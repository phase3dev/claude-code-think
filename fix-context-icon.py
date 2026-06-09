#!/usr/bin/env python3
"""
fix-context-icon.py — restore the always-visible context-usage icon in the
Claude Code VSCode extension.

ROOT CAUSE
----------
In the webview bundle (webview/index.js) the context pie indicator component
renders nothing until you have used MORE THAN 50% of the context window:

    let a = t>0 ? Math.min(e/t*100,100) : 0,   // % used   (e=usedTokens, t=contextWindow)
        l = b0e!==null ? b0e : a,
        c = 100 - l;                            // % remaining
    if (b0e===null) {
        if (t===0)   return null;               // no session yet -> hide
        if (c>=50)   return null;               // <-- BUG: >=50% remaining -> hide
    }

With the 1M context window, 50% used = 500,000 tokens, so the icon stays hidden
for virtually an entire normal session. This script flips the threshold so the
icon is visible whenever a context window is known (t>0), at any usage level.

    if(c>=50)return null   ->   if(c>=101)return null   (c maxes at 100, so never hides)

The (t===0) guard is left intact. In a resumed window, the webview can still show
a transient 0% before the first fresh response updates context metadata. After
that first response the icon stays visible.

SAFE & REVERSIBLE
-----------------
* Backs up each file once to  index.js.bak-context-icon  before editing.
* Writes through a same-directory temp file and atomic replace. Owner/group/mode
  are copied back onto the temp file before replacement, preserving root-patches
  against user-owned installs while avoiding truncate-in-place corruption.
* Idempotent: re-running detects an already-patched file and does nothing.
* No integrity/hash check exists on the webview bundle, so the edit loads fine.

USAGE
-----
    python3 fix-context-icon.py            # auto-discover & patch all installs
    python3 fix-context-icon.py --revert   # restore from backups
    python3 fix-context-icon.py /path/to/webview/index.js   # explicit target(s)

NOTE: VSCode auto-updates the extension; an update reinstalls a fresh bundle and
reverts this patch. Re-run this script after the extension updates (or wire it
into a shell startup / cron). After patching, reload the webview:
Command Palette -> "Developer: Reload Window".
"""
import glob
import os
import shutil
import sys
import tempfile

OLD = ">=50)return null}"
NEW = ">=101)return null}"
BACKUP_SUFFIX = ".bak-context-icon"

DISCOVERY_GLOBS = [
    os.path.expanduser("~/.vscode/extensions/anthropic.claude-code-*/webview/index.js"),
    os.path.expanduser("~/.vscode-server/extensions/anthropic.claude-code-*/webview/index.js"),
    os.path.expanduser("~/.vscode-insiders/extensions/anthropic.claude-code-*/webview/index.js"),
    os.path.expanduser("~/.vscode-server-insiders/extensions/anthropic.claude-code-*/webview/index.js"),
    # When run as root to patch every user's remote (vscode-server) install:
    "/home/*/.vscode-server/extensions/anthropic.claude-code-*/webview/index.js",
]


def discover():
    found = set()
    for pat in DISCOVERY_GLOBS:
        for p in glob.glob(pat):
            found.add(os.path.realpath(p))
    return sorted(found)


def write_atomic_preserving_metadata(path, text):
    """Atomic same-directory replacement that preserves owner/group/mode."""
    st = os.stat(path)
    directory = os.path.dirname(path) or "."
    basename = os.path.basename(path)
    fd, tmp = tempfile.mkstemp(prefix=f".{basename}.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        try:
            os.chown(tmp, st.st_uid, st.st_gid)
        except (AttributeError, PermissionError, OSError):
            pass
        shutil.copystat(path, tmp)
        os.replace(tmp, path)
        tmp = None
    finally:
        if tmp is not None:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass


def patch_file(path):
    with open(path, "r", encoding="utf-8", newline="") as f:
        data = f.read()
    if NEW in data:
        return "already-patched"
    n = data.count(OLD)
    if n == 0:
        return "gate-not-found (extension version changed? re-inspect FJe in index.js)"
    if n > 1:
        return f"ambiguous ({n} matches) — skipped for safety"
    backup = path + BACKUP_SUFFIX
    if not os.path.exists(backup):
        with open(backup, "w", encoding="utf-8", newline="") as b:
            b.write(data)
    write_atomic_preserving_metadata(path, data.replace(OLD, NEW, 1))
    return "PATCHED"


def revert_file(path):
    backup = path + BACKUP_SUFFIX
    if not os.path.exists(backup):
        return "no-backup"
    with open(backup, "r", encoding="utf-8", newline="") as b:
        data = b.read()
    write_atomic_preserving_metadata(path, data)
    return "REVERTED"


def main(argv):
    revert = "--revert" in argv
    explicit = [a for a in argv if not a.startswith("--")]
    targets = [os.path.realpath(p) for p in explicit] if explicit else discover()
    if not targets:
        print("No Claude Code extension webview/index.js found.")
        return 1
    action = revert_file if revert else patch_file
    print(f"{'Reverting' if revert else 'Patching'} {len(targets)} file(s):\n")
    changed = 0
    for t in targets:
        try:
            status = action(t)
        except OSError as e:
            status = f"ERROR: {e}"
        if status in ("PATCHED", "REVERTED"):
            changed += 1
        print(f"  [{status}]  {t}")
    print(f"\n{changed} file(s) changed.")
    if changed:
        print('Reload the webview to apply: Command Palette -> "Developer: Reload Window".')
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
