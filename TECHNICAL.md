# Technical details: empty thinking summaries on Opus 4.7 / 4.8

Full root-cause analysis and design notes behind the workarounds in the [README](README.md). This expands on the README's "Technical details" section with the request-level mechanics, the live A/B confirmation, and the proxy design.

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
// extension.js, simplified:
let B = ["--output-format","stream-json","--verbose","--input-format","stream-json"];
// ... pushes --thinking adaptive / enabled / disabled ...
if (l.type !== "disabled" && l.display) B.push("--thinking-display", l.display);
```

`l.display` is only ever set if some upstream layer already set it, and nothing maps `showThinkingSummaries` onto it. The literal string `"summarized"` occurs 0 times in `extension.js`; `showThinkingSummaries` appears only in the settings *schema*, never in the request path. So `l.display` is always undefined, `--thinking-display` is never passed, the binary is non-interactive so the setting gate is also skipped, `display` stays undefined, the server defaults to `"omitted"`, and you get empty thinking even with `showThinkingSummaries: true`.

## Behavior matrix

| Surface | `showThinkingSummaries: true` | `--thinking-display summarized` |
|---|:--:|:--:|
| Interactive terminal (TUI) | Works (`isInteractive` true) | Works |
| `claude -p` / headless / SDK | Ignored (`isInteractive` false) | Works |
| VS Code extension | Ignored (non-interactive, never mapped) | Works (extension just never sends it) |

This is why the interactive terminal was never broken and needs no fix, while the extension and headless paths show empty thinking.

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

Claude Code already places `--thinking adaptive` (VS Code/SDK) or `-p`/`--print` (headless) on the command line for real agent runs. The launcher inspects the args and, when it detects a real run, appends `--thinking-display summarized` before `exec`'ing the real `claude`. Because it lives *outside* the app:

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

Confirmed on Opus 4.7 / 4.8 with native-installer CLI `2.1.166` and VS Code extension `2.1.165` / `2.1.167`, on Windows 11 and Ubuntu 24.04. The CLI flag and the request field are stable levers, but the exact minified strings used by [`patch-extension.sh`](patch-extension.sh) (Option 2) can change between extension releases. If the target string isn't found, the script skips and tells you to inspect manually. Options 1 and 3 don't depend on internal strings.
