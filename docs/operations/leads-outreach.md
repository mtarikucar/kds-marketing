# Leads and outreach (prospect pool, campaigns, unsubscribe)

This runbook is for the operator and the workspace owner of the Rust server. It covers the
prospect pool and outreach email of spec
[`2026-10-30-leads-pool-outreach-design.md`](../superpowers/specs/2026-10-30-leads-pool-outreach-design.md)
(plan L9-T2): turning the platform switch on, the business-recipient basis, the customer's
mail domain, warm-up and auto-pause, the do-not-contact list and the master key, rollbacks,
attachments, and the legal points that must be answered first. Moving v1 leads in is
[`v1-import.md`](v1-import.md).

Nothing here is legal advice, and no mailbox-provider rule is stated here as a fact: what must
be checked against a current source is marked **VERIFY**, what the owner's lawyer must answer is
marked **LAWYER** (spec §12, §13).

## 0. What is on and off by default

| Switch | Default | Who turns it on | Effect while off |
|---|---|---|---|
| `JEETA_OUTREACH_ENABLED` (platform, environment) | off | the operator, only after §1 | no campaign launches or resumes (`403`, `details.reason = "outreach_disabled_on_platform"`), the dispatcher sends nothing, a queued outreach email is refused at claim, and no commercial send on any path rests on the business-recipient basis (spec D24, D53) |
| `b2b_basis` (workspace outreach settings) | `[]` | a person whose role is `owner`, with `legal_ack {counsel_confirmed: true, note}` in the same call (D17, D64) | outreach reaches only people with an effective consent; the audience preview counts the others as `no_basis` |
| `require_iys_lookup` | on | turning it off is the owner's, with `legal_ack` | — |
| Warm-up | on (start 20, step 10, max 150 a day) | `outreach.manage` may turn it off for an established mailbox | — |

The pool, research tasks, scoring, promotion and distribution work with the switch off: only
sending is locked. `make smoke-leads` proves the whole flow with the switch on **inside the test
only**, and the same flow with it off sends nothing; `jt_app/tests/outreach_lock.rs` proves every
send path refuses while locked.

## 1. Before turning `JEETA_OUTREACH_ENABLED` on

All of these, in this order. Write down the date and who confirmed each.

1. **The lawyer has answered spec §15 Q1** (points L-01 and L-03 of §12): whether commercial email
   to tradespeople and companies (esnaf/tacir) is allowed without prior consent under the 6563
   law's regulation, and whether İYS must be checked for them. Until then the switch stays off on
   production. The answer is the owner's to record; this runbook does not interpret it.
2. **The public links are live.** `JEETA_PUBLIC_BASE_URL` is set to the panel's `https` address
   (README "Environment"); `GET` and `POST /u/{workspace_id}/{token}/{mac}` (unsubscribe) and
   `GET /c/{workspace_id}/{token}/{link}/{mac}` (clicks) answer through the proxy. Without an
   `https` base URL every commercial email is refused (`CONFLICT`: no unsubscribe link can be
   given, D62).
3. **Staging first.** On staging, with the switch on there only, run one campaign to a mailbox you
   control (a synthetic business, an address you own): check the footer, the `List-Unsubscribe`
   and `List-Unsubscribe-Post` headers in the received message's source, that a reply stops the
   sequence, and that the one-click unsubscribe writes the suppression. `make smoke-leads` is the
   in-process version of the same check and must be green on the commit you deploy.
4. **Each workspace that will send** has its sender identity (company title, postal address,
   privacy notice URL) in the outreach settings; without them every commercial email is refused
   (`sender_identity_missing`). The owner's own workspace needs spec §15 Q3 answered.
5. **The customer's domain** passes the checklist of §3.

Then set `JEETA_OUTREACH_ENABLED=1` in the server's environment and restart. The start log says
`outreach email: campaigns launch and send only while JEETA_OUTREACH_ENABLED is on
outreach_enabled=true`. Any value other than `1`/`true`/`0`/`false`/empty stops the start.

**Turning it off** is always safe and immediate after a restart: running campaigns stay
`running` and their enrollments wait (nothing is lost); queued outreach emails are refused at
claim. Turn it back on to let them continue.

## 2. The business-recipient basis and `legal_ack`

Only after the lawyer's answer (§1.1), and per workspace:

- The owner opens it with `jeeta.outreach.settings_set` (or the panel's outreach settings):
  `{"b2b_basis": ["email"], "legal_ack": {"counsel_confirmed": true, "note": "<who answered, when>"}}`.
  The note is stored but never written to the ledger (`outreach.b2b_basis_set` names channels and
  flags only). Only email counts as a business channel, whatever else is stored (D53).
- It applies to people whose `recipient_kind` is `business` (a promoted prospect is one) without a
  withdrawal, a suppression or an İYS refusal (`RET`). With `require_iys_lookup` on, the dispatcher
  looks each address up in İYS (at most once in 30 days per address) before the first send.
- Anyone with `outreach.manage` may **close** it at once (`"b2b_basis": []`, or the lookup back
  on); no `legal_ack` is needed to narrow.
- Every email on this basis carries the public-data source line in its footer (D58).

## 3. The customer's domain: SPF, DKIM, DMARC

Jeeta sends through the customer's own mailbox over SMTP (their provider, their domain); it never
signs mail itself. So the sending domain's records are the customer's to set, and the panel warns
before a launch (V-E1). Before a workspace's first campaign, with the customer:

| Check | What to confirm | Status |
|---|---|---|
| SPF | the domain publishes an SPF record that authorises the mail provider's servers (RFC 7208) | check the published record |
| DKIM | the provider signs submitted mail for the domain (RFC 6376), with the domain's own selector | **VERIFY** per provider (V-E2): how Google Workspace, Microsoft 365 and cPanel hosts sign submitted mail |
| DKIM covers the unsubscribe headers | RFC 8058 asks for a DKIM signature covering `List-Unsubscribe` and `List-Unsubscribe-Post`; Jeeta writes both, the provider's signer decides what it covers | **VERIFY** (V-E2) on a received message's `DKIM-Signature: h=` list |
| DMARC | the domain publishes a DMARC policy (RFC 7489) and SPF or DKIM aligns with the `From` domain | check the published record |
| Receiver requirements | the current sender requirements of large receivers (authentication, one-click unsubscribe, complaint-rate limits) at the volumes of D15 | **VERIFY** (V-E1) against the receivers' current published guidance; record the source and date |

How to check without guessing: send one staging test email (`jeeta.outreach.test_send`, itself
locked while the switch is off) to a mailbox you control and read the received message's
`Authentication-Results` and `DKIM-Signature` headers. Write down what they showed and the date.

## 4. Warm-up and auto-pause

- **Warm-up** (D15, spec §3.11): a mailbox's outreach cap for its local day is
  `min(start + step × day_index, max)` with `day_index` the number of earlier days it sent
  outreach, reset after 30 days without outreach. Defaults 20 / 10 / 150; the daily ceiling is
  also bounded by the capability's `daily_ops_cap` and 500. Change it with
  `jeeta.outreach.settings_set {"warmup": {...}}`; turn it off only for a mailbox with an
  established sending history. These are product defaults, not provider numbers.
- **Auto-pause**: after each dispatcher run a campaign pauses itself when its last 50 sends hold
  more than 5 % hard bounces (`pause_reason = bounce_rate`) or its last 200 hold 2 complaints
  (`complaints`); a mailbox that is no longer live pauses it too (`mailbox_down`), and a new
  approved strategy without the campaign's segment pauses it (`strategy_changed`). Each shows as
  the work item `campaign_blocked`.
- **Handling one**: read the campaign (`jeeta.outreach.campaigns_get`) and its report
  (`jeeta.outreach.report`, by step); for bounces, check the list's source (the prospects'
  evidence) and the bounced addresses (marked undeliverable on the prospect); for complaints,
  review the template and the audience with the owner. Resume only after the cause is fixed
  (`jeeta.outreach.campaigns_control {"action": "resume"}`; with approval on, a resume after an
  edit needs approval again). Never raise warm-up or the throttles to "catch up".

## 5. The do-not-contact list and the master key (spec D36)

The blocklist holds **keyed hashes** of phone numbers, email addresses and Instagram/TikTok
handles (do-not-contact, erasure, rejection memory), never the values. The key is derived per
workspace from the platform master key (`JEETA_SECRET_KEY`, through `SecretBox::hmac_key` with
purpose `prospects.blocklist`). A hash cannot be computed again without its value, and the value
is gone. So:

- **Never rotate the master key (or change the blocklist's key derivation) without a plan for the
  blocklist.** A new key orphans every entry hashed under the old one: every objection is
  silently lifted, and a person who said "do not contact me" can be researched and emailed again.
- Each entry records its key's **fingerprint** (16 hex digits). Before any key change, count the
  entries per fingerprint, per workspace, as the platform role (read only):

  ```sql
  select workspace_id, key_fingerprint, reason, count(*)
  from prospect_blocklist group by 1, 2, 3 order by 1, 2, 3;
  ```

  (`BlocklistRepo::key_fingerprints` answers the same per workspace.) Write the counts down
  (counts only, never hashes in a ticket).
- Keep the old key available (sealed, per the custody rules of
  [`backup-restore.md`](backup-restore.md)) until the owner decides what to do with the orphaned
  `do_not_contact` and `erased` entries. After a change, entries under the new fingerprint are
  live; entries under the old one no longer match anything.
- The backups protect the key already (spec §14): a restore with the wrong key has the same
  effect as a rotation. The restore drill must use the original key.

## 6. Rollbacks: export the blocklist first

`0020_prospects.down.sql` **refuses** while the blocklist holds `do_not_contact` or `erased`
entries: a business's objection must outlive a rollback (D9, D27). If a rollback of 0020 is
really needed:

1. Stop the server (no writes in between).
2. Export the objections, as the platform role, to a protected file outside the repository
   (it holds keyed hashes, which are personal data under the same rules as the backups):

   ```sql
   \copy (select workspace_id, kind, key_hash, reason, created_at, key_fingerprint
          from prospect_blocklist where reason in ('do_not_contact', 'erased'))
         to 'prospect_blocklist_objections.csv' with (format csv, header)
   ```

   Record the row count only.
3. Delete those rows by hand, run the down migration, and keep the export until the owner has
   decided how the objections are carried into whatever replaces the pool (they must be loaded
   back before any prospecting resumes).

`0026_outreach.down.sql` refuses nothing (an unsubscribe is the inbox's suppression and withdrawn
consent, which stay). `0028_mail_files.down.sql` refuses while a queued or held outbox email
names mail files (send or refuse those first); the stored files are then left to the file
store's daily sweep. Every down migration is a no-op when already reverted.

## 7. Attachments

- Inbound mail attachments are stored as downloads only and kept `attachments.retention_days`
  (default **180**, D26), then purged daily by `mail_files_purge` (their metadata rows stay,
  marked deleted). Uploads staged for a reply and never sent go after 7 days. No tool changes the
  retention in this release: it is the leads policy's default (L-09 asks the lawyer to confirm it).
- A person's erasure deletes the files of their messages.
- Files are never scanned for malware in this release (spec §14): they are served as
  `application/octet-stream` with `Content-Disposition: attachment` and a `sandbox` CSP; say so to
  the customer.

## 8. The legal checklist (spec §12)

Each item blocks what is named until the owner's lawyer answers (**LAWYER**). Record the answer's
date and who gave it; do not paraphrase it into this file.

| Id | Question (short) | Blocks |
|---|---|---|
| L-01 | Commercial email to esnaf/tacir without prior consent under the 6563 law's regulation, and on what conditions | `b2b_basis`, and turning `JEETA_OUTREACH_ENABLED` on for cold email |
| L-02 | Which pool data is personal data; whether "business only, published by the business" suffices for minimisation | pool launch |
| L-03 | İYS lookup for business recipients; whether a `RET` binds email to a business address | `require_iys_lookup` default |
| L-04 | Lawful basis for collecting public business contact data (KVKK art. 5(2)(f)?) and the balancing record | pool launch |
| L-05 | Retention periods (30 / 180 / 365 days) | defaults (D26) |
| L-06 | Keeping hashed keys after erasure or objection to honour do-not-contact | blocklist design |
| L-07 | Footer: sender identity fields, data-source line, information notice at first contact, opt-out wording | launch |
| L-08 | Click-tracking disclosure in the privacy notice | `click_tracking` |
| L-09 | Inbound attachment retention (180 days) and special-category data in attachments | attachments |
| L-10 | Controller/processor roles between the workspace and Jeeta for pool data; the DPA | product terms |

## 9. Moving v1 leads

See [`v1-import.md`](v1-import.md): format 2 splits v1 leads between the inbox and the pool,
puts v1 opt-outs on the do-not-contact list as keyed hashes (so §5 applies to them from the
first import), and has its own dry run and rollback.
