/**
 * Pre-flight configuration validation for the SonarQube to SARIF action.
 *
 * Runs at action startup — before the analysis wait loop — to catch
 * misconfigurations early and emit actionable error messages.
 *
 * Checks (in order, fail-fast):
 *   1. SonarQube URL is reachable (HTTP connectivity)
 *   2. Token is valid  (GET /api/authentication/validate)
 *   3. Project key exists (GET /api/components/show?component=<key>)
 */

import axios from "axios";
import * as core from "@actions/core";
import { ActionConfig } from "./config";
import { SonarQubeError, createConnectionError } from "./errors";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface AuthValidateResponse {
  valid: boolean;
}

interface ComponentShowResponse {
  component: { key: string };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight validation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run pre-flight checks against the SonarQube server.
 *
 * Throws a `SonarQubeError` on the first failed check so the user gets a
 * single, actionable message rather than a cascade of errors.
 */
export async function validateConfig(config: ActionConfig): Promise<void> {
  core.info("Running pre-flight validation...");

  await checkConnectivity(config.sonarHostUrl);
  await checkToken(config.sonarHostUrl, config.sonarToken);
  await checkProjectKey(
    config.sonarHostUrl,
    config.sonarToken,
    config.projectKey,
  );

  core.info("Pre-flight validation passed.");
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check 1: Is the SonarQube URL reachable?
 *
 * A HEAD request against the root is cheap and protocol-agnostic — we only
 * care that the host responds, not that it returns 2xx.
 */
async function checkConnectivity(sonarHostUrl: string): Promise<void> {
  try {
    await axios.head(sonarHostUrl, {
      timeout: 10_000,
      // Any HTTP response (even 4xx/5xx) means the host is reachable.
      validateStatus: () => true,
    });
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    const detail = cause?.message ?? String(error);

    throw createConnectionError(
      `sonar-host-url is not reachable: ${detail}. Is the URL correct?`,
      cause,
    );
  }
}

/**
 * Check 2: Is the token valid?
 *
 * SonarQube `GET /api/authentication/validate` returns `{ "valid": true|false }`.
 * A 401 or `valid: false` both mean the token is rejected.
 */
async function checkToken(
  sonarHostUrl: string,
  sonarToken: string,
): Promise<void> {
  const url = `${sonarHostUrl}/api/authentication/validate`;
  const INVALID_MSG =
    "sonar-token is invalid or expired. " +
    "Generate a new token in SonarQube → My Account → Security.";

  try {
    const response = await axios.get<AuthValidateResponse>(url, {
      auth: { username: sonarToken, password: "" },
      timeout: 10_000,
      validateStatus: (status) => status < 500,
    });

    if (response.status === 401 || !response.data?.valid) {
      throw new SonarQubeError(INVALID_MSG, "AUTH_FAILED", response.status);
    }
  } catch (error) {
    if (error instanceof SonarQubeError) throw error;

    const cause = error instanceof Error ? error : undefined;
    throw createConnectionError(
      `Failed to reach /api/authentication/validate: ${cause?.message ?? String(error)}`,
      cause,
    );
  }
}

/**
 * Check 3: Does the project key exist?
 *
 * `GET /api/components/show?component=<key>` returns the component details.
 * A 404 means the project was not found; a 403 means the token lacks Browse
 * permission. Unlike `/api/projects/search` (which requires Administer System),
 * this endpoint only needs Browse permission on the project.
 */
async function checkProjectKey(
  sonarHostUrl: string,
  sonarToken: string,
  projectKey: string,
): Promise<void> {
  const url = `${sonarHostUrl}/api/components/show`;
  const NOT_FOUND_MSG =
    `Project key '${projectKey}' not found. ` +
    "Check the project exists and the token has Browse permission.";

  try {
    const response = await axios.get<ComponentShowResponse>(url, {
      params: { component: projectKey },
      auth: { username: sonarToken, password: "" },
      timeout: 10_000,
      validateStatus: (status) => status < 500,
    });

    if (response.status === 404 || !response.data?.component?.key) {
      throw new SonarQubeError(NOT_FOUND_MSG, "PROJECT_NOT_FOUND", 404);
    }
  } catch (error) {
    if (error instanceof SonarQubeError) throw error;

    const cause = error instanceof Error ? error : undefined;
    throw createConnectionError(
      `Failed to reach /api/components/show: ${cause?.message ?? String(error)}`,
      cause,
    );
  }
}
