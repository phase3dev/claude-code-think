#!/usr/bin/env python3
"""add-md-copy.py: sentinel-block apply (idempotent), reverse-transform --revert,
composition with context-icon (revert leaves context-icon intact), metadata
preservation, and emergency .bak-md-copy snapshot."""
import importlib.util
import os
import pathlib
import stat
import subprocess
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[1]
ADD_MD = REPO / "fixes" / "markdown-copy-export" / "add-md-copy.py"

OPEN = "/* cc-md-copy v1 */"
CLOSE = "/* /cc-md-copy v1 */"
CONTEXT_MARKED = "if(c>=101)return null}/*ccwa-context-icon*/"


def load_mod():
    spec = importlib.util.spec_from_file_location("add_md_copy", ADD_MD)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def make_webview(td, js_body, css_body=".x{}\n"):
    d = pathlib.Path(td) / ".vscode" / "extensions" / "anthropic.claude-code-test" / "webview"
    d.mkdir(parents=True)
    js = d / "index.js"; js.write_text(js_body, encoding="utf-8")
    css = d / "index.css"; css.write_text(css_body, encoding="utf-8")
    return js, css


class PatcherTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_mod()
        self.assertTrue(self.mod.INJECT_JS.strip(), "embed not generated; run tools/gen-embeds")
        self.assertTrue(self.mod.INJECT_CSS.strip(), "embed not generated; run tools/gen-embeds")

    def test_appended_block_is_asi_safe_after_no_semicolon_bundle(self):
        # If the bundle's last statement is an expression with no trailing semicolon,
        # the appended IIFE must not parse as a call on it (ASI). The payload's leading
        # ';' guards this; executing the patched bundle under node must not throw.
        with tempfile.TemporaryDirectory() as td:
            js, _ = make_webview(td, "globalThis.__ccwa_marker = 1\n")  # no trailing ;
            self.assertEqual(self.mod.patch_file(str(js), self.mod.INJECT_JS), "PATCHED")
            res = subprocess.run(["node", str(js)], capture_output=True, text=True)
            self.assertEqual(res.returncode, 0, res.stderr)

    def test_apply_appends_sentinel_block_to_both_files(self):
        with tempfile.TemporaryDirectory() as td:
            js, css = make_webview(td, "console.log(1)\n")
            self.assertEqual(self.mod.patch_file(str(js), self.mod.INJECT_JS), "PATCHED")
            self.assertEqual(self.mod.patch_file(str(css), self.mod.INJECT_CSS), "PATCHED")
            jt = js.read_text(encoding="utf-8")
            self.assertIn(OPEN, jt)
            self.assertIn(CLOSE, jt)
            self.assertIn("cc-md-copy", jt)  # the IIFE payload is present
            self.assertTrue(jt.startswith("console.log(1)"))  # original preserved
            self.assertIn(OPEN, css.read_text(encoding="utf-8"))

    def test_apply_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            js, _ = make_webview(td, "x\n")
            self.assertEqual(self.mod.patch_file(str(js), self.mod.INJECT_JS), "PATCHED")
            first = js.read_text(encoding="utf-8")
            self.assertEqual(self.mod.patch_file(str(js), self.mod.INJECT_JS), "already-patched")
            self.assertEqual(js.read_text(encoding="utf-8"), first)
            self.assertEqual(first.count(OPEN), 1)

    def test_revert_is_exact_reverse_transform(self):
        with tempfile.TemporaryDirectory() as td:
            original = "console.log(1)\n"
            js, _ = make_webview(td, original)
            self.mod.patch_file(str(js), self.mod.INJECT_JS)
            self.assertEqual(self.mod.revert_file(str(js)), "REVERTED")
            self.assertEqual(js.read_text(encoding="utf-8"), original)  # byte-exact

    def test_revert_composes_leaving_context_icon_intact(self):
        with tempfile.TemporaryDirectory() as td:
            # a bundle already carrying a context-icon MARKED patch
            original = f"head {CONTEXT_MARKED} tail\n"
            js, _ = make_webview(td, original)
            self.mod.patch_file(str(js), self.mod.INJECT_JS)
            self.assertIn(CONTEXT_MARKED, js.read_text(encoding="utf-8"))
            self.assertIn(OPEN, js.read_text(encoding="utf-8"))
            self.mod.revert_file(str(js))
            after = js.read_text(encoding="utf-8")
            self.assertEqual(after, original)          # md-copy gone
            self.assertIn(CONTEXT_MARKED, after)        # context-icon untouched

    def test_emergency_backup_written_once_and_not_used_by_revert(self):
        with tempfile.TemporaryDirectory() as td:
            js, _ = make_webview(td, "orig\n")
            self.mod.patch_file(str(js), self.mod.INJECT_JS)
            bak = pathlib.Path(str(js) + self.mod.BACKUP_SUFFIX)
            self.assertTrue(bak.exists())
            self.assertEqual(bak.read_text(encoding="utf-8"), "orig\n")
            # corrupt the backup; revert must NOT consult it (reverse-transform only)
            bak.write_text("GARBAGE", encoding="utf-8")
            self.mod.revert_file(str(js))
            self.assertEqual(js.read_text(encoding="utf-8"), "orig\n")

    def test_explicit_index_js_arg_patches_css_sibling_too(self):
        # `add-md-copy.py .../webview/index.js` must patch index.css as well, so an
        # explicit path matches auto-discovery and the index.js+index.css design.
        with tempfile.TemporaryDirectory() as td:
            js, css = make_webview(td, "console.log(1)\n")
            rc = self.mod.main([str(js)])
            self.assertEqual(rc, 0)
            self.assertIn(OPEN, js.read_text(encoding="utf-8"))
            self.assertIn(OPEN, css.read_text(encoding="utf-8"))  # the sibling was patched

    def test_revert_is_marker_scoped_and_keeps_trailing_bytes(self):
        # undo removes ONLY our OPEN..CLOSE block, even when foreign bytes follow
        # CLOSE (a future second end-of-file append feature): marker-scoped removal,
        # not truncate-to-EOF.
        with tempfile.TemporaryDirectory() as td:
            js, _ = make_webview(td, "orig\n")
            self.mod.patch_file(str(js), self.mod.INJECT_JS)
            with open(str(js), "a", encoding="utf-8") as f:
                f.write("\n/* other-feature */\nlater\n")  # bytes after our CLOSE
            self.assertEqual(self.mod.revert_file(str(js)), "REVERTED")
            after = js.read_text(encoding="utf-8")
            self.assertNotIn(OPEN, after)                 # our block is gone
            self.assertIn("/* other-feature */", after)   # foreign bytes preserved
            self.assertTrue(after.startswith("orig\n"))

    @unittest.skipIf(os.name == "nt", "POSIX mode bits")
    def test_apply_preserves_file_mode(self):
        with tempfile.TemporaryDirectory() as td:
            js, _ = make_webview(td, "x\n")
            js.chmod(0o640)
            self.mod.patch_file(str(js), self.mod.INJECT_JS)
            self.assertEqual(stat.S_IMODE(js.stat().st_mode), 0o640)


if __name__ == "__main__":
    unittest.main()
