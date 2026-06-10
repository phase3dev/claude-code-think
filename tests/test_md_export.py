#!/usr/bin/env python3
"""Tests for cc-export.py: session resolution, markdown/text rendering, opt-in
thinking/tools, and --open. Synthetic JSONL pins the documented row schema
without needing a real transcript."""
import importlib.util
import json
import os
import pathlib
import stat
import tempfile
import unittest

REPO = pathlib.Path(__file__).resolve().parents[1]
EXPORT_PY = REPO / "fixes" / "markdown-copy-export" / "cc-export.py"


def load_export():
    spec = importlib.util.spec_from_file_location("cc_export", EXPORT_PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def write_session(projects_dir, project_key, session_id, rows):
    d = pathlib.Path(projects_dir) / project_key
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{session_id}.jsonl"
    p.write_text("".join(json.dumps(r) + "\n" for r in rows), encoding="utf-8")
    return p


# A small but representative transcript (documented shapes from spec §2).
ROWS = [
    {"type": "user", "message": {"role": "user", "content": "Hello **world**"}},
    {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "thinking", "thinking": "secret reasoning", "signature": "sig"},
        {"type": "text", "text": "Hi there"},
        {"type": "tool_use", "id": "t1", "name": "Bash", "input": {"command": "ls"}},
    ]}},
    {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "file.txt"},
        {"type": "text", "text": "thanks"},
    ]}},
    {"type": "summary", "summary": "ignored metadata row"},
    {"type": "file-history-snapshot", "snapshot": {"ignored": True}},
]


class CcExportTests(unittest.TestCase):
    def setUp(self):
        self.mod = load_export()

    def test_markdown_default_is_readable_conversation_only(self):
        md = self.mod.render(ROWS, fmt="markdown", include_thinking=False, include_tools=False)
        self.assertIn("## User", md)
        self.assertIn("Hello **world**", md)
        self.assertIn("## Assistant", md)
        self.assertIn("Hi there", md)
        self.assertIn("thanks", md)
        # thinking and tools are excluded by default
        self.assertNotIn("secret reasoning", md)
        self.assertNotIn("Bash", md)
        self.assertNotIn("file.txt", md)

    def test_include_thinking_adds_thinking_blocks(self):
        md = self.mod.render(ROWS, fmt="markdown", include_thinking=True, include_tools=False)
        self.assertIn("secret reasoning", md)
        self.assertNotIn("Bash", md)

    def test_include_tools_adds_tool_use_and_result(self):
        md = self.mod.render(ROWS, fmt="markdown", include_thinking=False, include_tools=True)
        self.assertIn("Bash", md)
        self.assertIn("ls", md)
        self.assertIn("file.txt", md)

    def test_text_format_has_no_role_markdown_headers(self):
        txt = self.mod.render(ROWS, fmt="text", include_thinking=False, include_tools=False)
        self.assertIn("Hi there", txt)
        self.assertNotIn("## User", txt)
        self.assertNotIn("## Assistant", txt)

    def test_resolve_latest_in_cwd_project_dir(self):
        with tempfile.TemporaryDirectory() as td:
            config = pathlib.Path(td) / "config"
            projects = config / "projects"
            cwd = pathlib.Path(td) / "work" / "proj"
            cwd.mkdir(parents=True)
            key = self.mod.project_key_for_cwd(str(cwd))
            write_session(projects, key, "older", [ROWS[0]])
            newer = write_session(projects, key, "newer", [ROWS[0]])
            os.utime(newer, (10**10, 10**10))  # make 'newer' the most recent (yr 2286; 10**9 is 2001 = past)
            got = self.mod.resolve_session(config=str(config), cwd=str(cwd), session_id=None)
            self.assertEqual(pathlib.Path(got).name, "newer.jsonl")

    def test_resolve_explicit_session_scans_other_project_dirs(self):
        with tempfile.TemporaryDirectory() as td:
            config = pathlib.Path(td) / "config"
            projects = config / "projects"
            cwd = pathlib.Path(td) / "work" / "proj"
            cwd.mkdir(parents=True)
            # session lives under a DIFFERENT project key than the current cwd
            write_session(projects, "some-other-key", "abc123", [ROWS[0]])
            got = self.mod.resolve_session(config=str(config), cwd=str(cwd), session_id="abc123")
            self.assertEqual(pathlib.Path(got).name, "abc123.jsonl")

    def test_resolve_missing_returns_none(self):
        with tempfile.TemporaryDirectory() as td:
            config = pathlib.Path(td) / "config"
            (config / "projects").mkdir(parents=True)
            cwd = pathlib.Path(td) / "nope"
            cwd.mkdir()
            self.assertIsNone(
                self.mod.resolve_session(config=str(config), cwd=str(cwd), session_id="ghost")
            )

    def test_open_invokes_editor_with_resolved_path(self):
        # Stub `code` on PATH; assert main(--open) calls it with the jsonl path.
        with tempfile.TemporaryDirectory() as td:
            config = pathlib.Path(td) / "config"
            projects = config / "projects"
            cwd = pathlib.Path(td) / "work" / "proj"
            cwd.mkdir(parents=True)
            key = self.mod.project_key_for_cwd(str(cwd))
            sess = write_session(projects, key, "s1", [ROWS[0]])
            bindir = pathlib.Path(td) / "bin"
            bindir.mkdir()
            capture = pathlib.Path(td) / "opened.txt"
            code = bindir / "code"
            code.write_text(
                "#!/usr/bin/env bash\nprintf '%s' \"$1\" > \"$CC_OPEN_CAPTURE\"\n",
                encoding="utf-8",
            )
            code.chmod(code.stat().st_mode | stat.S_IXUSR)
            env = dict(os.environ)
            env["PATH"] = str(bindir) + os.pathsep + env["PATH"]
            env["CC_OPEN_CAPTURE"] = str(capture)
            rc = self.mod.main(
                ["--open", "--cwd", str(cwd)],
                config=str(config),
                env=env,
            )
            self.assertEqual(rc, 0)
            self.assertEqual(capture.read_text(encoding="utf-8"), str(sess))

    def test_fence_uses_longer_delimiter_when_body_has_backticks(self):
        # a tool/thinking payload that itself contains a ``` run must not close the
        # fence early: the delimiter grows to one more than the longest backtick run.
        out = self.mod._fence("tool_result", "```\ncode\n```")
        self.assertTrue(out.startswith("````tool_result\n"))
        self.assertTrue(out.endswith("\n````"))
        self.assertEqual(out.count("````"), 2)  # exactly one opening + one closing fence

    def test_fence_default_three_backticks_when_no_backticks(self):
        out = self.mod._fence("thinking", "plain text")
        self.assertEqual(out, "```thinking\nplain text\n```")


if __name__ == "__main__":
    unittest.main()
