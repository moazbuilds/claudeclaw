import { describe, test, expect } from "bun:test";
import { isAuthError } from "./auth-guard";

describe("isAuthError", () => {
  const positives = [
    "Error: 401 Unauthorized",
    "Invalid API key provided",
    "Invalid x-api-key header",
    "Please run /login to authenticate",
    "authentication_error: token has expired",
    "Your credit balance is too low to access the Claude API",
    "not authenticated — please log in",
  ];

  for (const text of positives) {
    test(`flags: "${text}"`, () => {
      expect(isAuthError(text)).toBe(true);
    });
  }

  const negatives = [
    "you've hit your limit for this session",
    "Claude session timed out after 300s",
    "ENOENT: no such file or directory",
    "",
    "the todo list has 3 items",
  ];

  for (const text of negatives) {
    test(`ignores: "${text}"`, () => {
      expect(isAuthError(text)).toBe(false);
    });
  }
});
