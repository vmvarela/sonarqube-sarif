import axios, { AxiosInstance } from "axios";
import * as core from "@actions/core";
import { SonarQubeSearchResponse, SonarQubeRule } from "./sonarqube-types";
import { ActionConfig } from "./config";
import {
  SonarQubeError,
  createHttpError,
  createConnectionError,
  createValidationError,
} from "./errors";
import { ProcessingMetrics } from "./stats";

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
// Retry constants
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000; // 1s → 2s → 4s
const JITTER_FACTOR = 0.2; // ±20% randomisation to avoid thundering herd

/** HTTP status codes that indicate a transient failure worth retrying. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** Network-level error codes that are safe to retry. */
const RETRYABLE_ERROR_CODES = new Set(["ETIMEDOUT", "ECONNRESET"]);

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

/**
 * Returns true when the error represents a transient condition that is safe
 * to retry (429 rate-limit, 5xx server errors, network timeouts / resets).
 * Permanent errors (401, 403, 404, 422, connection refused, …) return false.
 */
function isRetryableError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;

  // Network-level errors that are recoverable
  if (error.code && RETRYABLE_ERROR_CODES.has(error.code)) return true;

  // HTTP response errors – only retry on known transient status codes
  if (error.response) {
    return RETRYABLE_STATUS_CODES.has(error.response.status);
  }

  return false;
}

/**
 * Extract the delay (in milliseconds) from a `Retry-After` response header.
 * Only the numeric seconds format is supported.  Returns `undefined` when the
 * header is absent or cannot be parsed as a positive integer.
 */
function parseRetryAfterMs(
  headers: Record<string, unknown> | undefined,
): number | undefined {
  if (!headers) return undefined;
  const raw = headers["retry-after"];
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return seconds * 1000;
}

// ─────────────────────────────────────────────────────────────────────────────
// SonarQube Client
// ─────────────────────────────────────────────────────────────────────────────

export class SonarQubeClient {
  private readonly client: AxiosInstance;
  private readonly projectKey: string;
  private readonly config: ActionConfig;

  // ── Internal metric counters ────────────────────────────────────────────────
  private _apiRequestCount = 0;
  private _apiErrorCount = 0;
  private _apiRetryCount = 0;
  private _pagesFetched = 0;
  private _rulesFetchedTotal = 0;
  private _rulesFetchedSuccess = 0;

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

    // ── Axios interceptors for metric collection ──────────────────────────────
    this.client.interceptors.request.use((reqConfig) => {
      this._apiRequestCount++;
      return reqConfig;
    });

    this.client.interceptors.response.use(
      (response) => response,
      (error) => {
        if (axios.isAxiosError(error) && error.response) {
          this._apiErrorCount++;
        }
        return Promise.reject(error);
      },
    );
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
    let totalKnown = false;

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
        const response = await this.withRetry(
          () =>
            this.client.get(API_ENDPOINTS.ISSUES_SEARCH, {
              params,
            }),
          `fetching issues page ${page}`,
        );
        const normalized = normalizeIssuesResponse(response.data);
        this._pagesFetched++;

        if (page === 1) {
          if (normalized.pagingTotal !== undefined) {
            total = normalized.pagingTotal;
            totalKnown = true;
            core.info(`Total issues to fetch: ${total}`);
          } else {
            core.warning(
              "SonarQube response is missing paging.total. " +
                "Falling back to last-page heuristic (fetching until a page has fewer than " +
                `${MAX_PAGE_SIZE} results).`,
            );
          }
        }

        allIssues.push(...normalized.issues);
        this.mergeIntoMap(componentMap, normalized.components, "key");
        this.mergeIntoMap(ruleMap, normalized.rules, "key");

        if (totalKnown) {
          core.info(`Progress: ${allIssues.length}/${total} issues`);
          if (allIssues.length >= total) break;
        } else {
          core.info(
            `Progress: ${allIssues.length} issues fetched (total unknown)`,
          );
          if (normalized.issues.length < MAX_PAGE_SIZE) break;
        }

        page++;
      } catch (error) {
        throw error instanceof SonarQubeError
          ? error
          : this.handleError(error, "fetching issues");
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
    let failedCount = 0;

    this._rulesFetchedTotal = ruleKeys.length;

    for (let i = 0; i < ruleKeys.length; i += BATCH_SIZE) {
      const batch = ruleKeys.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (key) => {
          try {
            const response = await this.withRetry(
              () =>
                this.client.get(API_ENDPOINTS.RULES_SHOW, {
                  params: { key },
                }),
              `fetching rule ${key}`,
            );

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
              this._rulesFetchedSuccess++;
            }
          } catch (error) {
            failedCount++;
            core.debug(`Could not fetch rule ${key}: ${error}`);
          }
        }),
      );
    }

    if (failedCount > 0) {
      core.warning(
        `Could not fetch details for ${failedCount}/${ruleKeys.length} rules. ` +
          `Affected rules will use basic metadata from the issues response.`,
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

  /**
   * Execute `fn` with exponential backoff retry for transient errors.
   *
   * - Retries up to MAX_RETRIES times on 429 / 5xx / ETIMEDOUT / ECONNRESET.
   * - Respects `Retry-After` header (numeric seconds) on 429 responses.
   * - Applies ±JITTER_FACTOR randomisation to computed delays.
   * - Logs each retry at `core.warning` with attempt count and reason.
   * - Permanent errors (401, 403, 404, …) are never retried.
   */
  private async withRetry<T>(
    fn: () => Promise<T>,
    context: string,
  ): Promise<T> {
    let attempt = 0;

    while (true) {
      try {
        return await fn();
      } catch (error) {
        attempt++;

        if (!isRetryableError(error) || attempt > MAX_RETRIES) {
          throw this.handleError(error, context);
        }

        // Determine how long to wait before the next attempt
        const axiosErr = axios.isAxiosError(error) ? error : undefined;
        const retryAfterMs = axiosErr?.response?.headers
          ? parseRetryAfterMs(
              axiosErr.response.headers as Record<string, unknown>,
            )
          : undefined;

        const baseMs = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        const jitter = baseMs * JITTER_FACTOR * (2 * Math.random() - 1);
        const delayMs = retryAfterMs ?? Math.round(baseMs + jitter);

        const status = axiosErr?.response?.status;
        const reason =
          axiosErr?.code ?? (status ? `HTTP ${status}` : "unknown");

        core.warning(
          `Retry ${attempt}/${MAX_RETRIES} for "${context}" after ${delayMs}ms (reason: ${reason})`,
        );

        this._apiRetryCount++;
        await sleep(delayMs);
      }
    }
  }

  private handleError(error: unknown, context: string): SonarQubeError {
    if (error instanceof SonarQubeError) {
      return error;
    }

    if (axios.isAxiosError(error)) {
      if (error.response) {
        const status = error.response.status;
        const data = error.response.data;
        const sonarMsg = extractSonarErrors(data);

        return createHttpError(status, sonarMsg ?? error.message, data);
      }

      if (error.code === "ECONNREFUSED" || error.code === "ENOTFOUND") {
        return createConnectionError(
          `Cannot connect to ${this.config.sonarHostUrl}`,
          error,
        );
      }

      if (error.code === "ETIMEDOUT") {
        return new SonarQubeError(
          `Request timeout while ${context}`,
          "TIMEOUT",
          undefined,
          error.message,
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

  /**
   * Return a snapshot of the HTTP and pipeline metrics collected so far.
   * `sarifFileSizeBytes` and `processingTimeMs` are set by the caller (main.ts)
   * since those values are not available inside the client.
   */
  getMetrics(): Omit<
    ProcessingMetrics,
    "sarifFileSizeBytes" | "processingTimeMs"
  > {
    const ruleFetchSuccessRate =
      this._rulesFetchedTotal === 0
        ? 100
        : (this._rulesFetchedSuccess / this._rulesFetchedTotal) * 100;

    return {
      apiRequestCount: this._apiRequestCount,
      apiErrorCount: this._apiErrorCount,
      apiRetryCount: this._apiRetryCount,
      pagesFetched: this._pagesFetched,
      ruleFetchSuccessRate,
    };
  }
}
