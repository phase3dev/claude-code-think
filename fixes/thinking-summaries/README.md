# thinking-summaries

## What it fixes

Restores extended-thinking summaries on Opus 4.7 / 4.8, where the "Thinking"
section otherwise renders empty in the VS Code extension and in headless `-p` /
SDK runs. The fix injects `--thinking-display summarized` into the launch args -
the one lever that is not interactivity-gated. It edits no files.

## Standalone usage

The launcher (option 1) is what most people want. These standalone tools cover
the other delivery paths:

```
./patch-extension.sh             # idempotent edit to the extension's extension.js
./patch-extension.sh --revert    # restore the most recent .bak
./patch-extension.sh --dry-run   # show what would change, touch nothing

node proxy.js                     # advanced: localhost proxy that injects thinking.display
                                  # into every request (sits in the path of your live token)

./test-thinking-display.sh        # live A/B tester (sends 2 small requests, uses tokens)
```

`proxy.js` sees your live auth token; read the security notes in `proxy.js` and
`TECHNICAL.md` before relying on it. After running `patch-extension.sh`, reload
the VS Code window.

## Launcher toggle

`CC_THINKING_DISPLAY` (default `summarized`; `omitted` disables injection). This
is an argument-injection feature: no file is patched, so there is nothing to
reconcile.

## Maintenance Contract

- Anchors / selectors: the launcher detects a real agent run via
  `--thinking adaptive|enabled`, `-p` / `--print`, and
  `--max-thinking-tokens N` / `=N`. `patch-extension.sh` keys off
  `if(l.type!=="disabled"&&l.display)<var>.push("--thinking-display",l.display)`,
  with the array variable captured by a regex group so a minifier rename does not
  break it.
- Ownership marker: none in the bundle (this is argument injection).
  `patch-extension.sh` keeps timestamped `.bak.<epoch>` backups.
- Failure mode if an anchor moves: injection is skipped when `--thinking-display`
  is already present, when thinking is disabled, or for subcommands/probes; the
  standalone patch no-ops if its target string is absent.
- Launcher registry entry: argument-injection feature, gated by
  `CC_THINKING_DISPLAY` and `CC_WORKAROUNDS`.
- Test fixture: `tests/test_regressions.py` (thinking-arg parsing, proxy header
  filtering, patch-extension, and the A/B-script cases).
