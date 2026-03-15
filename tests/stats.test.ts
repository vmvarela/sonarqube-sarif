import { describe, it, expect } from "vitest";
import { calculateStats, filterBySeverity, formatStatsForLog } from "../src/stats";
import { SonarQubeSearchResponse, SonarQubeIssue } from "../src/sonarqube-types";

function createMockIssue(
  overrides: Partial<SonarQubeIssue> = {},
): SonarQubeIssue {
  return {
    key: "test-key",
    rule: "test:rule",
    severity: "MAJOR",
    component: "project:file.js",
    project: "project",
    message: "Test message",
    status: "OPEN",
    type: "CODE_SMELL",
    ...overrides,
  };
}

function createMockResponse(
  issues: SonarQubeIssue[] = [],
): SonarQubeSearchResponse {
  return {
    total: issues.length,
    p: 1,
    ps: 100,
    paging: { pageIndex: 1, pageSize: 100, total: issues.length },
    issues,
    components: [{ key: "project:file.js", name: "file.js", qualifier: "FIL" }],
    rules: [{ key: "test:rule", name: "Test Rule", status: "READY" }],
  };
}

describe("stats", () => {
  describe("calculateStats", () => {
    it("returns zero counts for empty issues", () => {
      const stats = calculateStats(createMockResponse());

      expect(stats.totalIssues).toBe(0);
      expect(stats.uniqueRules).toBe(1);
      expect(stats.components).toBe(1);
      expect(stats.bySeverity.BLOCKER).toBe(0);
      expect(stats.bySeverity.CRITICAL).toBe(0);
      expect(stats.bySeverity.MAJOR).toBe(0);
      expect(stats.bySeverity.MINOR).toBe(0);
      expect(stats.bySeverity.INFO).toBe(0);
      expect(stats.byType.BUG).toBe(0);
      expect(stats.byType.VULNERABILITY).toBe(0);
      expect(stats.byType.CODE_SMELL).toBe(0);
      expect(stats.byType.SECURITY_HOTSPOT).toBe(0);
    });

    it("counts issues by severity", () => {
      const issues = [
        createMockIssue({ severity: "BLOCKER" }),
        createMockIssue({ severity: "CRITICAL" }),
        createMockIssue({ severity: "CRITICAL" }),
        createMockIssue({ severity: "MAJOR" }),
        createMockIssue({ severity: "MINOR" }),
        createMockIssue({ severity: "INFO" }),
      ];
      const stats = calculateStats(createMockResponse(issues));

      expect(stats.bySeverity.BLOCKER).toBe(1);
      expect(stats.bySeverity.CRITICAL).toBe(2);
      expect(stats.bySeverity.MAJOR).toBe(1);
      expect(stats.bySeverity.MINOR).toBe(1);
      expect(stats.bySeverity.INFO).toBe(1);
    });

    it("counts issues by type", () => {
      const issues = [
        createMockIssue({ type: "BUG" }),
        createMockIssue({ type: "VULNERABILITY" }),
        createMockIssue({ type: "VULNERABILITY" }),
        createMockIssue({ type: "CODE_SMELL" }),
        createMockIssue({ type: "SECURITY_HOTSPOT" }),
      ];
      const stats = calculateStats(createMockResponse(issues));

      expect(stats.byType.BUG).toBe(1);
      expect(stats.byType.VULNERABILITY).toBe(2);
      expect(stats.byType.CODE_SMELL).toBe(1);
      expect(stats.byType.SECURITY_HOTSPOT).toBe(1);
    });

    it("tracks filtered count", () => {
      const stats = calculateStats(createMockResponse(), 5);

      expect(stats.filtered).toBe(5);
    });
  });

  describe("filterBySeverity", () => {
    const allSeverities = [
      createMockIssue({ key: "1", severity: "INFO" }),
      createMockIssue({ key: "2", severity: "MINOR" }),
      createMockIssue({ key: "3", severity: "MAJOR" }),
      createMockIssue({ key: "4", severity: "CRITICAL" }),
      createMockIssue({ key: "5", severity: "BLOCKER" }),
    ];

    it("returns all issues when minSeverity is INFO", () => {
      const { filtered, removedCount } = filterBySeverity(
        allSeverities,
        "INFO",
      );

      expect(filtered).toHaveLength(5);
      expect(removedCount).toBe(0);
    });

    it("filters out INFO when minSeverity is MINOR", () => {
      const { filtered, removedCount } = filterBySeverity(
        allSeverities,
        "MINOR",
      );

      expect(filtered).toHaveLength(4);
      expect(removedCount).toBe(1);
      expect(filtered.every((i) => i.severity !== "INFO")).toBe(true);
    });

    it("filters out INFO and MINOR when minSeverity is MAJOR", () => {
      const { filtered, removedCount } = filterBySeverity(
        allSeverities,
        "MAJOR",
      );

      expect(filtered).toHaveLength(3);
      expect(removedCount).toBe(2);
      expect(filtered.map((i) => i.severity)).toEqual([
        "MAJOR",
        "CRITICAL",
        "BLOCKER",
      ]);
    });

    it("keeps only CRITICAL and BLOCKER when minSeverity is CRITICAL", () => {
      const { filtered, removedCount } = filterBySeverity(
        allSeverities,
        "CRITICAL",
      );

      expect(filtered).toHaveLength(2);
      expect(removedCount).toBe(3);
      expect(filtered.map((i) => i.severity)).toEqual(["CRITICAL", "BLOCKER"]);
    });

    it("keeps only BLOCKER when minSeverity is BLOCKER", () => {
      const { filtered, removedCount } = filterBySeverity(
        allSeverities,
        "BLOCKER",
      );

      expect(filtered).toHaveLength(1);
      expect(removedCount).toBe(4);
      expect(filtered[0].severity).toBe("BLOCKER");
    });
  });

  describe("formatStatsForLog", () => {
    it("formats basic stats", () => {
      const stats = {
        totalIssues: 10,
        uniqueRules: 5,
        components: 3,
        bySeverity: { BLOCKER: 0, CRITICAL: 2, MAJOR: 5, MINOR: 2, INFO: 1 },
        byType: {
          BUG: 3,
          VULNERABILITY: 2,
          CODE_SMELL: 5,
          SECURITY_HOTSPOT: 0,
        },
        filtered: 0,
      };

      const lines = formatStatsForLog(stats);

      expect(lines).toContain("Total issues: 10");
      expect(lines).toContain("Unique rules: 5");
      expect(lines).toContain("Components: 3");
      expect(lines.some((l) => l.includes("CRITICAL: 2"))).toBe(true);
      expect(lines.some((l) => l.includes("BUG: 3"))).toBe(true);
    });

    it("includes filtered count when non-zero", () => {
      const stats = {
        totalIssues: 5,
        uniqueRules: 2,
        components: 1,
        bySeverity: { BLOCKER: 0, CRITICAL: 0, MAJOR: 5, MINOR: 0, INFO: 0 },
        byType: {
          BUG: 0,
          VULNERABILITY: 0,
          CODE_SMELL: 5,
          SECURITY_HOTSPOT: 0,
        },
        filtered: 3,
      };

      const lines = formatStatsForLog(stats);

      expect(lines.some((l) => l.includes("Filtered out: 3"))).toBe(true);
    });

    it("omits zero-count severities and types from summary", () => {
      const stats = {
        totalIssues: 1,
        uniqueRules: 1,
        components: 1,
        bySeverity: { BLOCKER: 0, CRITICAL: 0, MAJOR: 1, MINOR: 0, INFO: 0 },
        byType: {
          BUG: 0,
          VULNERABILITY: 0,
          CODE_SMELL: 1,
          SECURITY_HOTSPOT: 0,
        },
        filtered: 0,
      };

      const lines = formatStatsForLog(stats);
      const severityLine = lines.find((l) => l.includes("By severity"));
      const typeLine = lines.find((l) => l.includes("By type"));

      expect(severityLine).not.toContain("BLOCKER");
      expect(severityLine).toContain("MAJOR: 1");
      expect(typeLine).not.toContain("BUG");
      expect(typeLine).toContain("CODE_SMELL: 1");
    });
  });
});
