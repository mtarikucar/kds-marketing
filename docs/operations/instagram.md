# Instagram

Jeeta reaches a workspace's Instagram professional account in one of two ways: through the
Facebook Page it is linked to (Facebook Login, the Meta app), or on its own (Instagram Login, the
Meta app's Instagram product with its own app id and secret). The adapter is
`rust/crates/adapters/jt_meta`; its crate and module docs hold the calls and the error mapping.

This page is for the operator: what the Instagram Login product must offer in Meta's app dashboard,
the environment, and what an existing account must do after a permission is added. No key or
secret belongs on this page, in Git or in a chat: they live in the hosts' environment files only.

## 1. Environment

| Variable | What |
|---|---|
| `JEETA_INSTAGRAM_APP_ID`, `JEETA_INSTAGRAM_APP_SECRET` | the Instagram Login product's app id and secret (both or neither) |
| `JEETA_INSTAGRAM_COMMENT_SCOPES` | `1` to ask for the comment permissions too (off by default; turn on only after Meta's App Review approved them, spec 2026-10-30-inbox-comments-marketplace-design.md §11) |
| `JEETA_INSTAGRAM_MESSAGE_SCOPES` | `1` to ask for `instagram_business_manage_messages` too, so an Instagram Login account's direct messages connect without a Facebook Page (off by default; turn on only once the Instagram product offers the permission, §4: Instagram refuses a whole sign-in that asks for one it does not) |

## 2. The permissions Instagram Login asks for

At every sign-in Jeeta asks Instagram Login for (`jt_meta::INSTAGRAM_SCOPES`):

| Permission | Why |
|---|---|
| `instagram_business_basic` | the account itself |
| `instagram_business_content_publish` | Studio publishes the account's posts |
| `instagram_business_manage_insights` | Studio reads the account's and its posts' counters (spec D29, from 2026-11-04) |

and, while `JEETA_INSTAGRAM_COMMENT_SCOPES` is on, `instagram_business_manage_comments` and
`instagram_business_manage_messages` (comments and private replies); while
`JEETA_INSTAGRAM_MESSAGE_SCOPES` is on, `instagram_business_manage_messages` (direct messages, §4;
asked for once when both flags are on).

**In Meta's app dashboard**, the Instagram product's Instagram Login settings must offer every
permission above, `instagram_business_manage_insights` included. After enabling it, check with one
sign-in on staging that Instagram's consent page lists it.

**Advanced Access: unverified.** Whether `instagram_business_manage_insights` needs Advanced Access
(and so App Review) before accounts that are not the app's testers can grant it has not been
checked. Until it is, try one sign-in with a non-tester account on staging after enabling it, and
record the result here (no account names or ids).

## 3. Accounts connected before the insights permission

An account connected through Instagram Login before 2026-11-04 holds a grant without
`instagram_business_manage_insights`. It still publishes, but Studio cannot measure it. Jeeta says
so rather than calling it unsupported:

- its probe reports `insights: false`;
- its capability card says to reconnect (`connector.health` gives it `measure: reconnect`);
- the Studio overview's organic lane gives the reason `connector_reconnect_required` when that is
  all its accounts lack.

The fix is the owner's: **Kabiliyetler → the account's card → Yeniden bağla**, accepting the new permission
on Instagram's consent page. Nothing else changes for the account.

## 4. Direct messages through Instagram Login

An account connected through Instagram Login has no Facebook Page, so its direct messages
(`instagram_dm`) cannot come through Facebook Login. With `JEETA_INSTAGRAM_MESSAGE_SCOPES` on:

- Instagram Login asks for `instagram_business_manage_messages` (`jt_meta::INSTAGRAM_MESSAGE_SCOPES`);
  off, its request is byte for byte what it was before.
- "Instagram mesajları" signs in through Instagram Login when the workspace's Instagram account
  was connected that way (or there is no Meta app); otherwise through Facebook Login, as before
  (`connector::start_oauth`). A grant holding the permission lists the account as `instagram` and
  `instagram_dm` together, and confirming it renews the account's existing `instagram` capability
  in place (same capability: its posts and history stay) and creates its `instagram_dm`.
- Each connection step subscribes the account (`POST graph.instagram.com/{ig-id}/subscribed_apps`)
  to `messages,messaging_postbacks`, beside `comments,live_comments` when comments are granted, and
  then `message_echoes` too (Meta's fields reference lists the echoes under the comment
  permission). A refused subscription is asked once more with the fields of before the extras.
- A message Meta delivers to `/hooks/meta` (signed with the Instagram app's secret) is routed by
  the entry's account to `instagram_dm`; a reply goes out as `POST graph.instagram.com/{ig-id}/messages`
  with the account's token (at most 1000 bytes), and only within 24 hours of the person's last
  message (Instagram's standard messaging window; the inbox refuses later replies).

**In Meta's app dashboard**, before turning the flag on:

1. Instagram product → API setup with Instagram business login: add
   `instagram_business_manage_messages` to the permissions it offers.
2. Instagram product → webhooks (Instagram Login): the callback URL is the Meta webhook
   (`{JEETA_PUBLIC_BASE_URL}/hooks/meta`, `connector.hooks` shows it) with the Meta app's verify
   token (`JEETA_META_VERIFY_TOKEN`); subscribe the app to `messages` and `messaging_postbacks`
   (and `message_echoes` when comments are on). An account receives only the fields the app is
   subscribed to.
3. The app must be Live to receive webhooks for its users. For accounts that do not have a role on
   the app, `instagram_business_manage_messages` needs Advanced Access, which App Review grants;
   until then only accounts with a role on the app (and on the Instagram account) can grant it.

Then turn the flag on, deploy, and check with one sign-in on staging that Instagram's consent page
lists the messages permission. The owner then reconnects: **Kabiliyetler → the Instagram account's
card → Yeniden bağla** (or **Bağla → Meta → Instagram mesajları**), accepts the permission, and on
the panel's return page connects the account (shown as Instagram + Instagram mesajları).

**Unverified:** whether the Instagram account must also allow access to its messages in its own
app settings (Messages → Connected tools) under Instagram Login, as Facebook Login's messaging
needs; check it on the first account if no message arrives.
