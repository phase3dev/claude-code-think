#!/usr/bin/env python3
"""Scoping/correctness tests for the inject IIFE's pure helpers: sanitizeClone
strips our controls and never mutates the original; classifyBubble keys off the
stable prefixes; conversationToMarkdown joins with role headers and excludes our
UI text. Runs under node with md_dom_shim (no DOM, no dependency)."""
import json
import pathlib
import subprocess
import unittest

REPO = pathlib.Path(__file__).resolve().parents[1]
INJECT_JS = REPO / "fixes" / "markdown-copy-export" / "webview-inject.js"
SHIM = REPO / "tests" / "md_dom_shim.js"


def run_node(body_js):
    script = (
        f"const {{el, txt}} = require({json.dumps(str(SHIM))});\n"
        f"const M = require({json.dumps(str(INJECT_JS))});\n"
        f"{body_js}\n"
    )
    res = subprocess.run(
        ["node", "-e", script], cwd=REPO, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
    )
    assert res.returncode == 0, res.stderr
    return res.stdout


class InjectHelperTests(unittest.TestCase):
    def test_sanitize_strips_all_chrome_and_asserts_clean(self):
        # Fixture shaped like a real assistant bubble: a text content block plus the
        # sibling chrome the live DOM puts inside it (our controls, the rating
        # widget, and the v1-excluded tool/thinking/unknown blocks). Sanitize must
        # remove ALL of it and leave the original untouched.
        out = run_node(
            "const content = el('div',{'data-testid':'assistant-message'},["
            "  el('p',{},[txt('keep me')]),"
            "  el('button',{class:'cc-md-copy'},[txt('Copy')]),"
            "  el('div',{class:'cc-md-copy-feedback'},[txt('Copied')]),"
            "  el('div',{class:'toolUse_uq5aLg'},[txt('ran a tool')]),"
            "  el('div',{class:'toolResult_uq5aLg'},[txt('tool output')]),"
            "  el('div',{class:'thinking_aHyQPQ'},[txt('secret thoughts')]),"
            "  el('div',{class:'unknownContent_uq5aLg'},[txt('Unsupported content')]),"
            "  el('div',{'data-message-rating':'0'},[txt('Thanks for your feedback')]),"
            "]);"
            "const clean = M.sanitizeClone(content);"
            "const cleanMd = M.htmlToMarkdown(clean);"
            # Independent post-condition walk (does not reuse isChrome): assert no
            # chrome node survives. fail-closed in the TEST, never at runtime.
            "function residue(node, acc){var k=node.childNodes||[];for(var i=0;i<k.length;i++){var c=k[i];"
            "  if(c.nodeType!==1)continue;var tag=(c.tagName||'').toUpperCase();"
            "  var cls=(typeof c.className==='string'?c.className:'');"
            "  if(tag==='BUTTON')acc.button++;"
            "  if(c.getAttribute&&c.getAttribute('data-message-rating')!==null)acc.rating++;"
            "  if(/(^|\\s)(toolUse_|toolResult_|toolReference_)/.test(cls))acc.tool++;"
            "  if(/(^|\\s)thinking_/.test(cls))acc.thinking++;"
            "  if(/(^|\\s)unknownContent_/.test(cls))acc.unknown++;"
            "  residue(c, acc);}return acc;}"
            "const left = residue(clean,{button:0,rating:0,tool:0,thinking:0,unknown:0});"
            "const origIntact = (content.childNodes.length === 8);"
            "process.stdout.write(JSON.stringify({cleanMd, left, origIntact}));"
        )
        data = json.loads(out)
        self.assertIn("keep me", data["cleanMd"])
        for leak in ["Copy", "Copied", "ran a tool", "tool output",
                     "secret thoughts", "Unsupported content", "Thanks for your feedback"]:
            self.assertNotIn(leak, data["cleanMd"])
        # assert-clean: zero chrome nodes remain after sanitize
        self.assertEqual(data["left"], {"button": 0, "rating": 0, "tool": 0, "thinking": 0, "unknown": 0})
        # sanitize works on a clone; the original is untouched
        self.assertTrue(data["origIntact"])

    def test_classify_user_and_assistant_and_none(self):
        out = run_node(
            "const u = el('div',{class:'userMessageContainer_07S1Yg'},[]);"
            "const a = el('div',{'data-testid':'assistant-message',class:'message_07S1Yg'},[]);"
            # message_ alone is ambiguous (two element types use it) and carries no
            # data-testid -> must NOT classify as assistant.
            "const m = el('div',{class:'message_07S1Yg'},[]);"
            "const x = el('div',{class:'somethingElse_zz'},[]);"
            "process.stdout.write(JSON.stringify("
            "[M.classifyBubble(u), M.classifyBubble(a), M.classifyBubble(m), M.classifyBubble(x)]));"
        )
        self.assertEqual(json.loads(out), ["user", "assistant", None, None])

    def test_conversation_join_has_headers_and_excludes_chrome(self):
        out = run_node(
            "const u = el('div',{class:'userMessageContainer_07S1Yg'},[txt('hi there')]);"
            "const a = el('div',{'data-testid':'assistant-message'},["
            "  el('p',{},[txt('hello back')]),"
            "  el('div',{class:'thinking_aHyQPQ'},[txt('secret thoughts')]),"
            "  el('button',{class:'cc-md-copy'},[txt('Copy')]),"
            "  el('div',{'data-message-rating':'0'},[txt('Thanks for your feedback')]),"
            "]);"
            "process.stdout.write(M.conversationToMarkdown([u, a]));"
        )
        self.assertIn("## User", out)
        self.assertIn("hi there", out)
        self.assertIn("## Assistant", out)
        self.assertIn("hello back", out)
        self.assertNotIn("Copy", out)
        self.assertNotIn("secret thoughts", out)
        self.assertNotIn("Thanks for your feedback", out)


if __name__ == "__main__":
    unittest.main()
