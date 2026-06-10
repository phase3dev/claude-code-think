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

OLD = ">=50)return null}"
MARKER = "/*ccwa-context-icon*/"
MARKED = ">=101)return null}" + MARKER
BARE101 = ">=101)return null}"
BAK = ".bak-cc-workarounds"
STRAY_FRAGMENTS = (".ccbase.", ".ccnew.", ".ccwrite.", ".ccapply.", ".ccundo.", ".ccpatch.")


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

    def test_unmarked_upstream_value_is_left_untouched(self):
        for env_extra in ({}, {"CC_PATCH_CONTEXT_ICON": "0"}):
            with self.subTest(env=env_extra):
                with tempfile.TemporaryDirectory() as td:
                    home = pathlib.Path(td)
                    original = f"keep {BARE101} this"
                    idx = make_extension(home, original)
                    res = self._run(td, home, env_extra=env_extra)
                    self.assertEqual(res.returncode, 0, res.stderr)
                    self.assertEqual(idx.read_text(encoding="utf-8"), original)

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


@unittest.skipIf(os.name == "nt", "POSIX bash launcher test")
class BashReconcileTests(ReconcileMixin, unittest.TestCase):
    def _run(self, td, home, args=None, env_extra=None):
        fake, capture = make_fake_claude(td)
        self._capture_path = capture
        env = {
            "HOME": str(home),
            "CLAUDE_REAL_BIN": str(fake),
            "CAPTURE_ARGS": str(capture),
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


if __name__ == "__main__":
    unittest.main()
