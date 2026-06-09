// claudemax.win.js - Windows launcher for Claude Code that restores
// extended-thinking summaries on Opus 4.7 / 4.8, where the "Thinking" section
// otherwise renders empty.
//
// How it works: the VS Code extension and the headless CLI build the request
// without thinking.display, so the API defaults to "omitted" and you get empty
// thinking. This wrapper injects `--thinking-display summarized` into the launch
// args (the one lever that is NOT interactivity-gated), so summaries render again
// WITHOUT editing Claude's files, so it keeps working across Claude Code updates.
// It covers the VS Code extension AND the headless CLI (`-p` / `--print` / SDK).
// The interactive terminal already honors the showThinkingSummaries setting and
// needs no injection.
//
// Use it: set the official "Claude Code" extension's "claudeCode.claudeProcessWrapper"
// setting (or the third-party "Claude Code Chat" extension's
// "claudeCodeChat.executable.path") to claudemax.exe and reload the window, or
// run claudemax.exe in place of claude in a terminal. In a multi-root
// .code-workspace, claudeProcessWrapper is window-scoped: put it in the
// workspace file's "settings" block (or User settings), not a folder's
// .vscode/settings.json.
//
// Toggle off: set CC_THINKING_DISPLAY=omitted   (default is summarized).
//
// The real `claude` must be installed. This wrapper finds it automatically
// (native install `claude.exe` or npm `claude.cmd`); if it cannot, set the
// CLAUDE_REAL_BIN environment variable to the full path of your real claude.
//
// Build to a standalone .exe with vercel/pkg:
//   npm i -g pkg
//   pkg claudemax.win.js --targets node18-win-x64 --output claudemax.exe

const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

// --- Locate the real claude (native claude.exe or npm claude.cmd) ----------
function findClaude() {
  if (process.env.CLAUDE_REAL_BIN && fs.existsSync(process.env.CLAUDE_REAL_BIN)) {
    return process.env.CLAUDE_REAL_BIN;
  }
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const appdata = process.env.APPDATA || "";
  const candidates = [
    path.join(home, ".local", "bin", "claude.exe"),
    path.join(home, ".local", "bin", "claude.cmd"),
    appdata && path.join(appdata, "npm", "claude.cmd"),
    appdata && path.join(appdata, "npm", "claude.exe"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // Fall back to a PATH lookup via `where`, skipping our own executable.
  try {
    const out = execFileSync("where", ["claude"], { encoding: "utf8" });
    const self = path.resolve(process.execPath);
    const hit = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(
        (s) =>
          s &&
          /\.(exe|cmd|bat)$/i.test(s) &&
          fs.existsSync(s) &&
          path.resolve(s) !== self
      );
    if (hit) return hit;
  } catch (_) {
    /* claude not on PATH */
  }
  return null;
}

// Process-wrapper convention: the official VS Code extension invokes the wrapper
// as  <wrapper> <REAL_CLAUDE...> <args...>, passing the real CLI ahead of the
// args. <REAL_CLAUDE...> is either a single native-binary path (".../claude.exe")
// or a node interpreter followed by the bundled cli.js (".../node .../cli.js").
// Peel that off so it is not forwarded as a stray positional argument, and
// prefer it as the real claude. (The third-party claudeCodeChat "executable.path"
// mode calls <wrapper> <args...> with no leading binary, which falls through.)
const rawArgs = process.argv.slice(2);
let wrapperBin = null;
let argv = rawArgs;
if (
  rawArgs.length &&
  /[\\/]claude(\.exe|\.cmd|\.bat)?$/i.test(rawArgs[0]) &&
  fs.existsSync(rawArgs[0])
) {
  wrapperBin = rawArgs[0];
  argv = rawArgs.slice(1);
} else if (
  rawArgs.length >= 2 &&
  /[\\/]node(\.exe)?$/i.test(rawArgs[0]) &&
  fs.existsSync(rawArgs[0]) &&
  /\.(c?js|mjs)$/i.test(rawArgs[1]) &&
  fs.existsSync(rawArgs[1])
) {
  // node + cli.js: exec node directly, keep cli.js as the first forwarded arg.
  wrapperBin = rawArgs[0];
  argv = rawArgs.slice(1);
}

// Resolve the real claude: explicit override wins, then the extension-provided
// path, then autodetection.
const claude =
  process.env.CLAUDE_REAL_BIN && fs.existsSync(process.env.CLAUDE_REAL_BIN)
    ? process.env.CLAUDE_REAL_BIN
    : wrapperBin || findClaude();
if (!claude) {
  console.error(
    "claudemax: could not find the real 'claude' binary; set CLAUDE_REAL_BIN"
  );
  process.exit(1);
}

// --- Behavior --------------------------------------------------------------
// Set CC_THINKING_DISPLAY=omitted to hide thinking; default shows summaries.
const displayValue = process.env.CC_THINKING_DISPLAY || "summarized";

// --- Optional customizations -----------------------------------------------
//
// Raise reasoning effort - longer, more detailed summaries. Uses more tokens:
//   if (!process.env.CLAUDE_CODE_EFFORT_LEVEL) process.env.CLAUDE_CODE_EFFORT_LEVEL = "xhigh";
//
// Auto mode - let a classifier pick the effort level per task. This is an
// ALTERNATIVE to a fixed effort level above (when auto mode is on, a fixed
// CLAUDE_CODE_EFFORT_LEVEL may be ignored). Another frequently-requested feature:
//   if (!process.env.CLAUDE_CODE_ENABLE_AUTO_MODE) process.env.CLAUDE_CODE_ENABLE_AUTO_MODE = "1";
//
// Longer network timeout for large requests:
//   if (!process.env.API_TIMEOUT_MS) process.env.API_TIMEOUT_MS = "600000";

// --- Inject the thinking-display fix into the launch args -------------------
// Fire on a real agent invocation. Surfaces signal a real run differently:
//   - the VS Code extension passes "--max-thinking-tokens N" (N > 0) plus the
//     stream-json I/O flags, and does NOT pass "--thinking adaptive" or "-p";
//   - the SDK / older extensions pass "--thinking adaptive" (or "enabled");
//   - headless passes "-p" / "--print".
// Skip when thinking is disabled, when --thinking-display is already present
// (no double-inject vs a patched extension), or for subcommands/probes
// (mcp, config, --version, ...), which carry none of these markers.
let haveDisplay = false,
  thinkingAdaptive = false,
  thinkingDisabled = false,
  printMode = false,
  maxThinkingOn = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--thinking-display") haveDisplay = true;
  if (a === "-p" || a === "--print") printMode = true;
  if (a === "--max-thinking-tokens") {
    const v = argv[i + 1];
    if (v && v !== "0") maxThinkingOn = true;
  }
  if (argv[i - 1] === "--thinking") {
    if (a === "adaptive" || a === "enabled") thinkingAdaptive = true;
    if (a === "disabled") thinkingDisabled = true;
  }
}
const args = argv.slice();
if (
  !haveDisplay &&
  !thinkingDisabled &&
  displayValue !== "omitted" &&
  (thinkingAdaptive || printMode || maxThinkingOn)
) {
  args.push("--thinking-display", displayValue);
}

// .cmd/.bat (npm install) need a shell; .exe (native install) is exec'd directly.
const useShell = /\.(cmd|bat)$/i.test(claude);
const res = spawnSync(claude, args, {
  stdio: "inherit",
  env: process.env,
  shell: useShell,
});
process.exit(res.status == null ? 1 : res.status);
