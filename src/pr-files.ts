/**
 * PR Files Module
 * Fetches list of files changed in a Pull Request
 */

import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { SonarQubeIssue, SonarQubeComponent } from "./sonarqube-types";

/**
 * Get the list of files changed in a Pull Request
 */
export async function getChangedFiles(
  githubToken: string,
  pullRequestNumber: number,
): Promise<string[]> {
  const { owner, repo } = context.repo;

  try {
    const octokit = getOctokit(githubToken);

    // Paginate to get all changed files (PRs can have many files)
    const files: string[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullRequestNumber,
        per_page: perPage,
        page,
      });

      if (data.length === 0) break;

      files.push(...data.map((file: (typeof data)[number]) => file.filename));

      if (data.length < perPage) break;
      page++;
    }

    core.debug(`Changed files in PR #${pullRequestNumber}: ${files.length}`);
    core.debug(`Files: ${files.slice(0, 10).join(", ")}${files.length > 10 ? "..." : ""}`);

    return files;
  } catch (error) {
    if (error instanceof Error) {
      core.warning(`Failed to fetch PR files: ${error.message}`);
      core.debug(error.stack ?? "No stack trace");
    } else {
      core.warning("Failed to fetch PR files: Unknown error");
    }
    // Return empty array - will show all issues as fallback
    return [];
  }
}

/**
 * Build a map of component keys to file paths
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
 * Filter issues to only include those in changed files
 */
export function filterIssuesByChangedFiles(
  issues: SonarQubeIssue[],
  components: SonarQubeComponent[],
  changedFiles: string[],
): { filtered: SonarQubeIssue[]; excludedCount: number } {
  if (changedFiles.length === 0) {
    // No changed files info - return all issues
    return { filtered: issues, excludedCount: 0 };
  }

  const componentPathMap = buildComponentPathMap(components);
  const changedFilesSet = new Set(changedFiles);

  const filtered = issues.filter((issue) => {
    const path = componentPathMap.get(issue.component);
    if (!path) {
      // Unknown path - exclude to be safe
      return false;
    }
    return changedFilesSet.has(path);
  });

  const excludedCount = issues.length - filtered.length;

  if (excludedCount > 0) {
    core.info(
      `Filtered to PR changes: ${filtered.length} issues in changed files (${excludedCount} excluded)`,
    );
  }

  return { filtered, excludedCount };
}

/**
 * Filter components to only include those with issues
 */
export function filterComponentsByIssues(
  components: SonarQubeComponent[],
  issues: SonarQubeIssue[],
): SonarQubeComponent[] {
  const usedComponents = new Set(issues.map((i) => i.component));
  return components.filter((c) => usedComponents.has(c.key));
}
