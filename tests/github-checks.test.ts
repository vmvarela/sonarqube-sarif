import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  shouldFailCheck,
  determineConclusion,
  createAnnotations,
  formatCheckSummary,
  createCheckRun,
} from "../src/github-checks";
import { ConversionStats } from "../src/stats";
import { ActionConfig } from "../src/config";
import { SonarQubeIssue, SonarQubeComponent } from "../src/sonarqube-types";

// Mock @actions/core
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
  setFailed: vi.fn(),
}));

// Mock @actions/github
const mockCreateCheck = vi.fn();

vi.mock("@actions/github", () => ({
  context: {
    repo: { repo: "test-repo", owner: "test-owner" },
    sha: "abc123",
    ref: "refs/heads/main",
    payload: {
      pull_request: {
        number: 42,
        head: { sha: "def456", ref: "feature-branch" },
      },
    },
  },
  getOctokit: vi.fn(() => ({
    rest: {
      checks: {
        create: mockCreateCheck,
      },
    },
  })),
}));

import * as core from "@actions/core";

describe("github-checks", () => {
  const mockStats: ConversionStats = {
    totalIssues: 5,
    uniqueRules: 3,
    components: 2,
    bySeverity: {
      BLOCKER: 1,
      CRITICAL: 1,
      MAJOR: 2,
      MINOR: 1,
      INFO: 0,
    },
    byType: {
      BUG: 2,
      VULNERABILITY: 1,
      CODE_SMELL: 2,
      SECURITY_HOTSPOT: 0,
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
    githubToken: "test-token",
  };

  const mockIssues: SonarQubeIssue[] = [
    {
      key: "issue-1",
      rule: "java:S1234",
      severity: "CRITICAL",
      component: "project:src/main/File.java",
      project: "project",
      line: 10,
      textRange: { startLine: 10, endLine: 12, startOffset: 0, endOffset: 20 },
      status: "OPEN",
      message: "Fix this critical issue",
      type: "BUG",
    },
    {
      key: "issue-2",
      rule: "java:S5678",
      severity: "MAJOR",
      component: "project:src/main/Other.java",
      project: "project",
      line: 25,
      status: "OPEN",
      message: "Fix this major issue",
      type: "CODE_SMELL",
    },
  ];

  const mockComponents: SonarQubeComponent[] = [
    {
      key: "project:src/main/File.java",
      qualifier: "FIL",
      name: "File.java",
      path: "src/main/File.java",
    },
    {
      key: "project:src/main/Other.java",
      qualifier: "FIL",
      name: "Other.java",
      path: "src/main/Other.java",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("shouldFailCheck", () => {
    it("returns false when failOnSeverity is undefined", () => {
      expect(shouldFailCheck(mockStats, undefined)).toBe(false);
    });

    it("returns true when issues exist at threshold severity", () => {
      expect(shouldFailCheck(mockStats, "CRITICAL")).toBe(true);
      expect(shouldFailCheck(mockStats, "MAJOR")).toBe(true);
      expect(shouldFailCheck(mockStats, "BLOCKER")).toBe(true);
    });

    it("returns false when no issues at or above threshold", () => {
      const statsNoHighSeverity: ConversionStats = {
        ...mockStats,
        bySeverity: {
          BLOCKER: 0,
          CRITICAL: 0,
          MAJOR: 0,
          MINOR: 3,
          INFO: 2,
        },
      };
      expect(shouldFailCheck(statsNoHighSeverity, "MAJOR")).toBe(false);
      expect(shouldFailCheck(statsNoHighSeverity, "MINOR")).toBe(true);
    });
  });

  describe("determineConclusion", () => {
    it("returns success when no issues", () => {
      const emptyStats: ConversionStats = {
        ...mockStats,
        totalIssues: 0,
        bySeverity: { BLOCKER: 0, CRITICAL: 0, MAJOR: 0, MINOR: 0, INFO: 0 },
      };
      expect(determineConclusion(emptyStats, undefined)).toBe("success");
      expect(determineConclusion(emptyStats, "CRITICAL")).toBe("success");
    });

    it("returns neutral when issues exist but no failOnSeverity", () => {
      expect(determineConclusion(mockStats, undefined)).toBe("neutral");
    });

    it("returns failure when issues at or above failOnSeverity", () => {
      expect(determineConclusion(mockStats, "CRITICAL")).toBe("failure");
      expect(determineConclusion(mockStats, "MAJOR")).toBe("failure");
    });

    it("returns neutral when issues below failOnSeverity", () => {
      const statsLowSeverity: ConversionStats = {
        ...mockStats,
        bySeverity: {
          BLOCKER: 0,
          CRITICAL: 0,
          MAJOR: 0,
          MINOR: 2,
          INFO: 1,
        },
      };
      expect(determineConclusion(statsLowSeverity, "MAJOR")).toBe("neutral");
    });
  });

  describe("createAnnotations", () => {
    it("creates annotations from issues", () => {
      const annotations = createAnnotations(mockIssues, mockComponents);

      expect(annotations).toHaveLength(2);
      expect(annotations[0]).toEqual({
        path: "src/main/File.java",
        start_line: 10,
        end_line: 12,
        annotation_level: "failure",
        message: "Fix this critical issue",
        title: "[CRITICAL] java:S1234",
      });
      expect(annotations[1]).toEqual({
        path: "src/main/Other.java",
        start_line: 25,
        end_line: 25,
        annotation_level: "warning",
        message: "Fix this major issue",
        title: "[MAJOR] java:S5678",
      });
    });

    it("sorts by severity (most severe first)", () => {
      const mixedIssues: SonarQubeIssue[] = [
        { ...mockIssues[1], severity: "MINOR" },
        { ...mockIssues[0], severity: "BLOCKER" },
      ];

      const annotations = createAnnotations(mixedIssues, mockComponents);

      expect(annotations[0].annotation_level).toBe("failure"); // BLOCKER
      expect(annotations[1].annotation_level).toBe("notice"); // MINOR
    });

    it("skips issues without path mapping", () => {
      const issuesWithUnknownComponent: SonarQubeIssue[] = [
        { ...mockIssues[0], component: "unknown:component" },
      ];

      const annotations = createAnnotations(issuesWithUnknownComponent, mockComponents);
      expect(annotations).toHaveLength(0);
    });

    it("limits annotations to 50", () => {
      const manyIssues: SonarQubeIssue[] = Array.from({ length: 60 }, (_, i) => ({
        ...mockIssues[0],
        key: `issue-${i}`,
      }));

      const annotations = createAnnotations(manyIssues, mockComponents);
      expect(annotations).toHaveLength(50);
    });
  });

  describe("formatCheckSummary", () => {
    it("formats summary with issues", () => {
      const summary = formatCheckSummary(mockStats, mockConfig);

      expect(summary).toContain("## 🔍 SonarQube Analysis Results");
      expect(summary).toContain("| Total Issues | 5 |");
      expect(summary).toContain("| Unique Rules | 3 |");
      expect(summary).toContain("### By Severity");
      expect(summary).toContain("| BLOCKER | 1 |");
      expect(summary).toContain("### By Type");
      expect(summary).toContain("| BUG | 2 |");
      expect(summary).toContain("View in Security Tab");
      expect(summary).toContain("pr%3A42");
      expect(summary).toContain("tool%3ASonarQube");
      expect(summary).toContain("📊 [View in SonarQube]");
      expect(summary).toContain("https://sonar.example.com/dashboard?id=my-project");
    });

    it("formats summary when no issues", () => {
      const emptyStats: ConversionStats = {
        ...mockStats,
        totalIssues: 0,
        bySeverity: { BLOCKER: 0, CRITICAL: 0, MAJOR: 0, MINOR: 0, INFO: 0 },
        byType: { BUG: 0, VULNERABILITY: 0, CODE_SMELL: 0, SECURITY_HOTSPOT: 0 },
      };

      const summary = formatCheckSummary(emptyStats, mockConfig);

      expect(summary).toContain("## ✅ No issues found!");
      expect(summary).toContain("Great job!");
    });

    it("includes filtered message when issues were filtered", () => {
      const statsWithFiltered = { ...mockStats, filtered: 10 };
      const configWithMinSeverity = { ...mockConfig, minSeverity: "MAJOR" as const };

      const summary = formatCheckSummary(statsWithFiltered, configWithMinSeverity);

      expect(summary).toContain("10 issues were filtered out");
    });
  });

  describe("createCheckRun", () => {
    it("creates check run with annotations", async () => {
      mockCreateCheck.mockResolvedValueOnce({});

      await createCheckRun({
        config: mockConfig,
        stats: mockStats,
        issues: mockIssues,
        components: mockComponents,
      });

      expect(mockCreateCheck).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        name: "SonarQube Analysis",
        head_sha: "def456",
        status: "completed",
        conclusion: "neutral",
        output: {
          title: "Found 5 issues",
          summary: expect.stringContaining("SonarQube Analysis Results"),
          annotations: expect.arrayContaining([
            expect.objectContaining({ path: "src/main/File.java" }),
          ]),
        },
      });

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Created check run"),
      );
    });

    it("marks check as failure when failOnSeverity threshold met", async () => {
      mockCreateCheck.mockResolvedValueOnce({});

      await createCheckRun({
        config: { ...mockConfig, failOnSeverity: "CRITICAL" },
        stats: mockStats,
        issues: mockIssues,
        components: mockComponents,
      });

      expect(mockCreateCheck).toHaveBeenCalledWith(
        expect.objectContaining({ conclusion: "failure" }),
      );
      expect(core.setFailed).toHaveBeenCalledWith(
        expect.stringContaining("CRITICAL severity"),
      );
    });

    it("marks check as success when no issues", async () => {
      mockCreateCheck.mockResolvedValueOnce({});

      const emptyStats: ConversionStats = {
        ...mockStats,
        totalIssues: 0,
        bySeverity: { BLOCKER: 0, CRITICAL: 0, MAJOR: 0, MINOR: 0, INFO: 0 },
      };

      await createCheckRun({
        config: mockConfig,
        stats: emptyStats,
        issues: [],
        components: [],
      });

      expect(mockCreateCheck).toHaveBeenCalledWith(
        expect.objectContaining({
          conclusion: "success",
          output: expect.objectContaining({ title: "No issues found" }),
        }),
      );
    });

    it("warns when GitHub token is missing", async () => {
      const configWithoutToken = { ...mockConfig, githubToken: undefined };
      delete process.env.GITHUB_TOKEN;

      await createCheckRun({
        config: configWithoutToken,
        stats: mockStats,
        issues: mockIssues,
        components: mockComponents,
      });

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("GitHub token not available"),
      );
      expect(mockCreateCheck).not.toHaveBeenCalled();
    });

    it("warns on API error but does not throw", async () => {
      mockCreateCheck.mockRejectedValueOnce(new Error("API error"));

      await createCheckRun({
        config: mockConfig,
        stats: mockStats,
        issues: mockIssues,
        components: mockComponents,
      });

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Failed to create check run"),
      );
    });
  });
});
