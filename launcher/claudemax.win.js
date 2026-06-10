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
//   3. Adds per-message and whole-conversation "Copy" controls (Markdown / plain
//      text) to the VS Code chat. Like fix #2 there is no env/CLI lever, so this
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
const ICON_BARE = ">=101)return null}"; // legacy unmarked form (older launcher/standalone)
const ICON_NEW = ICON_BARE + ICON_MARKER;

// Bundle-patch feature registry. Each feature is idempotent (apply/undo are
// no-ops when their target state already holds) and reversible; undo keys off
// our own fingerprints (the ownership MARKER, plus any legacy unmarked form an
// older version wrote), so it reverses ONLY our own edits. Order matters: apply
// runs forward, undo runs in reverse.
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
  // Revert our edit to the pristine upstream form. Two ownership fingerprints
  // are recognized: the current MARKED form, and the legacy BARE form older
  // versions wrote before the marker existed. ICON_BARE is dead upstream code
  // (c maxes at 100), so it appears only as our own output; adopting it lets a
  // legacy install revert/upgrade cleanly. Marked must go first: ICON_BARE is a
  // prefix of ICON_NEW.
  return data.split(ICON_NEW).join(ICON_OLD).split(ICON_BARE).join(ICON_OLD);
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
const MD_COPY_JS = "/* cc-md-copy: per-message and whole-conversation copy (markdown/plain) for the\n * Claude Code VS Code webview. Self-contained IIFE appended to webview/index.js.\n * Additive and read-only w.r.t. app state; keyed on stable CSS-module class\n * prefixes, so it fails safe (controls simply do not appear) if a prefix moves.\n * Exposes its pure functions for node unit tests; boot()s only in a real webview. */\n(function () {\n  \"use strict\";\n\n  var CONTROL_PREFIX = \"cc-md-copy\"; // every injected node's class starts with this\n  var USER_BUBBLE = '[class*=\"userMessageContainer_\"]';\n  // Assistant message wrapper. Verified on 2.1.170: the render emits exactly one\n  // `data-testid=\"assistant-message\"` div per assistant turn, with the rating\n  // widget and content blocks as its children. (The earlier `[data-message-rating]`\n  // was WRONG: that attribute sits on the nested rating control, which is also only\n  // rendered behind an experiment+analytics gate.) Re-pinned in Task 6.\n  var ASSISTANT_BUBBLE = '[data-testid=\"assistant-message\"]';\n  var MESSAGES_CONTAINER = '[class*=\"messagesContainer_\"]'; // e.g. '[class*=\"timeline_\"]'; \"\" -> observe document.body\n  // Optional narrowing only. MUST be a single wrapper around ALL content blocks,\n  // not a per-block class (a turn has multiple blocks). \"\" -> use the bubble itself\n  // (already aggregates all blocks; sanitizeClone is the correctness gate).\n  var ASSISTANT_CONTENT = \"\";\n  var FEEDBACK_MS = 1800;\n\n  // ---- HTML -> Markdown (DOM walk) -------------------------------------------\n  // Uses only: nodeType, tagName, childNodes, textContent, getAttribute, className.\n  function htmlToMarkdown(root) {\n    // Longest run of consecutive backticks in s, so a code delimiter/fence can be\n    // chosen longer than anything inside it (else ``` in the content closes early).\n    function backtickRun(s) {\n      var max = 0, cur = 0;\n      for (var i = 0; i < s.length; i++) {\n        if (s.charAt(i) === \"`\") { cur++; if (cur > max) max = cur; } else cur = 0;\n      }\n      return max;\n    }\n    function fence(s, min) { var n = backtickRun(s) + 1; if (n < min) n = min; return new Array(n + 1).join(\"`\"); }\n    function inline(node) {\n      var out = \"\";\n      var kids = node.childNodes || [];\n      for (var i = 0; i < kids.length; i++) {\n        var c = kids[i];\n        if (c.nodeType === 3) { out += c.textContent || \"\"; continue; }\n        if (c.nodeType !== 1) continue;\n        var tag = (c.tagName || \"\").toUpperCase();\n        if (tag === \"BR\") out += \"\\n\";\n        else if (tag === \"STRONG\" || tag === \"B\") out += \"**\" + inline(c) + \"**\";\n        else if (tag === \"EM\" || tag === \"I\") out += \"*\" + inline(c) + \"*\";\n        else if (tag === \"DEL\" || tag === \"S\") out += \"~~\" + inline(c) + \"~~\";\n        else if (tag === \"CODE\") {\n          var ct = c.textContent || \"\";\n          var d = fence(ct, 1);\n          // CommonMark strips one leading+trailing space, so pad when an edge is a\n          // backtick to keep it from merging with the delimiter.\n          var p = (ct.charAt(0) === \"`\" || ct.charAt(ct.length - 1) === \"`\") ? \" \" : \"\";\n          out += d + p + ct + p + d;\n        }\n        else if (tag === \"A\") {\n          var href = c.getAttribute ? c.getAttribute(\"href\") : null;\n          var t = inline(c);\n          out += href ? \"[\" + t + \"](\" + href + \")\" : t;\n        } else out += inline(c); // unknown inline wrapper: keep text, drop tag\n      }\n      return out;\n    }\n    function langOf(codeEl) {\n      var cls = \"\";\n      if (codeEl) cls = (codeEl.getAttribute && codeEl.getAttribute(\"class\")) || codeEl.className || \"\";\n      var m = /language-([A-Za-z0-9+#.\\-]+)/.exec(cls || \"\");\n      return m ? m[1] : \"\";\n    }\n    function findChildTag(node, tag) {\n      var kids = node.childNodes || [];\n      for (var i = 0; i < kids.length; i++) {\n        if (kids[i].nodeType === 1 && (kids[i].tagName || \"\").toUpperCase() === tag) return kids[i];\n      }\n      return null;\n    }\n    function list(node, ordered, depth) {\n      var out = \"\", n = 1;\n      var kids = node.childNodes || [];\n      for (var i = 0; i < kids.length; i++) {\n        var li = kids[i];\n        if (li.nodeType !== 1 || (li.tagName || \"\").toUpperCase() !== \"LI\") continue;\n        var marker = ordered ? n++ + \". \" : \"- \";\n        var indent = new Array(depth + 1).join(\"  \");\n        var lead = \"\", nested = \"\";\n        var lk = li.childNodes || [];\n        for (var j = 0; j < lk.length; j++) {\n          var ch = lk[j];\n          var ct = ch.nodeType === 1 ? (ch.tagName || \"\").toUpperCase() : \"\";\n          if (ct === \"UL\") nested += list(ch, false, depth + 1);\n          else if (ct === \"OL\") nested += list(ch, true, depth + 1);\n          else if (ch.nodeType === 3) lead += ch.textContent || \"\";\n          else lead += inline(ch);\n        }\n        out += indent + marker + lead.trim() + \"\\n\" + nested;\n      }\n      return out;\n    }\n    function table(node) {\n      var rows = [];\n      (function collect(container) {\n        var kids = container.childNodes || [];\n        for (var i = 0; i < kids.length; i++) {\n          var c = kids[i];\n          if (c.nodeType !== 1) continue;\n          var t = (c.tagName || \"\").toUpperCase();\n          if (t === \"THEAD\" || t === \"TBODY\" || t === \"TFOOT\") collect(c);\n          else if (t === \"TR\") {\n            var cells = [], cc = c.childNodes || [];\n            for (var j = 0; j < cc.length; j++) {\n              var d = cc[j];\n              if (d.nodeType !== 1) continue;\n              var dt = (d.tagName || \"\").toUpperCase();\n              if (dt === \"TH\" || dt === \"TD\") cells.push(inline(d).trim());\n            }\n            rows.push(cells);\n          }\n        }\n      })(node);\n      if (!rows.length) return \"\";\n      var head = rows[0], body = rows.slice(1);\n      var sep = head.map(function () { return \"---\"; });\n      var out = \"| \" + head.join(\" | \") + \" |\\n| \" + sep.join(\" | \") + \" |\\n\";\n      for (var k = 0; k < body.length; k++) out += \"| \" + body[k].join(\" | \") + \" |\\n\";\n      return out;\n    }\n    function block(node) {\n      var out = \"\";\n      var kids = node.childNodes || [];\n      for (var i = 0; i < kids.length; i++) {\n        var c = kids[i];\n        if (c.nodeType === 3) { if ((c.textContent || \"\").trim()) out += c.textContent; continue; }\n        if (c.nodeType !== 1) continue;\n        var tag = (c.tagName || \"\").toUpperCase();\n        if (/^H[1-6]$/.test(tag)) out += new Array(+tag[1] + 1).join(\"#\") + \" \" + inline(c).trim() + \"\\n\\n\";\n        else if (tag === \"P\") out += inline(c).trim() + \"\\n\\n\";\n        else if (tag === \"UL\") out += list(c, false, 0) + \"\\n\";\n        else if (tag === \"OL\") out += list(c, true, 0) + \"\\n\";\n        else if (tag === \"PRE\") {\n          var code = findChildTag(c, \"CODE\");\n          var lang = langOf(code || c);\n          var body = (code || c).textContent || \"\";\n          var f = fence(body, 3);\n          out += f + lang + \"\\n\" + body.replace(/\\n$/, \"\") + \"\\n\" + f + \"\\n\\n\";\n        } else if (tag === \"BLOCKQUOTE\") {\n          var inner = block(c).trim().split(\"\\n\").map(function (l) { return \"> \" + l; }).join(\"\\n\");\n          out += inner + \"\\n\\n\";\n        } else if (tag === \"HR\") out += \"---\\n\\n\";\n        else if (tag === \"TABLE\") out += table(c) + \"\\n\";\n        else if (tag === \"BR\") out += \"\\n\";\n        else if (tag === \"STRONG\" || tag === \"B\" || tag === \"EM\" || tag === \"I\" ||\n                 tag === \"A\" || tag === \"CODE\" || tag === \"DEL\" || tag === \"S\")\n          out += inline(c) + \"\\n\\n\";\n        else out += block(c); // unknown wrapper: recurse (drop tag, keep content)\n      }\n      return out;\n    }\n    // block() dispatches on each CHILD's tag, treating the passed node as a plain\n    // container. Wrap root in a one-off container so root's OWN tag is dispatched\n    // too: callers pass either the bubble container (its block children render) or\n    // a single block element like <pre>/<ul>/<table> (now handled, not flattened).\n    return block({ childNodes: [root] }).replace(/\\n{3,}/g, \"\\n\\n\").trim();\n  }\n\n  // ---- pure helpers ----------------------------------------------------------\n  function hasPrefix(node, prefix) {\n    if (node.nodeType !== 1 || typeof node.className !== \"string\") return false;\n    var parts = node.className.split(/\\s+/);\n    for (var i = 0; i < parts.length; i++) if (parts[i].indexOf(prefix) === 0) return true;\n    return false;\n  }\n\n  // Class-prefix hooks for non-content chrome that renders *inside* an assistant\n  // bubble (verified on 2.1.170; Task 6 re-pins these). tool*/thinking_ are the v1\n  // exclusions; unknownContent_ is the renderer's fallback for unrecognized block\n  // types, so stripping it makes a *future* block type fail safe to excluded rather\n  // than leaking \"Unsupported content\" into the copy. Re-pin if a prefix moves.\n  var CHROME_PREFIXES = [\"toolUse_\", \"toolResult_\", \"toolReference_\", \"thinking_\", \"unknownContent_\"];\n\n  // True for any node that must never appear in copied output: our own controls,\n  // the rating widget (`data-message-rating` + its \"Thanks for your feedback\"\n  // text), any button (copy-code chrome), and the excluded content blocks above.\n  function isChrome(node) {\n    if (node.nodeType !== 1) return false;\n    if ((node.tagName || \"\").toUpperCase() === \"BUTTON\") return true;\n    if (node.getAttribute && node.getAttribute(\"data-message-rating\") !== null) return true;\n    if (hasPrefix(node, CONTROL_PREFIX)) return true;\n    for (var i = 0; i < CHROME_PREFIXES.length; i++) if (hasPrefix(node, CHROME_PREFIXES[i])) return true;\n    return false;\n  }\n\n  // Deep-clone `contentNode`, then strip every chrome node so copied output is the\n  // message's text content only. This is a CORRECTNESS GATE, not cosmetic: the\n  // default content node is the whole bubble (all content-block siblings, so multi-\n  // block assistant turns are captured), and this strip-list is the only thing\n  // keeping the rating widget and v1-excluded blocks out of the copy.\n  function sanitizeClone(contentNode) {\n    var clone = contentNode.cloneNode(true);\n    (function strip(node) {\n      var kids = (node.childNodes || []).slice();\n      for (var i = 0; i < kids.length; i++) {\n        var c = kids[i];\n        if (c.nodeType === 1 && isChrome(c)) { node.removeChild(c); continue; }\n        if (c.nodeType === 1) strip(c);\n      }\n    })(clone);\n    return clone;\n  }\n\n  function classifyBubble(node) {\n    if (node.nodeType !== 1) return null;\n    if (hasPrefix(node, \"userMessageContainer_\")) return \"user\";\n    if (node.getAttribute && node.getAttribute(\"data-testid\") === \"assistant-message\") return \"assistant\";\n    return null;\n  }\n\n  // Build the whole-conversation markdown from an ordered list of bubbles.\n  // `contentOf(bubble)` resolves the content node (default: the bubble itself, so\n  // every content block is included; sanitizeClone drops chrome); a default is\n  // provided for tests.\n  function conversationToMarkdown(bubbles, contentOf) {\n    contentOf = contentOf || function (b) { return b; };\n    var parts = [];\n    for (var i = 0; i < bubbles.length; i++) {\n      var role = classifyBubble(bubbles[i]);\n      if (!role) continue;\n      var clean = sanitizeClone(contentOf(bubbles[i]));\n      var body = role === \"assistant\" ? htmlToMarkdown(clean) : (clean.textContent || \"\").trim();\n      if (!body) continue;\n      parts.push((role === \"user\" ? \"## User\" : \"## Assistant\") + \"\\n\\n\" + body);\n    }\n    return parts.join(\"\\n\\n\") + (parts.length ? \"\\n\" : \"\");\n  }\n\n  // ---- exports (node tests) / boot (real webview) ----------------------------\n  if (typeof document !== \"undefined\") {\n    boot();\n  } else if (typeof module !== \"undefined\" && module.exports) {\n    module.exports = { htmlToMarkdown: htmlToMarkdown, sanitizeClone: sanitizeClone,\n                       classifyBubble: classifyBubble, conversationToMarkdown: conversationToMarkdown };\n  }\n\n  // ---- live-webview wiring (runs only when a document exists) ----------------\n  function qs(node, sel) { try { return sel && node.querySelector ? node.querySelector(sel) : null; } catch (_) { return null; } }\n  function qsa(sel) { try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (_) { return []; } }\n\n  // The content node to convert/copy: the optional ASSISTANT_CONTENT wrapper if\n  // pinned and present, else the bubble itself. The bubble already contains every\n  // content-block sibling of a multi-block turn, and sanitizeClone strips the\n  // chrome (rating widget, tool/thinking/unknown blocks, buttons, our controls)\n  // either way -- so this is a narrowing, never the thing that guarantees\n  // correctness.\n  function contentNodeOf(bubble, role) {\n    if (role === \"assistant\" && ASSISTANT_CONTENT) {\n      var n = qs(bubble, ASSISTANT_CONTENT);\n      if (n) return n;\n    }\n    return bubble;\n  }\n\n  function copyText(text) {\n    try {\n      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);\n    } catch (_) {}\n    return Promise.resolve(); // best-effort; never throw into the app\n  }\n\n  function flashFeedback(host) {\n    try {\n      var fb = document.createElement(\"span\");\n      fb.className = CONTROL_PREFIX + \"-feedback\";\n      fb.textContent = \"Copied\";\n      host.appendChild(fb);\n      setTimeout(function () { if (fb && fb.parentNode) fb.parentNode.removeChild(fb); }, FEEDBACK_MS);\n    } catch (_) {}\n  }\n\n  function bubbleMarkdown(bubble, role) {\n    var clean = sanitizeClone(contentNodeOf(bubble, role));\n    return role === \"assistant\" ? htmlToMarkdown(clean) : (clean.textContent || \"\").trim();\n  }\n  function bubblePlain(bubble, role) {\n    return (sanitizeClone(contentNodeOf(bubble, role)).textContent || \"\").trim();\n  }\n\n  // Build a single control: a primary \"Copy\" (markdown) plus a small caret that\n  // toggles a menu with \"Copy as plain text\". All nodes carry the CONTROL_PREFIX\n  // class so sanitizeClone removes them from any copied content.\n  function buildControl(onMarkdown, onPlain) {\n    var wrap = document.createElement(\"span\");\n    wrap.className = CONTROL_PREFIX;\n    var primary = document.createElement(\"button\");\n    primary.type = \"button\";\n    primary.className = CONTROL_PREFIX + \"-btn\";\n    primary.title = \"Copy as Markdown\";\n    primary.textContent = \"Copy\";\n    primary.addEventListener(\"click\", function (e) { e.stopPropagation(); onMarkdown(primary); });\n    var caret = document.createElement(\"button\");\n    caret.type = \"button\";\n    caret.className = CONTROL_PREFIX + \"-caret\";\n    caret.title = \"Copy options\";\n    caret.textContent = \"\u25be\"; // black down-pointing small triangle\n    var menu = document.createElement(\"span\");\n    menu.className = CONTROL_PREFIX + \"-menu\";\n    menu.style.display = \"none\";\n    var plain = document.createElement(\"button\");\n    plain.type = \"button\";\n    plain.className = CONTROL_PREFIX + \"-btn\";\n    plain.textContent = \"Copy as plain text\";\n    plain.addEventListener(\"click\", function (e) { e.stopPropagation(); menu.style.display = \"none\"; onPlain(plain); });\n    menu.appendChild(plain);\n    caret.addEventListener(\"click\", function (e) {\n      e.stopPropagation();\n      menu.style.display = menu.style.display === \"none\" ? \"inline-block\" : \"none\";\n    });\n    wrap.appendChild(primary);\n    wrap.appendChild(caret);\n    wrap.appendChild(menu);\n    return wrap;\n  }\n\n  function decorate(bubble) {\n    try {\n      var role = classifyBubble(bubble);\n      if (!role) return;\n      if (qs(bubble, \".\" + CONTROL_PREFIX)) return; // already decorated\n      var control = buildControl(\n        function (host) { copyText(bubbleMarkdown(bubble, role)).then(function () { flashFeedback(control); }); },\n        function (host) { copyText(bubblePlain(bubble, role)).then(function () { flashFeedback(control); }); }\n      );\n      bubble.appendChild(control);\n    } catch (_) {}\n  }\n\n  function copyConversation(format) {\n    var bubbles = qsa(USER_BUBBLE + \",\" + ASSISTANT_BUBBLE);\n    if (format === \"text\") {\n      var lines = [];\n      for (var i = 0; i < bubbles.length; i++) {\n        var role = classifyBubble(bubbles[i]);\n        if (!role) continue;\n        var body = bubblePlain(bubbles[i], role);\n        if (body) lines.push(body);\n      }\n      return copyText(lines.join(\"\\n\\n\") + (lines.length ? \"\\n\" : \"\"));\n    }\n    return copyText(conversationToMarkdown(bubbles, function (b) {\n      return contentNodeOf(b, classifyBubble(b));\n    }));\n  }\n\n  function installConversationControl() {\n    try {\n      if (qs(document, \".\" + CONTROL_PREFIX + \"-conversation\")) return;\n      var bar = document.createElement(\"div\");\n      bar.className = CONTROL_PREFIX + \"-conversation\";\n      var control = buildControl(\n        function () { copyConversation(\"markdown\").then(function () { flashFeedback(bar); }); },\n        function () { copyConversation(\"text\").then(function () { flashFeedback(bar); }); }\n      );\n      control.title = \"Copy entire conversation\";\n      bar.appendChild(control);\n      document.body.appendChild(bar); // fixed-position via CSS; placement refined in Task 6\n    } catch (_) {}\n  }\n\n  function sweep() { var b = qsa(USER_BUBBLE + \",\" + ASSISTANT_BUBBLE); for (var i = 0; i < b.length; i++) decorate(b[i]); }\n\n  function boot() {\n    try {\n      var target = (MESSAGES_CONTAINER && qs(document, MESSAGES_CONTAINER)) || document.body;\n      sweep();\n      installConversationControl();\n      if (typeof MutationObserver === \"undefined\") return;\n      var obs = new MutationObserver(function () { sweep(); });\n      obs.observe(target, { childList: true, subtree: true });\n    } catch (_) {}\n  }\n})();\n";
const MD_COPY_CSS = ".cc-md-copy {\n  display: inline-flex;\n  align-items: center;\n  gap: 2px;\n  vertical-align: middle;\n  margin-left: 6px;\n}\n.cc-md-copy-btn,\n.cc-md-copy-caret {\n  font: inherit;\n  font-size: 11px;\n  line-height: 1.4;\n  padding: 1px 6px;\n  color: var(--vscode-foreground);\n  background: transparent;\n  border: 1px solid var(--vscode-widget-border, transparent);\n  border-radius: 4px;\n  cursor: pointer;\n  opacity: 0.65;\n}\n.cc-md-copy-btn:hover,\n.cc-md-copy-caret:hover {\n  opacity: 1;\n  background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15));\n}\n.cc-md-copy-menu {\n  position: relative;\n  margin-left: 4px;\n  padding: 2px;\n  background: var(--vscode-menu-background, var(--vscode-editorWidget-background));\n  border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent));\n  border-radius: 4px;\n  z-index: 5;\n}\n.cc-md-copy-feedback {\n  margin-left: 6px;\n  font-size: 11px;\n  opacity: 0.85;\n  color: var(--vscode-foreground);\n}\n.cc-md-copy-conversation {\n  position: fixed;\n  right: 16px;\n  bottom: 56px;\n  z-index: 10;\n  padding: 2px;\n  background: var(--vscode-editorWidget-background);\n  border: 1px solid var(--vscode-widget-border, transparent);\n  border-radius: 6px;\n  opacity: 0.85;\n}\n.cc-md-copy-conversation:hover {\n  opacity: 1;\n}\n";
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
