# Social OAuth connect — operator setup

The one-click "Connect" buttons in the Social Planner (Facebook, Instagram,
LinkedIn, TikTok) are **built and deployed**, but stay **inert** until each
provider's app credentials are present in the prod env. This is the only
remaining work, and it can only be done by the account owner — it requires
logging into each provider's developer console with the business's own account.

Once a network's two secrets are set (steps below), its Connect button appears
automatically; users then click → approve → pick page(s)/account(s) → done.

## The exact values you'll need

**Redirect URI** (register this verbatim in each provider app — replace nothing,
this is the live value):

| Network   | Redirect URI |
|-----------|--------------|
| Facebook  | `https://marketing.hummytummy.com/api/marketing/social/oauth/facebook/callback` |
| Instagram | `https://marketing.hummytummy.com/api/marketing/social/oauth/instagram/callback` |
| LinkedIn  | `https://marketing.hummytummy.com/api/marketing/social/oauth/linkedin/callback` |
| TikTok    | `https://marketing.hummytummy.com/api/marketing/social/oauth/tiktok/callback` |

**GitHub repo secrets** (Settings → Secrets and variables → Actions). The deploy
workflow renders these into prod env on the next tag; nothing else to touch:

| Secret name | From |
|-------------|------|
| `META_APP_ID` / `META_APP_SECRET` | Meta app (covers BOTH Facebook + Instagram) |
| `LINKEDIN_CLIENT_ID` / `LINKEDIN_CLIENT_SECRET` | LinkedIn app |
| `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` | TikTok app |

(`APP_URL`, `PUBLIC_BASE_URL`, `FRONTEND_URL` are already set by the deploy.)

## Per-provider steps

### Meta (Facebook + Instagram) — one app covers both
1. https://developers.facebook.com → **My Apps → Create App** → type **Business**.
2. Add products: **Facebook Login** and (for IG) link an **Instagram** business/creator account to a Facebook Page.
3. Facebook Login → Settings → **Valid OAuth Redirect URIs**: add the Facebook + Instagram URIs above.
4. App settings → Basic: copy **App ID** → `META_APP_ID`, **App Secret** → `META_APP_SECRET`.
5. Request scopes `pages_show_list`, `pages_manage_posts`, `pages_read_engagement`, `instagram_basic`, `instagram_content_publish` via **App Review + Business Verification**. (Until approved, add your own accounts as **app testers** — works immediately for them.)

### LinkedIn (personal profile + company pages)
1. https://www.linkedin.com/developers/apps → **Create app** (attach a Company Page).
2. Auth tab → **Redirect URLs**: add the LinkedIn URI above. Copy **Client ID** → `LINKEDIN_CLIENT_ID`, **Client Secret** → `LINKEDIN_CLIENT_SECRET`.
3. Products: request **Share on LinkedIn** (`w_member_social`) and **Advertising/Community Management** for org posting (`w_organization_social`, `r_organization_admin`) — the latter needs **Marketing Developer Platform** approval.

### TikTok
1. https://developers.tiktok.com → **Manage apps → Connect an app**.
2. Add **Login Kit** + **Content Posting API**. Redirect URI: the TikTok URI above. Verify the domain `marketing.hummytummy.com` if prompted.
3. Copy **Client Key** → `TIKTOK_CLIENT_KEY`, **Client Secret** → `TIKTOK_CLIENT_SECRET`.
4. Request scopes `user.info.basic`, `video.publish` — Content Posting needs an **audit**; until then it posts only to the developer's own account.

## Activate

After setting a network's two GitHub secrets, push any `v*.*.*` tag (or re-run
the latest deploy) so the env re-renders. The Connect button(s) for the
configured network(s) then appear in **Social Planner → Accounts**.

## Verify (per network)

Connect → approve on the provider → the account-select dialog lists your
page(s)/account(s) → pick one → it shows in **Accounts** → compose a post,
target it, **Publish now** → it appears on the page with the business identity.

> Reminder: until each provider's review/audit clears, OAuth works only for
> accounts you added as app testers (your own). That review is a parallel,
> provider-side process — nothing in this app gates it.
