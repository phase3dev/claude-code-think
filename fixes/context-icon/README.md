# context-icon

## What it fixes

Restores the always-visible context-usage icon in the VS Code chat input.
Extension builds 2.1.165+ hide that icon until you have used more than 50% of the
context window. With the 1M context window that is ~500k tokens, so it is
effectively never shown. This fix flips the threshold so the icon renders
whenever a context window is known, at any usage level.

## Standalone usage

```
python3 fixes/context-icon/fix-context-icon.py            # auto-discover & patch all installs
python3 fixes/context-icon/fix-context-icon.py --revert   # restore from .bak-context-icon
python3 fixes/context-icon/fix-context-icon.py /path/to/webview/index.js   # explicit target(s)
```

The patch is idempotent and atomic (same-directory temp + replace, owner/group/
mode preserved). VS Code auto-updates the extension and an update reinstalls a
fresh bundle, so re-run after updates (or use the launcher, which re-applies on
every launch). After patching, reload the webview: Command Palette ->
"Developer: Reload Window".

## Launcher toggle

`CC_PATCH_CONTEXT_ICON` (default `1`). `0` leaves the icon unpatched, and the
launcher reverts our edit on the next launch.

## Maintenance Contract

- Anchors / selectors: `>=50)return null}` (component `FJe` in `webview/index.js`).
- Ownership marker: `/*ccwa-context-icon*/`. Apply rewrites `>=50)return null}` ->
  `>=101)return null}/*ccwa-context-icon*/`; undo reverses only that marked form.
- Failure mode if an anchor moves: if the anchor string changes, apply no-ops with
  a one-line warning (the icon goes missing again) until the anchor is updated. A
  bare upstream `>=101)return null}` with no marker is never touched.
- Launcher registry entry: feature id `context-icon`, file `webview/index.js`,
  apply = marked swap, undo = reverse of the marked form only.
- Test fixture: `tests/test_reconcile.py` (launcher engine, both platforms) and
  `tests/test_regressions.py::PatcherRegressionTests` (standalone patcher).
