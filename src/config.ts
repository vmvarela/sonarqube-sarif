/**
 * Configuration types and utilities for the SonarQube to SARIF action
 */

import * as core from "@actions/core";
import { context } from "@actions/github";

export interface ActionConfig {
  sonarHostUrl: string;
  sonarToken: string;
  projectKey: string;
  projectKeySource: "input" | "repository";
  repositoryProjectKey: string;
  outputFile: string;
  branch?: string;
  pullRequestNumber?: number;
  waitForProcessing: boolean;
  maxWaitTime: number;
  pollingInterval: number;
  processingDelay: number;
  minSeverity: SeverityLevel;
  includeResolved: boolean;
  prComment: boolean;
  failOnSeverity?: SeverityLevel;
  githubToken?: string;
}

export type SeverityLevel = "INFO" | "MINOR" | "MAJOR" | "CRITICAL" | "BLOCKER";

export const SEVERITY_ORDER: Record<SeverityLevel, number> = {
  INFO: 0,
  MINOR: 1,
  MAJOR: 2,
  CRITICAL: 3,
  BLOCKER: 4,
};

export const DEFAULT_CONFIG = {
  outputFile: "sonarqube.sarif",
  waitForProcessing: true,
  maxWaitTime: 300,
  pollingInterval: 10,
  processingDelay: 0,
  minSeverity: "INFO" as SeverityLevel,
  includeResolved: false,
} as const;

function emptyToUndefined(value: string): string | undefined {
  return value.trim() === "" ? undefined : value;
}

/**
 * Parse and validate action inputs
 */
export function parseConfig(): ActionConfig {
  const sonarHostUrl = core.getInput("sonar-host-url", { required: true });
  const sonarToken = core.getInput("sonar-token", { required: true });
  const projectKeyInput = core.getInput("project-key").trim();

  // Validate required inputs - use URL constructor for full validation
  try {
    const url = new URL(sonarHostUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ConfigError(
        "sonar-host-url must use HTTP or HTTPS protocol",
        "sonar-host-url",
      );
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(
      "sonar-host-url must be a valid URL (e.g., https://sonarqube.example.com)",
      "sonar-host-url",
    );
  }

  if (!sonarToken.trim()) {
    throw new ConfigError("sonar-token cannot be empty", "sonar-token");
  }

  const payloadRepoName = context.payload?.repository?.name;
  const repositoryName = (payloadRepoName ?? context.repo.repo ?? "").trim();

  let projectKey = projectKeyInput;
  let projectKeySource: "input" | "repository" = "input";

  if (!projectKey) {
    if (!repositoryName) {
      throw new ConfigError(
        "project-key is required when repository name is unavailable",
        "project-key",
      );
    }

    projectKey = repositoryName;
    projectKeySource = "repository";
  }

  const maxWaitTime = parsePositiveInt(
    core.getInput("max-wait-time"),
    DEFAULT_CONFIG.maxWaitTime,
    "max-wait-time",
  );

  const pollingInterval = parsePositiveInt(
    core.getInput("polling-interval"),
    DEFAULT_CONFIG.pollingInterval,
    "polling-interval",
  );

  const processingDelay = parseNonNegativeInt(
    core.getInput("processing-delay"),
    DEFAULT_CONFIG.processingDelay,
    "processing-delay",
    600,
  );

  const minSeverityInput = core
    .getInput("min-severity")
    .toUpperCase() as SeverityLevel;
  const minSeverity =
    SEVERITY_ORDER[minSeverityInput] !== undefined
      ? minSeverityInput
      : DEFAULT_CONFIG.minSeverity;

  // Auto-detect pull request from GitHub context
  const pullRequestNumber = context.payload.pull_request?.number;

  // PR comment is enabled by default when in a PR context
  const prCommentInput = core.getInput("pr-comment");
  const prComment =
    prCommentInput === ""
      ? Boolean(pullRequestNumber)
      : prCommentInput === "true";

  // Parse fail-on-severity (optional - undefined means never fail)
  const failOnSeverityInput = core
    .getInput("fail-on-severity")
    .toUpperCase() as SeverityLevel;
  const failOnSeverity =
    SEVERITY_ORDER[failOnSeverityInput] !== undefined
      ? failOnSeverityInput
      : undefined;

  return {
    sonarHostUrl: sonarHostUrl.replace(/\/$/, ""), // Remove trailing slash
    sonarToken,
    projectKey,
    projectKeySource,
    repositoryProjectKey: repositoryName,
    outputFile:
      emptyToUndefined(core.getInput("output-file")) ??
      DEFAULT_CONFIG.outputFile,
    branch: emptyToUndefined(core.getInput("branch")),
    pullRequestNumber,
    waitForProcessing: core.getInput("wait-for-processing") !== "false",
    maxWaitTime,
    pollingInterval,
    processingDelay,
    minSeverity,
    includeResolved: core.getInput("include-resolved") === "true",
    prComment,
    failOnSeverity,
    githubToken:
      emptyToUndefined(core.getInput("github-token")) ??
      process.env.GITHUB_TOKEN ??
      undefined,
  };
}

/**
 * Mask sensitive values in logs
 */
export function maskSecrets(config: ActionConfig): void {
  core.setSecret(config.sonarToken);
  // Mask GitHub token if provided (including from environment)
  if (config.githubToken) {
    core.setSecret(config.githubToken);
  }
  // Only mask URL if it might contain sensitive info (credentials in URL)
  if (config.sonarHostUrl.includes("@")) {
    core.setSecret(config.sonarHostUrl);
  }
}

function parsePositiveInt(
  value: string,
  defaultValue: number,
  fieldName: string,
): number {
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new ConfigError(
      `${fieldName} must be a positive integer, got: ${value}`,
      fieldName,
    );
  }
  return parsed;
}

function parseNonNegativeInt(
  value: string,
  defaultValue: number,
  fieldName: string,
  maxValue?: number,
): number {
  if (!value) return defaultValue;

  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed < 0) {
    throw new ConfigError(
      `${fieldName} must be a non-negative integer, got: ${value}`,
      fieldName,
    );
  }
  if (maxValue !== undefined && parsed > maxValue) {
    throw new ConfigError(
      `${fieldName} must not exceed ${maxValue}, got: ${value}`,
      fieldName,
    );
  }
  return parsed;
}

/**
 * Configuration error with field context
 */
export class ConfigError extends Error {
  constructor(
    message: string,
    public readonly field: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}
