#!/usr/bin/env bash
# Watchdog for the agenzax supervisor. Intended to run from cron every 5h if
# agenzax-new-events.sh's tick-based fast revival is in place (this becomes a
# safety net — see the main README's Architecture section), or every 30min if
# you run this standalone without that tick.
#   watchdog.sh check  -> ensure supervisor alive; print status + new events JSON
#   watchdog.sh ack    -> advance the reported-events watermark
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$DIR/state"
PIDFILE="$STATE/supervisor.pid"
LOCK="$STATE/watchdog.lock"
WATERMARK="$STATE/reported_watermark.txt"
EVENTS="$STATE/events.jsonl"

mkdir -p "$STATE"
exec 9>"$LOCK"
flock -n 9 || { echo "WATCHDOG_BUSY"; exit 0; }

cmd="${1:-check}"

supervisor_alive() {
  if [ -f "$PIDFILE" ]; then
    local pid
    pid="$(cat "$PIDFILE")"
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then return 0; fi
  fi
  return 1
}

if [ "$cmd" = "check" ]; then
  # Record the VM boot time on every check so VM-replacement intervals can be
  # measured empirically (state/vm-boots.log). A changed boot time means the
  # VM was replaced since the previous check.
  boot="$(uptime -s 2>/dev/null || echo unknown)"
  now="$(date '+%F %T %Z')"
  prev="$(cat "$STATE/vm-boot.txt" 2>/dev/null || echo "")"
  if [ -z "$prev" ]; then
    echo "$now boot=$boot first-record" >> "$STATE/vm-boots.log"
  elif [ "$boot" != "$prev" ]; then
    echo "$now boot=$boot REPLACED (prev=$prev)" >> "$STATE/vm-boots.log"
  else
    echo "$now boot=$boot ok" >> "$STATE/vm-boots.log"
  fi
  printf '%s' "$boot" > "$STATE/vm-boot.txt"

  if supervisor_alive; then
    echo "SUPERVISOR_ALIVE"
  else
    # Anchored match on the exact daemon cmdline ("python3 supervisor.py").
    # A loose substring match would false-positive on any shell whose own
    # command line merely mentions the file (e.g. py_compile, kill $(cat ...)).
    if pgrep -f "^python3 supervisor\.py$" >/dev/null 2>&1; then
      echo "SUPERVISOR_STRAY_RUNNING"
    else
      cd "$DIR"
      # 9>&- : do NOT let the child inherit the watchdog flock fd,
      # otherwise the lock would stay held forever and every later
      # watchdog run would bail out with WATCHDOG_BUSY
      9>&- setsid nohup python3 supervisor.py >>"$STATE/supervisor.log" 2>&1 < /dev/null &
      echo "SUPERVISOR_RESTARTED pid=$!"
      sleep 3
    fi
  fi
  echo "EVENTS_JSON:"
  touch "$WATERMARK"
  wm="$(cat "$WATERMARK")"
  [ -z "$wm" ] && wm=0
  if [ -f "$EVENTS" ]; then
    python3 - "$EVENTS" "$wm" <<'EOF'
import json, sys
path, wm = sys.argv[1], float(sys.argv[2])
out = []
with open(path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except Exception:
            continue
        if rec.get("ts", 0) > wm:
            out.append(rec)
print(json.dumps(out, ensure_ascii=False))
EOF
  else
    echo "[]"
  fi
elif [ "$cmd" = "ack" ]; then
  # fractional seconds: an integer watermark would sit *below* an event
  # timestamped in the same second (event ts has sub-second precision)
  date +%s.%N > "$WATERMARK"
  echo "ACKED"
else
  echo "unknown command: $cmd" >&2
  exit 2
fi
