import * as core from "@actions/core";
import * as fs from "fs";
import * as path from "path";

import { parseConfig, maskSecrets, ConfigError, ActionConfig } from "./config";
import { SonarQubeClient } from "./client";
import { SarifConverter } from "./sarif-converter";
import { SonarQubeError } from "./errors";
import {
  calculateStats,
  filterBySeverity,
  formatStatsForLog,
  setStatsOutputs,
  ConversionStats,
} from "./stats";
import { writePrComment } from "./pr-comment";
import { createCheckRun, shouldFailCheck } from "./github-checks";
import {
  getChangedFiles,
  filterIssuesByChangedFiles,
  filterComponentsByIssues,
} from "./pr-files";

// ─────────────────────────────────────────────────────────────────────────────
// Main Entry Point
// ─────────────────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  try {
    // Parse and validate configuration
    const config = parseConfig();
    maskSecrets(config);

    maybeWarnAboutProjectKey(config);

    // Print banner
    printBanner(config);

    // Create client and fetch issues
    const client = new SonarQubeClient(config);

    if (config.waitForProcessing) {
      await client.waitForProcessing();
    } else if (config.processingDelay > 0) {
      await client.applyProcessingDelay();
    }

    core.info("Fetching issues from SonarQube...");
    let data = await client.fetchAllIssues();

    // Apply severity filter if configured
    let filteredCount = 0;
    if (config.minSeverity !== "INFO") {
      const { filtered, removedCount } = filterBySeverity(
        data.issues,
        config.minSeverity,
      );
      data = { ...data, issues: filtered };
      filteredCount = removedCount;

      if (removedCount > 0) {
        core.info(
          `Filtered ${removedCount} issues below ${config.minSeverity} severity`,
        );
      }
    }

    // In PR context: filter to only show issues from changed files
    let prFilteredCount = 0;
    if (config.pullRequestNumber && config.githubToken) {
      core.info("Filtering issues to files changed in PR...");
      const changedFiles = await getChangedFiles(
        config.githubToken,
        config.pullRequestNumber,
      );

      if (changedFiles.length > 0) {
        const { filtered, excludedCount } = filterIssuesByChangedFiles(
          data.issues,
          data.components,
          changedFiles,
        );
        prFilteredCount = excludedCount;
        data = {
          ...data,
          issues: filtered,
          components: filterComponentsByIssues(data.components, filtered),
        };
      }
    }

    // Calculate and log statistics
    const stats = calculateStats(data, filteredCount + prFilteredCount);
    logStats(stats);

    // Handle empty results
    if (data.issues.length === 0) {
      core.info("No issues found. Great job! 🎉");
    }

    // Convert to SARIF
    core.info("Converting to SARIF format...");
    const converter = new SarifConverter(config.sonarHostUrl);
    const sarif = converter.convert(data);

    // Write output file
    writeOutput(config.outputFile, sarif);

    // Set outputs
    core.setOutput("sarif-file", config.outputFile);
    setStatsOutputs(stats);

    // Write job summary
    await writeSummary(config, stats);

    // Create GitHub Check Run with annotations
    await createCheckRun({
      config,
      stats,
      issues: data.issues,
      components: data.components,
    });

    // Fail the action if severity threshold is met — evaluated independently of
    // check run creation so it works even when the GitHub token is missing or
    // the check run API call fails.
    if (shouldFailCheck(stats, config.failOnSeverity)) {
      core.setFailed(
        `SonarQube analysis found issues at or above ${config.failOnSeverity} severity`,
      );
    }

    // Post PR comment if enabled, in PR context, and issues were found
    if (config.prComment && config.pullRequestNumber && stats.totalIssues > 0) {
      await writePrComment(config, stats);
    }

    // Success banner
    printSuccess();
  } catch (error) {
    handleError(error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

function printBanner(config: ActionConfig): void {
  const divider = "═".repeat(60);

  core.info(divider);
  core.info("  SonarQube CE to SARIF Converter");
  core.info(divider);
  core.info(`  Server:     ${config.sonarHostUrl}`);
  core.info(`  Project:    ${config.projectKey}`);

  if (config.branch) {
    core.info(`  Branch:     ${config.branch}`);
  }
  if (config.pullRequestNumber) {
    core.info(`  PR:         #${config.pullRequestNumber}`);
  }

  core.info(`  Output:     ${config.outputFile}`);
  core.info(`  Min Sev:    ${config.minSeverity}`);
  core.info(divider);
}

function logStats(stats: ConversionStats): void {
  core.info("");
  core.info("─── Results ───");
  for (const line of formatStatsForLog(stats)) {
    core.info(`  ${line}`);
  }
  core.info("");
}

function maybeWarnAboutProjectKey(config: ActionConfig): void {
  const hasBranchOrPr =
    config.branch != null || config.pullRequestNumber != null;
  if (!hasBranchOrPr) {
    return;
  }

  if (config.projectKey === config.repositoryProjectKey) {
    if (config.projectKeySource === "repository") {
      core.info(
        "Using repository name as SonarQube project key for the supplied branch/pull request inputs.",
      );
    }
    return;
  }

  core.warning(
    `SonarQube project key '${config.projectKey}' differs from the repository name '${config.repositoryProjectKey}'. Ensure this matches the branch or pull request target project in SonarQube.`,
  );
}

function writeOutput(outputFile: string, sarif: object): void {
  const outputDir = path.dirname(outputFile);

  if (outputDir && outputDir !== ".") {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  core.info(`Writing SARIF to: ${outputFile}`);
  fs.writeFileSync(outputFile, JSON.stringify(sarif, null, 2), "utf-8");
}

function printSuccess(): void {
  const divider = "═".repeat(60);
  core.info(divider);
  core.info("  ✓ SARIF file created successfully");
  core.info(divider);
}

async function writeSummary(
  config: ActionConfig,
  stats: ConversionStats,
): Promise<void> {
  const severityRows = Object.entries(stats.bySeverity)
    .filter(([_, count]) => count > 0)
    .map(([sev, count]) => [sev, count.toString()]);

  const typeRows = Object.entries(stats.byType)
    .filter(([_, count]) => count > 0)
    .map(([type, count]) => [type, count.toString()]);

  await core.summary
    .addHeading("🔍 SonarQube to SARIF Conversion", 2)
    .addTable([
      [
        { data: "Metric", header: true },
        { data: "Value", header: true },
      ],
      ["Total Issues", stats.totalIssues.toString()],
      ["Unique Rules", stats.uniqueRules.toString()],
      ["Components", stats.components.toString()],
      ["Output File", config.outputFile],
    ])
    .addHeading("By Severity", 3)
    .addTable([
      [
        { data: "Severity", header: true },
        { data: "Count", header: true },
      ],
      ...severityRows,
    ])
    .addHeading("By Type", 3)
    .addTable([
      [
        { data: "Type", header: true },
        { data: "Count", header: true },
      ],
      ...typeRows,
    ])
    .write();
}

function handleError(error: unknown): void {
  if (error instanceof SonarQubeError) {
    error.log();
    core.setFailed(error.message);
    return;
  }

  if (error instanceof ConfigError) {
    core.error(`Configuration error in '${error.field}': ${error.message}`);
    core.setFailed(error.message);
    return;
  }

  if (error instanceof Error) {
    core.setFailed(`Action failed: ${error.message}`);
    core.debug(error.stack ?? "No stack trace");
    return;
  }

  core.setFailed("Action failed with unknown error");
}

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

run().catch(handleError);
