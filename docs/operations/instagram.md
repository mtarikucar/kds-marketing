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

## 2. The permissions Instagram Login asks for

At every sign-in Jeeta asks Instagram Login for (`jt_meta::INSTAGRAM_SCOPES`):

| Permission | Why |
|---|---|
| `instagram_business_basic` | the account itself |
| `instagram_business_content_publish` | Studio publishes the account's posts |
| `instagram_business_manage_insights` | Studio reads the account's and its posts' counters (spec D29, from 2026-11-04) |

and, while `JEETA_INSTAGRAM_COMMENT_SCOPES` is on, `instagram_business_manage_comments` and
`instagram_business_manage_messages` (comments and private replies).

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
