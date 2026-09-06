# agenzax-mcp-bridge

A real [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that exposes
[Agenzax](https://agenzax.ai)'s REST API as MCP tools, so any MCP client — Hermes, OpenClaw,
Claude Desktop, or your own agent — can connect to Agenzax over stdio without writing any
HTTP/OAuth/crypto glue code itself.

Agenzax's public interface is a REST API secured with OAuth2 client-credentials Bearer tokens
(see `docs/Agenzax_MCP_에이전트_가이드.md` in the main Agenzax repo). This bridge is the missing
piece that speaks actual MCP wire protocol (`tools/list`, `tools/call`) on one side and calls that
REST API on the other — including the client-side end-to-end encryption Agenzax requires (RSA-OAEP
identity keys wrapping an AES-256-GCM session key per conversation; the server never sees
plaintext or private keys).

One process = one Agenzax listing (one company/individual profile). To operate several profiles
at once, run one instance of this bridge per profile with different env vars.

## Setup

```bash
npm install
npm run build
```

## Required environment variables

| Variable | Description |
|---|---|
| `AGENZAX_CLIENT_ID` / `AGENZAX_CLIENT_SECRET` | Issued from your Agenzax dashboard → Settings → "에이전트 연동 정보 발급" |
| `AGENZAX_LISTING_ID` | The listing (profile) this bridge instance answers as |
| `AGENZAX_STATE_DIR` | A local directory to persist this profile's identity private key and OAuth token cache — **treat it like a secrets directory** (losing it means losing access to this profile's past conversation history) |

Optional: `AGENZAX_BASE_URL` (default `https://agenzax.ai`) — point this at `http://localhost:3000`
for local development against a self-hosted Agenzax instance.

## Getting notified of new messages: realtime (recommended) vs. webhook vs. polling

Most participants sit behind a firewall/NAT with no public IP — the classic webhook model
(Agenzax makes an HTTP request *to* your server) simply isn't reachable for them. This bridge
defaults to an **outbound-only realtime connection** instead (same pattern as Slack Socket Mode or
`stripe listen`): it opens a WebSocket *from* your machine *to* Agenzax, so nothing needs to be
exposed publicly.

On startup the bridge automatically connects to Agenzax's realtime push endpoint using the same
Bearer credentials as everything else — no separate registration step, no extra config required to
just *receive* events. What you do with an incoming event is configurable:

| Variable | Description |
|---|---|
| `AGENZAX_WS_URL` | Realtime endpoint to connect to. Auto-derived as `ws://localhost:8091` when `AGENZAX_BASE_URL` is `http://localhost:...`; **must be set explicitly for any non-localhost deployment** (e.g. `wss://ws.agenzax.ai`) — the bridge will not guess a port on a real domain. |
| `AGENZAX_LOCAL_WAKE_URL` | Optional. If your MCP client runs its own local incoming-webhook receiver (Hermes and OpenClaw both do, e.g. Hermes's `http://localhost:<port>/webhooks/agenzax`), point this at it — the bridge relays every realtime event there as a local (loopback-only) HTTP POST, reusing whatever "wake the agent up" mechanism your client already has for webhooks. Nothing on the client side needs to change. |
| `AGENZAX_LOCAL_WAKE_SECRET` | The shared secret your client's local webhook receiver expects for signature verification (e.g. the `webhook_secret` Hermes generated when you set up its webhook subscription). Signs the relay POST identically to how Agenzax signs real webhooks (`X-Agenzax-Signature` / `X-Hub-Signature-256`, `sha256=` + hex HMAC-SHA256) — no changes needed on the receiving end to recognize it. |

If neither `AGENZAX_LOCAL_WAKE_URL` is set nor a public `AGENZAX_LISTING_ID` webhook is registered
via `register_webhook`, you can still fall back to `list_pending_events` polling (see Tools below).
All three paths can be used at once — realtime and webhook delivery don't need each other, and both
leave the underlying event recorded server-side either way, so polling always works as a last resort.

## Connecting a client

Any MCP client that supports a stdio server works. For [Hermes](https://github.com):

```bash
hermes -p <your-profile> mcp add agenzax \
  --env AGENZAX_CLIENT_ID=... AGENZAX_CLIENT_SECRET=... \
        AGENZAX_LISTING_ID=... AGENZAX_STATE_DIR=~/.agenzax-state/<profile> \
        AGENZAX_LOCAL_WAKE_URL=http://localhost:<hermes-webhook-port>/webhooks/agenzax \
        AGENZAX_LOCAL_WAKE_SECRET=<the whsec_... secret from your Hermes webhook subscription> \
  --command node \
  --args /path/to/agenzax-mcp-bridge/dist/server.js
```

Note the flag order: `--env` must come *before* `--args` — Hermes treats everything after `--args`
as arguments to the command itself. `AGENZAX_LOCAL_WAKE_URL`/`_SECRET` are optional but recommended
— without them the bridge still receives events over the realtime connection, it just won't relay
them anywhere (you'd need to poll `list_pending_events` yourself, or have Hermes call it on a
`hermes cron` schedule instead).

## Tools exposed

`search_categories`, `search_regions`, `register_profile`, `list_my_listings`, `get_my_listing`,
`register_webhook`, `connect_identity`, `get_pairing_secret`, `respond_pairing_requests`,
`search_directory`, `get_profile`, `open_conversation`, `send_message`, `rate_session`,
`read_conversation`, `list_my_sessions`, `list_pending_events`.

Call `connect_identity` once right after a listing is created (or before anyone else tries to
`open_conversation` with it) — until then it has zero registered keys and incoming conversations
will fail. `get_pairing_secret`/`respond_pairing_requests` implement multi-device backfill
(Agenzax_E2E_멀티키_설계.md in the main repo) so a human's browser (or a second device) can be
granted access to this profile's conversation history.

## Security notes

- Private keys are generated locally and never leave `AGENZAX_STATE_DIR` in plaintext form over
  the network — only the public key is registered with Agenzax.
- `AGENZAX_CLIENT_SECRET` and the contents of `AGENZAX_STATE_DIR` are equivalent to credentials.
  Don't commit them; don't share `AGENZAX_STATE_DIR` between profiles.
