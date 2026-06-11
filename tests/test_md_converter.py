#!/usr/bin/env python3
"""HTML->markdown converter unit tests. Runs webview-inject.js under node with the
md_dom_shim, builds DOM trees, and asserts the markdown the converter emits."""
import json
import os
import pathlib
import subprocess
import unittest

REPO = pathlib.Path(__file__).resolve().parents[1]
INJECT_JS = REPO / "fixes" / "markdown-copy-export" / "webview-inject.js"
SHIM = REPO / "tests" / "md_dom_shim.js"


def convert(builder_js):
    """Run a node snippet that builds a node `root` and prints htmlToMarkdown(root)."""
    script = (
        f"const {{el, txt}} = require({json.dumps(str(SHIM))});\n"
        f"const M = require({json.dumps(str(INJECT_JS))});\n"
        f"const root = ({builder_js});\n"
        f"process.stdout.write(M.htmlToMarkdown(root));\n"
    )
    res = subprocess.run(
        ["node", "-e", script], cwd=REPO, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10,
    )
    assert res.returncode == 0, res.stderr
    return res.stdout


class ConverterTests(unittest.TestCase):
    def test_headings_and_paragraph(self):
        out = convert("el('div',{},[el('h2',{},[txt('Title')]), el('p',{},[txt('Body text')])])")
        self.assertIn("## Title", out)
        self.assertIn("Body text", out)

    def test_bold_italic_inline_code(self):
        out = convert(
            "el('p',{},[txt('a '), el('strong',{},[txt('b')]), txt(' '), "
            "el('em',{},[txt('c')]), txt(' '), el('code',{},[txt('d')])])"
        )
        self.assertIn("**b**", out)
        self.assertIn("*c*", out)
        self.assertIn("`d`", out)

    def test_link_uses_href(self):
        out = convert("el('p',{},[el('a',{href:'https://x.test'},[txt('link')])])")
        self.assertIn("[link](https://x.test)", out)

    def test_fenced_code_block_with_language(self):
        out = convert(
            "el('pre',{},[el('code',{class:'language-python'},[txt('print(1)\\n')])])"
        )
        self.assertIn("```python", out)
        self.assertIn("print(1)", out)
        self.assertTrue(out.strip().endswith("```"))

    def test_unordered_list(self):
        out = convert("el('ul',{},[el('li',{},[txt('one')]), el('li',{},[txt('two')])])")
        self.assertIn("- one", out)
        self.assertIn("- two", out)

    def test_ordered_list(self):
        out = convert("el('ol',{},[el('li',{},[txt('a')]), el('li',{},[txt('b')])])")
        self.assertIn("1. a", out)
        self.assertIn("2. b", out)

    def test_nested_list_indents(self):
        out = convert(
            "el('ul',{},[el('li',{},[txt('top'), el('ul',{},[el('li',{},[txt('child')])])])])"
        )
        self.assertIn("- top", out)
        self.assertIn("  - child", out)

    def test_blockquote(self):
        out = convert("el('blockquote',{},[el('p',{},[txt('quoted')])])")
        self.assertIn("> quoted", out)

    def test_horizontal_rule(self):
        out = convert("el('div',{},[el('p',{},[txt('a')]), el('hr',{},[]), el('p',{},[txt('b')])])")
        self.assertIn("---", out)

    def test_table_gfm_pipes(self):
        out = convert(
            "el('table',{},[el('thead',{},[el('tr',{},[el('th',{},[txt('H1')]), el('th',{},[txt('H2')])])]),"
            "el('tbody',{},[el('tr',{},[el('td',{},[txt('a')]), el('td',{},[txt('b')])])])])"
        )
        self.assertIn("| H1 | H2 |", out)
        self.assertIn("| --- | --- |", out)
        self.assertIn("| a | b |", out)

    def test_unknown_wrapper_keeps_text_drops_tag(self):
        out = convert("el('p',{},[el('span',{},[txt('kept')])])")
        self.assertIn("kept", out)
        self.assertNotIn("span", out)

    def test_inline_code_with_backtick_uses_longer_delimiter(self):
        # content has a run of 1 backtick -> delimiter must be 2 so it can't close early
        out = convert("el('p',{},[el('code',{},[txt('a`b')])])")
        self.assertIn("``a`b``", out)

    def test_inline_code_edge_backtick_is_space_padded(self):
        # content starts with a backtick -> CommonMark needs a space inside the delimiters
        out = convert("el('p',{},[el('code',{},[txt('`x')])])")
        self.assertIn("`` `x ``", out)

    def test_fenced_code_with_triple_backticks_uses_longer_fence(self):
        # body contains a run of 3 backticks -> fence must be >=4 or it closes early
        out = convert("el('pre',{},[el('code',{class:'language-md'},[txt('```\\nx\\n```')])])")
        self.assertIn("````md", out)
        self.assertTrue(out.strip().endswith("````"))

    def test_details_summary_separates_thinking_header_from_body(self):
        out = convert(
            "el('details',{},["
            "  el('summary',{},[txt('Thought for 2s')]),"
            "  el('div',{},[el('p',{},[txt('visible thinking summary')])]),"
            "])"
        )
        self.assertIn("Thought for 2s\n\nvisible thinking summary", out)


if __name__ == "__main__":
    unittest.main()
