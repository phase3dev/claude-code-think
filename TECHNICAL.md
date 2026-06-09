# Technical details

Full root-cause analysis and design notes behind the workarounds in the [README](README.md).

* [Workaround 1: empty thinking summaries](#workaround-1-empty-thinking-summaries)
* [Workaround 2: missing context-usage icon](#workaround-2-missing-context-usage-icon)

---

# Workaround 1: empty thinking summaries

Request-level mechanics, the live A/B confirmation, and the proxy design for the empty-thinking-summaries fix on Opus 4.7 / 4.8.

## TL;DR

The Messages API `thinking.display` field decides whether summarized thinking is returned. On Opus 4.7 / 4.8 it defaults to `"omitted"`, so unless the request explicitly carries `thinking: {type: "adaptive", display: "summarized"}`, the thinking block streams back with an empty `thinking` string. The setting meant to opt you in, `showThinkingSummaries`, is honored only in interactive (TUI) mode, and the VS Code extension and headless `-p`/SDK drive the CLI non-interactively, so the setting is silently skipped on exactly the surfaces people complain about. The `--thinking-display summarized` CLI flag is not interactivity-gated, so forcing it (or the equivalent wire field) fixes the problem.

There is no raw/full thinking mode: the only valid `display` values are `"summarized"` and `"omitted"`.

## Root cause (from the installed CLI)

The request builder inside the CLI picks `display` like this (function names from a native-installer 2.1.x binary; logic is the same across install types):

```js
function p6(){ return !isInteractive }                    // p6() === "NOT interactive"
function EK8(){ return settings.showThinkingSummaries ?? false }

// request builder:
if (thinkingDisplay === "summarized" || thinkingDisplay === "omitted")
    pz.display = thinkingDisplay;            // <- the --thinking-display flag (ungated)
else if (!p6() && EK8())                     // <- (isInteractive && showThinkingSummaries)
    pz.display = "summarized";
// else: pz.display stays undefined -> server defaults to "omitted"
```

Two ways to set `display`:

1. The `--thinking-display` flag, always honored regardless of interactivity.
2. The `showThinkingSummaries` setting, honored only when `isInteractive`.

The VS Code extension launches the CLI with `--input-format stream-json` (i.e. non-interactive), so path #2 never fires. That leaves path #1, the flag, as the only lever. But the extension builds the thinking args like this:

```js
// extension.js, simplified (the array variable is minified; it is `q` in 2.1.16x,
// `B` in 2.0.x, and so on):
let q = ["--output-format","stream-json","--verbose","--input-format","stream-json"];
// adaptive thinking mode:        q.push("--thinking", "adaptive");
// budget thinking mode (2.1.16x): q.push("--max-thinking-tokens", l.budgetTokens.toString());
if (l.type !== "disabled" && l.display) q.push("--thinking-display", l.display);
```

`l.display` is only ever set if some upstream layer already set it, and nothing maps `showThinkingSummaries` onto it. The literal string `"summarized"` occurs 0 times in `extension.js`; `showThinkingSummaries` appears only in the settings *schema*, never in the request path. So `l.display` is always undefined, `--thinking-display` is never passed, the binary is non-interactive so the setting gate is also skipped, `display` stays undefined, the server defaults to `"omitted"`, and you get empty thinking even with `showThinkingSummaries: true`.

Two extension-side details changed in the 2.1.16x line and matter for the launcher (Option 1):

1. **Thinking signal.** The VS Code path now emits `--max-thinking-tokens <budgetTokens>` for its (default) budget thinking mode, not `--thinking adaptive`; `--thinking adaptive` is only emitted for the explicit adaptive mode. A launcher that triggers solely on `--thinking adaptive`/`-p` therefore never fires from the extension, which is why the previous launcher version stopped working when the extension updated.
2. **Process-wrapper calling convention.** When the `claudeCode.claudeProcessWrapper` setting is set, `resolveClaudeBinary()` returns `{pathToClaudeCodeExecutable: <wrapper>, executableArgs: [<realBinary>]}` (or `[<node>, <cli.js>]` when a bundled `cli.js` is used instead of a native binary). So the wrapper is invoked as `<wrapper> <realBinary> <args...>`, with the real CLI as a leading argument. The launcher detects and consumes that leading path; otherwise it would be forwarded to the real CLI as a stray positional.

## Behavior matrix

| Surface | `showThinkingSummaries: true` | `--thinking-display summarized` |
|---|:--:|:--:|
| Interactive terminal (TUI) | Works (`isInteractive` true) | Works |
| `claude -p` / headless / SDK | Ignored (`isInteractive` false) | Works |
| VS Code extension | Ignored (non-interactive, never mapped) | Works (extension just never sends it) |

This is why the interactive terminal was never broken and needs no fix, while the extension and headless paths show empty thinking. Note that on the VS Code path the current extension marks a real run with `--max-thinking-tokens`, not `--thinking adaptive`; the launcher keys off either.

## Confirmation (live A/B, headless)

Same prompt, run twice through a logged-in account on Opus 4.8 with `claude -p ... --output-format stream-json --verbose`:

| Run | thinking block |
|---|---|
| `--thinking-display summarized` | populated (hundreds of chars) |
| no flag, `showThinkingSummaries: true` | empty (0 chars) |

This proves three things: (1) `display: "summarized"` works end-to-end on 4.8, the server honors it; (2) the setting is ignored in non-interactive mode; (3) the flag is the lever. Reproduce it yourself with [`test-thinking-display.sh`](test-thinking-display.sh) (sends two small live requests; uses a few tokens).

VS Code UI was confirmed separately: after applying the Option 2 patch and reloading the window, thinking summaries render in the conversation on Opus 4.8. The fix has also been observed to survive an extension auto-update where `patch-extension.sh` had patched multiple installed versions.

## How each workaround applies the lever

### Option 1: launcher

Claude Code places one of these markers on the command line for real agent runs: `--max-thinking-tokens N` (the current VS Code extension's budget mode), `--thinking adaptive`/`enabled` (SDK and older extensions), or `-p`/`--print` (headless). The launcher inspects the args and, when it detects a real run via any of those markers, appends `--thinking-display summarized` before `exec`'ing the real `claude`. It also strips a leading real-binary path when the official extension passes one (the process-wrapper convention above), handling both a single native-binary path and a `node` + `cli.js` pair. Because it lives *outside* the app:

- it survives extension/CLI updates (nothing in Claude's install is modified);
- one wrapper covers both the VS Code extension and headless `-p`/SDK;
- the injection is guarded so it only fires on real runs (never on `mcp`, `config`, `--version`, etc.), never when thinking is explicitly `disabled`, and never twice (so it coexists with a patched or updated extension);
- `CC_THINKING_DISPLAY=omitted` flips it off without editing anything.

The launcher intentionally sets no environment of its own by default; it only adds the flag. Effort level, timeouts, and alternate-backend routing are available as commented, opt-in customizations in the script.

### Option 2: extension.js patch

A one-line change so the non-interactive spawn always forwards the flag:

```js
// from:
if(l.type!=="disabled"&&l.display)B.push("--thinking-display",l.display)
// to:
if(l.type!=="disabled")B.push("--thinking-display",l.display||"summarized")
```

The array variable (`B` here) is minified and renames between builds (`q` in 2.1.16x), so `patch-extension.sh` matches it with a capture group rather than a fixed literal and preserves whatever name the build uses. A hand edit should keep the surrounding build's variable name.

[`patch-extension.sh`](patch-extension.sh) applies this idempotently across all installed Claude Code extensions (backing up each first), with `--revert` and `--dry-run`. It must be re-applied after every extension update (the install folder is replaced on upgrade), and it only fixes VS Code; headless/SDK still need Option 1.

Toggle idea (untested): changing the line to `l.display || (process.env.CC_THINKING_DISPLAY || "summarized")` would let a `CC_THINKING_DISPLAY=omitted` env var (e.g. in VS Code `settings.json`) hide thinking while unset/`summarized` shows it, a way to honor an on/off switch without a code change each time. Not tested.

### Option 3: local proxy (design)

The most thorough fix: a small localhost forward proxy that injects the field at the wire level, so it is surface-agnostic (VS Code + CLI + SDK), needs no install edits, and survives updates. It works because every Claude Code surface resolves the API host as:

```
... ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"
```

Point `ANTHROPIC_BASE_URL` at the proxy and every request flows through it.

What the proxy does ([`proxy.js`](proxy.js)):

1. Accept requests on `http://127.0.0.1:<port>`.
2. For `POST /v1/messages`, parse the JSON body; if `body.thinking.type` is `"adaptive"` or `"enabled"` and `body.thinking.display` is unset, set it to the configured value (default `"summarized"`, or `"omitted"` to hide).
3. Forward everything else to `https://api.anthropic.com` unchanged: headers (incl. `x-api-key` / `Authorization: Bearer`, `anthropic-version`, `anthropic-beta`), query string, and the streaming SSE response body.
4. Stream the response straight back (no buffering, so `--output-format stream-json` and the UI keep working).

This doubles as the toggle: the injected value is read from `CC_THINKING_DISPLAY`, so flipping between `summarized` and `omitted` is just a restart with a different env var.

Security / trust notes (important):

- The proxy sees your live auth token. Keep it bound to 127.0.0.1 only, never `0.0.0.0`. Don't log headers/bodies except when actively debugging, and never to a shared path.
- Simplest TLS model: terminate plain HTTP locally and let the proxy make the upstream TLS call to api.anthropic.com (client to `http://127.0.0.1`, then on to the https upstream). Confirm your build accepts an `http://` localhost base URL; some builds may force https, in which case add a self-signed cert + `NODE_EXTRA_CA_CERTS`, or use a tool like `mitmproxy` with an addon that does the same body rewrite.
- Fully reversible: unset `ANTHROPIC_BASE_URL` to talk to Anthropic directly again.

Status: provided as a working starting point but not extensively tested, so validate the localhost-base-URL behavior before relying on it.

## Notes

- Summary length tracks effort. The detail/length of the summaries corresponds to the reasoning effort level, and at high effort (e.g. `CLAUDE_CODE_EFFORT_LEVEL=xhigh`) the summaries are long and read almost like full reasoning. Higher effort uses more tokens.
- Why hooks / plugins / MCP can't do this. None of them can modify the `/v1/messages` request body or the thinking config; they operate on tool/lifecycle events only, and the request is built inside the CLI. The only levers are: the `--thinking-display` flag, the (interactive-only) setting, an `extension.js`/binary patch, or a wire-level proxy.

## Compatibility

Confirmed on Opus 4.7 / 4.8 with VS Code extension `2.1.169` (native-binary CLI), via the `claudeCode.claudeProcessWrapper` setting, on Windows 11 and Ubuntu 24.04; earlier confirmations were on `2.1.165` / `2.1.167` (which signaled thinking with `--thinking adaptive`). The CLI flag and the request field are stable levers, but the exact minified strings used by [`patch-extension.sh`](patch-extension.sh) (Option 2) can change between extension releases (e.g. the array variable `B` -> `q`); the script matches the variable generically and, if the surrounding pattern isn't found, skips and tells you to inspect manually. Options 1 and 3 don't depend on internal strings.

---

# Workaround 2: missing context-usage icon

## TL;DR

The context-usage indicator in the VS Code chat input is gated to render only after more than 50% of the context window has been used. With the 1M context window that is about 500,000 tokens, so it is effectively never shown. There is no environment variable or CLI flag for the threshold, so the fix is a one-character-class edit to the extension's webview bundle, re-applied on each launch by the wrapper so it survives updates.

## Root cause (from the webview bundle)

The indicator is a React component in the extension's `webview/index.js`. The bundle is minified, so the component name `FJe` and its helpers (`OJe`, `BIt`, `b0e`, ...) are minifier-assigned and change between builds. Deobfuscated:

```js
function FJe({usedTokens:e, contextWindow:t, onCompact:i, buttonClassName:n}) {
  let a = t > 0 ? Math.min(e / t * 100, 100) : 0,  // a = % used
      l = b0e !== null ? b0e : a,                  // l = % used (b0e is a debug override, normally null)
      c = 100 - l;                                 // c = % REMAINING
  if (b0e === null) {
    if (t === 0) return null;        // no session / no window yet -> hide
    if (c >= 50) return null;        // <-- the gate: hide while >=50% remains
  }
  // ... renders the pie button + tooltip + popup ...
}
```

`c` is the percent of context *remaining*, so `c >= 50` hides the icon whenever at least half the window is free, i.e. it only appears once more than 50% is used. With a 1M window that is 500k tokens. Older bundles (`2.1.131`, `2.1.128`) do not contain this gate; it appeared around `2.1.165`, which matches users' recollection that the icon used to be visible.

The `CLAUDE_CODE_DISABLE_1M_CONTEXT=1` env var that circulates in the issue threads only shrinks the window to 200k so 50% (100k) is reached sooner. It does not touch the threshold and forces giving up the 1M window, so it is not a real fix.

## The fix

```text
if(c>=50)return null   ->   if(c>=101)return null
```

`c` is in `[0, 100]`, so `c >= 101` is never true and the gate never hides the icon. The separate `if (t === 0) return null` guard is left intact, so nothing renders before a context window is known. Using `>=101` (rather than deleting the line) is the smallest, most legible, greppable, reversible change, and it preserves the surrounding structure for a clean string substitution. The patch is anchored on the literal `>=50)return null}`, which is stable across builds even though the minified names around it are not, and which occurs exactly once in `2.1.169`.

There is no integrity or subresource check on the webview bundle (the only `sha256` references in `extension.js` belong to a bundled crypto library), so an edited `index.js` loads normally.

## Delivery: re-patch on each launch

The launcher is registered as the extension's process wrapper (`claudeCode.claudeProcessWrapper`), so the extension invokes it as `<wrapper> <REAL_CLAUDE...> <args...>` every time it spawns the CLI, including the first spawn after an auto-update. That is the ideal place to re-apply a bundle patch: it self-heals across updates with no daemon or cron.

The wrapper discovers `index.js` two ways:

* Precise: walk up from the real `claude` path the extension hands it until a path component matches `anthropic.claude-code-*`, then `<root>/webview/index.js`.
* Fallback: scan the user's `.vscode`, `.vscode-server`, and `.vscode-insiders` extension dirs for `anthropic.claude-code-*/webview/index.js` (covers terminal launches and standalone-CLI installs).

The edit is made safe:

* Idempotent: skips an already-patched file, and skips (rather than guesses) if the `>=50)return null}` anchor is absent because the extension changed.
* Backed up once to `index.js.bak-context-icon` before the first edit.
* Atomic: written to a temp file and moved into place only after it is verified non-empty and actually patched, so a failed or partial write cannot corrupt the bundle.
* Metadata-preserving via `cp -p` (portable; the GNU-only `chmod`/`chown --reference` is avoided so it also works on macOS/BSD). The Windows launcher writes with `fs.writeFileSync` + `fs.renameSync`, inheriting the parent directory's ACLs.
* Fully guarded so it never blocks the launch (a read-only file, a renamed bundle, or a missing tool simply no-ops).

Timing note: the wrapper patches `index.js` on disk when the CLI is spawned, which can be *after* the webview already loaded the old bundle. So the first time you enable it you may need two reloads (the spawn patches the file, then the webview loads the patched bundle). Later windows and post-update launches are already patched on disk.

## How the icon works (context for future changes)

### Data source resets on reload

`FJe` is fed from a live `usageData` store:

```js
React.createElement(FJe, {
  usedTokens:    e.usageData.value.totalTokens,
  contextWindow: e.usageData.value.contextWindow - e.usageData.value.maxOutputTokens - 13000,
  onCompact:     l,
  // ...
});
```

`usageData` initializes to all zeros and is only filled by usage events that arrive during an assistant turn. There is no seeding from `get_claude_state` on resume, so immediately after a window reload of a continued conversation, before any new turn, the store is still `{0,0,0,0}`: `usedTokens = 0` (the tooltip reads "0% used") and `contextWindow = 0 - 0 - 13000 = -13000` (negative, so the `t === 0` guard does not fire and, after the patch, the icon still renders at 0%). This self-corrects on the next turn, when a usage event fills the store with the real totals. `/context` does not use this store; it queries the CLI directly, so it always shows the true number.

If showing a transient 0% is undesirable, changing `if(t===0)return null` to `if(t<=0)return null` hides the icon while the store is empty (`t` is negative then) and shows it with the correct value after the first turn. This is documented as an optional manual tweak and is not applied by default.

### The glyph is a coarse 3-state gauge

```js
function BIt(e){ if(e<62.5) return 50; if(e<87) return 75; return 99 }  // e = % used
```

`BIt` maps percent-used to one of three bucket keys (`50`, `75`, `99`) that index arc-path lookup tables for the SVG. So the pie has only three visual states: below 62.5% used, 62.5 to 87%, and above 87%. It does not track 12% vs 30% vs 50%; it is a "getting full" warning light, which made sense when it was only shown past 50% used. The precise figure lives in the hover tooltip and the popup, and in `/context`. Making the pie a continuous gauge would require new SVG geometry, not a string patch, so it is out of scope.

### Click behavior

The pie button's `onClick` is `onCompact`: clicking the icon triggers compaction, not opening `/context`. Opening the detailed panel is the `/context` command. These are kept distinct.

## Compatibility

Confirmed on VS Code extension `2.1.169` (native-binary CLI) on Windows 11 and Ubuntu 24.04. The `>50% used` gate appeared around `2.1.165` (absent in `2.1.131` / `2.1.128`). The patch keys off the stable substring `>=50)return null}`, not the minified component name; if a future build changes that exact substring, the launcher safely no-ops (the icon goes missing again) until the anchor is updated. The standalone [`fix-context-icon.py`](fix-context-icon.py) applies the same change directly and supports `--revert`.
