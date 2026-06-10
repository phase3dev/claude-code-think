#!/usr/bin/env python3
"""Tests for tools/gen-embeds: region replacement, per-language block escaping
(round-trip), the heredoc-collision guard, the payload sentinel guard, region
counting, the strict all-consumers gate, and a whole-tree drift check."""
import base64
import importlib.machinery
import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[1]
GEN = REPO / "tools" / "gen-embeds"


def load_gen():
    # tools/gen-embeds has no .py extension, so spec_from_file_location returns
    # None (it guesses the loader from the suffix). Load via an explicit loader.
    loader = importlib.machinery.SourceFileLoader("gen_embeds", str(GEN))
    spec = importlib.util.spec_from_loader("gen_embeds", loader)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class GenPureTests(unittest.TestCase):
    def setUp(self):
        self.g = load_gen()

    def test_replace_region_keeps_markers_and_swaps_inner(self):
        text = (
            "head\n"
            "# >>>CCWA-MD-COPY-EMBED>>> (generated)\n"
            "OLD INNER\n"
            "# <<<CCWA-MD-COPY-EMBED<<<\n"
            "tail\n"
        )
        out = self.g.replace_region(text, "CCWA-MD-COPY-EMBED", "NEW INNER\n")
        self.assertIn(">>>CCWA-MD-COPY-EMBED>>>", out)
        self.assertIn("<<<CCWA-MD-COPY-EMBED<<<", out)
        self.assertIn("NEW INNER", out)
        self.assertNotIn("OLD INNER", out)
        self.assertTrue(out.startswith("head\n"))
        self.assertTrue(out.endswith("tail\n"))

    def test_replace_region_missing_raises(self):
        with self.assertRaises(ValueError):
            self.g.replace_region("no markers here", "CCWA-MD-COPY-EMBED", "x\n")

    def test_node_block_round_trips_via_json(self):
        js = "const x = `back${tick}`;\n\"quotes\" and \\backslash\n"
        css = ".cc-md-copy{content:'✓'}\n"
        block = self.g.node_block(js, css)
        # Extract each JSON string literal and confirm it decodes to the source.
        self.assertIn("MD_COPY_JS = ", block)
        js_lit = block.split("MD_COPY_JS = ", 1)[1].split(";\n", 1)[0]
        css_lit = block.split("MD_COPY_CSS = ", 1)[1].split(";\n", 1)[0]
        self.assertEqual(json.loads(js_lit), js)
        self.assertEqual(json.loads(css_lit), css)

    def test_py_block_round_trips_via_base64(self):
        js, css = "INJECT payload ''' triple\n", "/* css */\n"
        block = self.g.py_block(js, css)
        js_b64 = block.split('b64decode("', 1)[1].split('")', 1)[0]
        self.assertEqual(base64.b64decode(js_b64).decode("utf-8"), js)

    def test_bash_block_wraps_in_quoted_heredocs(self):
        block = self.g.bash_block("alert(1)\n", ".x{}\n")
        self.assertIn("_cc_md_copy_js() { cat <<'CCMDCOPYJS'", block)
        self.assertIn("_cc_md_copy_css() { cat <<'CCMDCOPYCSS'", block)
        self.assertIn("alert(1)", block)

    def test_bash_block_rejects_heredoc_delimiter_collision(self):
        with self.assertRaises(ValueError):
            self.g.bash_block("line\nCCMDCOPYJS\nmore\n", ".x{}\n")

    def test_reject_if_sentinels_guards_against_self_nesting(self):
        # a payload containing an append sentinel would break marker-scoped undo
        self.g.reject_if_sentinels("ok.js", "no markers here\n")  # does not raise
        for bad in ("/* cc-md-copy v1 */", "/* /cc-md-copy v1 */"):
            with self.assertRaises(ValueError):
                self.g.reject_if_sentinels("bad.js", "x\n" + bad + "\ny\n")

    def test_region_count_counts_markers(self):
        wired = ">>>CCWA-MD-COPY-EMBED>>>\nx\n<<<CCWA-MD-COPY-EMBED<<<\n"
        self.assertEqual(self.g.region_count(wired, "CCWA-MD-COPY-EMBED"), (1, 1))
        self.assertEqual(self.g.region_count("nothing\n", "CCWA-MD-COPY-EMBED"), (0, 0))


class GenDriftTests(unittest.TestCase):
    def test_check_reports_no_drift_in_tree(self):
        res = subprocess.run(
            ["python3", str(GEN), "--check"], cwd=REPO, text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20,
        )
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)

    def test_strict_flags_unwired_consumer_but_lenient_skips_it(self):
        # Hermetic (phase-independent): --check skips a consumer with no region (so
        # early, not-yet-wired phases pass), but --check --strict FAILS on it, so a
        # vanished generated region can't pass CI silently. This is finding #5's gate.
        g = load_gen()
        with tempfile.TemporaryDirectory() as td:
            repo = pathlib.Path(td)
            (repo / "wired.py").write_text(
                "# >>>CCWA-MD-COPY-EMBED>>>\n# <<<CCWA-MD-COPY-EMBED<<<\n", encoding="utf-8")
            (repo / "unwired.py").write_text("no region here\n", encoding="utf-8")
            old_repo, old_targets = g.REPO, g.TARGETS
            try:
                g.REPO = repo
                g.TARGETS = [
                    {"path": "wired.py", "style": "py"},
                    {"path": "unwired.py", "style": "py"},
                ]
                g.main([])                                    # regenerate: fills wired, skips unwired
                rc_lenient = g.main(["--check"])              # tolerant -> 0 (unwired skipped)
                rc_strict = g.main(["--check", "--strict"])   # strict -> 1 (unwired flagged)
            finally:
                g.REPO, g.TARGETS = old_repo, old_targets
        self.assertEqual(rc_lenient, 0)
        self.assertEqual(rc_strict, 1)


if __name__ == "__main__":
    unittest.main()
