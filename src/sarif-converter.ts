import * as core from "@actions/core";
import {
  SonarQubeSearchResponse,
  SonarQubeIssue,
  SonarQubeRule,
  SonarQubeComponent,
} from "./sonarqube-types";
import {
  SarifLog,
  SarifRun,
  SarifResult,
  SarifReportingDescriptor,
  SarifThreadFlow,
  SarifThreadFlowLocation,
} from "./sarif-types";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const SARIF_VERSION = "2.1.0" as const;
const SARIF_SCHEMA =
  "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json";

const SECURITY_TYPES = ["VULNERABILITY", "SECURITY_HOTSPOT"] as const;

const SEVERITY_TO_LEVEL: Record<string, "error" | "warning" | "note"> = {
  BLOCKER: "error",
  CRITICAL: "error",
  MAJOR: "warning",
  MINOR: "note",
  INFO: "note",
};

const SECURITY_SEVERITY_SCORES: Record<string, string> = {
  BLOCKER: "10.0",
  CRITICAL: "8.9",
  MAJOR: "6.9",
  MINOR: "3.9",
  INFO: "0.0",
};

// ─────────────────────────────────────────────────────────────────────────────
// Converter Class
// ─────────────────────────────────────────────────────────────────────────────

export class SarifConverter {
  private readonly sonarQubeUrl: string;
  private readonly componentPathCache: Map<string, string>;

  constructor(sonarQubeUrl: string) {
    this.sonarQubeUrl = sonarQubeUrl;
    this.componentPathCache = new Map();
  }

  /**
   * Convert SonarQube response to SARIF format
   */
  convert(data: SonarQubeSearchResponse): SarifLog {
    core.info(`Converting ${data.issues.length} issues to SARIF format`);

    // Pre-cache component paths
    this.cacheComponentPaths(data.components);

    // Build rule index map
    const ruleIndexMap = new Map<string, number>();
    data.rules.forEach((rule, index) => ruleIndexMap.set(rule.key, index));

    // Convert rules and issues
    const rules = data.rules.map((rule) => this.convertRule(rule));
    const results = data.issues.map((issue) =>
      this.convertIssue(issue, ruleIndexMap.get(issue.rule)),
    );

    const run: SarifRun = {
      tool: {
        driver: {
          name: "SonarQube",
          informationUri: this.sonarQubeUrl,
          rules,
        },
      },
      results,
      columnKind: "utf16CodeUnits",
    };

    core.info("✓ SARIF conversion completed");

    return {
      version: SARIF_VERSION,
      $schema: SARIF_SCHEMA,
      runs: [run],
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ───────────────────────────────────────────────────────────────────────────

  private cacheComponentPaths(components: SonarQubeComponent[]): void {
    for (const comp of components) {
      if (comp.path) {
        this.componentPathCache.set(comp.key, comp.path);
      }
    }
  }

  private getFilePath(componentKey: string): string {
    // Check cache first
    const cached = this.componentPathCache.get(componentKey);
    if (cached) return cached;

    // Fallback: extract from component key (format: projectKey:path/to/file)
    const colonIndex = componentKey.indexOf(":");
    const path =
      colonIndex > -1 ? componentKey.slice(colonIndex + 1) : componentKey;

    this.componentPathCache.set(componentKey, path);
    return path;
  }

  private getSeverityLevel(
    severity: string,
    type: string,
  ): "error" | "warning" | "note" {
    // Security issues: BLOCKER/CRITICAL = error, others = warning
    if (this.isSecurityType(type)) {
      return severity === "BLOCKER" || severity === "CRITICAL"
        ? "error"
        : "warning";
    }

    return SEVERITY_TO_LEVEL[severity] ?? "note";
  }

  private getSecuritySeverity(severity: string): string {
    return SECURITY_SEVERITY_SCORES[severity] ?? "0.0";
  }

  private isSecurityType(type: string): boolean {
    return SECURITY_TYPES.includes(type as (typeof SECURITY_TYPES)[number]);
  }

  private convertIssue(
    issue: SonarQubeIssue,
    ruleIndex: number | undefined,
  ): SarifResult {
    const result: SarifResult = {
      ruleId: issue.rule,
      level: this.getSeverityLevel(issue.severity, issue.type),
      message: { text: issue.message },
    };

    // Add rule index if available
    if (typeof ruleIndex === "number") {
      result.ruleIndex = ruleIndex;
    }

    // Add location
    const location = this.buildLocation(issue);
    if (location) {
      result.locations = [location];
    }

    // Add fingerprint for tracking
    if (issue.hash) {
      result.partialFingerprints = { issueHash: issue.hash };
    }

    // Add code flows for data flow issues
    if (issue.flows?.length) {
      result.codeFlows = this.convertFlows(issue.flows);
    }

    return result;
  }

  private buildLocation(issue: SonarQubeIssue) {
    const filePath = this.getFilePath(issue.component);

    if (issue.textRange) {
      return {
        physicalLocation: {
          artifactLocation: {
            uri: filePath,
            uriBaseId: "%SRCROOT%",
          },
          region: {
            startLine: issue.textRange.startLine,
            startColumn: issue.textRange.startOffset + 1,
            endLine: issue.textRange.endLine,
            endColumn: issue.textRange.endOffset + 1,
          },
        },
      };
    }

    if (issue.line) {
      return {
        physicalLocation: {
          artifactLocation: {
            uri: filePath,
            uriBaseId: "%SRCROOT%",
          },
          region: {
            startLine: issue.line,
          },
        },
      };
    }

    return null;
  }

  private convertFlows(flows: NonNullable<SonarQubeIssue["flows"]>) {
    return flows.map((flow) => {
      const threadFlow: SarifThreadFlow = {
        locations: flow.locations.map((loc) => {
          const location: SarifThreadFlowLocation = {
            location: {
              physicalLocation: {
                artifactLocation: {
                  uri: this.getFilePath(loc.component),
                  uriBaseId: "%SRCROOT%",
                },
              },
            },
            nestingLevel: 0,
          };

          if (loc.textRange) {
            location.location.physicalLocation = {
              artifactLocation: {
                uri: this.getFilePath(loc.component),
                uriBaseId: "%SRCROOT%",
              },
              region: {
                startLine: loc.textRange.startLine,
                startColumn: loc.textRange.startOffset + 1,
                endLine: loc.textRange.endLine,
                endColumn: loc.textRange.endOffset + 1,
              },
            };
          }

          return location;
        }),
      };

      return { threadFlows: [threadFlow] };
    });
  }

  private convertRule(rule: SonarQubeRule): SarifReportingDescriptor {
    const descriptor: SarifReportingDescriptor = {
      id: rule.key,
      name: rule.name,
      shortDescription: { text: rule.name },
    };

    // Full description
    if (rule.htmlDesc != null || rule.mdDesc != null) {
      descriptor.fullDescription = {
        text: rule.htmlDesc ?? rule.mdDesc ?? rule.name,
      };
      if (rule.mdDesc) {
        descriptor.fullDescription.markdown = rule.mdDesc;
      }
    }

    // Help URI
    descriptor.helpUri = `${this.sonarQubeUrl}/coding_rules?open=${encodeURIComponent(rule.key)}&rule_key=${encodeURIComponent(rule.key)}`;

    // Properties and tags
    const tags: string[] = [];
    if (rule.type) tags.push(rule.type.toLowerCase());
    if (rule.lang) tags.push(rule.lang);

    descriptor.properties = { tags };

    // Security severity for vulnerabilities/hotspots
    if (rule.type && this.isSecurityType(rule.type)) {
      descriptor.properties["security-severity"] = this.getSecuritySeverity(
        rule.severity ?? "INFO",
      );
    }

    // Default configuration
    if (rule.severity) {
      descriptor.defaultConfiguration = {
        level: this.getSeverityLevel(rule.severity, rule.type ?? "CODE_SMELL"),
      };
    }

    return descriptor;
  }
}
