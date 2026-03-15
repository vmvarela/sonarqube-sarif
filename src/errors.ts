/**
 * Custom error types for better error handling and actionable messages
 */

import * as core from "@actions/core";

export class SonarQubeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode?: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "SonarQubeError";
  }

  /**
   * Get actionable suggestion for the error
   */
  getSuggestion(): string {
    switch (this.code) {
      case "AUTH_FAILED":
        return "Check that your SONAR_TOKEN is valid and has not expired.";
      case "PROJECT_NOT_FOUND":
        return "Verify the project-key matches an existing project in SonarQube.";
      case "PERMISSION_DENIED":
        return 'Ensure your token has "Browse" permission for the project.';
      case "RATE_LIMITED":
        return "Wait a moment and retry, or increase polling-interval.";
      case "CONNECTION_FAILED":
        return "Check that sonar-host-url is correct and the server is accessible.";
      case "INVALID_RESPONSE":
        return "The SonarQube server returned an unexpected response. Check server logs.";
      case "TIMEOUT":
        return "Analysis is taking longer than expected. Try increasing max-wait-time.";
      default:
        return "Check the SonarQube server logs for more details.";
    }
  }

  /**
   * Log error with context
   */
  log(): void {
    core.error(`[${this.code}] ${this.message}`);
    core.error(`Suggestion: ${this.getSuggestion()}`);
    if (this.details) {
      core.debug(`Error details: ${JSON.stringify(this.details)}`);
    }
  }
}

/**
 * Create appropriate error from HTTP status code
 */
export function createHttpError(
  status: number,
  message: string,
  details?: unknown,
): SonarQubeError {
  const errorMap: Record<number, { code: string; msg: string }> = {
    401: { code: "AUTH_FAILED", msg: "Authentication failed" },
    403: { code: "PERMISSION_DENIED", msg: "Permission denied" },
    404: { code: "PROJECT_NOT_FOUND", msg: "Resource not found" },
    429: { code: "RATE_LIMITED", msg: "Rate limit exceeded" },
  };

  const errorInfo = errorMap[status] || {
    code: "HTTP_ERROR",
    msg: `HTTP error ${status}`,
  };

  return new SonarQubeError(
    `${errorInfo.msg}: ${message}`,
    errorInfo.code,
    status,
    details,
  );
}

/**
 * Create connection error
 */
export function createConnectionError(
  message: string,
  cause?: Error,
): SonarQubeError {
  return new SonarQubeError(
    `Connection failed: ${message}`,
    "CONNECTION_FAILED",
    undefined,
    cause?.message,
  );
}

/**
 * Create validation error for unexpected responses
 */
export function createValidationError(
  message: string,
  details?: unknown,
): SonarQubeError {
  return new SonarQubeError(message, "INVALID_RESPONSE", undefined, details);
}
