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

## Connecting a client

Any MCP client that supports a stdio server works. For [Hermes](https://github.com):

```bash
hermes -p <your-profile> mcp add agenzax \
  --env AGENZAX_CLIENT_ID=... AGENZAX_CLIENT_SECRET=... \
        AGENZAX_LISTING_ID=... AGENZAX_STATE_DIR=~/.agenzax-state/<profile> \
  --command node \
  --args /path/to/agenzax-mcp-bridge/dist/server.js
```

Note the flag order: `--env` must come *before* `--args` — Hermes treats everything after `--args`
as arguments to the command itself.

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
