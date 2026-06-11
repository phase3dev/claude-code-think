#!/usr/bin/env python3
"""Reconcile-engine regression tests for the unified launcher (bash + node).

These cover the feature registry, per-file reconcile (undo-all-then-apply-
enabled), ownership marking, the master switch, the emergency bypass, and
bash/node parity. Helpers are reused from test_regressions (same tests/ dir, on
sys.path under `unittest discover`).
"""
import os
import pathlib
import stat
import tempfile
import unittest

from test_regressions import (
    run,
    make_fake_claude,
    make_fake_node_cli,
    make_fake_cmd_shim,
    captured_args,
)

REPO = pathlib.Path(__file__).resolve().parents[1]
LAUNCHER_BASH = REPO / "launcher" / "claudemax"
LAUNCHER_WIN = REPO / "launcher" / "claudemax.win.js"

OLD = "if(t===0)return null;if(c>=50)return null}"
MARKER = "/*ccwa-context-icon:t:c*/"
MARKED = "if(c>=101)return null}" + MARKER
LEGACY_MARKER = "/*ccwa-context-icon*/"
LEGACY_CURRENT_MARKED = "if(c>=101)return null}" + LEGACY_MARKER
LEGACY_MARKED = "if(t===0)return null;if(c>=101)return null}" + LEGACY_MARKER
BARE101 = "if(t===0)return null;if(c>=101)return null}"
ALT_OLD = "if(Z===0)return null;if(U>=50)return null}"
ALT_MARKED = "if(U>=101)return null}/*ccwa-context-icon:Z:U*/"
BAK = ".bak-cc-workarounds"
MD_OPEN = "/* cc-md-copy v1 */"
MD_CLOSE = "/* /cc-md-copy v1 */"
STRAY_FRAGMENTS = (".ccbase.", ".ccnew.", ".ccwrite.", ".ccapply.", ".ccundo.", ".ccpatch.", ".ccmdapply.", ".ccmdundo.")


def make_extension(home, content):
    """Create a fake installed extension webview/index.js under HOME and return it."""
    idx = (
        pathlib.Path(home)
        / ".vscode"
        / "extensions"
        / "anthropic.claude-code-test"
        / "webview"
        / "index.js"
    )
    idx.parent.mkdir(parents=True)
    idx.write_text(content, encoding="utf-8")
    return idx


def make_extension_outside_scan(td, content):
    """Create an extension whose root is NOT under any HOME .vscode scan dir.

    Returns (index_js, extroot, bindir). The extension's bundled binary lives at
    <extroot>/resources/native-binary/, mirroring the real layout the official
    process-wrapper hands the launcher. Reaching this bundle requires the precise
    walk-up from the resolved binary path; the HOME fallback scan never sees it.
    """
    extroot = pathlib.Path(td) / "custom-ext-dir" / "anthropic.claude-code-9.9.9"
    idx = extroot / "webview" / "index.js"
    idx.parent.mkdir(parents=True)
    idx.write_text(content, encoding="utf-8")
    bindir = extroot / "resources" / "native-binary"
    bindir.mkdir(parents=True)
    return idx, extroot, bindir


class ReconcileMixin:
    """Platform-agnostic reconcile assertions. Subclasses implement `_run`/`_captured`."""

    def _run(self, td, home, args=None, env_extra=None):
        raise NotImplementedError

    def _captured(self):
        return captured_args(self._capture_path)

    def test_apply_writes_marked_form_and_pristine_backup(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"before {OLD} after")
            res = self._run(td, home)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {MARKED} after")
            bak = idx.with_name(idx.name + BAK)
            self.assertTrue(bak.exists())
            self.assertEqual(bak.read_text(encoding="utf-8"), f"before {OLD} after")

    def test_apply_accepts_renamed_minified_guard_vars(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"before {ALT_OLD} after")
            res = self._run(td, home)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {ALT_MARKED} after")
            self.assertNotIn("anchor not found", res.stderr)
            bak = idx.with_name(idx.name + BAK)
            self.assertTrue(bak.exists())
            self.assertEqual(bak.read_text(encoding="utf-8"), f"before {ALT_OLD} after")

    def test_reconcile_is_idempotent_and_leaves_no_temp_files(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"x {OLD} y")
            self.assertEqual(self._run(td, home).returncode, 0)
            first = idx.read_text(encoding="utf-8")
            self.assertEqual(first, f"x {MARKED} y")
            self.assertEqual(self._run(td, home).returncode, 0)
            self.assertEqual(idx.read_text(encoding="utf-8"), first)
            strays = [
                p.name
                for p in idx.parent.iterdir()
                if any(s in p.name for s in STRAY_FRAGMENTS)
            ]
            self.assertEqual(strays, [])

    def test_disabling_feature_reverts_only_that_feature(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"before {MARKED} after")
            res = self._run(td, home, env_extra={"CC_PATCH_CONTEXT_ICON": "0"})
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {OLD} after")

    def test_disabling_feature_reverts_renamed_var_marker_to_same_vars(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"before {ALT_MARKED} after")
            res = self._run(td, home, env_extra={"CC_PATCH_CONTEXT_ICON": "0"})
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {ALT_OLD} after")
            self.assertNotIn("anchor not found", res.stderr)

    def test_master_switch_reverts_all_and_injects_nothing(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"before {MARKED} after")
            res = self._run(
                td, home, args=["--thinking=adaptive"], env_extra={"CC_WORKAROUNDS": "0"}
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {OLD} after")
            self.assertEqual(self._captured(), ["--thinking=adaptive"])

    def test_legacy_bare_patch_is_upgraded_to_marked_when_enabled(self):
        # A bundle left by the OLD launcher/standalone carries the bare,
        # unmarked >=101 form while still keeping the old t===0 guard. Reconcile
        # adopts it as a legacy fingerprint, upgrading it to the current marked
        # form and capturing the correct pristine combined guard - without the
        # spurious "anchor not found" warning the marker-only path used to emit.
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"before {BARE101} after")
            res = self._run(td, home)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {MARKED} after")
            self.assertNotIn("anchor not found", res.stderr)
            bak = idx.with_name(idx.name + BAK)
            self.assertTrue(bak.exists())
            self.assertEqual(bak.read_text(encoding="utf-8"), f"before {OLD} after")

    def test_legacy_marked_patch_is_upgraded_to_show_icon_during_reload_gap(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"before {LEGACY_MARKED} after")
            res = self._run(td, home)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {MARKED} after")
            bak = idx.with_name(idx.name + BAK)
            self.assertTrue(bak.exists())
            self.assertEqual(bak.read_text(encoding="utf-8"), f"before {OLD} after")

    def test_legacy_current_marked_patch_is_upgraded_to_metadata_marker(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"before {LEGACY_CURRENT_MARKED} after")
            res = self._run(td, home)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {MARKED} after")
            self.assertNotIn("anchor not found", res.stderr)

    def test_legacy_bare_patch_is_reverted_when_feature_disabled(self):
        # Migration-table promise: disabling the fix reverts our edit. A legacy
        # bare patch must revert to pristine just like a marked one does.
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"before {BARE101} after")
            res = self._run(td, home, env_extra={"CC_PATCH_CONTEXT_ICON": "0"})
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {OLD} after")
            self.assertNotIn("anchor not found", res.stderr)

    def test_legacy_marked_patch_is_reverted_when_feature_disabled(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"before {LEGACY_MARKED} after")
            res = self._run(td, home, env_extra={"CC_PATCH_CONTEXT_ICON": "0"})
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {OLD} after")
            self.assertNotIn("anchor not found", res.stderr)

    def test_legacy_bare_patch_is_reverted_by_master_switch(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"before {BARE101} after")
            res = self._run(td, home, env_extra={"CC_WORKAROUNDS": "0"})
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {OLD} after")

    def test_unrecognized_bundle_warns_and_is_left_untouched(self):
        # The genuine "extension changed" signal must survive: a bundle with
        # neither our anchor nor either of our fingerprints is left untouched and
        # still warns (so a real upstream change is not silently ignored).
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            original = "totally unrelated minified code; return null}"
            idx = make_extension(home, original)
            res = self._run(td, home)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), original)
            self.assertIn("anchor not found", res.stderr)

    def test_reconcile_bypass_leaves_bundle_untouched_but_still_injects(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            original = f"before {OLD} after"
            idx = make_extension(home, original)
            res = self._run(
                td, home, args=["--thinking=adaptive"], env_extra={"CC_RECONCILE": "0"}
            )
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), original)
            self.assertEqual(
                self._captured(),
                ["--thinking=adaptive", "--thinking-display", "summarized"],
            )

    def test_stale_backup_is_ignored_by_routine_reconcile(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"before {OLD} after")
            bak = idx.with_name(idx.name + BAK)
            bak.write_text("GARBAGE-DO-NOT-USE", encoding="utf-8")
            res = self._run(td, home)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {MARKED} after")
            self.assertEqual(bak.read_text(encoding="utf-8"), "GARBAGE-DO-NOT-USE")

    def test_ambiguous_match_is_skipped(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            original = f"first {OLD} second {OLD}"
            idx = make_extension(home, original)
            res = self._run(td, home)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), original)


class MdCopyReconcileMixin:
    """md-copy reconcile assertions (append feature on index.js + index.css, and
    composition with context-icon). Subclasses provide `_run` and inherit from
    ReconcileMixin too (so make_extension/_captured are available)."""

    def _css_sibling(self, idx, content=".x{}\n"):
        css = idx.with_name("index.css")
        css.write_text(content, encoding="utf-8")
        return css

    def test_md_copy_block_applied_to_js_and_css_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, "console.log(1)\n")
            css = self._css_sibling(idx)
            self.assertEqual(self._run(td, home, env_extra={"CC_PATCH_MD_COPY": "1"}).returncode, 0)
            jt, ct = idx.read_text(encoding="utf-8"), css.read_text(encoding="utf-8")
            self.assertIn(MD_OPEN, jt)
            self.assertIn(MD_CLOSE, jt)
            self.assertIn("cc-md-copy", jt)   # the IIFE payload landed
            self.assertTrue(jt.startswith("console.log(1)"))
            self.assertIn(MD_OPEN, ct)
            # idempotent: a second launch changes nothing and leaves no temp files
            self.assertEqual(self._run(td, home, env_extra={"CC_PATCH_MD_COPY": "1"}).returncode, 0)
            self.assertEqual(idx.read_text(encoding="utf-8"), jt)
            self.assertEqual(jt.count(MD_OPEN), 1)
            strays = [p.name for p in idx.parent.iterdir() if any(s in p.name for s in STRAY_FRAGMENTS)]
            self.assertEqual(strays, [])

    def test_md_copy_reverted_when_disabled(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            original = "console.log(1)\n"
            idx = make_extension(home, original)
            css = self._css_sibling(idx)
            self.assertEqual(self._run(td, home, env_extra={"CC_PATCH_MD_COPY": "1"}).returncode, 0)
            self.assertIn(MD_OPEN, idx.read_text(encoding="utf-8"))
            # disable -> reconcile removes our block, byte-exactly
            self.assertEqual(self._run(td, home, env_extra={"CC_PATCH_MD_COPY": "0"}).returncode, 0)
            self.assertEqual(idx.read_text(encoding="utf-8"), original)
            self.assertNotIn(MD_OPEN, css.read_text(encoding="utf-8"))

    def test_md_copy_composes_with_context_icon_on_index_js(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"head {OLD} tail\n")
            self._css_sibling(idx)
            # both features on
            self.assertEqual(self._run(td, home, env_extra={"CC_PATCH_MD_COPY": "1"}).returncode, 0)
            both = idx.read_text(encoding="utf-8")
            self.assertIn(MARKED, both)        # context-icon applied
            self.assertIn(MD_OPEN, both)       # md-copy applied
            # turn context-icon OFF, md-copy stays on -> context reverts, md-copy intact
            self.assertEqual(self._run(td, home, env_extra={"CC_PATCH_CONTEXT_ICON": "0", "CC_PATCH_MD_COPY": "1"}).returncode, 0)
            t = idx.read_text(encoding="utf-8")
            self.assertIn(OLD, t)
            self.assertNotIn(MARKED, t)
            self.assertIn(MD_OPEN, t)
            # turn md-copy OFF, context-icon back on -> md-copy reverts, context intact
            self.assertEqual(self._run(td, home, env_extra={"CC_PATCH_MD_COPY": "0"}).returncode, 0)
            t2 = idx.read_text(encoding="utf-8")
            self.assertIn(MARKED, t2)
            self.assertNotIn(MD_OPEN, t2)

    def test_master_switch_reverts_md_copy_too(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            original = "x\n"
            idx = make_extension(home, original)
            css = self._css_sibling(idx)
            self.assertEqual(self._run(td, home, env_extra={"CC_PATCH_MD_COPY": "1"}).returncode, 0)
            self.assertIn(MD_OPEN, idx.read_text(encoding="utf-8"))
            self.assertEqual(self._run(td, home, env_extra={"CC_WORKAROUNDS": "0"}).returncode, 0)
            self.assertEqual(idx.read_text(encoding="utf-8"), original)
            self.assertNotIn(MD_OPEN, css.read_text(encoding="utf-8"))


@unittest.skipIf(os.name == "nt", "POSIX bash launcher test")
class BashReconcileTests(ReconcileMixin, MdCopyReconcileMixin, unittest.TestCase):
    def _run(self, td, home, args=None, env_extra=None):
        fake, capture = make_fake_claude(td)
        self._capture_path = capture
        env = {
            "HOME": str(home),
            "CLAUDE_REAL_BIN": str(fake),
            "CAPTURE_ARGS": str(capture),
            # Default md-copy off so ReconcileMixin tests (which assert context-icon
            # only) are unaffected; MdCopyReconcileMixin tests pass CC_PATCH_MD_COPY=1.
            "CC_PATCH_MD_COPY": "0",
        }
        if env_extra:
            env.update(env_extra)
        return run([str(LAUNCHER_BASH), *(args or [])], env=env)

    def test_apply_preserves_file_mode(self):
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td)
            idx = make_extension(home, f"before {OLD} after")
            idx.chmod(0o640)
            res = self._run(td, home)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(stat.S_IMODE(idx.stat().st_mode), 0o640)

    def test_precise_walkup_patches_extension_outside_scan_dirs(self):
        # bash walks up from REAL_CLAUDE, so this already held; it guards against
        # regressing the precise-target path the Windows fix brings to parity.
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td) / "empty-home"
            home.mkdir()
            idx, _extroot, bindir = make_extension_outside_scan(td, f"before {OLD} after")
            fake = bindir / "claude"
            fake.write_text(
                "#!/usr/bin/env bash\n"
                "python3 - \"$@\" <<'PY'\n"
                "import json, os, sys\n"
                "open(os.environ['CAPTURE_ARGS'], 'w').write(json.dumps(sys.argv[1:]))\n"
                "PY\n",
                encoding="utf-8",
            )
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            capture = pathlib.Path(td) / "args.json"
            env = {
                "HOME": str(home),
                "CLAUDE_REAL_BIN": str(fake),
                "CAPTURE_ARGS": str(capture),
                "CC_PATCH_MD_COPY": "0",
            }
            res = run([str(LAUNCHER_BASH), "--thinking=adaptive"], env=env)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {MARKED} after")


class WinReconcileTests(ReconcileMixin, MdCopyReconcileMixin, unittest.TestCase):
    def _run(self, td, home, args=None, env_extra=None):
        cli, capture = make_fake_node_cli(td)
        shim = make_fake_cmd_shim(td, cli)
        self._capture_path = capture
        env = {
            "HOME": str(home),
            "USERPROFILE": str(home),
            "CLAUDE_REAL_BIN": str(shim),
            "CAPTURE_ARGS": str(capture),
            # Default md-copy off so ReconcileMixin tests (which assert context-icon
            # only) are unaffected; MdCopyReconcileMixin tests pass CC_PATCH_MD_COPY=1.
            "CC_PATCH_MD_COPY": "0",
        }
        if env_extra:
            env.update(env_extra)
        return run(["node", str(LAUNCHER_WIN), *(args or [])], env=env)

    def test_precise_walkup_patches_extension_outside_scan_dirs(self):
        # Finding 2: when CLAUDE_REAL_BIN resolves to the extension's bundled
        # binary in a location the HOME fallback scan never sees, reconcile must
        # still patch that extension via the precise walk-up from the resolved
        # binary. The old code passed only wrapperBin (null on a terminal launch),
        # so the bundle was left unpatched; reconcile(wrapperBin || claude) fixes it.
        with tempfile.TemporaryDirectory() as td:
            home = pathlib.Path(td) / "empty-home"
            home.mkdir()
            idx, _extroot, bindir = make_extension_outside_scan(td, f"before {OLD} after")
            cli, capture = make_fake_node_cli(td)
            shim = bindir / "claude.cmd"  # the extension's bundled npm-shim binary
            shim.write_text(f'@ECHO off\nnode "{cli}" %*\n', encoding="utf-8")
            env = {
                "HOME": str(home),
                "USERPROFILE": str(home),
                "CLAUDE_REAL_BIN": str(shim),
                "CAPTURE_ARGS": str(capture),
                "CC_PATCH_MD_COPY": "0",
            }
            res = run(["node", str(LAUNCHER_WIN), "--thinking=adaptive"], env=env)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(idx.read_text(encoding="utf-8"), f"before {MARKED} after")


@unittest.skipIf(os.name == "nt", "needs both bash and node on PATH")
class ParityTests(unittest.TestCase):
    def test_bash_and_node_produce_identical_bundle_and_args(self):
        results = {}
        for kind in ("bash", "node"):
            with tempfile.TemporaryDirectory() as td:
                home = pathlib.Path(td)
                idx = make_extension(home, f"before {OLD} after")
                css = idx.with_name("index.css")
                css.write_text(".x{}\n", encoding="utf-8")
                if kind == "bash":
                    fake, capture = make_fake_claude(td)
                    env = {
                        "HOME": str(home),
                        "CLAUDE_REAL_BIN": str(fake),
                        "CAPTURE_ARGS": str(capture),
                    }
                    res = run([str(LAUNCHER_BASH), "--max-thinking-tokens=200"], env=env)
                else:
                    cli, capture = make_fake_node_cli(td)
                    shim = make_fake_cmd_shim(td, cli)
                    env = {
                        "HOME": str(home),
                        "USERPROFILE": str(home),
                        "CLAUDE_REAL_BIN": str(shim),
                        "CAPTURE_ARGS": str(capture),
                    }
                    res = run(
                        ["node", str(LAUNCHER_WIN), "--max-thinking-tokens=200"], env=env
                    )
                self.assertEqual(res.returncode, 0, res.stderr)
                results[kind] = (
                    idx.read_text(encoding="utf-8"),
                    captured_args(capture),
                    css.read_text(encoding="utf-8"),
                )
        # identical bytes from both launchers, for index.js AND index.css
        self.assertEqual(results["bash"][0], results["node"][0])  # index.js
        self.assertEqual(results["bash"][2], results["node"][2])  # index.css
        self.assertEqual(results["bash"][1], results["node"][1])  # injected args
        # index.js carries the context-icon swap AND the md-copy block; css the block
        self.assertIn(MARKED, results["bash"][0])
        self.assertIn(MD_OPEN, results["bash"][0])
        self.assertIn(MD_OPEN, results["bash"][2])
        self.assertEqual(
            results["bash"][1],
            ["--max-thinking-tokens=200", "--thinking-display", "summarized"],
        )


if __name__ == "__main__":
    unittest.main()
