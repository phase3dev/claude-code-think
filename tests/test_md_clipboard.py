#!/usr/bin/env python3
"""copyText honesty tests: the control may only report success when a copy
ACTUALLY happened. Regression for the original bug, where navigator.clipboard was
absent in the webview, the code fell through to Promise.resolve(), and the UI said
"Copied" while nothing was written.

copyText tries a synchronous execCommand("copy") first (gesture-safe and
secure-context-independent, so it works over remote / code-server), then falls
back to the async Clipboard API. It resolves to a boolean: true ONLY on a real
copy. Empty text is never a copy. Run under node with mocked document/navigator
globals (no jsdom)."""
import json
import pathlib
import subprocess
import unittest

REPO = pathlib.Path(__file__).resolve().parents[1]
INJECT_JS = REPO / "fixes" / "markdown-copy-export" / "webview-inject.js"

# Mocks are installed AFTER require() so the module takes its node-export branch
# (document is undefined at load -> it does not boot()); copyText reads the globals
# at call time. exec_ok / write controls each path; `captured` records the text
# each mechanism received so we can assert the real payload, not just the verdict.
HARNESS = """
const M = require(%(mod)s);
const cfg = %(cfg)s;
const captured = { exec: null, api: null };
// defineProperty (not assignment): require() already ran with document undefined so
// the module took its export branch; and node's built-in `navigator` global is a
// getter (no setter), so a plain `global.navigator =` would silently no-op.
const DOC = {
  activeElement: null,
  getSelection: () => null,
  createElement: (t) => ({
    tagName: t, value: "", style: {}, parentNode: null,
    setAttribute() {}, focus() {},
    select() { captured.exec = this.value; },
  }),
  documentElement: {},
  execCommand: () => cfg.exec_ok,
};
DOC.body = { appendChild(n) { n.parentNode = DOC.body; }, removeChild(n) { n.parentNode = null; } };
const NAV = cfg.clipboard === "absent" ? {} : { clipboard: { writeText: (s) => {
  captured.api = s;
  return cfg.clipboard === "resolve" ? Promise.resolve() : Promise.reject(new Error("blocked"));
} } };
Object.defineProperty(globalThis, "document", { value: DOC, configurable: true, writable: true });
Object.defineProperty(globalThis, "navigator", { value: NAV, configurable: true, writable: true });
Promise.resolve(M.copyText(cfg.text)).then((ok) => {
  process.stdout.write(JSON.stringify({ ok, captured }));
});
"""


def run(text, exec_ok, clipboard):
    cfg = {"text": text, "exec_ok": exec_ok, "clipboard": clipboard}
    script = HARNESS % {"mod": json.dumps(str(INJECT_JS)), "cfg": json.dumps(cfg)}
    res = subprocess.run(["node", "-e", script], cwd=REPO, text=True,
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    assert res.returncode == 0, res.stderr
    return json.loads(res.stdout)


class CopyTextHonestyTests(unittest.TestCase):
    def test_empty_text_is_never_a_copy(self):
        out = run("", exec_ok=True, clipboard="resolve")
        self.assertFalse(out["ok"])
        self.assertIsNone(out["captured"]["exec"])  # never even attempted
        self.assertIsNone(out["captured"]["api"])

    def test_execcommand_path_succeeds_and_carries_the_text(self):
        out = run("hello world", exec_ok=True, clipboard="resolve")
        self.assertTrue(out["ok"])
        self.assertEqual(out["captured"]["exec"], "hello world")
        self.assertIsNone(out["captured"]["api"])  # API never needed

    def test_falls_back_to_clipboard_api_when_execcommand_fails(self):
        out = run("payload", exec_ok=False, clipboard="resolve")
        self.assertTrue(out["ok"])
        self.assertEqual(out["captured"]["api"], "payload")

    def test_no_false_success_when_clipboard_absent_and_exec_fails(self):
        # The exact original-bug environment: no Clipboard API, execCommand unusable.
        out = run("payload", exec_ok=False, clipboard="absent")
        self.assertFalse(out["ok"])

    def test_no_false_success_when_clipboard_api_rejects(self):
        out = run("payload", exec_ok=False, clipboard="reject")
        self.assertFalse(out["ok"])


if __name__ == "__main__":
    unittest.main()
