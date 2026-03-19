import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getChangedFiles,
  filterIssuesByChangedFiles,
  filterComponentsByIssues,
} from "../src/pr-files";
import { SonarQubeIssue, SonarQubeComponent } from "../src/sonarqube-types";

// Mock @actions/core
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
}));

// Mock @actions/github
const mockListFiles = vi.fn();

vi.mock("@actions/github", () => ({
  context: {
    repo: { repo: "test-repo", owner: "test-owner" },
  },
  getOctokit: vi.fn(() => ({
    rest: {
      pulls: {
        listFiles: mockListFiles,
      },
    },
  })),
}));

import * as core from "@actions/core";

describe("pr-files", () => {
  const mockComponents: SonarQubeComponent[] = [
    {
      key: "project:src/main.ts",
      qualifier: "FIL",
      name: "main.ts",
      path: "src/main.ts",
    },
    {
      key: "project:src/config.ts",
      qualifier: "FIL",
      name: "config.ts",
      path: "src/config.ts",
    },
    {
      key: "project:src/utils.ts",
      qualifier: "FIL",
      name: "utils.ts",
      path: "src/utils.ts",
    },
    {
      key: "project:src/legacy.ts",
      qualifier: "FIL",
      name: "legacy.ts",
      path: "src/legacy.ts",
    },
  ];

  const mockIssues: SonarQubeIssue[] = [
    {
      key: "issue-1",
      rule: "ts:S1234",
      severity: "MAJOR",
      component: "project:src/main.ts",
      project: "project",
      line: 10,
      status: "OPEN",
      message: "Issue in main.ts",
      type: "BUG",
    },
    {
      key: "issue-2",
      rule: "ts:S1234",
      severity: "MINOR",
      component: "project:src/config.ts",
      project: "project",
      line: 20,
      status: "OPEN",
      message: "Issue in config.ts",
      type: "CODE_SMELL",
    },
    {
      key: "issue-3",
      rule: "ts:S5678",
      severity: "CRITICAL",
      component: "project:src/legacy.ts",
      project: "project",
      line: 30,
      status: "OPEN",
      message: "Issue in legacy.ts",
      type: "VULNERABILITY",
    },
    {
      key: "issue-4",
      rule: "ts:S9999",
      severity: "INFO",
      component: "project:src/utils.ts",
      project: "project",
      line: 5,
      status: "OPEN",
      message: "Issue in utils.ts",
      type: "CODE_SMELL",
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getChangedFiles", () => {
    it("fetches changed files from GitHub API", async () => {
      mockListFiles.mockResolvedValueOnce({
        data: [
          { filename: "src/main.ts" },
          { filename: "src/config.ts" },
          { filename: "README.md" },
        ],
      });

      const files = await getChangedFiles("test-token", 123);

      expect(files).toEqual(["src/main.ts", "src/config.ts", "README.md"]);
      expect(mockListFiles).toHaveBeenCalledWith({
        owner: "test-owner",
        repo: "test-repo",
        pull_number: 123,
        per_page: 100,
        page: 1,
      });
    });

    it("paginates when there are many files", async () => {
      // First page: 100 files
      const page1 = Array.from({ length: 100 }, (_, i) => ({
        filename: `file${i}.ts`,
      }));
      // Second page: 50 files
      const page2 = Array.from({ length: 50 }, (_, i) => ({
        filename: `file${100 + i}.ts`,
      }));

      mockListFiles
        .mockResolvedValueOnce({ data: page1 })
        .mockResolvedValueOnce({ data: page2 });

      const files = await getChangedFiles("test-token", 123);

      expect(files).toHaveLength(150);
      expect(mockListFiles).toHaveBeenCalledTimes(2);
    });

    it("returns empty array on error and warns about fallback", async () => {
      mockListFiles.mockRejectedValueOnce(new Error("API error"));

      const files = await getChangedFiles("test-token", 123);

      expect(files).toEqual([]);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          "Failed to fetch PR files: API error. Falling back to showing all issues (PR file filtering disabled).",
        ),
      );
    });
  });

  describe("filterIssuesByChangedFiles", () => {
    it("filters issues to only those in changed files", () => {
      const changedFiles = ["src/main.ts", "src/config.ts"];

      const { filtered, excludedCount } = filterIssuesByChangedFiles(
        mockIssues,
        mockComponents,
        changedFiles,
      );

      expect(filtered).toHaveLength(2);
      expect(filtered.map((i) => i.key)).toEqual(["issue-1", "issue-2"]);
      expect(excludedCount).toBe(2);
    });

    it("returns all issues when changedFiles is empty", () => {
      const { filtered, excludedCount } = filterIssuesByChangedFiles(
        mockIssues,
        mockComponents,
        [],
      );

      expect(filtered).toHaveLength(4);
      expect(excludedCount).toBe(0);
    });

    it("excludes issues with unknown component paths", () => {
      const issuesWithUnknown: SonarQubeIssue[] = [
        ...mockIssues,
        {
          key: "issue-unknown",
          rule: "ts:S0000",
          severity: "MAJOR",
          component: "project:unknown/file.ts",
          project: "project",
          line: 1,
          status: "OPEN",
          message: "Unknown component",
          type: "BUG",
        },
      ];

      const changedFiles = ["src/main.ts", "unknown/file.ts"];

      const { filtered } = filterIssuesByChangedFiles(
        issuesWithUnknown,
        mockComponents,
        changedFiles,
      );

      // Only main.ts issue should be included (unknown component has no path mapping)
      expect(filtered).toHaveLength(1);
      expect(filtered[0].key).toBe("issue-1");
    });

    it("handles case where no issues match changed files", () => {
      const changedFiles = ["src/newfile.ts", "docs/README.md"];

      const { filtered, excludedCount } = filterIssuesByChangedFiles(
        mockIssues,
        mockComponents,
        changedFiles,
      );

      expect(filtered).toHaveLength(0);
      expect(excludedCount).toBe(4);
    });

    it("logs info when issues are filtered", () => {
      const changedFiles = ["src/main.ts"];

      filterIssuesByChangedFiles(mockIssues, mockComponents, changedFiles);

      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining("Filtered to PR changes"),
      );
    });
  });

  describe("filterComponentsByIssues", () => {
    it("keeps only components that have issues", () => {
      const issues = mockIssues.slice(0, 2); // Only main.ts and config.ts issues

      const filtered = filterComponentsByIssues(mockComponents, issues);

      expect(filtered).toHaveLength(2);
      expect(filtered.map((c) => c.path)).toEqual([
        "src/main.ts",
        "src/config.ts",
      ]);
    });

    it("returns empty array when no issues", () => {
      const filtered = filterComponentsByIssues(mockComponents, []);

      expect(filtered).toHaveLength(0);
    });

    it("handles all components having issues", () => {
      const filtered = filterComponentsByIssues(mockComponents, mockIssues);

      expect(filtered).toHaveLength(4);
    });
  });
});
