// proxy.js - Option 3 (advanced): a tiny localhost proxy that injects
// thinking.display into every Claude Code request, fixing ALL surfaces at once
// (VS Code extension + headless CLI + SDK) without editing any of Claude's files.
//
// !!! ADVANCED / UNTESTED !!!
// This is provided as a working starting point, not a turnkey, battle-tested
// fix. It sits in the path of your live auth token, so read the security notes
// below and in TECHNICAL.md before relying on it. Most people should use
// Option 1 (the launcher) instead.
//
// How it works: every Claude Code surface resolves the API host as
//   ... ?? process.env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com"
// Point ANTHROPIC_BASE_URL at this proxy and it forwards every request to
// Anthropic unchanged EXCEPT that, for POST /v1/messages with an adaptive/enabled
// thinking config and no display set, it adds display:"summarized" (or "omitted").
//
// Run:
//   node proxy.js                 # listens on http://127.0.0.1:8788
//   CC_THINKING_DISPLAY=omitted node proxy.js   # inject "omitted" instead
//   CC_PROXY_PORT=9000 node proxy.js            # different port
// Then, in the SAME environment Claude Code launches from:
//   export ANTHROPIC_BASE_URL=http://127.0.0.1:8788
//   claude ...            # or set it for the VS Code extension host and reload
// Unset ANTHROPIC_BASE_URL to go straight back to Anthropic.

const http = require("http");
const https = require("https");

const UPSTREAM = "api.anthropic.com";
const PORT = parseInt(process.env.CC_PROXY_PORT || "8788", 10);
const DISPLAY = process.env.CC_THINKING_DISPLAY || "summarized"; // or "omitted"

http
  .createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);

      if (req.method === "POST" && req.url.startsWith("/v1/messages")) {
        try {
          const j = JSON.parse(body.toString("utf8"));
          const t = j.thinking;
          if (
            t &&
            (t.type === "adaptive" || t.type === "enabled") &&
            t.display == null
          ) {
            t.display = DISPLAY;
            body = Buffer.from(JSON.stringify(j));
          }
        } catch {
          /* not JSON we understand - pass the body through untouched */
        }
      }

      const headers = {
        ...req.headers,
        host: UPSTREAM,
        "content-length": Buffer.byteLength(body),
      };
      const up = https.request(
        { host: UPSTREAM, path: req.url, method: req.method, headers },
        (r) => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res); // stream the SSE response straight back, unbuffered
        }
      );
      up.on("error", (e) => {
        res.writeHead(502);
        res.end(String(e));
      });
      up.end(body);
    });
  })
  // Bind to 127.0.0.1 ONLY - never 0.0.0.0. This process sees your live token.
  .listen(PORT, "127.0.0.1", () =>
    console.error(
      `thinking-display proxy on http://127.0.0.1:${PORT} (injecting display="${DISPLAY}")`
    )
  );
