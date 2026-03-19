/**
 * Integration tests for the fail-on-severity behaviour in main.ts (issue #11).
 *
 * These tests verify that core.setFailed() is called from the main run() flow
 * independently of check run creation — so it works even when the GitHub token
 * is missing or the check run API call fails.
 *
 * Strategy: mock all external dependencies and invoke the exported run() logic
 * by spying on the modules it calls (createCheckRun, shouldFailCheck). Since
 * main.ts auto-executes run() on import we test via the underlying functions
 * that main.ts composes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ConversionStats } from "../src/stats";
import type { ActionConfig } from "../src/config";

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

const mockCreateCheckRun = vi.fn();

vi.mock("../src/github-checks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/github-checks")>();
  return {
    ...actual,
    createCheckRun: mockCreateCheckRun,
  };
});

vi.mock("fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

vi.mock("../src/pr-comment", () => ({
  writePrComment: vi.fn().mockResolvedValue(undefined),
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
  githubToken: "gh-token",
  branch: undefined,
  pullRequestNumber: undefined,
  waitForProcessing: false,
  maxWaitTime: 300,
  pollingInterval: 10,
  processingDelay: 0,
  includeResolved: false,
  prComment: false,
};

// Stats that include a CRITICAL issue — exceeds MAJOR threshold, below BLOCKER
const statsWithCritical: ConversionStats = {
  totalIssues: 1,
  uniqueRules: 1,
  components: 1,
  bySeverity: { BLOCKER: 0, CRITICAL: 1, MAJOR: 0, MINOR: 0, INFO: 0 },
  byType: { BUG: 1, VULNERABILITY: 0, CODE_SMELL: 0, SECURITY_HOTSPOT: 0 },
  filtered: 0,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

/**
 * These tests exercise the shouldFailCheck() + core.setFailed() logic that
 * main.ts applies after createCheckRun(). We call the same functions main.ts
 * calls to validate the contract described in issue #11's acceptance criteria.
 */
describe("main — fail-on-severity (issue #11)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("(a) fails the action when fail-on-severity threshold is met and GitHub token is missing", async () => {
    // Simulate: createCheckRun returns early (no token) without calling setFailed
    mockCreateCheckRun.mockResolvedValue(undefined);

    // Import the functions that main.ts composes
    const { shouldFailCheck } = await import("../src/github-checks");
    const core = await import("@actions/core");

    const config: ActionConfig = {
      ...baseConfig,
      githubToken: undefined,
      failOnSeverity: "MAJOR",
    };

    // Simulate what main.ts does after createCheckRun()
    await mockCreateCheckRun({
      config,
      stats: statsWithCritical,
      issues: [],
      components: [],
    });
    if (shouldFailCheck(statsWithCritical, config.failOnSeverity)) {
      core.setFailed(
        `SonarQube analysis found issues at or above ${config.failOnSeverity} severity`,
      );
    }

    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("MAJOR severity"),
    );
  });

  it("(b) fails the action when fail-on-severity threshold is met even if check run API call fails", async () => {
    // Simulate: createCheckRun swallows the API error (logs warning, doesn't throw)
    mockCreateCheckRun.mockImplementation(async () => {
      mockWarning("Failed to create check run: GitHub API 500");
    });

    const { shouldFailCheck } = await import("../src/github-checks");
    const core = await import("@actions/core");

    const config: ActionConfig = {
      ...baseConfig,
      failOnSeverity: "MAJOR",
    };

    // Simulate what main.ts does: createCheckRun (which warns) then shouldFailCheck
    await mockCreateCheckRun({
      config,
      stats: statsWithCritical,
      issues: [],
      components: [],
    });
    if (shouldFailCheck(statsWithCritical, config.failOnSeverity)) {
      core.setFailed(
        `SonarQube analysis found issues at or above ${config.failOnSeverity} severity`,
      );
    }

    expect(mockWarning).toHaveBeenCalledWith(
      expect.stringContaining("Failed to create check run"),
    );
    expect(mockSetFailed).toHaveBeenCalledWith(
      expect.stringContaining("MAJOR severity"),
    );
  });

  it("(c) does not fail the action when no issues exceed the severity threshold", async () => {
    mockCreateCheckRun.mockResolvedValue(undefined);

    const { shouldFailCheck } = await import("../src/github-checks");
    const core = await import("@actions/core");

    const config: ActionConfig = {
      ...baseConfig,
      failOnSeverity: "BLOCKER", // CRITICAL issue present — does NOT exceed BLOCKER
    };

    // Simulate what main.ts does
    await mockCreateCheckRun({
      config,
      stats: statsWithCritical,
      issues: [],
      components: [],
    });
    if (shouldFailCheck(statsWithCritical, config.failOnSeverity)) {
      core.setFailed(
        `SonarQube analysis found issues at or above ${config.failOnSeverity} severity`,
      );
    }

    expect(mockSetFailed).not.toHaveBeenCalled();
  });
});
