import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatSummaryMarkdown,
  findExistingComment,
  writePrComment,
} from "../src/pr-comment";
import { ConversionStats } from "../src/stats";
import { ActionConfig, DEFAULT_CONFIG } from "../src/config";

// Mock @actions/core
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
}));

// Mock @actions/github
const mockCreateComment = vi.fn();
const mockUpdateComment = vi.fn();
const mockListComments = vi.fn();

vi.mock("@actions/github", () => ({
  context: {
    repo: { repo: "test-repo", owner: "test-owner" },
    payload: { pull_request: { number: 42, head: { ref: "feature-branch" } } },
  },
  getOctokit: vi.fn(() => ({
    rest: {
      issues: {
        createComment: mockCreateComment,
        updateComment: mockUpdateComment,
        listComments: mockListComments,
      },
    },
  })),
}));

import * as core from "@actions/core";

const COMMENT_MARKER = "<!-- sonarqube-sarif-action -->";

describe("pr-comment", () => {
  const mockStats: ConversionStats = {
    totalIssues: 10,
    uniqueRules: 5,
    components: 3,
    bySeverity: {
      BLOCKER: 1,
      CRITICAL: 2,
      MAJOR: 3,
      MINOR: 2,
      INFO: 2,
    },
    byType: {
      BUG: 3,
      VULNERABILITY: 2,
      CODE_SMELL: 4,
      SECURITY_HOTSPOT: 1,
    },
    filtered: 0,
  };

  const mockConfig: ActionConfig = {
    sonarHostUrl: "https://sonar.example.com",
    sonarToken: "token",
    projectKey: "my-project",
    projectKeySource: "input",
    repositoryProjectKey: "my-project",
    outputFile: "sonarqube.sarif",
    pullRequestNumber: 42,
    waitForProcessing: true,
    maxWaitTime: 300,
    pollingInterval: 10,
    processingDelay: 0,
    minSeverity: "INFO",
    includeResolved: false,
    prComment: true,
    failOnSeverity: undefined,
    githubToken: "test-token",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
  });

  describe("formatSummaryMarkdown", () => {
    it("generates markdown with all statistics", () => {
      const markdown = formatSummaryMarkdown(mockStats, mockConfig);

      expect(markdown).toContain(COMMENT_MARKER);
      expect(markdown).toContain("## 🔍 SonarQube Analysis Results");
      expect(markdown).toContain("| Total Issues | 10 |");
      expect(markdown).toContain("| Unique Rules | 5 |");
      expect(markdown).toContain("| Files Affected | 3 |");
      expect(markdown).toContain("### By Severity");
      expect(markdown).toContain("| BLOCKER | 1 |");
      expect(markdown).toContain("| CRITICAL | 2 |");
      expect(markdown).toContain("### By Type");
      expect(markdown).toContain("| BUG | 3 |");
      expect(markdown).toContain("| VULNERABILITY | 2 |");
      expect(markdown).toContain("🔒 [View in Security Tab]");
      expect(markdown).toContain(
        "https://github.com/test-owner/test-repo/security/code-scanning",
      );
      expect(markdown).toContain("pr%3A42");
      expect(markdown).toContain("tool%3ASonarQube");
      expect(markdown).toContain("📊 [View in SonarQube]");
      expect(markdown).toContain(
        "https://sonar.example.com/dashboard?id=my-project",
      );
    });

    it("includes filtered message when issues were filtered", () => {
      const statsWithFiltered = { ...mockStats, filtered: 5 };
      const configWithMinSeverity = {
        ...mockConfig,
        minSeverity: "MAJOR" as const,
      };
      const markdown = formatSummaryMarkdown(
        statsWithFiltered,
        configWithMinSeverity,
      );

      expect(markdown).toContain("5 issues were filtered out");
      expect(markdown).toContain("below MAJOR severity threshold");
    });

    it("shows success message when no issues", () => {
      const emptyStats: ConversionStats = {
        totalIssues: 0,
        uniqueRules: 0,
        components: 0,
        bySeverity: {
          BLOCKER: 0,
          CRITICAL: 0,
          MAJOR: 0,
          MINOR: 0,
          INFO: 0,
        },
        byType: {
          BUG: 0,
          VULNERABILITY: 0,
          CODE_SMELL: 0,
          SECURITY_HOTSPOT: 0,
        },
        filtered: 0,
      };

      const markdown = formatSummaryMarkdown(emptyStats, mockConfig);

      expect(markdown).toContain("✅ **No issues found!**");
      expect(markdown).toContain("Your code looks clean");
    });

    it("omits severity section when all counts are zero", () => {
      const emptyStats: ConversionStats = {
        totalIssues: 0,
        uniqueRules: 0,
        components: 0,
        bySeverity: {
          BLOCKER: 0,
          CRITICAL: 0,
          MAJOR: 0,
          MINOR: 0,
          INFO: 0,
        },
        byType: {
          BUG: 0,
          VULNERABILITY: 0,
          CODE_SMELL: 0,
          SECURITY_HOTSPOT: 0,
        },
        filtered: 0,
      };

      const markdown = formatSummaryMarkdown(emptyStats, mockConfig);

      expect(markdown).not.toContain("### By Severity");
      expect(markdown).not.toContain("### By Type");
    });
  });

  describe("findExistingComment", () => {
    it("finds comment with marker on first page", async () => {
      const { getOctokit } = await import("@actions/github");
      const octokit = getOctokit("token");

      mockListComments.mockResolvedValueOnce({
        data: [
          { id: 1, body: "Random comment" },
          { id: 42, body: `${COMMENT_MARKER}\nSome content` },
          { id: 3, body: "Another comment" },
        ],
      });

      const result = await findExistingComment(
        octokit as any,
        "owner",
        "repo",
        123,
      );

      expect(result).toBe(42);
      expect(mockListComments).toHaveBeenCalledTimes(1);
      expect(mockListComments).toHaveBeenCalledWith({
        owner: "owner",
        repo: "repo",
        issue_number: 123,
        per_page: 100,
        page: 1,
      });
    });

    it("finds comment with marker on second page", async () => {
      const { getOctokit } = await import("@actions/github");
      const octokit = getOctokit("token");

      // Page 1: 100 comments without marker
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        body: `Generic comment ${i + 1}`,
      }));
      // Page 2: marker comment
      const page2 = [{ id: 200, body: `${COMMENT_MARKER}\nFound it` }];

      mockListComments
        .mockResolvedValueOnce({ data: page1 })
        .mockResolvedValueOnce({ data: page2 });

      const result = await findExistingComment(
        octokit as any,
        "owner",
        "repo",
        123,
      );

      expect(result).toBe(200);
      expect(mockListComments).toHaveBeenCalledTimes(2);
      expect(mockListComments).toHaveBeenNthCalledWith(1, {
        owner: "owner",
        repo: "repo",
        issue_number: 123,
        per_page: 100,
        page: 1,
      });
      expect(mockListComments).toHaveBeenNthCalledWith(2, {
        owner: "owner",
        repo: "repo",
        issue_number: 123,
        per_page: 100,
        page: 2,
      });
    });

    it("returns null when no comment with marker exists across all pages", async () => {
      const { getOctokit } = await import("@actions/github");
      const octokit = getOctokit("token");

      // Page 1: 100 comments without marker (full page — triggers next page)
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        id: i + 1,
        body: `Generic comment ${i + 1}`,
      }));

      mockListComments
        .mockResolvedValueOnce({ data: page1 })
        .mockResolvedValueOnce({ data: [] }); // page 2 empty → stop

      const result = await findExistingComment(
        octokit as any,
        "owner",
        "repo",
        123,
      );

      expect(result).toBeNull();
      expect(mockListComments).toHaveBeenCalledTimes(2);
    });

    it("stops after first page when fewer than 100 comments", async () => {
      const { getOctokit } = await import("@actions/github");
      const octokit = getOctokit("token");

      mockListComments.mockResolvedValueOnce({
        data: [
          { id: 1, body: "Random comment" },
          { id: 2, body: "Another comment" },
        ],
      });

      const result = await findExistingComment(
        octokit as any,
        "owner",
        "repo",
        123,
      );

      expect(result).toBeNull();
      expect(mockListComments).toHaveBeenCalledTimes(1);
    });

    it("returns null on error", async () => {
      const { getOctokit } = await import("@actions/github");
      const octokit = getOctokit("token");

      mockListComments.mockRejectedValueOnce(new Error("API error"));

      const result = await findExistingComment(
        octokit as any,
        "owner",
        "repo",
        123,
      );

      expect(result).toBeNull();
      expect(core.debug).toHaveBeenCalledWith(
        expect.stringContaining("Failed to list comments"),
      );
    });
  });

  describe("writePrComment", () => {
    it("creates new comment when none exists", async () => {
      mockListComments.mockResolvedValueOnce({ data: [] });
      mockCreateComment.mockResolvedValueOnce({ data: { id: 999 } });

      await writePrComment(mockConfig, mockStats);

      expect(mockCreateComment).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        issue_number: 42,
        body: expect.stringContaining(COMMENT_MARKER),
      });
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Created new PR comment"),
      );
    });

    it("updates existing comment when one exists", async () => {
      mockListComments.mockResolvedValueOnce({
        data: [{ id: 123, body: `${COMMENT_MARKER}\nOld content` }],
      });
      mockUpdateComment.mockResolvedValueOnce({});

      await writePrComment(mockConfig, mockStats);

      expect(mockUpdateComment).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        comment_id: 123,
        body: expect.stringContaining(COMMENT_MARKER),
      });
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Updated existing PR comment"),
      );
    });

    it("warns when GitHub token is missing", async () => {
      delete process.env.GITHUB_TOKEN;
      const configWithoutToken = { ...mockConfig, githubToken: undefined };

      await writePrComment(configWithoutToken, mockStats);

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("GitHub token not available"),
      );
      expect(mockCreateComment).not.toHaveBeenCalled();
    });

    it("skips when not in PR context", async () => {
      const configWithoutPR = { ...mockConfig, pullRequestNumber: undefined };

      await writePrComment(configWithoutPR, mockStats);

      expect(core.debug).toHaveBeenCalledWith(
        expect.stringContaining("Not in a pull request context"),
      );
      expect(mockCreateComment).not.toHaveBeenCalled();
    });

    it("warns on API error but does not throw", async () => {
      mockListComments.mockResolvedValueOnce({ data: [] });
      mockCreateComment.mockRejectedValueOnce(new Error("API error"));

      await writePrComment(mockConfig, mockStats);

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to post PR comment"),
      );
    });
  });
});
