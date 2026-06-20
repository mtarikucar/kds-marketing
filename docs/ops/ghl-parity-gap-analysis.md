# GoHighLevel Parity — Gap Analysis (2026-06-19)

Evidence-based audit of the current codebase (main / v2.32.0) against GoHighLevel's
full feature surface. Status legend: **HAVE** (real, working) · **PARTIAL**
(exists but shallow / missing key depth) · **MISSING** (not implemented).

The product already has **impressively broad** GHL coverage. The gaps are
concentrated in a few *signature* areas (multi-pipeline Opportunities, the visual
drag-drop builder, workflow-builder depth, commerce/e-sign, email deliverability)
plus a long tail of smaller items.

---

## Tier 1 — Signature gaps (define the "GHL feel"; build first)

### 1. Opportunities + multiple custom pipelines + kanban  — **MISSING**
All sales are modeled as `Lead.status` (one hardcoded enum pipeline). GHL's core is
**named Opportunities** moving across **multiple custom pipelines** with custom
stages, dragged on a **kanban board**, with monetary value & forecasting. No
`Pipeline` / `Stage` / `Opportunity` models exist (`backend/prisma/schema.prisma`).
Foundational — reporting and automation key off pipeline stage.

### 2. Visual drag-and-drop builder (pages / funnels / forms / emails) — **MISSING (template-only)**
GHL's signature is a WYSIWYG canvas (sections→rows→columns→elements). Today: a
**JSON textarea** with AI-drafted blocks (`SitesPage.tsx`, `site-renderer.service.ts`,
7 block types). No visual canvas, no template library, no nested layout, no custom
CSS/JS, **no multi-step funnels** (only A/B `Experiment` variants), **no custom
domains** for pages, no blogs, no pop-ups/sticky bars, no order forms. Forms are a
fixed name/email/phone schema (no field builder). Biggest "feel" gap.

### 3. Workflow builder depth — **PARTIAL**
Engine is solid (16 actions, wait/branch/webhook/AI, per-step cursor) but: builder is
a **form/JSON editor, not a visual node canvas**; only **7 triggers** (no inbound
webhook, no tag-added, no opportunity-stage-changed); **no tag add/remove actions**;
no goals; no drip/sequence template. (`workflows/workflow-dsl.schema.ts`.)

---

## Tier 2 — Commerce & deliverability

### 4. Payments / Commerce depth — **PARTIAL**
HAVE: one-time invoices (Stripe only), internal + affiliate commissions.
MISSING: **products/catalog**, **recurring invoices/subscriptions**, **estimates**,
**taxes**, reusable **coupons**, **text-to-pay / payment links**, **Documents &
Contracts with e-signature**, **proposals**, **order forms / 1-click upsells / order
bumps**, customer **wallet**. Only Stripe (no PayPal/Authorize.net/NMI).

### 5. Email marketing deliverability + builder — **MISSING/PARTIAL**
HAVE: broadcast campaigns (email/SMS/WhatsApp), click/open tracking, opt-out,
throttled sender. MISSING: **drag-drop email builder** (plaintext only), **dedicated
sending domains + DKIM/SPF**, **email verification**, **A/B testing**, drip sequences.
Single shared SMTP transporter (`common/services/email.service.ts`).

---

## Tier 3 — CRM depth & channel breadth

### 6. Custom Objects + Companies/B2B — **MISSING**
Only the `Lead` entity. `CustomFieldDef` is enum-ready for CONTACT/OPPORTUNITY but
only LEAD is wired. No user-defined object types; no Company record or contact↔company
hierarchy.

### 7. Channel breadth — **PARTIAL**
Inbox: WEBCHAT, WhatsApp, SMS (NetGSM), Instagram, Messenger, inbound Voice AI.
MISSING: **email inbox** (receive/reply — campaign-only today), **Google Business
Messages**, inbound two-way **SMS threading**. Social planner: **3/7 networks** (FB,
IG, LinkedIn) — missing **GMB, TikTok, X/Twitter, Pinterest**. **Listings (Yext-style)**
missing.

### 8. Calendars — **PARTIAL**
Single-owner calendars only. MISSING **calendar types**: round-robin, collective,
class/group, service. **Outlook/O365 sync** missing (Google 2-way is solid).

### 9. Inbox productivity — **MISSING**
No **snippets / canned responses**, no **internal notes** on conversations, no
standalone **trigger links + QR codes** (only campaign-level tracking), bulk actions
limited to **bulk-assign** (no bulk update/delete/tag/add-to-workflow), no CSV export.

---

## Tier 4 — Reporting, reputation, memberships, agency polish

- **Ad reporting / Ad Manager** (Google Ads, Facebook Ads spend/leads/ROAS) — **MISSING**.
- **Attribution** — PARTIAL (single-touch rep/source; no multi-touch / revenue).
- **Reputation** — review requests + AI replies HAVE; **auto review monitoring/sync**
  (Google/FB) and **listings** MISSING.
- **Memberships** — courses + communities HAVE; **certificates**, **gamification**,
  lesson-level **drip/access gating** MISSING.
- **Agency polish** — sub-accounts/snapshots/rebilling/SaaS-configurator/wallet HAVE;
  **custom-domain white-label** PARTIAL (subdomain only), **affiliate public portal**,
  **prospecting/audit tool**, **inbound lead webhooks** MISSING; SSO state in-memory
  (needs Redis for multi-replica).
- **Voice** — IVR + Voice AI + click-to-dial HAVE; **power dialer**, call **recording
  retrieval** MISSING.

---

## Tier 5 — Separate large projects (flag, not in-line)

- **White-label mobile app** (LeadConnector equivalent) — a separate native iOS/Android
  project, not part of this monorepo.
- **App Marketplace** (third-party app platform) — a large platform effort of its own.

---

## Coverage snapshot (rough)

| Cluster | Approx parity |
|---|---|
| CRM / Contacts | ~75% (gaps: custom objects, B2B, bulk, export) |
| Conversations / Inbox | ~65% (gaps: email inbox, snippets, notes, GMB) |
| Sales (Opportunities/Pipelines) | ~30% (single-pipeline; no kanban/opportunities) |
| Payments / Commerce | ~35% (invoices+Stripe only; no e-sign/products/subs) |
| Sites / Funnels / Builder | ~30% (template-only; no visual builder) |
| Automation / Email | ~55% (engine good; no visual canvas, deliverability) |
| Calendars | ~70% (single-owner; no types/Outlook) |
| Phone / Voice | ~75% (no power dialer) |
| Reputation | ~60% (no auto-monitor/listings) |
| Social | ~43% (3/7 networks) |
| Memberships | ~70% (no certs/gamification) |
| Agency / SaaS | ~80% (no custom domain/mobile/marketplace) |
| Reporting / Analytics | ~50% (no ad reporting; single-touch attribution) |
| AI suite | ~85% (no image gen; strong otherwise) |
| Platform / Dev (API/webhooks/SSO) | ~75% (no inbound webhooks; SSO single-replica) |

**Recommended build order:** Tier 1 → 2 → 3 → 4, with Tier 5 deferred as separate
projects. Each item should go through brainstorm → plan → implement as its own epic.
