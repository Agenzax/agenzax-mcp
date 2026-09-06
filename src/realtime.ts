// 실시간 이벤트 수신 — 웹훅(HTTP, 공인 서버 필요)의 대안으로 Agenzax의 웹소켓 푸시 서버에
// 아웃바운드로 연결해둔다. 인바운드 포트를 하나도 열 필요가 없어(Slack Socket Mode/Stripe CLI
// listen과 동일한 패턴) 방화벽/NAT 뒤의 대다수 참여사에게 기본으로 권장하는 경로다.
//
// 이 프로세스 자체는 stdio 전용 MCP 서버라 자기 HTTP 포트가 없다 — 대신 이벤트가 오면, 이미
// 로컬에서 돌고 있는 MCP 클라이언트(Hermes/OpenClaw 등)의 자체 로컬 웹훅 수신기로 그대로
// 릴레이 POST한다. Agenzax가 원래 그 로컬 웹훅 URL로 직접 HTTP를 쏘려던 것(실제 원격 배포에서는
// 도달 불가능)을, 이 프로세스가 대신 웹소켓으로 받아 localhost로만 전달해주는 셈이다.
import WebSocket from "ws";
import { createHmac } from "crypto";

export interface RealtimeOptions {
  baseUrl: string;
  listingId: string;
  getBearer: () => Promise<string>;
  /** 이 값이 있으면 받은 이벤트를 이 URL로 그대로 릴레이 POST한다(예: Hermes의 로컬 웹훅 수신기). 없으면 수신만 하고 로그만 남긴다. */
  localWakeUrl?: string;
  /** localWakeUrl 쪽 수신기가 서명 검증을 요구하면(Hermes register_webhook이 발급한 값 등) 여기 넣는다. */
  localWakeSecret?: string;
}

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

function deriveWsUrl(baseUrl: string): string | null {
  try {
    const u = new URL(baseUrl);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      return `ws://${u.hostname}:${process.env.WS_PORT ?? 8091}`;
    }
    return null; // 로컬이 아니면 함부로 포트를 추측하지 않는다 — AGENZAX_WS_URL을 명시해야 함
  } catch {
    return null;
  }
}

async function relayToLocalWake(rawBody: string, opts: RealtimeOptions): Promise<void> {
  if (!opts.localWakeUrl) return;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.localWakeSecret) {
    const signature = "sha256=" + createHmac("sha256", opts.localWakeSecret).update(rawBody).digest("hex");
    headers["X-Agenzax-Signature"] = signature;
    headers["X-Hub-Signature-256"] = signature;
  }
  try {
    const res = await fetch(opts.localWakeUrl, { method: "POST", headers, body: rawBody });
    if (!res.ok) console.error(`[realtime] Local wake relay returned HTTP ${res.status}`);
  } catch (err) {
    // 로컬 릴레이 실패는 치명적이지 않다 — 이벤트는 서버에도 남아있어 list_pending_events로 여전히 복구 가능하다.
    console.error("[realtime] Local wake relay failed (non-fatal, event still recoverable via list_pending_events):", err instanceof Error ? err.message : err);
  }
}

/** 자동 재연결(지수 백오프)이 포함된 상시 연결. 실패해도 프로세스를 죽이지 않는다 — 웹훅/폴링이라는 다른 경로가 항상 남아있다. */
export function startRealtimeClient(opts: RealtimeOptions): void {
  const wsUrl = process.env.AGENZAX_WS_URL ?? deriveWsUrl(opts.baseUrl);
  if (!wsUrl) {
    console.error("[realtime] AGENZAX_WS_URL not set and AGENZAX_BASE_URL isn't localhost — skipping realtime connection (falling back to webhook/polling only).");
    return;
  }

  let backoffMs = RECONNECT_BASE_MS;

  async function connect() {
    let bearer: string;
    try {
      bearer = await opts.getBearer();
    } catch (err) {
      console.error("[realtime] Failed to obtain a token, retrying:", err instanceof Error ? err.message : err);
      scheduleReconnect();
      return;
    }

    const ws = new WebSocket(`${wsUrl}?listing_id=${opts.listingId}`, { headers: { Authorization: `Bearer ${bearer}` } });

    ws.on("open", () => {
      console.error("[realtime] Connected — receiving events by push instead of polling.");
      backoffMs = RECONNECT_BASE_MS; // 정상 연결됐으니 다음 끊김 때는 다시 짧은 백오프부터
    });

    ws.on("message", (data) => {
      const rawBody = data.toString();
      console.error("[realtime] Event received:", rawBody);
      void relayToLocalWake(rawBody, opts);
    });

    ws.on("close", (code) => {
      console.error(`[realtime] Disconnected (code ${code}) — reconnecting in ${backoffMs}ms.`);
      scheduleReconnect();
    });

    ws.on("error", (err) => {
      console.error("[realtime] Connection error:", err.message);
    });
  }

  function scheduleReconnect() {
    setTimeout(connect, backoffMs);
    backoffMs = Math.min(backoffMs * 2, RECONNECT_MAX_MS);
  }

  connect();
}
