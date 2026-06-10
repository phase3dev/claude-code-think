#!/usr/bin/env python3
import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import textwrap
import unittest


REPO = pathlib.Path(__file__).resolve().parents[1]
OLD_ICON = ">=50)return null}"
NEW_ICON = ">=101)return null}"


def run(cmd, *, env=None, cwd=REPO, timeout=10):
    merged_env = os.environ.copy()
    if env:
        merged_env.update(env)
    return subprocess.run(
        cmd,
        cwd=cwd,
        env=merged_env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
    )


def make_fake_claude(directory):
    capture = pathlib.Path(directory) / "args.json"
    fake = pathlib.Path(directory) / "claude"
    fake.write_text(
        "#!/usr/bin/env bash\n"
        "python3 - \"$@\" <<'PY'\n"
        "import json, os, sys\n"
        "open(os.environ['CAPTURE_ARGS'], 'w').write(json.dumps(sys.argv[1:]))\n"
        "PY\n",
        encoding="utf-8",
    )
    fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
    return fake, capture


def make_fake_node_cli(directory):
    temp = pathlib.Path(directory)
    capture = temp / "args.json"
    cli = temp / "cli.js"
    cli.write_text(
        "const fs = require('fs');\n"
        "fs.writeFileSync(process.env.CAPTURE_ARGS, JSON.stringify(process.argv.slice(2)));\n",
        encoding="utf-8",
    )
    return cli, capture


def make_fake_cmd_shim(directory, cli):
    shim = pathlib.Path(directory) / "claude.cmd"
    shim.write_text(f'@ECHO off\nnode "{cli}" %*\n', encoding="utf-8")
    return shim


def captured_args(path):
    return json.loads(path.read_text(encoding="utf-8"))


class LauncherRegressionTests(unittest.TestCase):
    @unittest.skipIf(os.name == "nt", "POSIX Bash launcher test")
    def test_bash_thinking_launchers_parse_equals_flags_and_validate_display(self):
        for launcher in ("claudemax",):
            with self.subTest(launcher=launcher):
                with tempfile.TemporaryDirectory() as td:
                    fake, capture = make_fake_claude(td)
                    env = {
                        "CLAUDE_REAL_BIN": str(fake),
                        "CAPTURE_ARGS": str(capture),
                        "CC_PATCH_CONTEXT_ICON": "0",
                    }

                    res = run([str(REPO / "launcher" / launcher), "--thinking=adaptive"], env=env)
                    self.assertEqual(res.returncode, 0, res.stderr)
                    self.assertEqual(
                        captured_args(capture),
                        ["--thinking=adaptive", "--thinking-display", "summarized"],
                    )

                    capture.unlink()
                    res = run(
                        [str(REPO / "launcher" / launcher), "--max-thinking-tokens=123"],
                        env=env,
                    )
                    self.assertEqual(res.returncode, 0, res.stderr)
                    self.assertEqual(
                        captured_args(capture),
                        [
                            "--max-thinking-tokens=123",
                            "--thinking-display",
                            "summarized",
                        ],
                    )

                    capture.unlink()
                    res = run(
                        [
                            str(REPO / "launcher" / launcher),
                            "--thinking",
                            "adaptive",
                            "--thinking-display=omitted",
                        ],
                        env=env,
                    )
                    self.assertEqual(res.returncode, 0, res.stderr)
                    self.assertEqual(
                        captured_args(capture),
                        ["--thinking", "adaptive", "--thinking-display=omitted"],
                    )

                    capture.unlink()
                    bad_env = dict(env)
                    bad_env["CC_THINKING_DISPLAY"] = "bogus"
                    res = run(
                        [str(REPO / "launcher" / launcher), "--thinking=adaptive"],
                        env=bad_env,
                    )
                    self.assertEqual(res.returncode, 0, res.stderr)
                    self.assertIn("invalid CC_THINKING_DISPLAY", res.stderr)
                    self.assertEqual(
                        captured_args(capture),
                        ["--thinking=adaptive", "--thinking-display", "summarized"],
                    )

                    # --thinking=disabled (equals form) must suppress injection even
                    # when a trigger like --print is present.
                    capture.unlink()
                    res = run(
                        [str(REPO / "launcher" / launcher), "--print", "--thinking=disabled"],
                        env=env,
                    )
                    self.assertEqual(res.returncode, 0, res.stderr)
                    self.assertEqual(
                        captured_args(capture),
                        ["--print", "--thinking=disabled"],
                    )

    def test_windows_thinking_launchers_resolve_cmd_shims_without_shell(self):
        for launcher in ("claudemax.win.js",):
            with self.subTest(launcher=launcher):
                with tempfile.TemporaryDirectory() as td:
                    cli, capture = make_fake_node_cli(td)
                    shim = make_fake_cmd_shim(td, cli)

                    env = {
                        "CLAUDE_REAL_BIN": str(shim),
                        "CAPTURE_ARGS": str(capture),
                        "CC_PATCH_CONTEXT_ICON": "0",
                    }
                    res = run(
                        [
                            "node",
                            str(REPO / "launcher" / launcher),
                            "--thinking=adaptive",
                            "literal&arg",
                            "%PATH%",
                            'quoted"arg',
                            "caret^arg",
                        ],
                        env=env,
                    )
                    self.assertEqual(res.returncode, 0, res.stderr)
                    self.assertEqual(
                        captured_args(capture),
                        [
                            "--thinking=adaptive",
                            "literal&arg",
                            "%PATH%",
                            'quoted"arg',
                            "caret^arg",
                            "--thinking-display",
                            "summarized",
                        ],
                    )

    @unittest.skipIf(os.name == "nt", "POSIX Bash launcher test")
    def test_bash_context_icon_launchers_skip_ambiguous_files(self):
        launchers = ("claudemax",)
        for launcher in launchers:
            with self.subTest(launcher=launcher):
                with tempfile.TemporaryDirectory() as td:
                    temp = pathlib.Path(td)
                    fake, capture = make_fake_claude(td)
                    index = (
                        temp
                        / ".vscode"
                        / "extensions"
                        / "anthropic.claude-code-test"
                        / "webview"
                        / "index.js"
                    )
                    index.parent.mkdir(parents=True)
                    original = f"first {OLD_ICON} second {OLD_ICON}"
                    index.write_text(original, encoding="utf-8")

                    res = run(
                        [str(REPO / "launcher" / launcher)],
                        env={
                            "HOME": str(temp),
                            "CLAUDE_REAL_BIN": str(fake),
                            "CAPTURE_ARGS": str(capture),
                        },
                    )
                    self.assertEqual(res.returncode, 0, res.stderr)
                    self.assertEqual(index.read_text(encoding="utf-8"), original)

    @unittest.skipIf(os.name == "nt", "POSIX Bash launcher test")
    def test_bash_context_icon_launchers_patch_single_match(self):
        for launcher in ("claudemax",):
            with self.subTest(launcher=launcher):
                with tempfile.TemporaryDirectory() as td:
                    temp = pathlib.Path(td)
                    fake, capture = make_fake_claude(td)
                    index = (
                        temp
                        / ".vscode"
                        / "extensions"
                        / "anthropic.claude-code-test"
                        / "webview"
                        / "index.js"
                    )
                    index.parent.mkdir(parents=True)
                    index.write_text(f"before {OLD_ICON} after", encoding="utf-8")
                    index.chmod(0o640)

                    res = run(
                        [str(REPO / "launcher" / launcher)],
                        env={
                            "HOME": str(temp),
                            "CLAUDE_REAL_BIN": str(fake),
                            "CAPTURE_ARGS": str(capture),
                        },
                    )
                    self.assertEqual(res.returncode, 0, res.stderr)
                    self.assertEqual(
                        index.read_text(encoding="utf-8"), f"before {NEW_ICON} after"
                    )
                    backup = index.with_name(index.name + ".bak-context-icon")
                    self.assertTrue(backup.exists())
                    self.assertEqual(stat.S_IMODE(index.stat().st_mode), 0o640)

    def test_windows_context_icon_launchers_skip_ambiguous_files(self):
        win_launchers = ("claudemax.win.js",)
        for launcher in win_launchers:
            with self.subTest(launcher=launcher):
                with tempfile.TemporaryDirectory() as td:
                    temp = pathlib.Path(td)
                    cli, capture = make_fake_node_cli(td)
                    shim = make_fake_cmd_shim(td, cli)
                    index = (
                        temp
                        / ".vscode"
                        / "extensions"
                        / "anthropic.claude-code-test"
                        / "webview"
                        / "index.js"
                    )
                    index.parent.mkdir(parents=True)
                    original = f"first {OLD_ICON} second {OLD_ICON}"
                    index.write_text(original, encoding="utf-8")

                    res = run(
                        ["node", str(REPO / "launcher" / launcher)],
                        env={
                            "HOME": str(temp),
                            "USERPROFILE": str(temp),
                            "CLAUDE_REAL_BIN": str(shim),
                            "CAPTURE_ARGS": str(capture),
                        },
                    )
                    self.assertEqual(res.returncode, 0, res.stderr)
                    self.assertEqual(index.read_text(encoding="utf-8"), original)

    def test_windows_context_icon_launchers_patch_single_match(self):
        for launcher in ("claudemax.win.js",):
            with self.subTest(launcher=launcher):
                with tempfile.TemporaryDirectory() as td:
                    temp = pathlib.Path(td)
                    cli, capture = make_fake_node_cli(td)
                    shim = make_fake_cmd_shim(td, cli)
                    index = (
                        temp
                        / ".vscode"
                        / "extensions"
                        / "anthropic.claude-code-test"
                        / "webview"
                        / "index.js"
                    )
                    index.parent.mkdir(parents=True)
                    index.write_text(f"before {OLD_ICON} after", encoding="utf-8")

                    res = run(
                        ["node", str(REPO / "launcher" / launcher)],
                        env={
                            "HOME": str(temp),
                            "USERPROFILE": str(temp),
                            "CLAUDE_REAL_BIN": str(shim),
                            "CAPTURE_ARGS": str(capture),
                        },
                    )
                    self.assertEqual(res.returncode, 0, res.stderr)
                    self.assertEqual(
                        index.read_text(encoding="utf-8"), f"before {NEW_ICON} after"
                    )
                    backup = index.with_name(index.name + ".bak-context-icon")
                    self.assertTrue(backup.exists())


class ProxyRegressionTests(unittest.TestCase):
    def test_proxy_exports_header_filters_that_strip_hop_by_hop_headers(self):
        script = textwrap.dedent(
            """
            const assert = require('assert');
            const { headersForUpstream, headersForClient } = require('./proxy.js');
            const inbound = {
              host: '127.0.0.1:8788',
              connection: 'keep-alive, x-remove-me',
              'x-remove-me': '1',
              'transfer-encoding': 'chunked',
              upgrade: 'websocket',
              'proxy-authorization': 'secret',
              'content-length': '999',
              'x-custom': 'ok'
            };
            const upstream = headersForUpstream(inbound, 12);
            assert.strictEqual(upstream.host, 'api.anthropic.com');
            assert.strictEqual(upstream['content-length'], 12);
            assert.strictEqual(upstream['x-custom'], 'ok');
            for (const name of ['connection', 'x-remove-me', 'transfer-encoding', 'upgrade', 'proxy-authorization']) {
              assert.strictEqual(upstream[name], undefined, name);
            }
            const client = headersForClient({
              connection: 'close',
              'transfer-encoding': 'chunked',
              trailer: 'x-trailer',
              'content-type': 'text/event-stream'
            });
            assert.deepStrictEqual(client, {'content-type': 'text/event-stream'});
            """
        )
        res = run(["node", "-e", script], timeout=5)
        self.assertEqual(res.returncode, 0, res.stderr)


class PatcherRegressionTests(unittest.TestCase):
    def test_fix_context_icon_atomic_replace_preserves_metadata_and_docs_limitation(self):
        source = (REPO / "fix-context-icon.py").read_text(encoding="utf-8")
        self.assertIn("os.replace", source)
        self.assertIn("copystat", source)
        self.assertIn("transient 0%", source)

        spec = importlib.util.spec_from_file_location(
            "fix_context_icon", REPO / "fix-context-icon.py"
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        with tempfile.TemporaryDirectory() as td:
            target = pathlib.Path(td) / "index.js"
            target.write_text(f"before {OLD_ICON} after", encoding="utf-8")
            target.chmod(0o640)
            before = target.stat()

            self.assertEqual(mod.patch_file(str(target)), "PATCHED")
            after = target.stat()
            if os.name != "nt":
                self.assertEqual(
                    stat.S_IMODE(after.st_mode), stat.S_IMODE(before.st_mode)
                )
            # NOTE: this test runs as a single user, so the temp file's owner
            # already matches the target and the os.chown() in
            # write_atomic_preserving_metadata is effectively a no-op. The
            # cross-owner case that actually exercises the chown (root patching a
            # user-owned bundle) requires two UIDs and is NOT covered here; that
            # path is verified by inspection only.
            self.assertEqual(after.st_uid, before.st_uid)
            self.assertEqual(after.st_gid, before.st_gid)
            self.assertEqual(
                target.read_text(encoding="utf-8"), f"before {NEW_ICON} after"
            )
            self.assertTrue((pathlib.Path(str(target) + mod.BACKUP_SUFFIX)).exists())

    def test_patch_extension_avoids_bash4_mapfile(self):
        source = (REPO / "patch-extension.sh").read_text(encoding="utf-8")
        self.assertNotIn("mapfile", source)
        self.assertIn("while IFS= read -r", source)

    def test_live_ab_script_uses_temp_files_and_optional_timeout(self):
        source = (REPO / "test-thinking-display.sh").read_text(encoding="utf-8")
        self.assertIn("mktemp", source)
        self.assertIn("trap", source)
        self.assertNotIn("/tmp/cc_t_a.jsonl", source)
        self.assertNotIn("/tmp/cc_t_b.jsonl", source)
        self.assertIn("run_with_timeout", source)


if __name__ == "__main__":
    unittest.main()
