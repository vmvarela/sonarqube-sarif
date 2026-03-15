/**
 * Statistics and metrics for conversion results
 */

import * as coreModule from "@actions/core";
import { SonarQubeSearchResponse, SonarQubeIssue } from "./sonarqube-types";
import { SeverityLevel, SEVERITY_ORDER } from "./config";

export interface ConversionStats {
  totalIssues: number;
  uniqueRules: number;
  components: number;
  bySeverity: Record<string, number>;
  byType: Record<string, number>;
  filtered: number;
}

/**
 * Calculate statistics from SonarQube response
 */
export function calculateStats(
  data: SonarQubeSearchResponse,
  filtered: number = 0,
): ConversionStats {
  const bySeverity: Record<string, number> = {
    BLOCKER: 0,
    CRITICAL: 0,
    MAJOR: 0,
    MINOR: 0,
    INFO: 0,
  };

  const byType: Record<string, number> = {
    BUG: 0,
    VULNERABILITY: 0,
    CODE_SMELL: 0,
    SECURITY_HOTSPOT: 0,
  };

  for (const issue of data.issues) {
    if (issue.severity && bySeverity[issue.severity] !== undefined) {
      bySeverity[issue.severity]++;
    }
    if (issue.type && byType[issue.type] !== undefined) {
      byType[issue.type]++;
    }
  }

  return {
    totalIssues: data.issues.length,
    uniqueRules: data.rules.length,
    components: data.components.length,
    bySeverity,
    byType,
    filtered,
  };
}

/**
 * Filter issues by minimum severity
 */
export function filterBySeverity(
  issues: SonarQubeIssue[],
  minSeverity: SeverityLevel,
): { filtered: SonarQubeIssue[]; removedCount: number } {
  const minLevel = SEVERITY_ORDER[minSeverity];
  const filtered = issues.filter((issue) => {
    const issueLevel = SEVERITY_ORDER[issue.severity as SeverityLevel] ?? 0;
    return issueLevel >= minLevel;
  });

  return {
    filtered,
    removedCount: issues.length - filtered.length,
  };
}

/**
 * Format stats for logging
 */
export function formatStatsForLog(stats: ConversionStats): string[] {
  const lines: string[] = [
    `Total issues: ${stats.totalIssues}`,
    `Unique rules: ${stats.uniqueRules}`,
    `Components: ${stats.components}`,
  ];

  if (stats.filtered > 0) {
    lines.push(`Filtered out: ${stats.filtered} (below severity threshold)`);
  }

  const severities = Object.entries(stats.bySeverity)
    .filter(([_, count]) => count > 0)
    .map(([sev, count]) => `${sev}: ${count}`)
    .join(", ");

  if (severities) {
    lines.push(`By severity: ${severities}`);
  }

  const types = Object.entries(stats.byType)
    .filter(([_, count]) => count > 0)
    .map(([type, count]) => `${type}: ${count}`)
    .join(", ");

  if (types) {
    lines.push(`By type: ${types}`);
  }

  return lines;
}

/**
 * Set action outputs for stats
 */
export function setStatsOutputs(stats: ConversionStats): void {
  // Import is at top level, but function is designed to work with mock in tests
  const core = coreModule;

  core.setOutput("issues-count", stats.totalIssues);
  core.setOutput("rules-count", stats.uniqueRules);
  core.setOutput("components-count", stats.components);

  // Individual severity counts
  core.setOutput("blocker-count", stats.bySeverity.BLOCKER ?? 0);
  core.setOutput("critical-count", stats.bySeverity.CRITICAL ?? 0);
  core.setOutput("major-count", stats.bySeverity.MAJOR ?? 0);
  core.setOutput("minor-count", stats.bySeverity.MINOR ?? 0);
  core.setOutput("info-count", stats.bySeverity.INFO ?? 0);

  // Individual type counts
  core.setOutput("bugs-count", stats.byType.BUG ?? 0);
  core.setOutput("vulnerabilities-count", stats.byType.VULNERABILITY ?? 0);
  core.setOutput("code-smells-count", stats.byType.CODE_SMELL ?? 0);
  core.setOutput("hotspots-count", stats.byType.SECURITY_HOTSPOT ?? 0);
}
