/**
 * Unit tests for src/preflight.ts
 *
 * Covers:
 *  - Happy path: all checks pass → resolves without error
 *  - URL not reachable (network error) → actionable SonarQubeError
 *  - Token invalid: valid=false → SonarQubeError AUTH_FAILED
 *  - Token invalid: HTTP 401 → SonarQubeError AUTH_FAILED
 *  - Project not found: empty components → SonarQubeError PROJECT_NOT_FOUND
 *  - Project not found: HTTP 404 → SonarQubeError PROJECT_NOT_FOUND
 *  - /api/authentication/validate network error → SonarQubeError CONNECTION_FAILED
 *  - /api/projects/search network error → SonarQubeError CONNECTION_FAILED
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SonarQubeError } from "../src/errors";
import type { ActionConfig } from "../src/config";

// ─── Mock @actions/core ───────────────────────────────────────────────────────

vi.mock("@actions/core", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

// ─── Mock axios ───────────────────────────────────────────────────────────────

const axiosMocks = {
  head: vi.fn(),
  get: vi.fn(),
  isAxiosError: vi.fn(
    (e: unknown) => (e as { isAxiosError?: boolean })?.isAxiosError === true,
  ),
};

vi.mock("axios", () => ({
  default: {
    head: (...args: unknown[]) => axiosMocks.head(...args),
    get: (...args: unknown[]) => axiosMocks.get(...args),
    isAxiosError: (e: unknown) => axiosMocks.isAxiosError(e),
  },
}));

// ─── Import after mocks ───────────────────────────────────────────────────────

import { validateConfig } from "../src/preflight";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const baseConfig: ActionConfig = {
  sonarHostUrl: "https://sonar.example.com",
  sonarToken: "valid-token",
  projectKey: "my-project",
  projectKeySource: "input",
  repositoryProjectKey: "my-project",
  outputFile: "sonarqube.sarif",
  branch: undefined,
  pullRequestNumber: undefined,
  waitForProcessing: false,
  maxWaitTime: 300,
  pollingInterval: 10,
  processingDelay: 0,
  minSeverity: "INFO",
  includeResolved: false,
  prComment: false,
  failOnSeverity: undefined,
  githubToken: undefined,
  skipPreflight: false,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("validateConfig (pre-flight)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  it("resolves without error when all checks pass", async () => {
    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get
      .mockResolvedValueOnce({ status: 200, data: { valid: true } }) // auth/validate
      .mockResolvedValueOnce({
        status: 200,
        data: { components: [{ key: "my-project" }] },
      }); // projects/search

    await expect(validateConfig(baseConfig)).resolves.toBeUndefined();
  });

  // ── Check 1: connectivity ───────────────────────────────────────────────────

  it("throws CONNECTION_FAILED when URL is not reachable", async () => {
    const networkError = new Error("connect ECONNREFUSED 127.0.0.1:9000");
    axiosMocks.head.mockRejectedValue(networkError);

    await expect(validateConfig(baseConfig)).rejects.toThrow(SonarQubeError);
    await expect(validateConfig(baseConfig)).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
    });
  });

  it("includes actionable guidance in connectivity error message", async () => {
    axiosMocks.head.mockRejectedValue(new Error("connection refused"));

    await expect(validateConfig(baseConfig)).rejects.toThrow(
      /Is the URL correct/,
    );
  });

  it("does not throw when host returns a non-2xx response (host is reachable)", async () => {
    // A 404 still means the host is up — only network errors should fail
    axiosMocks.head.mockResolvedValue({ status: 404 });
    axiosMocks.get
      .mockResolvedValueOnce({ status: 200, data: { valid: true } })
      .mockResolvedValueOnce({
        status: 200,
        data: { components: [{ key: "my-project" }] },
      });

    await expect(validateConfig(baseConfig)).resolves.toBeUndefined();
  });

  // ── Check 2: token validation ───────────────────────────────────────────────

  it("throws AUTH_FAILED when token is invalid (valid=false)", async () => {
    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get.mockResolvedValueOnce({
      status: 200,
      data: { valid: false },
    });

    await expect(validateConfig(baseConfig)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("throws AUTH_FAILED on HTTP 401 from /api/authentication/validate", async () => {
    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get.mockResolvedValueOnce({ status: 401, data: {} });

    await expect(validateConfig(baseConfig)).rejects.toMatchObject({
      code: "AUTH_FAILED",
    });
  });

  it("includes actionable guidance in token error message", async () => {
    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get.mockResolvedValueOnce({
      status: 200,
      data: { valid: false },
    });

    await expect(validateConfig(baseConfig)).rejects.toThrow(
      /Generate a new token in SonarQube/,
    );
  });

  it("throws CONNECTION_FAILED when /api/authentication/validate is unreachable", async () => {
    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get.mockRejectedValueOnce(new Error("ECONNRESET"));

    await expect(validateConfig(baseConfig)).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
    });
  });

  // ── Check 3: project key ────────────────────────────────────────────────────

  it("throws PROJECT_NOT_FOUND when components array is empty", async () => {
    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get
      .mockResolvedValueOnce({ status: 200, data: { valid: true } })
      .mockResolvedValueOnce({ status: 200, data: { components: [] } });

    await expect(validateConfig(baseConfig)).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });

  it("throws PROJECT_NOT_FOUND on HTTP 404 from /api/projects/search", async () => {
    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get
      .mockResolvedValueOnce({ status: 200, data: { valid: true } })
      .mockResolvedValueOnce({ status: 404, data: {} });

    await expect(validateConfig(baseConfig)).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });

  it("includes the project key and actionable guidance in the project error message", async () => {
    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get
      .mockResolvedValueOnce({ status: 200, data: { valid: true } })
      .mockResolvedValueOnce({ status: 200, data: { components: [] } });

    let caughtError: unknown;
    try {
      await validateConfig(baseConfig);
    } catch (e) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(SonarQubeError);
    expect((caughtError as Error).message).toMatch(/my-project/);
    expect((caughtError as Error).message).toMatch(/Browse permission/);
  });

  it("throws CONNECTION_FAILED when /api/projects/search is unreachable", async () => {
    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get
      .mockResolvedValueOnce({ status: 200, data: { valid: true } })
      .mockRejectedValueOnce(new Error("ETIMEDOUT"));

    await expect(validateConfig(baseConfig)).rejects.toMatchObject({
      code: "CONNECTION_FAILED",
    });
  });

  // ── Fail-fast behaviour ─────────────────────────────────────────────────────

  it("does not call token check when connectivity check fails", async () => {
    axiosMocks.head.mockRejectedValue(new Error("connection refused"));

    await expect(validateConfig(baseConfig)).rejects.toThrow(SonarQubeError);

    // axios.get should never have been called
    expect(axiosMocks.get).not.toHaveBeenCalled();
  });

  it("does not call project key check when token check fails", async () => {
    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get.mockResolvedValueOnce({
      status: 200,
      data: { valid: false },
    });

    await expect(validateConfig(baseConfig)).rejects.toThrow(SonarQubeError);

    // axios.get should only have been called once (for auth/validate)
    expect(axiosMocks.get).toHaveBeenCalledTimes(1);
  });
});
