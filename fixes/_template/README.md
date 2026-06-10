# <fix-name>

> Copy this folder to `fixes/<fix-name>/` to start a new fix.

## What it fixes

<symptom the user sees, and where (VS Code extension / headless / SDK)>

## Standalone usage

<the one-shot tool in this folder, with example commands and --revert>

## Launcher toggle

<the CC_PATCH_<NAME> env var, default, and what 0 does>

## Maintenance Contract

- Anchors / selectors: <exact stable string(s) or class prefixes this fix keys off>
- Ownership marker: <the sentinel/marker this fix's apply embeds, e.g. `/* cc-<name> v1 */`>
- Failure mode if an anchor moves: <what happens - must fail safe / no-op, never corrupt>
- Launcher registry entry: <feature id, the file(s) it touches, apply/undo summary>
- Test fixture: <the test(s) in tests/ that cover this fix>
