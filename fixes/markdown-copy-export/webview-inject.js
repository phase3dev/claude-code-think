/* cc-md-copy: per-message and whole-conversation copy (markdown/plain) for the
 * Claude Code VS Code webview. Self-contained IIFE appended to webview/index.js.
 * Additive and read-only w.r.t. app state; keyed on stable CSS-module class
 * prefixes, so it fails safe (controls simply do not appear) if a prefix moves.
 * Exposes its pure functions for node unit tests; boot()s only in a real webview. */
(function () {
  "use strict";

  var CONTROL_PREFIX = "cc-md-copy"; // every injected node's class starts with this
  var USER_BUBBLE = '[class*="userMessageContainer_"]';
  // Assistant message wrapper. Verified on 2.1.170: the render emits exactly one
  // `data-testid="assistant-message"` div per assistant turn, with the rating
  // widget and content blocks as its children. (The earlier `[data-message-rating]`
  // was WRONG: that attribute sits on the nested rating control, which is also only
  // rendered behind an experiment+analytics gate.) Re-pinned in Task 6.
  var ASSISTANT_BUBBLE = '[data-testid="assistant-message"]';

  // ---- HTML -> Markdown (DOM walk) -------------------------------------------
  // Uses only: nodeType, tagName, childNodes, textContent, getAttribute, className.
  function htmlToMarkdown(root) {
    function inline(node) {
      var out = "";
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c.nodeType === 3) { out += c.textContent || ""; continue; }
        if (c.nodeType !== 1) continue;
        var tag = (c.tagName || "").toUpperCase();
        if (tag === "BR") out += "\n";
        else if (tag === "STRONG" || tag === "B") out += "**" + inline(c) + "**";
        else if (tag === "EM" || tag === "I") out += "*" + inline(c) + "*";
        else if (tag === "DEL" || tag === "S") out += "~~" + inline(c) + "~~";
        else if (tag === "CODE") out += "`" + (c.textContent || "") + "`";
        else if (tag === "A") {
          var href = c.getAttribute ? c.getAttribute("href") : null;
          var t = inline(c);
          out += href ? "[" + t + "](" + href + ")" : t;
        } else out += inline(c); // unknown inline wrapper: keep text, drop tag
      }
      return out;
    }
    function langOf(codeEl) {
      var cls = "";
      if (codeEl) cls = (codeEl.getAttribute && codeEl.getAttribute("class")) || codeEl.className || "";
      var m = /language-([A-Za-z0-9+#.\-]+)/.exec(cls || "");
      return m ? m[1] : "";
    }
    function findChildTag(node, tag) {
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        if (kids[i].nodeType === 1 && (kids[i].tagName || "").toUpperCase() === tag) return kids[i];
      }
      return null;
    }
    function list(node, ordered, depth) {
      var out = "", n = 1;
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var li = kids[i];
        if (li.nodeType !== 1 || (li.tagName || "").toUpperCase() !== "LI") continue;
        var marker = ordered ? n++ + ". " : "- ";
        var indent = new Array(depth + 1).join("  ");
        var lead = "", nested = "";
        var lk = li.childNodes || [];
        for (var j = 0; j < lk.length; j++) {
          var ch = lk[j];
          var ct = ch.nodeType === 1 ? (ch.tagName || "").toUpperCase() : "";
          if (ct === "UL") nested += list(ch, false, depth + 1);
          else if (ct === "OL") nested += list(ch, true, depth + 1);
          else if (ch.nodeType === 3) lead += ch.textContent || "";
          else lead += inline(ch);
        }
        out += indent + marker + lead.trim() + "\n" + nested;
      }
      return out;
    }
    function table(node) {
      var rows = [];
      (function collect(container) {
        var kids = container.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
          var c = kids[i];
          if (c.nodeType !== 1) continue;
          var t = (c.tagName || "").toUpperCase();
          if (t === "THEAD" || t === "TBODY" || t === "TFOOT") collect(c);
          else if (t === "TR") {
            var cells = [], cc = c.childNodes || [];
            for (var j = 0; j < cc.length; j++) {
              var d = cc[j];
              if (d.nodeType !== 1) continue;
              var dt = (d.tagName || "").toUpperCase();
              if (dt === "TH" || dt === "TD") cells.push(inline(d).trim());
            }
            rows.push(cells);
          }
        }
      })(node);
      if (!rows.length) return "";
      var head = rows[0], body = rows.slice(1);
      var sep = head.map(function () { return "---"; });
      var out = "| " + head.join(" | ") + " |\n| " + sep.join(" | ") + " |\n";
      for (var k = 0; k < body.length; k++) out += "| " + body[k].join(" | ") + " |\n";
      return out;
    }
    function block(node) {
      var out = "";
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c.nodeType === 3) { if ((c.textContent || "").trim()) out += c.textContent; continue; }
        if (c.nodeType !== 1) continue;
        var tag = (c.tagName || "").toUpperCase();
        if (/^H[1-6]$/.test(tag)) out += new Array(+tag[1] + 1).join("#") + " " + inline(c).trim() + "\n\n";
        else if (tag === "P") out += inline(c).trim() + "\n\n";
        else if (tag === "UL") out += list(c, false, 0) + "\n";
        else if (tag === "OL") out += list(c, true, 0) + "\n";
        else if (tag === "PRE") {
          var code = findChildTag(c, "CODE");
          var lang = langOf(code || c);
          var body = (code || c).textContent || "";
          out += "```" + lang + "\n" + body.replace(/\n$/, "") + "\n```\n\n";
        } else if (tag === "BLOCKQUOTE") {
          var inner = block(c).trim().split("\n").map(function (l) { return "> " + l; }).join("\n");
          out += inner + "\n\n";
        } else if (tag === "HR") out += "---\n\n";
        else if (tag === "TABLE") out += table(c) + "\n";
        else if (tag === "BR") out += "\n";
        else if (tag === "STRONG" || tag === "B" || tag === "EM" || tag === "I" ||
                 tag === "A" || tag === "CODE" || tag === "DEL" || tag === "S")
          out += inline(c) + "\n\n";
        else out += block(c); // unknown wrapper: recurse (drop tag, keep content)
      }
      return out;
    }
    // block() dispatches on each CHILD's tag, treating the passed node as a plain
    // container. Wrap root in a one-off container so root's OWN tag is dispatched
    // too: callers pass either the bubble container (its block children render) or
    // a single block element like <pre>/<ul>/<table> (now handled, not flattened).
    return block({ childNodes: [root] }).replace(/\n{3,}/g, "\n\n").trim();
  }

  // ---- pure helpers ----------------------------------------------------------
  function hasPrefix(node, prefix) {
    if (node.nodeType !== 1 || typeof node.className !== "string") return false;
    var parts = node.className.split(/\s+/);
    for (var i = 0; i < parts.length; i++) if (parts[i].indexOf(prefix) === 0) return true;
    return false;
  }

  // Class-prefix hooks for non-content chrome that renders *inside* an assistant
  // bubble (verified on 2.1.170; Task 6 re-pins these). tool*/thinking_ are the v1
  // exclusions; unknownContent_ is the renderer's fallback for unrecognized block
  // types, so stripping it makes a *future* block type fail safe to excluded rather
  // than leaking "Unsupported content" into the copy. Re-pin if a prefix moves.
  var CHROME_PREFIXES = ["toolUse_", "toolResult_", "toolReference_", "thinking_", "unknownContent_"];

  // True for any node that must never appear in copied output: our own controls,
  // the rating widget (`data-message-rating` + its "Thanks for your feedback"
  // text), any button (copy-code chrome), and the excluded content blocks above.
  function isChrome(node) {
    if (node.nodeType !== 1) return false;
    if ((node.tagName || "").toUpperCase() === "BUTTON") return true;
    if (node.getAttribute && node.getAttribute("data-message-rating") !== null) return true;
    if (hasPrefix(node, CONTROL_PREFIX)) return true;
    for (var i = 0; i < CHROME_PREFIXES.length; i++) if (hasPrefix(node, CHROME_PREFIXES[i])) return true;
    return false;
  }

  // Deep-clone `contentNode`, then strip every chrome node so copied output is the
  // message's text content only. This is a CORRECTNESS GATE, not cosmetic: the
  // default content node is the whole bubble (all content-block siblings, so multi-
  // block assistant turns are captured), and this strip-list is the only thing
  // keeping the rating widget and v1-excluded blocks out of the copy.
  function sanitizeClone(contentNode) {
    var clone = contentNode.cloneNode(true);
    (function strip(node) {
      var kids = (node.childNodes || []).slice();
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c.nodeType === 1 && isChrome(c)) { node.removeChild(c); continue; }
        if (c.nodeType === 1) strip(c);
      }
    })(clone);
    return clone;
  }

  function classifyBubble(node) {
    if (node.nodeType !== 1) return null;
    if (hasPrefix(node, "userMessageContainer_")) return "user";
    if (node.getAttribute && node.getAttribute("data-testid") === "assistant-message") return "assistant";
    return null;
  }

  // Build the whole-conversation markdown from an ordered list of bubbles.
  // `contentOf(bubble)` resolves the content node (default: the bubble itself, so
  // every content block is included; sanitizeClone drops chrome); a default is
  // provided for tests.
  function conversationToMarkdown(bubbles, contentOf) {
    contentOf = contentOf || function (b) { return b; };
    var parts = [];
    for (var i = 0; i < bubbles.length; i++) {
      var role = classifyBubble(bubbles[i]);
      if (!role) continue;
      var clean = sanitizeClone(contentOf(bubbles[i]));
      var body = role === "assistant" ? htmlToMarkdown(clean) : (clean.textContent || "").trim();
      if (!body) continue;
      parts.push((role === "user" ? "## User" : "## Assistant") + "\n\n" + body);
    }
    return parts.join("\n\n") + (parts.length ? "\n" : "");
  }

  // ---- exports (node tests) / boot (real webview) ----------------------------
  if (typeof document !== "undefined") {
    boot();
  } else if (typeof module !== "undefined" && module.exports) {
    module.exports = { htmlToMarkdown: htmlToMarkdown, sanitizeClone: sanitizeClone,
                       classifyBubble: classifyBubble, conversationToMarkdown: conversationToMarkdown };
  }

  // boot() is defined in Phase 3; declare a no-op so the file is valid until then.
  function boot() {}
})();
