/**
 * SonarQube API types based on /api/issues/search endpoint
 */

export interface SonarQubeIssue {
  key: string;
  rule: string;
  severity: "BLOCKER" | "CRITICAL" | "MAJOR" | "MINOR" | "INFO";
  component: string;
  project: string;
  line?: number;
  hash?: string;
  textRange?: {
    startLine: number;
    endLine: number;
    startOffset: number;
    endOffset: number;
  };
  flows?: Array<{
    locations: Array<{
      component: string;
      textRange?: {
        startLine: number;
        endLine: number;
        startOffset: number;
        endOffset: number;
      };
      msg?: string;
    }>;
  }>;
  status: string;
  message: string;
  effort?: string;
  debt?: string;
  author?: string;
  tags?: string[];
  creationDate?: string;
  updateDate?: string;
  type: "BUG" | "VULNERABILITY" | "CODE_SMELL" | "SECURITY_HOTSPOT";
}

export interface SonarQubeRule {
  key: string;
  name: string;
  status: string;
  lang?: string;
  langName?: string;
  htmlDesc?: string;
  mdDesc?: string;
  severity?: string;
  type?: string;
}

export interface SonarQubeComponent {
  key: string;
  enabled?: boolean;
  qualifier: string;
  name: string;
  longName?: string;
  path?: string;
}

export interface SonarQubeSearchResponse {
  total: number;
  p: number;
  ps: number;
  paging: {
    pageIndex: number;
    pageSize: number;
    total: number;
  };
  issues: SonarQubeIssue[];
  components: SonarQubeComponent[];
  rules: SonarQubeRule[];
}
