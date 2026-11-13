# Cutover record: jeetagrowth.com to the Rust system (2026-11-12)

This is the public record of the switch described in [v1-cutover.md](v1-cutover.md). It names what
was done, in what order, and what is still open. Provider IDs, account bindings, addresses of
hosts, recovery material and anything secret stay in the operator's private change record, as that
procedure requires; none of it is on this page.

## What was done

All times are 2026-11-12, Europe/Istanbul.

| Step | Result |
|---|---|
| Recovery set of v1 | Full database dump of v1 and the leads-only exports of both real workspaces, taken before anything was stopped. |
| Production release | The release proven on staging was installed on production after a rehearsal on a restored copy of the production database (jobs off, network blocked, row counts compared). |
| Public address | `jeetagrowth.com` now serves the Rust panel with its own certificate. `www`, `marketing.hummytummy.com` and `yeni.jeetagrowth.com` redirect to it. |
| The former address | `yeni.jeetagrowth.com` still answers `/mcp`, `/api/`, `/hooks/`, `/oauth/callback/`, `/files/`, `/u/` and `/c/`, so provider callbacks, agent connections and links in mail already sent keep working. Its requests are logged so that what still uses it can be seen before it is removed. |
| v1 | The v1 API and panel were stopped and are not restarted. The v1 database is kept read-only for at least 90 days (until 2027-02-10). |
| Leads | The leads-only import of the 2026-10-26 owner amendment ran for one workspace: 643 leads, after a clean dry run. The other workspace's export (571 leads) waits for that workspace to be registered on the new system. |
| Legal pages | `/privacy`, `/terms` and `/data-deletion` are served as static pages on production and staging. |
| Provider apps | The redirect addresses of the new host were added to the Meta, X, TikTok and LinkedIn apps. |
| Marketplace removal | The marketplace module (Trendyol, Hepsiburada) was removed (#401, migration 0043). Staging, then production, were upgraded to that release, each after a recovery set and a rehearsal; on production the row counts of all 103 tables were unchanged. |

## Where the record differs from the written procedure

- **The operator worked on the host directly.** The procedure dispatches the switch from CI. The
  owner decided on the day that the operator connects to the host; a one-time workflow added the
  operator's key and was removed afterwards (see below).
- **The provider apps were kept.** The procedure expects new provider apps with their own review.
  The existing apps were kept and their redirect addresses extended, so permissions already
  granted stayed valid. Accounts are reconnected on the new host as each workspace moves.
- **Meta's webhooks point at staging.** While the Meta app is in App Review the reviewers use
  staging, so the app's callback address is staging's. A WhatsApp account connected on production
  receives its messages through its own override; `account_update` follows the app's address.

## One-time workflows

Two workflows existed only on the branch `ops/cutover-jeetagrowth`: one that added the operator's
SSH key to the host, and a read-only inventory that never completed. Both were deleted from that
branch after the switch. Nothing on the default branch refers to them.

## Open after the switch

- Reconnect each workspace's provider accounts on `jeetagrowth.com`.
- Register the second workspace and run its leads-only import.
- Move the Meta app's callback address to production once App Review ends.
- Update the callback addresses in the NetGSM panel, then remove `yeni.jeetagrowth.com`.
- Decide what happens to the test workspaces on production.
- Close the v1 archive after its retention period.
