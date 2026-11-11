# v1 lead export and import (format 2: inbox and pool)

This runbook moves the leads of one v1 workspace into one Rust workspace, splitting them
between the inbox and the prospect pool (spec
[`2026-10-30-leads-pool-outreach-design.md`](../superpowers/specs/2026-10-30-leads-pool-outreach-design.md)
§10, D23; plan L7). It extends the leads-only amendment of [`v1-cutover.md`](v1-cutover.md):
every rule there (read-only export account, protected files, exact binary and schema, counts-only
output, rollback before people change the leads, shredding) still holds. Format 2 adds the
contact evidence that decides the route, v1's activities and offers (as notes), tags,
attribution, the research candidate, v1's score and the lead's v1 owner.

**Nothing in this runbook runs from the repository's CI or from a developer machine.** The
coordinator runs it after the cutover, on the servers, with the owner. The export file holds
personal data: it never enters the repository, a ticket, a chat, a log or a backup, and only
counts are ever written down.

## 0. What goes where

| Lead (in this order) | Route | Count |
|---|---|---|
| `deletedAt` set | skipped | `skipped_deleted` |
| `mergedIntoId` set | skipped | `skipped_merged` |
| a format-1 line (no `format` field) | inbox, as before | `to_inbox` |
| status other than `NEW` | inbox | `to_inbox` |
| any contact evidence (`contact.*` > 0, a `lastContactAt`), or no `contact` object | inbox | `to_inbox` |
| source `INSTAGRAM`, `WEBSITE`, `PHONE`, `EMAIL`, `ADS`, `REFERRAL`, `HARDWARE_QUOTE`, `FIELD_VISIT` | inbox | `to_inbox` |
| otherwise (`AI_RESEARCH`, `IMPORT`, `OTHER`, never contacted) | pool | `to_pool` |

Inbox leads are imported before pool leads. A pool lead then imports nothing when one of its
phones or emails is erased (`erased_skipped`), when v1 recorded an opt-out (its keys go on the
do-not-contact list as keyed hashes: `pool_dnc`), when a hard key is on the blocklist already
(`pool_blocked`), when a phone or email is an inbox identity (`pool_in_inbox`), when another
prospect holds a hard key (`pool_duplicates`) or when the pool cannot hold it (`pool_invalid`).
Otherwise it becomes one prospect (`pooled`), status `new`, recorded by the importer
(`Recorder::Import { system: "v1", record: <lead id> }`), with v1's score as a `v1-legacy`
score row. Its retention starts at the import (spec §10, owner question Q4).

## 1. The export query (format 2)

The query is spec Appendix B with every column checked against
`backend/prisma/schema.prisma` on 2026-11-11. Prisma maps the models to tables (`@@map`) but
no field to another column name, so each column is the field name, quoted. The query also
leaves out deleted and merged leads (data minimisation: the importer would only skip them), the
attribution's query strings other than `utm_*` (it exports a landing **path** and a referrer
**host** only), and adds the offers and the last contact time Appendix B left out.

Save it on the v1 host as `/root/v1-export-leads-v2.sql` (root-only, `chmod 600`); it is not
in the repository because it changes with v1's schema and must be re-checked at each export.

```sql
-- Read-only export, format 2. One JSON object per line. Personal data stays on the hosts.
\set ON_ERROR_STOP on
\set QUIET on
\pset format unaligned
\pset tuples_only on
\pset pager off
SELECT json_build_object(
  'format', 2, 'id', l.id, 'businessName', l."businessName", 'contactPerson', l."contactPerson",
  'phone', l.phone, 'whatsapp', l.whatsapp, 'email', l.email, 'address', l.address,
  'city', l.city, 'region', l.region, 'businessType', l."businessType",
  'tableCount', l."tableCount", 'branchCount', l."branchCount",
  'currentSystem', l."currentSystem", 'source', l.source, 'status', l.status,
  'lostReason', l."lostReason", 'notes', l.notes, 'nextFollowUp', l."nextFollowUp",
  'priority', l.priority, 'customFields', l."customFields",
  'emailOptOut', l."emailOptOut", 'smsOptOut', l."smsOptOut", 'waOptOut', l."waOptOut",
  'emailBouncedAt', l."emailBouncedAt", 'createdAt', l."createdAt", 'updatedAt', l."updatedAt",
  'deletedAt', l."deletedAt", 'mergedIntoId', l."mergedIntoId",
  'aiScore', l."aiScore", 'aiScoreReason', l."aiScoreReason", 'scoredAt', l."scoredAt",
  'emailVerifiedStatus', l."emailVerifiedStatus",
  'ownerEmail', (SELECT u.email FROM marketing_users u WHERE u.id = l."assignedToId"),
  'contact', json_build_object(
    'conversationsOutbound', (SELECT count(*) FROM messages m
        JOIN conversations c ON c.id = m."conversationId"
        WHERE c."leadId" = l.id AND m.direction = 'OUTBOUND'),
    'conversationsInbound', (SELECT count(*) FROM messages m
        JOIN conversations c ON c.id = m."conversationId"
        WHERE c."leadId" = l.id AND m.direction = 'INBOUND'),
    'campaignSent', (SELECT count(*) FROM campaign_recipients r
        WHERE r."leadId" = l.id AND r.status = 'SENT'),
    'mailSent', (SELECT count(*) FROM mail_log g WHERE g."leadId" = l.id AND g.status = 'SENT'),
    'activitiesOutbound', (SELECT count(*) FROM lead_activities a WHERE a."leadId" = l.id
        AND a.type IN ('CALL', 'VISIT', 'EMAIL', 'WHATSAPP', 'DEMO', 'MEETING')),
    'offers', (SELECT count(*) FROM lead_offers o WHERE o."leadId" = l.id AND o.status <> 'DRAFT'),
    'lastContactAt', (SELECT max(m."createdAt") FROM messages m
        JOIN conversations c ON c.id = m."conversationId" WHERE c."leadId" = l.id)),
  'activities', (SELECT coalesce(json_agg(json_build_object('id', a.id, 'type', a.type,
        'title', a.title, 'description', a.description, 'outcome', a.outcome,
        'createdAt', a."createdAt") ORDER BY a."createdAt", a.id), '[]')
      FROM lead_activities a WHERE a."leadId" = l.id),
  'offers', (SELECT coalesce(json_agg(json_build_object('id', o.id, 'status', o.status,
        'planName', o."planName", 'price', coalesce(o."customPrice", o."planMonthlyPrice"),
        'currency', o."planCurrency", 'validUntil', o."validUntil", 'createdAt', o."createdAt")
        ORDER BY o."createdAt", o.id), '[]')
      FROM lead_offers o WHERE o."leadId" = l.id AND o.status <> 'DRAFT'),
  'tags', (SELECT coalesce(json_agg(t.name ORDER BY t.name), '[]')
      FROM lead_tags lt JOIN tags t ON t.id = lt."tagId" WHERE lt."leadId" = l.id),
  'attribution', (SELECT json_build_object('utmSource', la."utmSource",
        'utmMedium', la."utmMedium", 'utmCampaign', la."utmCampaign",
        'utmContent', la."utmContent", 'utmTerm', la."utmTerm",
        'landingPath', split_part(regexp_replace(la."landingUrl", '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]*', ''), '?', 1),
        'referrerHost', substring(la."referrerUrl" FROM '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#:]+)'))
      FROM lead_attributions la WHERE la."leadId" = l.id),
  'research', (SELECT json_build_object('evidence', rc.evidence, 'painPoint', rc."painPoint",
        'pitch', rc.pitch, 'stage', rc.stage, 'website', rc.website,
        'instagram', rc.instagram, 'score', rc.score, 'createdAt', rc."createdAt")
      FROM research_candidates rc WHERE rc."leadId" = l.id
      ORDER BY rc."createdAt" DESC LIMIT 1)
)::text
FROM leads l
WHERE l."workspaceId" = :'v1_workspace_id'
  AND l."deletedAt" IS NULL AND l."mergedIntoId" IS NULL
ORDER BY l."createdAt", l.id;
```

Notes on the query:

- `messages`, `conversations`, `campaign_recipients`, `mail_log` and `lead_offers` carry a
  `workspaceId` too; the joins through `leadId` stay within the lead's workspace.
- `ownerEmail` is `marketing_users.email`. The importer maps it, lower-cased, to an **active**
  member of the Rust workspace with that email; there is no other matching.
- `lastContactAt` is the latest conversation message either way. A lead with any contact goes to
  the inbox whatever the other counts say.
- v1 research candidates still `PENDING` (not leads) are not exported (spec §10, Q4).

### 1.1 Column check (before every export)

The importer refuses unknown fields, so a renamed v1 column fails loudly at the dry run; check
first anyway. On the v1 host, with the read-only account, this prints **names only** and must
print `0`:

```sql
SELECT count(*) FROM (VALUES
  ('leads','id'),('leads','workspaceId'),('leads','businessName'),('leads','contactPerson'),
  ('leads','phone'),('leads','whatsapp'),('leads','email'),('leads','address'),('leads','city'),
  ('leads','region'),('leads','businessType'),('leads','tableCount'),('leads','branchCount'),
  ('leads','currentSystem'),('leads','source'),('leads','status'),('leads','lostReason'),
  ('leads','notes'),('leads','nextFollowUp'),('leads','priority'),('leads','customFields'),
  ('leads','emailOptOut'),('leads','smsOptOut'),('leads','waOptOut'),('leads','emailBouncedAt'),
  ('leads','createdAt'),('leads','updatedAt'),('leads','deletedAt'),('leads','mergedIntoId'),
  ('leads','aiScore'),('leads','aiScoreReason'),('leads','scoredAt'),
  ('leads','emailVerifiedStatus'),('leads','assignedToId'),
  ('marketing_users','id'),('marketing_users','email'),
  ('messages','conversationId'),('messages','direction'),('messages','createdAt'),
  ('conversations','id'),('conversations','leadId'),
  ('campaign_recipients','leadId'),('campaign_recipients','status'),
  ('mail_log','leadId'),('mail_log','status'),
  ('lead_activities','id'),('lead_activities','leadId'),('lead_activities','type'),
  ('lead_activities','title'),('lead_activities','description'),('lead_activities','outcome'),
  ('lead_activities','createdAt'),
  ('lead_offers','id'),('lead_offers','leadId'),('lead_offers','status'),
  ('lead_offers','planName'),('lead_offers','customPrice'),('lead_offers','planMonthlyPrice'),
  ('lead_offers','planCurrency'),('lead_offers','validUntil'),('lead_offers','createdAt'),
  ('lead_tags','leadId'),('lead_tags','tagId'),('tags','id'),('tags','name'),
  ('lead_attributions','leadId'),('lead_attributions','utmSource'),
  ('lead_attributions','utmMedium'),('lead_attributions','utmCampaign'),
  ('lead_attributions','utmContent'),('lead_attributions','utmTerm'),
  ('lead_attributions','landingUrl'),('lead_attributions','referrerUrl'),
  ('research_candidates','leadId'),('research_candidates','evidence'),
  ('research_candidates','painPoint'),('research_candidates','pitch'),
  ('research_candidates','stage'),('research_candidates','website'),
  ('research_candidates','instagram'),('research_candidates','score'),
  ('research_candidates','createdAt')
) AS want(t, c)
WHERE NOT EXISTS (SELECT 1 FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = want.t AND column_name = want.c);
```

If it prints more than `0`, list the missing pairs (replace `count(*)` by `want.t, want.c`),
correct the query against `schema.prisma` and repeat; never guess a column.

### 1.2 Counts for the owner (before the export)

Also counts only, on the v1 host:

```sql
SELECT count(*) AS leads,
       count(*) FILTER (WHERE "deletedAt" IS NOT NULL) AS deleted,
       count(*) FILTER (WHERE "mergedIntoId" IS NOT NULL) AS merged,
       count(*) FILTER (WHERE status = 'NEW') AS new_status
FROM leads WHERE "workspaceId" = :'v1_workspace_id';
```

Production had 1,143 leads when the spec was written; the owner compares this number with the
dry run's `total + deleted + merged` (deleted and merged leads are not exported).

## 2. File handling

On the v1 host, as root, with the read-only database account from a protected service file
(never a password on the command line):

```sh
umask 077
psql -X -q -d service=jeeta_v1_readonly \
  -v v1_workspace_id=<v1 workspace id> \
  -f /root/v1-export-leads-v2.sql > /root/v1-leads-v2.jsonl
chmod 600 /root/v1-leads-v2.jsonl
wc -l < /root/v1-leads-v2.jsonl        # a count: the only thing written down
sha256sum /root/v1-leads-v2.jsonl      # recorded with the counts, to reuse the same file
```

- Never `cat`, `head`, `less` or `grep` the file; never paste a line anywhere. The importer
  reports problems as fixed categories (`input_invalid`, `input_refused`), never a value.
- Transfer it to the Rust host over SSH (`scp -p`) into `/root/`, mode 0600, and check the
  `sha256sum` there. No other copy: no laptop, no shared drive, no backup set.
- Keep the same file for the dry run, the import, a rollback and the spot checks.

## 3. Dry run (staging copy first, then production)

The dry run executes every write in 100-lead transactions and rolls each back: nothing is
written, not even the ledger entry. It prints one JSON line of counts.

1. **Staging.** On a staging Rust installation with a workspace that mirrors the target's
   members (same emails, so `owners_mapped` is meaningful):

   ```sh
   set -a; . /etc/jeeta/jeeta.env; set +a      # the staging installation's environment
   /opt/jeeta/jeeta import-v1-leads --workspace <staging workspace id> \
     --input /root/v1-leads-v2.jsonl --dry-run
   ```

2. **Production**, the same command with the production environment and workspace id, still
   `--dry-run`.

The report's fields: `total`, `to_inbox`, `to_pool`, `skipped_deleted`, `skipped_merged`,
`imported` (inbox people), `already_present`, `duplicates_merged`, `identities_invalid`,
`identities_conflicting`, `erased_skipped`, `opt_outs`, `tasks`, `pooled`, `pool_duplicates`,
`pool_in_inbox`, `pool_dnc`, `pool_blocked`, `pool_invalid`, `owners_mapped`,
`owners_unmapped`, `activities_as_notes`, `offers_as_notes` (and, for a rollback, `rolled_back`,
`kept`, `prospects_rolled_back`, `prospects_kept`). Every value is a number.

## 4. Owner review

Send the owner the production dry run's counts (and the staging one's, if they differ) — the
JSON line only. The owner checks at least:

- `to_inbox + to_pool + skipped_*` equals `total`, and `total` matches the v1 count of §1.2;
- `to_pool` is about the number of never-contacted research leads the owner expects;
- `owners_unmapped`: v1 owners with no active member under the same email. Either invite them
  first (then dry-run again) or accept that `distribution.backfill` assigns those journeys;
- `pool_dnc`, `pool_blocked`, `erased_skipped`: objections and erasures honoured;
- `identities_invalid` and `pool_invalid`: values Jeeta could not hold.

Nothing is imported until the owner says yes in writing (the counts and the file's
`sha256sum` are the record).

## 5. Import

```sh
/opt/jeeta/jeeta import-v1-leads --workspace <production workspace id> \
  --input /root/v1-leads-v2.jsonl
```

The counts must equal the approved dry run's (against unchanged data). Each 100-lead chunk
commits on its own; if the command stops, run it again with the same file: imported leads count
`already_present`. One `import.v1_leads` ledger entry (counts only, actor System `v1_import`)
records each successful run. Keep the workspace's outreach switch and jobs as they are: the
importer starts nothing and sends nothing.

## 6. Spot checks

In the panel of the production workspace, without writing values down anywhere:

- a few inbox people: name, company, identities, stage, the "v1 bilgileri" note (tags,
  attribution, `aiScore` lines), one note per v1 activity except status changes, one
  "v1 teklifleri" note when the lead had offers (no quotes), the owner when it was mapped;
- a few prospects in **Aday havuzu**: business name, city, district, sector, contact fields
  with their `v1` import evidence, the `v1-legacy` score, signals and notes; a bounced email
  shows as not deliverable;
- the ownerless imported journeys appear in `distribution.backfill`'s count;
- another workspace has no imported rows.

Record only counts and yes/no answers.

## 7. Rollback

Before people or jobs change the imported records:

```sh
/opt/jeeta/jeeta import-v1-leads --workspace <production workspace id> \
  --input /root/v1-leads-v2.jsonl --rollback
```

- An inbox person goes with its import-created children when nothing changed it
  (`rolled_back`); otherwise it is kept (`kept`). A person a prospect was promoted to, one with
  an outreach enrollment or a mail file is kept: those rows name it without an on-delete rule.
- A prospect goes with its keys and score when it is still `new`, at revision 1, undecided,
  unpromoted and scored only by v1 (`prospects_rolled_back`); otherwise it is kept
  (`prospects_kept`).
- The do-not-contact hashes of v1 opt-outs **stay**: an objection outlives the import.
- Never delete kept records by hand as part of this rollback; review them with the owner.

A second rollback is a no-op for what is gone. An import after a rollback writes the same
records again under the same deterministic ids.

## 8. Delete the file

After the spot checks are accepted (or the rollback is reviewed), on every host that held it:

```sh
shred --remove /root/v1-leads-v2.jsonl
```

Use the storage operator's procedure for snapshots and copy-on-write storage as well
([`v1-cutover.md`](v1-cutover.md), last section).

## 9. Switch v1 to read-only

After the owner accepts the import, v1 stops taking writes so no lead changes on the old side:

1. Fence v1's senders and schedulers as in [`v1-cutover.md`](v1-cutover.md) "Cutover
   procedure", step 2 (if not done already).
2. Make the v1 application's database role read-only and restart the v1 backend so every new
   session inherits it (as the v1 database owner):

   ```sql
   ALTER ROLE <v1 application role> SET default_transaction_read_only = on;
   ```

3. Check that a write through v1's panel now fails, and record the time.
4. The read-only v1 archive and its 90-day minimum are [`v1-cutover.md`](v1-cutover.md)'s
   step 3; this switch does not replace it.

Undoing the switch (`ALTER ROLE … RESET default_transaction_read_only`) is an explicit owner
decision, as is resuming v1 at all.
