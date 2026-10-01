#!/usr/bin/env python3
"""Resident supervisor for agenzax-mcp.

Keeps two children alive:
  1. receiver.py — tiny HTTP server on 127.0.0.1:8099. The MCP server's
     realtime websocket pushes every event to it via AGENZAX_LOCAL_WAKE_URL
     (loopback POST). Pushes are appended to state/push_events.jsonl.
  2. agenzax-mcp — one MCP stdio child (its websocket to agenzax.ai is what
     shows the listing as online).

Event flow is push-driven: the MCP child's realtime websocket (tunneled
through the egress proxy since the 2026-10-02 vendor patch) pushes every
event to receiver.py, and the supervisor polls list_pending_events
immediately on each push (checked every TICK_SECS). A blind poll every
BACKFILL_SECS acts only as a safety net for events missed while the
websocket was down.

Liveness is guarded externally by watchdog.sh (run from cron) via
state/supervisor.pid; this process also refuses to double-run via flock.

Never auto-replies: outbound starts at tier 1 (human approval required),
so captured events are only logged for the watchdog/cron to surface.

Operational rule: list_pending_events marks fetched events consumed
server-side (they won't be returned again), so NOTHING else may call it
while the supervisor runs — check state/events.jsonl instead.
"""
import fcntl
import json
import logging
import os
import signal
import subprocess
import sys
import time

BASE = os.path.dirname(os.path.abspath(__file__))
STATE = os.path.join(BASE, "state")
PIDFILE = os.path.join(STATE, "supervisor.pid")
SEENFILE = os.path.join(STATE, "seen.json")
EVENTSFILE = os.path.join(STATE, "events.jsonl")
PUSHFILE = os.path.join(STATE, "push_events.jsonl")
LOGFILE = os.path.join(STATE, "supervisor.log")
RECEIVER_LOG = os.path.join(STATE, "receiver.log")

TICK_SECS = 5        # how often to check for pushes / child health
# Push is the primary path now (2026-10-02): the vendored agenzax-mcp tunnels
# its realtime websocket through the egress proxy, so pushes arrive within
# seconds and each one triggers an immediate poll. The blind periodic poll
# below is only a safety net for events missed while the websocket was down
# (events stay pending server-side until consumed, so nothing is lost —
# at worst delayed until the next safety-net poll).
BACKFILL_SECS = 86400  # once a day

sys.path.insert(0, BASE)
from mcp_client import MCPClient  # noqa: E402

logging.basicConfig(
    filename=LOGFILE,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

stop = False


def _on_signal(signum, frame):
    global stop
    stop = True


signal.signal(signal.SIGTERM, _on_signal)
signal.signal(signal.SIGINT, _on_signal)


def load_seen():
    try:
        with open(SEENFILE) as f:
            return set(json.load(f))
    except Exception:
        return set()


def save_seen(seen):
    tmp = SEENFILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(sorted(seen), f)
    os.replace(tmp, SEENFILE)


def event_key(ev):
    if isinstance(ev, dict) and ev.get("id"):
        return "id:%s" % ev["id"]
    return "hash:" + json.dumps(ev, sort_keys=True, ensure_ascii=False)


def do_poll(client, seen):
    """One list_pending_events round; returns updated seen set."""
    res = client.call_tool("list_pending_events", {})
    if res["isError"]:
        raise RuntimeError(res["text"][:500])
    payload = json.loads(res["text"]) if res["text"].strip() else {}
    events = payload.get("events", []) if isinstance(payload, dict) else []
    new = [e for e in events if event_key(e) not in seen]
    if new:
        with open(EVENTSFILE, "a") as f:
            for e in new:
                f.write(
                    json.dumps({"ts": time.time(), "event": e},
                               ensure_ascii=False) + "\n"
                )
                seen.add(event_key(e))
        save_seen(seen)
        logging.info("captured %d new event(s)", len(new))
    return seen


def spawn_receiver():
    logf = open(RECEIVER_LOG, "a")
    return subprocess.Popen(
        [sys.executable, os.path.join(BASE, "receiver.py")],
        stdout=logf,
        stderr=subprocess.STDOUT,
        stdin=subprocess.DEVNULL,
        start_new_session=True,
    )


def push_file_size():
    try:
        return os.path.getsize(PUSHFILE)
    except OSError:
        return 0


def main():
    os.makedirs(STATE, exist_ok=True)
    lockf = open(os.path.join(STATE, "supervisor.lock"), "w")
    try:
        fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another supervisor is running", file=sys.stderr)
        sys.exit(1)
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))

    seen = load_seen()
    receiver = spawn_receiver()
    logging.info("supervisor started (pid %d), receiver pid %d",
                 os.getpid(), receiver.pid)
    last_push_size = push_file_size()
    last_backfill = 0  # immediate poll on first tick
    backoff = 5
    client = None
    try:
        while not stop:
            try:
                if receiver.poll() is not None:
                    logging.warning("receiver died, restarting")
                    receiver = spawn_receiver()
                if client is None:
                    logging.info("spawning agenzax-mcp child")
                    client = MCPClient()
                    backoff = 5
                size = push_file_size()
                pushed = size > last_push_size
                last_push_size = size
                now = time.time()
                if pushed:
                    logging.info("push received, backfilling events")
                    seen = do_poll(client, seen)
                    last_backfill = now
                elif now - last_backfill >= BACKFILL_SECS:
                    logging.info("periodic backfill poll")
                    seen = do_poll(client, seen)
                    last_backfill = now
            except Exception as ex:
                logging.warning("poll failed: %s", ex)
                try:
                    if client:
                        client.close()
                except Exception:
                    pass
                client = None
                time.sleep(min(backoff, 300))
                backoff *= 2
                continue
            for _ in range(TICK_SECS):
                if stop:
                    break
                time.sleep(1)
    finally:
        for proc, name in ((client, "mcp"), (receiver, "receiver")):
            if proc is None:
                continue
            try:
                if name == "mcp":
                    proc.close()
                else:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                    proc.wait(timeout=10)
            except Exception:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except Exception:
                    pass
        try:
            os.remove(PIDFILE)
        except OSError:
            pass
        logging.info("supervisor stopped")


if __name__ == "__main__":
    main()
