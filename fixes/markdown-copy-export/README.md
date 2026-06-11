# markdown-copy-export

## What it fixes

The Claude Code VS Code chat has no way to copy a whole message or the whole
conversation as Markdown (only code blocks have a copy button). This adds a
single-click copy icon (Markdown) on every user and assistant message - it flips
to a checkmark only when the copy actually lands - plus a floating "copy
conversation" icon, and a standalone CLI that exports a session transcript to
Markdown or plain text. Affects the VS Code extension webview; the CLI is
independent of it.

## Standalone usage

Webview controls (one-shot patch, re-applied automatically by the launcher):

    python3 fixes/markdown-copy-export/add-md-copy.py            # patch all installs
    python3 fixes/markdown-copy-export/add-md-copy.py --revert    # remove (reverse transform)
    python3 fixes/markdown-copy-export/add-md-copy.py /path/to/webview/index.js

Reload the window after patching (first enable may need two reloads, like
context-icon). `--revert` removes only our sentinel block, so it composes with
the context-icon patcher on the same file.

Session exporter (independent of the webview):

    python3 fixes/markdown-copy-export/cc-export.py                 # latest session -> markdown
    python3 fixes/markdown-copy-export/cc-export.py --format text
    python3 fixes/markdown-copy-export/cc-export.py --include-thinking --include-tools
    python3 fixes/markdown-copy-export/cc-export.py --session ID -o out.md

## Launcher toggle

`CC_PATCH_MD_COPY` (default `1`). `0` leaves the webview without the copy
controls and reverts ours on the next launch. `CC_WORKAROUNDS=0` reverts it too.

## Maintenance Contract

- Anchors / selectors: user bubble `[class*="userMessageContainer_"]`; assistant
  bubble `[data-testid="assistant-message"]` (NOT `[data-message-rating]` — that is
  the nested, experiment+analytics-gated rating widget, which the sanitizer strips);
  chrome strip-prefixes `toolUse_`/`toolResult_`/`toolReference_`/
  `unknownContent_` plus `[data-message-rating]` and `button`; visible
  `thinking_` summaries are content and remain copyable;
  clipboard write via a synchronous `document.execCommand("copy")` first
  (gesture-safe and works without a secure context, e.g. remote / code-server),
  falling back to `navigator.clipboard.writeText`; the icon only flips to a
  checkmark when a copy actually succeeds. Optional refinements pinned at install: the messages container and the
  single all-content wrapper, if any (see the inject source constants
  `MESSAGES_CONTAINER` / `ASSISTANT_CONTENT`). When a bundle update renames the
  bubble anchor or a chrome hook, the Phase-9 selector guard fails loudly; re-pin
  the constant and the Phase-2 fixtures together.
- Ownership marker: the sentinel block `/* cc-md-copy v1 */ ... /* /cc-md-copy v1 */`
  appended to `webview/index.js` (the IIFE) and `webview/index.css` (its styles).
- Failure mode if an anchor moves: fails safe - the controls simply do not appear
  (the IIFE no-ops; `boot()` is fully guarded). The conversation walk degrades to
  "no bubbles matched", never wrong output. The launcher patch still installs.
- Launcher registry entry: feature id `md-copy`, files `webview/index.js` +
  `webview/index.css`, apply = append the sentinel block (registered LAST, after
  context-icon), undo = marker-scoped block removal (deletes exactly its own
  OPEN..CLOSE block, keeps any bytes after CLOSE; composes regardless of ordering).
  The payload is the single source `webview-inject.{js,css}`,
  embedded into the launcher and `add-md-copy.py` by `tools/gen-embeds` (CI drift
  check: `tools/gen-embeds --check`).
- Test fixture: `tests/test_md_converter.py`, `tests/test_md_inject.py`,
  `tests/test_md_patcher.py`, `tests/test_md_export.py`, `tests/test_gen_embeds.py`,
  and the `md-copy` cases in `tests/test_reconcile.py`.
