import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  parseConfig,
  maskSecrets,
  ConfigError,
  SEVERITY_ORDER,
} from "../src/config";

// Mock @actions/core
vi.mock("@actions/core", () => ({
  getInput: vi.fn(),
  setSecret: vi.fn(),
}));

// Mock @actions/github
vi.mock("@actions/github", () => ({
  context: {
    repo: { repo: "test-repo", owner: "test-owner" },
    payload: { 
      repository: { name: "test-repo" },
      pull_request: { number: 123 },
    },
  },
}));

import * as core from "@actions/core";

describe("config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("parseConfig", () => {
    it("parses all required inputs correctly", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "https://sonar.example.com",
          "sonar-token": "secret-token",
          "project-key": "my-project",
          "output-file": "results.sarif",
          branch: "main",
          "wait-for-processing": "true",
          "max-wait-time": "600",
          "polling-interval": "15",
          "min-severity": "MAJOR",
          "include-resolved": "true",
          "pr-comment": "true",
          "fail-on-severity": "CRITICAL",
        };
        return inputs[name] || "";
      });

      const config = parseConfig();

      expect(config.sonarHostUrl).toBe("https://sonar.example.com");
      expect(config.sonarToken).toBe("secret-token");
      expect(config.projectKey).toBe("my-project");
      expect(config.projectKeySource).toBe("input");
      expect(config.outputFile).toBe("results.sarif");
      expect(config.branch).toBe("main");
      expect(config.pullRequestNumber).toBe(123);
      expect(config.waitForProcessing).toBe(true);
      expect(config.maxWaitTime).toBe(600);
      expect(config.pollingInterval).toBe(15);
      expect(config.minSeverity).toBe("MAJOR");
      expect(config.includeResolved).toBe(true);
      expect(config.prComment).toBe(true);
      expect(config.failOnSeverity).toBe("CRITICAL");
    });

    it("uses defaults for optional inputs", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "https://sonar.example.com",
          "sonar-token": "secret-token",
          "project-key": "my-project",
        };
        return inputs[name] || "";
      });

      const config = parseConfig();

      expect(config.outputFile).toBe("sonarqube.sarif");
      expect(config.branch).toBeUndefined();
      expect(config.pullRequestNumber).toBe(123); // Auto-detected from context
      expect(config.waitForProcessing).toBe(true);
      expect(config.maxWaitTime).toBe(300);
      expect(config.pollingInterval).toBe(10);
      expect(config.minSeverity).toBe("INFO");
      expect(config.includeResolved).toBe(false);
      expect(config.prComment).toBe(true); // Defaults to true when in PR context
      expect(config.failOnSeverity).toBeUndefined(); // No default
    });

    it("falls back to repository name when project-key is empty", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "https://sonar.example.com",
          "sonar-token": "secret-token",
          "project-key": "",
        };
        return inputs[name] || "";
      });

      const config = parseConfig();

      expect(config.projectKey).toBe("test-repo");
      expect(config.projectKeySource).toBe("repository");
    });

    it("removes trailing slash from sonar-host-url", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "https://sonar.example.com/",
          "sonar-token": "secret-token",
          "project-key": "my-project",
        };
        return inputs[name] || "";
      });

      const config = parseConfig();

      expect(config.sonarHostUrl).toBe("https://sonar.example.com");
    });

    it("throws ConfigError for invalid sonar-host-url", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "not-a-url",
          "sonar-token": "secret-token",
          "project-key": "my-project",
        };
        return inputs[name] || "";
      });

      expect(() => parseConfig()).toThrow(ConfigError);
      expect(() => parseConfig()).toThrow(
        "sonar-host-url must be a valid URL",
      );
    });

    it("throws ConfigError for empty sonar-token", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "https://sonar.example.com",
          "sonar-token": "   ",
          "project-key": "my-project",
        };
        return inputs[name] || "";
      });

      expect(() => parseConfig()).toThrow(ConfigError);
      expect(() => parseConfig()).toThrow("sonar-token cannot be empty");
    });

    it("throws ConfigError for invalid max-wait-time", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "https://sonar.example.com",
          "sonar-token": "secret-token",
          "project-key": "my-project",
          "max-wait-time": "-5",
        };
        return inputs[name] || "";
      });

      expect(() => parseConfig()).toThrow(ConfigError);
      expect(() => parseConfig()).toThrow("must be a positive integer");
    });

    it("parses processing-delay with valid values", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "https://sonar.example.com",
          "sonar-token": "secret-token",
          "project-key": "my-project",
          "processing-delay": "60",
        };
        return inputs[name] || "";
      });

      const config = parseConfig();

      expect(config.processingDelay).toBe(60);
    });

    it("defaults processing-delay to 0", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "https://sonar.example.com",
          "sonar-token": "secret-token",
          "project-key": "my-project",
        };
        return inputs[name] || "";
      });

      const config = parseConfig();

      expect(config.processingDelay).toBe(0);
    });

    it("accepts processing-delay at maximum value of 600", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "https://sonar.example.com",
          "sonar-token": "secret-token",
          "project-key": "my-project",
          "processing-delay": "600",
        };
        return inputs[name] || "";
      });

      const config = parseConfig();

      expect(config.processingDelay).toBe(600);
    });

    it("throws ConfigError for processing-delay exceeding 600", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "https://sonar.example.com",
          "sonar-token": "secret-token",
          "project-key": "my-project",
          "processing-delay": "601",
        };
        return inputs[name] || "";
      });

      expect(() => parseConfig()).toThrow(ConfigError);
      expect(() => parseConfig()).toThrow("must not exceed 600");
    });

    it("throws ConfigError for negative processing-delay", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "https://sonar.example.com",
          "sonar-token": "secret-token",
          "project-key": "my-project",
          "processing-delay": "-10",
        };
        return inputs[name] || "";
      });

      expect(() => parseConfig()).toThrow(ConfigError);
      expect(() => parseConfig()).toThrow("must be a non-negative integer");
    });

    it("normalizes severity to uppercase", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "https://sonar.example.com",
          "sonar-token": "secret-token",
          "project-key": "my-project",
          "min-severity": "critical",
        };
        return inputs[name] || "";
      });

      const config = parseConfig();

      expect(config.minSeverity).toBe("CRITICAL");
    });

    it("falls back to INFO for invalid severity", () => {
      vi.mocked(core.getInput).mockImplementation((name: string) => {
        const inputs: Record<string, string> = {
          "sonar-host-url": "https://sonar.example.com",
          "sonar-token": "secret-token",
          "project-key": "my-project",
          "min-severity": "INVALID",
        };
        return inputs[name] || "";
      });

      const config = parseConfig();

      expect(config.minSeverity).toBe("INFO");
    });
  });

  describe("maskSecrets", () => {
    it("masks the token", () => {
      const config = {
        sonarHostUrl: "https://sonar.example.com",
        sonarToken: "secret-token",
        projectKey: "my-project",
        projectKeySource: "input" as const,
        repositoryProjectKey: "test-repo",
        outputFile: "sonarqube.sarif",
        waitForProcessing: true,
        maxWaitTime: 300,
        pollingInterval: 10,
        processingDelay: 0,
        minSeverity: "INFO" as const,
        includeResolved: false,
      };

      maskSecrets(config);

      expect(core.setSecret).toHaveBeenCalledWith("secret-token");
    });

    it("masks URL if it contains credentials", () => {
      const config = {
        sonarHostUrl: "https://user@sonar.example.com",
        sonarToken: "secret-token",
        projectKey: "my-project",
        projectKeySource: "input" as const,
        repositoryProjectKey: "test-repo",
        outputFile: "sonarqube.sarif",
        waitForProcessing: true,
        maxWaitTime: 300,
        pollingInterval: 10,
        processingDelay: 0,
        minSeverity: "INFO" as const,
        includeResolved: false,
      };

      maskSecrets(config);

      expect(core.setSecret).toHaveBeenCalledWith(
        "https://user@sonar.example.com",
      );
    });
  });

  describe("SEVERITY_ORDER", () => {
    it("has correct ordering", () => {
      expect(SEVERITY_ORDER.INFO).toBeLessThan(SEVERITY_ORDER.MINOR);
      expect(SEVERITY_ORDER.MINOR).toBeLessThan(SEVERITY_ORDER.MAJOR);
      expect(SEVERITY_ORDER.MAJOR).toBeLessThan(SEVERITY_ORDER.CRITICAL);
      expect(SEVERITY_ORDER.CRITICAL).toBeLessThan(SEVERITY_ORDER.BLOCKER);
    });
  });

  describe("ConfigError", () => {
    it("includes field name", () => {
      const error = new ConfigError("Invalid value", "test-field");

      expect(error.message).toBe("Invalid value");
      expect(error.field).toBe("test-field");
      expect(error.name).toBe("ConfigError");
    });
  });
});
