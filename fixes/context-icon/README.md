# context-icon

## What it fixes

Restores the always-visible context-usage icon in the VS Code chat input.
Extension builds 2.1.165+ hide that icon until you have used more than 50% of the
context window. With the 1M context window that is ~500k tokens, so it is
effectively never shown. This fix removes the startup hide guard and flips the
threshold so the icon renders at any usage level, including the reload gap before
fresh usage data arrives.

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

- Anchors / selectors: `if(<id>===0)return null;if(<id>>=50)return null}`
  (component `FJe` in `webview/index.js`). The identifier names are captured, not
  hardcoded.
- Ownership marker: `/*ccwa-context-icon:<first-var>:<remaining-var>*/`. Apply
  rewrites the combined guard to `if(<remaining-var>>=101)return null}<marker>`;
  undo uses the marker metadata to restore the pristine combined guard with the
  same variable names. Older `/*ccwa-context-icon*/` markers are recognized as
  legacy fingerprints.
- Failure mode if an anchor moves: if the guard shape changes, apply no-ops with a
  one-line warning (the icon goes missing again) until the anchor is updated.
- Launcher registry entry: feature id `context-icon`, file `webview/index.js`,
  apply = marked swap, undo = reverse of the marked form only.
- Test fixture: `tests/test_reconcile.py` (launcher engine, both platforms) and
  `tests/test_regressions.py::PatcherRegressionTests` (standalone patcher).
