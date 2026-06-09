# claude-code-workarounds

Unofficial community workarounds for Claude Code. Each entry below is an independent fix with its own scripts and detailed section.

Not affiliated with or endorsed by Anthropic. A future Claude Code update could make any of the included workarounds obsolete. Use them at your own discretion.

## Workarounds

1. **Empty thinking summaries (Opus 4.7 / 4.8)** [updated 2026-06-08].
   Thinking summaries render empty in the VS Code extension and headless `-p`/SDK paths, even with `showThinkingSummaries` enabled. Fix via a launcher (recommended), a one-line extension patch, or a local proxy.
   -> [details](#workaround-1-thinking-summaries)

2. **Missing context-usage icon (1M context window)** [updated 2026-06-08].
   The context-usage pie in the chat input is hidden until you have used more than 50% of the context window. With the 1M window that is about 500,000 tokens, so it is effectively never shown. Fix via a launcher that re-patches the webview on each launch, or a standalone patcher script.
   -> [details](#workaround-2-context-usage-icon)

## Launchers at a glance

The recommended fix for each workaround is a small launcher that wraps the real `claude` binary. They are drop-in process wrappers that differ only in what they inject or patch. Pick the one matching the fixes you want:

| Launcher | Thinking fix | Context-icon fix | Edits the extension? |
|---|:--:|:--:|:--:|
| `claudemax` | yes | yes | yes (webview bundle only) |
| `claude-think` | yes | - | no |
| `claude-context` | - | yes | yes (webview bundle only) |

* **Linux / macOS:** the bash scripts [`claudemax`](claudemax), [`claude-think`](claude-think), [`claude-context`](claude-context).
* **Windows:** the matching compiled `.exe` builds (`claudemax.exe`, `claude-think.exe`, `claude-context.exe`) on the [Releases](../../releases) page, built from the `*.win.js` sources.

> Note: The interactive terminal (`claude` in a shell) already shows thinking summaries through the `showThinkingSummaries` setting and always shows the context icon. Both issues affect the VS Code extension and the headless `-p` / SDK paths.

> Requirement: The real Claude Code CLI must already be installed and working. If `claude --version` prints a version, this requirement is met.

> The thinking fix (`claude-think`) edits nothing. The context-icon fix (`claude-context`, `claudemax`) does edit the extension's webview bundle on disk - idempotently, with a one-time backup, an atomic write, and a toggle. See [Workaround 2](#workaround-2-context-usage-icon).

---

# Workaround 1: thinking summaries

Extended-thinking summaries stopped appearing with Opus 4.7 and remain unavailable in the VS Code extension and headless paths, even when `showThinkingSummaries` is enabled. For background, see these GitHub issue threads:

* <https://github.com/anthropics/claude-code/issues/49322>
* <https://github.com/anthropics/claude-code/issues/63358>

There are three workarounds:

* **Option 1: Launcher (recommended).** A small wrapper that launches Claude Code and adds the missing flag. It fixes the VS Code extension and headless CLI, and it survives Claude Code updates.
* **Option 2: One-line patch.** A direct edit to one line of the VS Code extension. This only fixes VS Code and must be re-applied after each extension update.
* **Option 3: Local proxy (advanced).** A localhost proxy that can fix all surfaces at once. This is powerful but untested and is documented for users who want to evaluate it.

## Option 1: Launcher (recommended)

The launcher starts the real `claude` binary and appends the missing `--thinking-display summarized` flag. It does not modify Claude Code files, so it continues working after updates. The same wrapper fixes both the VS Code extension and headless CLI.

Use [`claude-think`](claude-think) for the thinking fix alone, or [`claudemax`](claudemax) to also restore the context-usage icon ([Workaround 2](#workaround-2-context-usage-icon)). Setup is identical; substitute the launcher name.

### Linux / macOS (tested on Ubuntu 24.04)

```sh
# 1. Install the launcher
mkdir -p ~/.local/bin
cp claude-think ~/.local/bin/claude-think     # or claudemax for both fixes
chmod +x ~/.local/bin/claude-think

# 2. Sanity check. This should print normal Claude help.
~/.local/bin/claude-think --help
```

### Use it in VS Code

No PATH changes are required.

1. Open the Command Palette with Ctrl/Cmd + Shift + P.
2. Select "Preferences: Open User Settings (JSON)".
3. Add this line, replacing `YOUR_USERNAME`. This is the official "Claude Code" extension's setting (shown in the UI as "Claude Code: Claude Process Wrapper"):

   ```jsonc
   "claudeCode.claudeProcessWrapper": "/home/YOUR_USERNAME/.local/bin/claude-think"
   ```

   If you use the third-party "Claude Code Chat" extension instead, set `"claudeCodeChat.executable.path"` to the same path.

4. Reload the VS Code window by opening the Command Palette and selecting "Developer: Reload Window".
5. To undo the change, clear or remove the `claudeCode.claudeProcessWrapper` setting, then reload. Do not point this setting at `claude` directly: under the process-wrapper convention the extension would launch `claude <REAL_CLAUDE> <args...>` and the real CLI would receive its own path as a stray argument. (If you used the third-party `claudeCodeChat.executable.path` instead, that one can simply be pointed back to your normal `claude` binary or removed.)

> Multi-root note: `claudeCode.claudeProcessWrapper` is window-scoped. In a single folder, User or Workspace settings both work. In a multi-root `.code-workspace`, set it in the `.code-workspace` file's `"settings"` block (or User settings); VS Code ignores it in a folder's `.vscode/settings.json`.

### Use it in a terminal

Run `claude-think` (or `claudemax`) in place of `claude`.

### Windows 11

The same result is achieved with the compiled `.exe`.

1. Download `claude-think.exe` (or `claudemax.exe` for both fixes) from this repository's [Releases](../../releases), or build it yourself - see [Building the .exe files](#building-the-exe-files).
2. Put it somewhere stable, such as `C:\Users\YOU\.local\bin\claude-think.exe`.
3. Open the Command Palette and select "Preferences: Open User Settings (JSON)".
4. Add the following setting (the official "Claude Code" extension setting). Use double backslashes in the path.

   ```jsonc
   "claudeCode.claudeProcessWrapper": "C:\\Users\\YOU\\.local\\bin\\claude-think.exe"
   ```

   If you use the third-party "Claude Code Chat" extension instead, set `"claudeCodeChat.executable.path"` to the same path. In a multi-root `.code-workspace`, put `claudeCode.claudeProcessWrapper` in the workspace file's `"settings"` block or in User settings, not a folder's `.vscode/settings.json`.

5. Reload the VS Code window by opening the Command Palette and selecting "Developer: Reload Window".
6. To use it in a terminal, run `claude-think.exe` in place of `claude`.

> The wrapper finds the real Claude binary automatically, including native installs with `claude.exe` and npm installs with `claude.cmd`. If it cannot find the binary, set `CLAUDE_REAL_BIN` to the full path of your `claude` binary.

The Windows sources are [`claude-think.win.js`](claude-think.win.js) and [`claudemax.win.js`](claudemax.win.js).

### Turn the thinking fix on or off

The launcher reads one environment variable, `CC_THINKING_DISPLAY`:

* unset or `summarized`: show thinking summaries, which is the default
* `omitted`: hide thinking summaries

Set the variable in the same environment where Claude Code launches (such as your shell profile or the VS Code extension environment), then reload. To disable the launcher entirely, clear or remove the `claudeCode.claudeProcessWrapper` setting (do not point it at `claude`, for the reason in the undo note above).

### What the launcher does

When Claude Code starts a real agent run it puts one of these markers on the command line: `--max-thinking-tokens N` (the current VS Code extension's budget thinking mode), `--thinking adaptive` or `enabled` (the SDK and older extensions), or `-p` / `--print` (headless). It does not add the matching `--thinking-display` flag, so the API defaults the display to `"omitted"` and the Thinking section comes back empty.

The launcher inspects the arguments and, when it detects a real run via any of those markers, appends `--thinking-display summarized` before handing off to the real `claude` binary. The official extension also launches the wrapper with the real CLI path as a leading argument (a "process wrapper" convention); the launcher detects and consumes that path so it is not forwarded as a stray positional. See [TECHNICAL.md](TECHNICAL.md) for more.

### Why Option 1 is recommended

1. It survives updates because it does not edit Claude Code files.
2. It fixes both the VS Code extension and headless `claude -p` or SDK runs.
3. It leaves the interactive TUI unchanged because that path already works.
4. It only injects the flag on real agent runs, not on subcommands or probes such as `mcp`, `config`, or `--version`.
5. It does not add the flag twice, so it can coexist with a patched or updated extension.
6. It can be toggled with one environment variable.
7. It provides one place to configure effort level, auto mode, timeouts, or model routing. See the commented customization section in the script and the [Side note](#side-note-launching-claude-code-with-third-party-models).

## Option 2: One-line `extension.js` patch (VS Code only)

If you only use the VS Code extension and accept reapplying the change after updates, you can patch the extension directly. The fix is a single line:

```js
// from:
if(l.type!=="disabled"&&l.display)B.push("--thinking-display",l.display)
// to:
if(l.type!=="disabled")B.push("--thinking-display",l.display||"summarized")
```

> The extension is minified, so the array variable name varies by build (`B` in 2.0.x, `q` in 2.1.16x, and so on). Match the surrounding text and keep whatever variable name your build uses; [`patch-extension.sh`](patch-extension.sh) does this automatically. This version fragility is one reason Option 1 is preferred.

### Automatic patching on Linux, macOS, WSL, or Git Bash

[`patch-extension.sh`](patch-extension.sh) finds every installed Claude Code extension, backs each one up, and applies the patch:

```sh
./patch-extension.sh            # patch and create .bak backups
./patch-extension.sh --dry-run  # preview only, change nothing
./patch-extension.sh --revert   # restore backups
```

Reload the VS Code window after patching. Re-run the patch after every extension update because updates replace the extension folder and remove the change.

### Manual patching on any OS

Find the extension's `extension.js` file, back it up, replace the line shown above, save the file, and reload VS Code. Common locations:

* Linux/macOS: `~/.vscode/extensions/anthropic.claude-code-*/`
* Windows: `%USERPROFILE%\.vscode\extensions\anthropic.claude-code-*\`

### Why Option 1 is preferred over Option 2

1. Option 2 must be re-applied after every extension update.
2. Option 2 fixes VS Code only. Headless `claude -p` and SDK runs still come back empty.

## Option 3: Local proxy (advanced, untested)

A localhost proxy can add the missing field to every request, fixing VS Code, CLI, and SDK runs without editing files or reapplying patches. This works because each surface honors `ANTHROPIC_BASE_URL`.

This is a working starting point, not a turnkey fix. It also sits in the path of your live auth token, so review the security notes before relying on it.

```sh
node proxy.js                                      # listens on http://127.0.0.1:8788
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788   # set this where Claude launches
claude ...                                        # for VS Code, set it for the extension host, then reload
```

Security: The proxy sees your live auth token. It binds to `127.0.0.1` only, never `0.0.0.0`, and does not log headers or bodies. Unset `ANTHROPIC_BASE_URL` to return directly to Anthropic. See [`proxy.js`](proxy.js) and [TECHNICAL.md](TECHNICAL.md#option-3-local-proxy-design) for details and caveats.

---

# Workaround 2: context-usage icon

The context-usage indicator (the small pie in the chat input that shows how full the context window is) disappeared for many users on recent extension builds. It is not actually removed: recent builds (around 2.1.165 and later) gate the indicator so it renders **only after you have used more than 50% of the context window**. With the 1M context window enabled, 50% is roughly 500,000 tokens, so in normal use the icon is effectively never shown.

The `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` workaround that circulates in issue threads is not a real fix: it only shrinks the window so 50% is reached sooner, at the cost of giving up the 1M window, and it does not touch the threshold. This workaround addresses the threshold directly.

Related GitHub issue threads (feature requests for a persistent context indicator, useful as corroboration):

* <https://github.com/anthropics/claude-code/issues/18456>
* <https://github.com/anthropics/claude-code/issues/66021>

There is no environment variable or CLI flag for this threshold, so the fix is a tiny edit to the extension's webview bundle. There are two ways to apply it.

## Option 1: Launcher (recommended)

Use [`claude-context`](claude-context) for the context-icon fix alone, or [`claudemax`](claudemax) to also restore thinking summaries ([Workaround 1](#workaround-1-thinking-summaries)). Install and wire it up exactly like the Workaround 1 launcher (copy to `~/.local/bin`, point `claudeCode.claudeProcessWrapper` at it, reload), substituting the launcher name. On Windows, download `claude-context.exe` or `claudemax.exe` from [Releases](../../releases).

On each launch the wrapper idempotently patches the extension's `webview/index.js`, flipping the hidden threshold so the icon shows at any usage level. Because it re-applies every launch, an extension auto-update that reinstalls a fresh bundle is re-patched on the next launch.

> First-run note: the wrapper patches `index.js` on disk when the CLI is spawned, which can be **after** the webview already loaded the old bundle. The first time you enable it you may need **two reloads**: reload once (the spawn patches the file), then reload again (the webview loads the patched bundle). Later windows and post-update launches are already patched on disk.

### What it changes

In the indicator component, the render gate is `if (c >= 50) return null`, where `c` is the percent of context **remaining**. So the icon renders only when less than 50% remains (more than 50% used). The fix flips the threshold:

```text
if(c>=50)return null   ->   if(c>=101)return null
```

`c` maxes at 100, so `c >= 101` is never true and the gate never hides the icon. The separate `if (t === 0) return null` guard (no context window known yet) is left intact, so nothing renders before a session exists. The edit is anchored on the stable string `>=50)return null}`, not on the minified component name, which changes between builds.

### Turn the context-icon fix on or off

The launcher reads `CC_PATCH_CONTEXT_ICON`:

* unset or `1`: patch the webview so the icon is visible, which is the default
* `0`: leave the extension webview untouched

### This edits the extension (unlike the thinking fix)

Unlike Workaround 1, this fix edits the extension's bundled `webview/index.js`. The edit is made safe:

* **Idempotent** - it skips a file that is already patched, and skips (rather than guesses) if the `>=50)return null}` anchor is absent because the extension changed.
* **Backed up once** - `index.js.bak-context-icon` is created before the first edit.
* **Atomic** - the change is written to a temp file and moved into place only after it is verified, so a failed or partial write leaves the original untouched.
* **Best-effort** - every step is guarded; a read-only file, a renamed bundle, or a missing tool simply no-ops and never blocks the launch.
* **Reversible** - delete the patched bundle's `.bak-context-icon` after restoring it, set `CC_PATCH_CONTEXT_ICON=0`, or just let an extension update replace the file.

## Option 2: Standalone patcher script

[`fix-context-icon.py`](fix-context-icon.py) applies the same one-character-class change directly, without a launcher. It auto-discovers installed extensions, backs each up, and is idempotent.

```sh
python3 fix-context-icon.py            # auto-discover and patch all installs
python3 fix-context-icon.py --revert   # restore from backups
python3 fix-context-icon.py /path/to/webview/index.js   # explicit target(s)
```

After patching, reload the webview (Command Palette -> "Developer: Reload Window"). Because an extension update reinstalls a fresh bundle and reverts the patch, re-run the script after updates (or use the launcher, which re-applies automatically).

## Known limitations

1. **Coarse glyph.** The pie is a 3-state gauge, not a continuous fill: it only changes appearance at roughly 62.5% and 87% used. The precise percentage is in the hover tooltip and in `/context`, not in the glyph itself. Making the pie a fine-grained gauge would require new SVG geometry, not a one-line patch, so it is out of scope.
2. **Transient 0% right after a reload.** The icon reads from a usage store that resets to zero on a window reload and is repopulated by the next assistant turn. Immediately after reloading a continued conversation, before any new turn, the tooltip can briefly read "0% context used"; it self-corrects to the true value after the next turn. (`/context` is unaffected - it queries the CLI directly.) If you would rather hide the icon while the store is empty than show a transient 0%, change the icon's `if(t===0)return null` to `if(t<=0)return null` in `webview/index.js`; the icon then stays hidden until the first turn populates real numbers. This is a manual, optional tweak and is not applied by default.

---

## Side note: launching Claude Code with third-party models

Because Option 1 is a launcher you control, you can also use it to launch Claude Code with any third-party, Anthropic-API-compatible model, such as DeepSeek. Set model-routing variables in the same launcher environment:

```sh
# --- Connection ---
export ANTHROPIC_BASE_URL="https://api.deepseek.com/anthropic"
export ANTHROPIC_AUTH_TOKEN="your token"
# --- Model mapping ---
export ANTHROPIC_MODEL="deepseek-v4-pro"
export ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek-v4-pro"
export ANTHROPIC_DEFAULT_SONNET_MODEL="deepseek-v4-pro"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="deepseek-v4-flash"
export CLAUDE_CODE_SUBAGENT_MODEL="deepseek-v4-flash"
```

Setup is otherwise identical to Option 1. This is unrelated to the fixes above.

## Troubleshooting

* Thinking still empty after setup: Reload the VS Code window after changing the setting. Confirm the setting points to the launcher's full absolute path. On Windows, confirm the path uses double backslashes.
* Context icon still missing after setup: It may take two reloads the first time (see the first-run note above). Confirm you are using `claude-context` or `claudemax`, and that `CC_PATCH_CONTEXT_ICON` is not set to `0`.
* `could not find the real 'claude' binary`: Set `CLAUDE_REAL_BIN` to its full path. Use `which claude` on Linux/macOS or `where claude` on Windows.
* Nothing changes in a plain terminal chat: This is expected. The interactive TUI already shows summaries and the context icon, and does not need these fixes.
* Summaries are short: Summary length tracks the reasoning effort level. Try a higher `CLAUDE_CODE_EFFORT_LEVEL`, such as `xhigh`, or enable auto mode with `CLAUDE_CODE_ENABLE_AUTO_MODE=1`. Higher effort uses more tokens.
* To verify the thinking root cause: Run [`test-thinking-display.sh`](test-thinking-display.sh). It performs a live A/B test and uses a small number of tokens.

## Files

| File | Workaround | Description |
|---|---|---|
| [`claudemax`](claudemax) | both | Launcher (Linux/macOS) with both fixes. |
| [`claude-think`](claude-think) | thinking | Launcher (Linux/macOS), thinking fix only. |
| [`claude-context`](claude-context) | context icon | Launcher (Linux/macOS), context-icon fix only. |
| [`claudemax.win.js`](claudemax.win.js) | both | Windows source for `claudemax.exe`. |
| [`claude-think.win.js`](claude-think.win.js) | thinking | Windows source for `claude-think.exe`. |
| [`claude-context.win.js`](claude-context.win.js) | context icon | Windows source for `claude-context.exe`. |
| [`patch-extension.sh`](patch-extension.sh) | thinking | Option 2 idempotent `extension.js` patch with `--revert` and `--dry-run`. |
| [`fix-context-icon.py`](fix-context-icon.py) | context icon | Option 2 standalone webview patcher with `--revert`. |
| [`proxy.js`](proxy.js) | thinking | Option 3 localhost proxy. Advanced and untested. |
| [`test-thinking-display.sh`](test-thinking-display.sh) | thinking | Live A/B test showing that the flag is the relevant lever. |
| [`TECHNICAL.md`](TECHNICAL.md) | both | Full root-cause analysis and design notes. |

## Releases

Prebuilt Windows `.exe` launchers are published on the [Releases](../../releases) page rather than committed to the repo, since they are large and reproducible from the `*.win.js` sources. Each release attaches:

* `claudemax.exe` - both fixes
* `claude-think.exe` - thinking fix only
* `claude-context.exe` - context-icon fix only

Linux and macOS users run the bash scripts from the repo and do not need a download.

## Building the .exe files

The Windows launchers are built from their `*.win.js` sources into standalone `.exe`s with [vercel/pkg](https://github.com/vercel/pkg). Node.js is required.

```sh
npm i -g pkg
pkg claudemax.win.js      --targets node18-win-x64 --output claudemax.exe
pkg claude-think.win.js   --targets node18-win-x64 --output claude-think.exe
pkg claude-context.win.js --targets node18-win-x64 --output claude-context.exe
```

## Compatibility

Confirmed on Opus 4.7 and Opus 4.8 with VS Code extension `2.1.169` (native-binary CLI), via the `claudeCode.claudeProcessWrapper` setting, on Windows 11 and Ubuntu 24.04.

* **Thinking fix:** earlier builds (`2.1.165` / `2.1.167`) signaled thinking with `--thinking adaptive`; `2.1.169` uses `--max-thinking-tokens` on the VS Code path. The launcher keys off either, plus `-p`/`--print` for headless. The `--thinking-display` flag and the request field are stable levers; the Option 2 minified strings can change between releases (the script matches generically and skips if not found).
* **Context-icon fix:** the `>50% used` gate appeared around `2.1.165` (absent in `2.1.131` / `2.1.128`). The patch anchors on the stable substring `>=50)return null}`; if a future build changes that exact string, the launcher safely no-ops and the anchor needs updating.

Behavior may change in future Claude Code releases.
