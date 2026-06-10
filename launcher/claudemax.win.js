// claudemax.win.js - Windows launcher for Claude Code that combines TWO
// unofficial fixes:
//
//   1. Restores extended-thinking summaries on Opus 4.7 / 4.8, where the
//      "Thinking" section otherwise renders empty in the VS Code extension and
//      headless -p/SDK. Done by injecting `--thinking-display summarized` into
//      the launch args (the one lever that is NOT interactivity-gated). Edits
//      nothing.
//   2. Restores the always-visible context-usage icon in the VS Code chat input.
//      Recent extension builds (2.1.165+) hide that icon until you have used
//      >50% of the context window; with the 1M window that is ~500k tokens, so it
//      is effectively never shown. There is no env/CLI lever, so (unlike fix #1)
//      this wrapper idempotently patches the extension's webview bundle on each
//      launch, flipping the threshold so the icon shows at any usage level.
//      Because it re-applies every launch, it survives extension updates.
//
// This is the "both fixes" variant. For thinking-only use claude-think.exe; for
// the context-icon fix alone use claude-context.exe. All three are drop-in
// process wrappers and differ only in what they inject/patch.
//
// NOTE: unlike fix #1, fix #2 DOES edit the extension's bundled webview/index.js.
// That edit is idempotent, backed up once to index.js.bak-context-icon, written
// via a temp file + rename, best-effort (it never blocks the launch), and
// toggle-able with CC_PATCH_CONTEXT_ICON=0.
//
// Use it: set the official "Claude Code" extension's "claudeCode.claudeProcessWrapper"
// setting (or the third-party "Claude Code Chat" extension's
// "claudeCodeChat.executable.path") to claudemax.exe and reload the window, or
// run claudemax.exe in place of claude in a terminal. In a multi-root
// .code-workspace, claudeProcessWrapper is window-scoped: put it in the
// workspace file's "settings" block (or User settings), not a folder's
// .vscode/settings.json.
//
// Toggle off:
//   set CC_THINKING_DISPLAY=omitted    hide thinking summaries (default: summarized)
//   set CC_PATCH_CONTEXT_ICON=0        leave the extension webview untouched (default: 1)
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
    "claudemax: refusing to launch unresolved .cmd/.bat shim without a shell; set CLAUDE_REAL_BIN to claude.exe or CC_NODE_BIN to node.exe"
  );
  return null;
}

function normalizeDisplayValue(value) {
  if (value === "summarized" || value === "omitted") return value;
  console.error(
    `claudemax: invalid CC_THINKING_DISPLAY=${value}; using summarized`
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
    "claudemax: could not find the real 'claude' binary; set CLAUDE_REAL_BIN"
  );
  process.exit(1);
}

// --- Restore the always-visible context-usage icon (patches the webview) ----
//
// Idempotent edit to component `FJe` in the extension's webview/index.js:
//   if(c>=50)return null   ->   if(c>=101)return null
// `c` is "% of context remaining"; it maxes at 100, so >=101 never fires and the
// icon renders whenever a context window is known (the t===0 "no session yet"
// guard is left intact). Best-effort: every step is wrapped so it can never block
// the launch; a one-time backup is made and the write goes through a temp + rename
// so a failed write leaves the original untouched. Re-applied each launch, so an
// extension update that reinstalls a fresh bundle is re-patched next launch.
//
// Maintenance note: this keys off the stable string ">=50)return null}", not the
// minified component name. If a future build changes that exact substring, the
// routine safely no-ops until the anchor here is updated.
const ICON_OLD = ">=50)return null}";
const ICON_MARKER = "/*ccwa-context-icon*/";
const ICON_NEW = ">=101)return null}" + ICON_MARKER;

// Bundle-patch feature registry. Each feature is idempotent (apply/undo are
// no-ops when their target state already holds) and reversible; undo keys off
// the ownership MARKER only, so it reverses ONLY our own edits. Order matters:
// apply runs forward, undo runs in reverse.
function applyContextIcon(data) {
  if (data.indexOf(ICON_MARKER) !== -1) return data; // already applied
  const n = data.split(ICON_OLD).length - 1;
  if (n === 0) {
    console.error(
      "claudemax: context-icon anchor not found (extension changed?); skipping"
    );
    return data;
  }
  if (n !== 1) return data; // ambiguous (version changed) - skip
  return data.replace(ICON_OLD, ICON_NEW);
}

function undoContextIcon(data) {
  if (data.indexOf(ICON_MARKER) === -1) return data; // nothing of ours
  return data.split(ICON_NEW).join(ICON_OLD);
}

function contextIconEnabled() {
  if (process.env.CC_WORKAROUNDS === "0") return false;
  return process.env.CC_PATCH_CONTEXT_ICON !== "0";
}

const BUNDLE_FEATURES = [
  {
    id: "context-icon",
    enabled: contextIconEnabled,
    apply: applyContextIcon,
    undo: undoContextIcon,
  },
];

// Reconcile one file: undo every known feature (reverse), re-apply enabled ones
// (forward), write only when the bytes change. Best-effort; never throws.
function reconcileIndexJs(file) {
  try {
    if (!fs.existsSync(file)) return;
    let current;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch (_) {
      return; // not readable
    }
    let base = current;
    for (let i = BUNDLE_FEATURES.length - 1; i >= 0; i--) {
      base = BUNDLE_FEATURES[i].undo(base);
    }
    let desired = base;
    for (const feat of BUNDLE_FEATURES) {
      if (feat.enabled()) desired = feat.apply(desired);
    }
    if (desired === current) return; // idempotent: nothing to write
    const bak = file + ".bak-cc-workarounds";
    if (!fs.existsSync(bak)) {
      try {
        fs.writeFileSync(bak, base); // pristine snapshot, emergency-only
      } catch (_) {
        /* best-effort backup */
      }
    }
    const tmp = file + ".ccpatch." + process.pid;
    try {
      fs.writeFileSync(tmp, desired);
      fs.renameSync(tmp, file); // atomic on the same volume
    } catch (_) {
      try {
        fs.unlinkSync(tmp);
      } catch (_) {
        /* nothing to clean up */
      }
    }
  } catch (_) {
    /* never block the launch */
  }
}

// Most precise target: walk up from the real binary path the extension handed us
// (its bundled resources\native-binary\claude.exe) to a dir named
// anthropic.claude-code-*, then <root>\webview\index.js.
function extensionRootFromBinary(binPath) {
  try {
    let d = path.dirname(path.resolve(binPath));
    let prev = null;
    while (d && d !== prev) {
      if (/^anthropic\.claude-code-/i.test(path.basename(d))) return d;
      prev = d;
      d = path.dirname(d);
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

// Fallback: scan this user's VS Code extension dirs for any installed build.
function scanExtensionIndexes() {
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const bases = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".vscode-insiders", "extensions"),
    path.join(home, ".vscode-server", "extensions"),
    path.join(home, ".vscode-server-insiders", "extensions"),
  ];
  const found = [];
  for (const base of bases) {
    let entries;
    try {
      entries = fs.readdirSync(base);
    } catch (_) {
      continue; // dir doesn't exist
    }
    for (const name of entries) {
      if (/^anthropic\.claude-code-/i.test(name)) {
        found.push(path.join(base, name, "webview", "index.js"));
      }
    }
  }
  return found;
}

function reconcile(binPath) {
  if (process.env.CC_RECONCILE === "0") return; // emergency bypass: touch nothing
  const targets = new Set();
  if (binPath) {
    const root = extensionRootFromBinary(binPath);
    if (root) targets.add(path.join(root, "webview", "index.js"));
  }
  for (const f of scanExtensionIndexes()) targets.add(f);
  for (const f of targets) reconcileIndexJs(f);
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
  process.env.CC_WORKAROUNDS !== "0" &&
  !haveDisplay &&
  !thinkingDisabled &&
  displayValue !== "omitted" &&
  (thinkingAdaptive || printMode || maxThinkingOn)
) {
  args.push("--thinking-display", displayValue);
}

// Reconcile the webview before handing off (best-effort; never throws).
reconcile(wrapperBin);

const invocation = resolveClaudeInvocation(claude, args);
if (!invocation) process.exit(1);
const res = spawnSync(invocation.command, invocation.args, {
  stdio: "inherit",
  env: process.env,
  shell: false,
});
process.exit(res.status == null ? 1 : res.status);
