// claudemax.win.js - Windows launcher for Claude Code that combines three
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
//   3. Adds a single-click "Copy as Markdown" icon to every message (and a floating
//      "copy conversation" icon) in the VS Code chat; the icon flips to a checkmark
//      only when the copy truly lands. Like fix #2 there is no env/CLI lever, so this
//      wrapper idempotently appends a self-contained block to the webview bundle
//      (index.js + index.css) each launch; it fails safe (the controls simply do
//      not appear if the markup moves) and survives extension updates.
//
// This single launcher carries every fix, each independently switchable by an
// environment variable (all on by default): CC_THINKING_DISPLAY=omitted (fix 1),
// CC_PATCH_CONTEXT_ICON=0 (fix 2), CC_PATCH_MD_COPY=0 (fix 3). E.g. for thinking
// summaries only, set CC_PATCH_CONTEXT_ICON=0 AND CC_PATCH_MD_COPY=0.
//
// NOTE: unlike fix #1, fixes #2 and #3 DO edit the extension's bundled webview
// files (#2 patches index.js in place; #3 appends a block to index.js + index.css).
// Those edits are idempotent and ownership-marked, snapshotted once to
// index.js.bak-cc-workarounds (emergency restore only), written via a temp file +
// rename, best-effort (it never blocks the launch), reconciled per file every
// launch, and toggle-able with CC_PATCH_CONTEXT_ICON=0 / CC_PATCH_MD_COPY=0 (or
// CC_WORKAROUNDS=0 / CC_RECONCILE=0).
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
//   set CC_PATCH_CONTEXT_ICON=0        leave the context-usage icon as-is (default: 1)
//   set CC_PATCH_MD_COPY=0             no copy controls / webview append (default: 1)
//   set CC_WORKAROUNDS=0               master: disable every fix (default: 1)
//   set CC_RECONCILE=0                 do not touch the webview bundle (default: 1)
//   set CC_SCRUB_ROUTING=1             force the default Anthropic account (default: 0)
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
//   if(t===0)return null;if(c>=50)return null}
//     -> if(c>=101)return null}/*ccwa-context-icon:t:c*/
// `c` is "% of context remaining"; it maxes at 100, so >=101 never fires. Removing
// the t===0 guard keeps the icon visible across a reload gap; it may briefly show
// 0% until the webview receives fresh usage data. Best-effort: every step is
// wrapped so it can never block the launch; a one-time backup is made and the
// write goes through a temp + rename so a failed write leaves the original
// untouched. Re-applied each launch, so an extension update that reinstalls a
// fresh bundle is re-patched next launch.
//
// Maintenance note: this keys off the minified guard pair shape below, not the
// component name or exact minified variable names. If a future build changes that
// shape, the routine safely no-ops until the anchor here is updated.
const ICON_IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";
const ICON_OLD_RE = new RegExp(
  "if\\((" + ICON_IDENT + ")===0\\)return null;if\\((" + ICON_IDENT + ")>=50\\)return null\\}",
  "g"
);
const ICON_MARKED_RE = new RegExp(
  "if\\((" + ICON_IDENT + ")>=101\\)return null\\}/\\*ccwa-context-icon:(" +
    ICON_IDENT +
    "):\\1\\*/",
  "g"
);
const ICON_OLD = "if(t===0)return null;if(c>=50)return null}";
const ICON_LEGACY_MARKER = "/*ccwa-context-icon*/";
const ICON_BARE = "if(c>=101)return null}";
const ICON_NEW = "if(c>=101)return null}/*ccwa-context-icon:t:c*/";
const ICON_LEGACY_NEW_CURRENT = ICON_BARE + ICON_LEGACY_MARKER;
const ICON_LEGACY_BARE = "if(t===0)return null;if(c>=101)return null}";
// Legacy bare (metadata-less) marker on arbitrary guard names: an older
// var-agnostic write could leave the both-guards >=101 form + bare marker on a
// non-t/c build (e.g. Z/U). Match it by shape, not the fixed t/c.
const ICON_LEGACY_NEW_RE = new RegExp(
  "if\\((" +
    ICON_IDENT +
    ")===0\\)return null;if\\((" +
    ICON_IDENT +
    ")>=101\\)return null\\}/\\*ccwa-context-icon\\*/",
  "g"
);

function iconOld(firstVar, remainingVar) {
  return `if(${firstVar}===0)return null;if(${remainingVar}>=50)return null}`;
}

function iconNew(firstVar, remainingVar) {
  return `if(${remainingVar}>=101)return null}/*ccwa-context-icon:${firstVar}:${remainingVar}*/`;
}

// Bundle-patch feature registry. Each feature is idempotent (apply/undo are
// no-ops when their target state already holds) and reversible; undo keys off
// our own fingerprints (the ownership MARKER, plus any legacy unmarked form an
// older version wrote), so it reverses ONLY our own edits. Order matters: apply
// runs forward, undo runs in reverse.
function applyContextIcon(data) {
  if (ICON_MARKED_RE.test(data)) {
    ICON_MARKED_RE.lastIndex = 0;
    return data; // already applied
  }
  ICON_MARKED_RE.lastIndex = 0;
  const base = undoContextIcon(data);
  const matches = Array.from(base.matchAll(ICON_OLD_RE));
  const n = matches.length;
  if (n === 0) {
    console.error(
      "claudemax: context-icon anchor not found (extension changed?); skipping"
    );
    return base;
  }
  if (n !== 1) return base; // ambiguous (version changed) - skip
  return base.replace(ICON_OLD_RE, (_, firstVar, remainingVar) =>
    iconNew(firstVar, remainingVar)
  );
}

function undoContextIcon(data) {
  // Revert our edit to the pristine upstream form. Recognized fingerprints are:
  // the current metadata marker, and legacy marked/bare forms that older
  // versions wrote with fixed t/c names. Marked forms must go first because bare
  // strings are prefixes of marked strings.
  return data
    .replace(ICON_MARKED_RE, (_, remainingVar, firstVar) =>
      iconOld(firstVar, remainingVar)
    )
    .replace(ICON_LEGACY_NEW_RE, (_, firstVar, remainingVar) =>
      iconOld(firstVar, remainingVar)
    )
    .split(ICON_LEGACY_NEW_CURRENT).join(ICON_OLD)
    .split(ICON_LEGACY_BARE).join(ICON_OLD)
    .split(ICON_BARE).join(ICON_OLD)
    // Strip any leftover bare marker so apply is never wedged by an unrecognized
    // form (parity with the bash launcher's final undo pass).
    .replace(/\)return null\}\/\*ccwa-context-icon\*\//g, ")return null}");
}

function contextIconEnabled() {
  if (process.env.CC_WORKAROUNDS === "0") return false;
  return process.env.CC_PATCH_CONTEXT_ICON !== "0";
}

// ---- md-copy: large IIFE appended to index.js + CSS appended to index.css ----
// Bracketed by the sentinel /* cc-md-copy v1 */ ... /* /cc-md-copy v1 */ (its
// ownership marker). apply appends at END-OF-FILE; undo removes exactly that
// OPEN..CLOSE block (marker-scoped, keeps any bytes after CLOSE), so it composes
// with context-icon regardless of ordering. The block is byte-identical to the
// bash/python deliveries. MD_COPY_JS / MD_COPY_CSS are GENERATED by
// tools/gen-embeds (CI drift check: tools/gen-embeds --check); do not edit.
const MD_OPEN = "/* cc-md-copy v1 */";
const MD_CLOSE = "/* /cc-md-copy v1 */";
// >>>CCWA-MD-COPY-EMBED>>> (generated by tools/gen-embeds; do not edit)
const MD_COPY_JS = "/* cc-md-copy: per-message and whole-conversation copy (Markdown) for the\n * Claude Code VS Code webview. Self-contained IIFE appended to webview/index.js.\n * Each control is a single clipboard icon that flips to a checkmark for ~2s when a\n * copy actually succeeds (no text label, no menu). Additive and read-only w.r.t.\n * app state; keyed on stable CSS-module class prefixes, so it fails safe (controls\n * simply do not appear) if a prefix moves.\n * Exposes its pure functions for node unit tests; boot()s only in a real webview. */\n/* Leading ';' so that, appended after the bundle, this IIFE can never be parsed as\n * a call on the bundle's final expression if it lacks a trailing semicolon (ASI\n * safety across extension builds). */\n;(function () {\n  \"use strict\";\n\n  var CONTROL_PREFIX = \"cc-md-copy\"; // every injected node's class starts with this\n  var USER_BUBBLE = '[class*=\"userMessageContainer_\"]';\n  // Assistant message wrapper. Verified on 2.1.170: the render emits exactly one\n  // `data-testid=\"assistant-message\"` div per assistant turn, with the rating\n  // widget and content blocks as its children. (The earlier `[data-message-rating]`\n  // was WRONG: that attribute sits on the nested rating control, which is also only\n  // rendered behind an experiment+analytics gate.) Re-pinned in Task 6.\n  var ASSISTANT_BUBBLE = '[data-testid=\"assistant-message\"]';\n  var MESSAGES_CONTAINER = '[class*=\"messagesContainer_\"]'; // e.g. '[class*=\"timeline_\"]'; \"\" -> observe document.body\n  // Optional narrowing only. MUST be a single wrapper around ALL content blocks,\n  // not a per-block class (a turn has multiple blocks). \"\" -> use the bubble itself\n  // (already aggregates all blocks; sanitizeClone is the correctness gate).\n  var ASSISTANT_CONTENT = \"\";\n  var FEEDBACK_MS = 2000; // how long the checkmark shows after a successful copy\n\n  // ---- HTML -> Markdown (DOM walk) -------------------------------------------\n  // Uses only: nodeType, tagName, childNodes, textContent, getAttribute, className.\n  function htmlToMarkdown(root) {\n    // Longest run of consecutive backticks in s, so a code delimiter/fence can be\n    // chosen longer than anything inside it (else ``` in the content closes early).\n    function backtickRun(s) {\n      var max = 0, cur = 0;\n      for (var i = 0; i < s.length; i++) {\n        if (s.charAt(i) === \"`\") { cur++; if (cur > max) max = cur; } else cur = 0;\n      }\n      return max;\n    }\n    function fence(s, min) { var n = backtickRun(s) + 1; if (n < min) n = min; return new Array(n + 1).join(\"`\"); }\n    function inline(node) {\n      var out = \"\";\n      var kids = node.childNodes || [];\n      for (var i = 0; i < kids.length; i++) {\n        var c = kids[i];\n        if (c.nodeType === 3) { out += c.textContent || \"\"; continue; }\n        if (c.nodeType !== 1) continue;\n        var tag = (c.tagName || \"\").toUpperCase();\n        if (tag === \"BR\") out += \"\\n\";\n        else if (tag === \"STRONG\" || tag === \"B\") out += \"**\" + inline(c) + \"**\";\n        else if (tag === \"EM\" || tag === \"I\") out += \"*\" + inline(c) + \"*\";\n        else if (tag === \"DEL\" || tag === \"S\") out += \"~~\" + inline(c) + \"~~\";\n        else if (tag === \"CODE\") {\n          var ct = c.textContent || \"\";\n          var d = fence(ct, 1);\n          // CommonMark strips one leading+trailing space, so pad when an edge is a\n          // backtick to keep it from merging with the delimiter.\n          var p = (ct.charAt(0) === \"`\" || ct.charAt(ct.length - 1) === \"`\") ? \" \" : \"\";\n          out += d + p + ct + p + d;\n        }\n        else if (tag === \"A\") {\n          var href = c.getAttribute ? c.getAttribute(\"href\") : null;\n          var t = inline(c);\n          out += href ? \"[\" + t + \"](\" + href + \")\" : t;\n        } else out += inline(c); // unknown inline wrapper: keep text, drop tag\n      }\n      return out;\n    }\n    function langOf(codeEl) {\n      var cls = \"\";\n      if (codeEl) cls = (codeEl.getAttribute && codeEl.getAttribute(\"class\")) || codeEl.className || \"\";\n      var m = /language-([A-Za-z0-9+#.\\-]+)/.exec(cls || \"\");\n      return m ? m[1] : \"\";\n    }\n    function findChildTag(node, tag) {\n      var kids = node.childNodes || [];\n      for (var i = 0; i < kids.length; i++) {\n        if (kids[i].nodeType === 1 && (kids[i].tagName || \"\").toUpperCase() === tag) return kids[i];\n      }\n      return null;\n    }\n    function list(node, ordered, depth) {\n      var out = \"\", n = 1;\n      var kids = node.childNodes || [];\n      for (var i = 0; i < kids.length; i++) {\n        var li = kids[i];\n        if (li.nodeType !== 1 || (li.tagName || \"\").toUpperCase() !== \"LI\") continue;\n        var marker = ordered ? n++ + \". \" : \"- \";\n        var indent = new Array(depth + 1).join(\"  \");\n        var lead = \"\", nested = \"\";\n        var lk = li.childNodes || [];\n        for (var j = 0; j < lk.length; j++) {\n          var ch = lk[j];\n          var ct = ch.nodeType === 1 ? (ch.tagName || \"\").toUpperCase() : \"\";\n          if (ct === \"UL\") nested += list(ch, false, depth + 1);\n          else if (ct === \"OL\") nested += list(ch, true, depth + 1);\n          else if (ch.nodeType === 3) lead += ch.textContent || \"\";\n          else lead += inline(ch);\n        }\n        out += indent + marker + lead.trim() + \"\\n\" + nested;\n      }\n      return out;\n    }\n    function table(node) {\n      var rows = [];\n      (function collect(container) {\n        var kids = container.childNodes || [];\n        for (var i = 0; i < kids.length; i++) {\n          var c = kids[i];\n          if (c.nodeType !== 1) continue;\n          var t = (c.tagName || \"\").toUpperCase();\n          if (t === \"THEAD\" || t === \"TBODY\" || t === \"TFOOT\") collect(c);\n          else if (t === \"TR\") {\n            var cells = [], cc = c.childNodes || [];\n            for (var j = 0; j < cc.length; j++) {\n              var d = cc[j];\n              if (d.nodeType !== 1) continue;\n              var dt = (d.tagName || \"\").toUpperCase();\n              if (dt === \"TH\" || dt === \"TD\") cells.push(inline(d).trim());\n            }\n            rows.push(cells);\n          }\n        }\n      })(node);\n      if (!rows.length) return \"\";\n      var head = rows[0], body = rows.slice(1);\n      var sep = head.map(function () { return \"---\"; });\n      var out = \"| \" + head.join(\" | \") + \" |\\n| \" + sep.join(\" | \") + \" |\\n\";\n      for (var k = 0; k < body.length; k++) out += \"| \" + body[k].join(\" | \") + \" |\\n\";\n      return out;\n    }\n    function block(node) {\n      var out = \"\";\n      var kids = node.childNodes || [];\n      for (var i = 0; i < kids.length; i++) {\n        var c = kids[i];\n        if (c.nodeType === 3) { if ((c.textContent || \"\").trim()) out += c.textContent; continue; }\n        if (c.nodeType !== 1) continue;\n        var tag = (c.tagName || \"\").toUpperCase();\n        if (/^H[1-6]$/.test(tag)) out += new Array(+tag[1] + 1).join(\"#\") + \" \" + inline(c).trim() + \"\\n\\n\";\n        else if (tag === \"P\") out += inline(c).trim() + \"\\n\\n\";\n        else if (tag === \"UL\") out += list(c, false, 0) + \"\\n\";\n        else if (tag === \"OL\") out += list(c, true, 0) + \"\\n\";\n        else if (tag === \"PRE\") {\n          var code = findChildTag(c, \"CODE\");\n          var lang = langOf(code || c);\n          var body = (code || c).textContent || \"\";\n          var f = fence(body, 3);\n          out += f + lang + \"\\n\" + body.replace(/\\n$/, \"\") + \"\\n\" + f + \"\\n\\n\";\n        } else if (tag === \"BLOCKQUOTE\") {\n          var inner = block(c).trim().split(\"\\n\").map(function (l) { return \"> \" + l; }).join(\"\\n\");\n          out += inner + \"\\n\\n\";\n        } else if (tag === \"DETAILS\") out += block(c).trim() + \"\\n\\n\";\n        else if (tag === \"SUMMARY\") out += inline(c).trim() + \"\\n\\n\";\n        else if (tag === \"HR\") out += \"---\\n\\n\";\n        else if (tag === \"TABLE\") out += table(c) + \"\\n\";\n        else if (tag === \"BR\") out += \"\\n\";\n        else if (tag === \"STRONG\" || tag === \"B\" || tag === \"EM\" || tag === \"I\" ||\n                 tag === \"A\" || tag === \"CODE\" || tag === \"DEL\" || tag === \"S\")\n          out += inline(c) + \"\\n\\n\";\n        else out += block(c); // unknown wrapper: recurse (drop tag, keep content)\n      }\n      return out;\n    }\n    // block() dispatches on each CHILD's tag, treating the passed node as a plain\n    // container. Wrap root in a one-off container so root's OWN tag is dispatched\n    // too: callers pass either the bubble container (its block children render) or\n    // a single block element like <pre>/<ul>/<table> (now handled, not flattened).\n    return block({ childNodes: [root] }).replace(/\\n{3,}/g, \"\\n\\n\").trim();\n  }\n\n  // ---- pure helpers ----------------------------------------------------------\n  function hasPrefix(node, prefix) {\n    if (node.nodeType !== 1 || typeof node.className !== \"string\") return false;\n    var parts = node.className.split(/\\s+/);\n    for (var i = 0; i < parts.length; i++) if (parts[i].indexOf(prefix) === 0) return true;\n    return false;\n  }\n\n  // Class-prefix hooks for non-content chrome that renders *inside* an assistant\n  // bubble (verified on 2.1.170; Task 6 re-pins these). Tool blocks are excluded\n  // from message copy; thinking summaries are visible content and must remain\n  // copyable. unknownContent_ is the renderer's fallback for unrecognized block\n  // types, so stripping it makes a *future* block type fail safe to excluded rather\n  // than leaking \"Unsupported content\" into the copy. Re-pin if a prefix moves.\n  var CHROME_PREFIXES = [\"toolUse_\", \"toolResult_\", \"toolReference_\", \"unknownContent_\"];\n\n  // True for any node that must never appear in copied output: our own controls,\n  // the rating widget (`data-message-rating` + its \"Thanks for your feedback\"\n  // text), any button (copy-code chrome), and the excluded content blocks above.\n  function isChrome(node) {\n    if (node.nodeType !== 1) return false;\n    if ((node.tagName || \"\").toUpperCase() === \"BUTTON\") return true;\n    if (node.getAttribute && node.getAttribute(\"data-message-rating\") !== null) return true;\n    if (hasPrefix(node, CONTROL_PREFIX)) return true;\n    for (var i = 0; i < CHROME_PREFIXES.length; i++) if (hasPrefix(node, CHROME_PREFIXES[i])) return true;\n    return false;\n  }\n\n  // Deep-clone `contentNode`, then strip every chrome node so copied output is the\n  // message's text content only. This is a CORRECTNESS GATE, not cosmetic: the\n  // default content node is the whole bubble (all content-block siblings, so multi-\n  // block assistant turns are captured), and this strip-list is the only thing\n  // keeping the rating widget and excluded tool/fallback blocks out of the copy.\n  function sanitizeClone(contentNode) {\n    var clone = contentNode.cloneNode(true);\n    (function strip(node) {\n      var kids = Array.prototype.slice.call(node.childNodes || []);\n      for (var i = 0; i < kids.length; i++) {\n        var c = kids[i];\n        if (c.nodeType === 1 && isChrome(c)) { node.removeChild(c); continue; }\n        if (c.nodeType === 1) strip(c);\n      }\n    })(clone);\n    return clone;\n  }\n\n  function hasCopyableContent(contentNode, role) {\n    function walk(node) {\n      if (!node) return false;\n      if (node.nodeType === 3) return !!(node.textContent || \"\").trim();\n      if (node.nodeType !== 1) return false;\n      if (isChrome(node)) return false;\n      var kids = node.childNodes || [];\n      for (var i = 0; i < kids.length; i++) if (walk(kids[i])) return true;\n      return false;\n    }\n    return walk(contentNode);\n  }\n\n  function classifyBubble(node) {\n    if (node.nodeType !== 1) return null;\n    if (hasPrefix(node, \"userMessageContainer_\")) return \"user\";\n    if (node.getAttribute && node.getAttribute(\"data-testid\") === \"assistant-message\") return \"assistant\";\n    return null;\n  }\n\n  // Build the whole-conversation markdown from an ordered list of bubbles.\n  // `contentOf(bubble)` resolves the content node (default: the bubble itself, so\n  // every content block is included; sanitizeClone drops chrome); a default is\n  // provided for tests.\n  function conversationToMarkdown(bubbles, contentOf) {\n    contentOf = contentOf || function (b) { return b; };\n    var parts = [];\n    for (var i = 0; i < bubbles.length; i++) {\n      var role = classifyBubble(bubbles[i]);\n      if (!role) continue;\n      var clean = sanitizeClone(contentOf(bubbles[i]));\n      var body = role === \"assistant\" ? htmlToMarkdown(clean) : (clean.textContent || \"\").trim();\n      if (!body) continue;\n      parts.push((role === \"user\" ? \"## User\" : \"## Assistant\") + \"\\n\\n\" + body);\n    }\n    return parts.join(\"\\n\\n\") + (parts.length ? \"\\n\" : \"\");\n  }\n\n  // ---- exports (node tests) / boot (real webview) ----------------------------\n  if (typeof document !== \"undefined\") {\n    boot();\n  } else if (typeof module !== \"undefined\" && module.exports) {\n    module.exports = { htmlToMarkdown: htmlToMarkdown, sanitizeClone: sanitizeClone,\n                       classifyBubble: classifyBubble, conversationToMarkdown: conversationToMarkdown,\n                       hasCopyableContent: hasCopyableContent, copyText: copyText };\n  }\n\n  // ---- live-webview wiring (runs only when a document exists) ----------------\n  function qs(node, sel) { try { return sel && node.querySelector ? node.querySelector(sel) : null; } catch (_) { return null; } }\n  function qsa(sel) { try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (_) { return []; } }\n\n  // The content node to convert/copy: the optional ASSISTANT_CONTENT wrapper if\n  // pinned and present, else the bubble itself. The bubble already contains every\n  // content-block sibling of a multi-block turn, and sanitizeClone strips the\n  // chrome (rating widget, tool/unknown blocks, buttons, our controls)\n  // either way -- so this is a narrowing, never the thing that guarantees\n  // correctness.\n  function contentNodeOf(bubble, role) {\n    if (role === \"assistant\" && ASSISTANT_CONTENT) {\n      var n = qs(bubble, ASSISTANT_CONTENT);\n      if (n) return n;\n    }\n    return bubble;\n  }\n\n  // Copy `s` via a synchronous execCommand(\"copy\") on an off-screen textarea, and\n  // report whether it actually happened. Done first (and synchronously) because it\n  // runs inside the click gesture and works whether or not the page is a secure\n  // context -- so it covers remote / code-server, where the async Clipboard API is\n  // simply absent. Restores the prior selection/focus so it is invisible.\n  function execCopy(s) {\n    try {\n      if (typeof document === \"undefined\" || !document.createElement) return false;\n      var prev = document.activeElement || null;\n      var sel = document.getSelection ? document.getSelection() : null;\n      var saved = (sel && sel.rangeCount) ? sel.getRangeAt(0) : null;\n      var ta = document.createElement(\"textarea\");\n      ta.value = s;\n      ta.setAttribute(\"readonly\", \"\");\n      ta.style.position = \"fixed\";\n      ta.style.top = \"-1000px\";\n      ta.style.left = \"0\";\n      ta.style.opacity = \"0\";\n      (document.body || document.documentElement).appendChild(ta);\n      ta.focus();\n      ta.select();\n      var ok = false;\n      try { ok = document.execCommand(\"copy\"); } catch (_) { ok = false; }\n      if (ta.parentNode) ta.parentNode.removeChild(ta);\n      if (saved && sel) { try { sel.removeAllRanges(); sel.addRange(saved); } catch (_) {} }\n      if (prev && prev.focus) { try { prev.focus(); } catch (_) {} }\n      return !!ok;\n    } catch (_) { return false; }\n  }\n\n  // Copy `text` and resolve to whether the copy ACTUALLY happened, so callers only\n  // show success on a real copy -- never a false \"copied\" (the original bug:\n  // navigator.clipboard was undefined in the webview, the code fell through to\n  // Promise.resolve(), and the UI claimed success while nothing was written). Empty\n  // text is a non-copy -> false. execCommand first (gesture-safe, secure-context-\n  // independent); the async Clipboard API is the fallback. Never throws.\n  function copyText(text) {\n    var s = (text == null) ? \"\" : String(text);\n    if (!s) return Promise.resolve(false);\n    if (execCopy(s)) return Promise.resolve(true);\n    try {\n      if (typeof navigator !== \"undefined\" && navigator.clipboard && navigator.clipboard.writeText) {\n        return navigator.clipboard.writeText(s).then(\n          function () { return true; },\n          function () { return false; }\n        );\n      }\n    } catch (_) {}\n    return Promise.resolve(false);\n  }\n\n  function bubbleMarkdown(bubble, role) {\n    var clean = sanitizeClone(contentNodeOf(bubble, role));\n    return role === \"assistant\" ? htmlToMarkdown(clean) : (clean.textContent || \"\").trim();\n  }\n\n  // Inline SVG icons (currentColor, ~14px). Set via innerHTML on our own buttons\n  // only; the markup never reaches copied content (sanitizeClone drops our nodes).\n  var ICON_COPY = '<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><rect x=\"9\" y=\"9\" width=\"13\" height=\"13\" rx=\"2\" ry=\"2\"></rect><path d=\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"></path></svg>';\n  var ICON_CHECK = '<svg width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2.5\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\"><polyline points=\"20 6 9 17 4 12\"></polyline></svg>';\n\n  // Flip the button to a checkmark for FEEDBACK_MS, then restore. Idempotent across\n  // rapid clicks (any pending restore is cleared first).\n  function showCopied(btn) {\n    try {\n      if (btn.__ccTimer) clearTimeout(btn.__ccTimer);\n      btn.classList.add(CONTROL_PREFIX + \"-ok\");\n      btn.innerHTML = ICON_CHECK;\n      btn.__ccTimer = setTimeout(function () {\n        try { btn.classList.remove(CONTROL_PREFIX + \"-ok\"); btn.innerHTML = ICON_COPY; } catch (_) {}\n        btn.__ccTimer = null;\n      }, FEEDBACK_MS);\n    } catch (_) {}\n  }\n\n  // Build a single control: one clipboard-icon button. `onCopy()` is invoked\n  // synchronously on click (so the copy stays inside the user gesture) and must\n  // return a Promise<boolean>; the checkmark shows only when it resolves true. All\n  // nodes carry the CONTROL_PREFIX class so sanitizeClone strips them from copies.\n  function buildControl(onCopy, title) {\n    var wrap = document.createElement(\"span\");\n    wrap.className = CONTROL_PREFIX;\n    var btn = document.createElement(\"button\");\n    btn.type = \"button\";\n    btn.className = CONTROL_PREFIX + \"-btn\";\n    btn.title = title || \"Copy as Markdown\";\n    btn.setAttribute(\"aria-label\", btn.title);\n    btn.innerHTML = ICON_COPY;\n    var busy = false;\n    btn.addEventListener(\"click\", function (e) {\n      e.stopPropagation();\n      if (busy) return;\n      busy = true;\n      var p;\n      try { p = onCopy(); } catch (_) { p = false; }\n      Promise.resolve(p).then(\n        function (ok) { busy = false; if (ok) showCopied(btn); },\n        function () { busy = false; }\n      );\n    });\n    wrap.appendChild(btn);\n    return wrap;\n  }\n\n  function decorate(bubble) {\n    try {\n      var role = classifyBubble(bubble);\n      if (!role) return;\n      // Idempotent: keep exactly one control. A React re-render of the bubble can\n      // leave a stale control behind or transiently defeat an \"already decorated\"\n      // guard, which is what produced duplicate rows of buttons; prune any extras\n      // every sweep and only add one when none remain.\n      var existing = bubble.querySelectorAll ? bubble.querySelectorAll(\".\" + CONTROL_PREFIX) : null;\n      if (!hasCopyableContent(contentNodeOf(bubble, role), role)) {\n        if (existing && existing.length) {\n          for (var j = existing.length - 1; j >= 0; j--) {\n            if (existing[j] && existing[j].parentNode) existing[j].parentNode.removeChild(existing[j]);\n          }\n        }\n        return;\n      }\n      if (existing && existing.length) {\n        for (var i = existing.length - 1; i >= 1; i--) {\n          if (existing[i] && existing[i].parentNode) existing[i].parentNode.removeChild(existing[i]);\n        }\n        return;\n      }\n      var control = buildControl(function () {\n        return copyText(bubbleMarkdown(bubble, role));\n      }, \"Copy as Markdown\");\n      bubble.appendChild(control);\n    } catch (_) {}\n  }\n\n  function copyConversation() {\n    var bubbles = qsa(USER_BUBBLE + \",\" + ASSISTANT_BUBBLE);\n    return copyText(conversationToMarkdown(bubbles, function (b) {\n      return contentNodeOf(b, classifyBubble(b));\n    }));\n  }\n\n  // A single floating \"Copy conversation\" icon, present only while a conversation\n  // is open (so it never clutters the history-list view). Pinned top-right by CSS,\n  // clear of the chat input at the bottom; the most-recent-prompt sticky header\n  // sits to its left.\n  function installConversationControl() {\n    try {\n      var existing = qs(document, \".\" + CONTROL_PREFIX + \"-conversation\");\n      var hasMessages = qsa(USER_BUBBLE + \",\" + ASSISTANT_BUBBLE).length > 0;\n      if (!hasMessages) {\n        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);\n        return;\n      }\n      if (existing) return;\n      var bar = document.createElement(\"div\");\n      bar.className = CONTROL_PREFIX + \"-conversation\";\n      bar.appendChild(buildControl(copyConversation, \"Copy conversation\"));\n      document.body.appendChild(bar);\n    } catch (_) {}\n  }\n\n  function sweep() {\n    var b = qsa(USER_BUBBLE + \",\" + ASSISTANT_BUBBLE);\n    for (var i = 0; i < b.length; i++) decorate(b[i]);\n    installConversationControl();\n  }\n\n  function boot() {\n    try {\n      var target = (MESSAGES_CONTAINER && qs(document, MESSAGES_CONTAINER)) || document.body;\n      sweep();\n      if (typeof MutationObserver === \"undefined\") return;\n      var obs = new MutationObserver(function () { sweep(); });\n      obs.observe(target, { childList: true, subtree: true });\n    } catch (_) {}\n  }\n})();\n";
const MD_COPY_CSS = ".cc-md-copy {\n  display: inline-flex;\n  align-items: center;\n  vertical-align: middle;\n  margin-left: 6px;\n}\n.cc-md-copy-btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  padding: 2px;\n  color: var(--vscode-foreground);\n  background: transparent;\n  border: none;\n  border-radius: 4px;\n  cursor: pointer;\n  opacity: 0.6;\n}\n.cc-md-copy-btn svg {\n  display: block;\n  width: 14px;\n  height: 14px;\n}\n.cc-md-copy-btn:hover {\n  opacity: 1;\n  background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));\n}\n/* Success state: the icon is a green checkmark for a moment after a real copy. */\n.cc-md-copy-btn.cc-md-copy-ok,\n.cc-md-copy-btn.cc-md-copy-ok:hover {\n  opacity: 1;\n  color: var(--vscode-charts-green, var(--vscode-testing-iconPassed, #89d185));\n  background: transparent;\n}\n/* Whole-conversation copy: a single floating icon pinned to the top-right corner,\n   clear of the chat input at the bottom. Shown only while a conversation is open\n   (the IIFE adds/removes it). Nudge top/right here if it crowds the sticky header. */\n.cc-md-copy-conversation {\n  position: fixed;\n  top: 26px;\n  right: 4px;\n  z-index: 30;\n  display: inline-flex;\n  padding: 2px;\n  background: var(--vscode-editorWidget-background);\n  border: 1px solid var(--vscode-widget-border, transparent);\n  border-radius: 6px;\n  opacity: 0.85;\n}\n.cc-md-copy-conversation .cc-md-copy {\n  margin-left: 0;\n}\n.cc-md-copy-conversation:hover {\n  opacity: 1;\n}\n";
// <<<CCWA-MD-COPY-EMBED<<<

function mdBlock(payload) {
  return "\n" + MD_OPEN + "\n" + payload.replace(/\n+$/, "") + "\n" + MD_CLOSE + "\n";
}
function applyMdCopy(data, payload) {
  if (data.indexOf(MD_OPEN) !== -1) return data; // already applied
  if (!payload) return data; // embed not generated -> no-op
  return data + mdBlock(payload);
}
function undoMdCopy(data) {
  // Marker-scoped block removal (same algorithm as the bash/python deliveries):
  // remove exactly our OPEN..CLOSE block plus the separator newline apply added,
  // and KEEP any bytes after CLOSE. This makes undo independent of file ordering,
  // so it composes with context-icon and any future end-of-file append feature.
  var oi = data.indexOf(MD_OPEN);
  if (oi === -1) return data; // nothing of ours
  var ci = data.indexOf(MD_CLOSE, oi);
  if (ci === -1) return data; // malformed (open without close) -> leave file intact
  var start = oi > 0 && data.charAt(oi - 1) === "\n" ? oi - 1 : oi; // drop the separator newline
  var end = ci + MD_CLOSE.length;
  if (data.charAt(end) === "\n") end += 1; // drop the one trailing newline apply added
  return data.slice(0, start) + data.slice(end);
}
function mdCopyEnabled() {
  if (process.env.CC_WORKAROUNDS === "0") return false;
  return process.env.CC_PATCH_MD_COPY !== "0";
}

// Per-file feature lists. index.js: context-icon (in-place) then md-copy (append,
// registered LAST). index.css: md-copy (append) only. apply runs forward, undo
// reverse. md-copy binds the matching payload per file.
const contextIconFeature = {
  id: "context-icon", enabled: contextIconEnabled, apply: applyContextIcon, undo: undoContextIcon,
};
const mdCopyJsFeature = {
  id: "md-copy", enabled: mdCopyEnabled, apply: function (d) { return applyMdCopy(d, MD_COPY_JS); }, undo: undoMdCopy,
};
const mdCopyCssFeature = {
  id: "md-copy", enabled: mdCopyEnabled, apply: function (d) { return applyMdCopy(d, MD_COPY_CSS); }, undo: undoMdCopy,
};
const FILE_FEATURES = {
  "index.js": [contextIconFeature, mdCopyJsFeature],
  "index.css": [mdCopyCssFeature],
};

// Reconcile one file against its feature list: undo every feature (reverse),
// re-apply enabled ones (forward), write only when the bytes change. Best-effort.
function reconcileFile(file, features) {
  try {
    if (!fs.existsSync(file)) return;
    let current;
    try {
      current = fs.readFileSync(file, "utf8");
    } catch (_) {
      return; // not readable
    }
    let base = current;
    for (let i = features.length - 1; i >= 0; i--) base = features[i].undo(base);
    let desired = base;
    for (const feat of features) if (feat.enabled()) desired = feat.apply(desired);
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
  const dirs = new Set();
  if (binPath) {
    const root = extensionRootFromBinary(binPath);
    if (root) dirs.add(path.join(root, "webview"));
  }
  for (const f of scanExtensionIndexes()) dirs.add(path.dirname(f));
  for (const dir of dirs) {
    reconcileFile(path.join(dir, "index.js"), FILE_FEATURES["index.js"]);
    reconcileFile(path.join(dir, "index.css"), FILE_FEATURES["index.css"]);
  }
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

// --- Routing scrub + local environment -------------------------------------
// CC_SCRUB_ROUTING=1 clears third-party model-routing variables before launch so
// Claude Code always uses the default Anthropic account. Useful when you also run
// wrappers (e.g. a DeepSeek launcher) that set ANTHROPIC_BASE_URL /
// ANTHROPIC_AUTH_TOKEN / *_MODEL. Default off: leave the environment as-is.
if (process.env.CC_SCRUB_ROUTING && process.env.CC_SCRUB_ROUTING !== "0") {
  for (const k of [
    "CLAUDE_CONFIG_DIR",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "CLAUDE_CODE_SUBAGENT_MODEL",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_SUPPORTED_CAPABILITIES",
  ]) {
    delete process.env[k];
  }
}

// Personal/local environment for a custom build. The marker pair below is a
// stable splice point: build.ps1 injects a private env file here before pkg
// compiles the launcher, so a personal .exe never needs hand-edited source.
// Put process.env.* assignments between the markers; coming after the scrub,
// they win over it. Example:
//   if (!process.env.CLAUDE_CODE_EFFORT_LEVEL) process.env.CLAUDE_CODE_EFFORT_LEVEL = "max";
// >>> ccwa-local-env >>>
// <<< ccwa-local-env <<<

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

// Reconcile the webview before handing off (best-effort; never throws). Walk up
// from the resolved binary - wrapperBin when the extension handed us one, else
// the CLAUDE_REAL_BIN/autodetected `claude` - so an extension whose root sits
// outside the HOME fallback scan is still reached (parity with the bash walk
// from REAL_CLAUDE).
reconcile(wrapperBin || claude);

const invocation = resolveClaudeInvocation(claude, args);
if (!invocation) process.exit(1);
const res = spawnSync(invocation.command, invocation.args, {
  stdio: "inherit",
  env: process.env,
  shell: false,
});
process.exit(res.status == null ? 1 : res.status);
