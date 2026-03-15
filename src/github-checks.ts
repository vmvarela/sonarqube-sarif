/**
 * GitHub Check Run functionality
 * Creates check runs with annotations for SonarQube issues
 */

import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { ActionConfig, SeverityLevel, SEVERITY_ORDER } from "./config";
import { ConversionStats } from "./stats";
import { SonarQubeIssue, SonarQubeComponent } from "./sonarqube-types";

// GitHub limits annotations to 50 per check run
const MAX_ANNOTATIONS = 50;

// Map SonarQube severity to GitHub annotation level
type AnnotationLevel = "failure" | "warning" | "notice";
const ANNOTATION_LEVEL: Record<string, AnnotationLevel> = {
  BLOCKER: "failure",
  CRITICAL: "failure",
  MAJOR: "warning",
  MINOR: "notice",
  INFO: "notice",
};

interface CheckRunParams {
  config: ActionConfig;
  stats: ConversionStats;
  issues: SonarQubeIssue[];
  components: SonarQubeComponent[];
}

/**
 * Determine if the check should fail based on issues and fail-on-severity config
 */
export function shouldFailCheck(
  stats: ConversionStats,
  failOnSeverity?: SeverityLevel,
): boolean {
  if (!failOnSeverity) {
    return false;
  }

  const threshold = SEVERITY_ORDER[failOnSeverity];

  // Check if any severity at or above threshold has issues
  for (const [severity, count] of Object.entries(stats.bySeverity)) {
    if (count > 0 && SEVERITY_ORDER[severity as SeverityLevel] >= threshold) {
      return true;
    }
  }

  return false;
}

/**
 * Determine check conclusion based on issues and config
 */
export function determineConclusion(
  stats: ConversionStats,
  failOnSeverity?: SeverityLevel,
): "success" | "failure" | "neutral" {
  if (stats.totalIssues === 0) {
    return "success";
  }

  if (shouldFailCheck(stats, failOnSeverity)) {
    return "failure";
  }

  return "neutral";
}

/**
 * Build component path map for resolving file paths
 */
function buildComponentPathMap(
  components: SonarQubeComponent[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const component of components) {
    if (component.path) {
      map.set(component.key, component.path);
    }
  }
  return map;
}

/**
 * Create annotations from SonarQube issues
 */
export function createAnnotations(
  issues: SonarQubeIssue[],
  components: SonarQubeComponent[],
): Array<{
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  message: string;
  title: string;
}> {
  const componentMap = buildComponentPathMap(components);
  const annotations: Array<{
    path: string;
    start_line: number;
    end_line: number;
    annotation_level: "failure" | "warning" | "notice";
    message: string;
    title: string;
  }> = [];

  // Sort by severity (most severe first) to ensure important issues get annotated
  const sortedIssues = [...issues].sort((a, b) => {
    return SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
  });

  for (const issue of sortedIssues) {
    if (annotations.length >= MAX_ANNOTATIONS) {
      break;
    }

    const path = componentMap.get(issue.component);
    if (!path) {
      continue;
    }

    const startLine = issue.textRange?.startLine ?? issue.line ?? 1;
    const endLine = issue.textRange?.endLine ?? startLine;

    annotations.push({
      path,
      start_line: startLine,
      end_line: endLine,
      annotation_level: ANNOTATION_LEVEL[issue.severity] ?? "notice",
      message: issue.message,
      title: `[${issue.severity}] ${issue.rule}`,
    });
  }

  if (sortedIssues.length > MAX_ANNOTATIONS) {
    core.warning(
      `Found ${sortedIssues.length} issues but GitHub limits check run annotations to ${MAX_ANNOTATIONS}. ` +
        `Showing the ${MAX_ANNOTATIONS} most severe issues as annotations. ` +
        `All ${sortedIssues.length} issues are included in the SARIF output file.`,
    );
  }

  return annotations;
}

/**
 * Format check run summary
 */
export function formatCheckSummary(
  stats: ConversionStats,
  config: ActionConfig,
): string {
  const { owner, repo } = context.repo;
  const prNumber = config.pullRequestNumber;
  const securityTabUrl = prNumber
    ? `https://github.com/${owner}/${repo}/security/code-scanning?query=pr%3A${prNumber}+tool%3ASonarQube+is%3Aopen`
    : `https://github.com/${owner}/${repo}/security/code-scanning`;
  const sonarQubeUrl = `${config.sonarHostUrl}/dashboard?id=${encodeURIComponent(config.projectKey)}`;

  const lines: string[] = [];

  if (stats.totalIssues === 0) {
    lines.push("## ✅ No issues found!");
    lines.push("");
    lines.push("Your code looks clean. Great job!");
  } else {
    lines.push("## 🔍 SonarQube Analysis Results");
    lines.push("");
    lines.push("| Metric | Value |");
    lines.push("|--------|-------|");
    lines.push(`| Total Issues | ${stats.totalIssues} |`);
    lines.push(`| Unique Rules | ${stats.uniqueRules} |`);
    lines.push(`| Files Affected | ${stats.components} |`);

    if (stats.filtered > 0) {
      lines.push("");
      lines.push(
        `> ℹ️ ${stats.filtered} issues were filtered out (below ${config.minSeverity} severity threshold)`,
      );
    }

    if (stats.totalIssues > MAX_ANNOTATIONS) {
      lines.push("");
      lines.push(
        `> ⚠️ Showing top ${MAX_ANNOTATIONS} issues as annotations (GitHub limit). ` +
          `All ${stats.totalIssues} issues are in the SARIF output file.`,
      );
    }

    // Severity breakdown
    const severityEntries = Object.entries(stats.bySeverity).filter(
      ([_, count]) => count > 0,
    );
    if (severityEntries.length > 0) {
      lines.push("");
      lines.push("### By Severity");
      lines.push("");
      lines.push("| Severity | Count |");
      lines.push("|----------|-------|");
      for (const [sev, count] of severityEntries) {
        lines.push(`| ${sev} | ${count} |`);
      }
    }

    // Type breakdown
    const typeEntries = Object.entries(stats.byType).filter(
      ([_, count]) => count > 0,
    );
    if (typeEntries.length > 0) {
      lines.push("");
      lines.push("### By Type");
      lines.push("");
      lines.push("| Type | Count |");
      lines.push("|------|-------|");
      for (const [type, count] of typeEntries) {
        lines.push(`| ${type} | ${count} |`);
      }
    }
  }

  lines.push("");
  lines.push(
    `🔒 [View in Security Tab](${securityTabUrl}) · 📊 [View in SonarQube](${sonarQubeUrl})`,
  );

  return lines.join("\n");
}

/**
 * Create a GitHub Check Run with annotations
 */
export async function createCheckRun(params: CheckRunParams): Promise<void> {
  const { config, stats, issues, components } = params;

  if (!config.githubToken) {
    core.warning(
      "GitHub token not available. Skipping check run creation. " +
        "Provide github-token input or ensure GITHUB_TOKEN is available.",
    );
    return;
  }

  const { owner, repo } = context.repo;
  const headSha = context.payload.pull_request?.head?.sha ?? context.sha;

  try {
    const octokit = getOctokit(config.githubToken);
    const conclusion = determineConclusion(stats, config.failOnSeverity);
    const annotations = createAnnotations(issues, components);
    const summary = formatCheckSummary(stats, config);

    const issueWord = stats.totalIssues === 1 ? "issue" : "issues";
    const title =
      stats.totalIssues === 0
        ? "No issues found"
        : `Found ${stats.totalIssues} ${issueWord}`;

    await octokit.rest.checks.create({
      owner,
      repo,
      name: "SonarQube Analysis",
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: {
        title,
        summary,
        annotations,
      },
    });

    core.info(`Created check run: ${title} (${conclusion})`);

    if (conclusion === "failure") {
      core.setFailed(
        `SonarQube analysis found issues at or above ${config.failOnSeverity ?? "configured"} severity`,
      );
    }
  } catch (error) {
    if (error instanceof Error) {
      core.warning(`Failed to create check run: ${error.message}`);
      core.debug(error.stack ?? "No stack trace");
    } else {
      core.warning("Failed to create check run: Unknown error");
    }
  }
}
