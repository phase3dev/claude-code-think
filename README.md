# claude-code-think

This repository provides unofficial community workarounds for restoring visible extended-thinking summaries in Claude Code. These summaries stopped appearing with Opus 4.7 and remain unavailable in the affected paths, even when `showThinkingSummaries` is enabled.

Whether this behavior is intentional or a bug is outside the scope of this repository. For background, see these related GitHub issue threads:

* <https://github.com/anthropics/claude-code/issues/49322>
* <https://github.com/anthropics/claude-code/issues/63358>

These are unofficial community workarounds. Use them at your own discretion.

This repository may or may not be actively maintained, and future Claude Code updates could make these workarounds obsolete. It exists primarily to share public information, rather than to serve as an ongoing development project.

## Workarounds

These workarounds have been confirmed on Windows 11 and Ubuntu 24.04 with Opus 4.7 and Opus 4.8:

* **Option 1: Launcher (recommended).** A small wrapper that launches Claude Code and adds the missing flag. It fixes the VS Code extension and headless CLI, and it survives Claude Code updates.
* **Option 2: One-line patch.** A direct edit to one line of the VS Code extension. This only fixes VS Code and must be re-applied after each extension update.
* **Option 3: Local proxy (advanced).** A localhost proxy that can fix all surfaces at once. This is powerful but untested and is documented for users who want to evaluate it.

> Note: The interactive terminal, meaning `claude` in a shell, already shows summaries through the `showThinkingSummaries` setting. This issue affects the VS Code extension and headless `-p` or SDK paths.

> Requirement: The real Claude Code CLI must already be installed and working. If `claude --version` prints a version, this requirement is met.

## Option 1: Launcher (recommended)

The launcher starts the real `claude` binary and appends the missing `--thinking-display summarized` flag. It does not modify Claude Code files, so it continues working after updates. The same wrapper fixes both the VS Code extension and headless CLI.

### Linux / macOS (tested on Ubuntu 24.04)

The launcher is [`claudemax`](claudemax). Save it, make it executable, then point VS Code to it.

```sh
# 1. Install the launcher
mkdir -p ~/.local/bin
cp claudemax ~/.local/bin/claudemax     # or paste the file contents into that path
chmod +x ~/.local/bin/claudemax

# 2. Sanity check. This should print normal Claude help.
~/.local/bin/claudemax --help
```

### Use it in VS Code

No PATH changes are required.

1. Open the Command Palette with Ctrl/Cmd + Shift + P.
2. Select "Preferences: Open User Settings (JSON)".
3. Add this line, replacing `YOUR_USERNAME`. This is the official "Claude Code" extension's setting (shown in the UI as "Claude Code: Claude Process Wrapper"):

   ```jsonc
   "claudeCode.claudeProcessWrapper": "/home/YOUR_USERNAME/.local/bin/claudemax"
   ```

   If you use the third-party "Claude Code Chat" extension instead, set `"claudeCodeChat.executable.path"` to the same path.

4. Reload the VS Code window by opening the Command Palette and selecting "Developer: Reload Window".
5. To undo the change, point the setting back to your normal `claude` binary and reload.

> Multi-root note: `claudeCode.claudeProcessWrapper` is window-scoped. In a single folder, User or Workspace settings both work. In a multi-root `.code-workspace`, set it in the `.code-workspace` file's `"settings"` block (or User settings); VS Code ignores it in a folder's `.vscode/settings.json`.

### Use it in a terminal

Run `claudemax` in place of `claude`.

<details>
<summary>Show the full <code>claudemax</code> script</summary>

```bash
#!/usr/bin/env bash
# claudemax - Claude Code launcher that restores extended-thinking summaries on
# Opus 4.7 / 4.8, where the "Thinking" section otherwise renders empty.
#
# How it works: the VS Code extension and the headless CLI build the request
# without thinking.display, so the API defaults to "omitted" and you get empty
# thinking. This wrapper injects `--thinking-display summarized` into the launch
# args (the one lever that is NOT interactivity-gated), so summaries render again
# WITHOUT editing Claude's files, so it keeps working across Claude Code
# updates. It covers the VS Code extension AND the headless CLI (`-p` / `--print`
# / SDK). The interactive terminal already honors the showThinkingSummaries
# setting and needs no injection.
#
# Use it:
#   - VS Code (official "Claude Code" extension): set "claudeCode.claudeProcessWrapper"
#     to the FULL path of this file, then reload the window. In a multi-root
#     .code-workspace this setting is window-scoped, so put it in the workspace
#     file's "settings" block (or User settings), not a folder .vscode/settings.json.
#   - VS Code (third-party "Claude Code Chat"): set "claudeCodeChat.executable.path".
#   - Terminal: run `claudemax` in place of `claude`.
#
# Toggle off:
#   export CC_THINKING_DISPLAY=omitted
#
# Default:
#   CC_THINKING_DISPLAY=summarized
#
# The real `claude` must be installed. This wrapper finds it automatically; if it
# cannot, set CLAUDE_REAL_BIN to the full path of your real claude binary.

set -euo pipefail

# --- Locate the real claude binary -----------------------------------------

self="$(readlink -f "$0" 2>/dev/null || echo "$0")"

# Process-wrapper convention: the official VS Code extension invokes the wrapper
# as  <wrapper> <REAL_CLAUDE...> <args...>, passing the real CLI ahead of the
# args. <REAL_CLAUDE...> is either a single native-binary path (".../claude") or
# a node interpreter followed by the bundled cli.js (".../node .../cli.js").
# Peel that off so it is not forwarded as a stray positional argument, and
# prefer it as the real claude. (Plain "claudemax <args>" use is unaffected:
# <args> never begins with an existing claude/node binary path.)
wrapper_bin=""
if [ "$#" -gt 0 ] \
  && printf '%s' "$1" | grep -Eqi '/claude(\.exe|\.cmd|\.bat)?$' \
  && [ -e "$1" ]; then
  wrapper_bin="$1"
  shift
elif [ "$#" -ge 2 ] \
  && printf '%s' "$1" | grep -Eqi '/node(\.exe)?$' && [ -e "$1" ] \
  && printf '%s' "$2" | grep -Eqi '\.(c?js|mjs)$' && [ -e "$2" ]; then
  # node + cli.js: exec node directly and keep cli.js as the first forwarded arg.
  wrapper_bin="$1"
  shift
fi

REAL_CLAUDE="${CLAUDE_REAL_BIN:-}"
if [ -z "$REAL_CLAUDE" ] && [ -n "$wrapper_bin" ]; then
  REAL_CLAUDE="$wrapper_bin"
fi

if [ -z "$REAL_CLAUDE" ]; then
  for c in \
    "$HOME/.local/bin/claude" \
    /usr/local/bin/claude \
    /usr/bin/claude \
    /opt/homebrew/bin/claude \
    "$(command -v claude 2>/dev/null || true)"; do

    [ -n "$c" ] && [ -x "$c" ] || continue
    [ "$(readlink -f "$c" 2>/dev/null || echo "$c")" = "$self" ] && continue

    REAL_CLAUDE="$c"
    break
  done
fi

[ -n "$REAL_CLAUDE" ] || {
  echo "claudemax: could not find the real 'claude' binary; set CLAUDE_REAL_BIN" >&2
  exit 1
}

# --- Behavior ---------------------------------------------------------------

# Set CC_THINKING_DISPLAY=omitted to hide thinking; default shows summaries.
DISPLAY_VALUE="${CC_THINKING_DISPLAY:-summarized}"

# --- Optional customizations ------------------------------------------------
#
# Raise reasoning effort - longer, more detailed summaries. Uses more tokens:
#   export CLAUDE_CODE_EFFORT_LEVEL="${CLAUDE_CODE_EFFORT_LEVEL:-xhigh}"
#
# Auto mode - let a classifier pick the effort level per task. This is an
# ALTERNATIVE to a fixed effort level above (when auto mode is on, a fixed
# CLAUDE_CODE_EFFORT_LEVEL may be ignored). Another frequently-requested feature:
#   export CLAUDE_CODE_ENABLE_AUTO_MODE="${CLAUDE_CODE_ENABLE_AUTO_MODE:-1}"
#
# Longer network timeout for large requests:
#   export API_TIMEOUT_MS="${API_TIMEOUT_MS:-600000}"

# --- Inject the thinking-display fix into the launch args -------------------
#
# Fire on a real agent invocation. Surfaces signal a real run differently:
#   - the VS Code extension passes "--max-thinking-tokens N" (N > 0) plus the
#     stream-json I/O flags, and does NOT pass "--thinking adaptive" or "-p";
#   - the SDK / older extensions pass "--thinking adaptive" (or "enabled");
#   - headless passes "-p" / "--print".
#
# Skip injection when:
#   - thinking is explicitly disabled
#   - --thinking-display is already present (no double-inject vs a patched extension)
#   - CC_THINKING_DISPLAY=omitted
#   - the command is a subcommand/probe such as mcp, config, or --version,
#     which carries none of these markers

args=("$@")
have_display=false
thinking_adaptive=false
thinking_disabled=false
print_mode=false
max_thinking_on=false
prev=""

for a in "$@"; do
  case "$a" in
    --thinking-display)
      have_display=true
      ;;
    -p|--print)
      print_mode=true
      ;;
  esac

  if [ "$prev" = "--thinking" ]; then
    case "$a" in
      adaptive|enabled)
        thinking_adaptive=true
        ;;
      disabled)
        thinking_disabled=true
        ;;
    esac
  fi

  if [ "$prev" = "--max-thinking-tokens" ] && [ "$a" != "0" ]; then
    max_thinking_on=true
  fi

  prev="$a"
done

if [ "$have_display" = false ] \
  && [ "$thinking_disabled" = false ] \
  && [ "$DISPLAY_VALUE" != "omitted" ] \
  && { [ "$thinking_adaptive" = true ] || [ "$print_mode" = true ] || [ "$max_thinking_on" = true ]; }; then
  args+=(--thinking-display "$DISPLAY_VALUE")
fi

# The `${args[@]+...}` form guards the empty-array case under `set -u`,
# including older Bash versions such as the default Bash on older macOS systems.
exec "$REAL_CLAUDE" ${args[@]+"${args[@]}"}
```

</details>

### Windows 11

The same result can be achieved by using a compiled `.exe` version of the wrapper.

1. Download `claudemax.exe` from this repository's [Releases](../../releases), or build it yourself by following [Building claudemax.exe](#building-claudemaxexe).
2. Put `claudemax.exe` somewhere stable, such as `C:\Users\YOU\.local\bin\claudemax.exe`.
3. Open the Command Palette and select "Preferences: Open User Settings (JSON)".
4. Add the following setting (the official "Claude Code" extension setting). Use double backslashes in the path.

   ```jsonc
   "claudeCode.claudeProcessWrapper": "C:\\Users\\YOU\\.local\\bin\\claudemax.exe"
   ```

   If you use the third-party "Claude Code Chat" extension instead, set `"claudeCodeChat.executable.path"` to the same path. In a multi-root `.code-workspace`, put `claudeCode.claudeProcessWrapper` in the workspace file's `"settings"` block or in User settings, not a folder's `.vscode/settings.json`.

5. Reload the VS Code window by opening the Command Palette and selecting "Developer: Reload Window".
6. To use it in a terminal, run `claudemax.exe` in place of `claude`.

> The wrapper finds the real Claude binary automatically, including native installs with `claude.exe` and npm installs with `claude.cmd`. If it cannot find the binary, set `CLAUDE_REAL_BIN` to the full path of your `claude` binary.

The Windows source is [`claudemax.win.js`](claudemax.win.js).

### Turn the fix on or off

The launcher reads one environment variable, `CC_THINKING_DISPLAY`:

* unset or `summarized`: show thinking summaries, which is the default
* `omitted`: hide thinking summaries

Set the variable in the same environment where Claude Code launches, such as your shell profile or the VS Code extension environment, then reload. To disable the launcher entirely, point the VS Code setting back to your normal `claude` binary.

### What the launcher does

When Claude Code starts a real agent run it puts one of these markers on the command line: `--max-thinking-tokens N` (the current VS Code extension's budget thinking mode), `--thinking adaptive` or `enabled` (the SDK and older extensions), or `-p` / `--print` (headless). It does not add the matching `--thinking-display` flag, so the API defaults the display to `"omitted"` and the Thinking section comes back empty.

The launcher inspects the arguments and, when it detects a real run via any of those markers, appends `--thinking-display summarized` before handing off to the real `claude` binary. The official extension also launches the wrapper with the real CLI path as a leading argument (a "process wrapper" convention); the launcher detects and consumes that path so it is not forwarded as a stray positional. See [Technical details](#technical-details) and [TECHNICAL.md](TECHNICAL.md) for more information.

### Why Option 1 is recommended

1. It survives updates because it does not edit Claude Code files.
2. It fixes both the VS Code extension and headless `claude -p` or SDK runs.
3. It leaves the interactive TUI unchanged because that path already works.
4. It only injects the flag on real agent runs, not on subcommands or probes such as `mcp`, `config`, or `--version`.
5. It does not add the flag twice, so it can coexist with a patched or updated extension.
6. It can be toggled with one environment variable.
7. It provides one place to configure effort level, auto mode, timeouts, or model routing. See the commented customization section in the script and [Side Note](#side-note-use-option-1-to-launch-claude-code-with-third-party-models).

## Option 2: One-line `extension.js` patch (VS Code only)

If you only use the VS Code extension and accept reapplying the change after updates, you can patch the extension directly. The fix is a single line:

```js
// from:
if(l.type!=="disabled"&&l.display)B.push("--thinking-display",l.display)
// to:
if(l.type!=="disabled")B.push("--thinking-display",l.display||"summarized")
```

> The extension is minified, so the array variable name varies by build (`B` in 2.0.x, `q` in 2.1.16x, and so on). Match the surrounding text and keep whatever variable name your build uses; `patch-extension.sh` does this automatically. This version fragility is one reason Option 1 is preferred.

### Automatic patching on Linux, macOS, WSL, or Git Bash

[`patch-extension.sh`](patch-extension.sh) finds every installed Claude Code extension, backs each one up, and applies the patch:

```sh
./patch-extension.sh            # patch and create .bak backups
./patch-extension.sh --dry-run  # preview only, change nothing
./patch-extension.sh --revert   # restore backups
```

Reload the VS Code window after patching. Re-run the patch after every extension update because updates replace the extension folder and remove the change.

### Manual patching on any OS

Find the extension's `extension.js` file, back it up, replace the line shown above, save the file, and reload VS Code.

Common locations:

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

## Side Note: Use Option 1 to launch Claude Code with third-party models

Because Option 1 is a launcher you control, you can use it to launch Claude Code with any third-party, Anthropic-API-compatible model, such as DeepSeek.

### DeepSeek Example

Instead of the thinking environment variables above, set model-routing variables in the same launcher:

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

Setup is otherwise identical to Option 1. This is unrelated to the thinking-summary fix.

## Troubleshooting

* Still empty after setup: Reload the VS Code window after changing the setting. Confirm that the setting points to the launcher's full absolute path. On Windows, confirm that the path uses double backslashes.
* `could not find the real 'claude' binary`: The wrapper could not locate your real Claude binary. Set `CLAUDE_REAL_BIN` to its full path. Use `which claude` on Linux/macOS or `where claude` on Windows.
* Nothing changes in a plain terminal chat: This is expected. The interactive TUI already shows summaries through `showThinkingSummaries` and does not need this fix.
* Summaries are short: Summary length tracks the reasoning effort level. Try a higher `CLAUDE_CODE_EFFORT_LEVEL`, such as `xhigh`, or enable auto mode with `CLAUDE_CODE_ENABLE_AUTO_MODE=1`. Higher effort uses more tokens.
* To verify the root cause: Run [`test-thinking-display.sh`](test-thinking-display.sh). It performs a live A/B test of the flag and the setting and uses a small number of tokens.

## Files

| File | Description |
|---|---|
| [`claudemax`](claudemax) | Option 1 launcher for Linux/macOS. |
| [`claudemax.win.js`](claudemax.win.js) | Option 1 launcher for Windows. Build it to `claudemax.exe`. |
| [`patch-extension.sh`](patch-extension.sh) | Option 2 idempotent `extension.js` patch with `--revert` and `--dry-run`. |
| [`proxy.js`](proxy.js) | Option 3 localhost proxy. Advanced and untested. |
| [`claude-think.sh`](claude-think.sh) | Minimal CLI-only launcher variant. |
| [`test-thinking-display.sh`](test-thinking-display.sh) | Live A/B test showing that the flag is the relevant lever. |
| [`TECHNICAL.md`](TECHNICAL.md) | Full root-cause analysis and design notes. |

## Building claudemax.exe

The Windows launcher is built from [`claudemax.win.js`](claudemax.win.js) into a standalone `.exe` with [vercel/pkg](https://github.com/vercel/pkg). Node.js is required.

```sh
npm i -g pkg
pkg claudemax.win.js --targets node18-win-x64 --output claudemax.exe
```

The prebuilt `.exe` is published on the [Releases](../../releases) page rather than committed to the repo, since it is large and reproducible from the source above. Building it yourself is only necessary if you would rather not download the release asset.

## Technical details

This is a condensed version of [TECHNICAL.md](TECHNICAL.md), with enough detail to explain why the Thinking section is empty and why each fix works.

### Root cause

The Messages API `thinking.display` field controls whether summarized thinking is returned. On Opus 4.7 and 4.8, it defaults to `"omitted"`. Unless the client explicitly sends `thinking: {type: "adaptive", display: "summarized"}`, the thinking block streams back empty.

There is no raw or full thinking mode. The only valid values are `"summarized"` and `"omitted"`.

Claude Code has a setting for this, `showThinkingSummaries`, but it is only wired up on one of the three surfaces:

```js
// In the CLI binary, simplified:
function p6(){ return !isInteractive }                    // p6() === "NOT interactive"
function EK8(){ return settings.showThinkingSummaries ?? false }

// request builder:
if (thinkingDisplay === "summarized" || thinkingDisplay === "omitted")
    pz.display = thinkingDisplay;            // the --thinking-display flag, ungated
else if (!p6() && EK8())                     // isInteractive && showThinkingSummaries
    pz.display = "summarized";
```

The setting-to-display mapping is gated on `isInteractive`. The VS Code extension launches the CLI non-interactively with `--input-format stream-json`, so that branch never runs. The extension only forwards `--thinking-display` when its own `display` value is already set (the array variable is minified, shown here as `q`, as in extension 2.1.16x):

```js
// extension.js, simplified:
if (l.type !== "disabled" && l.display) q.push("--thinking-display", l.display);
```

`l.display` is never populated from `showThinkingSummaries`; the literal string `"summarized"` appears zero times in `extension.js`. The result on the extension and headless paths is that `display` is never sent, the API omits summaries, and the Thinking section is empty even with `showThinkingSummaries: true`.

The current extension signals a real run on the VS Code path with `--max-thinking-tokens <budgetTokens>` (its budget thinking mode) rather than `--thinking adaptive`, and it launches a configured `claudeProcessWrapper` with the real CLI path as a leading argument. Both matter for the launcher: it triggers on `--max-thinking-tokens` and strips the leading binary path.

The ungated lever is the `--thinking-display summarized` CLI flag, which works headless. Each fix in this repository forces that flag, or the equivalent request field, to be present.

### Behavior matrix

| Surface | `showThinkingSummaries: true` | `--thinking-display summarized` |
|---|:--:|:--:|
| Interactive terminal (TUI) | Works | Works |
| `claude -p` / headless / SDK | Ignored because it is non-interactive | Works |
| VS Code extension | Ignored because it is non-interactive and never mapped | Works, but the extension does not send it by default |

> On the VS Code path the current extension signals a real run with `--max-thinking-tokens`, not `--thinking adaptive`, and launches the wrapper with the real CLI path as a leading argument. The launcher handles both.

### How each option applies the lever

* **Option 1: Launcher.** Appends `--thinking-display summarized` to the arguments before executing the real CLI, triggering on `--max-thinking-tokens` (nonzero), `--thinking adaptive`/`enabled`, or `-p`/`--print`, and stripping the leading real-binary path the official extension passes. It operates outside the app, survives updates, and covers VS Code plus headless runs.
* **Option 2: Patch.** Changes the extension so it always forwards the flag with `l.display || "summarized"`. It modifies the bundle, is wiped by updates, is fragile against the minified variable rename (`B`, `q`, ...), and fixes VS Code only.
* **Option 3: Proxy.** Sets `body.thinking.display = "summarized"` on the wire for every `/v1/messages` request. It is surface-agnostic.

For the live A/B confirmation, deeper design notes, proxy security model, and notes on summary length versus effort level, see [TECHNICAL.md](TECHNICAL.md).

## Confirmation

Confirmed on Opus 4.7 and Opus 4.8 with VS Code extension `2.1.169` (native-binary CLI), via the `claudeCode.claudeProcessWrapper` setting, on Windows 11 and Ubuntu 24.04. Earlier builds (`2.1.165` / `2.1.167`) signaled thinking with `--thinking adaptive`; `2.1.169` uses `--max-thinking-tokens` on the VS Code path. Behavior may change in future Claude Code releases.
