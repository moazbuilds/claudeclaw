---
name: learn
description: Review reaction-based training data and propose feedback memory entries. Use when the user asks to "review reactions", "learn from reactions", "what did I react to", "process feedback", or runs /claudeclaw:learn. Walks the user through recent positive and negative reactions on Discord and proposes MEMORY.md feedback entries that the user approves before they get written.
---

# Learn from reactions

ClaudeClaw's Discord runtime captures every emoji reaction on bot messages as
training signal. Positive reactions ("good response, do more of this") and
negative reactions ("bad response, don't do this") are logged separately from
the bot's responses themselves. This skill joins them and turns the patterns
into long-lived feedback memory.

## Files involved

- `.claude/claudeclaw/training/responses.jsonl` — every bot reply, with the
  prompt that triggered it and the response text
- `.claude/claudeclaw/training/reactions.jsonl` — every classifiable reaction
  (positive or negative) the user added to a bot message
- `.claude/claudeclaw/training/last-review.txt` — ISO timestamp of the last
  review pass; reactions older than this are skipped on subsequent runs

## Procedure

1. **Read both logs.** Parse line-by-line JSON. Skip malformed lines silently.
   If `reactions.jsonl` does not exist or is empty, tell the user there is
   nothing to review and stop.

2. **Filter to new reactions.** If `last-review.txt` exists, drop any reaction
   record whose `timestamp` is `<=` that timestamp. The first run reviews
   everything.

3. **Join.** For each remaining reaction, find the matching response by
   `messageId`. If no response is found (likely because it predates training
   capture, or the log was rotated), fall back to summarizing only the
   reaction's emoji + sentiment.

4. **Group and summarize.** Cluster the joined records by sentiment. For each
   group, look for patterns — recurring topics, response styles, lengths,
   formats. A single negative reaction is data; three negatives on similar
   responses is a rule worth saving.

5. **Propose feedback memories.** For each pattern strong enough to act on,
   draft a feedback memory in the standard format (rule, **Why:**, **How to
   apply:**). Show each draft to the user one at a time and ask whether to
   save it. Do NOT batch-write. The user must approve each entry.

   Use the Skill tool to invoke memory-writing per the auto-memory section of
   the project CLAUDE.md (write the file under
   `C:\Users\xMFdo\.claude\projects\C--Users-xMFdo--openclaw\memory\` and add
   a one-line pointer to `MEMORY.md`).

6. **Update last-review.txt.** Once the user is done reviewing (or skips), write
   the current ISO timestamp to `.claude/claudeclaw/training/last-review.txt`
   so the next run only sees new reactions.

## Style notes

- Keep the review conversational and brief — Adam prefers short replies.
- One pattern at a time. Don't dump a wall of proposed memories.
- If a pattern isn't load-bearing, say so and skip it. Not every reaction
  needs to become a memory; isolated reactions can just be noise.
- If there are zero new reactions since last review, say so in one line and
  stop. Don't pad.
