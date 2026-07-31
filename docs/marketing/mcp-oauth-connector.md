# Connecting Claude to Jeeta over OAuth

Jeeta is an OAuth 2.1 authorization server for its own MCP endpoint. That is
what lets **Claude.ai** and **Claude Desktop** add
`https://jeetagrowth.com/api/mcp` as a connector from their own UI: you sign in
to Jeeta, approve a workspace and a set of permissions on a consent screen, and
the connector is bound to **you**, not to a shared workspace key.

This is the companion to [`mcp-connector.md`](./mcp-connector.md), which covers
the tools themselves, approvals, write mode and the audit trail. Read this one
for **how a client authenticates**; read that one for **what it can then do**.

| | OAuth (this document) | API key (`mk_live_…`) |
|---|---|---|
| Set up by | any workspace member, from the client's UI | OWNER/MANAGER, in Jeeta's settings |
| Bound to | a **user** + one workspace | a **workspace** |
| Permissions | chosen on the consent screen, capped by your role | the key's scopes |
| Lead visibility | your own rows if you are a REP | whole workspace (no user to narrow by) |
| Revoked by | removing the user's membership, or revoking the token | revoking the key |
| Works in | Claude.ai, Claude Desktop | Claude Code, anything that can set a header |

Prefer OAuth wherever the client supports it: it is the only path where the
audit trail names a person.

## 1. Add the connector

**Claude.ai** — Settings → Connectors → *Add custom connector* → paste:

```
https://jeetagrowth.com/api/mcp
```

**Claude Desktop** — Settings → Connectors → *Add custom connector*, same URL.

Nothing else is needed. There is no client ID to create, no secret to paste,
and no registration step in Jeeta: Claude identifies itself with a **Client ID
Metadata Document** (see [How the flow works](#how-the-flow-works)).

The path is **`/api/mcp`**, not `/mcp` — `app.setGlobalPrefix('api')` applies to
the MCP controller too.

## 2. Approve it

The client opens a browser window at Jeeta. If you are not signed in you get the
normal login screen, and you are returned to the consent page afterwards with
the request intact.

The consent screen (`/oauth/consent`) shows:

- **who is asking** — the client's name and, under it, the URL of its metadata
  document. That URL is the client's real identity: anyone can claim the name
  "Claude", but only whoever controls `claude.ai` can serve a document at a
  `claude.ai` URL.
- **what it will be able to do**, in plain language (`leads.read` reads as "Read
  your leads"). Anything crossed out is a permission **your role in the selected
  workspace does not have** — it will not be granted, and switching workspaces
  can change the list.
- **which workspace** it lands in. Only workspaces you are an active member of
  are offered; the one you are currently working in is preselected.

Press **Allow** and the browser returns to the client, which exchanges its code
for tokens. Press **Deny** and the client is told `access_denied` and nothing is
created.

### What you cannot grant

The consent screen is not a way around the permission model. The granted scopes
are capped three times, server-side:

1. by what the client asked for,
2. by your **active** membership in the chosen workspace,
3. by the permissions your role actually holds there (a REP cannot consent
   themselves into `campaigns.send`, `leads.manage`, `courses.manage`,
   `automations.manage` or `settings.manage`).

`users.manage` and `billing.manage` are not offerable at all: they are absent
from `MCP_ALL_SCOPES`, because no tool may ever require them (see
[What is never a tool](./mcp-connector.md#what-is-never-a-tool)). Every scope
that IS offerable is rendered in a sentence on the consent screen rather than as
a raw id — a permission you cannot read is one you cannot meaningfully refuse.

## 3. Check it works

Ask Claude to list its Jeeta tools. You should see the **advertised** subset of
the [tool catalogue](./mcp-connector.md#tool-catalogue) your granted scopes
cover — a narrower grant legitimately shows fewer tools, not an error.

The catalogue is 84 tools across 21 domains, but only 45 are advertised in
`tools/list`: past ~60, listing everything at once degrades a model's accuracy.
The rest are **deferred** — fully registered, scope-checked and callable, just
not pushed into every session. If a tool you expect is missing, ask Claude to
call `jeeta.find_tools` and search for it; that returns each match with its
input schema so it can be called straight away. `jeeta.find_tools` applies the
same scope filter, so it can never reveal a tool your grant does not cover. See
[Progressive disclosure](./mcp-connector.md#progressive-disclosure).

Then confirm the audit trail: `GET /api/marketing/approvals/agent-runs` (or the
`agent_runs` table) should show a row with `agent = 'mcp'` for the call.

## How the flow works

```
Claude                         Jeeta                          You
  │                              │                             │
  │ 1. POST /api/mcp (no token)  │                             │
  ├─────────────────────────────►│                             │
  │ 401 + WWW-Authenticate:      │                             │
  │    resource_metadata="…"     │                             │
  │◄─────────────────────────────┤                             │
  │                              │                             │
  │ 2. GET /.well-known/oauth-protected-resource/api/mcp        │
  │    → resource + which authorization server guards it        │
  │ 3. GET /.well-known/oauth-authorization-server              │
  │    → authorize + token endpoints, S256-only, CIMD supported │
  │                              │                             │
  │ 4. browser → GET /api/mcp-oauth/authorize?…                 │
  │              (client_id = its CIMD URL, PKCE challenge,     │
  │               resource = https://jeetagrowth.com/api/mcp)   │
  │                              │  302 → /oauth/consent?…      │
  │                              ├────────────────────────────►│
  │                              │                             │
  │                              │  GET/POST /authorize/consent │
  │                              │◄───────────────────────────►│  Allow
  │                              │                             │
  │ 5. redirect_uri?code=…&state=…&iss=https://jeetagrowth.com  │
  │◄─────────────────────────────┤                             │
  │                              │                             │
  │ 6. POST /api/mcp-oauth/token (code + code_verifier)         │
  │    → access_token (1h) + refresh_token (rotating)           │
  │                              │                             │
  │ 7. POST /api/mcp with Authorization: Bearer …               │
```

The properties worth knowing, because they change what can go wrong:

- **PKCE is mandatory, S256 only.** An authorize request without a
  `code_challenge`, or with `code_challenge_method=plain`, is refused. (RFC 7636
  §4.3 defaults an *absent* method to `plain`; Jeeta refuses rather than
  inheriting that default.)
- **The client is identified by CIMD, not registration.** `client_id` is an
  HTTPS URL; Jeeta fetches it (through the SSRF-guarded `safeFetch`) and refuses
  any document that does not claim that exact URL as its own `client_id`. That
  self-reference check is what stops one client impersonating another. There is
  no `/register` endpoint.
- **`redirect_uri` must be one the fetched document declares**, matched exactly
  — no prefix matching, no normalisation.
- **Tokens are audience-bound (RFC 8707).** Every token names
  `https://jeetagrowth.com/api/mcp` as its `resource`, and the MCP endpoint
  refuses a token minted for anything else. A token you granted to some other
  MCP server cannot be replayed here.
- **The authorization response carries `iss` (RFC 9207)**, so a client holding
  several authorization servers cannot be fed Jeeta's code as if it came from
  another.
- **Codes and tokens are hashed at rest** (SHA-256, same convention as API
  keys). A database leak yields nothing redeemable.
- **The authorization code is single-use**, and replaying it revokes every token
  descended from it.
- **Refresh tokens rotate**, and reusing a revoked one revokes the whole chain.
- **Access tokens live ~1 hour**; the database is read on every MCP request, so
  a revoked token stops working on the next call, not when it expires.
- **Your role is re-resolved on every tool call.** A demotion takes effect
  immediately, and if your membership is removed the connector stops working —
  nobody has to hunt down the tokens you were issued.

### Discovery lives at the root

Both metadata documents are served at the **origin root**, not under `/api` —
RFC 9728 §3 and RFC 8414 §3 put them there, and that is where clients look:

| Document | URL |
|---|---|
| Protected resource (RFC 9728) | `https://jeetagrowth.com/.well-known/oauth-protected-resource/api/mcp` |
| Authorization server (RFC 8414) | `https://jeetagrowth.com/.well-known/oauth-authorization-server` |

Note the shape of the first: the resource's path (`/api/mcp`) is a **suffix** of
the well-known path, not a prefix — `/api/.well-known/…` is wrong and returns
404 on purpose.

`PUBLIC_BASE_URL` is what these documents publish as the issuer. It is
deliberately **not** derived from the `Host` header (which an attacker can set),
so a deployment with it unset refuses to publish metadata at all rather than
publish someone else's origin as ours.

## The API-key alternative (Claude Code)

Claude Code sets a static header rather than running an OAuth flow, so it uses a
workspace API key. Full instructions are in
[`mcp-connector.md`](./mcp-connector.md#1-mint-a-workspace-api-key); the short
version:

```bash
claude mcp add --transport http jeeta https://jeetagrowth.com/api/mcp \
  --header "Authorization: Bearer mk_live_XXXXXXXXXXXXXXXXXXXXXXXX"
```

The one behavioural difference to keep in mind: an API-key session has **no
user**, so `jeeta.search_leads` runs under a named service principal and sees
every lead in the workspace. An OAuth session runs as you.

## Smoke tests

Discovery — no credential needed:

```bash
curl -s https://jeetagrowth.com/.well-known/oauth-protected-resource/api/mcp
# {"resource":"https://jeetagrowth.com/api/mcp",
#  "authorization_servers":["https://jeetagrowth.com"],
#  "scopes_supported":["leads.read",...],"bearer_methods_supported":["header"]}

curl -s https://jeetagrowth.com/.well-known/oauth-authorization-server
# {"issuer":"https://jeetagrowth.com",
#  "authorization_endpoint":"https://jeetagrowth.com/api/mcp-oauth/authorize",
#  "token_endpoint":"https://jeetagrowth.com/api/mcp-oauth/token",
#  "code_challenge_methods_supported":["S256"],
#  "client_id_metadata_document_supported":true,...}
```

The 401 challenge that starts discovery:

```bash
curl -si -X POST https://jeetagrowth.com/api/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | head -20
# HTTP/1.1 401
# WWW-Authenticate: Bearer realm="jeeta-mcp",
#   resource_metadata="https://jeetagrowth.com/.well-known/oauth-protected-resource/api/mcp"
```

`initialize`, then `tools/list`, with a token (an OAuth access token or an
`mk_live_…` key — the endpoint takes either):

```bash
TOKEN="…"

curl -si -X POST https://jeetagrowth.com/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":"2025-11-25","capabilities":{},
        "clientInfo":{"name":"curl","version":"1.0.0"}}}'
# → {"result":{"serverInfo":{"name":"jeeta","version":"1.0.0"},…}}
# If the response carries an `mcp-session-id` header, echo it back on
# subsequent calls as `-H "mcp-session-id: <value>"`.

curl -s -X POST https://jeetagrowth.com/api/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
# → the ADVERTISED tools your granted scopes cover, and only those.
#   Deferred tools are callable by name but not listed here — call
#   jeeta.find_tools to discover them.
```

Both use `Accept: application/json, text/event-stream` because the transport may
answer either as JSON or as a single SSE event.

## Troubleshooting

- **The client says the server has no OAuth / discovery fails.** Check the two
  well-known URLs above return 200 at the **root**. A 404 there with a working
  `/api/mcp` means the global-prefix exclusion is missing
  (`MCP_OAUTH_WELL_KNOWN_EXCLUSIONS` in `mcp-oauth.config.ts`), or
  `PUBLIC_BASE_URL` is unset, which makes metadata 503 by design.
- **`{"error":"invalid_target"}` on authorize.** The client asked for a
  `resource` that is not `https://jeetagrowth.com/api/mcp`. Usually a
  copy-pasted URL with the wrong host or a missing `/api`.
- **`{"error":"invalid_client","error_description":"client_id metadata document
  does not claim the URL it was fetched from"}`.** The document served at the
  `client_id` URL names a different `client_id`. This is the impersonation
  check; it is byte-exact on purpose.
- **`{"error":"invalid_request","error_description":"code_challenge is required
  (PKCE)"}`.** The client is not doing PKCE. Jeeta has no non-PKCE path.
- **The consent screen offers no workspaces.** You have no ACTIVE membership.
  Being invited is not enough — the invite has to be accepted.
- **Everything is crossed out on the consent screen.** Your role in that
  workspace holds none of the requested permissions. Pick a different workspace
  or ask an OWNER for the permission.
- **`401 invalid_token` on `/api/mcp` with a token that worked yesterday.** It
  expired (access tokens are ~1h — the client should refresh), it was revoked,
  or it was minted for a different resource. All three answer identically on
  purpose: which one it was is not the presenter's business.
- **The connector suddenly stops working for one person.** Their workspace
  membership was removed or deactivated. The role is re-resolved per call, so
  this bites immediately and by design.
