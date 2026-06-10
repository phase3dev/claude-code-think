#!/usr/bin/env bash
# Option 2 - idempotent patch for the Claude Code VS Code extension so it forwards
# --thinking-display summarized on the (non-interactive) path it uses to spawn the
# CLI. Restores visible thinking summaries on Opus 4.7 / 4.8.
#
# For Linux / macOS (and WSL / Git Bash on Windows). On native Windows without a
# bash shell, apply the one-line edit by hand - see the README ("Option 2").
#
# Usage:
#   ./patch-extension.sh            # patch every extension.js found (backs up first)
#   ./patch-extension.sh --revert   # restore the most recent .bak for each
#   ./patch-extension.sh --dry-run  # show what would change, touch nothing
#
# Re-run after every extension update (the install dir is replaced on upgrade).
# A VS Code window reload is required for changes to take effect.
set -euo pipefail

MODE="${1:-patch}"

# Where VS Code / Cursor / code-server keep extensions across platforms.
BASE_DIRS=(
  "$HOME/.vscode/extensions"
  "$HOME/.vscode-server/extensions"
  "$HOME/.vscode-insiders/extensions"
  "$HOME/.cursor/extensions"
  "$HOME/.local/share/code-server/extensions"
  "$HOME/.config/Code/User/extensions"
)

TARGETS=()
while IFS= read -r target; do
  TARGETS+=("$target")
done < <(
  for b in "${BASE_DIRS[@]}"; do
    [ -d "$b" ] || continue
    # Match any arch/platform build (e.g. -linux-x64, -darwin-arm64, -win32-x64).
    find "$b" -maxdepth 2 -type f -name extension.js -path '*anthropic.claude-code-*' 2>/dev/null
  done | sort -u
)

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "No anthropic.claude-code extension.js found under known base dirs." >&2
  echo "If your editor stores extensions elsewhere, edit BASE_DIRS in this script." >&2
  exit 1
fi

python3 - "$MODE" "${TARGETS[@]}" <<'PY'
import sys, time, glob, os, re

mode = sys.argv[1]
targets = sys.argv[2:]

# The extension is minified, and the array variable that collects CLI flags is
# named differently across builds (B in 2.0.x, q in 2.1.16x, ...). Match it with
# a capture group instead of a fixed literal so the patch survives the rename.
PAT = re.compile(
    r'if\(l\.type!=="disabled"&&l\.display\)([A-Za-z_$][\w$]*)\.push\("--thinking-display",l\.display\)'
)
# Already-patched form (gate dropped, default added), any variable name.
PATCHED = re.compile(
    r'if\(l\.type!=="disabled"\)([A-Za-z_$][\w$]*)\.push\("--thinking-display",l\.display\|\|"summarized"\)'
)

def patched_form(m):
    var = m.group(1)
    return f'if(l.type!=="disabled"){var}.push("--thinking-display",l.display||"summarized")'

def revert(path):
    baks = sorted(glob.glob(path + ".bak.*"))
    if not baks:
        print(f"  [skip] no backup for {path}")
        return
    latest = baks[-1]
    data = open(latest, "rb").read()
    open(path, "wb").write(data)
    print(f"  [revert] restored {path}\n           from {os.path.basename(latest)}")

for path in targets:
    print(path)
    src = open(path, "r", encoding="utf-8", errors="surrogatepass").read()

    if mode == "--revert":
        revert(path)
        continue

    if PATCHED.search(src):
        print("  [skip] already patched")
        continue
    count = len(PAT.findall(src))
    if count == 0:
        print("  [skip] target string not found (extension layout changed?) "
              "- inspect manually before patching")
        continue

    if mode == "--dry-run":
        print(f"  [dry-run] would replace {count} occurrence(s)")
        continue

    bak = f"{path}.bak.{int(time.time())}"
    open(bak, "w", encoding="utf-8", errors="surrogatepass").write(src)
    patched = PAT.sub(patched_form, src)
    open(path, "w", encoding="utf-8", errors="surrogatepass").write(patched)
    print(f"  [ok] patched {count} occurrence(s); backup: {os.path.basename(bak)}")

if mode not in ("--revert", "--dry-run"):
    print("\nDone. Reload the VS Code window (Cmd/Ctrl+Shift+P -> 'Reload Window') "
          "to load the patched extension.")
PY
