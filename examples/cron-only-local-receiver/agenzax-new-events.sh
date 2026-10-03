#!/usr/bin/env bash
# Hook poll script: wake the agent when new agenzax events land in
# ~/workspace/agenzax/state/events.jsonl (written by supervisor.py within
# seconds of a websocket push).
#
# Watermark (~/hooks/state/agenzax-events-watermark) is advanced ONLY by the
# main agent after it delivers the notification — so a dead worker never loses
# an event.
#
# Duplicate-wake suppression is per event batch, not global: a wake records a
# claim of "<max_event_ts> <epoch>". Later polls only wake for events NEWER
# than the claimed max ts, so a slow worker handling one batch never blocks
# notification of newer events. If a worker dies, its batch stays above the
# watermark and is re-woken after the claim TTL expires.
# Claim writes are skipped on dry runs.
#
# NOTE: this is a worked example written for one participant's hook runtime
# (sources $HATCH_HOOK_RUNTIME for the silent/log/wake helpers). Adapt the
# wake/log/silent calls to whatever your own MCP client's hook mechanism
# exposes — the file-watching + claim logic above is the reusable part.
set -euo pipefail
source "$HATCH_HOOK_RUNTIME"

EVENTS="$HOME/workspace/agenzax/state/events.jsonl"
WM="$HOME/hooks/state/agenzax-events-watermark"
CLAIM="$HOME/hooks/state/agenzax-events-wake-claim"
CLAIM_TTL=120

# Fast supervisor revival (added 2026-10-03, contributed by a participant running
# alongside this reference agent): piggyback on this 10s tick instead of waiting for
# watchdog.sh's own cron interval (which only needs to be a safety net once this
# exists — see watchdog.sh's header comment). watchdog.sh is flock-guarded, so a
# concurrent cron run cannot collide with this.
#
# Cooldown guard: if supervisor keeps crashing right after restart (config bug, bad
# dependency, etc.), without this the hook would retry every 10s forever — up to
# 6x/min, each spawning `npx agenzax-mcp@latest` (a network call) plus an MCP
# handshake. The cron-only design throttled retries naturally via its own interval;
# this restores an equivalent floor so a crash loop can't hammer the network/registry.
REVIVAL_COOLDOWN_FILE="$HOME/hooks/state/agenzax-supervisor-revival-cooldown"
REVIVAL_COOLDOWN_SECS=30

if ! pgrep -f "^python3 supervisor\.py$" >/dev/null 2>&1; then
    now_revival="$(date +%s)"
    last_revival="$(cat "$REVIVAL_COOLDOWN_FILE" 2>/dev/null || echo 0)"
    if [ "$((now_revival - last_revival))" -lt "$REVIVAL_COOLDOWN_SECS" ]; then
        log "supervisor not running; skipping restart (cooldown, last attempt ${last_revival}s ago)"
    elif [ "${HATCH_HOOK_DRY_RUN:-0}" = "1" ]; then
        log "dry-run: supervisor not running; would restart via watchdog.sh"
    else
        log "supervisor not running; restarting via watchdog.sh"
        echo "$now_revival" > "$REVIVAL_COOLDOWN_FILE"
        "$HOME/workspace/agenzax/watchdog.sh" check >/dev/null 2>&1 || true
    fi
fi

wm="0"
[ -f "$WM" ] && wm="$(cat "$WM")"

covered="$wm"
now="$(date +%s)"
if [ -f "$CLAIM" ]; then
    # shellcheck disable=SC2162
    read -r claimed_max_ts claimed_at < "$CLAIM" || true
    if [ -n "${claimed_max_ts:-}" ] && [ -n "${claimed_at:-}" ] \
        && [ "$now" -lt "$((claimed_at + CLAIM_TTL))" ]; then
        covered="$(python3 -c "print(max(float('$wm'), float('$claimed_max_ts')))")"
    fi
fi

read_result="$(python3 - "$EVENTS" "$covered" <<'EOF'
import json, sys
path, floor = sys.argv[1], float(sys.argv[2] or 0)
out = []
try:
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get("ts", 0) > floor:
                out.append(rec)
except FileNotFoundError:
    pass
print(json.dumps(out, ensure_ascii=False))
EOF
)"

count="$(python3 -c "import json,sys; print(len(json.loads(sys.argv[1])))" "$read_result")"
if [ "$count" -eq 0 ]; then
    silent "no new agenzax events"
    exit 0
fi

max_ts="$(python3 -c "import json,sys; print(max(r['ts'] for r in json.loads(sys.argv[1])))" "$read_result")"
if [ "${HATCH_HOOK_DRY_RUN:-0}" != "1" ]; then
    printf '%s %s\n' "$max_ts" "$now" > "$CLAIM"
fi
log "new agenzax events" "{\"count\": $count}"
wake "$count new agenzax event(s)" "{\"events\": $read_result}"
