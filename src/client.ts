import axios, { AxiosInstance, AxiosError } from "axios";
import * as core from "@actions/core";
import { SonarQubeSearchResponse, SonarQubeRule } from "./sonarqube-types";
import { ActionConfig } from "./config";
import {
  SonarQubeError,
  createHttpError,
  createConnectionError,
  createValidationError,
} from "./errors";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PAGE_SIZE = 500;
const MAX_PAGES = 100; // Safety limit to prevent infinite loops
const API_ENDPOINTS = {
  ISSUES_SEARCH: "/api/issues/search",
  RULES_SHOW: "/api/rules/show",
  CE_COMPONENT: "/api/ce/component",
} as const;

const TASK_STATUS = {
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  CANCELED: "CANCELED",
  PENDING: "PENDING",
  IN_PROGRESS: "IN_PROGRESS",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface IssuesSearchParams {
  componentKeys: string;
  ps: number;
  p: number;
  resolved?: string;
  branch?: string;
}

interface NormalizedResponse {
  pagingTotal?: number;
  issues: SonarQubeSearchResponse["issues"];
  components: SonarQubeSearchResponse["components"];
  rules: SonarQubeSearchResponse["rules"];
}

type SonarApiErrorPayload = {
  errors?: Array<{ msg?: string }>;
};

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeToArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }
  if (isRecord(value)) {
    return Object.values(value) as T[];
  }
  return [];
}

function extractSonarErrors(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;

  const errors = (payload as SonarApiErrorPayload).errors;
  if (!Array.isArray(errors) || errors.length === 0) return undefined;

  const msgs = errors
    .map((e) => (e && typeof e.msg === "string" ? e.msg : undefined))
    .filter((m): m is string => Boolean(m));

  return msgs.length > 0
    ? msgs.join(" | ")
    : "SonarQube API returned an error.";
}

function normalizeIssuesResponse(payload: unknown): NormalizedResponse {
  const errorMsg = extractSonarErrors(payload);
  if (errorMsg) {
    throw createValidationError(`SonarQube API error: ${errorMsg}`, payload);
  }

  if (!isRecord(payload)) {
    throw createValidationError(
      "Unexpected response: expected JSON object from /api/issues/search",
      typeof payload,
    );
  }

  const paging = isRecord(payload.paging) ? payload.paging : undefined;
  const pagingTotal =
    paging && typeof paging.total === "number" ? paging.total : undefined;

  const issues = normalizeToArray<SonarQubeSearchResponse["issues"][0]>(
    payload.issues,
  );
  const components = normalizeToArray<SonarQubeSearchResponse["components"][0]>(
    payload.components,
  );
  const rules = normalizeToArray<SonarQubeSearchResponse["rules"][0]>(
    payload.rules,
  );

  if (!Array.isArray(payload.issues) && issues.length === 0) {
    const keys = Object.keys(payload).slice(0, 10).join(", ");
    throw createValidationError(
      `Unexpected response shape (missing 'issues'). Keys: ${keys}`,
      payload,
    );
  }

  return { pagingTotal, issues, components, rules };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// SonarQube Client
// ─────────────────────────────────────────────────────────────────────────────

export class SonarQubeClient {
  private readonly client: AxiosInstance;
  private readonly projectKey: string;
  private readonly config: ActionConfig;

  constructor(config: ActionConfig) {
    this.projectKey = config.projectKey;
    this.config = config;

    this.client = axios.create({
      baseURL: config.sonarHostUrl,
      auth: {
        username: config.sonarToken,
        password: "",
      },
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeout: 30000, // 30 second timeout
    });
  }

  /**
   * Fetch all issues with pagination support
   */
  async fetchAllIssues(): Promise<SonarQubeSearchResponse> {
    const allIssues: SonarQubeSearchResponse["issues"] = [];
    const componentMap = new Map<
      string,
      SonarQubeSearchResponse["components"][0]
    >();
    const ruleMap = new Map<string, SonarQubeSearchResponse["rules"][0]>();

    let page = 1;
    let total = 0;

    core.info(`Fetching issues for project: ${this.projectKey}`);

    while (true) {
      // Safety check: prevent infinite loops due to pagination errors
      if (page > MAX_PAGES) {
        core.warning(
          `Reached maximum page limit (${MAX_PAGES}). Some issues may be missing.`,
        );
        break;
      }

      const params = this.buildSearchParams(page);

      core.debug(`Fetching page ${page}: ${JSON.stringify(params)}`);

      try {
        const response = await this.client.get(API_ENDPOINTS.ISSUES_SEARCH, {
          params,
        });
        const normalized = normalizeIssuesResponse(response.data);

        if (page === 1) {
          total = normalized.pagingTotal ?? normalized.issues.length;
          core.info(`Total issues to fetch: ${total}`);
        }

        allIssues.push(...normalized.issues);
        this.mergeIntoMap(componentMap, normalized.components, "key");
        this.mergeIntoMap(ruleMap, normalized.rules, "key");

        core.info(`Progress: ${allIssues.length}/${total} issues`);

        if (allIssues.length >= total) break;
        page++;
      } catch (error) {
        throw this.handleError(error, "fetching issues");
      }
    }

    // Fetch missing rule details if needed
    const missingRuleKeys = this.findMissingRuleKeys(allIssues, ruleMap);
    if (missingRuleKeys.length > 0) {
      core.info(`Fetching details for ${missingRuleKeys.length} rules...`);
      await this.fetchRuleDetails(missingRuleKeys, ruleMap);
    }

    return this.buildResponse(allIssues, componentMap, ruleMap);
  }

  /**
   * Apply a fixed delay before fetching issues
   * Alternative to waitForProcessing when lacking Execute Analysis permission
   */
  async applyProcessingDelay(): Promise<void> {
    const { processingDelay } = this.config;
    if (processingDelay <= 0) return;

    core.info(`Waiting ${processingDelay}s for analysis to complete...`);
    await sleep(processingDelay * 1000);
  }

  /**
   * Wait for SonarQube analysis to complete
   */
  async waitForProcessing(): Promise<void> {
    // Apply fixed delay first if configured
    await this.applyProcessingDelay();

    const { maxWaitTime, pollingInterval } = this.config;
    const startTime = Date.now();
    const maxWaitMs = maxWaitTime * 1000;
    const pollMs = pollingInterval * 1000;

    core.info("Waiting for analysis to complete...");
    core.info(`Timeout: ${maxWaitTime}s, Poll interval: ${pollingInterval}s`);

    while (true) {
      const elapsed = Date.now() - startTime;

      if (elapsed >= maxWaitMs) {
        core.warning(
          `Timeout after ${maxWaitTime}s. Analysis may still be in progress.`,
        );
        return;
      }

      const shouldContinue = await this.pollAnalysisStatus(elapsed, pollMs);
      if (!shouldContinue) {
        return;
      }
    }
  }

  /**
   * Poll analysis status once and determine if we should continue waiting
   * @returns true if we should continue polling, false if done
   */
  private async pollAnalysisStatus(
    elapsedMs: number,
    pollMs: number,
  ): Promise<boolean> {
    try {
      const status = await this.checkAnalysisStatus();
      const elapsedSec = Math.round(elapsedMs / 1000);

      if (!status) {
        core.info("✓ No analysis in progress");
        return false;
      }

      core.info(`Status: ${status} (${elapsedSec}s elapsed)`);

      if (status === TASK_STATUS.SUCCESS) {
        core.info("✓ Analysis completed successfully");
        return false;
      }

      if (status === TASK_STATUS.FAILED || status === TASK_STATUS.CANCELED) {
        const reason = status === TASK_STATUS.FAILED ? "failed" : "canceled";
        core.warning(`Analysis ${reason}. Proceeding with existing issues.`);
        return false;
      }

      await sleep(pollMs);
      return true;
    } catch (error) {
      if (error instanceof SonarQubeError && error.statusCode === 404) {
        core.warning(
          "CE endpoint unavailable (older SonarQube?). Skipping wait.",
        );
        return false;
      }
      throw error;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ───────────────────────────────────────────────────────────────────────────

  private buildSearchParams(page: number): IssuesSearchParams {
    const params: IssuesSearchParams = {
      componentKeys: this.projectKey,
      ps: MAX_PAGE_SIZE,
      p: page,
    };

    if (!this.config.includeResolved) {
      params.resolved = "false";
    }

    // SonarQube CE doesn't support pullRequest parameter - only Developer Edition+
    // When in a PR context, we use the branch name instead
    if (this.config.branch) {
      params.branch = this.config.branch;
    }

    // Note: pullRequest parameter is NOT sent to SonarQube CE
    // The pullRequestNumber is only used for GitHub PR comments/checks

    return params;
  }

  private mergeIntoMap<T extends { key?: string }>(
    map: Map<string, T>,
    items: T[],
    keyField: "key",
  ): void {
    for (const item of items) {
      const key = item[keyField];
      if (key && typeof key === "string") {
        map.set(key, item);
      }
    }
  }

  private findMissingRuleKeys(
    issues: SonarQubeSearchResponse["issues"],
    ruleMap: Map<string, SonarQubeRule>,
  ): string[] {
    const usedRules = new Set(issues.map((i) => i.rule));
    return Array.from(usedRules).filter((key) => !ruleMap.has(key));
  }

  private async fetchRuleDetails(
    ruleKeys: string[],
    ruleMap: Map<string, SonarQubeRule>,
  ): Promise<void> {
    // Fetch rules in parallel with concurrency limit
    const BATCH_SIZE = 5;

    for (let i = 0; i < ruleKeys.length; i += BATCH_SIZE) {
      const batch = ruleKeys.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (key) => {
          try {
            const response = await this.client.get(API_ENDPOINTS.RULES_SHOW, {
              params: { key },
            });

            const rule = response.data?.rule;
            if (rule && typeof rule.key === "string") {
              ruleMap.set(rule.key, {
                key: rule.key,
                name: rule.name ?? key,
                status: rule.status ?? "READY",
                lang: rule.lang,
                langName: rule.langName,
                htmlDesc: rule.htmlDesc,
                mdDesc: rule.mdDesc,
                severity: rule.severity,
                type: rule.type,
              });
            }
          } catch (error) {
            core.debug(`Could not fetch rule ${key}: ${error}`);
          }
        }),
      );
    }
  }

  private async checkAnalysisStatus(): Promise<string | null> {
    try {
      const response = await this.client.get(API_ENDPOINTS.CE_COMPONENT, {
        params: { component: this.projectKey },
      });

      const current = response.data?.current;
      return current?.status ?? null;
    } catch (error) {
      throw this.handleError(error, "checking analysis status");
    }
  }

  private buildResponse(
    issues: SonarQubeSearchResponse["issues"],
    componentMap: Map<string, SonarQubeSearchResponse["components"][0]>,
    ruleMap: Map<string, SonarQubeRule>,
  ): SonarQubeSearchResponse {
    return {
      total: issues.length,
      p: 1,
      ps: issues.length,
      paging: {
        pageIndex: 1,
        pageSize: issues.length,
        total: issues.length,
      },
      issues,
      components: Array.from(componentMap.values()),
      rules: Array.from(ruleMap.values()),
    };
  }

  private handleError(error: unknown, context: string): SonarQubeError {
    if (error instanceof SonarQubeError) {
      return error;
    }

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError;

      if (axiosError.response) {
        const status = axiosError.response.status;
        const data = axiosError.response.data;
        const sonarMsg = extractSonarErrors(data);

        return createHttpError(status, sonarMsg ?? axiosError.message, data);
      }

      if (
        axiosError.code === "ECONNREFUSED" ||
        axiosError.code === "ENOTFOUND"
      ) {
        return createConnectionError(
          `Cannot connect to ${this.config.sonarHostUrl}`,
          axiosError,
        );
      }

      if (axiosError.code === "ETIMEDOUT") {
        return new SonarQubeError(
          `Request timeout while ${context}`,
          "TIMEOUT",
          undefined,
          axiosError.message,
        );
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    return new SonarQubeError(
      `Error ${context}: ${message}`,
      "UNKNOWN",
      undefined,
      error,
    );
  }
}
