import { test, expect } from "bun:test";

function isAllowed(userId: number | undefined, allowed: number[]): boolean {
  return !!userId && allowed.length > 0 && allowed.includes(userId);
}

test("empty allowlist denies everything", () => {
  expect(isAllowed(123, [])).toBe(false);
});
test("missing userId denied", () => {
  expect(isAllowed(undefined, [123])).toBe(false);
});
test("allowlisted user permitted", () => {
  expect(isAllowed(123, [123, 456])).toBe(true);
});
