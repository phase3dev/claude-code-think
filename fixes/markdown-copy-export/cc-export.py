#!/usr/bin/env python3
"""cc-export - export a Claude Code session transcript to Markdown or plain text.

Reads the session JSONL directly (the high-fidelity source: exact text, no
re-conversion), so it is independent of the VS Code webview. Default output is
the readable conversation only (user text + assistant text); thinking and tool
calls are opt-in. `--open` opens the raw .jsonl in the editor instead.

    python3 cc-export.py                       # latest session in this cwd -> stdout (markdown)
    python3 cc-export.py --session ID          # a specific session id
    python3 cc-export.py --format text         # plain text
    python3 cc-export.py --include-thinking --include-tools
    python3 cc-export.py -o out.md             # write to a file
    python3 cc-export.py --open                # open the raw transcript in VS Code
    python3 cc-export.py --cwd /path/to/proj   # resolve as if launched from there

The JSONL is an internal format that can change, so each row's shape is validated
and unknown shapes are skipped rather than assuming a fixed schema.
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import unicodedata


def config_dir(env=None):
    env = env if env is not None else os.environ
    return env.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")


def project_key_for_cwd(cwd):
    """The on-disk project dir name: realpath, NFC-normalized, slashes -> dashes."""
    real = os.path.realpath(cwd)
    norm = unicodedata.normalize("NFC", real)
    return norm.replace(os.sep, "-").replace("/", "-")


def resolve_session(config, cwd, session_id):
    """Return the path to the session JSONL, or None.

    With an explicit id: look in this cwd's project dir, then scan all project
    dirs. With no id: the most recently modified .jsonl in this cwd's project dir.
    """
    projects = os.path.join(config, "projects")
    key = project_key_for_cwd(cwd)
    proj_dir = os.path.join(projects, key)
    if session_id:
        local = os.path.join(proj_dir, f"{session_id}.jsonl")
        if os.path.isfile(local):
            return local
        for hit in glob.glob(os.path.join(projects, "*", f"{session_id}.jsonl")):
            if os.path.isfile(hit):
                return hit
        return None
    candidates = glob.glob(os.path.join(proj_dir, "*.jsonl"))
    if not candidates:
        return None
    return max(candidates, key=lambda p: os.path.getmtime(p))


def read_rows(path):
    rows = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue  # skip a corrupt line rather than abort
    return rows


def _blocks(content):
    """Normalize a message's content to a list of block dicts.

    Content may be a plain string (treated as one text block) or a list.
    """
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    if isinstance(content, list):
        return [b for b in content if isinstance(b, dict)]
    return []


def render(rows, fmt="markdown", include_thinking=False, include_tools=False):
    """Render rows to markdown (with role headers) or plain text."""
    md = fmt != "text"
    parts = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        rtype = row.get("type")
        if rtype not in ("user", "assistant"):
            continue  # skip summary / file-history-snapshot / etc.
        message = row.get("message")
        if not isinstance(message, dict):
            continue
        blocks = _blocks(message.get("content"))
        chunks = []
        for b in blocks:
            bt = b.get("type")
            if bt == "text":
                t = b.get("text")
                if isinstance(t, str) and t.strip():
                    chunks.append(t.rstrip())
            elif bt == "thinking" and include_thinking:
                t = b.get("thinking")
                if isinstance(t, str) and t.strip():
                    chunks.append(_fence("thinking", t) if md else t.rstrip())
            elif bt == "tool_use" and include_tools:
                name = b.get("name", "tool")
                payload = json.dumps(b.get("input", {}), indent=2, ensure_ascii=False)
                chunks.append(_fence(f"tool_use {name}", payload) if md else f"[tool_use {name}] {payload}")
            elif bt == "tool_result" and include_tools:
                payload = b.get("content")
                if isinstance(payload, (dict, list)):
                    payload = json.dumps(payload, indent=2, ensure_ascii=False)
                payload = "" if payload is None else str(payload)
                chunks.append(_fence("tool_result", payload) if md else f"[tool_result] {payload}")
        if not chunks:
            continue
        body = "\n\n".join(chunks)
        if md:
            header = "## User" if rtype == "user" else "## Assistant"
            parts.append(f"{header}\n\n{body}")
        else:
            parts.append(body)
    return ("\n\n".join(parts) + "\n") if parts else ""


def _fence(label, text):
    return f"```{label}\n{text.rstrip()}\n```"


def main(argv=None, config=None, env=None):
    env = env if env is not None else os.environ
    argv = list(sys.argv[1:] if argv is None else argv)
    ap = argparse.ArgumentParser(prog="cc-export", description="Export a Claude Code session.")
    ap.add_argument("--session", default=None, help="session id (default: latest in cwd)")
    ap.add_argument("--cwd", default=None, help="resolve as if launched from this dir")
    ap.add_argument("--format", choices=("markdown", "text"), default="markdown")
    ap.add_argument("--include-thinking", action="store_true")
    ap.add_argument("--include-tools", action="store_true")
    ap.add_argument("--open", action="store_true", help="open the raw .jsonl in VS Code")
    ap.add_argument("-o", "--output", default=None, help="write to FILE (default: stdout)")
    args = ap.parse_args(argv)

    conf = config if config is not None else config_dir(env)
    cwd = args.cwd or os.getcwd()
    path = resolve_session(conf, cwd, args.session)
    if not path:
        sys.stderr.write("cc-export: no matching session transcript found\n")
        return 1

    if args.open:
        editor = env.get("CC_EDITOR", "code")
        try:
            subprocess.run([editor, path], check=False, env=env)
        except FileNotFoundError:
            sys.stderr.write(f"cc-export: editor '{editor}' not found on PATH\n")
            return 1
        return 0

    out = render(
        read_rows(path),
        fmt=args.format,
        include_thinking=args.include_thinking,
        include_tools=args.include_tools,
    )
    if args.output:
        with open(args.output, "w", encoding="utf-8") as f:
            f.write(out)
    else:
        sys.stdout.write(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
