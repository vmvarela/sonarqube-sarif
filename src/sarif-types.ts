/**
 * SARIF v2.1.0 types (simplified)
 * Based on: https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html
 */

export interface SarifLog {
  version: "2.1.0";
  $schema: string;
  runs: SarifRun[];
}

export interface SarifRun {
  tool: SarifTool;
  results: SarifResult[];
  columnKind?: "utf16CodeUnits" | "unicodeCodePoints";
}

export interface SarifTool {
  driver: SarifToolComponent;
}

export interface SarifToolComponent {
  name: string;
  version?: string;
  informationUri?: string;
  rules?: SarifReportingDescriptor[];
}

export interface SarifReportingDescriptor {
  id: string;
  name?: string;
  shortDescription?: SarifMultiformatMessageString;
  fullDescription?: SarifMultiformatMessageString;
  helpUri?: string;
  help?: SarifMultiformatMessageString;
  properties?: {
    tags?: string[];
    precision?: string;
    "security-severity"?: string;
    [key: string]: unknown;
  };
  defaultConfiguration?: {
    level?: "none" | "note" | "warning" | "error";
  };
}

export interface SarifResult {
  ruleId: string;
  ruleIndex?: number;
  level?: "none" | "note" | "warning" | "error";
  message: SarifMessage;
  locations?: SarifLocation[];
  partialFingerprints?: {
    [key: string]: string;
  };
  codeFlows?: SarifCodeFlow[];
}

export interface SarifMessage {
  text: string;
  markdown?: string;
}

export interface SarifMultiformatMessageString {
  text: string;
  markdown?: string;
}

export interface SarifLocation {
  physicalLocation?: SarifPhysicalLocation;
}

export interface SarifPhysicalLocation {
  artifactLocation: SarifArtifactLocation;
  region?: SarifRegion;
}

export interface SarifArtifactLocation {
  uri: string;
  uriBaseId?: string;
}

export interface SarifRegion {
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface SarifCodeFlow {
  threadFlows: SarifThreadFlow[];
}

export interface SarifThreadFlow {
  locations: SarifThreadFlowLocation[];
}

export interface SarifThreadFlowLocation {
  location: SarifLocation;
  nestingLevel?: number;
}
