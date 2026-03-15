import { describe, it, expect } from "vitest";
import {
  SonarQubeError,
  createHttpError,
  createConnectionError,
  createValidationError,
} from "../src/errors";

describe("errors", () => {
  describe("SonarQubeError", () => {
    it("creates error with all properties", () => {
      const error = new SonarQubeError("Test error", "TEST_CODE", 404, {
        extra: "data",
      });

      expect(error.message).toBe("Test error");
      expect(error.code).toBe("TEST_CODE");
      expect(error.statusCode).toBe(404);
      expect(error.details).toEqual({ extra: "data" });
      expect(error.name).toBe("SonarQubeError");
    });

    it("provides suggestion for AUTH_FAILED", () => {
      const error = new SonarQubeError("Auth failed", "AUTH_FAILED");

      expect(error.getSuggestion()).toContain("SONAR_TOKEN");
    });

    it("provides suggestion for PROJECT_NOT_FOUND", () => {
      const error = new SonarQubeError("Not found", "PROJECT_NOT_FOUND");

      expect(error.getSuggestion()).toContain("project-key");
    });

    it("provides suggestion for PERMISSION_DENIED", () => {
      const error = new SonarQubeError("Forbidden", "PERMISSION_DENIED");

      expect(error.getSuggestion()).toContain("Browse");
    });

    it("provides suggestion for RATE_LIMITED", () => {
      const error = new SonarQubeError("Too many requests", "RATE_LIMITED");

      expect(error.getSuggestion()).toContain("polling-interval");
    });

    it("provides suggestion for CONNECTION_FAILED", () => {
      const error = new SonarQubeError(
        "Connection failed",
        "CONNECTION_FAILED",
      );

      expect(error.getSuggestion()).toContain("sonar-host-url");
    });

    it("provides suggestion for TIMEOUT", () => {
      const error = new SonarQubeError("Timeout", "TIMEOUT");

      expect(error.getSuggestion()).toContain("max-wait-time");
    });

    it("provides generic suggestion for unknown code", () => {
      const error = new SonarQubeError("Unknown", "UNKNOWN_CODE");

      expect(error.getSuggestion()).toContain("server logs");
    });
  });

  describe("createHttpError", () => {
    it("creates AUTH_FAILED for 401", () => {
      const error = createHttpError(401, "Unauthorized");

      expect(error.code).toBe("AUTH_FAILED");
      expect(error.statusCode).toBe(401);
      expect(error.message).toContain("Authentication failed");
    });

    it("creates PERMISSION_DENIED for 403", () => {
      const error = createHttpError(403, "Forbidden");

      expect(error.code).toBe("PERMISSION_DENIED");
      expect(error.statusCode).toBe(403);
    });

    it("creates PROJECT_NOT_FOUND for 404", () => {
      const error = createHttpError(404, "Not found");

      expect(error.code).toBe("PROJECT_NOT_FOUND");
      expect(error.statusCode).toBe(404);
    });

    it("creates RATE_LIMITED for 429", () => {
      const error = createHttpError(429, "Too many requests");

      expect(error.code).toBe("RATE_LIMITED");
      expect(error.statusCode).toBe(429);
    });

    it("creates HTTP_ERROR for unknown status", () => {
      const error = createHttpError(500, "Server error");

      expect(error.code).toBe("HTTP_ERROR");
      expect(error.statusCode).toBe(500);
      expect(error.message).toContain("HTTP error 500");
    });

    it("includes details in error", () => {
      const details = { response: "data" };
      const error = createHttpError(400, "Bad request", details);

      expect(error.details).toEqual(details);
    });
  });

  describe("createConnectionError", () => {
    it("creates CONNECTION_FAILED error", () => {
      const error = createConnectionError("Cannot connect to server");

      expect(error.code).toBe("CONNECTION_FAILED");
      expect(error.message).toContain("Connection failed");
      expect(error.message).toContain("Cannot connect to server");
    });

    it("includes cause message in details", () => {
      const cause = new Error("ECONNREFUSED");
      const error = createConnectionError("Connection refused", cause);

      expect(error.details).toBe("ECONNREFUSED");
    });
  });

  describe("createValidationError", () => {
    it("creates INVALID_RESPONSE error", () => {
      const error = createValidationError("Unexpected format");

      expect(error.code).toBe("INVALID_RESPONSE");
      expect(error.message).toBe("Unexpected format");
    });

    it("includes details", () => {
      const error = createValidationError("Bad data", { received: "garbage" });

      expect(error.details).toEqual({ received: "garbage" });
    });
  });
});
