# Security

## What is this document for?

This action handles two kinds of sensitive inputs: a SonarQube token and, optionally, a GitHub token. It also writes a SARIF file that may contain source file paths, issue messages, and code locations. That makes the security story simple: protect the tokens, understand what goes into the SARIF file, and keep the action pointed at infrastructure you trust.

This is not a formal audit report. It is the practical security model for operators and maintainers.

## What the action actually does

The action:

- reads configuration from GitHub Actions inputs
- authenticates to SonarQube over HTTP or HTTPS
- fetches issue and rule data from SonarQube APIs
- writes a SARIF file to the runner filesystem
- optionally calls GitHub APIs for Check Runs, PR comments, and PR file lookup

It does **not** execute shell commands based on user input, evaluate arbitrary code, or upload data anywhere except the systems you configure: SonarQube and GitHub.

## Security properties

### Secrets

- `sonar-token` is treated as a secret and should be passed through GitHub Actions secrets.
- `github-token` defaults to `GITHUB_TOKEN`; if a custom token is supplied, it is also masked.
- URLs are only masked when they appear to embed credentials.

### Network behavior

- SonarQube communication uses authenticated HTTP requests through `axios`.
- GitHub communication goes through the official Actions GitHub client.
- There is no secondary telemetry channel.

### Filesystem behavior

- The action writes exactly one output artifact: the SARIF file you configure.
- Parent directories are created if needed.
- The action does not scan the workspace for files to upload on its own.

### Code execution surface

- No `eval`, dynamic function construction, or shell interpolation.
- No subprocess execution driven by action inputs.
- Data transformation is plain TypeScript over JSON payloads.

## Real risks to keep in mind

### 1. Trusting the SonarQube server

The action will talk to whatever `sonar-host-url` you provide. If you point it at an untrusted host, you are sending a valid token there. That is operator error, but it is the main trust boundary in this project.

**Recommendation:** use only trusted SonarQube instances, preferably over HTTPS.

### 2. SARIF contains useful code metadata

SARIF is not just a count file. It may include file paths, line numbers, rule identifiers, and issue messages. In some cases it can also include code-flow data.

**Recommendation:** treat generated SARIF as build output with source-code-adjacent sensitivity.

### 3. Over-broad GitHub permissions

The action can work with narrowly scoped repository permissions. Giving it more than `security-events: write`, `checks: write`, and `pull-requests: write` does not improve functionality.

**Recommendation:** keep workflow permissions minimal.

## Recommended operator setup

Use GitHub secrets for tokens and explicit workflow permissions:

```yaml
permissions:
  security-events: write
  checks: write
  pull-requests: write
```

On the SonarQube side:

- **Browse** is required to fetch issues.
- **Execute Analysis** is only required if you use `wait-for-processing: true`.

If you cannot grant Execute Analysis, prefer `wait-for-processing: false` with a fixed `processing-delay`.

## Dependency posture

The project keeps a small runtime dependency set:

- `@actions/core`
- `@actions/github`
- `axios`

That does not make the project automatically safe, but it does keep the supply-chain surface modest and auditable.

## For maintainers

When changing this action, be suspicious of anything that would:

- log tokens or authenticated URLs
- add shell execution based on inputs
- expand filesystem writes beyond the configured SARIF path
- send data to services other than SonarQube or GitHub

Those changes would materially alter the security model and should be called out in review and release notes.

## Reporting security issues

If you find a vulnerability, please use the repository's security reporting mechanism or contact the maintainer privately before opening a public issue.

Last reviewed: 2026-03-06
