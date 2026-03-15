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
};

vi.mock("axios", () => ({
  default: {
    create: (...args: unknown[]) => {
      axiosMocks.create(...args);
      return { get: axiosMocks.get };
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
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
  });

  describe("fetchAllIssues", () => {
    it("fetches issues with pagination", async () => {
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
      expect(axiosMocks.get).toHaveBeenCalledTimes(2);
    });

    it("fetches single page when total fits", async () => {
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
      expect(axiosMocks.get).toHaveBeenCalledTimes(1);
    });

    it("handles empty response", async () => {
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
    });

    it("deduplicates components and rules across pages", async () => {
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
    });

    it("fetches missing rule details", async () => {
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
    });

    it("includes branch parameter when configured", async () => {
      const configWithBranch = { ...mockConfig, branch: "feature-branch" };

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

      expect(axiosMocks.get).toHaveBeenCalledWith("/api/issues/search", {
        params: expect.objectContaining({
          branch: "feature-branch",
        }),
      });
    });

    it("includes resolved filter when configured", async () => {
      const configWithResolved = { ...mockConfig, includeResolved: true };

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

      expect(axiosMocks.get).toHaveBeenCalledWith("/api/issues/search", {
        params: expect.not.objectContaining({
          resolved: "false",
        }),
      });
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

      // Page 1: full page (500 issues) — must continue
      axiosMocks.get.mockResolvedValueOnce(makePage(500, 0));
      // Page 2: full page (500 issues) — must continue
      axiosMocks.get.mockResolvedValueOnce(makePage(500, 500));
      // Page 3: partial page (37 issues) — signals last page
      axiosMocks.get.mockResolvedValueOnce(makePage(37, 1000));

      const client = new SonarQubeClient(mockConfig);
      const result = await client.fetchAllIssues();

      expect(axiosMocks.get).toHaveBeenCalledTimes(3);
      expect(result.issues).toHaveLength(1037);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("missing paging.total"),
      );
    });

    it("stops after one page when paging.total is missing and page is partial", async () => {
      // A single partial page — no paging.total — should stop immediately
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

      expect(axiosMocks.get).toHaveBeenCalledTimes(1);
      expect(result.issues).toHaveLength(42);
      expect(core.warning).toHaveBeenCalledWith(
        expect.stringContaining("missing paging.total"),
      );
    });

    it("fetches exactly MAX_PAGE_SIZE issues in one page without spurious extra fetch", async () => {
      // paging.total present and equals page size — should stop after page 1
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

      expect(axiosMocks.get).toHaveBeenCalledTimes(1);
      expect(result.issues).toHaveLength(500);
      expect(core.warning).not.toHaveBeenCalled();
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
      axiosMocks.get.mockRejectedValueOnce(axiosError);

      const client = new SonarQubeClient(mockConfig);

      await expect(client.fetchAllIssues()).rejects.toThrow(SonarQubeError);
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
});
