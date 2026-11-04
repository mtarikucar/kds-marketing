# Growth Studio materials library — implementation plan

> **For agentic workers:** use superpowers:executing-plans (or subagent-driven-development) to implement
> this plan task by task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Studio builds content only from real, categorized materials in their real context and time
(spec `docs/superpowers/specs/2026-11-03-studio-materials-design.md`, read it first).

**Architecture:** pure rules in `jt_studio` (olay, material, calendar, eligibility, selection, truth check,
shoot requests); a `MaterialRepo` port on `TenantRepos`; one migration `0021_studio_materials` with seven
forced-RLS tables; the planner, `piece_submit` and the publisher gated by eligibility (spec D1); use cases
with MCP twins and panel-only human decisions; a "Materyaller" tab in the panel.

**Base and branch:** `feat/studio-materials` from `origin/feat/rust-panel-money-inputs`, one draft PR into it
("Growth Studio materials library"). Merge the base on conflict, never rebase. Do not merge the PR.

**Global constraints:** hexagonal boundaries (`jt_archtest`); catalog rows, handlers, MCP tools and the
exact-set tests change together (`jt_app/tests/catalog.rs`, `jt_archtest/tests/{m4_productisation,
studio_rules,twin_rule}.rs`, `jt_mcp/tests/registry.rs`); migrations are repeatable and reversible, `down`
refuses unsafe states; FORCE RLS on every new table; no titles, notes, places, names or captions in the
ledger or logs; Turkish + English panel copy with parity. On Windows: `jt_pg` tests and every crate depending
on it build on Linux CI only; `cargo clippy -p jt_app` needs `--features tokio/time,uuid/v4`; CI runs
`cargo doc` with `-D warnings` (no private intra-doc links); never commit a local `wal.rs` workaround.

**Per-task loop:** failing test → red → implement → green → `cargo fmt --all -- --check` and clippy on the
touched crates → small commit ending with the `Co-Authored-By` line. Push per phase; `gh pr checks`, read
failures with `gh run view --log-failed`.

## Phase 0 — documents

- [ ] Spec and this plan; commit; push; draft PR.

## Phase 1 — the material gate (spec D1), shippable alone

No new catalog row: the gate changes behaviour behind existing use cases. Ships before any panel work.

### P1-T1 Domain: olay, material, calendar, eligibility (`jt_studio`)
- [ ] Tests `jt_studio/tests/materials.rs`: olay validation (title, range ≤ 366 days, occasion exactly for
  season/special day, confirmed ⇔ confirmed_by); material validation (genel real ⇒ freed; generator ⇔ AI;
  share by `None` only for AI without `depicts`); tag keys round-trip; every §4.3 refusal code.
- [ ] Tests `jt_studio/tests/calendar.rs`: Turkish defaults for 2025–2028 (anneler günü = second Sunday of
  May, babalar günü = third Sunday of June), lunar/mezuniyet/kulüp entries without windows, overlay of a
  workspace row, season year of an olay shot before the window, `in_window`.
- [ ] Implement `olay.rs`, `material.rs`, `calendar.rs`, `eligibility.rs`; ids `OlayId`, `MaterialId`,
  `ShootRequestId`.

### P1-T2 Domain: selection and shoot requests
- [ ] Tests `jt_studio/tests/selection.rs`: slot need parsing (`figur.bitmis_urun`, `toplu_siparis`,
  free keys → no need); order (season in window, upcoming olay, recent recap, archive, generic); reuse
  window; ties by id; AI promo only before the olay ends; nothing eligible → `None`.
- [ ] Tests for shoot request keys and texts (Turkish), week start.
- [ ] Implement `selection.rs`, `shoot.rs`.

### P1-T3 Ports and the in-memory fake
- [ ] `jt_app::ports::materials::MaterialRepo` (olays, materials, piece uses, calendar rows, shoot requests,
  policy, releases, person redaction), `TenantRepos::studio_materials()`; every `TenantRepos`
  impl (pg, testkit `MemTenant`, the spy tenants in `jt_app/tests`, the failing tenant in `jt_webhook`
  tests, `jt_testkit::activation_control`).
- [ ] `jt_testkit` `MemMaterials` with the migration's constraints (one material per file, origin and file
  never change, piece uses insert-only, shoot request key unique) and a `seed_material` helper.

### P1-T4 Migration `0021_studio_materials` and the pg repo
- [ ] Migration up/down per spec §6 (checks, composite FKs, triggers, FORCE RLS, `down` refusing live
  rows); `jt_pg/tests/migrations.rs` and `jt_archtest` table count 74 → 81; README migrations table.
- [ ] `jt_pg/src/repos/studio/materials.rs`; tests `jt_pg/tests/studio_materials.rs` (round trips, RLS
  isolation, origin trigger, insert-only uses, down refusal) — Linux CI.

### P1-T5 Planner gate — superseded by Phase 3 (olay-driven publishing)

`planner.rs` slot materialization is not changed in Phase 1. Phase 3 replaces it (spec §14). Until Phase 3
ships, the gate holds at submission (P1-T6) and publish (P1-T7): nothing without an eligible material is
ever submitted or published.

### P1-T6 Submission gate
- [ ] Tests: piece with bytes / hosted URL / non-material file → `not_a_material`; no anchor →
  `no_eligible_material`; other olay, out of season, unset permission, AI recap → `material_refused` with
  codes; a valid piece records its uses and subject.
- [ ] `pieces.rs`: `subject` input (required while slots have no brief), D2, §4.3 under the control
  fence at the slot's time, `record_piece_materials`.

### P1-T7 Publish re-check and pending
- [ ] Tests: permission revoked after submit, window passed, olay unconfirmed or rebound, no recorded use →
  `publish_due` holds (no attempt, no failure), `studio.pending` shows `material_check_hold` with codes.
- [ ] `chain::authorize_execution_at` (slot target) re-check; `awaits_human` includes the hold; pending
  blocker; `PendingStudioOut.shoot_requests`.

### P1-T8 Files cleanup and existing tests
- [ ] `cleanup_files` never deletes a live material's file (test).
- [ ] Every existing Studio test that submits or publishes a piece seeds materials (`jt_app`, `jt_pg`,
  `jt_mcp`, `jt_panel_http`, `jt_archtest` acceptance scenarios, `smoke_studio`).

## Phase 2 — the library's use cases, MCP twins and panel routes

### P2-T1 Olays: `olay_create`, `olay_update`, `olays_list`, `olay_get` (twins), `olay_confirm` (panel only)
### P2-T2 Materials: `material_add` (capture time + olay suggestions), `material_tag`, `materials_list`,
`material_get` (used-in), `slot_materials` (twins); `material_permission`, `material_free`, `material_bind`,
`material_delete` (panel only)
### P2-T3 Calendar and policy: `calendar_list` (twin), `calendar_set`, `material_policy_set` (panel only)
### P2-T4 Çekim listesi: `shoot_list`, `shoot_request`, `shoot_resolve` (twins); `work.pending` kind
`studio_shoot_request`
### P2-T5 Surfaces: catalog rows, MCP tools (descriptions say what a human decides), panel routes,
archtest pins (catalog count, registry count, POST_M4 lists, studio rules), MCP and HTTP tests
### P2-T6 KVKK: erasure hook in `inbox.people.erase`, file deletion after commit, retention in
`StudioFilesCleanup` (24 months)

Each task: use-case tests in `jt_app/tests/studio_materials_*.rs` first (permission, human-only, replay,
ledger payload without personal text), then MCP/HTTP twins.

## Phase 3 — olay-driven publishing (spec §14, replaces weekly slot quotas)

Migration `0022_studio_posts` (posts, package requests, posting policy; down refuses live rows).

### P3-T1 Domain: posts, formats, caps
- [ ] `PostFormat`, leads and graces, `PlannedPost`, `PackageRequest` (olay, calendar, floor), the posting
  policy with its defaults (D21, D28, D29), `validate_package` (all-or-nothing, a reason per item: lead,
  horizon, quiet hours in `tz`, caps, spacing, formats per kind, media count, §4.3 per material).
- [ ] Formats per organic kind (D30): story refused everywhere (`format_unsupported`) until the official
  docs are checked and an adapter publishes it; the audit of what each adapter publishes today.

### P3-T2 Storage and ports
- [ ] `0022_studio_posts`, pg repo, fake, archtest table count, README.

### P3-T3 Triggers (the new `studio_plan`, every 10 minutes)
- [ ] Olay trigger with the 30-minute debounce (20 uploads → one request); calendar trigger at
  `window_start − lead`; floor trigger (`floor_days`, not while a package or post is pending); çekim
  listesi items when nothing is eligible; requests expire after 7 days.
- [ ] Remove weekly materialization from `planner.rs`; retire old planned/ready slots `replanned` once
  (D34), with a ledger entry each; `RetirementReason::Replanned` and `MissedGrace`.
- [ ] Test: zero materials + approved strategy + no-approval policy → çekim listesi items only, no post, no
  publication.

### P3-T4 Package proposal and just-in-time work
- [ ] `studio.post_requests`, `studio.posts_propose`, `studio.posts_list`, `studio.weekly_summary`
  (twins); `studio.posting_policy_set` (panel only); catalog, MCP, routes, archtest pins.
- [ ] Pending lists a post only from `prep_start_at`; missed past grace → retired `missed_grace`.

### P3-T5 Learning per format × olay kind × hypothesis
- [ ] Aggregation over measurements; best formats in package requests; the floor trigger's hypothesis by
  posterior mean.

## Phase 4 — truth check

- [ ] Domain `truth.rs`: Turkish folding, tokens, Turkish date parsing, every finding of spec §7, digest.
- [ ] Submission reports caption findings in `slot_get` (`material_check`); publish holds on findings not
  released; `material_check_release` (panel only, human) for one revision and digest; TikTok title scanned.

## Phase 5 — panel "Materyaller"

- [ ] API client and types; Materyaller tab: Yükle (phone), Olaylar + detail, Materyal editor, Takvim,
  Çekim listesi; Today's slot card shows the post's materials and the hold; the weekly summary. Vitest per screen; TR/EN parity.

## Phase 6 — documents

- [ ] `rust/README.md` (migration row, jobs), spec "what is built" section; final PR description with
  deploy notes (spec §12).
