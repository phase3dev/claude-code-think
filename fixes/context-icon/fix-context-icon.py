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
for virtually an entire normal session. This script removes the startup guard and
flips the threshold so the icon stays visible across reload gaps and then
self-corrects when fresh usage data arrives.

    if(t===0)return null;if(c>=50)return null}
        -> if(c>=101)return null}/*ccwa-context-icon:t:c*/   (marked; c maxes at 100)

The minified variable names are not stable across builds; the patcher matches the
guard shape with any ASCII JS identifier pair and stores the matched names in the
marker so undo can restore the same pristine names.

In a resumed window, the webview can still show a transient 0% before the first
fresh response updates context metadata. After that first response the icon
corrects.

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
import re
import shutil
import sys
import tempfile

IDENT = r"[A-Za-z_$][A-Za-z0-9_$]*"
OLD_RE = re.compile(rf"if\(({IDENT})===0\)return null;if\(({IDENT})>=50\)return null\}}")
MARKED_RE = re.compile(
    rf"if\(({IDENT})>=101\)return null\}}/\*ccwa-context-icon:({IDENT}):\1\*/"
)
# Legacy bare (metadata-less) marker on arbitrary guard names: an older
# var-agnostic write could leave the both-guards >=101 form + bare marker on a
# non-t/c build (e.g. Z/U). Recognize it by shape, not the fixed t/c.
LEGACY_NEW_RE = re.compile(
    rf"if\(({IDENT})===0\)return null;if\(({IDENT})>=101\)return null\}}/\*ccwa-context-icon\*/"
)
# Strip any leftover bare marker so patch_file (which only re-applies on the
# pristine guard pair) is never wedged by an unrecognized bare-marked form.
ORPHAN_MARKER_RE = re.compile(r"\)return null\}/\*ccwa-context-icon\*/")
OLD = "if(t===0)return null;if(c>=50)return null}"
NEW_BARE = "if(c>=101)return null}"
NEW_LEGACY = NEW_BARE + "/*ccwa-context-icon*/"
NEW = "if(c>=101)return null}/*ccwa-context-icon:t:c*/"
LEGACY_BARE = "if(t===0)return null;if(c>=101)return null}"
BACKUP_SUFFIX = ".bak-context-icon"


def old_guard(first_var, remaining_var):
    return f"if({first_var}===0)return null;if({remaining_var}>=50)return null}}"


def marked_guard(first_var, remaining_var):
    return (
        f"if({remaining_var}>=101)return null}}"
        f"/*ccwa-context-icon:{first_var}:{remaining_var}*/"
    )


def undo_known_patches(data):
    data = MARKED_RE.sub(lambda m: old_guard(m.group(2), m.group(1)), data)
    data = LEGACY_NEW_RE.sub(lambda m: old_guard(m.group(1), m.group(2)), data)
    data = (
        data.replace(NEW_LEGACY, OLD)
        .replace(LEGACY_BARE, OLD)
        .replace(NEW_BARE, OLD)
    )
    return ORPHAN_MARKER_RE.sub(")return null}", data)

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
    if MARKED_RE.search(data):
        return "already-patched"
    data = undo_known_patches(data)
    matches = list(OLD_RE.finditer(data))
    n = len(matches)
    if n == 0:
        return "gate-not-found (extension version changed? re-inspect FJe in index.js)"
    if n > 1:
        return f"ambiguous ({n} matches) — skipped for safety"
    match = matches[0]
    patched = data[: match.start()] + marked_guard(match.group(1), match.group(2)) + data[match.end() :]
    backup = path + BACKUP_SUFFIX
    if not os.path.exists(backup):
        with open(backup, "w", encoding="utf-8", newline="") as b:
            b.write(data)
    write_atomic_preserving_metadata(path, patched)
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
