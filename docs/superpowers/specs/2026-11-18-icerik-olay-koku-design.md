# One content module with the olay at its root — design (part 1, server)

Date: 2026-11-18. Status: product decision approved by the owner; this note records the server's
rules and storage. Builds on the materials library (`2026-11-03-studio-materials-design.md`, "spec
2026-11-03") and the content module (`2026-11-10-uc-modul-ve-panel-iskeleti-design.md`, "design
2026-11-10"). Part 2 (the panel page) follows in its own change.

## 1. What changes

"Materyal kütüphanesi" (`/materials`) and "İçerik oluşturma" (`/content`) become one page whose root
object is the **olay**: an olay is a folder holding its files (materials), its "Eksikler" (shoot
requests and the captures its contents asked for) and its contents (production areas), each area
shown as an eight-stage pipeline:

| Stage | Steps | Output shown under a finished stage |
|---|---|---|
| Hazırlık | 1–3 | the steps' one-line outputs (step 3: platform · format) |
| Fikir | 4–6 | step 6: the main message |
| Metin | 7–8 | step 7: the headline |
| Görsel | 9–10 | the materials the steps chose |
| Paket | 11–14 | the current package's versions |
| Onay | — | per planned post: required or not, who approved, when |
| Yayın | — | per planned post: account, time, published at, link |
| Sonuç | — | per publication: the last complete measurement's raw counters |

"Genel" is the permanent folder of everything about no olay: materials bound `genel` and areas with
no olay. It is a presentation of "no olay": no binding or area is migrated into it.

## 2. Decisions

| # | Decision |
|---|---|
| O1 | **Every area may name its olay.** `ProductionProject.olay_id` (document field, `null`: Genel). The olay trigger sets its olay, the calendar trigger the calendar's olay, the floor trigger none; a person creating an area may name one (`studio.project_create` `olay_id`, `NOT_FOUND` for an unknown olay). Area lists (`studio.project_list`, `content.areas`) take `olay_id`: an olay's id, or `genel` for the areas of none. |
| O2 | **Storage of the area's olay.** Migration `0044_content_olay_root` adds `studio_production_projects.olay_id`, a stored column *generated* from the document (it cannot disagree with it), indexed with the workspace and `archived`. No foreign key: olays are never deleted, the use cases check existence, and 0021/0022 stay revertible on their own. |
| O3 | **Backfill.** A system area opened by the olay or calendar trigger before 0044 gets the `olay_id` of the stored `studio_package_requests` row of its trigger key (the area's key is the request's key, design 2026-11-10 §6.3), when that olay exists. Floor areas, areas a person opened and areas with no such request keep none. Revisions are not moved. |
| O4 | **Unfiled is a binding.** `Binding::Unfiled` (`{"kind":"unfiled"}`, column `binding = 'unfiled'`, no olay). Only a person in person (`library::person`, not an agent's key) adds a material with neither `olay_id` nor `genel`; such an upload needs no share permission at once (nothing may use it; the permission is still a person's to give later). Agents name an olay or genel as before. |
| O5 | **Unfiled is never a candidate.** `check_use` refuses it first after erasure (`Refusal::Unfiled`, code `unfiled`), in every role and subject; selection never ranks it; an area refuses it as a source, as a step's material and in `project_materials` (`CONFLICT material_unfiled`). |
| O6 | **Filing by analysis.** `studio.material_analysis_complete` takes an optional `filing`: exactly one of `olay_id`, `new_olay {kind, title, starts_on, ends_on, place?, occasion?, notes?}` or `genel: true` (`VALIDATION one_filing` otherwise), only for an unfiled material (`CONFLICT material_already_filed`). Without a filing the material stays unfiled and the queue shows it as needing filing; a person files it with `studio.material_bind` (which now refuses binding *to* unfiled). The live daily routine (complete without filing) and the Codex job (AI material with an explicit `olay_id`) are unchanged. |
| O7 | **The owner's confirmation rule.** An olay opened by `new_olay` is **confirmed** when the material is live, unfiled, `origin.kind = real` and was added by a person (`Material::upload_confirms_olay`): `confirmed.by` is that person, and the ledger entry `studio.olay.created` carries `confirmed_by_rule: {rule: "person_upload", uploaded_by}`, `opened_by: "material_filing"` and the material's id — the confirmation is the rule's, from that upload, not a click. Otherwise (an AI image, any agent-made olay) it is `proposed` as spec D3 says. Filing into an existing proposed olay does not confirm it. Genel filing of a real material is refused (`FORBIDDEN human_required`, spec D8: a person frees it). Share permission, publishing approval and the people/face/child/logo rules are unchanged. |
| O8 | **The analysis work item says unfiled.** `studio_material_analysis` items carry `unfiled: bool` and, when true, a hint to file with the completion after reading `jeeta.studio.olays_list`. |
| O9 | **Step history.** An area keeps `steps: [{step, note, at, output?, material_ids?}]` for its current attempt, ascending, one per step. `content.area_progress` takes optional `output` (one line, whitespace collapsed, 1–240 characters) and `material_ids` (≤ 20 distinct live, filed materials). A report of step *n* replaces *n* and **drops every later step** (going back means redoing what follows), so a stage never shows an output of work the agent went back on. `progress` still holds the last report. |
| O10 | **Redo versus history.** "Olmamış" (`content.area_redo`) starts a new attempt: the area's steps are cleared, since the package they led to is abandoned; an accepted delivery (agent's or a person's release) copies the steps into the package (`ContentPackage.steps`), so each package keeps the steps that made it. The page shows the area's own steps as current, never a previous package's. A claim (also after a lease ran out) continues the attempt. |
| O11 | **Pipeline states.** Step stages: all `done` while the area holds its current package; else `done` before the stage of the current step, `todo` after, and that stage `current`, `waiting_person` while a capture is awaited, Paket `problem` while the area is held (three refusals). With no step reported a working area is at Hazırlık, one waiting for a capture at Görsel. Onay: `waiting_person` while a planned post waits for an approval (as `studio.pending` asks for it), `current` while no version has a time, else `done`. Yayın: `todo` until Onay is done, `problem` when a post cannot go out (every attempt failed or refused, or retired unsent), `done` once every live post went out, else `current`. Sonuç: `current` once something went out, `done` once every published post is measured. |
| O12 | **Results.** Sonuç shows the provider's own counters of the last complete measurement (`studio_measurements.raw_metrics`) per publication; with none, nothing — no derived or invented numbers. |
| O13 | **One read per view.** `content.tree`, `content.analysis_queue`, `content.areas` (panel only) and `content.olay_view` (panel and MCP) read the page without N+1 calls from the panel (§3). |

## 3. Surface

| Use case | Route | Tool | Permission |
|---|---|---|---|
| `content.tree` | `GET /api/content/tree` | — | `materials.work`, `content.work` or `content.manage` |
| `content.analysis_queue` | `GET /api/content/analysis-queue` | — | `materials.work` |
| `content.areas` | `GET /api/content/areas` (`scope`, cursors, `archived`, `olay_id`) | — | `content.work` or `content.manage` |
| `content.olay_view` | `GET /api/content/olays/{olay_id or genel}` | `jeeta.content.olay_view` | any of the three; `contents` needs a content permission and `files` `materials.work` (each `null` otherwise) |

The tree lists every olay with its live file count, area count, published count and why it waits
for a person (`olay_proposed`, `shoot_request`, `material_request`, `content_approval`,
`content_problem`); the Genel folder; the calendar's special days whose window ends today or later
and starts within 120 days with no olay of their occasion and season year; the analysis queue's size
(unfiled materials, and filed ones whose analysis waits or runs); and "Sizi bekleyenler"
(`olay_confirmations`, `shoot_requests` = open çekim listesi items + open area capture requests,
`content_approvals`, `problem_contents`). An olay's "Eksikler" are the çekim listesi's requests for
it (an upcoming olay's; a season's request of its occasion and season year) and its areas' capture
requests, open ones and those resolved in the last 30 days; Genel's are the workspace-wide requests.

## 4. Migration `0044_content_olay_root`

Additive: widens `studio_materials_binding_check` to `unfiled`, adds the generated column and its
index, backfills O3. Its down refuses while a material is unfiled, an area a person opened names an
olay, or an area or package holds reported steps; otherwise it drops the column and index and
narrows the check again.
