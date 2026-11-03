# Growth Studio materials library ("Materyaller") — design

Date: 2026-11-03. Status: behaviour approved by the owner in chat (2026-11-03); this document turns it
into rules and storage. Amended the same day by the owner: Studio is **material-gated by construction**
(D1), not by a human-approval policy.

Rust workspace (`rust/`), base `feat/rust-panel-money-inputs` (the Rust integration branch; `main` holds
v1 only). Builds on Growth Studio as it is (`jt_studio`, `jt_app::usecases::studio`, migration
`0009_studio`): the file store (`studio.file_upload`, `studio_files`, `StudioFilesCleanup`), slots,
pieces, the planner, the publisher and the approval receipts. Nothing here adds a second file store.

## 1. Why

The owner runs a customer workspace, figurunica: a studio for 3D figures, diorama tablolar and landmark
models (anlamlı yer/maket), with workshops (atölye) and seasonal collections. The owner feeds real photos
and videos into Jeeta, and Studio must build content from them, categorized, in their real context and
time. In the owner's words, the core worry: footage shot at one workshop must never be posted as another
workshop, and special-day photos and videos must never be picked at random for unrelated content.

## 2. Goals and non-goals

**Goals.**
- Every material has a real context (an *olay*) or is explicitly evergreen (*genel*), a share permission,
  and tags. Its origin (real or AI-generated) is fixed at birth.
- Studio produces content only from eligible materials (D1). No eligible material: a request on the
  weekly *çekim listesi* instead of content.
- What a caption claims (date, place, event, client) is checked against the used materials' olay before
  publishing, deterministically from structured olay data.
- KVKK: materials that show a person are personal data, erased with the person, and kept no longer than
  the retention rule (§9).
- A "Materyaller" area in Growth Studio (Turkish UI, works on a phone) and MCP twins for every action an
  agent needs.

**Non-goals (this release).**
- Auto-ingest from the workspace's WhatsApp or mailbox (phase 2, §13).
- Image understanding on the server. Tags, faces and quality are suggested by connected agents (the
  owner's Codex agent through MCP) and corrected by humans. No platform-held vision or generation API
  (owner's standing rule: connected agents do the work).
- Editing media (crop, blur). A material that needs a crop is not used until a human replaces or
  re-grades it.
- Deleting already-published provider posts automatically (§9.3).

## 3. Decisions

| # | Decision |
|---|---|
| D1 | **Material-gated by construction (owner, 2026-11-03).** The planner materializes an organic slot only when an eligible anchor material exists for it at its time; otherwise it writes a çekim listesi request and no slot. `studio.piece_submit` refuses, server-side, a piece that does not show at least one eligible anchor material, whatever the approval policy and whoever submits. The publisher re-checks at publish time and holds on any failure (permission revoked, window passed, olay mismatch). A workspace with an approved strategy and no materials produces nothing but material requests. This is the first implementable phase (P1), before any panel work. |
| D2 | **Every medium of a piece is a material.** A piece's media (top level and every adaptation) are `MediaAsset::File` whose file is a live material of the workspace. Inline bytes and hosted URLs are refused in pieces (they carry no provenance); an agent registers media as a material first (`studio.material_add`). |
| D3 | **Olay status.** An olay a human creates in the panel is *confirmed*; one an agent creates over MCP is *proposed* until a human confirms it. Only confirmed olays make materials eligible. An agent cannot invent an event and publish an announcement for it. |
| D4 | **Consent decisions are a human's.** Share permission, freeing a material ("genel kullanılabilir"), rebinding a real material to another olay, deleting a material, confirming an olay, editing the calendar and releasing a caption hold are panel-only use cases for an owner or manager human (`studio.manage`, the existing `human_approver` rule). One exception (D5). |
| D5 | **AI images and share permission.** An agent may set `shareable` or `not_shareable` on an `ai_generated` material it adds, only while the material's `depicts` set is empty (no face, name, child, client logo, corporate reference). A real material, or an AI one with any `depicts` flag, gets its permission from a human only. |
| D6 | **Origin is immutable.** `real` or `ai_generated` (with the generator's name, e.g. `codex`) is fixed when the material is created; an AI material can never become real (domain rule, database check and trigger). |
| D7 | **Subjects, not free-text claims.** A piece declares its *subject*: `olay(id)` (it speaks about that olay and may state its real date, place, name and client), `archive(id)` (a season or special-day olay of an earlier year, presented as last year's, with that year), or `generic` (no specific date, place or event). The default is the slot brief's subject (§6.2). The truth check compares the caption against the subject's structured data (§7). |
| D8 | **Freed and genel materials are generic only.** A real material freed by a human, or one uploaded as genel by a human, may appear only under the `generic` subject. Workshop A's footage, even freed, never appears in content about workshop B. |
| D9 | **Season windows are absolute.** A material of a season or special-day olay is used only while the slot's time is inside that occasion's window: the olay's own year as itself, a later year only under `archive` with the olay's year in the caption. Out of season it waits. |
| D10 | **AI promo visuals.** An `ai_generated` material bound to a confirmed olay counts as an anchor only for that olay's own subject and only until the olay ends (an announcement, never a recap). AI materials bound to no olay (genel) are supporting visuals (text cards, backgrounds, layouts): never an anchor, usable beside one. |
| D11 | **The çekim listesi is its own table**, surfaced in `studio.pending`, `work.pending` and the panel. The existing inbox tasks hang off a person's journey (`/api/inbox/journeys/{id}/tasks`) and do not fit workspace-level requests. |
| D12 | **Calendar defaults are computed, not seeded.** Fixed and rule-based Turkish dates are derived per year by a pure function; the workspace table holds only the owner's edits and the dates the owner enters. Lunar holidays (Ramazan and Kurban Bayramı), mezuniyet and kulüp sezon başı ship with no dates: they are inactive until the owner enters a year's dates. No guessed date is ever stored. |
| D13 | **Paid-lane slots stay ungated (decided 2026-11-03, was Q1).** The paid lane moves budgets of ad sets built from existing creatives; it carries no piece, and any creative that came from Studio already passed the gate. D1 applies to every content-producing (organic) slot. Revisit when Studio builds paid creatives itself. |
| D14 | **Material files outlive the 30-day publication cleanup.** `StudioFilesCleanup` never deletes the file of a live material; it deletes the files of erased materials (§9). |
| D15 | **Migration number 0021.** `0019` and `0020` are taken by open PRs (#392 inbox public, #393 prospects); sqlx applies a lower pending version after a higher applied one, so the three merge in any order. |
| D35 | **The library needs no strategy.** Its use cases (olays, materials, tags, calendar, çekim listesi) and `studio.file_upload` are exempt from the strategy gate, not from the workspace-status check: the owner gathers materials before and while the strategy is worked out. Nothing is planned or published without an approved strategy anyway. |
| D16 | **Retention (decided, was Q2).** Materials that show people are kept 24 months after their olay by default (§9.3); the owner may delete earlier at any time; a person's erasure removes theirs at once, whatever the retention. |
| D17 | **AI self-permission (decided, was Q3).** D5 stands. The `depicts` flags are mandatory on every AI upload (the agent states the set, possibly empty: no face, name, child, logo, brand or club mark). Any flag set: a human decides. A human may always revoke. |
| D18 | **Per-workspace settings (decided, was Q4–Q5).** `lead_days` 21, `reuse_days` 14, `recap_days` 30 are the materials policy's defaults, editable per workspace; the season windows of §4.4 are the defaults of the per-workspace calendar. |
| D19 | **Hard findings are never releasable (decided, was Q6).** The fix is to change the material's binding or the caption. Only caption findings (§7) may be released by a human. |

## 4. Domain (`jt_studio`, pure)

New modules `olay`, `material`, `calendar`, `eligibility`, `selection`, `truth`, `shoot`. Person ids are
plain `Uuid` (the domain crate may not depend on `jt_inbox`; the application maps `PersonId`).

### 4.1 Olay

`Olay { id, workspace_id, kind, title, starts_on, ends_on, place, client, notes, occasion, status,
confirmed_by, revision, created_at }`.

- `kind`: `workshop` (atölye), `order` (sipariş/proje, e.g. a 200-figure club order), `season` (sezon
  koleksiyonu: yılbaşı, cadılar bayramı…), `special_day` (özel gün), `product_shoot` (ürün çekimi),
  `other`.
- `starts_on ..= ends_on`: calendar dates in Istanbul (UTC+03); one day or a range, at most 366 days.
- `place`: optional, ≤ 120 characters. `title`: 1–120. `notes`: ≤ 2000.
- `client`: optional `{ person_id?: Uuid, organization?: string }`, the inbox person and/or the company or
  club (≤ 120). At least one of the two when present. The person's name is read from the inbox at check
  time, never copied into the olay (a copy would freeze and survive erasure).
- `occasion`: the calendar key (§4.4) for `season` and `special_day`, required for them and absent for
  the others.
- `status`: `proposed` or `confirmed`; `confirmed` exactly when `confirmed_by` (a user) is set.
- *Season year* of a season/special-day olay: the year of the first window of its occasion that ends on
  or after `starts_on` (a yılbaşı collection shot in November belongs to that December's window).

### 4.2 Material

`Material { id, workspace_id, file_id, mime, title, origin, binding, freed, share, tags, tags_reviewed_by,
people, captured_at, created_by, revision, created_at, erased_at }`.

- `file_id`: a `studio_files` file (`studio.file_upload`); one material per file.
- `origin`: `real` | `ai_generated { generator }` (D6). `generator`: 1–40 of `[a-z0-9_.-]`.
- `binding`: `olay(OlayId)` | `genel`. Real `genel` requires `freed` (only a human sets it, D4). AI
  `genel` is a supporting visual (D10) and an agent may create it.
- `freed`: `{ by: UserId, at }`: a human marked it "genel kullanılabilir" (D8).
- `share`: `{ permission, by: Option<UserId>, at }` or unset. `permission`: `shareable`, `not_shareable`,
  `product_only` (faces and names hidden). `by = None` only for D5's agent-set AI case.
- `tags`: `product_groups` ⊆ {figur, diorama_tablo, anlamli_yer_maket, sezon_urunu, atolye, pazaryeri};
  `doors` ⊆ {kisiye_ozel, toplu_siparis, ortaklik}; `content_types` ⊆ {bitmis_urun, once_sonra,
  uretim_baski, boyama, paketleme, teslim_tepki, atolye_ani}; `quality` ∈ {publishable, needs_crop,
  unusable} or unset; `depicts` ⊆ {face, name, child, client_logo, corporate_ref}. Agents suggest them;
  `tags_reviewed_by` records the human who confirmed or corrected them last.
- `people`: inbox persons the material shows (KVKK link, §9).
- `captured_at`: from EXIF `DateTimeOriginal` (JPEG) or the MP4 `mvhd` creation time when present, else
  what the uploader says. Used to suggest an olay (§5.3), never to decide eligibility.
- `erased_at`: set by erasure or deletion; an erased material keeps only its id, file id, origin and
  binding (for "used in" history).

### 4.3 Eligibility

`check_use(material, role, subject, at, olays, calendar) -> Result<(), Refusal>` where `role` is
`anchor` or `support`, `subject` is D7's, `at` the slot's time. Refusals are closed codes, each with a
Turkish line in the panel:

1. erased → `erased`.
2. share unset → `share_unset`; `not_shareable` → `not_shareable`.
3. `depicts` non-empty and the permission not set by a human → `sensitive_needs_human`.
4. quality not `publishable` → `quality`.
5. Real, bound to olay O: O missing → `olay_missing`; O not confirmed → `olay_unconfirmed`;
   subject `olay(O)`: if O is a season/special day, `at` inside the window of O's occasion and season year,
   else `out_of_season` (or `use_archive` when inside a later year's window); subject `archive(O)`: O is
   a season/special day (else `archive_not_season`) and `at` inside a later year's window (else
   `out_of_season`); subject `generic`: freed (else `not_freed`), and for a season/special day `at` inside
   a window of its occasion of its season year or later (else `out_of_season`); any other olay's subject →
   `other_olay`.
6. Real genel: subject `generic` only, else `genel_generic_only`.
7. AI bound to O: as anchor only for subject `olay(O)`, O confirmed, `at`'s Istanbul date ≤ O's end (else
   `ai_not_anchor` / `ai_olay_past`); as support only for subject `olay(O)`. AI genel: support under any
   subject, never an anchor (`ai_not_anchor`).

A piece passes when every medium is a material (D2), every material passes as `support` (or `anchor`),
and at least one passes as `anchor`.

### 4.4 Calendar

`CalendarEntry { key, year, name, kind: season|special_day, window_start, window_end, lead_days, enabled }`
per workspace and year. Effective calendar for a year = the computed defaults overlaid by the workspace's
rows (a row replaces the default of its key and year; `enabled = false` turns it off).

Turkish defaults (D12), window ending on the day itself unless stated, `lead_days` 21:

| key | name | window |
|---|---|---|
| `yilbasi` | Yılbaşı | 1 Dec – 31 Dec |
| `sevgililer_gunu` | Sevgililer Günü | 1 – 14 Feb |
| `nisan_23` | 23 Nisan Ulusal Egemenlik ve Çocuk Bayramı | 9 – 23 Apr |
| `anneler_gunu` | Anneler Günü | the 14 days up to the second Sunday of May |
| `babalar_gunu` | Babalar Günü | the 14 days up to the third Sunday of June |
| `cadilar_bayrami` | Cadılar Bayramı | 17 – 31 Oct |
| `ogretmenler_gunu` | Öğretmenler Günü | 10 – 24 Nov |
| `ramazan_bayrami` | Ramazan Bayramı | none: entered per year by the owner |
| `kurban_bayrami` | Kurban Bayramı | none: entered per year by the owner |
| `mezuniyet` | Mezuniyet | none: entered per year by the owner |
| `kulup_sezon_basi` | Kulüp sezon başı | none: entered per year by the owner |

The owner may add keys of their own (`[a-z0-9_]{1,40}`). An entry with no window is inactive: it never
makes a material eligible and the planner names it in the çekim listesi once its year begins ("Ramazan
Bayramı 2027 tarihlerini gir").

### 4.5 Selection (Studio picks real material first)

`select_anchor(slot_need, at, materials, olays, calendar, usage, reuse_days) -> Option<Pick>`, pure and
deterministic. Candidates: every live material with every subject it can take (its olay, `archive` of
it, `generic` when freed or genel) that passes `check_use(anchor)` at `at` and matches the slot's need.

*Slot need* is derived from the hypothesis and arm by one convention: the arm's content-type key and the
hypothesis's `segment_key` are split on `.`, `:` and `/`; every part that is a tag key (§4.2) is a
requirement (e.g. content type `figur.bitmis_urun` needs product group `figur` and content type
`bitmis_urun`; segment `toplu_siparis` needs door `toplu_siparis`). A strategy that uses no tag keys
places no tag requirement; eligibility still applies in full.

Order (first wins): (1) a season/special-day olay's own material inside its window; (2) a confirmed olay
that has not ended (announcement); (3) a real olay that ended within `recap_days` (recap); (4) `archive`;
(5) any other olay subject; (6) `generic`. Then: not used within `reuse_days` before (D18) first, then least recently used, then most recently captured or created, then id.
Use = a publication that showed the material, or a slot brief that picked it.

### 4.6 Çekim listesi

`ShootRequest { id, key, reason, text, week_start, status: open|done|dismissed, created_by, created_at,
resolved_by, resolved_at }`. `key` makes the request idempotent:

- `slot:{hypothesis}:{content_type}:{week}`: the planner found no anchor for a position;
- `season:{key}:{year}`: a window opens within its `lead_days` (or is open) and no eligible material of
  the occasion exists; or the entry has no dates yet;
- `olay:{id}`: a confirmed olay starts within `lead_days` and has no anchor ("16 Kasım atölyesi için afiş veya
  hazırlık fotoğrafı yükle");
- `agent:{request_key}` / `human:{request_key}`: added by an agent or a person.

System requests close themselves (`done`, by the system) at the next planner run once their condition
holds; others are closed by a person or agent. The weekly list is the open requests, newest week first.

### 4.7 Truth check (§7) — `truth::check(piece_text_sources, subject, materials, olays, people_names, at)`

Returns findings, each `hard` (eligibility, never releasable) or `caption` (a deterministic token match a
human may release).

## 5. Application (`jt_app`)

### 5.1 Ports

A new `MaterialRepo` on `TenantRepos` (`studio_materials()`): olays, materials, piece materials, calendar
rows, shoot requests, the materials policy, caption releases, and the person-erasure
redaction. Calls run in the caller's tenant transaction; no file I/O under its locks (files are written
before, deleted after, as `studio.file_upload` does).

### 5.2 Use cases and catalog

Twins (MCP tool + panel route), all exempt from the strategy gate (D35), `studio.work` unless stated:

| use case | route | risk |
|---|---|---|
| `studio.olays_list` | `GET /api/studio/olays` | read |
| `studio.olay_get` | `GET /api/studio/olays/{olay_id}` (materials, requests, used-in) | read |
| `studio.olay_create` | `POST /api/studio/olays` (human: confirmed; agent: proposed) | write |
| `studio.olay_update` | `PATCH /api/studio/olays/{olay_id}` (agent: proposed olays only) | write |
| `studio.materials_list` | `GET /api/studio/materials` (`?olay_id&state`) | read |
| `studio.material_get` | `GET /api/studio/materials/{material_id}` (with used-in) | read |
| `studio.material_add` | `POST /api/studio/materials` (file id, olay or genel, origin, tags, captured_at; answers olay suggestions) | write |
| `studio.material_tag` | `PATCH /api/studio/materials/{material_id}/tags` | write |
| `studio.slot_materials` | `GET /api/studio/slots/{slot_id}/materials` (brief + eligible materials) | read |
| `studio.calendar_list` | `GET /api/studio/calendar` (`?year`) | read |
| `studio.shoot_list` | `GET /api/studio/shoot-requests` | read |
| `studio.shoot_request` | `POST /api/studio/shoot-requests` | write |
| `studio.shoot_resolve` | `POST /api/studio/shoot-requests/{request_id}/resolve` | write |

Panel only (D4: a human's decision; owner or manager, `studio.manage`):

| use case | route | risk |
|---|---|---|
| `studio.olay_confirm` | `POST /api/studio/olays/{olay_id}/confirm` | write |
| `studio.material_permission` | `PUT /api/studio/materials/{material_id}/permission` | write |
| `studio.material_free` | `POST /api/studio/materials/{material_id}/free` (`{free: bool}`) | write |
| `studio.material_bind` | `POST /api/studio/materials/{material_id}/bind` | write |
| `studio.material_delete` | `POST /api/studio/materials/{material_id}/delete` (`{confirm}`) | destructive |
| `studio.calendar_set` | `PUT /api/studio/calendar/{key}/{year}` | write |
| `studio.material_policy_set` | `PUT /api/studio/materials/policy` | write |
| `studio.material_check_release` | `POST /api/studio/slots/{slot_id}/material-check/release` | write |

Every write takes a `request_key` (replayed, as Studio's writes are) and an `expected_revision` where it
edits a revisioned record, and writes a ledger entry (`studio.material.*`, `studio.olay.*`,
`studio.shoot.*`, `studio.calendar.set`). Ledger payloads name ids, codes and tags, never titles, notes,
places, client names or captions.

### 5.3 Upload and suggestion

`studio.material_add` takes a file already stored by `studio.file_upload` (the panel uploads, then adds;
an agent may do the same). It reads the file's first bytes for a capture time (§4.2), and answers the
material with `olay_suggestions`: confirmed or proposed olays whose date range contains the capture date
(Istanbul), nearest first. A human confirms by choosing; nothing is bound automatically. Adding requires
`olay_id` or `genel` (real genel: human only); an agent naming an unknown event creates a proposed olay
first.

### 5.4 Planner gate (D1) — superseded by §14

The owner is reworking the posting methodology (per-post preparation lead, no all-at-once weekly planning,
no fixed weekly count, bursts from an olay's new materials). Until it is settled, slot materialization is
unchanged and the gate holds at submission (§5.5) and publish (§5.6). The intended planner behaviour,
to be fitted to the new model:


`studio::planner::plan` keeps its positions and draws. For each organic position it computes the slot
need (§4.5) and runs `select_anchor` at the position's time:

- a pick: the slot is inserted with its brief (`studio_slot_briefs`: material, subject, need), and
  `studio.slot.planned` carries `material_id` and the subject kind;
- no pick: no slot; a `slot:` shoot request is upserted and `studio.slot.unfilled` is written once per
  key. A later run re-plans the position if a material arrived (positions are stable ids).

After positions, the planner upserts the `season:` and `olay:` requests (§4.6) and closes system requests
whose condition now holds.

### 5.5 Submission gate (D1, D2)

`studio.piece_submit` gains a `subject` (default: the slot's brief subject once the planner writes briefs,
§5.4; until then, and for a slot with no brief, the piece must name one). Under the same control fence that already
checks the files, it loads every medium's material and runs §4.3 at the slot's `scheduled_at`:

- any medium not a material → `VALIDATION` `{"field":"media","reason":"not_a_material"}`;
- no anchor → `VALIDATION` `{"reason":"no_eligible_material"}`;
- any refusal → `VALIDATION` `{"reason":"material_refused","refusals":[{material_id, code}]}`;
- otherwise the piece is saved with its material uses (`studio_piece_materials`: piece, slot, revision,
  material, role) and its subject (in the piece's material record, not in the immutable `Piece` JSON).

Caption findings (§7) do not refuse submission; they come back in `slot_get` as `material_check`.

### 5.6 Publish re-check (D1)

`authorize_execution_at`, for a slot target, reloads the piece's material uses and runs §4.3 and §7 at
`now`. Any hard finding, or a caption finding not released for this revision and digest, refuses with
`material_check_hold`. The refusal is a hold, not a failed run (`awaits_human`); `studio.pending` lists a
blocker `material_check_hold` with the findings and `next_action` `fix_piece_or_release` (caption only)
or `fix_piece` (hard). A piece with no recorded material use (submitted before this release) holds with
`no_material`.

## 6. Storage — migration `0021_studio_materials`

Seven tenant tables, `workspace_id` first in every key, ENABLE + FORCE RLS with the `tenant_isolation`
policy of `0009`, composite foreign keys to `workspaces`, `studio_files`, `studio_slots`, `studio_pieces`.
Records keep Studio's `data jsonb` with the columns the rules and indexes need. 74 → 81 tables. Slot
briefs (`studio_slot_briefs`: slot, material, subject, need) wait for the new posting model (§5.4) and its
own migration.

| table | key columns and checks |
|---|---|
| `studio_olays` | `id`, `kind`, `status` (`proposed`/`confirmed`), `starts_on ≤ ends_on`, `occasion` present exactly for season/special_day, `revision > 0` |
| `studio_materials` | `id`, `file_id` (unique per workspace, FK `studio_files`), `olay_id` (FK, null exactly for genel), `binding`, `origin` (`real`/`ai_generated`), `generator` (present exactly for AI), `share`, `freed_at`, `erased_at`, `revision`; a real genel row has `freed_at`; trigger: `origin`, `generator` and `file_id` never change |
| `studio_piece_materials` | `(piece_id, material_id)`, `slot_id`, `revision`, `role` (`anchor`/`support`), FKs to the piece (with its slot) and the material; insert only (trigger refuses update and delete) |
| `studio_calendar_entries` | `(key, year)`, `kind`, `window_start ≤ window_end` or both null, `lead_days` 0–90, `enabled` |
| `studio_shoot_requests` | `id`, `key` (unique per workspace), `status`, `week_start` |
| `studio_material_policy` | one row per workspace: `lead_days` 0–90, `reuse_days` 0–365, `recap_days` 0–365 (defaults 21, 14, 30 when absent) |
| `studio_material_releases` | `(slot_id, revision)`, `findings_digest`, `by` (a user), `at` |

`down` refuses while any `studio_olays`, `studio_materials` or `studio_shoot_requests` row exists (the
owner's materials and their provenance; the data are not recreated by a re-run of `up`), then drops the
tables. A no-op when already reverted.

## 7. Truth check

Deterministic, from structured data only. Text sources: the piece's text, every adaptation's text, and a
TikTok posting screen title when approved. Matching is on a Turkish-folded form (Turkish lowercase,
`ç ğ ı ö ş ü` → `c g i o s u`, whitespace collapsed) at word boundaries. A token shorter than 4
characters is never matched.

Caption findings:
- `names_other_olay`: the title, place or client organization of a confirmed olay other than the subject's
  appears, unless the same token is the subject olay's too (two workshops in one city do not collide).
- `names_material_context`: subject `generic`, and a used material's olay title, place or client appears
  (a freed material cannot claim its event, D8).
- `date_outside_olay`: subject `olay(O)`, and a date in the caption (`16 Kasım`, `16 Kasım 2026`,
  `16.11`, `16.11.2026`, `16/11/2026`) falls outside O's range (a date without a year compares day and
  month against the range's years).
- `date_in_generic`: subject `generic` and a caption date equals a used material's olay date.
- `archive_year_missing`: subject `archive(O)` and O's season year does not appear.
- `client_named_product_only`: a used material is `product_only` and its olay's client organization or
  client person's current name appears.

Hard findings are §4.3's refusals at publish time. Release: a human (owner or manager) releases the
caption findings of one slot revision; the release stores the findings' digest, and any new or changed
finding needs a new release. Hard findings cannot be released: change the piece or the material.

## 8. Agents (MCP)

Agents use the twins of §5.2. The intended loop for the owner's Codex agent:
`studio.pending` → `studio.slot_materials` (brief and eligible materials) → write the caption for the
brief's subject → optional AI support visual: `studio.file_upload` + `studio.material_add`
(`origin: ai_generated, generator: "codex"`, genel) → `studio.piece_submit` with the materials' file ids →
fix any `material_check` finding. Tags: `studio.material_tag` on materials humans upload. Missing
material: `studio.shoot_request`. A poster for an upcoming olay: `material_add` bound to that olay; it
anchors only that olay's announcement until the olay ends (D10). Tool descriptions say what a human must
decide (permission, freeing, confirming).

## 9. KVKK and retention

### 9.1 Personal data

A material whose `depicts` has `face`, `name` or `child`, or whose `people` is not empty, is personal data;
so is an olay's client person link. Tables are tenant-scoped with forced RLS. Ledger entries and logs carry
ids and codes, never titles, notes, places, names or captions.

### 9.2 Erasure

`inbox.people.erase` (same transaction) redacts every material that lists the person in `people`
(`erased_at`, title and tags cleared, share `not_shareable`) and clears the person from every olay's
client link (the organization stays: it is a company, not the person). After commit the erased materials'
files are deleted (best effort; `StudioFilesCleanup` finishes what fails). Pending pieces that show an
erased material hold at publish (§5.6, `erased`).

### 9.3 Retention rule

- A material that is personal data (§9.1) is kept for **24 months after its olay's end** (genel: after its
  upload); `StudioFilesCleanup` then erases it as §9.2 does. The owner may delete earlier at any time.
- A material that is not personal data is kept until the owner deletes it.
- Deleting or erasing keeps the material's id, origin, binding and its `studio_piece_materials` rows
  (evidence of what was published), never its bytes, title or tags.
- Posts already published stay on the provider; the material's "used in" list names them so the owner can
  remove them there. Jeeta does not delete provider posts.

## 10. Panel ("Materyaller", Turkish UI)

A "Materyaller" tab in Growth Studio, phone-first (one column under 640 px, the file input takes
`accept="image/*,video/mp4"` with the camera):

- **Yükle**: pick or shoot, upload, then a short form: olay (suggested from the capture date; pick, or
  create on the spot), paylaşım izni (mandatory radio: paylaşılabilir / paylaşılamaz / sadece ürün), tags
  (prefilled when an agent suggested them).
- **Olaylar**: list (type, dates, place, material counts, "onay bekliyor" for proposed) and detail
  (materials, requests, used-in, confirm).
- **Materyal**: tags and permission editing, free / unfree, rebind, delete, "kullanıldığı yerler".
- **Takvim**: the year's effective calendar, editing a row, entering lunar holiday dates.
- **Çekim listesi**: this week's open requests first, done / dismiss.
- In Today's slot card: the slot's material brief and a `material_check_hold` with its findings and the
  release button (caption findings only).

## 11. Testing

- Domain: eligibility table tests per refusal code; season-year and window edges (yılbaşı across the year,
  anneler/babalar günü computed for several years); selection order and reuse; tag-need parsing; truth
  check tokens, Turkish folding and dates.
- Application (in-memory fakes): **zero materials + approved strategy + no-approval policy → no slots, no
  publications, shoot requests only**; a material appears → the next run plans the slot with its brief;
  submit refusals (not a material, no anchor, other olay, out of season, AI as recap, unset permission);
  publish holds when permission is revoked, the window passes or the olay changes; erasure redacts;
  cleanup keeps live material files and erases retention-expired ones.
- Postgres (CI): the migration up/down/up, down refusing live rows, RLS isolation of every new table, the
  origin trigger, the insert-only piece-materials trigger.
- Archtest: catalog rows, MCP registry and panel routes for the new use cases; panel-only rows have no
  tool; table count 81; SQL scoping.
- Panel (vitest): upload form requires the permission; olay suggestion; çekim listesi actions; TR/EN parity.

## 12. Deploy and migration notes

- One migration, `0021_studio_materials`, new tables only; no backfill. Existing slots have no brief, and
  existing Ready pieces have no material uses: **they hold at publish with `no_material` once this ships.**
  On a workspace that publishes today, re-submit or cancel them; read `studio.pending` on each workspace
  before deploying.
- The gate makes a workspace with no materials quiet by design: the triggers write çekim listesi requests (§14).
- `0021` down refuses once materials exist.

## 13. Auto-ingest (later, not now)

Auto-ingest: photos and videos arriving in the workspace's WhatsApp or mailbox become *proposed* materials
(origin real, permission unset, olay suggested from the conversation and the capture date), queued for a
human's review in the Yükle screen. Nothing ingested is eligible until a human sets the permission and
confirms the olay.

## 14. Olay-driven publishing (replaces weekly slot quotas)

Decided 2026-11-03 (the owner settled the methodology and left the details to the coordinator). The
owner's single requirement: **"I give materials; the system handles everything else in the best way."**
This replaces the weekly slot materialization of `planner.rs` (§5.4 is superseded by this section).

### 14.1 Decisions

| # | Decision |
|---|---|
| D20 | **The unit is a planned post**: format (`story`, `feed_post`, `carousel`, `reel`, `tiktok_video`), channel (an organic capability), `publish_at`, `prep_start_at = publish_at − lead(format)`, its olay (or none for a generic post), its material ids, its subject, the hypothesis the agent chose among the live ones, and its state. It is stored as a Studio slot (`scheduled_at = publish_at`, so the publisher, approvals, the TikTok posting screen, attempts, publications and measurement stay as they are) plus a `studio_posts` row with the rest. |
| D21 | **Leads per format** (per-workspace settings, defaults): story 2 h, feed_post 24 h, carousel 24 h, reel 48 h, tiktok_video 48 h (TikTok needs a human's posting-screen choice). |
| D22 | **No weekly quota.** `sections.cadence.per_week` and the hypotheses' `slots_per_week` are informational expected volume, never enforced. A hypothesis takes posts on a channel when its organic cadence names a content type for that channel (the chain rule `validate_chain` is unchanged); the post's arm is (hypothesis, content type, channel, organic), the content type chosen by the agent among the cadence's, default its first. |
| D23 | **Three triggers create package requests, never posts.** A package request is a work item for agents (`work.pending` kind `studio_package_request`, and `studio.pending`). Triggers: olay (D24), calendar (D25), floor (D26). |
| D24 | **Olay trigger.** When an olay gains confirmed, eligible materials, the trigger waits until 30 minutes (setting `debounce_minutes`) after the last such change to that olay (material added, permission set, olay confirmed), then fires once: 20 photos make one request. The request lists the materials not yet in any request of that olay and the formats that performed best for this olay kind so far (D31). |
| D25 | **Calendar trigger.** At an occasion's `window_start − lead_days` (default 21 days) it requests a package for that occasion's confirmed olay of the season year. No eligible material (or no such olay): a çekim listesi item instead (§4.6 `season:`). |
| D26 | **Floor trigger.** If no feed-format post (feed_post, carousel, reel) was published on a channel for `floor_days` (default 4) and no package request or planned post is pending for it, it requests a package of ONE post built on a generic material (freed or genel), least recently used, freshest first. None: a çekim listesi item. A floor, not a quota. |
| D27 | **The agent proposes; the system validates and materializes.** `studio.package_propose` answers a request with planned posts (format, channel, `publish_at`, materials, subject, hypothesis). Validation is all-or-nothing with a reason per item: request open; channel organic, connected and supporting the format (D30); `publish_at` at least `lead(format)` ahead and within 30 days; not in quiet hours; every material passes §4.3 at `publish_at` as an anchor or support with at least one anchor, and the format's media count; caps and spacing (D29) against everything already planned or published plus the package. Valid: the posts are materialized at once with their prep start; the request is answered. |
| D28 | **Just-in-time preparation.** A planned post enters the agent's pending work only at `prep_start_at`. The agent writes the caption, picks or edits media among eligible materials, and submits the piece (`studio.piece_submit`, gated as §5.5); the truth check runs at submit and at publish. A post not ready (no piece, or for TikTok no posting-screen choice) at `publish_at` may slip within its grace (story +1 h; feed_post, carousel, reel, tiktok_video +6 h; settings). Past grace it is retired `missed_grace`, and the weekly summary names it. |
| D29 | **Protective caps instead of quotas** (per-workspace settings, defaults): feed formats at most 2 per channel per day with at least 3 h between them; stories at most 25 per channel per day, at least 10 min apart (a 20-story package spreads out); tiktok_video at most 3 per day; quiet hours 00:00–08:00 in the workspace's time zone (setting `tz`, default `Europe/Istanbul`). A provider's own API limits are enforced by its adapter and come on top. |
| D30 | **Formats per provider: only what is verified and built.** Each organic kind declares the formats its adapter publishes. Stories by API are **unverified** for every provider until checked against the official documentation and built: Instagram Content Publishing (`media_type=STORIES`), Facebook Page stories, TikTok (no story format is known to this design in its Content Posting API — unverified). Until verified and built, `story` is refused as `format_unsupported` everywhere; nothing is assumed. |
| D31 | **Learning per format × olay kind × hypothesis.** The existing measurements (`studio_measurements`, the arms' posteriors) are aggregated by the post's format, its olay's kind and its hypothesis. Package requests carry the best formats for the olay kind; the floor trigger chooses its hypothesis by the arms' posterior mean. |
| D32 | **Owner UX: no approvals by default.** The owner uploads materials and confirms the olay and the share permission when asked; the structure (material gate, truth check, caps) is the safety. The lane approval policy stays available, off by default; TikTok keeps its posting screen (TikTok's rule). The owner gets the çekim listesi and a weekly summary (`studio.weekly_summary`): published, planned, cancelled, each with its reason. |
| D33 | **Paid lane unchanged** (D13). |
| D34 | **Existing slots retire safely.** On the first run of the new planner, every organic slot still `planned` or `ready` that has no `studio_posts` row is retired with reason `replanned` (a new retirement reason, allowed from planned and ready), one ledger entry each; their pieces, attempts and evidence stay. Published and measured slots are untouched. |

### 14.2 Storage — migration `0022_studio_posts`

- `studio_posts`: the planned post of a slot (`slot_id` PK with the workspace, FK `studio_slots`): `format`,
  `prep_start_at ≤ publish_at`, `grace_until ≥ publish_at`, `olay_id` (FK, nullable), `package_request_id`
  (FK), `data` (materials, subject, content type).
- `studio_package_requests`: `id`, `key` (unique: `olay:{id}:{last_change}`, `calendar:{key}:{year}`,
  `floor:{capability}:{date}`), `trigger`, `status` (`open`, `answered`, `expired`), `data` (materials,
  best formats, hints), `created_at`, `answered_at`. An open request expires after 7 days.
- `studio_posting_policy`: one row per workspace (leads, graces, caps, spacing, quiet hours, `tz`,
  `floor_days`, `debounce_minutes`); defaults when absent.
- `0022` down refuses while a post or package request exists.

### 14.3 Jobs and use cases

- `studio_plan` (every 10 minutes instead of hourly) runs the triggers, retires missed posts and, once,
  the old slots (D34). It never creates a post.
- Twins: `studio.package_requests` (`GET /api/studio/package-requests`), `studio.package_propose`
  (`POST /api/studio/package-requests/{request_id}/proposal`), `studio.posts_list`
  (`GET /api/studio/posts`), `studio.weekly_summary` (`GET /api/studio/summary`). Panel only:
  `studio.posting_policy_set` (`PUT /api/studio/posting-policy`).
- `studio.pending` and `work.pending` list package requests and the planned posts whose prep has started;
  a post before its prep start is listed in `studio.posts_list` only.

### 14.4 Tests to pin

- Zero materials + approved strategy + no-approval policy → no package request but çekim listesi items,
  no post, no publication.
- 20 materials added to one olay within minutes → one package request, 30 minutes after the last.
- A package breaking a cap, the spacing, quiet hours, the lead, a material rule or the channel's formats
  → refused whole, with each item's reason; a valid one → posts with prep starts.
- A post is pending only from its prep start; missed past grace → retired `missed_grace`, in the summary.
- The floor fires after `floor_days` without a feed post and not while a package is pending.
- Old planned and ready slots retire `replanned` once; evidence is kept.

## 15. Questions answered (2026-11-03)

The owner left Q1–Q6 of the first draft to the coordinator, who answered them the same day: Q1 → D13,
Q2 → D16, Q3 → D17, Q4–Q5 → D18, Q6 → D19. No question is open.
