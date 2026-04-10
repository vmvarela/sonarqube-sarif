import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SonarQubeError } from "../src/errors";

// Mock @actions/core
vi.mock("@actions/core", () => ({
  info: vi.fn(),
  debug: vi.fn(),
  warning: vi.fn(),
}));

// Store mock functions in a module-level object that can be accessed by the hoisted mock
const axiosMocks = {
  get: vi.fn(),
  create: vi.fn(),
  requestInterceptorFn: null as ((config: unknown) => unknown) | null,
  responseInterceptorOnFulfilled: null as ((res: unknown) => unknown) | null,
  responseInterceptorOnRejected: null as ((err: unknown) => unknown) | null,
};

vi.mock("axios", () => ({
  default: {
    create: (...args: unknown[]) => {
      axiosMocks.create(...args);

      // Instrumented get: runs request interceptor before the mock, and
      // response interceptors after — mirrors real axios behaviour.
      const instrumentedGet = async (...getArgs: unknown[]) => {
        // Run request interceptor if registered
        if (axiosMocks.requestInterceptorFn) {
          axiosMocks.requestInterceptorFn(getArgs[0]);
        }
        try {
          const result = await axiosMocks.get(...getArgs);
          return axiosMocks.responseInterceptorOnFulfilled
            ? axiosMocks.responseInterceptorOnFulfilled(result)
            : result;
        } catch (err) {
          if (axiosMocks.responseInterceptorOnRejected) {
            return axiosMocks.responseInterceptorOnRejected(err);
          }
          throw err;
        }
      };

      return {
        get: instrumentedGet,
        interceptors: {
          request: {
            use: (fn: (config: unknown) => unknown) => {
              axiosMocks.requestInterceptorFn = fn;
            },
          },
          response: {
            use: (
              onFulfilled: (res: unknown) => unknown,
              onRejected: (err: unknown) => unknown,
            ) => {
              axiosMocks.responseInterceptorOnFulfilled = onFulfilled;
              axiosMocks.responseInterceptorOnRejected = onRejected;
            },
          },
        },
      };
    },
    isAxiosError: (error: unknown) =>
      (error as { isAxiosError?: boolean })?.isAxiosError === true,
  },
}));

// Import after mocks are set up
import { SonarQubeClient } from "../src/client";
import { ActionConfig } from "../src/config";
import * as core from "@actions/core";

describe("SonarQubeClient", () => {
  const mockConfig: ActionConfig = {
    sonarHostUrl: "https://sonar.example.com",
    sonarToken: "test-token",
    projectKey: "my-project",
    projectKeySource: "input",
    repositoryProjectKey: "my-project",
    outputFile: "sonarqube.sarif",
    pullRequestNumber: undefined,
    waitForProcessing: true,
    maxWaitTime: 300,
    pollingInterval: 10,
    processingDelay: 0,
    minSeverity: "INFO",
    includeResolved: false,
    prComment: false,
    failOnSeverity: undefined,
    githubToken: undefined,
    skipPreflight: false,
  };

  type TestIssue = {
    key: string;
    rule: string;
    severity: string;
    component: string;
    project: string;
    message: string;
    status: string;
    type: string;
    creationDate?: string;
    line?: number;
    effort?: string;
    debt?: string;
    flows?: unknown[];
    textRange?: {
      startLine: number;
      endLine: number;
      startOffset: number;
      endOffset: number;
    };
  };

  type TestComponent = {
    key: string;
    name: string;
    path?: string;
    qualifier?: string;
  };

  type TestRule = {
    key: string;
    name: string;
    status: string;
    lang?: string;
    langName?: string;
    severity?: string;
    type?: string;
  };

  const makeIssue = (
    id: number | string,
    overrides: Partial<TestIssue> = {},
  ): TestIssue => ({
    key: `issue-${id}`,
    rule: "ts:S1234",
    severity: "MAJOR",
    component: "project:src/a.ts",
    project: "project",
    message: `Issue ${id}`,
    status: "OPEN",
    type: "BUG",
    ...overrides,
  });

  const makeIssueBatch = (
    count: number,
    prefix: string,
    overrides: Partial<TestIssue> = {},
  ): TestIssue[] =>
    Array.from({ length: count }, (_, index) =>
      makeIssue(`${prefix}-${index + 1}`, overrides),
    );

  const makeComponent = (
    overrides: Partial<TestComponent> = {},
  ): TestComponent => ({
    key: "project:src/a.ts",
    name: "a.ts",
    path: "src/a.ts",
    qualifier: "FIL",
    ...overrides,
  });

  const makeRule = (overrides: Partial<TestRule> = {}): TestRule => ({
    key: "ts:S1234",
    name: "Rule 1234",
    status: "READY",
    ...overrides,
  });

  const makeCountResponse = (total?: number) => ({
    data: {
      paging: total === undefined ? {} : { total },
      issues: [],
      components: [],
      rules: [],
    },
  });

  const makeIssuesResponse = ({
    issues,
    total,
    components = [makeComponent()],
    rules = [makeRule()],
    includeTotal = true,
  }: {
    issues: TestIssue[];
    total?: number;
    components?: TestComponent[];
    rules?: TestRule[];
    includeTotal?: boolean;
  }) => ({
    data: {
      paging: includeTotal && total !== undefined ? { total } : {},
      issues,
      components,
      rules,
    },
  });

  const makeRuleDetailResponse = (rule: TestRule) => ({
    data: { rule },
  });

  type MockRequestConfig = {
    params?: Record<string, unknown>;
  };

  const getIssueSearchCalls = (): MockRequestConfig[] =>
    axiosMocks.get.mock.calls
      .filter(([url]) => url === "/api/issues/search")
      .map(([, requestConfig]) => (requestConfig ?? {}) as MockRequestConfig);

  beforeEach(() => {
    vi.clearAllMocks();
    axiosMocks.get.mockReset();
    axiosMocks.create.mockReset();
    axiosMocks.requestInterceptorFn = null;
    axiosMocks.responseInterceptorOnFulfilled = null;
    axiosMocks.responseInterceptorOnRejected = null;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("constructor", () => {
    it("creates axios client with correct config", () => {
      new SonarQubeClient(mockConfig);

      expect(axiosMocks.create).toHaveBeenCalledWith({
        baseURL: "https://sonar.example.com",
        auth: {
          username: "test-token",
          password: "",
        },
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        timeout: 30000,
      });
    });

    it("registers request and response interceptors", () => {
      new SonarQubeClient(mockConfig);
      expect(axiosMocks.requestInterceptorFn).toBeTypeOf("function");
      expect(axiosMocks.responseInterceptorOnFulfilled).toBeTypeOf("function");
      expect(axiosMocks.responseInterceptorOnRejected).toBeTypeOf("function");
    });
  });

  describe("fetchAllIssues", () => {
    it("fetches issues with pagination", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(3));

      // First page
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 3 },
          issues: [
            {
              key: "issue-1",
              rule: "ts:S1234",
              severity: "MAJOR",
              component: "project:src/a.ts",
              project: "project",
              message: "Issue 1",
              status: "OPEN",
              type: "BUG",
            },
            {
              key: "issue-2",
              rule: "ts:S1234",
              severity: "MINOR",
              component: "project:src/b.ts",
              project: "project",
              message: "Issue 2",
              status: "OPEN",
              type: "CODE_SMELL",
            },
          ],
          components: [
            {
              key: "project:src/a.ts",
              name: "a.ts",
              path: "src/a.ts",
              qualifier: "FIL",
            },
          ],
          rules: [{ key: "ts:S1234", name: "Rule 1234", status: "READY" }],
        },
      });

      // Second page
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 3 },
          issues: [
            {
              key: "issue-3",
              rule: "ts:S5678",
              severity: "CRITICAL",
              component: "project:src/c.ts",
              project: "project",
              message: "Issue 3",
              status: "OPEN",
              type: "VULNERABILITY",
            },
          ],
          components: [
            {
              key: "project:src/c.ts",
              name: "c.ts",
              path: "src/c.ts",
              qualifier: "FIL",
            },
          ],
          rules: [{ key: "ts:S5678", name: "Rule 5678", status: "READY" }],
        },
      });

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(result.issues).toHaveLength(3);
      expect(result.components).toHaveLength(2);
      expect(result.rules).toHaveLength(2);
      expect(axiosMocks.get).toHaveBeenCalledTimes(3);
    });

    it("fetches single page when total fits", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(1));

      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 1 },
          issues: [
            {
              key: "issue-1",
              rule: "ts:S1234",
              severity: "MAJOR",
              component: "project:src/a.ts",
              project: "project",
              message: "Issue 1",
              status: "OPEN",
              type: "BUG",
            },
          ],
          components: [
            {
              key: "project:src/a.ts",
              name: "a.ts",
              path: "src/a.ts",
              qualifier: "FIL",
            },
          ],
          rules: [{ key: "ts:S1234", name: "Rule 1234", status: "READY" }],
        },
      });

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(result.issues).toHaveLength(1);
      expect(axiosMocks.get).toHaveBeenCalledTimes(2);
    });

    it("handles empty response", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));

      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 0 },
          issues: [],
          components: [],
          rules: [],
        },
      });

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(result.issues).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(axiosMocks.get).toHaveBeenCalledTimes(2);
    });

    it("deduplicates components and rules across pages", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(2));

      // First page
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 2 },
          issues: [
            {
              key: "issue-1",
              rule: "ts:S1234",
              severity: "MAJOR",
              component: "project:src/a.ts",
              project: "project",
              message: "Issue 1",
              status: "OPEN",
              type: "BUG",
            },
          ],
          components: [
            {
              key: "project:src/a.ts",
              name: "a.ts",
              path: "src/a.ts",
              qualifier: "FIL",
            },
          ],
          rules: [{ key: "ts:S1234", name: "Rule 1234", status: "READY" }],
        },
      });

      // Second page with same component and rule
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 2 },
          issues: [
            {
              key: "issue-2",
              rule: "ts:S1234",
              severity: "MINOR",
              component: "project:src/a.ts",
              project: "project",
              message: "Issue 2",
              status: "OPEN",
              type: "CODE_SMELL",
            },
          ],
          components: [
            {
              key: "project:src/a.ts",
              name: "a.ts",
              path: "src/a.ts",
              qualifier: "FIL",
            },
          ],
          rules: [{ key: "ts:S1234", name: "Rule 1234", status: "READY" }],
        },
      });

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(result.issues).toHaveLength(2);
      expect(result.components).toHaveLength(1); // Deduplicated
      expect(result.rules).toHaveLength(1); // Deduplicated
      expect(axiosMocks.get).toHaveBeenCalledTimes(3);
    });

    it("fetches missing rule details", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(1));

      // Issues response without rule details
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 1 },
          issues: [
            {
              key: "issue-1",
              rule: "ts:S9999",
              severity: "MAJOR",
              component: "project:src/a.ts",
              project: "project",
              message: "Issue 1",
              status: "OPEN",
              type: "BUG",
            },
          ],
          components: [
            {
              key: "project:src/a.ts",
              name: "a.ts",
              path: "src/a.ts",
              qualifier: "FIL",
            },
          ],
          rules: [], // Missing rule!
        },
      });

      // Rule details fetch
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          rule: {
            key: "ts:S9999",
            name: "Missing Rule",
            status: "READY",
            lang: "ts",
            severity: "MAJOR",
            type: "BUG",
          },
        },
      });

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(result.rules).toHaveLength(1);
      expect(result.rules[0].key).toBe("ts:S9999");
      expect(result.rules[0].name).toBe("Missing Rule");
      expect(core.warning).not.toHaveBeenCalled();
      expect(axiosMocks.get).toHaveBeenCalledTimes(3);
    });

    it("warns with summary when some rule detail fetches fail", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(2));

      // Issues response with two missing rules
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 2 },
          issues: [
            {
              key: "issue-1",
              rule: "ts:S1111",
              severity: "MAJOR",
              component: "project:src/a.ts",
              project: "project",
              message: "Issue 1",
              status: "OPEN",
              type: "BUG",
            },
            {
              key: "issue-2",
              rule: "ts:S2222",
              severity: "MINOR",
              component: "project:src/a.ts",
              project: "project",
              message: "Issue 2",
              status: "OPEN",
              type: "CODE_SMELL",
            },
          ],
          components: [
            {
              key: "project:src/a.ts",
              name: "a.ts",
              path: "src/a.ts",
              qualifier: "FIL",
            },
          ],
          rules: [],
        },
      });

      // First rule fetch succeeds
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          rule: {
            key: "ts:S1111",
            name: "Rule 1111",
            status: "READY",
            lang: "ts",
            severity: "MAJOR",
            type: "BUG",
          },
        },
      });

      // Second rule fetch fails
      axiosMocks.get.mockRejectedValueOnce(new Error("Not found"));

      const client = new SonarQubeClient(mockConfig);
      await client.fetchAllIssues();

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Could not fetch details for 1/2 rules"),
      );
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          "Affected rules will use basic metadata from the issues response",
        ),
      );
      expect(core.debug).toHaveBeenCalledWith(
        expect.stringContaining("Could not fetch rule ts:S2222"),
      );
      expect(axiosMocks.get).toHaveBeenCalledTimes(4);
    });

    it("warns with summary when all rule detail fetches fail", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(1));

      // Issues response with one missing rule
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 1 },
          issues: [
            {
              key: "issue-1",
              rule: "ts:S9999",
              severity: "MAJOR",
              component: "project:src/a.ts",
              project: "project",
              message: "Issue 1",
              status: "OPEN",
              type: "BUG",
            },
          ],
          components: [
            {
              key: "project:src/a.ts",
              name: "a.ts",
              path: "src/a.ts",
              qualifier: "FIL",
            },
          ],
          rules: [],
        },
      });

      // Rule fetch fails
      axiosMocks.get.mockRejectedValueOnce(new Error("SonarQube unavailable"));

      const client = new SonarQubeClient(mockConfig);
      await client.fetchAllIssues();

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Could not fetch details for 1/1 rules"),
      );
      expect(axiosMocks.get).toHaveBeenCalledTimes(3);
    });

    it("includes branch parameter when configured", async () => {
      const configWithBranch = { ...mockConfig, branch: "feature-branch" };

      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));

      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 0 },
          issues: [],
          components: [],
          rules: [],
        },
      });

      const client = new SonarQubeClient(configWithBranch);
      await client.fetchAllIssues();

      const issueSearchCalls = getIssueSearchCalls();
      expect(issueSearchCalls).toHaveLength(2);
      for (const requestConfig of issueSearchCalls) {
        expect(requestConfig).toMatchObject({
          params: expect.objectContaining({
            branch: "feature-branch",
          }),
        });
      }
    });

    it("includes resolved filter when configured", async () => {
      const configWithResolved = { ...mockConfig, includeResolved: true };

      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));

      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 0 },
          issues: [],
          components: [],
          rules: [],
        },
      });

      const client = new SonarQubeClient(configWithResolved);
      await client.fetchAllIssues();

      const issueSearchCalls = getIssueSearchCalls();
      expect(issueSearchCalls).toHaveLength(2);
      for (const requestConfig of issueSearchCalls) {
        expect(requestConfig).not.toMatchObject({
          params: expect.objectContaining({
            resolved: "false",
          }),
        });
      }
    });

    it("throws SonarQubeError on API error response", async () => {
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          errors: [{ msg: "Project not found" }],
        },
      });

      const client = new SonarQubeClient(mockConfig);

      await expect(client.fetchAllIssues()).rejects.toThrow(SonarQubeError);
    });

    it("throws on HTTP error", async () => {
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 401,
          data: { errors: [{ msg: "Unauthorized" }] },
        },
        message: "Request failed",
      };
      axiosMocks.get.mockRejectedValueOnce(axiosError);

      const client = new SonarQubeClient(mockConfig);

      await expect(client.fetchAllIssues()).rejects.toThrow(SonarQubeError);
    });

    it("throws on connection error", async () => {
      const axiosError = {
        isAxiosError: true,
        code: "ECONNREFUSED",
        message: "Connection refused",
      };
      axiosMocks.get.mockRejectedValueOnce(axiosError);

      const client = new SonarQubeClient(mockConfig);

      await expect(client.fetchAllIssues()).rejects.toThrow(SonarQubeError);
    });

    it("fetches all pages when paging.total is missing (last-page heuristic)", async () => {
      // Helper: build a page with N issues and no paging.total
      const makePage = (count: number, startIndex: number) => ({
        data: {
          // No paging.total — simulates an API that omits it
          paging: {},
          issues: Array.from({ length: count }, (_, i) => ({
            key: `issue-${startIndex + i}`,
            rule: "ts:S1234",
            severity: "MAJOR",
            component: "project:src/a.ts",
            project: "project",
            message: `Issue ${startIndex + i}`,
            status: "OPEN",
            type: "BUG",
          })),
          components: [
            {
              key: "project:src/a.ts",
              name: "a.ts",
              path: "src/a.ts",
              qualifier: "FIL",
            },
          ],
          rules: [{ key: "ts:S1234", name: "Rule 1234", status: "READY" }],
        },
      });

      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(1037));
      // Page 1: full page (500 issues) — must continue
      axiosMocks.get.mockResolvedValueOnce(makePage(500, 0));
      // Page 2: full page (500 issues) — must continue
      axiosMocks.get.mockResolvedValueOnce(makePage(500, 500));
      // Page 3: partial page (37 issues) — signals last page
      axiosMocks.get.mockResolvedValueOnce(makePage(37, 1000));

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(axiosMocks.get).toHaveBeenCalledTimes(4);
      expect(result.issues).toHaveLength(1037);
      expect(core.warning).not.toHaveBeenCalled();
    });

    it("stops after one page when paging.total is missing and page is partial", async () => {
      // A single partial page — no paging.total — should stop immediately
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(42));
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: {},
          issues: Array.from({ length: 42 }, (_, i) => ({
            key: `issue-${i}`,
            rule: "ts:S1234",
            severity: "MAJOR",
            component: "project:src/a.ts",
            project: "project",
            message: `Issue ${i}`,
            status: "OPEN",
            type: "BUG",
          })),
          components: [
            {
              key: "project:src/a.ts",
              name: "a.ts",
              path: "src/a.ts",
              qualifier: "FIL",
            },
          ],
          rules: [{ key: "ts:S1234", name: "Rule 1234", status: "READY" }],
        },
      });

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(axiosMocks.get).toHaveBeenCalledTimes(2);
      expect(result.issues).toHaveLength(42);
      expect(core.warning).not.toHaveBeenCalled();
    });

    it("fetches exactly MAX_PAGE_SIZE issues in one page without spurious extra fetch", async () => {
      // paging.total present and equals page size — should stop after page 1
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(500));
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 500 },
          issues: Array.from({ length: 500 }, (_, i) => ({
            key: `issue-${i}`,
            rule: "ts:S1234",
            severity: "MAJOR",
            component: "project:src/a.ts",
            project: "project",
            message: `Issue ${i}`,
            status: "OPEN",
            type: "BUG",
          })),
          components: [
            {
              key: "project:src/a.ts",
              name: "a.ts",
              path: "src/a.ts",
              qualifier: "FIL",
            },
          ],
          rules: [{ key: "ts:S1234", name: "Rule 1234", status: "READY" }],
        },
      });

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(axiosMocks.get).toHaveBeenCalledTimes(2);
      expect(result.issues).toHaveLength(500);
      expect(core.warning).not.toHaveBeenCalled();
    });
  });

  describe("10k+ issue partitioning", () => {
    it("partitions by issue type when total exceeds 10000", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(15000));
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(5000));
      axiosMocks.get.mockResolvedValueOnce(
        makeIssuesResponse({
          total: 5000,
          issues: makeIssueBatch(5000, "bug", {
            type: "BUG",
            rule: "ts:S-BUG",
          }),
          rules: [makeRule({ key: "ts:S-BUG", name: "Bug Rule", type: "BUG" })],
        }),
      );
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(3000));
      axiosMocks.get.mockResolvedValueOnce(
        makeIssuesResponse({
          total: 3000,
          issues: makeIssueBatch(3000, "vuln", {
            type: "VULNERABILITY",
            rule: "ts:S-VULN",
          }),
          components: [
            makeComponent({
              key: "project:src/b.ts",
              name: "b.ts",
              path: "src/b.ts",
            }),
          ],
          rules: [
            makeRule({
              key: "ts:S-VULN",
              name: "Vulnerability Rule",
              type: "VULNERABILITY",
            }),
          ],
        }),
      );
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(7000));
      axiosMocks.get.mockResolvedValueOnce(
        makeIssuesResponse({
          total: 7000,
          issues: makeIssueBatch(7000, "smell", {
            type: "CODE_SMELL",
            rule: "ts:S-SMELL",
          }),
          components: [
            makeComponent({
              key: "project:src/c.ts",
              name: "c.ts",
              path: "src/c.ts",
            }),
          ],
          rules: [
            makeRule({
              key: "ts:S-SMELL",
              name: "Code Smell Rule",
              type: "CODE_SMELL",
            }),
          ],
        }),
      );
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(result.issues).toHaveLength(15000);
      expect(result.rules).toHaveLength(3);
      expect(axiosMocks.get).toHaveBeenCalledTimes(8);
      expect(axiosMocks.get).toHaveBeenNthCalledWith(1, "/api/issues/search", {
        params: {
          componentKeys: "my-project",
          ps: 1,
          p: 1,
          resolved: "false",
        },
      });
      expect(axiosMocks.get).toHaveBeenNthCalledWith(2, "/api/issues/search", {
        params: {
          componentKeys: "my-project",
          ps: 1,
          p: 1,
          resolved: "false",
          types: "BUG",
        },
      });
      expect(axiosMocks.get).toHaveBeenNthCalledWith(3, "/api/issues/search", {
        params: {
          componentKeys: "my-project",
          ps: 500,
          p: 1,
          resolved: "false",
          types: "BUG",
        },
      });
      expect(axiosMocks.get).toHaveBeenNthCalledWith(4, "/api/issues/search", {
        params: {
          componentKeys: "my-project",
          ps: 1,
          p: 1,
          resolved: "false",
          types: "VULNERABILITY",
        },
      });
      expect(axiosMocks.get).toHaveBeenNthCalledWith(5, "/api/issues/search", {
        params: {
          componentKeys: "my-project",
          ps: 500,
          p: 1,
          resolved: "false",
          types: "VULNERABILITY",
        },
      });
      expect(axiosMocks.get).toHaveBeenNthCalledWith(6, "/api/issues/search", {
        params: {
          componentKeys: "my-project",
          ps: 1,
          p: 1,
          resolved: "false",
          types: "CODE_SMELL",
        },
      });
      expect(axiosMocks.get).toHaveBeenNthCalledWith(7, "/api/issues/search", {
        params: {
          componentKeys: "my-project",
          ps: 500,
          p: 1,
          resolved: "false",
          types: "CODE_SMELL",
        },
      });
      expect(axiosMocks.get).toHaveBeenNthCalledWith(8, "/api/issues/search", {
        params: {
          componentKeys: "my-project",
          ps: 1,
          p: 1,
          resolved: "false",
          types: "SECURITY_HOTSPOT",
        },
      });
    });

    it("deduplicates issues across type partitions", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(15000));
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(2));
      axiosMocks.get.mockResolvedValueOnce(
        makeIssuesResponse({
          total: 2,
          issues: [
            makeIssue("shared", { type: "BUG", rule: "ts:S-BUG" }),
            makeIssue("bug-only", { type: "BUG", rule: "ts:S-BUG" }),
          ],
          rules: [makeRule({ key: "ts:S-BUG", name: "Bug Rule", type: "BUG" })],
        }),
      );
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(2));
      axiosMocks.get.mockResolvedValueOnce(
        makeIssuesResponse({
          total: 2,
          issues: [
            makeIssue("shared", {
              type: "VULNERABILITY",
              rule: "ts:S-VULN",
              message: "Duplicate issue from second partition",
            }),
            makeIssue("vuln-only", {
              type: "VULNERABILITY",
              rule: "ts:S-VULN",
            }),
          ],
          rules: [
            makeRule({
              key: "ts:S-VULN",
              name: "Vulnerability Rule",
              type: "VULNERABILITY",
            }),
          ],
        }),
      );
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(result.issues).toHaveLength(3);
      expect(result.issues.map((issue) => issue.key)).toEqual([
        "issue-shared",
        "issue-bug-only",
        "issue-vuln-only",
      ]);
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining(
          "Deduplicated 1 duplicate issues across partitions.",
        ),
      );
    });

    it("uses date bisection when a single type exceeds 10000", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(25000));
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(12000));
      axiosMocks.get.mockResolvedValueOnce(
        makeIssuesResponse({
          issues: [
            makeIssue("oldest", {
              type: "BUG",
              rule: "ts:S-BUG",
              creationDate: "2024-01-01T00:00:00.000Z",
            }),
          ],
          rules: [makeRule({ key: "ts:S-BUG", name: "Bug Rule", type: "BUG" })],
          includeTotal: false,
        }),
      );
      axiosMocks.get.mockResolvedValueOnce(
        makeIssuesResponse({
          issues: [
            makeIssue("newest", {
              type: "BUG",
              rule: "ts:S-BUG",
              creationDate: "2024-01-31T00:00:00.000Z",
            }),
          ],
          rules: [makeRule({ key: "ts:S-BUG", name: "Bug Rule", type: "BUG" })],
          includeTotal: false,
        }),
      );
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(6000));
      axiosMocks.get.mockResolvedValueOnce(
        makeIssuesResponse({
          total: 6000,
          issues: makeIssueBatch(6000, "left", {
            type: "BUG",
            rule: "ts:S-BUG",
          }),
          rules: [makeRule({ key: "ts:S-BUG", name: "Bug Rule", type: "BUG" })],
        }),
      );
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(6000));
      axiosMocks.get.mockResolvedValueOnce(
        makeIssuesResponse({
          total: 6000,
          issues: makeIssueBatch(6000, "right", {
            type: "BUG",
            rule: "ts:S-BUG",
          }),
          rules: [makeRule({ key: "ts:S-BUG", name: "Bug Rule", type: "BUG" })],
        }),
      );
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(result.issues).toHaveLength(12000);
      expect(core.info).toHaveBeenCalledWith(
        expect.stringContaining(
          "Type BUG exceeds limit, splitting by date range",
        ),
      );
      const issueSearchCalls = getIssueSearchCalls();
      expect(
        issueSearchCalls.some(
          (requestConfig) =>
            typeof requestConfig.params?.createdBefore === "string",
        ),
      ).toBe(true);
      expect(
        issueSearchCalls.some(
          (requestConfig) =>
            typeof requestConfig.params?.createdAfter === "string",
        ),
      ).toBe(true);
    });

    it("falls back to 10k limit at max bisection depth", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(20000));
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(12000));

      for (let depth = 0; depth < 16; depth++) {
        axiosMocks.get.mockResolvedValueOnce(
          makeIssuesResponse({
            issues: [
              makeIssue(`oldest-${depth}`, {
                type: "BUG",
                rule: "ts:S-BUG",
                creationDate: "2024-01-01T00:00:00.000Z",
              }),
            ],
            rules: [
              makeRule({ key: "ts:S-BUG", name: "Bug Rule", type: "BUG" }),
            ],
            includeTotal: false,
          }),
        );
        axiosMocks.get.mockResolvedValueOnce(
          makeIssuesResponse({
            issues: [
              makeIssue(`newest-${depth}`, {
                type: "BUG",
                rule: "ts:S-BUG",
                creationDate: "2024-12-31T00:00:00.000Z",
              }),
            ],
            rules: [
              makeRule({ key: "ts:S-BUG", name: "Bug Rule", type: "BUG" }),
            ],
            includeTotal: false,
          }),
        );
        axiosMocks.get.mockResolvedValueOnce(makeCountResponse(12000));
      }

      axiosMocks.get.mockResolvedValueOnce(
        makeIssuesResponse({
          total: 10000,
          issues: makeIssueBatch(10000, "fallback", {
            type: "BUG",
            rule: "ts:S-BUG",
          }),
          rules: [makeRule({ key: "ts:S-BUG", name: "Bug Rule", type: "BUG" })],
        }),
      );

      for (let depth = 0; depth < 16; depth++) {
        axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));
      }

      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(result.issues).toHaveLength(10000);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Date bisection reached maximum depth (16)"),
      );
    });

    it("handles same-timestamp cluster in date bisection", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(15000));
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(12000));
      axiosMocks.get.mockResolvedValueOnce(
        makeIssuesResponse({
          issues: [
            makeIssue("same-oldest", {
              type: "BUG",
              rule: "ts:S-BUG",
              creationDate: "2024-01-01T00:00:00.000Z",
            }),
          ],
          rules: [makeRule({ key: "ts:S-BUG", name: "Bug Rule", type: "BUG" })],
          includeTotal: false,
        }),
      );
      axiosMocks.get.mockResolvedValueOnce(
        makeIssuesResponse({
          issues: [
            makeIssue("same-newest", {
              type: "BUG",
              rule: "ts:S-BUG",
              creationDate: "2024-01-01T00:00:00.000Z",
            }),
          ],
          rules: [makeRule({ key: "ts:S-BUG", name: "Bug Rule", type: "BUG" })],
          includeTotal: false,
        }),
      );
      axiosMocks.get.mockResolvedValueOnce(
        makeIssuesResponse({
          total: 10000,
          issues: makeIssueBatch(10000, "same-time", {
            type: "BUG",
            rule: "ts:S-BUG",
          }),
          rules: [makeRule({ key: "ts:S-BUG", name: "Bug Rule", type: "BUG" })],
        }),
      );
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(0));

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(result.issues).toHaveLength(10000);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining(
          "All issues in window share the same timestamp",
        ),
      );
    });
  });

  describe("waitForProcessing", () => {
    it("returns immediately when no analysis in progress", async () => {
      axiosMocks.get.mockResolvedValueOnce({
        data: { current: null },
      });

      const client = new SonarQubeClient(mockConfig);
      const promise = client.waitForProcessing();

      await vi.runAllTimersAsync();
      await promise;

      expect(core.info).toHaveBeenCalledWith("✓ No analysis in progress");
    });

    it("waits until analysis succeeds", async () => {
      // First call: IN_PROGRESS
      axiosMocks.get.mockResolvedValueOnce({
        data: { current: { status: "IN_PROGRESS" } },
      });

      // Second call: SUCCESS
      axiosMocks.get.mockResolvedValueOnce({
        data: { current: { status: "SUCCESS" } },
      });

      const client = new SonarQubeClient(mockConfig);
      const promise = client.waitForProcessing();

      // Advance past first poll
      await vi.advanceTimersByTimeAsync(10000);
      await promise;

      expect(core.info).toHaveBeenCalledWith(
        "✓ Analysis completed successfully",
      );
    });

    it("warns and continues when analysis fails", async () => {
      axiosMocks.get.mockResolvedValueOnce({
        data: { current: { status: "FAILED" } },
      });

      const client = new SonarQubeClient(mockConfig);
      const promise = client.waitForProcessing();

      await vi.runAllTimersAsync();
      await promise;

      expect(core.warning).toHaveBeenCalledWith(
        "Analysis failed. Proceeding with existing issues.",
      );
    });

    it("warns and continues when analysis canceled", async () => {
      axiosMocks.get.mockResolvedValueOnce({
        data: { current: { status: "CANCELED" } },
      });

      const client = new SonarQubeClient(mockConfig);
      const promise = client.waitForProcessing();

      await vi.runAllTimersAsync();
      await promise;

      expect(core.warning).toHaveBeenCalledWith(
        "Analysis canceled. Proceeding with existing issues.",
      );
    });

    it("times out after maxWaitTime", async () => {
      // Always return PENDING
      axiosMocks.get.mockResolvedValue({
        data: { current: { status: "PENDING" } },
      });

      const shortTimeoutConfig = {
        ...mockConfig,
        maxWaitTime: 30,
        pollingInterval: 10,
      };
      const client = new SonarQubeClient(shortTimeoutConfig);
      const promise = client.waitForProcessing();

      // Advance time past timeout
      await vi.advanceTimersByTimeAsync(35000);
      await promise;

      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Timeout after 30s"),
      );
    });

    it("handles 404 from CE endpoint gracefully", async () => {
      const error = new SonarQubeError("Not found", "PROJECT_NOT_FOUND", 404);
      axiosMocks.get.mockRejectedValueOnce(error);

      const client = new SonarQubeClient(mockConfig);
      const promise = client.waitForProcessing();

      await vi.runAllTimersAsync();
      await promise;

      expect(core.warning).toHaveBeenCalledWith(
        "CE endpoint unavailable (older SonarQube?). Skipping wait.",
      );
    });
  });

  describe("applyProcessingDelay", () => {
    it("waits for configured delay", async () => {
      const configWithDelay = { ...mockConfig, processingDelay: 5 };
      const client = new SonarQubeClient(configWithDelay);

      const promise = client.applyProcessingDelay();

      expect(core.info).toHaveBeenCalledWith(
        "Waiting 5s for analysis to complete...",
      );

      await vi.advanceTimersByTimeAsync(5000);
      await promise;
    });

    it("does nothing when delay is 0", async () => {
      const client = new SonarQubeClient(mockConfig);

      await client.applyProcessingDelay();

      expect(core.info).not.toHaveBeenCalledWith(
        expect.stringContaining("Waiting"),
      );
    });
  });

  describe("error handling", () => {
    it("handles timeout errors", async () => {
      const axiosError = {
        isAxiosError: true,
        code: "ETIMEDOUT",
        message: "Timeout",
      };
      // ETIMEDOUT is retryable — mock all 4 attempts (1 initial + 3 retries)
      axiosMocks.get.mockRejectedValueOnce(axiosError);
      axiosMocks.get.mockRejectedValueOnce(axiosError);
      axiosMocks.get.mockRejectedValueOnce(axiosError);
      axiosMocks.get.mockRejectedValueOnce(axiosError);

      const client = new SonarQubeClient(mockConfig);
      const promise = client.fetchAllIssues();
      const expectation = expect(promise).rejects.toThrow(SonarQubeError);

      // Advance through all retry delays: 1s + 2s + 4s = 7s
      await vi.advanceTimersByTimeAsync(10000);

      await expectation;
    });

    it("handles generic errors", async () => {
      axiosMocks.get.mockRejectedValueOnce(new Error("Something went wrong"));

      const client = new SonarQubeClient(mockConfig);

      await expect(client.fetchAllIssues()).rejects.toThrow(SonarQubeError);
    });

    it("handles malformed response", async () => {
      axiosMocks.get.mockResolvedValueOnce({
        data: "not an object",
      });

      const client = new SonarQubeClient(mockConfig);

      await expect(client.fetchAllIssues()).rejects.toThrow(SonarQubeError);
    });

    it("handles response without issues array", async () => {
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 0 },
          // missing issues field
        },
      });

      const client = new SonarQubeClient(mockConfig);

      await expect(client.fetchAllIssues()).rejects.toThrow(SonarQubeError);
    });
  });

  describe("retry behavior", () => {
    const successResponse = {
      data: {
        paging: { total: 1 },
        issues: [
          {
            key: "issue-1",
            rule: "ts:S1234",
            severity: "MAJOR",
            component: "project:src/a.ts",
            project: "project",
            line: 10,
            status: "OPEN",
            message: "Fix this",
            effort: "5min",
            debt: "5min",
            type: "CODE_SMELL",
            flows: [],
            textRange: {
              startLine: 10,
              endLine: 10,
              startOffset: 0,
              endOffset: 5,
            },
          },
        ],
        components: [
          { key: "project:src/a.ts", path: "src/a.ts", name: "a.ts" },
        ],
        rules: [
          {
            key: "ts:S1234",
            name: "Rule",
            status: "READY",
            lang: "ts",
            langName: "TypeScript",
          },
        ],
      },
    };

    it("succeeds after a transient 503 on the first attempt", async () => {
      const transientError = {
        isAxiosError: true,
        response: { status: 503, data: {} },
        message: "Service Unavailable",
      };
      axiosMocks.get.mockRejectedValueOnce(transientError);
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(1));
      axiosMocks.get.mockResolvedValueOnce(successResponse);

      const client = new SonarQubeClient(mockConfig);
      const promise = client.fetchAllIssues();

      // Advance past the first retry delay (up to 2s with jitter at max)
      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.issues).toHaveLength(1);
      expect(axiosMocks.get).toHaveBeenCalledTimes(3);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("Retry 1/3"),
      );
    });

    it("succeeds after a transient 429 rate-limit on the first attempt", async () => {
      const rateLimitError = {
        isAxiosError: true,
        response: { status: 429, headers: {}, data: {} },
        message: "Too Many Requests",
      };
      axiosMocks.get.mockRejectedValueOnce(rateLimitError);
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(1));
      axiosMocks.get.mockResolvedValueOnce(successResponse);

      const client = new SonarQubeClient(mockConfig);
      const promise = client.fetchAllIssues();

      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.issues).toHaveLength(1);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("HTTP 429"),
      );
    });

    it("respects Retry-After header on 429 response", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);

      const rateLimitError = {
        isAxiosError: true,
        response: {
          status: 429,
          headers: { "retry-after": "5" }, // 5 seconds
          data: {},
        },
        message: "Too Many Requests",
      };
      axiosMocks.get.mockRejectedValueOnce(rateLimitError);
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(1));
      axiosMocks.get.mockResolvedValueOnce(successResponse);

      const client = new SonarQubeClient(mockConfig);
      const promise = client.fetchAllIssues();

      // 4999ms should NOT be enough (Retry-After = 5000ms)
      await vi.advanceTimersByTimeAsync(4999);
      expect(axiosMocks.get).toHaveBeenCalledTimes(1); // still waiting

      // 1 more ms tips it over
      await vi.advanceTimersByTimeAsync(1);
      const result = await promise;

      expect(result.issues).toHaveLength(1);
    });

    it("does not retry permanent 401 errors", async () => {
      const authError = {
        isAxiosError: true,
        response: { status: 401, data: { errors: [{ msg: "Unauthorized" }] } },
        message: "Unauthorized",
      };
      axiosMocks.get.mockRejectedValueOnce(authError);

      const client = new SonarQubeClient(mockConfig);
      await expect(client.fetchAllIssues()).rejects.toThrow(SonarQubeError);

      // Should have been called exactly once — no retry
      expect(axiosMocks.get).toHaveBeenCalledTimes(1);
      expect(core.warning).not.toHaveBeenCalledWith(
        expect.stringContaining("Retry"),
      );
    });

    it("does not retry permanent 404 errors", async () => {
      const notFoundError = {
        isAxiosError: true,
        response: { status: 404, data: {} },
        message: "Not Found",
      };
      axiosMocks.get.mockRejectedValueOnce(notFoundError);

      const client = new SonarQubeClient(mockConfig);
      await expect(client.fetchAllIssues()).rejects.toThrow(SonarQubeError);

      expect(axiosMocks.get).toHaveBeenCalledTimes(1);
    });

    it("throws after exhausting MAX_RETRIES on persistent 502", async () => {
      const badGateway = {
        isAxiosError: true,
        response: { status: 502, data: {} },
        message: "Bad Gateway",
      };
      // 1 initial + 3 retries = 4 total attempts
      axiosMocks.get.mockRejectedValueOnce(badGateway);
      axiosMocks.get.mockRejectedValueOnce(badGateway);
      axiosMocks.get.mockRejectedValueOnce(badGateway);
      axiosMocks.get.mockRejectedValueOnce(badGateway);

      const client = new SonarQubeClient(mockConfig);
      const promise = client.fetchAllIssues();
      const expectation = expect(promise).rejects.toThrow();

      // Advance through all retry delays: 1s + 2s + 4s = 7s (plus jitter overhead)
      await vi.advanceTimersByTimeAsync(10000);

      await expectation;
      expect(axiosMocks.get).toHaveBeenCalledTimes(4); // 1 + 3 retries
      expect(core.warning).toHaveBeenCalledTimes(3); // one warning per retry
    });

    it("retries on ECONNRESET network error", async () => {
      const networkError = {
        isAxiosError: true,
        code: "ECONNRESET",
        message: "socket hang up",
      };
      axiosMocks.get.mockRejectedValueOnce(networkError);
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(1));
      axiosMocks.get.mockResolvedValueOnce(successResponse);

      const client = new SonarQubeClient(mockConfig);
      const promise = client.fetchAllIssues();

      await vi.advanceTimersByTimeAsync(2000);
      const result = await promise;

      expect(result.issues).toHaveLength(1);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("ECONNRESET"),
      );
    });
  });

  describe("getMetrics", () => {
    const singleIssueResponse = {
      data: {
        paging: { total: 1 },
        issues: [
          {
            key: "issue-1",
            rule: "ts:S1234",
            severity: "MAJOR",
            component: "project:src/a.ts",
            project: "project",
            message: "Issue 1",
            status: "OPEN",
            type: "BUG",
          },
        ],
        components: [
          { key: "project:src/a.ts", name: "a.ts", qualifier: "FIL" },
        ],
        rules: [{ key: "ts:S1234", name: "Rule 1234", status: "READY" }],
      },
    };

    it("returns zero counts before any requests", () => {
      const client = new SonarQubeClient(mockConfig);
      const metrics = client.getMetrics();

      expect(metrics.apiRequestCount).toBe(0);
      expect(metrics.apiErrorCount).toBe(0);
      expect(metrics.apiRetryCount).toBe(0);
      expect(metrics.pagesFetched).toBe(0);
      expect(metrics.ruleFetchSuccessRate).toBe(100);
    });

    it("counts a successful single-page fetch as 1 request and 1 page", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(1));
      axiosMocks.get.mockResolvedValueOnce(singleIssueResponse);

      const client = new SonarQubeClient(mockConfig);
      await client.fetchAllIssues();
      const metrics = client.getMetrics();

      expect(metrics.apiRequestCount).toBe(2);
      expect(metrics.apiErrorCount).toBe(0);
      expect(metrics.apiRetryCount).toBe(0);
      expect(metrics.pagesFetched).toBe(1);
    });

    it("counts pages fetched for multi-page response", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(2));
      // Page 1
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 2 },
          issues: [
            {
              key: "issue-1",
              rule: "ts:S1234",
              severity: "MAJOR",
              component: "project:src/a.ts",
              project: "project",
              message: "Issue 1",
              status: "OPEN",
              type: "BUG",
            },
          ],
          components: [
            { key: "project:src/a.ts", name: "a.ts", qualifier: "FIL" },
          ],
          rules: [{ key: "ts:S1234", name: "Rule 1234", status: "READY" }],
        },
      });
      // Page 2
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 2 },
          issues: [
            {
              key: "issue-2",
              rule: "ts:S1234",
              severity: "MINOR",
              component: "project:src/a.ts",
              project: "project",
              message: "Issue 2",
              status: "OPEN",
              type: "CODE_SMELL",
            },
          ],
          components: [
            { key: "project:src/a.ts", name: "a.ts", qualifier: "FIL" },
          ],
          rules: [],
        },
      });

      const client = new SonarQubeClient(mockConfig);
      await client.fetchAllIssues();
      const metrics = client.getMetrics();

      expect(metrics.pagesFetched).toBe(2);
      expect(metrics.apiRequestCount).toBe(3);
    });

    it("counts retry attempts and HTTP errors", async () => {
      const serverError = {
        isAxiosError: true,
        response: { status: 503, data: {} },
        message: "Service Unavailable",
      };
      axiosMocks.get.mockRejectedValueOnce(serverError);
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(1));
      axiosMocks.get.mockResolvedValueOnce(singleIssueResponse);

      const client = new SonarQubeClient(mockConfig);
      const promise = client.fetchAllIssues();
      await vi.advanceTimersByTimeAsync(2000);
      await promise;

      const metrics = client.getMetrics();
      // 3 total requests (1 failed count + 1 successful count + 1 page fetch)
      expect(metrics.apiRequestCount).toBe(3);
      // 1 HTTP error before retry
      expect(metrics.apiErrorCount).toBe(1);
      // 1 retry attempt
      expect(metrics.apiRetryCount).toBe(1);
    });

    it("reports 100% rule fetch success rate when all rules succeed", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(1));
      // Response with a missing rule
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 1 },
          issues: [
            {
              key: "issue-1",
              rule: "ts:S9999",
              severity: "MAJOR",
              component: "project:src/a.ts",
              project: "project",
              message: "Issue 1",
              status: "OPEN",
              type: "BUG",
            },
          ],
          components: [
            { key: "project:src/a.ts", name: "a.ts", qualifier: "FIL" },
          ],
          rules: [],
        },
      });
      // Rule detail fetch succeeds
      axiosMocks.get.mockResolvedValueOnce(
        makeRuleDetailResponse({
          key: "ts:S9999",
          name: "Missing Rule",
          status: "READY",
          severity: "MAJOR",
          type: "BUG",
        }),
      );

      const client = new SonarQubeClient(mockConfig);
      await client.fetchAllIssues();
      const metrics = client.getMetrics();

      expect(metrics.ruleFetchSuccessRate).toBe(100);
    });

    it("reports partial rule fetch success rate when some rule fetches fail", async () => {
      axiosMocks.get.mockResolvedValueOnce(makeCountResponse(1));
      // Two missing rules
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          paging: { total: 1 },
          issues: [
            {
              key: "issue-1",
              rule: "ts:S1111",
              severity: "MAJOR",
              component: "project:src/a.ts",
              project: "project",
              message: "Issue 1",
              status: "OPEN",
              type: "BUG",
            },
            {
              key: "issue-2",
              rule: "ts:S2222",
              severity: "MINOR",
              component: "project:src/a.ts",
              project: "project",
              message: "Issue 2",
              status: "OPEN",
              type: "CODE_SMELL",
            },
          ],
          components: [
            { key: "project:src/a.ts", name: "a.ts", qualifier: "FIL" },
          ],
          rules: [],
        },
      });
      // First rule succeeds, second fails
      axiosMocks.get.mockResolvedValueOnce({
        data: {
          rule: {
            key: "ts:S1111",
            name: "Rule 1111",
            status: "READY",
          },
        },
      });
      axiosMocks.get.mockRejectedValueOnce(new Error("Network error"));

      const client = new SonarQubeClient(mockConfig);
      await client.fetchAllIssues();
      const metrics = client.getMetrics();

      expect(metrics.ruleFetchSuccessRate).toBe(50);
    });
  });
});
