/**
 * Integration tests for main.ts — fail-on-severity behaviour (issue #11).
 *
 * These tests import and invoke the real run() function from main.ts with all
 * external dependencies mocked. This ensures the actual execution path in
 * main.ts is exercised, not a manual re-implementation of it.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ActionConfig } from "../src/config";
import type { SonarQubeSearchResponse } from "../src/sonarqube-types";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockSetFailed = vi.fn();
const mockSetOutput = vi.fn();
const mockInfo = vi.fn();
const mockWarning = vi.fn();
const mockDebug = vi.fn();
const mockError = vi.fn();
const mockSetSecret = vi.fn();

vi.mock("@actions/core", () => ({
  info: mockInfo,
  debug: mockDebug,
  warning: mockWarning,
  error: mockError,
  setFailed: mockSetFailed,
  setOutput: mockSetOutput,
  setSecret: mockSetSecret,
  summary: {
    addHeading: vi.fn().mockReturnThis(),
    addTable: vi.fn().mockReturnThis(),
    write: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@actions/github", () => ({
  context: {
    repo: { repo: "test-repo", owner: "test-owner" },
    sha: "abc123",
    ref: "refs/heads/main",
    payload: {},
  },
  getOctokit: vi.fn(),
}));

const mockFetchAllIssues = vi.fn();
const mockWaitForProcessing = vi.fn().mockResolvedValue(undefined);
const mockGetMetrics = vi.fn().mockReturnValue({
  apiRequestCount: 5,
  apiErrorCount: 0,
  apiRetryCount: 0,
  pagesFetched: 1,
  ruleFetchSuccessRate: 100,
});

vi.mock("../src/client", () => ({
  SonarQubeClient: vi.fn().mockImplementation(function () {
    return {
      fetchAllIssues: mockFetchAllIssues,
      waitForProcessing: mockWaitForProcessing,
      applyProcessingDelay: vi.fn().mockResolvedValue(undefined),
      getMetrics: mockGetMetrics,
    };
  }),
}));

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  statSync: vi.fn().mockReturnValue({ size: 2048 }),
}));

const mockParseConfig = vi.fn();
const mockMaskSecrets = vi.fn();

vi.mock("../src/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/config")>();
  return {
    ...actual,
    parseConfig: mockParseConfig,
    maskSecrets: mockMaskSecrets,
  };
});

vi.mock("../src/pr-comment", () => ({
  writePrComment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/preflight", () => ({
  validateConfig: vi.fn().mockResolvedValue(undefined),
}));

const mockCreateCheck = vi.fn();
vi.mock("../src/github-checks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github-checks")>();
  return {
    ...actual,
    // Keep shouldFailCheck real — that's what we're testing
    createCheckRun: vi.fn().mockImplementation(async () => {
      // Default: succeeds silently (no token path or happy path)
    }),
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseConfig: ActionConfig = {
  sonarHostUrl: "https://sonarqube.example.com",
  sonarToken: "token",
  projectKey: "my-project",
  projectKeySource: "input",
  repositoryProjectKey: "my-project",
  outputFile: "results.sarif",
  minSeverity: "INFO",
  failOnSeverity: undefined,
  githubToken: undefined,
  branch: undefined,
  pullRequestNumber: undefined,
  waitForProcessing: false,
  maxWaitTime: 300,
  pollingInterval: 10,
  processingDelay: 0,
  includeResolved: false,
  prComment: false,
  skipPreflight: true, // Skip pre-flight in unit tests
};

const responseWithCritical: SonarQubeSearchResponse = {
  total: 1,
  p: 1,
  ps: 100,
  issues: [
    {
      key: "issue-1",
      rule: "squid:S001",
      severity: "CRITICAL",
      component: "my-project:src/Main.java",
      project: "my-project",
      message: "Critical issue",
      status: "OPEN",
      type: "BUG",
    },
  ],
  components: [
    {
      key: "my-project:src/Main.java",
      name: "Main.java",
      path: "src/Main.java",
      qualifier: "FIL",
    },
  ],
  rules: [],
  paging: { pageIndex: 1, pageSize: 100, total: 1 },
};

const responseEmpty: SonarQubeSearchResponse = {
  total: 0,
  p: 1,
  ps: 100,
  issues: [],
  components: [],
  rules: [],
  paging: { pageIndex: 1, pageSize: 100, total: 0 },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("main — fail-on-severity (issue #11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWaitForProcessing.mockResolvedValue(undefined);
  });

  it("(a) fails the action when fail-on-severity threshold is met and GitHub token is missing", async () => {
    mockParseConfig.mockReturnValue({
      ...baseConfig,
      githubToken: undefined, // no token → createCheckRun returns early
      failOnSeverity: "MAJOR",
    });
    mockFetchAllIssues.mockResolvedValue(responseWithCritical);

    const { run } = await import("../src/main");
    await run();

    // The real shouldFailCheck() sees CRITICAL >= MAJOR → true → setFailed
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("MAJOR severity"),
    );
    // Success banner must NOT be printed when action fails
    expect(mockInfo).not.toHaveBeenCalledWith(
      expect.stringContaining("SARIF file created successfully"),
    );
  });

  it("(b) fails the action when fail-on-severity threshold is met even if check run API call fails", async () => {
    mockParseConfig.mockReturnValue({
      ...baseConfig,
      githubToken: "gh-token",
      failOnSeverity: "MAJOR",
    });
    mockFetchAllIssues.mockResolvedValue(responseWithCritical);

    // Override createCheckRun mock to simulate API failure (swallowed as warning)
    const githubChecks = await import("../src/github-checks");
    vi.mocked(githubChecks.createCheckRun).mockImplementationOnce(async () => {
      mockWarning("Failed to create check run: GitHub API 500");
    });

    const { run } = await import("../src/main");
    await run();

    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to create check run"),
    );
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("MAJOR severity"),
    );
    expect(mockInfo).not.toHaveBeenCalledWith(
      expect.stringContaining("SARIF file created successfully"),
    );
  });

  it("(c) does not fail the action when no issues exceed the severity threshold", async () => {
    mockParseConfig.mockReturnValue({
      ...baseConfig,
      failOnSeverity: "BLOCKER", // threshold above CRITICAL
    });
    mockFetchAllIssues.mockResolvedValue(responseWithCritical);

    const { run } = await import("../src/main");
    await run();

    // CRITICAL < BLOCKER → shouldFailCheck returns false → no setFailed
    expect(mockSetFailed).not.toHaveBeenCalled();
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining("SARIF file created successfully"),
    );
  });

  it("(d) does not fail the action when failOnSeverity is not configured", async () => {
    mockParseConfig.mockReturnValue({
      ...baseConfig,
      failOnSeverity: undefined,
    });
    mockFetchAllIssues.mockResolvedValue(responseWithCritical);

    const { run } = await import("../src/main");
    await run();

    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("(e) does not fail the action when there are no issues at all", async () => {
    mockParseConfig.mockReturnValue({
      ...baseConfig,
      failOnSeverity: "INFO", // lowest threshold possible
    });
    mockFetchAllIssues.mockResolvedValue(responseEmpty);

    const { run } = await import("../src/main");
    await run();

    expect(mockSetFailed).not.toHaveBeenCalled();
  });

  it("(f) sets processing metric outputs on successful run", async () => {
    mockParseConfig.mockReturnValue({ ...baseConfig });
    mockFetchAllIssues.mockResolvedValue(responseWithCritical);

    const { run } = await import("../src/main");
    await run();

    expect(mockSetOutput).toHaveBeenCalledWith("api-request-count", 5);
    expect(mockSetOutput).toHaveBeenCalledWith("api-error-count", 0);
    expect(mockSetOutput).toHaveBeenCalledWith("api-retry-count", 0);
    expect(mockSetOutput).toHaveBeenCalledWith("pages-fetched", 1);
    expect(mockSetOutput).toHaveBeenCalledWith("rule-fetch-success-rate", 100);
    expect(mockSetOutput).toHaveBeenCalledWith("sarif-file-size-bytes", 2048);
    expect(mockSetOutput).toHaveBeenCalledWith(
      "processing-time-ms",
      expect.any(Number),
    );
  });

  it("(g) calls validateConfig when skipPreflight is false", async () => {
    mockParseConfig.mockReturnValue({ ...baseConfig, skipPreflight: false });
    mockFetchAllIssues.mockResolvedValue(responseEmpty);

    const preflight = await import("../src/preflight");
    const { run } = await import("../src/main");
    await run();

    expect(vi.mocked(preflight.validateConfig)).toHaveBeenCalledTimes(1);
  });

  it("(h) skips validateConfig when skipPreflight is true", async () => {
    mockParseConfig.mockReturnValue({ ...baseConfig, skipPreflight: true });
    mockFetchAllIssues.mockResolvedValue(responseEmpty);

    const preflight = await import("../src/preflight");
    const { run } = await import("../src/main");
    await run();

    expect(vi.mocked(preflight.validateConfig)).not.toHaveBeenCalled();
  });
});
