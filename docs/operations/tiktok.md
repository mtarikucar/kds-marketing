# TikTok

Jeeta connects a workspace's TikTok account through the platform's TikTok app (Login Kit), posts
its Studio pieces through the Content Posting API (a human always passes the TikTok posting
screen first), reads the account's and its posts' counters, and receives TikTok's webhooks
(spec `docs/superpowers/specs/2026-10-27-tiktok-linkedin-connectors-design.md` §2). The adapter is
`rust/crates/adapters/jt_tiktok`; its crate docs hold the call table and the error mapping.

This page is for the operator: the two TikTok apps, the environment, what to register in TikTok's
developer portal, how to move from the sandbox app to the production app, and what each error
means. No key or secret belongs on this page, in Git or in a chat: they live in the hosts'
environment files only.

## 1. The two apps

| | Sandbox | Production |
|---|---|---|
| App id (public: it appears in TikTok's URLs) | `7657953727315413012` | `7654940656787277840` |
| Status (2026-10-30) | in use on yeni and staging | **in review** (resubmitted 2026-10-28 after a "Scopes mismatch" rejection) |
| Who can sign in | only the TikTok accounts added as target users in the sandbox | anyone, once approved |
| Posting | unaudited: only to **private** accounts, privacy "Only me" | audited: every privacy the account is offered |

Both have the products **Login Kit** and **Content Posting API** (Direct Post on), and the scopes
`user.info.basic`, `user.info.stats`, `video.list`, `video.publish` and `video.upload` (the last
comes with Content Posting and cannot be removed; Jeeta uses it for "send to TikTok drafts").
Jeeta asks for exactly these five at sign-in, and shows TikTok's consent page every time
(`disable_auto_auth=1`).

A TikTok account has a different `open_id` under each app ("if a partner has X number of
clients, it will get X number of open_id for the same TikTok user",
<https://developers.tiktok.com/doc/tiktok-api-v2-get-user-info>). Jeeta keys a `tiktok` capability
by its `open_id`, so a capability connected through one app is never the same account as one
connected through the other (section 4).

## 2. Environment

| Variable | Value |
|---|---|
| `JEETA_TIKTOK_CLIENT_KEY` | the app's client key (portal → the app → App details) |
| `JEETA_TIKTOK_CLIENT_SECRET` | the app's client secret; given with the key, or neither |
| `JEETA_PUBLIC_BASE_URL` | required once any provider app is set: the redirect and webhook addresses are built from it |

The values live in the service's environment file, `root:root` 0600, never printed:

| Host | File | Service |
|---|---|---|
| `yeni.jeetagrowth.com` (production) | `/etc/jeeta/jeeta.env` | `jeeta.service` |
| `staging.jeetagrowth.com` | `/etc/jeeta-staging/jeeta.env` | `jeeta-staging.service` |

At start the binary logs one line `provider apps: ...` with `providers=` the configured apps: it
must name `tiktok`. The client secret signs the OAuth token calls and verifies the webhooks, so the
key and the secret must be the same app's, and the app whose webhooks a host receives (section 3).

## 3. What to register in TikTok's developer portal

**Redirect URIs** (Login Kit → Redirect URI), each exactly, on the app the host runs with:

| When | URI |
|---|---|
| now | `https://yeni.jeetagrowth.com/oauth/callback/tiktok` |
| now | `https://staging.jeetagrowth.com/oauth/callback/tiktok` |
| until v1 is stopped | `https://jeetagrowth.com/api/marketing/social/oauth/tiktok/callback` (v1's) |
| at the jeetagrowth.com cutover to Rust (`docs/operations/v1-cutover.md`) | `https://jeetagrowth.com/oauth/callback/tiktok`, added before the DNS switch; v1's removed once v1 is stopped |

**Webhook callback URL** (the app's Webhooks section): `https://<host>/hooks/tiktok`. TikTok sends
an app's events to the one callback URL registered for that app
(<https://developers.tiktok.com/doc/webhooks-overview>), so each app points at the host that runs
with its keys:

- the production app: `https://yeni.jeetagrowth.com/hooks/tiktok` until the cutover, then
  `https://jeetagrowth.com/hooks/tiktok`;
- the sandbox app, while it is used: `https://staging.jeetagrowth.com/hooks/tiktok`.

A host that receives another app's webhooks answers `401` (the signature is the other app's
secret); TikTok then retries for 72 hours and drops the event. Nothing is lost for good: the status
poll settles posts and the hourly probe notices a lost access, only later. The panel shows the
address to paste under Capabilities → Webhook addresses → TikTok (MCP: `jeeta.connector.hooks`,
field `tiktok`), with the events Jeeta acts on. TikTok's documentation describes no per-event
subscription for these events; if the portal offers a choice, select at least the five below.

| Event (<https://developers.tiktok.com/doc/webhooks-events>, <https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status>) | What Jeeta does |
|---|---|
| `authorization.removed` | the account removed the app (or its account was deleted, banned, ...): the capability turns unreachable and the owner is asked to reconnect (`connector.authorization_removed` in the ledger, a reconnect item in pending work) |
| `post.publish.failed`, `post.publish.complete`, `post.publish.inbox_delivered`, `post.publish.publicly_available` | the post's status is read back at once, exactly as the minute's recovery job does, so the slot settles in seconds (and a public post gets its public id and link) |
| anything else (`post.publish.no_longer_publicaly_available`, a future event) | stored, left for the agent (`jeeta.events.pending`) |

The delivery is checked before anything is read: header `TikTok-Signature: t=<unix>,s=<hex>`,
HMAC-SHA256 under the client secret over `"{t}.{raw body}"`
(<https://developers.tiktok.com/doc/webhooks-verification>), compared in constant time, `t` within
five minutes of the server's clock. TikTok gives its events no id and delivers at least once: Jeeta
names an event by what it says (its name, account, time and content) and stores it once. A storage
failure answers `500` so that TikTok redelivers; everything else answers `200`.

## 4. Moving from the sandbox key to the production key

Do it once TikTok approved the production app, on staging first, then on production. The release
must carry TikTok webhooks (migration `0018_tiktok_webhooks`); deploy it first with the usual
procedure (`docs/operations/deployment.md`, "Upgrade and rollback") if it does not.

What changes for the accounts already connected: their tokens are the sandbox app's. Once the host
runs with the production app, the hourly refresh presents a sandbox refresh token to the production
app and is refused, so each such capability turns unreachable and asks to be reconnected; and
reconnecting it is refused with `account_mismatch`, because the same TikTok account has another
`open_id` under the production app (section 1). So each one is **retired and connected again**,
as a new capability; retired **before** the switch, its token is still revoked with the sandbox
app it belongs to.

On staging:

1. In the portal, on the production app: status approved; the scopes of section 1; the redirect
   URIs of section 3 (staging's and yeni's); the webhook callback URL of the host it will serve.
2. In the staging panel: cancel the Studio slots still waiting on a TikTok capability (Today →
   Cancel), then retire each TikTok capability (its card → Retire: its token is erased and revoked
   at TikTok).
3. On the host, keep a copy and edit in place, pasting the production app's key and secret from
   the portal (never on a command line):

   ```sh
   sudo cp -p /etc/jeeta-staging/jeeta.env /etc/jeeta-staging/jeeta.env.bak-$(date +%Y%m%d%H%M)
   sudoedit /etc/jeeta-staging/jeeta.env   # JEETA_TIKTOK_CLIENT_KEY, JEETA_TIKTOK_CLIENT_SECRET
   sudo systemctl restart jeeta-staging
   sudo journalctl -u jeeta-staging -n 50 --no-pager | grep 'provider apps'   # providers=...tiktok...
   ```

   An environment change needs only the restart, no release.
4. In the panel: Connect → TikTok, sign in with the TikTok account (the consent page lists the
   five scopes), confirm the account, and probe it (its card → Probe; MCP `jeeta.connector.probe`):
   it reads **Verified**. A sandbox capability retired only after the switch logs that its access
   could not be given back (the production app cannot revoke a sandbox token): remove the sandbox
   app from that TikTok account's settings by hand if wanted.
5. Check the posting: on a TikTok slot's posting screen the privacy list now offers "Everyone".
   Post a test, and Today shows it published, with its link once TikTok's moderation passed it.

Then on production, the same with `/etc/jeeta/jeeta.env` and `jeeta.service`
(`sudo systemctl restart jeeta`, `sudo journalctl -u jeeta ...`).

## 5. Rotating the sandbox secret

The sandbox client secret was exposed once; rotate it after the production key is live on both
hosts: portal → the sandbox app → its credentials → reset the client secret. If a host still runs
with the sandbox app (staging, for tests with target users), put the new secret in its environment
file and restart it as in section 4; otherwise nothing more is needed (the old value is dead).
Check which app a host runs with by its client key, which is not secret:
`sudo awk -F= '/^JEETA_TIKTOK_CLIENT_KEY=/{print $2}' /etc/jeeta-staging/jeeta.env`.

## 6. Limits of an unaudited app

Until TikTok audits the app (the production review), and always for the sandbox app:

- it posts only to **private** accounts: a public account is refused with
  `unaudited_client_can_only_post_to_private_accounts` (HTTP 403), whatever the privacy chosen;
- the posting screen offers only "Only me" (`SELF_ONLY`); Jeeta never picks a privacy itself;
- only the sandbox's target users can sign in to the sandbox app.

To demonstrate posting, make the test account private in TikTok for the session (its privacy
settings, "Private account") and public again afterwards.

## 7. Videos and photos: `FILE_UPLOAD` and `PULL_FROM_URL`

- **Videos go as `FILE_UPLOAD`**: Jeeta reads the file from its file store and uploads it in
  10 MiB chunks to the upload URL TikTok answers with (`open-upload*.tiktokapis.com`). Nothing has
  to be verified at TikTok; it costs the server's upload time (at most 120 seconds per chunk).
- **Photos go as `PULL_FROM_URL`** (TikTok takes photos no other way): TikTok fetches the file
  store's signed URLs itself, so the file store's public host must be verified in the portal (URL
  properties, a domain or a URL prefix); until it is, photo posts fail `url_ownership_unverified`.
- Sending videos as `PULL_FROM_URL` too would spare the server the upload, but it needs the same URL
  verification and a signed URL that stays valid while TikTok downloads (TikTok gives up after an
  hour: `video_pull_failed`). Not changed: a decision for later.

## 8. Tokens and disconnecting

- The access token lives 24 hours. The refresh job (hourly) renews it when it expires within six
  hours. TikTok's refresh token is valid for 365 days after the first sign-in
  (<https://developers.tiktok.com/doc/oauth-user-access-token-management>): a year after the owner
  connected, the refresh is refused and the capability asks to be reconnected.
- A capability whose access was lost (a refused refresh, `authorization.removed`) is reconnected
  from its card (Reconnect; MCP `jeeta.connector.reconnect`) with the same TikTok account.
- Retiring a TikTok capability erases its sealed credential and revokes its token at TikTok
  (`POST /v2/oauth/revoke/`, best effort: a failure is logged as "a retired capability's access
  could not be given back at its provider", and the app then stays in the account's TikTok
  settings until its owner removes it there).

## 9. A failed post

A TikTok post that failed is never sent again by itself (no Studio publication is: a retry could
post twice). Today shows the slot with TikTok's reason in plain words and a Cancel button; cancel
it, fix the cause, and the agent (or the next planning run) plans it again.

## 10. Troubleshooting by error code

A failure reads `kind: tiktok: HTTP <status> <code>: <message>` (the attempt's failure reason,
`studio.publish.failure` in the ledger, a probe's health reason), or `kind: tiktok: publish failed:
<fail_reason>` for a post TikTok gave up on.

| Code | Means | Do |
|---|---|---|
| `invalid_client` ("platform client credentials rejected") | the host's client key or secret is wrong, or not the same app's | fix the environment file (section 2), restart |
| `invalid_grant` | a refresh token spent, expired (after 365 days) or revoked, or a sign-in code reused | reconnect the account |
| `access_token_invalid`, HTTP 401 | the token was revoked or expired | reconnect |
| `scope_not_authorized`, `scope_permission_missed` | the grant lacks a scope (connected before it was asked for) | reconnect: the consent page grants all five |
| `unaudited_client_can_only_post_to_private_accounts` | an unaudited app posting to a public account | section 6 |
| `privacy_level_option_mismatch`, "privacy level X not available" | the privacy chosen is not offered for the account (any longer) | cancel, post again with a privacy the screen offers |
| `spam_risk_too_many_posts`, `reached_active_user_cap`, `spam_risk_too_many_pending_share` | daily caps: the creator's posts through apps, the app's daily posting users, drafts waiting in the inbox | wait a day |
| `spam_risk_user_banned_from_posting` | TikTok bars the account from posting | the account's owner, in TikTok |
| `rate_limit_exceeded`, HTTP 429 | too many calls for the account's token | wait; a failed post is planned again |
| `url_ownership_unverified` | photos from an unverified host | section 7 |
| `file_format_check_failed`, `duration_check_failed`, `frame_rate_check_failed`, `picture_size_check_failed` | TikTok refused the media | fix the file (MP4, the account's longest video, frame rate, picture size) |
| `video_pull_failed`, `photo_pull_failed` | TikTok could not download the media within an hour | check the media URL is public and valid; post again |
| `spam_risk_text`, `spam_risk` | TikTok flagged the caption or the post | change the caption; do not retry as is |
| `auth_removed` | the creator removed the app while the post was processing | reconnect |
| `internal`, `internal_error`, HTTP 5xx | TikTok's side | post again later |
| "the TikTok host is not allowed for the tiktok connector" | TikTok answered an upload URL on a host the egress allowlist does not hold (a new regional upload host) | add the host to `jt_outbound`'s fixed `tiktok` hosts and `jt_tiktok::TIKTOK_HOSTS` (a release) |

Webhooks: `401` answers to TikTok in the access log mean a signature of another app (section 3), a
server clock more than five minutes off (check NTP), or a redelivery still signed with its first,
stale timestamp (TikTok does not document whether it signs retries anew; the poll and the probe
cover what such an event carried). The gate's counters `unrouted_tiktok` and `unparseable_tiktok`
count events dropped because no workspace here holds their account connected (or they name another
app), and signed bodies that are no webhook Jeeta knows.

## 11. Out of scope

- Direct messages and comments: TikTok offers no public API for them to Login Kit apps.
- Ads (`tiktok_ads`): a separate Marketing API app with its own review; spec phase S4.
