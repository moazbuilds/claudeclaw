#!/usr/bin/env bash
# claw-state-handoff.sh — ClaudeClaw UserPromptSubmit hook
# Proactively resets session at TURN_RESET_THRESHOLD turns.
# Wire in ~/.claude/settings.json under hooks.UserPromptSubmit.
set -euo pipefail

PROJECT_DIR="${CLAUDECLAW_PROJECT_DIR:-$PWD}"
CLAW_SESSION="$PROJECT_DIR/.claude/claudeclaw/session.json"
OUTPUT_FILE="$PROJECT_DIR/PRIOR_SESSION_STATE.md"
TURN_RESET_THRESHOLD="${CLAUDECLAW_TURN_THRESHOLD:-40}"

if [ ! -f "$CLAW_SESSION" ]; then exit 0; fi

SESSION_ID=$(jq -r '.sessionId // ""' "$CLAW_SESSION" 2>/dev/null || echo "")
TURN_COUNT=$(jq -r '.turnCount // 0' "$CLAW_SESSION" 2>/dev/null || echo "0")
CREATED_AT=$(jq -r '.createdAt // "unknown"' "$CLAW_SESSION" 2>/dev/null || echo "unknown")
COMPACT_WARNED=$(jq -r '.compactWarned // false' "$CLAW_SESSION" 2>/dev/null || echo "false")

if [ -z "$SESSION_ID" ] || [ "$SESSION_ID" = "null" ]; then exit 0; fi
if [ "$TURN_COUNT" -lt "$TURN_RESET_THRESHOLD" ]; then exit 0; fi

echo "[claw-state-handoff] Turn $TURN_COUNT >= $TURN_RESET_THRESHOLD — writing handoff + resetting"

cat > "$OUTPUT_FILE" << STATEEOF
# Claw Prior Session State — Handoff
**Generated:** $(date -u +"%Y-%m-%dT%H:%M:%SZ")
**Reason:** Turn count $TURN_COUNT reached threshold ($TURN_RESET_THRESHOLD) — proactive reset
**Session:** $SESSION_ID | **Created:** $CREATED_AT | **CompactWarned:** $COMPACT_WARNED
---
## Instructions for Claude on Next Session Start
This is a planned handoff. No work was lost.
1. Read CLAUDE.md
2. Read MEMORY.md
3. Fill in Active Work Summary and Key Facts below
4. Tell the user you have resumed and state what was in progress
5. Delete this file after reading (it is consumed, not persistent)
## Active Work Summary
*(Claude: fill this in when you read this file)*
## Key Facts to Carry Forward
*(Claude: record decisions, configs, context that should survive the reset)*
STATEEOF

echo "[claw-state-handoff] Wrote PRIOR_SESSION_STATE.md"
echo '{"sessionId":null,"createdAt":null,"lastUsedAt":null,"turnCount":0,"compactWarned":false}' > "$CLAW_SESSION"
echo "[claw-state-handoff] Session reset — next message starts fresh"
