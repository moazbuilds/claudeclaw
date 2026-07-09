import { describe, test, expect } from "bun:test";
import { extractReactionDirective } from "./commands/discord";

describe("extractReactionDirective", () => {
  test("returns null emoji and cleaned text when no directive present", () => {
    const { cleanedText, reactionEmoji } = extractReactionDirective("hey friend");
    expect(reactionEmoji).toBeNull();
    expect(cleanedText).toBe("hey friend");
  });

  test("extracts a single unicode emoji and strips the directive", () => {
    const { cleanedText, reactionEmoji } = extractReactionDirective("nice [react:⚡] friend");
    expect(reactionEmoji).toBe("⚡");
    expect(cleanedText).toBe("nice  friend");
  });

  test("first directive wins when multiple are present", () => {
    const { cleanedText, reactionEmoji } = extractReactionDirective("[react:⚡] then [react:🔥] end");
    expect(reactionEmoji).toBe("⚡");
    expect(cleanedText).toBe("then  end");
  });

  test("empty directive does not match the regex and is left in place", () => {
    const { cleanedText, reactionEmoji } = extractReactionDirective("ok [react:] [react:👍] done");
    expect(reactionEmoji).toBe("👍");
    expect(cleanedText).toBe("ok [react:]  done");
  });

  test("does not match across newlines", () => {
    const { cleanedText, reactionEmoji } = extractReactionDirective("line1 [react:\nbroken] line2");
    expect(reactionEmoji).toBeNull();
    expect(cleanedText).toBe("line1 [react:\nbroken] line2");
  });

  test("collapses trailing spaces on stripped lines and extra blank lines", () => {
    const input = "first [react:⚡]\n\n\nsecond";
    const { cleanedText, reactionEmoji } = extractReactionDirective(input);
    expect(reactionEmoji).toBe("⚡");
    expect(cleanedText).toBe("first\n\nsecond");
  });

  test("trims surrounding whitespace from the cleaned result", () => {
    const { cleanedText, reactionEmoji } = extractReactionDirective("   [react:🦞]   ");
    expect(reactionEmoji).toBe("🦞");
    expect(cleanedText).toBe("");
  });

  test("trims whitespace inside the directive value", () => {
    const { cleanedText, reactionEmoji } = extractReactionDirective("yo [react:  ⚡  ]");
    expect(reactionEmoji).toBe("⚡");
    expect(cleanedText).toBe("yo");
  });

  test("case-insensitive directive tag", () => {
    const { cleanedText, reactionEmoji } = extractReactionDirective("hi [REACT:⚡]");
    expect(reactionEmoji).toBe("⚡");
    expect(cleanedText).toBe("hi");
  });
});
