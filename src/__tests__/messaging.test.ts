import { describe, test, expect } from "bun:test";
import { extractErrorDetail } from "../messaging";

describe("extractErrorDetail", () => {
  test("prefers stderr over stdout", () => {
    expect(extractErrorDetail({ stdout: "some output", stderr: "auth error" })).toBe("auth error");
  });

  test("parses JSON stdout error when stderr is empty", () => {
    const stdout = JSON.stringify({ is_error: true, result: "Rate limit exceeded" });
    expect(extractErrorDetail({ stdout, stderr: "" })).toBe("Rate limit exceeded");
  });

  test("falls back to raw stdout when not JSON and no stderr", () => {
    expect(extractErrorDetail({ stdout: "plain error text", stderr: "" })).toBe("plain error text");
  });
});
