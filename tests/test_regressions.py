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
OLD_ICON = "if(t===0)return null;if(c>=50)return null}"
NEW_ICON = "if(c>=101)return null}/*ccwa-context-icon:t:c*/"
ALT_OLD_ICON = "if(Z===0)return null;if(U>=50)return null}"
ALT_NEW_ICON = "if(U>=101)return null}/*ccwa-context-icon:Z:U*/"


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

    # CC_SCRUB_ROUTING clears third-party model-routing env vars before launch so
    # Claude Code lands on the default Anthropic account. Default off (env intact).
    ROUTING_KEYS = [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CONFIG_DIR",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
    ]

    @staticmethod
    def _routing_env(td):
        return {
            "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
            "ANTHROPIC_AUTH_TOKEN": "secret-token",
            "CLAUDE_CONFIG_DIR": str(pathlib.Path(td) / "cfg"),
            "ANTHROPIC_DEFAULT_OPUS_MODEL": "deepseek-v4-pro",
        }

    @unittest.skipIf(os.name == "nt", "POSIX Bash launcher test")
    def test_bash_launcher_scrubs_routing_env_only_when_enabled(self):
        keys = self.ROUTING_KEYS
        with tempfile.TemporaryDirectory() as td:
            fake = pathlib.Path(td) / "claude"
            capture = pathlib.Path(td) / "env.json"
            fake.write_text(
                "#!/usr/bin/env bash\n"
                "python3 - <<'PY'\n"
                "import json, os\n"
                "keys = json.loads(os.environ['CAPTURE_KEYS'])\n"
                "data = {}\n"
                "for k in keys:\n"
                "    data[k] = os.environ.get(k)\n"
                "open(os.environ['CAPTURE_ENV'], 'w').write(json.dumps(data))\n"
                "PY\n",
                encoding="utf-8",
            )
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)

            routing = self._routing_env(td)
            base = {
                "HOME": td,            # keep reconcile away from real webview bundles
                "CC_RECONCILE": "0",   # do not read or write any bundle this launch
                "CLAUDE_REAL_BIN": str(fake),
                "CAPTURE_ENV": str(capture),
                "CAPTURE_KEYS": json.dumps(keys),
                **routing,
            }
            launcher = str(REPO / "launcher" / "claudemax")

            res = run([launcher], env=base)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(json.loads(capture.read_text(encoding="utf-8")), routing)

            res = run([launcher], env={**base, "CC_SCRUB_ROUTING": "1"})
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(
                json.loads(capture.read_text(encoding="utf-8")),
                {k: None for k in keys},
            )

    def test_windows_launcher_scrubs_routing_env_only_when_enabled(self):
        keys = self.ROUTING_KEYS
        with tempfile.TemporaryDirectory() as td:
            temp = pathlib.Path(td)
            capture = temp / "env.json"
            cli = temp / "cli.js"
            cli.write_text(
                "const fs = require('fs');\n"
                "const keys = JSON.parse(process.env.CAPTURE_KEYS);\n"
                "const out = {};\n"
                "for (const k of keys) out[k] = (k in process.env) ? process.env[k] : null;\n"
                "fs.writeFileSync(process.env.CAPTURE_ENV, JSON.stringify(out));\n",
                encoding="utf-8",
            )
            shim = make_fake_cmd_shim(td, cli)

            routing = self._routing_env(td)
            base = {
                "HOME": td,
                "USERPROFILE": td,
                "CC_RECONCILE": "0",
                "CLAUDE_REAL_BIN": str(shim),
                "CAPTURE_ENV": str(capture),
                "CAPTURE_KEYS": json.dumps(keys),
                **routing,
            }
            launcher = str(REPO / "launcher" / "claudemax.win.js")

            res = run(["node", launcher], env=base)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(json.loads(capture.read_text(encoding="utf-8")), routing)

            res = run(["node", launcher], env={**base, "CC_SCRUB_ROUTING": "1"})
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertEqual(
                json.loads(capture.read_text(encoding="utf-8")),
                {k: None for k in keys},
            )

    def test_launchers_expose_local_env_injection_anchor(self):
        # The marker pair is a stable contract: the Linux deploy step and the
        # Windows build.ps1 splice a private env file between these lines.
        for name in ("claudemax", "claudemax.win.js"):
            with self.subTest(launcher=name):
                src = (REPO / "launcher" / name).read_text(encoding="utf-8")
                self.assertIn("CC_SCRUB_ROUTING", src)
                self.assertIn(">>> ccwa-local-env >>>", src)
                self.assertIn("<<< ccwa-local-env <<<", src)


class ProxyRegressionTests(unittest.TestCase):
    def test_proxy_exports_header_filters_that_strip_hop_by_hop_headers(self):
        script = textwrap.dedent(
            """
            const assert = require('assert');
            const { headersForUpstream, headersForClient } = require('./fixes/thinking-summaries/proxy.js');
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
        source = (REPO / "fixes" / "context-icon" / "fix-context-icon.py").read_text(encoding="utf-8")
        self.assertIn("os.replace", source)
        self.assertIn("copystat", source)
        self.assertIn("transient 0%", source)

        spec = importlib.util.spec_from_file_location(
            "fix_context_icon", REPO / "fixes" / "context-icon" / "fix-context-icon.py"
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
            patched_text = target.read_text(encoding="utf-8")
            self.assertIn("/*ccwa-context-icon", patched_text)
            self.assertEqual(patched_text, f"before {mod.NEW} after")
            self.assertTrue((pathlib.Path(str(target) + mod.BACKUP_SUFFIX)).exists())
            # Idempotent: a second patch is a no-op.
            self.assertEqual(mod.patch_file(str(target)), "already-patched")

    def test_fix_context_icon_patches_renamed_minified_guard_vars(self):
        spec = importlib.util.spec_from_file_location(
            "fix_context_icon", REPO / "fixes" / "context-icon" / "fix-context-icon.py"
        )
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)

        with tempfile.TemporaryDirectory() as td:
            target = pathlib.Path(td) / "index.js"
            target.write_text(f"before {ALT_OLD_ICON} after", encoding="utf-8")

            self.assertEqual(mod.patch_file(str(target)), "PATCHED")
            self.assertEqual(target.read_text(encoding="utf-8"), f"before {ALT_NEW_ICON} after")
            backup = pathlib.Path(str(target) + mod.BACKUP_SUFFIX)
            self.assertEqual(backup.read_text(encoding="utf-8"), f"before {ALT_OLD_ICON} after")
            self.assertEqual(mod.patch_file(str(target)), "already-patched")

    def test_patch_extension_avoids_bash4_mapfile(self):
        source = (REPO / "fixes" / "thinking-summaries" / "patch-extension.sh").read_text(encoding="utf-8")
        self.assertNotIn("mapfile", source)
        self.assertIn("while IFS= read -r", source)

    def test_live_ab_script_uses_temp_files_and_optional_timeout(self):
        source = (REPO / "fixes" / "thinking-summaries" / "test-thinking-display.sh").read_text(encoding="utf-8")
        self.assertIn("mktemp", source)
        self.assertIn("trap", source)
        self.assertNotIn("/tmp/cc_t_a.jsonl", source)
        self.assertNotIn("/tmp/cc_t_b.jsonl", source)
        self.assertIn("run_with_timeout", source)


if __name__ == "__main__":
    unittest.main()
