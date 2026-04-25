import { describe, expect, it } from "bun:test";
import { extractErrorDetail } from "./messaging";

describe("extractErrorDetail", () => {
  it("prefers stderr when present", () => {
    expect(
      extractErrorDetail({
        stdout: '{"is_error":true,"result":"Not logged in · Please run /login"}',
        stderr: "Permission denied",
      })
    ).toBe("Permission denied");
  });

  it("extracts the result field from JSON stdout errors", () => {
    expect(
      extractErrorDetail({
        stdout: '{"is_error":true,"result":"Not logged in · Please run /login"}',
        stderr: "",
      })
    ).toBe("Not logged in · Please run /login");
  });

  it("falls back to raw stdout when stdout is not JSON", () => {
    expect(
      extractErrorDetail({
        stdout: "Quota exceeded",
        stderr: "",
      })
    ).toBe("Quota exceeded");
  });
});
