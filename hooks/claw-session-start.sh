#!/usr/bin/env bash
# claw-session-start.sh — ClaudeClaw SessionStart hook
# Injects orientation context at the start of every session.
# Wire in ~/.claude/settings.json under hooks.SessionStart.
set -euo pipefail

PROJECT_DIR="${CLAUDECLAW_PROJECT_DIR:-$PWD}"

# Locate prompts/ relative to this script (hooks/ sits next to prompts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAW_PROMPTS="${CLAUDECLAW_INSTALL_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}/prompts"

PRIOR_STATE="$PROJECT_DIR/PRIOR_SESSION_STATE.md"

# Exit silently if prompts dir doesn't exist (non-Claw install)
if [ ! -d "$CLAW_PROMPTS" ]; then
  exit 0
fi

echo "CLAW SESSION START — read these files before anything else:"
echo ""
echo "1. $CLAW_PROMPTS/IDENTITY.md"
echo "2. $CLAW_PROMPTS/USER.md"
echo "3. $CLAW_PROMPTS/SOUL.md"
echo "4. $PROJECT_DIR/CLAUDE.md"

if [ -f "$PRIOR_STATE" ]; then
  echo ""
  echo "*** PRIOR SESSION HANDOFF — read this before IDENTITY/USER/SOUL: $PRIOR_STATE ***"
fi

echo ""
echo "Read MEMORY.md if present in the project directory."
echo "Confirm ready and state what was in progress (if resuming)."
