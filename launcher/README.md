# The unified launcher

One bash launcher (`claudemax`) and one Windows launcher (`claudemax.win.js`)
carry every fix in this repo. Each fix is on by default and independently
switchable at runtime with an environment variable, so the same artifact serves
"I want everything" and "I want only X" without editing code and without
recompiling. The Windows launcher compiles to a single `claudemax.exe` with
`pkg`.

Both launchers are drop-in process wrappers: they find the real `claude`, peel
the process-wrapper convention args, inject the thinking-display flag when a real
agent run is detected, reconcile the webview bundle, then exec the real CLI.

## Wiring (process wrapper)

VS Code, official "Claude Code" extension:

- Set `claudeCode.claudeProcessWrapper` to the full path of `launcher/claudemax`
  (or `claudemax.exe` on Windows), then reload the window.
- In a multi-root `.code-workspace`, this setting is window-scoped: put it in the
  workspace file's `settings` block (or in User settings), not in a folder
  `.vscode/settings.json`.

VS Code, third-party "Claude Code Chat" extension:

- Set `claudeCodeChat.executable.path` to the launcher.

Terminal:

- Run `claudemax` in place of `claude`.

## Toggles

| Env var | Default | Effect |
| --- | --- | --- |
| `CC_WORKAROUNDS` | `1` | Master switch. `0` disables every fix (argument injection and bundle patches) and reverts the webview to a clean bundle on launch. |
| `CC_RECONCILE` | `1` | `0` = do not read or write the webview bundle this launch (emergency bypass). Argument injection still runs. |
| `CC_THINKING_DISPLAY` | `summarized` | `summarized` shows extended-thinking summaries; `omitted` hides them (no injection). |
| `CC_PATCH_CONTEXT_ICON` | `1` | `0` leaves the context-usage icon unpatched (and reverts ours on the next launch). |
| `CC_PATCH_MD_COPY` | `1` | `0` leaves the webview without the markdown copy/export controls (and reverts ours on the next launch). |

Setting toggles without touching the script:

- Use the extension's existing `claudeCode.environmentVariables` setting to set
  any `CC_*` toggle from the settings UI on any OS, including against the compiled
  `claudemax.exe`.
- Source-script users can instead edit the `FEATURE DEFAULTS` block near the top
  of `claudemax` / `claudemax.win.js`.

## Overriding the real binary

- `CLAUDE_REAL_BIN` - full path to the real `claude`, if autodetection fails.
- `CC_NODE_BIN` (Windows) - path to `node.exe`, used when resolving a `.cmd` /
  `.bat` shim without going through a shell.

## Building the exe

```
npm i -g pkg
pkg launcher/claudemax.win.js --targets node18-win-x64 --output claudemax.exe
```

The exe is distributed through GitHub Releases, not committed to the repo.
