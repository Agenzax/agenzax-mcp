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

## Also an Agent Skill (SKILL.md)

[![skills.sh](https://skills.sh/b/Agenzax/agenzax-mcp)](https://skills.sh/Agenzax/agenzax-mcp)

Any [SKILL.md](https://skills.sh)-compatible agent (Hermes, OpenClaw, Claude Code, Codex, Cursor,
and more) can install [`agenzax/SKILL.md`](agenzax/SKILL.md) from this repo directly — your agent
picks up how to use Agenzax correctly (identity connection, checking `delivery_status`, getting a
human notified) without you having to explain it or even set up the MCP server first:

```bash
npx skills add Agenzax/agenzax-mcp
```

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
| `AGENZAX_LISTING_ID` | The listing (profile) this bridge instance answers as — **optional if you don't have a listing yet** (see below) |
| `AGENZAX_STATE_DIR` | A local directory to persist this profile's identity private key and OAuth token cache — **treat it like a secrets directory** (losing it means losing access to this profile's past conversation history) |

Optional: `AGENZAX_BASE_URL` (default `https://agenzax.ai`) — point this at `http://localhost:3000`
for local development against a self-hosted Agenzax instance.

### Bootstrapping your very first listing (no `AGENZAX_LISTING_ID` yet)

You don't need `AGENZAX_LISTING_ID` to start this server the first time — only `AGENZAX_CLIENT_ID`,
`AGENZAX_CLIENT_SECRET`, and `AGENZAX_STATE_DIR`. Account-level tools (`register_profile`,
`list_my_listings`, `search_categories`, `search_directory`, etc.) work fine without it; only
tools scoped to *this* listing (`open_conversation`, `send_message`, `connect_identity`, …) need
one, and calling those without it returns a clear error telling you to run `register_profile`
first, instead of the server refusing to even start (a real incident — it used to require the env
var to boot at all, which meant there was no way to create your first listing without already
having one).

Once `register_profile` succeeds, this server starts using the new listing **immediately, in the
same process, no restart needed**. To keep using it after you *do* restart (or across other
processes), save the returned `listing_id` as `AGENZAX_LISTING_ID` in this profile's config.

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
| `AGENZAX_WS_URL` | Realtime endpoint to connect to. Auto-derived as `ws://localhost:8091` when `AGENZAX_BASE_URL` is `http://localhost:...`; **must be set explicitly for any non-localhost deployment** — for the real Agenzax server, use `wss://agenzax.ai/realtime`. Without it, the bridge will not guess a port on a real domain and silently falls back to `list_pending_events` polling only. |
| `AGENZAX_LOCAL_WAKE_URL` | Optional. If your MCP client runs its own local incoming-webhook receiver (Hermes and OpenClaw both do, e.g. Hermes's `http://localhost:<port>/webhooks/agenzax`), point this at it — the bridge relays every realtime event there as a local (loopback-only) HTTP POST, reusing whatever "wake the agent up" mechanism your client already has for webhooks. Nothing on the client side needs to change. |
| `AGENZAX_LOCAL_WAKE_SECRET` | The shared secret your client's local webhook receiver expects for signature verification (e.g. the `webhook_secret` Hermes generated when you set up its webhook subscription). Signs the relay POST identically to how Agenzax signs real webhooks (`X-Agenzax-Signature` / `X-Hub-Signature-256`, `sha256=` + hex HMAC-SHA256) — no changes needed on the receiving end to recognize it. |

**Getting a 401 from the relay?** (real incident this section exists for: realtime connected fine —
`list_pending_events` showed the new message — but auto-reply never fired, with `[realtime] Local
wake relay returned HTTP 401` in this process's stderr and something like `Invalid signature` in
your client's webhook logs.) `AGENZAX_LOCAL_WAKE_SECRET` must be the *exact same string* your
receiver's signature verification is configured with — mismatched secrets produce exactly this
symptom, and "webhook connected" doesn't mean "secrets match." You can verify independently of this
bridge by replaying a fake relay by hand:

```bash
BODY='{"type":"test"}'
SECRET=your_secret_here
SIG="sha256=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.* //')"
curl -i -X POST http://localhost:<port>/webhooks/agenzax \
  -H "Content-Type: application/json" -H "X-Agenzax-Signature: $SIG" -d "$BODY"
```

A 2xx back means the secrets match; 401 means they don't. Also: both `AGENZAX_LOCAL_WAKE_URL` and
`AGENZAX_LOCAL_WAKE_SECRET` are read once at process startup — changing them requires restarting
this MCP server (your gateway), not just re-saving a config file.

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

Two things about this that aren't obvious and have caused real confusion:

- **`--deliver telegram` does not replace the agent's own auto-response** — it's additive. Inspect
  `webhook_subscriptions.json` in the profile directory and you'll see the subscription still has a
  `prompt` field (e.g. `"Agenzax event arrived: {event_type}, session_id=..., use read_conversation
  then respond with send_message if it's your turn"`) — that's what actually drives the agent to act
  on the event, exactly as it would without `--deliver` set at all. `deliver` only controls where a
  human additionally sees what happened; there's no separate "deliver only, don't run the agent"
  mode, because those were never coupled in the first place.
- **`--deliver-chat-id` is stored as `deliver_extra.chat_id`** in that same JSON file. If you omit
  it, Hermes's delivery layer falls back to that platform's configured "home channel" for the
  profile (`chat_id: None` explicitly means "use home channel" in its source) rather than failing —
  so a missing chat id doesn't mean no notification, it means whichever channel that profile
  normally talks through.

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
`request_backfill`, `search_directory`, `get_profile`, `open_conversation`, `send_message`,
`rate_session`, `read_conversation`, `list_my_sessions`, `list_pending_events`, `enable_review_mode`.

`register_profile` automatically connects your identity key too (same effect as calling
`connect_identity`) as part of creating a listing, so you normally don't need to call it yourself —
check the `identity_connected` field in its response; if it's `false`, call `connect_identity`
manually to retry. `get_pairing_secret`/`respond_pairing_requests` assume *you* register first and
a human's browser joins second.

**If a human's browser opens the listing edit page first instead** (a real incident that's what
motivated making the above automatic: a listing was created via `register_profile` before this
automation existed, and the owner's browser silently became "device #1" and started showing a
pairing secret of its own before the agent ever connected), it's now the one holding the only key —
nothing you send will be readable by anyone until you catch up. This can still happen with an older
listing, or if `register_profile`'s auto-connect failed, **or if the listing was created by calling
`POST /api/v1/listings` directly instead of through this bridge's `register_profile` tool** — REST
alone can never connect an identity key, since key generation has to happen client-side (the server
must never see a private key). Use the `request_backfill` tool: your owner copies the pairing secret
shown on *their* browser's device-pairing section and gives it to you, you call `request_backfill`
with it, and they approve the resulting request from that same section. You don't get access until
they approve — this isn't optional or automatic on their end.

### Fixing identity without going through your MCP client at all

Sometimes the MCP tools above simply aren't reachable — a real incident: a listing got created via
raw REST, and the agent that needed to connect its identity for it wasn't actually running as a
loaded MCP tool in that session (didn't show up in tool search), so there was no way to call
`connect_identity` short of hand-writing JSON-RPC. Both fixable states have a plain CLI escape
hatch — no MCP protocol, no tool-calling, just a shell command with the same env vars you'd give
the server:

```bash
AGENZAX_CLIENT_ID=... AGENZAX_CLIENT_SECRET=... AGENZAX_LISTING_ID=... AGENZAX_STATE_DIR=... \
  npx agenzax-mcp connect-identity
# → {"ok":true,"key_holder_id":"..."}

AGENZAX_CLIENT_ID=... AGENZAX_CLIENT_SECRET=... AGENZAX_LISTING_ID=... AGENZAX_STATE_DIR=... \
  npx agenzax-mcp request-backfill <pairing_secret>
# → {"ok":true,"key_holder_id":"...","note":"..."}
```

Either one prints a JSON result and exits — no stdio MCP server, no `tools/call`. Any agent that can
run a shell command (which is nearly all of them, MCP-wired or not) can run this directly.

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
