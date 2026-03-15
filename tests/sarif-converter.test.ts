import { describe, it, expect } from "vitest";
import { SarifConverter } from "../src/sarif-converter";
import { SonarQubeSearchResponse, SonarQubeIssue } from "../src/sonarqube-types";

const SONAR_URL = "https://sonarqube.example.com";

type Severity = SonarQubeIssue["severity"];
type IssueType = SonarQubeIssue["type"];

function createMockResponse(
  overrides: Partial<SonarQubeSearchResponse> = {},
): SonarQubeSearchResponse {
  return {
    total: 0,
    p: 1,
    ps: 100,
    paging: { pageIndex: 1, pageSize: 100, total: 0 },
    issues: [],
    components: [],
    rules: [],
    ...overrides,
  };
}

describe("SarifConverter", () => {
  describe("convert", () => {
    it("returns valid SARIF structure with empty issues", () => {
      const converter = new SarifConverter(SONAR_URL);
      const result = converter.convert(createMockResponse());

      expect(result.version).toBe("2.1.0");
      expect(result.$schema).toContain("sarif-schema-2.1.0");
      expect(result.runs).toHaveLength(1);
      expect(result.runs[0].tool.driver.name).toBe("SonarQube");
      expect(result.runs[0].tool.driver.informationUri).toBe(SONAR_URL);
      expect(result.runs[0].results).toHaveLength(0);
    });

    it("converts issues with full text range", () => {
      const converter = new SarifConverter(SONAR_URL);
      const data = createMockResponse({
        issues: [
          {
            key: "issue-1",
            rule: "js:S1234",
            severity: "CRITICAL",
            component: "project:src/main.js",
            project: "project",
            message: "Fix this issue",
            status: "OPEN",
            type: "VULNERABILITY",
            textRange: {
              startLine: 10,
              endLine: 10,
              startOffset: 5,
              endOffset: 20,
            },
          },
        ],
        components: [
          {
            key: "project:src/main.js",
            path: "src/main.js",
            name: "main.js",
            qualifier: "FIL",
          },
        ],
        rules: [
          {
            key: "js:S1234",
            name: "Security rule",
            status: "READY",
            type: "VULNERABILITY",
            severity: "CRITICAL",
          },
        ],
      });

      const result = converter.convert(data);

      expect(result.runs[0].results).toHaveLength(1);
      const issue = result.runs[0].results[0];
      expect(issue.ruleId).toBe("js:S1234");
      expect(issue.level).toBe("error");
      expect(issue.message.text).toBe("Fix this issue");
      expect(issue.locations?.[0].physicalLocation?.artifactLocation?.uri).toBe(
        "src/main.js",
      );
      expect(issue.locations?.[0].physicalLocation?.region?.startLine).toBe(10);
      expect(issue.locations?.[0].physicalLocation?.region?.startColumn).toBe(
        6,
      ); // offset + 1
    });

    it("converts issues with line-only location", () => {
      const converter = new SarifConverter(SONAR_URL);
      const data = createMockResponse({
        issues: [
          {
            key: "issue-2",
            rule: "js:S5678",
            severity: "MAJOR",
            component: "project:src/utils.js",
            project: "project",
            message: "Refactor this",
            status: "OPEN",
            type: "CODE_SMELL",
            line: 42,
          },
        ],
        components: [
          {
            key: "project:src/utils.js",
            path: "src/utils.js",
            name: "utils.js",
            qualifier: "FIL",
          },
        ],
        rules: [
          {
            key: "js:S5678",
            name: "Code smell rule",
            status: "READY",
            type: "CODE_SMELL",
            severity: "MAJOR",
          },
        ],
      });

      const result = converter.convert(data);

      const issue = result.runs[0].results[0];
      expect(issue.level).toBe("warning");
      expect(issue.locations?.[0].physicalLocation?.region?.startLine).toBe(42);
      expect(
        issue.locations?.[0].physicalLocation?.region?.startColumn,
      ).toBeUndefined();
    });

    it("extracts path from component key when path is missing", () => {
      const converter = new SarifConverter(SONAR_URL);
      const data = createMockResponse({
        issues: [
          {
            key: "issue-3",
            rule: "js:S9999",
            severity: "INFO",
            component: "myproject:path/to/file.js",
            project: "myproject",
            message: "Info message",
            status: "OPEN",
            type: "BUG",
            line: 1,
          },
        ],
        components: [
          {
            key: "myproject:path/to/file.js",
            name: "file.js",
            qualifier: "FIL",
            // No path property
          },
        ],
        rules: [
          {
            key: "js:S9999",
            name: "Bug rule",
            status: "READY",
            type: "BUG",
            severity: "INFO",
          },
        ],
      });

      const result = converter.convert(data);

      expect(
        result.runs[0].results[0].locations?.[0].physicalLocation
          ?.artifactLocation?.uri,
      ).toBe("path/to/file.js");
    });

    it("adds partial fingerprints when hash is present", () => {
      const converter = new SarifConverter(SONAR_URL);
      const data = createMockResponse({
        issues: [
          {
            key: "issue-4",
            rule: "js:S1111",
            severity: "MINOR",
            component: "project:file.js",
            project: "project",
            message: "Minor issue",
            status: "OPEN",
            type: "CODE_SMELL",
            hash: "abc123def456",
          },
        ],
        components: [],
        rules: [
          {
            key: "js:S1111",
            name: "Minor rule",
            status: "READY",
          },
        ],
      });

      const result = converter.convert(data);

      expect(result.runs[0].results[0].partialFingerprints?.issueHash).toBe(
        "abc123def456",
      );
    });

    it("converts code flows for data flow issues", () => {
      const converter = new SarifConverter(SONAR_URL);
      const data = createMockResponse({
        issues: [
          {
            key: "issue-5",
            rule: "js:S2222",
            severity: "BLOCKER",
            component: "project:main.js",
            project: "project",
            message: "Data flow issue",
            status: "OPEN",
            type: "VULNERABILITY",
            flows: [
              {
                locations: [
                  {
                    component: "project:main.js",
                    textRange: {
                      startLine: 5,
                      endLine: 5,
                      startOffset: 0,
                      endOffset: 10,
                    },
                  },
                  {
                    component: "project:utils.js",
                    textRange: {
                      startLine: 20,
                      endLine: 20,
                      startOffset: 5,
                      endOffset: 15,
                    },
                  },
                ],
              },
            ],
          },
        ],
        components: [
          {
            key: "project:main.js",
            path: "main.js",
            name: "main.js",
            qualifier: "FIL",
          },
          {
            key: "project:utils.js",
            path: "utils.js",
            name: "utils.js",
            qualifier: "FIL",
          },
        ],
        rules: [
          {
            key: "js:S2222",
            name: "Flow rule",
            status: "READY",
            type: "VULNERABILITY",
            severity: "BLOCKER",
          },
        ],
      });

      const result = converter.convert(data);

      expect(result.runs[0].results[0].codeFlows).toHaveLength(1);
      expect(result.runs[0].results[0].codeFlows?.[0].threadFlows).toHaveLength(
        1,
      );
      expect(
        result.runs[0].results[0].codeFlows?.[0].threadFlows[0].locations,
      ).toHaveLength(2);
    });
  });

  describe("severity mapping", () => {
    it.each<[Severity, IssueType, string]>([
      ["BLOCKER", "VULNERABILITY", "error"],
      ["CRITICAL", "VULNERABILITY", "error"],
      ["MAJOR", "VULNERABILITY", "warning"],
      ["MINOR", "VULNERABILITY", "warning"],
      ["BLOCKER", "CODE_SMELL", "error"],
      ["CRITICAL", "CODE_SMELL", "error"],
      ["MAJOR", "CODE_SMELL", "warning"],
      ["MINOR", "CODE_SMELL", "note"],
      ["INFO", "CODE_SMELL", "note"],
    ])("maps %s/%s to %s", (severity, type, expectedLevel) => {
      const converter = new SarifConverter(SONAR_URL);
      const data = createMockResponse({
        issues: [
          {
            key: "test",
            rule: "test:rule",
            severity,
            component: "project:file.js",
            project: "project",
            message: "Test",
            status: "OPEN",
            type,
          },
        ],
        components: [],
        rules: [{ key: "test:rule", name: "Test", status: "READY" }],
      });

      const result = converter.convert(data);
      expect(result.runs[0].results[0].level).toBe(expectedLevel);
    });
  });

  describe("rule conversion", () => {
    it("creates help URI for rules", () => {
      const converter = new SarifConverter(SONAR_URL);
      const data = createMockResponse({
        issues: [],
        components: [],
        rules: [
          {
            key: "js:S1234",
            name: "Test Rule",
            status: "READY",
          },
        ],
      });

      const result = converter.convert(data);

      expect(result.runs[0].tool.driver.rules?.[0].helpUri).toContain(
        "coding_rules",
      );
      expect(result.runs[0].tool.driver.rules?.[0].helpUri).toContain(
        "js%3AS1234",
      );
    });

    it("adds security-severity for vulnerability rules", () => {
      const converter = new SarifConverter(SONAR_URL);
      const data = createMockResponse({
        issues: [],
        components: [],
        rules: [
          {
            key: "js:S1234",
            name: "Security Rule",
            status: "READY",
            type: "VULNERABILITY",
            severity: "CRITICAL",
          },
        ],
      });

      const result = converter.convert(data);

      expect(
        result.runs[0].tool.driver.rules?.[0].properties?.["security-severity"],
      ).toBe("8.9");
    });

    it("adds tags for type and language", () => {
      const converter = new SarifConverter(SONAR_URL);
      const data = createMockResponse({
        issues: [],
        components: [],
        rules: [
          {
            key: "js:S1234",
            name: "JS Rule",
            status: "READY",
            type: "BUG",
            lang: "js",
          },
        ],
      });

      const result = converter.convert(data);

      expect(result.runs[0].tool.driver.rules?.[0].properties?.tags).toContain(
        "bug",
      );
      expect(result.runs[0].tool.driver.rules?.[0].properties?.tags).toContain(
        "js",
      );
    });
  });
});
