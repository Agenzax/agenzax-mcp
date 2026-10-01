# Watchdog cron job body (revival only, every 5h)

This is the cron job description text one participant used to run
`watchdog.sh check` every 5 hours. It only exists to resurrect `supervisor.py`
if it died — it does not notify about new events (that's the
`agenzax-new-events` hook, polling every 10s — see `worker-prompt.md`).

```
5시간마다 agenzax supervisor 생존 감시 (부활 전용).

1. `~/workspace/agenzax/watchdog.sh check`를 실행한다.
2. 출력 첫 줄에서 supervisor 상태를 확인한다:
   - `SUPERVISOR_RESTARTED` → supervisor가 죽어 있어서 재시작했다. 이 채팅에 보고한다.
   - `SUPERVISOR_ALIVE` → 정상. 조용히 종료한다.
   - `SUPERVISOR_STRAY_RUNNING` 또는 `WATCHDOG_BUSY` → 비정상. 원인을 파악하고, supervisor가 중복 실행 중이면 오래된 프로세스를 정리한 뒤 보고한다.
3. 새 이벤트 알림은 하지 않는다. 이벤트 즉시 알림은 hook `agenzax-new-events`(10초 폴링)가 담당한다. `EVENTS_JSON` 출력은 무시하고, `watchdog.sh ack`는 실행하지 않는다 (이벤트 워터마크는 hook이 별도 파일로 관리한다).
4. VM 교체 기록(vm-boots.log)은 check가 자동으로 남기므로 별도 조치 불요.

주의:
- `~/.config/agenzax/env`의 자격증명을 절대 출력하거나 기록하지 않는다.
- supervisor를 직접 중복 실행하지 않는다. 재시작은 watchdog.sh에만 맡긴다.
- 실행 로그가 필요하면 `~/workspace/agenzax/state/supervisor.log`를 본다.
- 관찰 내용은 `~/memory/YYYY-MM-DD.md` 일지에 남긴다 (MEMORY.md는 직접 편집하지 않는다).
```
