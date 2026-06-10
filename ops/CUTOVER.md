# Cutover runbook — monorepo marketing → standalone kds-marketing

Goal: production `marketing.hummytummy.com` stops being served by the kds
monorepo (core backend `/marketing/*` + monorepo-built SPA) and is served by
THIS project (backend :3100 + its own SPA), with the HummyTummy operation
living on as **workspace #1** and the nightly research routine pointing at
the new service.

Run top to bottom; every step is verifiable before the next. Steps 0–4 are
zero-downtime preparation; the actual switch is steps 5–7 (one short
maintenance window for the data copy).

---

## 0. Pre-flight — verify the CURRENT prod state

The monorepo's `main` already contains PR #226 (marketing module removed
from core). **Before anything, find out what prod actually runs:**

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  https://hummytummy.com/api/marketing/auth/login -X POST \
  -H 'Content-Type: application/json' -d '{}'
# 401/400 → old marketing API still served (prod predates #226)
# 404     → prod already runs post-#226 core; the OLD routine has been
#           failing since that deploy — treat cutover as URGENT
```

Also check the live routine's recent runs at https://claude.ai/code/routines
("hummy tummy marketing") — `created:0` / connection errors confirm the
ingest path is already dark.

## 1. Provision infra for the new service

- Postgres database `marketing` (managed or container) — SEPARATE from
  core's DB.
- Decide the staging + prod hostnames (suggestion: keep
  `marketing.hummytummy.com` for the workspace-#1 panel; the platform is
  reachable on the same host under `/platform`).
- Create `.env` from `backend/.env.example`. Non-negotiables:
  `DATABASE_URL`, `MARKETING_JWT_SECRET`, `MARKETING_JWT_REFRESH_SECRET`,
  `PLATFORM_JWT_SECRET`, `INTERNAL_SERVICE_TOKEN` (same value core uses),
  `RESEARCH_ROUTINE_TOKEN` (NEW random 48+ hex — never reuse the old
  leaked MARKETING_INGEST_TOKEN), `CORE_SERVICE_URL`, `APP_NAME`/`APP_URL`
  (HummyTummy branding for the converted-tenant welcome mail), `BANK_IBAN`
  + `BANK_ACCOUNT_NAME`, and the PSP credentials you'll accept
  (PAYTR_* for TRY, STRIPE_* for USD).

## 2. Deploy to STAGING with an empty DB

```bash
docker compose pull && docker compose up -d   # migrate deploy runs on boot
docker compose exec backend npx ts-node prisma/seed-packages.ts
PLATFORM_OPERATOR_EMAIL=... PLATFORM_OPERATOR_PASSWORD=... \
  docker compose exec backend npx ts-node prisma/seed-platform-operator.ts
```

Smoke: register a workspace via `/register`, confirm TRIAL quota 3 in
Research settings, buy STARTER via bank transfer, approve it in
`/platform/payments`, watch the quota jump to 10.

## 3. Drain core's outbox backlog

On the core (monorepo) deployment, confirm the relay is healthy and no
`payment.succeeded.v1` / `marketing.*` outbox rows are stuck pending —
events relayed during the data copy would land in one side only.

```sql
SELECT type, status, count(*) FROM outbox_events
WHERE status NOT IN ('dispatched') GROUP BY 1,2;
```

## 4. Build the workspace-#1 import script (rehearse on staging!)

The monorepo's marketing tables still live in CORE's database. Copy order
matters — import FIRST, then this repo's backfill migrations adopt the rows:

```bash
# 4a. Fresh DB for prod (NOT the staging one), apply ONLY the migrations
#     that predate multi-tenancy, so legacy-shaped data can land:
npx prisma migrate resolve --applied 0_init  # …see note below
# Simpler equivalent: restore the dump into an empty DB and run
# `prisma migrate deploy` AFTER the import — the 3-step workspace
# migrations (expand→backfill→contract) were written exactly for
# pre-workspace data and were rehearsed against live rows.

# 4b. Dump the 13 marketing tables from CORE's prod DB:
pg_dump --data-only --no-owner \
  -t marketing_users -t leads -t lead_activities -t marketing_tasks \
  -t lead_offers -t commissions -t marketing_notifications \
  -t marketing_distribution_config -t sales_calls -t installation_crews \
  -t installation_jobs -t installation_tasks -t sales_targets \
  "$CORE_DB_URL" > marketing-data.sql

# 4c. New prod DB: apply pre-workspace migrations only, import, then deploy
#     the rest:
#     (0_init + hardware_quote) → psql < marketing-data.sql → migrate deploy
#     The backfill migration adopts every row into the deterministic
#     'default' workspace (b6a7c000-…-000000000001), remaps roles
#     SALES_MANAGER/REP → MANAGER/REP and turns the old global sentinel
#     into the workspace SYSTEM user.

# 4d. Row-count parity check (run on both sides):
psql "$DB" -c "SELECT 'leads', count(*) FROM leads UNION ALL
               SELECT 'marketing_users', count(*) FROM marketing_users …"
```

`tenant_provisioning_log` STAYS in core (core-owned idempotency ledger).

## 5. Maintenance window — switch the domain

1. Monorepo nginx: serve 503 on `marketing.hummytummy.com/api` (stop new
   writes), leave the SPA up with a maintenance banner if desired.
2. Run step 4's dump→import→migrate against the NEW prod DB.
3. Brand workspace #1 (operator SQL or the platform panel):

```sql
UPDATE workspaces SET
  slug='hummytummy', name='HummyTummy',
  "productName"='HummyTummy POS', "productUrl"='https://hummytummy.com',
  "productDescription"='Modern POS + digital ordering for cafes/restaurants in Turkey',
  "defaultLanguage"='tr', "defaultCurrency"='TRY',
  "coreIntegration"='{"type":"KDS_CORE","appName":"HummyTummy","appUrl":"https://hummytummy.com"}'
WHERE id='b6a7c000-0000-4000-8000-000000000001';
```

4. Seed packages + operator (step 2 commands) and give workspace #1 the
   internal OPERATOR package:

```sql
INSERT INTO workspace_subscriptions
  (id,"workspaceId","packageId",status,"billingCycle",currency,
   "currentPeriodStart","currentPeriodEnd")
SELECT gen_random_uuid(),'b6a7c000-0000-4000-8000-000000000001',id,
  'ACTIVE','YEARLY','TRY',now(),now()+interval '10 years'
FROM packages WHERE code='OPERATOR';
```

5. Create workspace #1's research profile (Research settings UI): name
   "TR F&B", language `tr`, geo `{country:"TR", cities:[Istanbul, Ankara,
   Izmir, Antalya, Bursa]}`, icpDescription transcribing the old routine's
   brief (pain-review cafes/restaurants, growth signals, no digital infra),
   exclusions (big chains list from the old prompt).

## 6. Point traffic at the new service

Host nginx for `marketing.hummytummy.com`:
- `/` → new frontend container
- `/api/` → new backend `:3100` (strip nothing; the service serves
  `/api/marketing/*`, `/api/platform/*`, `/api/internal/*`,
  `/api/billing/webhooks/*`)

Core's env: `MARKETING_SERVICE_URL=https://marketing.hummytummy.com`,
shared `INTERNAL_SERVICE_TOKEN`. Restart core; verify referral resolve +
event relay logs.

PSP webhooks: point PayTR's callback URL and the Stripe endpoint
(`/api/billing/webhooks/paytr|stripe`) at the new host; set
`STRIPE_WEBHOOK_SECRET` from the new endpoint's signing secret.

## 7. Flip the research routine

A DISABLED generic routine is already created:
**trig_015cAwmTR4y3nd9Hc4ES5MPw** — "marketing-platform research (generic)"
(https://claude.ai/code/routines/trig_015cAwmTR4y3nd9Hc4ES5MPw)

1. Update its prompt: replace both `https://TODO-set-at-cutover.example.com`
   with the real base URL and `TODO-set-at-cutover` with the real
   `RESEARCH_ROUTINE_TOKEN` (canonical text: `ops/research-routine-prompt.md`).
2. Dry-run it once ("run now") and check the summary lists workspace #1's
   job and submits successfully (`created>0` or a clean quality-bar skip).
3. Enable it; DISABLE the old "hummy tummy marketing" routine (do not
   delete — keep for reference until the first healthy week).

## 8. Aftercare

- Monorepo cleanup PR on `test`: delete the `marketing/` SPA dir, its
  build/deploy steps in `.github/workflows/{test,release}-deploy.yml`, and
  the `marketing` service in both compose files.
- After 30 days of healthy operation: drop the 13 marketing tables from
  CORE's database (keep the step-4 dump archived).
- Rotate the old leaked `MARKETING_INGEST_TOKEN` out of any secret stores;
  it has no server-side consumer anymore.

## Smoke checklist (post-cutover)

- [ ] Workspace-#1 manager logs in, sees historical leads
- [ ] `GET /api/internal/research/jobs` (new token) lists workspace #1
- [ ] 2-lead test POST creates leads + stamps profile lastRunStats
- [ ] Core → marketing: a test `payment.succeeded.v1` relays and credits a
      commission
- [ ] Marketing → core: referral resolve works from core's checkout
- [ ] PayTR test-mode checkout settles an order end-to-end
- [ ] `stripe listen --forward-to .../api/billing/webhooks/stripe` settles
      a test checkout
- [ ] Bank-transfer order → platform approve → entitlements update
