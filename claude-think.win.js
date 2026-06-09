// claude-think.win.js - Windows launcher for Claude Code that restores
// extended-thinking summaries on Opus 4.7 / 4.8, where the "Thinking" section
// otherwise renders empty.
//
// Thinking-only variant. To ALSO restore the always-visible context-usage icon,
// use claudemax (both fixes combined); for the icon fix alone, use
// claude-context. All three are drop-in process wrappers and differ only in what
// they inject/patch.
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
// "claudeCodeChat.executable.path") to claude-think.exe and reload the window, or
// run claude-think.exe in place of claude in a terminal. In a multi-root
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
//   pkg claude-think.win.js --targets node18-win-x64 --output claude-think.exe

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

function findExecutableOnPath(name) {
  const lookup = process.platform === "win32" ? "where" : "which";
  try {
    const out = execFileSync(lookup, [name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const hit = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && fs.existsSync(s));
    if (hit) return hit;
  } catch (_) {
    /* not on PATH */
  }
  return null;
}

function expandShimPath(raw, shimDir) {
  let s = raw.trim().replace(/^["']|["']$/g, "");
  s = s.replace(/%~?dp0%?/gi, shimDir + path.sep);
  s = s.replace(/%([^%]+)%/g, (m, name) => process.env[name] || m);
  return path.isAbsolute(s) ? s : path.resolve(shimDir, s);
}

function resolveShimEntrypoint(shim) {
  const shimDir = path.dirname(path.resolve(shim));
  const candidates = [
    path.join(shimDir, "node_modules", "@anthropic-ai", "claude-code", "cli.js"),
    path.resolve(shimDir, "..", "@anthropic-ai", "claude-code", "cli.js"),
    path.resolve(
      shimDir,
      "..",
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js"
    ),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  try {
    const data = fs.readFileSync(shim, "utf8");
    const matches = data.matchAll(
      /(?:"([^"]+?\.js)"|'([^']+?\.js)'|([^\s"']+?\.js))/gi
    );
    for (const m of matches) {
      const hit = expandShimPath(m[1] || m[2] || m[3], shimDir);
      if (fs.existsSync(hit)) return hit;
    }
  } catch (_) {
    /* unreadable shim */
  }
  return null;
}

function resolveNodeForShim(shim) {
  const shimDir = path.dirname(path.resolve(shim));
  const candidates = [
    process.env.CC_NODE_BIN,
    path.join(shimDir, "node.exe"),
    path.join(shimDir, "node"),
    process.pkg ? null : process.execPath,
    findExecutableOnPath("node"),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveClaudeInvocation(command, args) {
  if (!/\.(cmd|bat)$/i.test(command)) return { command, args };
  const cli = resolveShimEntrypoint(command);
  const node = resolveNodeForShim(command);
  if (cli && node) return { command: node, args: [cli, ...args] };
  console.error(
    "claude-think: refusing to launch unresolved .cmd/.bat shim without a shell; set CLAUDE_REAL_BIN to claude.exe or CC_NODE_BIN to node.exe"
  );
  return null;
}

function normalizeDisplayValue(value) {
  if (value === "summarized" || value === "omitted") return value;
  console.error(
    `claude-think: invalid CC_THINKING_DISPLAY=${value}; using summarized`
  );
  return "summarized";
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
    "claude-think: could not find the real 'claude' binary; set CLAUDE_REAL_BIN"
  );
  process.exit(1);
}

// --- Behavior --------------------------------------------------------------
// Set CC_THINKING_DISPLAY=omitted to hide thinking; default shows summaries.
const displayValue = normalizeDisplayValue(
  process.env.CC_THINKING_DISPLAY || "summarized"
);

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
  if (a === "--thinking-display" || a.startsWith("--thinking-display=")) {
    haveDisplay = true;
  }
  if (a === "-p" || a === "--print") printMode = true;
  if (a === "--thinking=adaptive" || a === "--thinking=enabled") {
    thinkingAdaptive = true;
  }
  if (a === "--thinking=disabled") thinkingDisabled = true;
  if (a.startsWith("--max-thinking-tokens=")) {
    const v = a.slice("--max-thinking-tokens=".length);
    if (v && v !== "0") maxThinkingOn = true;
  }
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

const invocation = resolveClaudeInvocation(claude, args);
if (!invocation) process.exit(1);
const res = spawnSync(invocation.command, invocation.args, {
  stdio: "inherit",
  env: process.env,
  shell: false,
});
process.exit(res.status == null ? 1 : res.status);
