#!/bin/bash
# Installs Scrapling and its browser so the scrapling-official skill works in cloud sessions.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

VENV="$HOME/scrapling-venv"

if [ ! -x "$VENV/bin/scrapling" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q "scrapling[all]>=0.5"
fi

# Browser download is slow, so only do it once per container.
if [ ! -f "$VENV/.browser-installed" ]; then
  "$VENV/bin/scrapling" install --force
  touch "$VENV/.browser-installed"
fi

if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  echo "export PATH=\"$VENV/bin:\$PATH\"" >> "$CLAUDE_ENV_FILE"
fi
