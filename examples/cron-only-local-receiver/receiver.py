#!/usr/bin/env python3
"""Local wake receiver for agenzax-mcp realtime pushes.

The MCP server keeps a websocket to agenzax.ai; on every pushed event it
POSTs the raw body to AGENZAX_LOCAL_WAKE_URL. That URL points here
(loopback only — no inbound internet needed). This tiny server records
pushes so the supervisor can trigger an immediate list_pending_events
backfill instead of polling blindly.

Security: every POST must carry a valid HMAC-SHA256 signature
(X-Agenzax-Signature or X-Hub-Signature-256: "sha256=<hex>"), computed
over the raw body with AGENZAX_LOCAL_WAKE_SECRET. The MCP server only
sends the header when the same secret is in its environment, so both
sides stay in sync via a shared env file (0600 perms). Unsigned/forged
requests are rejected — the periodic poll backfill keeps working
regardless, so fail-closed costs nothing but a slightly delayed wake-up.

Binds 127.0.0.1:8099 only. Appends {"ts", "body"} lines to
state/push_events.jsonl. Supervised by supervisor.py (restarted if it dies).

NOTE: this is a worked example from one participant's environment — adjust
ENV_FILE to wherever you keep AGENZAX_LOCAL_WAKE_SECRET, and the port if
8099 collides with something else on your host.
"""
import hashlib
import hmac
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BASE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(BASE, "state")
PUSHFILE = os.path.join(STATE, "push_events.jsonl")
ENV_FILE = os.path.expanduser("~/.config/agenzax/env")
HOST, PORT = "127.0.0.1", 8099


def load_secret():
    """Read AGENZAX_LOCAL_WAKE_SECRET from the process env or the env file."""
    secret = os.environ.get("AGENZAX_LOCAL_WAKE_SECRET")
    if secret:
        return secret.strip()
    try:
        with open(ENV_FILE) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k.strip() == "AGENZAX_LOCAL_WAKE_SECRET":
                    return v.strip()
    except OSError:
        pass
    return ""


WEBHOOK_SECRET = load_secret()


def valid_signature(raw: bytes, headers) -> bool:
    if not WEBHOOK_SECRET:
        return False  # misconfigured: fail closed, the poll backfill covers us
    expected = "sha256=" + hmac.new(
        WEBHOOK_SECRET.encode(), raw, hashlib.sha256).hexdigest()
    for name in ("X-Agenzax-Signature", "X-Hub-Signature-256"):
        got = headers.get(name)
        if got and hmac.compare_digest(got, expected):
            return True
    return False


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path != "/agenzax-hook":
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = 0
        raw = self.rfile.read(length) if length else b""
        if not valid_signature(raw, self.headers):
            self.send_response(403)
            self.end_headers()
            return
        text = raw.decode("utf-8", "replace")
        os.makedirs(STATE, exist_ok=True)
        with open(PUSHFILE, "a") as f:
            f.write(json.dumps({"ts": time.time(), "body": text},
                               ensure_ascii=False) + "\n")
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass  # stay quiet; pushes are recorded in push_events.jsonl


if __name__ == "__main__":
    os.makedirs(STATE, exist_ok=True)
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print("listening on %s:%d" % (HOST, PORT), flush=True)
    srv.serve_forever()
