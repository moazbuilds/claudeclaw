#!/usr/bin/env bash
# claw-pre-compact.sh — ClaudeClaw PreCompact hook
# Saves session context to PRIOR_SESSION_STATE.md and resets session.json.
# Wire in ~/.claude/settings.json under hooks.PreCompact.
set -euo pipefail

PROJECT_DIR="${CLAUDECLAW_PROJECT_DIR:-$PWD}"
CLAW_SESSION="$PROJECT_DIR/.claude/claudeclaw/session.json"
OUTPUT_FILE="$PROJECT_DIR/PRIOR_SESSION_STATE.md"

SESSION_ID="" ; TURN_COUNT=0 ; CREATED_AT="unknown"
if [ -f "$CLAW_SESSION" ]; then
  SESSION_ID=$(jq -r '.sessionId // ""' "$CLAW_SESSION" 2>/dev/null || echo "")
  TURN_COUNT=$(jq -r '.turnCount // 0' "$CLAW_SESSION" 2>/dev/null || echo "0")
  CREATED_AT=$(jq -r '.createdAt // "unknown"' "$CLAW_SESSION" 2>/dev/null || echo "unknown")
fi

cat > "$OUTPUT_FILE" << STATEEOF
# Claw Prior Session State — Compact Handoff
**Generated:** $(date -u +"%Y-%m-%dT%H:%M:%SZ")
**Reason:** /compact ran
**Session:** $SESSION_ID | **Turns:** $TURN_COUNT | **Created:** $CREATED_AT
---
## Instructions for Claude on Next Session Start
Read CLAUDE.md and MEMORY.md. Summarise what was in progress and confirm resumption.
## Active Work Summary
*(Claude: fill in from compact summary)*
## Key Facts to Carry Forward
*(Claude: record critical context)*
STATEEOF

echo "[claw-pre-compact] Wrote PRIOR_SESSION_STATE.md"

if [ -f "$CLAW_SESSION" ]; then
  echo '{"sessionId":null,"createdAt":null,"lastUsedAt":null,"turnCount":0,"compactWarned":false}' > "$CLAW_SESSION"
  echo "[claw-pre-compact] Session reset"
fi
