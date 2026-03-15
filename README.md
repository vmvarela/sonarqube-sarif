# SonarQube → GitHub Security Tab

[![CI](https://github.com/vmvarela/sonarqube-sarif/actions/workflows/ci.yml/badge.svg)](https://github.com/vmvarela/sonarqube-sarif/actions/workflows/ci.yml)
[![GitHub Marketplace](https://img.shields.io/badge/Marketplace-v1-blue?logo=github)](https://github.com/marketplace/actions/sonarqube-to-github-security-tab-sarif)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## What is this?

SonarQube can analyze code, but it does not give you the GitHub experience most teams actually want: pull request annotations, a check run summary, and SARIF that GitHub can ingest. This action fills that gap.

It fetches issues from the SonarQube REST API, converts them to SARIF, writes a file for `github/codeql-action/upload-sarif`, creates a GitHub Check Run, and can post a PR summary comment. In pull requests, it narrows the feedback to files changed in the PR so reviewers are not buried in the entire backlog.

If you already run SonarQube and want the results to show up where developers work, this is the missing piece.

## Supported editions

The action works against the SonarQube REST API and is edition-agnostic:

| Edition          | Works?  | Notes                                                   |
| ---------------- | ------- | ------------------------------------------------------- |
| Community (CE)   | Yes     | Full support. No branch analysis in SonarQube itself.   |
| Developer (DE)   | Yes     | Branch and PR analysis available on the SonarQube side. |
| Enterprise (EE)  | Yes     | Same API surface.                                       |
| Data Center (DC) | Yes     | Same API surface.                                       |
| SonarCloud       | Partial | API differs; not officially tested.                     |

For Developer Edition and above, SonarQube itself can perform true PR analysis. The `branch` input lets you target a specific branch when fetching issues, which pairs well with DE/EE branch analysis.

## Quick Start

This is the happy path. Run SonarQube, convert the results, and upload SARIF only on non-PR events.

```yaml
name: SonarQube Analysis

on:
  push:
    branches: [main]
  pull_request:

jobs:
  analyze:
    runs-on: ubuntu-latest
    permissions:
      security-events: write
      checks: write
      pull-requests: write

    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0

      - name: SonarQube Scan
        uses: sonarsource/sonarqube-scan-action@v7
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
          SONAR_HOST_URL: ${{ secrets.SONAR_HOST_URL }}

      - name: Convert SonarQube issues to SARIF
        uses: vmvarela/sonarqube-sarif@v1
        with:
          sonar-host-url: ${{ secrets.SONAR_HOST_URL }}
          sonar-token: ${{ secrets.SONAR_TOKEN }}

      - name: Upload SARIF
        if: github.event_name != 'pull_request'
        uses: github/codeql-action/upload-sarif@v4
        with:
          sarif_file: sonarqube.sarif
```

## What happens when it runs?

- On any run, the action fetches SonarQube issues, converts them to SARIF, writes the file, and exposes counts as outputs.
- If a GitHub token is available, it also creates a Check Run with up to 50 annotations.
- In PR context, it filters issues to changed files and can upsert a summary PR comment.
- On push to the default branch, you usually upload the SARIF file so GitHub Security reflects the branch that matters.

That split is deliberate. PRs need review feedback; the Security tab needs a stable view of the default branch.

## Recommended workflow

Use this action in two modes:

1. **Pull requests:** rely on the Check Run and optional PR comment.
2. **Default branch pushes:** upload the generated SARIF to GitHub code scanning.

On Community Edition, SonarQube does not do true PR analysis — it analyzes the project state it knows about. This action filters the results to changed files, which is useful for review but is not the same as "only issues introduced by this PR."

On Developer Edition and above, SonarQube can analyze branches and PRs natively. Pair the `branch` input with SonarQube's branch analysis for more precise results.

## Inputs you will probably care about

These are the knobs most teams end up using:

| Input                 | Default             | Why you would change it                                          |
| --------------------- | ------------------- | ---------------------------------------------------------------- |
| `project-key`         | repository name     | Your SonarQube project key does not match the repo name.         |
| `branch`              | unset               | Target a specific SonarQube branch (useful for DE/EE/DC).        |
| `min-severity`        | `INFO`              | Ignore low-severity noise.                                       |
| `fail-on-severity`    | unset               | Turn findings into a failing check.                              |
| `wait-for-processing` | `true`              | Disable polling if your token lacks Execute Analysis permission. |
| `processing-delay`    | `0`                 | Wait a fixed number of seconds before fetching issues.           |
| `pr-comment`          | auto-enabled in PRs | Silence the PR comment if you only want the Check Run.           |
| `include-resolved`    | `false`             | Include resolved issues in the SARIF output.                     |
| `output-file`         | `sonarqube.sarif`   | Write the SARIF file somewhere else.                             |

## Full input reference

| Input                 | Default           | Notes                                                            |
| --------------------- | ----------------- | ---------------------------------------------------------------- |
| `sonar-host-url`      | —                 | Required. Must be `http://` or `https://`.                       |
| `sonar-token`         | —                 | Required. Needs SonarQube Browse permission.                     |
| `project-key`         | repo name         | Falls back to the GitHub repository name.                        |
| `output-file`         | `sonarqube.sarif` | Directories are created if needed.                               |
| `branch`              | unset             | Pass explicitly when you need a branch-specific SonarQube query. |
| `wait-for-processing` | `true`            | Polls SonarQube until analysis completes or times out.           |
| `max-wait-time`       | `300`             | Timeout, in seconds, for polling.                                |
| `polling-interval`    | `10`              | Interval, in seconds, between polling attempts.                  |
| `processing-delay`    | `0`               | Fixed delay before fetching issues; max `600`.                   |
| `min-severity`        | `INFO`            | One of `INFO`, `MINOR`, `MAJOR`, `CRITICAL`, `BLOCKER`.          |
| `include-resolved`    | `false`           | Includes resolved issues in the fetched dataset.                 |
| `pr-comment`          | PRs only          | If omitted, comments are enabled only in PR context.             |
| `fail-on-severity`    | unset             | Fails the Check Run when issues at or above the threshold exist. |
| `github-token`        | `github.token`    | Used for Check Runs, PR comments, and PR file lookup.            |

## Real examples

Use a severity gate when you want review feedback for everything, but only fail the job on serious findings.

```yaml
- uses: vmvarela/sonarqube-sarif@v1
  with:
    sonar-host-url: ${{ secrets.SONAR_HOST_URL }}
    sonar-token: ${{ secrets.SONAR_TOKEN }}
    min-severity: MAJOR
    fail-on-severity: CRITICAL
```

If your SonarQube token cannot query Compute Engine status, skip polling and wait a fixed amount of time instead.

```yaml
- uses: vmvarela/sonarqube-sarif@v1
  with:
    sonar-host-url: ${{ secrets.SONAR_HOST_URL }}
    sonar-token: ${{ secrets.SONAR_TOKEN }}
    wait-for-processing: false
    processing-delay: 60
```

On Developer Edition, target a specific branch to fetch branch-specific issues.

```yaml
- uses: vmvarela/sonarqube-sarif@v1
  with:
    sonar-host-url: ${{ secrets.SONAR_HOST_URL }}
    sonar-token: ${{ secrets.SONAR_TOKEN }}
    branch: ${{ github.ref_name }}
```

If the PR comment becomes noise, keep the Check Run and disable the comment.

```yaml
- uses: vmvarela/sonarqube-sarif@v1
  with:
    sonar-host-url: ${{ secrets.SONAR_HOST_URL }}
    sonar-token: ${{ secrets.SONAR_TOKEN }}
    pr-comment: false
```

## Outputs

The action always emits the SARIF path plus counts you can reuse in later workflow steps.

| Output                                                                            | Meaning                                         |
| --------------------------------------------------------------------------------- | ----------------------------------------------- |
| `sarif-file`                                                                      | Path to the generated SARIF file                |
| `issues-count`                                                                    | Total issues after filtering                    |
| `rules-count`                                                                     | Unique rules represented in the result          |
| `components-count`                                                                | Files/components referenced by remaining issues |
| `blocker-count` / `critical-count` / `major-count` / `minor-count` / `info-count` | Severity counts                                 |
| `bugs-count` / `vulnerabilities-count` / `code-smells-count` / `hotspots-count`   | Type counts                                     |

This is a typical follow-up step:

```yaml
- name: Show SonarQube counts
  run: |
    echo "Issues: ${{ steps.sarif.outputs.issues-count }}"
    echo "Vulnerabilities: ${{ steps.sarif.outputs.vulnerabilities-count }}"
```

## Permissions

The action uses `GITHUB_TOKEN` by default. Give it only what it needs.

```yaml
permissions:
  security-events: write
  checks: write
  pull-requests: write
```

On the SonarQube side, **Browse** is required. **Execute Analysis** is only needed if you want polling via `wait-for-processing: true`.

## Limitations

- **PR filtering depends on changed-file lookup.** If GitHub file lookup fails, the action falls back to the full issue set.
- **Check annotations are capped at 50.** That is a GitHub Check Run limit, not a project limit.
- **The action does not evaluate SonarQube Quality Gates.** `fail-on-severity` is a separate, issue-based gate.
- **Community Edition has no branch or PR analysis.** On CE, SonarQube analyzes the project as a whole; this action filters the result to changed files as a best-effort approximation.

If you need baseline-aware PR decoration on Community Edition, SonarQube Developer Edition is the better tool.

## Related docs

- [docs/RFC-001-technical-design.md](docs/RFC-001-technical-design.md) — how the action is wired internally
- [SECURITY.md](SECURITY.md) — security model and operational guidance

## License

[MIT](LICENSE)
