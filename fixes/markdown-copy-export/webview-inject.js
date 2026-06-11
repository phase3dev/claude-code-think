/* cc-md-copy: per-message and whole-conversation copy (Markdown) for the
 * Claude Code VS Code webview. Self-contained IIFE appended to webview/index.js.
 * Each control is a single clipboard icon that flips to a checkmark for ~2s when a
 * copy actually succeeds (no text label, no menu). Additive and read-only w.r.t.
 * app state; keyed on stable CSS-module class prefixes, so it fails safe (controls
 * simply do not appear) if a prefix moves.
 * Exposes its pure functions for node unit tests; boot()s only in a real webview. */
/* Leading ';' so that, appended after the bundle, this IIFE can never be parsed as
 * a call on the bundle's final expression if it lacks a trailing semicolon (ASI
 * safety across extension builds). */
;(function () {
  "use strict";

  var CONTROL_PREFIX = "cc-md-copy"; // every injected node's class starts with this
  var USER_BUBBLE = '[class*="userMessageContainer_"]';
  // Assistant message wrapper. Verified on 2.1.170: the render emits exactly one
  // `data-testid="assistant-message"` div per assistant turn, with the rating
  // widget and content blocks as its children. (The earlier `[data-message-rating]`
  // was WRONG: that attribute sits on the nested rating control, which is also only
  // rendered behind an experiment+analytics gate.) Re-pinned in Task 6.
  var ASSISTANT_BUBBLE = '[data-testid="assistant-message"]';
  var MESSAGES_CONTAINER = '[class*="messagesContainer_"]'; // e.g. '[class*="timeline_"]'; "" -> observe document.body
  // Optional narrowing only. MUST be a single wrapper around ALL content blocks,
  // not a per-block class (a turn has multiple blocks). "" -> use the bubble itself
  // (already aggregates all blocks; sanitizeClone is the correctness gate).
  var ASSISTANT_CONTENT = "";
  var FEEDBACK_MS = 2000; // how long the checkmark shows after a successful copy

  // ---- HTML -> Markdown (DOM walk) -------------------------------------------
  // Uses only: nodeType, tagName, childNodes, textContent, getAttribute, className.
  function htmlToMarkdown(root) {
    // Longest run of consecutive backticks in s, so a code delimiter/fence can be
    // chosen longer than anything inside it (else ``` in the content closes early).
    function backtickRun(s) {
      var max = 0, cur = 0;
      for (var i = 0; i < s.length; i++) {
        if (s.charAt(i) === "`") { cur++; if (cur > max) max = cur; } else cur = 0;
      }
      return max;
    }
    function fence(s, min) { var n = backtickRun(s) + 1; if (n < min) n = min; return new Array(n + 1).join("`"); }
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
        else if (tag === "CODE") {
          var ct = c.textContent || "";
          var d = fence(ct, 1);
          // CommonMark strips one leading+trailing space, so pad when an edge is a
          // backtick to keep it from merging with the delimiter.
          var p = (ct.charAt(0) === "`" || ct.charAt(ct.length - 1) === "`") ? " " : "";
          out += d + p + ct + p + d;
        }
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
          var f = fence(body, 3);
          out += f + lang + "\n" + body.replace(/\n$/, "") + "\n" + f + "\n\n";
        } else if (tag === "BLOCKQUOTE") {
          var inner = block(c).trim().split("\n").map(function (l) { return "> " + l; }).join("\n");
          out += inner + "\n\n";
        } else if (tag === "DETAILS") out += block(c).trim() + "\n\n";
        else if (tag === "SUMMARY") out += inline(c).trim() + "\n\n";
        else if (tag === "HR") out += "---\n\n";
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
  // bubble (verified on 2.1.170; Task 6 re-pins these). Tool blocks are excluded
  // from message copy; thinking summaries are visible content and must remain
  // copyable. unknownContent_ is the renderer's fallback for unrecognized block
  // types, so stripping it makes a *future* block type fail safe to excluded rather
  // than leaking "Unsupported content" into the copy. Re-pin if a prefix moves.
  var CHROME_PREFIXES = ["toolUse_", "toolResult_", "toolReference_", "unknownContent_"];

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
  // keeping the rating widget and excluded tool/fallback blocks out of the copy.
  function sanitizeClone(contentNode) {
    var clone = contentNode.cloneNode(true);
    (function strip(node) {
      var kids = Array.prototype.slice.call(node.childNodes || []);
      for (var i = 0; i < kids.length; i++) {
        var c = kids[i];
        if (c.nodeType === 1 && isChrome(c)) { node.removeChild(c); continue; }
        if (c.nodeType === 1) strip(c);
      }
    })(clone);
    return clone;
  }

  function hasCopyableContent(contentNode, role) {
    function walk(node) {
      if (!node) return false;
      if (node.nodeType === 3) return !!(node.textContent || "").trim();
      if (node.nodeType !== 1) return false;
      if (isChrome(node)) return false;
      var kids = node.childNodes || [];
      for (var i = 0; i < kids.length; i++) if (walk(kids[i])) return true;
      return false;
    }
    return walk(contentNode);
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
                       classifyBubble: classifyBubble, conversationToMarkdown: conversationToMarkdown,
                       hasCopyableContent: hasCopyableContent, copyText: copyText };
  }

  // ---- live-webview wiring (runs only when a document exists) ----------------
  function qs(node, sel) { try { return sel && node.querySelector ? node.querySelector(sel) : null; } catch (_) { return null; } }
  function qsa(sel) { try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (_) { return []; } }

  // The content node to convert/copy: the optional ASSISTANT_CONTENT wrapper if
  // pinned and present, else the bubble itself. The bubble already contains every
  // content-block sibling of a multi-block turn, and sanitizeClone strips the
  // chrome (rating widget, tool/unknown blocks, buttons, our controls)
  // either way -- so this is a narrowing, never the thing that guarantees
  // correctness.
  function contentNodeOf(bubble, role) {
    if (role === "assistant" && ASSISTANT_CONTENT) {
      var n = qs(bubble, ASSISTANT_CONTENT);
      if (n) return n;
    }
    return bubble;
  }

  // Copy `s` via a synchronous execCommand("copy") on an off-screen textarea, and
  // report whether it actually happened. Done first (and synchronously) because it
  // runs inside the click gesture and works whether or not the page is a secure
  // context -- so it covers remote / code-server, where the async Clipboard API is
  // simply absent. Restores the prior selection/focus so it is invisible.
  function execCopy(s) {
    try {
      if (typeof document === "undefined" || !document.createElement) return false;
      var prev = document.activeElement || null;
      var sel = document.getSelection ? document.getSelection() : null;
      var saved = (sel && sel.rangeCount) ? sel.getRangeAt(0) : null;
      var ta = document.createElement("textarea");
      ta.value = s;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.left = "0";
      ta.style.opacity = "0";
      (document.body || document.documentElement).appendChild(ta);
      ta.focus();
      ta.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
      if (ta.parentNode) ta.parentNode.removeChild(ta);
      if (saved && sel) { try { sel.removeAllRanges(); sel.addRange(saved); } catch (_) {} }
      if (prev && prev.focus) { try { prev.focus(); } catch (_) {} }
      return !!ok;
    } catch (_) { return false; }
  }

  // Copy `text` and resolve to whether the copy ACTUALLY happened, so callers only
  // show success on a real copy -- never a false "copied" (the original bug:
  // navigator.clipboard was undefined in the webview, the code fell through to
  // Promise.resolve(), and the UI claimed success while nothing was written). Empty
  // text is a non-copy -> false. execCommand first (gesture-safe, secure-context-
  // independent); the async Clipboard API is the fallback. Never throws.
  function copyText(text) {
    var s = (text == null) ? "" : String(text);
    if (!s) return Promise.resolve(false);
    if (execCopy(s)) return Promise.resolve(true);
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(s).then(
          function () { return true; },
          function () { return false; }
        );
      }
    } catch (_) {}
    return Promise.resolve(false);
  }

  function bubbleMarkdown(bubble, role) {
    var clean = sanitizeClone(contentNodeOf(bubble, role));
    return role === "assistant" ? htmlToMarkdown(clean) : (clean.textContent || "").trim();
  }

  // Inline SVG icons (currentColor, ~14px). Set via innerHTML on our own buttons
  // only; the markup never reaches copied content (sanitizeClone drops our nodes).
  var ICON_COPY = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
  var ICON_CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>';

  // Flip the button to a checkmark for FEEDBACK_MS, then restore. Idempotent across
  // rapid clicks (any pending restore is cleared first).
  function showCopied(btn) {
    try {
      if (btn.__ccTimer) clearTimeout(btn.__ccTimer);
      btn.classList.add(CONTROL_PREFIX + "-ok");
      btn.innerHTML = ICON_CHECK;
      btn.__ccTimer = setTimeout(function () {
        try { btn.classList.remove(CONTROL_PREFIX + "-ok"); btn.innerHTML = ICON_COPY; } catch (_) {}
        btn.__ccTimer = null;
      }, FEEDBACK_MS);
    } catch (_) {}
  }

  // Build a single control: one clipboard-icon button. `onCopy()` is invoked
  // synchronously on click (so the copy stays inside the user gesture) and must
  // return a Promise<boolean>; the checkmark shows only when it resolves true. All
  // nodes carry the CONTROL_PREFIX class so sanitizeClone strips them from copies.
  function buildControl(onCopy, title) {
    var wrap = document.createElement("span");
    wrap.className = CONTROL_PREFIX;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = CONTROL_PREFIX + "-btn";
    btn.title = title || "Copy as Markdown";
    btn.setAttribute("aria-label", btn.title);
    btn.innerHTML = ICON_COPY;
    var busy = false;
    btn.addEventListener("click", function (e) {
      e.stopPropagation();
      if (busy) return;
      busy = true;
      var p;
      try { p = onCopy(); } catch (_) { p = false; }
      Promise.resolve(p).then(
        function (ok) { busy = false; if (ok) showCopied(btn); },
        function () { busy = false; }
      );
    });
    wrap.appendChild(btn);
    return wrap;
  }

  function decorate(bubble) {
    try {
      var role = classifyBubble(bubble);
      if (!role) return;
      // Idempotent: keep exactly one control. A React re-render of the bubble can
      // leave a stale control behind or transiently defeat an "already decorated"
      // guard, which is what produced duplicate rows of buttons; prune any extras
      // every sweep and only add one when none remain.
      var existing = bubble.querySelectorAll ? bubble.querySelectorAll("." + CONTROL_PREFIX) : null;
      if (!hasCopyableContent(contentNodeOf(bubble, role), role)) {
        if (existing && existing.length) {
          for (var j = existing.length - 1; j >= 0; j--) {
            if (existing[j] && existing[j].parentNode) existing[j].parentNode.removeChild(existing[j]);
          }
        }
        return;
      }
      if (existing && existing.length) {
        for (var i = existing.length - 1; i >= 1; i--) {
          if (existing[i] && existing[i].parentNode) existing[i].parentNode.removeChild(existing[i]);
        }
        return;
      }
      var control = buildControl(function () {
        return copyText(bubbleMarkdown(bubble, role));
      }, "Copy as Markdown");
      bubble.appendChild(control);
    } catch (_) {}
  }

  function copyConversation() {
    var bubbles = qsa(USER_BUBBLE + "," + ASSISTANT_BUBBLE);
    return copyText(conversationToMarkdown(bubbles, function (b) {
      return contentNodeOf(b, classifyBubble(b));
    }));
  }

  // A single floating "Copy conversation" icon, present only while a conversation
  // is open (so it never clutters the history-list view). Pinned top-right by CSS,
  // clear of the chat input at the bottom; the most-recent-prompt sticky header
  // sits to its left.
  function installConversationControl() {
    try {
      var existing = qs(document, "." + CONTROL_PREFIX + "-conversation");
      var hasMessages = qsa(USER_BUBBLE + "," + ASSISTANT_BUBBLE).length > 0;
      if (!hasMessages) {
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);
        return;
      }
      if (existing) return;
      var bar = document.createElement("div");
      bar.className = CONTROL_PREFIX + "-conversation";
      bar.appendChild(buildControl(copyConversation, "Copy conversation"));
      document.body.appendChild(bar);
    } catch (_) {}
  }

  function sweep() {
    var b = qsa(USER_BUBBLE + "," + ASSISTANT_BUBBLE);
    for (var i = 0; i < b.length; i++) decorate(b[i]);
    installConversationControl();
  }

  function boot() {
    try {
      var target = (MESSAGES_CONTAINER && qs(document, MESSAGES_CONTAINER)) || document.body;
      sweep();
      if (typeof MutationObserver === "undefined") return;
      var obs = new MutationObserver(function () { sweep(); });
      obs.observe(target, { childList: true, subtree: true });
    } catch (_) {}
  }
})();
