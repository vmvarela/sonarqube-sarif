/**
 * Unit tests for src/preflight.ts
 *
 * Covers:
 *  - Happy path: all checks pass → resolves without error
 *  - URL not reachable (network error) → actionable SonarQubeError
 *  - Token invalid: valid=false → SonarQubeError AUTH_FAILED
 *  - Token invalid: HTTP 401 → SonarQubeError AUTH_FAILED
 *  - Project not found: missing component → SonarQubeError PROJECT_NOT_FOUND
 *  - Project not found: HTTP 404 → SonarQubeError PROJECT_NOT_FOUND
 *  - /api/components/show network error → SonarQubeError CONNECTION_FAILED
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
        data: { component: { key: "my-project" } },
      }); // components/show

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
        data: { component: { key: "my-project" } },
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

  it("warns but does not throw when component is missing from response", async () => {
    const coreModule = await import("@actions/core");

    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get
      .mockResolvedValueOnce({ status: 200, data: { valid: true } })
      .mockResolvedValueOnce({ status: 200, data: {} });

    await expect(validateConfig(baseConfig)).resolves.toBeUndefined();
    expect(vi.mocked(coreModule.warning)).toHaveBeenCalledWith(
      expect.stringContaining("unexpected response"),
    );
  });

  it("throws PROJECT_NOT_FOUND on HTTP 404 from /api/components/show", async () => {
    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get
      .mockResolvedValueOnce({ status: 200, data: { valid: true } })
      .mockResolvedValueOnce({ status: 404, data: {} });

    await expect(validateConfig(baseConfig)).rejects.toMatchObject({
      code: "PROJECT_NOT_FOUND",
    });
  });

  it("includes the project key and actionable guidance in 404 error message", async () => {
    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get
      .mockResolvedValueOnce({ status: 200, data: { valid: true } })
      .mockResolvedValueOnce({ status: 404, data: {} });

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

  it("warns but does not throw on HTTP 403 (missing Browse permission)", async () => {
    const coreModule = await import("@actions/core");

    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get
      .mockResolvedValueOnce({ status: 200, data: { valid: true } })
      .mockResolvedValueOnce({ status: 403, data: {} });

    await expect(validateConfig(baseConfig)).resolves.toBeUndefined();
    expect(vi.mocked(coreModule.warning)).toHaveBeenCalledWith(
      expect.stringContaining("Browse permission"),
    );
  });

  it("includes server error message in 404 when available", async () => {
    axiosMocks.head.mockResolvedValue({ status: 200 });
    axiosMocks.get
      .mockResolvedValueOnce({ status: 200, data: { valid: true } })
      .mockResolvedValueOnce({
        status: 404,
        data: { errors: [{ msg: "Component key 'x' not found" }] },
      });

    await expect(validateConfig(baseConfig)).rejects.toThrow(
      /Component key 'x' not found/,
    );
  });

  it("throws CONNECTION_FAILED when /api/components/show is unreachable", async () => {
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
