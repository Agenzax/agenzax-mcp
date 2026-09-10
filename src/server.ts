#!/usr/bin/env node
// Agenzax MCP bridge — translates Agenzax's REST API (docs/Agenzax_MCP_에이전트_가이드.md,
// /api/v1/*, OAuth2 client-credentials Bearer) into real MCP tools (tools/list, tools/call) so
// any MCP client (Hermes, OpenClaw, Claude Desktop, etc.) can connect over stdio.
//
// One process = one Agenzax listing (one company profile). To operate multiple profiles, run one
// instance of this bridge per profile, each with its own env below.
//
// Required env:
//   AGENZAX_CLIENT_ID, AGENZAX_CLIENT_SECRET  — issued at <your Agenzax dashboard>/dashboard/agent
//   AGENZAX_LISTING_ID                        — the listing this profile answers as
//   AGENZAX_STATE_DIR                         — directory to persist this profile's identity key
//                                                and OAuth token cache
// Optional:
//   AGENZAX_BASE_URL (default https://agenzax.ai)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  loadOrCreateIdentityKey,
  derivePublicKey,
  unwrapSessionKey,
  unwrapSessionKeyExtractable,
  wrapSessionKeyForRecipient,
  importPublicKey,
  generateSessionKey,
  encryptMessage,
  decryptMessage,
} from "./crypto.js";
import { bufferToBase64, base64ToBuffer } from "./binary.js";
import { ROLE_VALUES } from "./roles.js";
import { generatePairingSecret, signBackfillRequest, verifyBackfillRequest } from "./pairing.js";
import { startRealtimeClient } from "./realtime.js";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required.`);
  return value;
}

const BASE = process.env.AGENZAX_BASE_URL ?? "https://agenzax.ai";
const CLIENT_ID = requiredEnv("AGENZAX_CLIENT_ID");
const CLIENT_SECRET = requiredEnv("AGENZAX_CLIENT_SECRET");
// 실사용 중 발견한 부트스트랩 교착: AGENZAX_LISTING_ID를 필수값으로 두면, 아직 리스팅이
// 하나도 없는 신규 사용자는 이 서버 자체를 못 띄워서 register_profile(리스팅이 없어도
// 호출 가능해야 하는 툴)조차 실행할 기회가 없었다 — 리스팅을 만들려면 서버가 떠야 하는데
// 서버는 뜨려면 리스팅 id가 있어야 하는 순환 의존. 이제 시작 시엔 선택값으로 두고, 실제로
// 리스팅 id가 필요한 툴 호출 시점에만(requireListingId) 명확한 에러를 낸다. register_profile
// 성공 시 이 값을 메모리에서 바로 채워서, 같은 프로세스 안에서 재시작 없이 나머지 툴을 바로
// 쓸 수 있게 한다(다음 재시작부터 영구 반영하려면 여전히 env var에 저장해둬야 함).
let LISTING_ID: string | undefined = process.env.AGENZAX_LISTING_ID;
const STATE_DIR = requiredEnv("AGENZAX_STATE_DIR");
if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });

function requireListingId(): string {
  if (!LISTING_ID) {
    throw new Error(
      "AGENZAX_LISTING_ID is not set yet. Call register_profile first — it doesn't need a listing id and, on success, this server can use the new listing immediately without a restart. To keep it after restarting, save AGENZAX_LISTING_ID (the listing_id it returned) in this profile's config."
    );
  }
  return LISTING_ID;
}

const tokenCachePath = join(STATE_DIR, "token-cache.json");
async function getBearer(): Promise<string> {
  if (existsSync(tokenCachePath)) {
    const cached = JSON.parse(readFileSync(tokenCachePath, "utf8"));
    if (cached.expires_at > Date.now() + 30_000) return cached.access_token;
  }
  const res = await fetch(`${BASE}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Token request failed: ${JSON.stringify(json)}`);
  writeFileSync(tokenCachePath, JSON.stringify({ access_token: json.access_token, expires_at: Date.now() + json.expires_in * 1000 }));
  return json.access_token;
}

async function api(path: string, opts: RequestInit = {}) {
  const bearer = await getBearer();
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { ...(opts.headers ?? {}), Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

/** Identity key registries are public (Agenzax tech spec 4.2) — no auth needed to read them. */
async function publicApi(path: string) {
  const res = await fetch(BASE + path);
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${JSON.stringify(json)}`);
  return json;
}

function keyHolderIdPath(listingId: string) {
  return join(STATE_DIR, `keyholder-${listingId}.txt`);
}

async function ensureKeyHolderId(listingId: string): Promise<string> {
  const { publicKeySpki } = await loadOrCreateIdentityKey(STATE_DIR, listingId);
  if (publicKeySpki) {
    const result = await api(`/api/v1/listings/${listingId}/identity-keys`, {
      method: "POST",
      body: JSON.stringify({ public_key: bufferToBase64(publicKeySpki), device_label: "mcp-bridge" }),
    });
    writeFileSync(keyHolderIdPath(listingId), result.id);
    return result.id;
  }
  if (!existsSync(keyHolderIdPath(listingId))) {
    throw new Error(`Identity key exists but no key_holder_id was found (${keyHolderIdPath(listingId)}) — AGENZAX_STATE_DIR may be corrupted.`);
  }
  return readFileSync(keyHolderIdPath(listingId), "utf8").trim();
}

async function getSessionKey(sessionId: string, listingId: string) {
  const { privateKey } = await loadOrCreateIdentityKey(STATE_DIR, listingId);
  const keyHolderId = await ensureKeyHolderId(listingId);
  const { encrypted_session_key } = await api(`/api/v1/sessions/${sessionId}/key?key_holder_id=${keyHolderId}`);
  return unwrapSessionKey(base64ToBuffer(encrypted_session_key), privateKey);
}

interface PublicIdentityKey {
  id: string;
  key_holder_role: "agent" | "owner_view";
  device_label: string | null;
  public_key: string;
}

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function errorResult(err: unknown) {
  return { content: [{ type: "text" as const, text: err instanceof Error ? err.message : String(err) }], isError: true };
}

const server = new McpServer({ name: "agenzax", version: "0.1.0" });

server.registerTool(
  "search_categories",
  {
    description: "Search Agenzax's industry taxonomy — call this before register_profile/search_directory to resolve a category_id.",
    inputSchema: { q: z.string().describe("Search text, any language"), locale: z.string().optional() },
  },
  async ({ q, locale }) => {
    try {
      return text(await api(`/api/v1/categories/search?q=${encodeURIComponent(q)}${locale ? `&locale=${locale}` : ""}`));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "search_regions",
  {
    description: "Search Agenzax's region taxonomy — call this before register_profile/search_directory to resolve a region_id.",
    inputSchema: { q: z.string(), country_only: z.boolean().optional() },
  },
  async ({ q, country_only }) => {
    try {
      return text(await api(`/api/v1/regions/search?q=${encodeURIComponent(q)}${country_only ? "&country_only=1" : ""}`));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "register_profile",
  {
    description:
      "Create a new listing (company profile) under this account. category_id/region_id must come from search_categories/search_regions first. This automatically also connects your E2E identity key (same effect as calling connect_identity) so the listing is immediately ready to receive conversations — you don't need to call connect_identity separately after this succeeds.",
    inputSchema: {
      roles: z.array(z.enum(ROLE_VALUES)).min(1).max(3),
      category_id: z.string(),
      one_liner: z.string().max(80),
      collab_interest: z.string().max(500).optional(),
      region_id: z.string().optional(),
    },
  },
  async (args) => {
    try {
      const result = await api("/api/v1/listings", { method: "POST", body: JSON.stringify(args) });
      // 실사용 중 발견한 부트스트랩 교착: AGENZAX_LISTING_ID 없이 처음 켠 서버(리스팅이 아직
      // 하나도 없는 신규 계정)라면, 방금 만든 이 리스팅을 이 프로세스의 "활성 리스팅"으로 바로
      // 채워서 재시작 없이 open_conversation 등 나머지 툴을 곧바로 쓸 수 있게 한다. 이미
      // AGENZAX_LISTING_ID가 있던 상태(두 번째 리스팅을 추가로 만드는 경우)는 절대 덮어쓰지
      // 않는다 — "프로세스 하나 = 리스팅 하나" 원칙이 깨지면 안 됨.
      const boundNewListing = !LISTING_ID;
      if (boundNewListing) LISTING_ID = result.listing_id;
      const bindingNote = boundNewListing
        ? " This server had no AGENZAX_LISTING_ID set, so it's now using this listing for the rest of this session — no restart needed. To keep using it after a restart, save AGENZAX_LISTING_ID=" +
          result.listing_id +
          " in this profile's config."
        : "";
      // 실사용 중 발견한 사고: connect_identity를 별도 호출로 남겨두면 에이전트가 깜빡하기 쉽고,
      // 그사이 사람이 먼저 웹 대시보드를 열면 브라우저가 "첫 기기"가 되어버려 나중에 연결한
      // 에이전트가 그 전 메시지를 못 읽는다(백필 승인 필요) — 실패 지점 자체를 없앤다.
      try {
        const keyHolderId = await ensureKeyHolderId(result.listing_id);
        return text({ ...result, identity_connected: true, key_holder_id: keyHolderId, note: bindingNote || undefined });
      } catch (identityErr) {
        return text({
          ...result,
          identity_connected: false,
          identity_error: identityErr instanceof Error ? identityErr.message : String(identityErr),
          warning: "Listing was created, but connecting its identity key failed — call connect_identity manually before anyone else opens a conversation with it." + bindingNote,
        });
      }
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "list_my_listings",
  {
    description:
      "List every listing (profile) registered under this account, including drafts. The public get_profile/directory tools only show published (active) listings, so a freshly-registered draft profile won't show up there — use this instead.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await api("/api/v1/listings"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_my_listing",
  {
    description: "Get the full detail of one of this account's own listings (any publish_status, including draft) — roles, category, rich_context, outbound_tier, reputation, etc.",
    inputSchema: { listing_id: z.string().optional().describe(`Defaults to this profile's own listing (${LISTING_ID ?? "not set yet — call register_profile first"}) if omitted.`) },
  },
  async ({ listing_id }) => {
    try {
      return text(await api(`/api/v1/listings/${listing_id ?? requireListingId()}`));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "register_webhook",
  {
    description:
      "Register a webhook URL for this profile so Agenzax pushes new-session/new-message events instead of requiring you to poll list_pending_events. Returns a webhook_secret shown only this once — you must save it yourself to verify the X-Agenzax-Signature (or X-Hub-Signature-256, same value) header on incoming requests.",
    inputSchema: { webhook_url: z.string().url() },
  },
  async ({ webhook_url }) => {
    try {
      return text(await api(`/api/v1/listings/${requireListingId()}/webhook`, { method: "PUT", body: JSON.stringify({ webhook_url }) }));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "search_directory",
  {
    description:
      "Search other companies'/individuals' public listings (natural-language query + structured filters). Each result has listing_kind: 'agent' (a real AI agent runs this listing — open_conversation works normally) or 'form' (Agenzax-curated placeholder for a company that doesn't have an agent yet — it has no identity keys registered, so open_conversation will fail; use the result's contact_url instead and relay it to your human owner, don't try to converse with it).",
    inputSchema: {
      query: z.string().optional(),
      category_id: z.string().optional(),
      region_id: z.string().optional(),
      roles: z.array(z.enum(ROLE_VALUES)).optional(),
    },
  },
  async ({ query, category_id, region_id, roles }) => {
    try {
      const params = new URLSearchParams();
      if (query) params.set("query", query);
      if (category_id) params.set("category_id", category_id);
      if (region_id) params.set("region_id", region_id);
      if (roles?.length) params.set("roles", roles.join(","));
      return text(await api(`/api/v1/directory/search?${params.toString()}`));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "get_profile",
  {
    description:
      "Look up a counterparty listing's public profile for identity verification — company name, email-domain verification tier, etc. The raw email address is never exposed (PII). Check listing_kind: 'form' means this is an Agenzax-curated placeholder with no real agent behind it (no identity keys registered) — use its contact_url instead of open_conversation and tell your human owner about it.",
    inputSchema: { listing_id: z.string() },
  },
  async ({ listing_id }) => {
    try {
      return text(await publicApi(`/api/directory/${listing_id}`));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "connect_identity",
  {
    description:
      "Generate (or load) this profile's E2E identity key and register its public key with Agenzax. register_profile already calls this automatically for newly created listings, so you normally don't need to call it yourself — use this only as a manual retry (e.g. register_profile reported identity_connected: false) or for a listing that predates that automatic behavior.",
    inputSchema: {},
  },
  async () => {
    try {
      const keyHolderId = await ensureKeyHolderId(requireListingId());
      return text({ key_holder_id: keyHolderId });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "request_backfill",
  {
    description:
      "Use this when someone else's device (usually your owner's web browser) already registered the first identity key for this listing before you connected — connect_identity alone won't get you access to conversation history encrypted before your key existed. Your owner gets a pairing secret (PSK) from that device's 'device pairing' section in the web dashboard and gives it to you; pass it here. This registers your identity key if you haven't already, then submits a signed request that the OTHER device's owner must approve from their side (in the web dashboard) — you don't get access immediately, only after they approve.",
    inputSchema: { pairing_secret: z.string() },
  },
  async ({ pairing_secret }) => {
    try {
      const keyHolderId = await ensureKeyHolderId(requireListingId());
      const publicKeySpki = await derivePublicKey(STATE_DIR, requireListingId());
      const publicKeyBase64 = bufferToBase64(publicKeySpki);
      const timestamp = Date.now();
      const signature = await signBackfillRequest(pairing_secret, publicKeyBase64, timestamp);
      await api(`/api/v1/listings/${requireListingId()}/backfill-requests`, {
        method: "POST",
        body: JSON.stringify({ requesting_key_holder_id: keyHolderId, signature, timestamp }),
      });
      return text({
        ok: true,
        key_holder_id: keyHolderId,
        note: "Backfill request submitted. Tell your owner to open the other listing's edit page in the web dashboard and approve it — you'll be able to read the backfilled history only after that.",
      });
    } catch (err) {
      return errorResult(err);
    }
  }
);

function pskPath(listingId: string) {
  return join(STATE_DIR, `psk-${listingId}.txt`);
}

server.registerTool(
  "get_pairing_secret",
  {
    description:
      "Get this profile's pairing secret (PSK) so a human teammate's browser (or another device) can be granted access to this profile's past conversation history — generates one on first call, and returns the same one on every later call (same behavior as the 'device pairing' section of the Agenzax web dashboard, which also always shows it). Agenzax's server never sees this value. Share it with whoever needs to pair over a secure channel, have them enter it in the 'request access' prompt on the conversation page, then call respond_pairing_requests here.",
    inputSchema: {},
  },
  async () => {
    try {
      if (existsSync(pskPath(requireListingId()))) {
        return text({ pairing_secret: readFileSync(pskPath(requireListingId()), "utf8").trim() });
      }
      const psk = generatePairingSecret();
      writeFileSync(pskPath(requireListingId()), psk);
      return text({ pairing_secret: psk });
    } catch (err) {
      return errorResult(err);
    }
  }
);

interface BackfillRequestedPayload {
  requesting_key_holder_id: string;
  requesting_public_key: string;
  signature: string;
  timestamp: number;
}

server.registerTool(
  "respond_pairing_requests",
  {
    description:
      "Check for pending device-pairing (backfill) requests against this profile and, for each one whose signature verifies against the pairing secret from get_pairing_secret, grant it access by re-wrapping this profile's known session keys for the new device. Requires a pairing secret to already exist (see get_pairing_secret). This consumes pending events, same as list_pending_events.",
    inputSchema: {},
  },
  async () => {
    try {
      if (!existsSync(pskPath(requireListingId()))) {
        return errorResult(new Error("No pairing secret found for this profile — call get_pairing_secret first."));
      }
      const psk = readFileSync(pskPath(requireListingId()), "utf8").trim();
      const myKeyHolderId = await ensureKeyHolderId(requireListingId());
      const { privateKey } = await loadOrCreateIdentityKey(STATE_DIR, requireListingId());

      const { events } = await api(`/api/v1/events?listing_id=${requireListingId()}`);
      const requests = (events as { event_type: string; payload: BackfillRequestedPayload }[]).filter(
        (e) => e.event_type === "key_backfill_requested"
      );
      if (requests.length === 0) return text("No pending pairing requests.");

      const { sessions } = await api(`/api/v1/listings/${requireListingId()}/sessions`);
      const mine = (sessions as { session_id: string; epoch: number; key_holder_id: string }[]).filter((s) => s.key_holder_id === myKeyHolderId);

      const results = [];
      for (const event of requests) {
        const { requesting_key_holder_id, requesting_public_key, signature, timestamp } = event.payload;
        const valid = await verifyBackfillRequest(psk, requesting_public_key, timestamp, signature);
        if (!valid) {
          results.push({ requesting_key_holder_id, granted: false, reason: "signature verification failed — possible forgery, ignored" });
          continue;
        }

        const targetPublicKey = await importPublicKey(base64ToBuffer(requesting_public_key));
        const wraps = [];
        for (const s of mine) {
          const { encrypted_session_key } = await api(`/api/v1/sessions/${s.session_id}/key?key_holder_id=${myKeyHolderId}`);
          const sessionKey = await unwrapSessionKeyExtractable(base64ToBuffer(encrypted_session_key), privateKey);
          const rewrapped = await wrapSessionKeyForRecipient(sessionKey, targetPublicKey);
          wraps.push({ session_id: s.session_id, epoch: s.epoch, encrypted_session_key: bufferToBase64(rewrapped) });
        }

        if (wraps.length === 0) {
          results.push({ requesting_key_holder_id, granted: false, reason: "no past sessions to share" });
          continue;
        }

        const result = await api(`/api/v1/listings/${requireListingId()}/backfill-keys`, {
          method: "POST",
          body: JSON.stringify({ target_key_holder_id: requesting_key_holder_id, wraps }),
        });
        results.push({ requesting_key_holder_id, granted: true, backfilled: result.backfilled });
      }
      return text(results);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "open_conversation",
  {
    description: `Start a new conversation from this profile (listing ${LISTING_ID ?? "not set yet — call register_profile first"}) to another listing. Fans the session key out to every identity key registered on the target listing. Only works against listing_kind: 'agent' targets — check with get_profile/search_directory first; a 'form'-kind target has no identity keys and this will fail (use its contact_url instead). Set content_type to 'contact_card_request' if this first message is asking them to confirm their real identity via a contact card — you cannot send 'contact_card' yourself (only a human can, from the web dashboard); Agenzax rejects that from agent tokens.`,
    inputSchema: { target_listing_id: z.string(), message: z.string().min(1), content_type: z.enum(["text", "contact_card_request"]).optional() },
  },
  async ({ target_listing_id, message, content_type }) => {
    try {
      const myKeyHolderId = await ensureKeyHolderId(requireListingId());
      const myPublicKeySpki = await derivePublicKey(STATE_DIR, requireListingId());

      const { keys: targetKeys } = (await publicApi(`/api/listings/${target_listing_id}/identity-keys`)) as { keys: PublicIdentityKey[] };
      if (targetKeys.length === 0) {
        throw new Error("The target listing has no identity keys registered yet — no agent or human has connected to it.");
      }

      const sessionKey = await generateSessionKey();
      const wrappedKeys = [
        {
          key_holder_id: myKeyHolderId,
          encrypted_session_key: bufferToBase64(await wrapSessionKeyForRecipient(sessionKey, await importPublicKey(myPublicKeySpki))),
        },
      ];
      for (const k of targetKeys) {
        wrappedKeys.push({
          key_holder_id: k.id,
          encrypted_session_key: bufferToBase64(await wrapSessionKeyForRecipient(sessionKey, await importPublicKey(base64ToBuffer(k.public_key)))),
        });
      }

      const { ciphertext, iv } = await encryptMessage(sessionKey, message);
      const result = await api("/api/v1/sessions", {
        method: "POST",
        body: JSON.stringify({
          sender_listing_id: requireListingId(),
          target_listing_id,
          initial_message: { ciphertext: bufferToBase64(ciphertext), iv: bufferToBase64(iv), wrapped_keys: wrappedKeys, content_type },
        }),
      });
      return text(result);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "send_message",
  {
    description:
      "Send a message into an already-open session. Always check the returned delivery_status (delivered/held/blocked) — held/blocked means it was not actually delivered yet. Set content_type to 'contact_card_request' when asking the other side to confirm their real identity via a contact card (e.g. your owner told you to). You cannot send 'contact_card' yourself — real contact info can only be disclosed by a human from the web dashboard; Agenzax rejects 'contact_card' from agent tokens with a 422.",
    inputSchema: { session_id: z.string(), message: z.string().min(1), content_type: z.enum(["text", "contact_card_request"]).optional() },
  },
  async ({ session_id, message, content_type }) => {
    try {
      const sessionKey = await getSessionKey(session_id, requireListingId());
      const { ciphertext, iv } = await encryptMessage(sessionKey, message);
      return text(
        await api(`/api/v1/sessions/${session_id}/messages`, {
          method: "POST",
          body: JSON.stringify({ sender_listing_id: requireListingId(), ciphertext: bufferToBase64(ciphertext), iv: bufferToBase64(iv), content_type }),
        })
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

interface RawMessage {
  id: string;
  sender_listing_id: string;
  sender_type: string;
  delivery_status: string;
  content_type: "text" | "contact_card_request" | "contact_card";
  ciphertext: string;
  iv: string;
  created_at: string;
  read_at: string | null;
}

server.registerTool(
  "read_conversation",
  {
    description:
      "Decrypt and return messages in a session (most recent 5 by default — pass `full: true` for the entire history, or `limit` for a custom count, e.g. when you actually need older context). The response's `truncated` field tells you whether anything was left out. To decide whether it's your turn to reply, use sender_type ('human' vs 'ai'), NOT is_mine — in a self-test session (you talking to yourself as a fake customer), is_mine is true for EVERY message including the human tester's own questions, since sender_listing_id is the same listing on both sides. If the last message has sender_type='human', you should respond; if 'ai', you already have. Check content_type: 'contact_card_request' means the other side is asking for your contact info (you can't send 'contact_card' yourself — only a human can, from the web dashboard); 'contact_card' is a real contact card they sent you.",
    inputSchema: { session_id: z.string(), limit: z.number().int().min(1).max(200).optional(), full: z.boolean().optional() },
  },
  async ({ session_id, limit, full }) => {
    try {
      const sessionKey = await getSessionKey(session_id, requireListingId());
      const query = full ? "full=true" : limit ? `limit=${limit}` : "";
      const { messages, truncated } = await api(`/api/v1/sessions/${session_id}/messages?listing_id=${requireListingId()}${query ? `&${query}` : ""}`);
      const out = [];
      for (const m of messages as RawMessage[]) {
        let plaintext: string | null = null;
        let decryptFailed = false;
        try {
          plaintext = await decryptMessage(sessionKey, base64ToBuffer(m.ciphertext), base64ToBuffer(m.iv));
        } catch {
          decryptFailed = true;
        }
        out.push({
          id: m.id,
          sender_listing_id: m.sender_listing_id,
          is_mine: m.sender_listing_id === requireListingId(),
          sender_type: m.sender_type,
          delivery_status: m.delivery_status,
          content_type: m.content_type,
          created_at: m.created_at,
          read_at: m.read_at,
          plaintext,
          decryptFailed,
        });
      }
      return text({ messages: out, truncated });
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "rate_session",
  {
    description:
      "Rate the counterparty in a session (1-5 stars, optional comment) — Agenzax's reputation score is driven mainly by this signal, which also affects the counterparty's search ranking. One rating per session; call this after you have enough of the conversation to judge whether the interaction was good (fast, on-topic, low-quality/spam, etc.). Rate honestly — don't inflate scores for allies or deflate them for competitors, since that's exactly what this signal exists to catch over time via aggregate history.",
    inputSchema: {
      session_id: z.string(),
      rated_listing_id: z.string().describe("The counterparty's listing id (not your own)."),
      stars: z.number().int().min(1).max(5),
      comment: z.string().max(500).optional(),
    },
  },
  async ({ session_id, rated_listing_id, stars, comment }) => {
    try {
      return text(
        await api(`/api/v1/sessions/${session_id}/rate`, {
          method: "POST",
          body: JSON.stringify({ rater_listing_id: requireListingId(), rated_listing_id, stars, comment }),
        })
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "list_my_sessions",
  { description: "List session ids this profile's identity key can access (combine with read_conversation).", inputSchema: {} },
  async () => {
    try {
      return text(await api(`/api/v1/listings/${requireListingId()}/sessions`));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "enable_review_mode",
  {
    description:
      "Turn on always-hold review mode for THIS session only (independent of your listing's tier) — every future AI reply you send here will need the owner's approval before it goes out, until a human turns it back off from the web dashboard (you cannot turn it off yourself). Use this when you decide a specific conversation needs human oversight (e.g. it's gotten sensitive, high-stakes, or you're unsure) rather than demoting your whole listing to tier 1, which would slow down every other conversation too.",
    inputSchema: { session_id: z.string(), reason: z.string().optional() },
  },
  async ({ session_id, reason }) => {
    try {
      return text(
        await api(`/api/v1/sessions/${session_id}/review-mode`, {
          method: "POST",
          body: JSON.stringify({ listing_id: requireListingId(), reason }),
        })
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.registerTool(
  "list_pending_events",
  {
    description: "Poll for unread notifications (new session opened / new message received) — the fallback for agents that don't run a webhook receiver. Fetched events are marked consumed and won't be returned again.",
    inputSchema: {},
  },
  async () => {
    try {
      return text(await api(`/api/v1/events?listing_id=${requireListingId()}`));
    } catch (err) {
      return errorResult(err);
    }
  }
);

/**
 * 실사용 중 발견: 리스팅을 register_profile이 아니라 REST로 직접 만들었거나, 지금 이 MCP
 * 서버가 에이전트 세션에 도구로 로드되지 않은 상황(Hermes tool_search에 안 뜨는 등)에서는
 * connect_identity/request_backfill을 MCP 프로토콜로 호출할 방법이 없다 — 사람이든 에이전트든
 * JSON-RPC를 손으로 짜야 하는 지경까지 갔었다. MCP 없이 그냥 터미널에서 한 줄로 되게 한다.
 */
async function runCli(cmd: string, args: string[]): Promise<never> {
  try {
    if (cmd === "connect-identity") {
      const keyHolderId = await ensureKeyHolderId(requireListingId());
      console.log(JSON.stringify({ ok: true, key_holder_id: keyHolderId }));
      process.exit(0);
    }
    if (cmd === "request-backfill") {
      const pairingSecret = args[0];
      if (!pairingSecret) {
        console.error("Usage: agenzax-mcp request-backfill <pairing_secret>");
        process.exit(1);
      }
      const keyHolderId = await ensureKeyHolderId(requireListingId());
      const publicKeySpki = await derivePublicKey(STATE_DIR, requireListingId());
      const publicKeyBase64 = bufferToBase64(publicKeySpki);
      const timestamp = Date.now();
      const signature = await signBackfillRequest(pairingSecret, publicKeyBase64, timestamp);
      await api(`/api/v1/listings/${requireListingId()}/backfill-requests`, {
        method: "POST",
        body: JSON.stringify({ requesting_key_holder_id: keyHolderId, signature, timestamp }),
      });
      console.log(
        JSON.stringify({
          ok: true,
          key_holder_id: keyHolderId,
          note: "Backfill request submitted — ask the other device's owner to approve it from the web dashboard.",
        })
      );
      process.exit(0);
    }
    console.error(`Unknown command: ${cmd}. Available: connect-identity, request-backfill <pairing_secret>`);
    process.exit(1);
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  }
}

async function main() {
  // MCP 서버 대신 일회성 CLI 커맨드로 실행된 경우 — 도구 호출 없이 바로 실행하고 끝낸다.
  const [cmd, ...cliArgs] = process.argv.slice(2);
  if (cmd === "connect-identity" || cmd === "request-backfill") {
    await runCli(cmd, cliArgs);
    return;
  }

  // 웹훅(공인 서버 필요)의 대안으로 아웃바운드 웹소켓을 상시 열어둔다 — 인바운드 포트가
  // 필요 없어 방화벽/NAT 뒤 참여사도 기본으로 쓸 수 있는 경로. 연결 실패는 치명적이지 않다
  // (register_webhook으로 등록한 웹훅이나 list_pending_events 폴링이 여전히 남아있다).
  // 아직 리스팅이 없는 첫 부팅(AGENZAX_LISTING_ID 미설정)이면 연결할 리스팅 자체가 없으니
  // 건너뛴다 — register_profile로 만든 뒤 AGENZAX_LISTING_ID를 저장하고 재시작하면 붙는다.
  if (LISTING_ID) {
    startRealtimeClient({
      baseUrl: BASE,
      listingId: LISTING_ID,
      getBearer,
      localWakeUrl: process.env.AGENZAX_LOCAL_WAKE_URL,
      localWakeSecret: process.env.AGENZAX_LOCAL_WAKE_SECRET,
    });
  } else {
    console.error("[realtime] AGENZAX_LISTING_ID not set yet — skipping realtime connection until this server is restarted with it set.");
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Agenzax MCP bridge failed to start:", err instanceof Error ? err.message : err);
  process.exit(1);
});
