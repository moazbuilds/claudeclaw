import { test, expect } from "bun:test";
import { isAllowed, isDiscordAuthorized } from "../src/allowlist";

test("empty allowlist denies everything", () => {
  expect(isAllowed(123, [])).toBe(false);
});
test("missing userId denied", () => {
  expect(isAllowed(undefined, [123])).toBe(false);
});
test("allowlisted user permitted", () => {
  expect(isAllowed(123, [123, 456])).toBe(true);
});

// --- isDiscordAuthorized ---

test("global allowlist grants access in DMs", () => {
  expect(isDiscordAuthorized("u1", false, "chan1", ["u1"], undefined)).toBe(true);
});
test("global allowlist grants access in any guild channel", () => {
  expect(isDiscordAuthorized("u1", true, "chan1", ["u1"], { chan2: ["u1"] })).toBe(true);
});
test("channel-scoped user is authorized in their listed channel", () => {
  expect(isDiscordAuthorized("u2", true, "chan1", [], { chan1: ["u2"] })).toBe(true);
});
test("channel-scoped user is NOT authorized in a different channel", () => {
  expect(isDiscordAuthorized("u2", true, "chan2", [], { chan1: ["u2"] })).toBe(false);
});
test("channel-scoped user is NOT authorized via DM even for their allowed channel's ID", () => {
  expect(isDiscordAuthorized("u2", false, "chan1", [], { chan1: ["u2"] })).toBe(false);
});
test("unlisted user is denied everywhere", () => {
  expect(isDiscordAuthorized("u3", true, "chan1", ["u1"], { chan1: ["u2"] })).toBe(false);
  expect(isDiscordAuthorized("u3", false, "chan1", ["u1"], { chan1: ["u2"] })).toBe(false);
});
test("missing channelAllowedUserIds config does not throw", () => {
  expect(isDiscordAuthorized("u1", true, "chan1", [], undefined)).toBe(false);
});
