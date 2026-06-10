#!/usr/bin/env bash
# A/B test: does Opus 4.8 return populated thinking summaries with
# --thinking-display summarized vs. relying on the showThinkingSummaries setting?
# Sends 2 small live requests through your logged-in account (uses tokens).
#
# Expected on Opus 4.7 / 4.8: run A (flag) is populated, run B (no flag) is empty.
set -euo pipefail

CLAUDE="${CLAUDE_REAL_BIN:-$(command -v claude 2>/dev/null || echo "$HOME/.local/bin/claude")}"
[ -x "$CLAUDE" ] || { echo "could not find 'claude'; set CLAUDE_REAL_BIN" >&2; exit 1; }

PROMPT='If all Bloops are Razzies, and all Razzies are Lazzies, are all Bloops necessarily Lazzies? Reason through it carefully step by step, then give a one-word answer.'
A_JSONL="$(mktemp "${TMPDIR:-/tmp}/cc-thinking-a.XXXXXX")"
B_JSONL="$(mktemp "${TMPDIR:-/tmp}/cc-thinking-b.XXXXXX")"
cleanup() {
  rm -f "$A_JSONL" "$B_JSONL"
}
trap cleanup EXIT

run_with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
  else
    "$@"
  fi
}

inspect() { # $1 = jsonl file
python3 - "$1" <<'PY'
import json, sys
found=False
for ln in open(sys.argv[1]):
    ln=ln.strip()
    if not ln: continue
    try: ev=json.loads(ln)
    except: continue
    msg=ev.get('message') or ev
    content=msg.get('content') if isinstance(msg,dict) else None
    if isinstance(content,list):
        for b in content:
            if isinstance(b,dict) and b.get('type')=='thinking':
                t=b.get('thinking',''); found=True
                print(f"  THINKING len={len(t)}  preview={t[:80]!r}")
            elif isinstance(b,dict) and b.get('type')=='text':
                print(f"  TEXT     len={len(b.get('text',''))}")
if not found: print("  (no thinking block emitted)")
PY
}

echo "### A: --thinking-display summarized"
run_with_timeout 150 "$CLAUDE" -p "$PROMPT" --model opus --thinking-display summarized \
  --output-format stream-json --verbose --max-turns 1 </dev/null >"$A_JSONL" 2>/dev/null
inspect "$A_JSONL"

echo "### B: no flag (relies on showThinkingSummaries setting)"
run_with_timeout 150 "$CLAUDE" -p "$PROMPT" --model opus \
  --output-format stream-json --verbose --max-turns 1 </dev/null >"$B_JSONL" 2>/dev/null
inspect "$B_JSONL"

echo
echo "Expected: A populated (len>0), B empty (len=0) on Opus 4.7 / 4.8."
