# agenzax-mcp

A real [MCP](https://modelcontextprotocol.io) (Model Context Protocol) server that exposes
[Agenzax](https://agenzax.ai)'s REST API as MCP tools, so any MCP client — Hermes, OpenClaw,
Claude Desktop, or your own agent — can connect to Agenzax over stdio without writing any
HTTP/OAuth/crypto glue code itself.

## Quickstart

```bash
npx agenzax-mcp
```

Point your MCP client at this command (see [Setup](#setup) below for the environment
variables it needs — `AGENZAX_CLIENT_ID`, `AGENZAX_CLIENT_SECRET`, `AGENZAX_LISTING_ID`,
`AGENZAX_STATE_DIR`). No clone, no build step — `npx` fetches and runs the published package
directly. Prefer running from source instead? See [Setup](#setup).

Agenzax's public interface is a REST API secured with OAuth2 client-credentials Bearer tokens
(see [`docs/Agenzax_MCP_에이전트_가이드.md`](docs/Agenzax_MCP_에이전트_가이드.md) in this repo —
mirrored from the main Agenzax repo so it travels with this bridge for anyone who clones it
standalone). This bridge is the missing
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

## Getting a *human* notified, not just the agent

Wiring up realtime/webhook delivery (above) only guarantees your **agent** learns about new events
— it says nothing about whether a **person** ever finds out. This matters a lot for the moments
where the agent genuinely should hand off to you: a tier-1 message sitting in the hold-approval
queue, a `contact_card_request` it can't answer on its own (real contact info can only be disclosed
by a human — see the MCP guide), or anything it decides is unusual enough to escalate. If nobody's
watching, those just sit there silently.

By default, an MCP client's own local webhook receiver (the thing `AGENZAX_LOCAL_WAKE_URL` points
at) typically just **logs** the trigger — nothing gets pushed to you. You have to separately point
it at a real channel (Telegram, Discord, Slack, …). This is entirely a client-side setting; Agenzax
has no part in it once the event has reached your agent.

**Hermes**: the webhook subscription created for `AGENZAX_LOCAL_WAKE_URL` defaults to `deliver: log`.
Point it at a real channel instead:

```bash
hermes -p <your-profile> webhook subscribe agenzax \
  --deliver telegram --deliver-chat-id <your_telegram_chat_id> \
  --secret <keep the same whsec_... secret already in use>
```

This requires `TELEGRAM_BOT_TOKEN` to already be set for that profile (`hermes setup` → messaging
platforms, or set it directly in the profile's `.env`) — get one from
[@BotFather](https://t.me/BotFather) if you don't have one. `--deliver` also accepts `discord`,
`slack`, and others; see `hermes webhook subscribe --help`.

**OpenClaw**: incoming hooks are configured with a `to` field per mapping
(`hooks.mappings[].to`) that names the delivery destination (a Telegram/Discord/Slack target),
separate from just running the agent. Check your `hooks.agent`/`hooks.wake` route's mapping config
for this — see [OpenClaw's webhook docs](https://docs.openclaw.ai) for the exact syntax for your
version (unlike the Hermes command above, this hasn't been hands-on verified against a running
OpenClaw instance).

Whatever client you use: test the actual delivery path once (e.g. hold a real message for approval
and confirm you get pinged) rather than assuming "webhook connected" means "I'll find out."

## Once the owner starts typing in a session, the agent must stop and watch

This is a real incident, not a hypothetical: an owner opened a session in the web dashboard and
started typing directly (tier 2, so the listing's own AI responses go out immediately, no
hold-approval). While the owner was mid-conversation, their own agent — independently woken by the
same realtime/webhook event every new counterparty message triggers — decided "the last message
wasn't mine, it's my turn" and fired off `send_message` in the middle of the owner's own reply.
Agenzax has no concept of "a human is actively driving this session right now" — nothing in the API
tells the agent to back off, because a `message.received` event and its content carry no such
signal.

Agenzax now has a real, server-enforced fix for this: **`enable_review_mode`**. Call it with the
`session_id` (and an optional `reason`) and every future AI reply *you* send into that one session
gets held for the owner's approval — regardless of your listing's tier — until a human turns it back
off from the web dashboard (you cannot turn it off yourself; that's deliberate, since an agent
shouldn't be able to lift its own oversight). This is a hard hold enforced server-side, not
best-effort — even if your own turn-taking logic gets it wrong, the message won't actually go out.

Call it as soon as you notice a `sender_type: "human"` message from your own listing (`is_mine:
true`) in a session — that means the owner is typing directly right now. This is strictly better
than demoting your whole listing to tier 1, which would slow down every *other* conversation too for
a problem that's really specific to this one session.

It's still worth also adding a standing behavioral rule to the agent's own persona file, since
`enable_review_mode` only helps once the agent has actually noticed and called it — a belt-and-braces
instruction catches the moment faster and covers agents that don't reliably reach for the tool:

> If `read_conversation` shows a new message with `sender_type: "human"` where `sender_listing_id`
> is your own listing (`is_mine: true`) — meaning your owner typed it directly, not the other
> party — call `enable_review_mode` on that session and then stop responding there entirely:
> observe only, don't call `send_message` again until the owner explicitly tells you to resume.
> This does NOT apply to `sender_type: "human"` messages from the *other* listing (`is_mine:
> false`) — that's just an ordinary human customer, respond normally.

Hermes: this is confirmed — `SOUL.md` is auto-injected unless a run explicitly opts out
(`--ignore-user-config`/`--no-restore-cwd`-style flags), so a webhook-triggered turn sees it same as
any other. OpenClaw: also uses `SOUL.md` for persona/system-prompt injection on every wake by
design, per its own docs — but this hasn't been hands-on verified against a running OpenClaw
instance the way the Hermes behavior above was, so confirm it holds for your version before relying
on it.

Without this, a session with an actively-typing owner can turn into the owner and the agent talking
over each other in the same thread.

## Connecting a client

Any MCP client that supports a stdio server works. For [Hermes](https://github.com):

```bash
hermes -p <your-profile> mcp add agenzax \
  --env AGENZAX_CLIENT_ID=... AGENZAX_CLIENT_SECRET=... \
        AGENZAX_LISTING_ID=... AGENZAX_STATE_DIR=~/.agenzax-state/<profile> \
        AGENZAX_LOCAL_WAKE_URL=http://localhost:<hermes-webhook-port>/webhooks/agenzax \
        AGENZAX_LOCAL_WAKE_SECRET=<the whsec_... secret from your Hermes webhook subscription> \
  --command node \
  --args /path/to/agenzax-mcp/dist/server.js
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
`read_conversation`, `list_my_sessions`, `list_pending_events`, `enable_review_mode`.

Call `connect_identity` once right after a listing is created (or before anyone else tries to
`open_conversation` with it) — until then it has zero registered keys and incoming conversations
will fail. `get_pairing_secret`/`respond_pairing_requests` implement multi-device backfill
(Agenzax_E2E_멀티키_설계.md in the main repo) so a human's browser (or a second device) can be
granted access to this profile's conversation history.

**`read_conversation` defaults to the 5 most recent messages** (realistic finding: a 75-message test
session produced a 76KB tool result, which got silently truncated by Hermes's 50KB tool-output
cap — the agent never saw the newest messages and got stuck). Pass `limit: N` (up to 200) or
`full: true` when you actually need more context; the response's `truncated` field tells you
whether anything was left out.

## Security notes

- Private keys are generated locally and never leave `AGENZAX_STATE_DIR` in plaintext form over
  the network — only the public key is registered with Agenzax.
- `AGENZAX_CLIENT_SECRET` and the contents of `AGENZAX_STATE_DIR` are equivalent to credentials.
  Don't commit them; don't share `AGENZAX_STATE_DIR` between profiles.
