#!/usr/bin/env python3
"""Minimal MCP stdio client for agenzax-mcp.

Usage:
    python3 mcp_client.py list
    python3 mcp_client.py call <tool_name> '<json_args>'

Credentials are loaded from an env file on disk (0600 perms), never from
chat or command line. Adjust ENV_FILE for your environment.
"""
import json
import os
import queue
import signal
import subprocess
import sys
import threading

ENV_FILE = os.path.expanduser("~/.config/agenzax/env")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(BASE_DIR, "state")
STDERR_LOG = os.path.join(STATE_DIR, "mcp-stderr.log")
# Vendored agenzax-mcp with the egress-proxy websocket patch
# (apply-patch.mjs). Falls back to npx when no vendored copy is present.
# NOTE: agenzax-mcp >= 0.1.14 ships the egress-proxy fix natively, so vendoring
# plus apply-patch.mjs is no longer necessary just for that — only keep the
# vendored path if you specifically want a pinned version. The npx fallback
# always resolves "latest" at every spawn (every reconnect in supervisor.py's
# retry loop does a fresh registry lookup) — fine for most setups, but it means
# an upstream release can change behavior under you with no staging step. If
# that matters for your deployment, log the resolved version at handshake time
# (see _handshake below) so a bad day correlates with a version bump instead of
# being a mystery.
VENDOR_SERVER = os.path.join(BASE_DIR, "vendor", "agenzax-mcp", "dist", "server.js")


def mcp_command():
    if os.path.isfile(VENDOR_SERVER):
        return ["node", VENDOR_SERVER]
    return ["npx", "-y", "agenzax-mcp@latest"]


def load_env(path):
    env = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


class MCPClient:
    def __init__(self, timeout=120):
        env = dict(os.environ)
        env.update(load_env(ENV_FILE))
        os.makedirs(STATE_DIR, exist_ok=True)
        self._stderr = open(STDERR_LOG, "a")
        self.proc = subprocess.Popen(
            mcp_command(),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr,
            env=env,
            text=True,
            bufsize=1,
            start_new_session=True,  # own process group so close() kills the whole tree
        )
        self._id = 0
        self._responses = queue.Queue()
        self._notifications = queue.Queue()
        self._lock = threading.Lock()
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()
        self._handshake(timeout)

    def _next_id(self):
        with self._lock:
            self._id += 1
            return self._id

    def _read_loop(self):
        for line in self.proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if "id" in msg and ("result" in msg or "error" in msg):
                self._responses.put(msg)
            elif "id" in msg and "method" in msg:
                # server-initiated request: we don't implement any, reply cleanly
                resp = {
                    "jsonrpc": "2.0",
                    "id": msg["id"],
                    "error": {"code": -32601, "message": "not implemented by minimal client"},
                }
                self._send(resp)
            else:
                self._notifications.put(msg)

    def _send(self, obj):
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def _request(self, method, params=None, timeout=120):
        rid = self._next_id()
        self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})
        deadline = True
        while deadline:
            try:
                msg = self._responses.get(timeout=timeout)
            except queue.Empty:
                raise TimeoutError(f"MCP request '{method}' timed out after {timeout}s")
            if msg.get("id") == rid:
                if "error" in msg:
                    raise RuntimeError(f"MCP error on '{method}': {msg['error']}")
                return msg.get("result")
            # not ours; shouldn't happen with single-threaded use, requeue
            self._responses.put(msg)

    def _handshake(self, timeout):
        # IMPORTANT: rename "cron-only-example-mcp" to your own agent's name before
        # running this in production. agenzax-mcp forwards this clientInfo to Agenzax
        # (as of 0.1.17) so the directory can show which agent software connects —
        # if every adopter of this example ships the placeholder name unchanged,
        # Agenzax's stats just show a wall of "cron-only-example-mcp" instead of
        # anything identifying. Opt out entirely with AGENZAX_DISABLE_CLIENT_REPORTING=1.
        result = self._request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "cron-only-example-mcp", "version": "0.1.0"},
            },
            timeout=timeout,
        )
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        # Only meaningful against the npx fallback (always "latest") — the vendored
        # path has whatever version you last ran apply-patch.mjs against.
        server_info = (result or {}).get("serverInfo") or {}
        print(
            f"[mcp_client] connected to agenzax-mcp server {server_info.get('version', 'unknown')}",
            file=sys.stderr,
        )

    def list_tools(self):
        return self._request("tools/list").get("tools", [])

    def call_tool(self, name, arguments=None, timeout=180):
        res = self._request(
            "tools/call", {"name": name, "arguments": arguments or {}}, timeout=timeout
        )
        texts = [
            b.get("text", "")
            for b in res.get("content", [])
            if b.get("type") == "text"
        ]
        return {"isError": res.get("isError", False), "text": "\n".join(texts), "raw": res}

    def drain_notifications(self):
        items = []
        while True:
            try:
                items.append(self._notifications.get_nowait())
            except queue.Empty:
                break
        return items

    def close(self):
        try:
            # kill the whole process group: npx may spawn node as a child
            # that would otherwise survive and leak as an orphan
            os.killpg(os.getpgid(self.proc.pid), signal.SIGTERM)
            self.proc.wait(timeout=10)
        except Exception:
            try:
                os.killpg(os.getpgid(self.proc.pid), signal.SIGKILL)
            except Exception:
                pass
        try:
            self._stderr.close()
        except Exception:
            pass


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    client = MCPClient()
    try:
        if cmd == "list":
            for t in client.list_tools():
                print(t["name"])
        elif cmd == "call":
            name = sys.argv[2]
            args = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
            r = client.call_tool(name, args)
            print("isError:", r["isError"])
            print(r["text"][:6000])
        else:
            print(f"unknown command: {cmd}", file=sys.stderr)
            sys.exit(2)
    finally:
        client.close()


if __name__ == "__main__":
    main()
