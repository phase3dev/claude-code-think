#!/usr/bin/env bash
# claude-think.sh - minimal CLI-only variant of the launcher fix.
#
# Runs the real `claude` with `--thinking-display summarized` so headless / `-p`
# / SDK invocations return populated thinking summaries on Opus 4.7 / 4.8. Unlike
# `claudemax`, it sets NO environment of its own; it only adds the flag. The
# interactive TUI already honors the showThinkingSummaries setting, so it needs
# nothing.
#
# Most people should use `claudemax` instead (it covers VS Code too). This file
# exists for pure CLI/SDK users who want the smallest possible wrapper.
#
# Install (optional): symlink onto PATH, e.g.
#   ln -s "$(pwd)/claude-think.sh" ~/.local/bin/claude-think
# then use `claude-think -p "..."` exactly like `claude`.
set -euo pipefail

# Resolve the real claude, never calling this wrapper if it's on PATH as claude.
self="$(readlink -f "$0" 2>/dev/null || echo "$0")"
REAL_CLAUDE="${CLAUDE_REAL_BIN:-}"
if [ -z "$REAL_CLAUDE" ]; then
  for c in \
      "$HOME/.local/bin/claude" \
      /usr/local/bin/claude \
      /usr/bin/claude \
      /opt/homebrew/bin/claude \
      "$(command -v claude 2>/dev/null || true)"; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    [ "$(readlink -f "$c" 2>/dev/null || echo "$c")" = "$self" ] && continue
    REAL_CLAUDE="$c"; break
  done
fi
[ -n "$REAL_CLAUDE" ] || { echo "could not locate the real 'claude' binary; set CLAUDE_REAL_BIN" >&2; exit 1; }

# Don't double-inject if the flag is already present.
for a in "$@"; do
  [ "$a" = "--thinking-display" ] && exec "$REAL_CLAUDE" "$@"
done

exec "$REAL_CLAUDE" --thinking-display summarized "$@"
