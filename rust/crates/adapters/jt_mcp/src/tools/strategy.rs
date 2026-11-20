//! `jeeta.strategy.get`, `jeeta.strategy.knowledge_get`, `jeeta.strategy.start_consultation`,
//! `jeeta.strategy.record`, `jeeta.strategy.write_section`, `jeeta.strategy.set_hypotheses`,
//! `jeeta.strategy.submit`, `jeeta.strategy.approve`, `jeeta.strategy.archive`,
//! `jeeta.strategy.list_versions` and `jeeta.strategy.consultation`; and the agents' side of the
//! knowledge base: `jeeta.strategy.frame_apply`, `note_claim`, `note_file`, `note_release` and
//! `proposal_create`.
//!
//! The knowledge base (design 2026-11-19 §4) is read with `knowledge_get`; `get` answers it in
//! the shape older routines read the strategy (§5.4). The consultation tools stay for those
//! routines until they move (they are retired in the design's PR 7) and work on the internal
//! frame; an approval through them keeps the knowledge base equal (§4.3.4).
//!
//! Reading needs `workspace.read`; the agents' tools need a work permission (`frame_apply` the
//! one of each part it derives, which the use case checks); every consultation change needs
//! `team.manage` (approving and archiving also
//! the role owner or manager, which the use cases check). The arguments mirror the panel's
//! bodies; a section and the hypotheses are passed through as written, for the use cases' strict
//! parsers to judge.

use jt_app::ctx::Ctx;
use jt_app::usecases::Deps;
use jt_app::usecases::knowledge::{self, derive, notes, proposals};
use jt_app::usecases::strategy::{
    self, ApproveInput, ArchiveInput, DEFAULT_CONSULTATION_PAGE, RecordInput, RecordKind,
};
use jt_strategy::{ConsultationEntryId, Sections, StrategyVersionId};
use jt_tenancy::Permission;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{NoArgs, ToolDef, args, listed, to_json};
use crate::registry::{ToolFuture, schema_for};

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "strategy.get",
            description: "Read the knowledge base in the shape older routines read the \
                          strategy: approved.sections.identity (product, voice and positioning \
                          from the owner's cards), prohibitions and goals (the owner's rules \
                          and goals), audience and prospecting (derived), hypotheses (the \
                          topics), and knowledge (everything jeeta.strategy.knowledge_get \
                          answers; null until the knowledge base is set up, which reading \
                          jeeta.strategy.knowledge_get does). approved is null until the \
                          knowledge base has a card. The owner's edits apply at once: nothing \
                          here waits for an approval. Prefer jeeta.strategy.knowledge_get. \
                          [risk: READ]",
            permissions: &[Permission::WorkspaceRead],
            schema: schema_for::<NoArgs>,
            run: get,
        },
        ToolDef {
            use_case: "strategy.knowledge_get",
            description: "Read the knowledge base the owner keeps for agents: every card (key, \
                          title, body, attachments with short-lived links), the rules no agent \
                          may cross (prohibitions, the ad budget, the paid-message limit, which \
                          accounts' posts wait for the owner's approval), the goals, the notes \
                          the owner wrote (open ones bind at once, before they are filed), the \
                          pending proposals, and the frame (its number, the knowledge revision \
                          each part was derived from, which derivations are due, its audience, \
                          objective, topics with has_posts, closing topics and prospecting). \
                          Topic ids are what tools that ask for a hypothesis_id take. The \
                          owner's edits apply at once: read this at the start of every run. \
                          [risk: READ]",
            permissions: &[Permission::WorkspaceRead],
            schema: schema_for::<NoArgs>,
            run: knowledge_get,
        },
        ToolDef {
            use_case: "strategy.frame_apply",
            description: "Apply what you derived from the knowledge base to the frame the \
                          engine works from. Send kb_revision as you read it \
                          (jeeta.strategy.knowledge_get revision) and parts, the derivations you \
                          answer: posting (audience, objective, topics; needs content.work) and \
                          prospecting (prospecting: icp, rubric, segments; needs \
                          prospects.work). Send only what changed: a topic that stays is sent with \
                          the same id, title, segment_key, angle and metric as knowledge_get \
                          frame.topics has it (leave out has_posts, and send cadence only for \
                          its organic lane); a segment or ICP entry that stays keeps its key and \
                          words; a part listed with nothing else is acknowledged as \
                          unchanged (applied false) and clears its knowledge_derive item. \
                          Topics: send every topic that should stay, with its id; one left out \
                          gets no new post, is listed under closing while it has planned posts \
                          (posts a person approved stay as they are), and is retired by the \
                          system after them. A segment a row still uses is kept for you \
                          (kept_segments). Identity, channels, prohibitions, goals and budgets \
                          are not yours: the system takes them from the cards and the owner's \
                          rules. paid_cadence (needs ads.work) sets the paid cadence of named \
                          topics and retires nothing; it may be sent alone, with parts empty. \
                          Refusals: CONFLICT kb_revision_ahead or derivation_stale (read \
                          jeeta.strategy.knowledge_get again and derive again), CONFLICT \
                          knowledge_empty (nothing to derive yet), VALIDATION with details.gaps \
                          naming your input's paths, part_not_listed, part_permission. A replay \
                          of request_key answers the first answer. [risk: WRITE]",
            permissions: &[
                Permission::ContentWork,
                Permission::ProspectsWork,
                Permission::AdsWork,
            ],
            schema: frame_apply_schema,
            run: frame_apply,
        },
        ToolDef {
            use_case: "strategy.note_claim",
            description: "Claim a note the owner wrote to the agents (a knowledge_note item of \
                          jeeta.work.pending) at expected_revision; the answer carries a \
                          claim_token, until when it lasts (30 minutes) and the note (text, \
                          links, file ids; jeeta.strategy.knowledge_get gives the files' \
                          short-lived links). Another agent's live claim is CONFLICT \
                          note_claimed with its until. Close it with jeeta.strategy.note_file, \
                          or give it back with jeeta.strategy.note_release. [risk: WRITE]",
            permissions: knowledge::WORK_PERMISSIONS,
            schema: note_claim_schema,
            run: note_claim,
        },
        ToolDef {
            use_case: "strategy.note_file",
            description: "Close the note you claimed with what it asks, as the owner's own \
                          words, in one call: cards (at most three: an existing card's whole \
                          new body at its expected_revision, keeping everything the owner \
                          wrote, or {new: {title, body}} when no card fits), attachments (the \
                          note's own files or links onto a card you file, by its index in \
                          cards), rules (a prohibition the owner states), goals (a goal the \
                          owner states), post_request ({}: the owner asks for a post; it opens \
                          a content as if the owner wrote the note on the Paylasimlar page: the \
                          note's text its brief, the note's images and MP4 videos its files, \
                          PDFs staying knowledge; the note records the content), proposals (ids \
                          of proposals you made with \
                          jeeta.strategy.proposal_create for this note, after it was written, \
                          for what you inferred and the owner did not say; each still waiting \
                          for the owner). summary is one line in Turkish the owner reads under the \
                          note. Dismiss ({dismiss: {reason}}, a reason in Turkish that \
                          says where the answer is) only a note with nothing to act on. The ad \
                          budget, the message limit and the approval switch are the owner's \
                          alone: a note asking to change them is dismissed with a reason that \
                          sends the owner to Kurallar. Refusals: CONFLICT filing_removes_text \
                          (keep what the owner wrote), card_changed (read the card again and \
                          file again), note_withdrawn, not_claimed (claim it again), \
                          proposal_closed (the owner decided it or it expired), \
                          module_not_installed (no content module for a post_request: dismiss \
                          the note saying so); VALIDATION note_too_long (a post_request takes \
                          at most 2000 characters: file it as a card or dismiss it); NOT_FOUND \
                          no_such_proposal (not yours, or made before the note). A filing \
                          that changes a card the frame is derived from makes a \
                          knowledge_derive item: call jeeta.work.pending again after it. \
                          [risk: WRITE]",
            permissions: knowledge::WORK_PERMISSIONS,
            schema: note_file_schema,
            run: note_file,
        },
        ToolDef {
            use_case: "strategy.note_release",
            description: "Give a note you claimed back unfiled, with its claim_token: it is \
                          open again for any agent. [risk: WRITE]",
            permissions: knowledge::WORK_PERMISSIONS,
            schema: note_release_schema,
            run: note_release,
        },
        ToolDef {
            use_case: "strategy.proposal_create",
            description: "Propose to the owner a change you learned while working and the \
                          owner did not say: kind card_new (title and body), card_edit (card_id \
                          and the card's whole new body, optionally a title), rule_add (one \
                          prohibition, at most 500 characters) or goal_add (one goal, at most \
                          300), with a one-line reason in Turkish. Nothing changes until the \
                          owner adds it in Bilgi bankasi; it closes by itself after 14 days. At \
                          most 20 pending, 10 a day from one connection (CONFLICT \
                          too_many_proposals, proposal_rate); the same proposal pending twice is \
                          CONFLICT proposal_exists. A replay of request_key answers the same \
                          proposal. [risk: WRITE]",
            permissions: knowledge::WORK_PERMISSIONS,
            schema: proposal_create_schema,
            run: proposal_create,
        },
        ToolDef {
            use_case: "strategy.start_consultation",
            description: "Retired soon: the strategy is the knowledge base now; read \
                          jeeta.strategy.knowledge_get and apply with jeeta.strategy.frame_apply. \
                          Open the consultation: a new draft version, copied from the approved \
                          version (its hypotheses kept) or empty when none is approved. While a \
                          draft is open, returns that draft instead and changes nothing. Returns \
                          the draft with its gaps. [risk: WRITE]",
            permissions: &[Permission::TeamManage],
            schema: schema_for::<NoArgs>,
            run: start_consultation,
        },
        ToolDef {
            use_case: "strategy.record",
            description: "Retired soon: the strategy is the knowledge base now; read \
                          jeeta.strategy.knowledge_get and apply with jeeta.strategy.frame_apply. \
                          Record a question put to the owner, the owner's answer, an assumption \
                          made without an answer, or a note in the open draft's consultation \
                          log, optionally about one section. Returns {id}. [risk: WRITE]",
            permissions: &[Permission::TeamManage],
            schema: schema_for::<RecordArgs>,
            run: record,
        },
        ToolDef {
            use_case: "strategy.write_section",
            description: "Retired soon: the strategy is the knowledge base now; read \
                          jeeta.strategy.knowledge_get and apply with jeeta.strategy.frame_apply. \
                          Write one section of the open draft, replacing it. Values by \
                          section_key: identity {product, voice, positioning, usp}; audience \
                          [{key, name, description}] (key: 2 to 32 of a-z, 0-9, _); channels \
                          [{channel, rationale, group_id?}] (channel: a capability kind or \
                          \"any\"); goals {objective, kpis: [{name, target}]}; budget_frame \
                          {lanes: [{lane: organic|paid, period: weekly|monthly, cap_minor, \
                          currency}]}; prohibitions [text]; cadence {per_week, channel_mix: \
                          [{channel, share_pct}]}; paid_enabled true|false; prospecting {icp: \
                          [{key, segment_key, sectors, areas: [{city, district?}], signals, \
                          exclusions, size_hint, language?, daily_cap 1-200, backlog_target}], \
                          rubric: {criteria: [{key, description, weight}] (weights sum to 100), \
                          qualify_at 1-100}} (no icp entry: prospecting is off). An unknown \
                          field, a \
                          lane without lane or period, and a text over its cap (identity fields, \
                          rationale, description and objective 2000 characters; names, keys, \
                          channels and KPI targets 200; each prohibition 500) are refused with \
                          details.gaps; other missing content is allowed and listed in the \
                          returned draft's gaps. Editing withdraws a submission. [risk: WRITE]",
            permissions: &[Permission::TeamManage],
            schema: schema_for::<WriteSectionArgs>,
            run: write_section,
        },
        ToolDef {
            use_case: "strategy.set_hypotheses",
            description: "Retired soon: the strategy is the knowledge base now; read \
                          jeeta.strategy.knowledge_get and apply with jeeta.strategy.frame_apply. \
                          Replace the open draft's hypotheses: each one says which audience \
                          segment responds to which angle on which channel, measured by a \
                          metric, with a prior confidence from 0 to 1. Give the id of a \
                          hypothesis to keep it; leave the id out to add a new one; one of the \
                          approved version left out is retired. A hypothesis posts on social \
                          accounts only with an organic cadence: leave cadence out and, when \
                          the strategy posts (cadence.per_week above zero), submitting gives it \
                          the default (it posts, with the one content type general); give \
                          cadence.organic to name its own content types, or with \
                          slots_per_week 0 to say it does not post. Returns the draft with its \
                          gaps. Editing withdraws a submission. [risk: WRITE]",
            permissions: &[Permission::TeamManage],
            schema: schema_for::<SetHypothesesArgs>,
            run: set_hypotheses,
        },
        ToolDef {
            use_case: "strategy.submit",
            description: "Retired soon: the strategy is the knowledge base now; read \
                          jeeta.strategy.knowledge_get and apply with jeeta.strategy.frame_apply. \
                          Submit the open draft for approval by the owner or a manager. A draft \
                          with gaps is refused with details.gaps. Returns the submitted draft. \
                          [risk: WRITE]",
            permissions: &[Permission::TeamManage],
            schema: schema_for::<NoArgs>,
            run: submit,
        },
        ToolDef {
            use_case: "strategy.approve",
            description: "Retired soon: the strategy is the knowledge base now; read \
                          jeeta.strategy.knowledge_get and apply with jeeta.strategy.frame_apply. \
                          Approve the submitted draft, putting it in force and archiving the \
                          version it replaces; this opens the strategy gate. Only for a key of \
                          an owner or a manager; call it only once the owner has said to \
                          approve. Before approving, read the draft's assumptions \
                          (strategy.get -> draft.assumptions) to the owner and approve only after \
                          they confirm. Name the draft as you read it: version_id and \
                          submitted_at from jeeta.strategy.get (draft.id, draft.submitted_at) or \
                          jeeta.work.pending; a draft that changed since is refused with \
                          CONFLICT, so read it again. Returns the approved version. \
                          [risk: WRITE]",
            permissions: &[Permission::TeamManage],
            schema: schema_for::<ApproveArgs>,
            run: approve,
        },
        ToolDef {
            use_case: "strategy.archive",
            description: "Retired soon: the strategy is the knowledge base now; read \
                          jeeta.strategy.knowledge_get and apply with jeeta.strategy.frame_apply. \
                          Archive the approved version in force, named by version_id (from \
                          jeeta.strategy.get), without a successor: the strategy gate closes \
                          and gated tools stop until another version is approved. Only for a \
                          key of an owner or a manager, and only with confirm: true. An open \
                          draft stays open. [risk: DESTRUCTIVE]",
            permissions: &[Permission::TeamManage],
            schema: schema_for::<ArchiveArgs>,
            run: archive,
        },
        ToolDef {
            use_case: "strategy.list_versions",
            description: "Retired soon: the strategy is the knowledge base now; read \
                          jeeta.strategy.knowledge_get and apply with jeeta.strategy.frame_apply. \
                          List every version of the workspace's strategy, newest first, with \
                          its number, status and dates. Returns {versions: [...]}. \
                          [risk: READ]",
            permissions: &[Permission::WorkspaceRead],
            schema: schema_for::<NoArgs>,
            run: list_versions,
        },
        ToolDef {
            use_case: "strategy.consultation",
            description: "Retired soon: the strategy is the knowledge base now; read \
                          jeeta.strategy.knowledge_get and apply with jeeta.strategy.frame_apply. \
                          Read one page of a version's consultation log, newest first: the \
                          questions, answers, assumptions, notes, section drafts, submission, \
                          approval and archiving. Page back with before_at and before_id set to \
                          the at and id of the previous page's last entry. Returns \
                          {entries: [...]}. [risk: READ]",
            permissions: &[Permission::WorkspaceRead],
            schema: schema_for::<ConsultationArgs>,
            run: consultation,
        },
    ]
}

/// What an entry records.
#[derive(Clone, Copy, Debug, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
#[schemars(inline)]
enum EntryKind {
    Question,
    Answer,
    Assumption,
    Note,
}

impl From<EntryKind> for RecordKind {
    fn from(kind: EntryKind) -> Self {
        match kind {
            EntryKind::Question => RecordKind::Question,
            EntryKind::Answer => RecordKind::Answer,
            EntryKind::Assumption => RecordKind::Assumption,
            EntryKind::Note => RecordKind::Note,
        }
    }
}

/// One consultation entry.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct RecordArgs {
    /// question, answer, assumption or note.
    kind: EntryKind,
    /// The section the entry is about, if any.
    #[serde(default)]
    #[schemars(schema_with = "optional_section_key_schema")]
    section_key: Option<String>,
    /// The text, 1 to 20000 characters.
    text: String,
}

/// One section and its value.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct WriteSectionArgs {
    /// Which section.
    #[schemars(schema_with = "section_key_schema")]
    section_key: String,
    /// The section's whole value, shaped as the description says for its key.
    value: Value,
}

/// The draft's hypotheses.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct SetHypothesesArgs {
    /// Every hypothesis of the draft, in order.
    #[schemars(schema_with = "hypotheses_schema")]
    hypotheses: Value,
}

/// The draft to approve, as it was read.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ApproveArgs {
    /// The draft's id (draft.id from jeeta.strategy.get).
    version_id: Uuid,
    /// The draft's submitted_at, exactly as jeeta.strategy.get answered it.
    #[schemars(schema_with = "date_time_schema")]
    submitted_at: String,
}

/// The JSON Schema of an RFC 3339 time.
fn date_time_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "string", "format": "date-time" })
}

/// The version to archive.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ArchiveArgs {
    /// The id of the approved version in force, from jeeta.strategy.get.
    version_id: Uuid,
    /// Must be true: archiving closes the strategy gate.
    #[serde(default)]
    confirm: bool,
}

/// Which log, and which page of it.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ConsultationArgs {
    /// The version, from jeeta.strategy.get or jeeta.strategy.list_versions.
    version_id: Uuid,
    /// At most this many entries: 1 to 500, default 50.
    #[schemars(range(min = 1, max = 500))]
    limit: Option<u32>,
    /// The at of the previous page's last entry; given together with before_id.
    #[serde(default)]
    #[schemars(schema_with = "super::optional_date_time_schema")]
    before_at: Option<String>,
    /// The id of the previous page's last entry; given together with before_at.
    before_id: Option<Uuid>,
}

/// The JSON Schema of a section key, naming every key there is.
fn section_key_schema(_: &mut SchemaGenerator) -> Schema {
    json_schema!({ "type": "string", "enum": Sections::KEYS })
}

/// [`section_key_schema`], or null.
fn optional_section_key_schema(_: &mut SchemaGenerator) -> Schema {
    let mut keys: Vec<Value> = Sections::KEYS.iter().map(|k| json!(k)).collect();
    keys.push(Value::Null);
    json_schema!({ "type": ["string", "null"], "enum": keys })
}

/// The JSON Schema of a list of hypotheses as written. Like `HypothesisInput`, which reads them,
/// it asks for no field (a missing one is empty, and the use case lists what a hypothesis lacks
/// as gaps) and takes a null `id` for a new hypothesis; it still refuses unknown fields.
fn hypotheses_schema(_: &mut SchemaGenerator) -> Schema {
    Schema::try_from(strategy::hypotheses_schema()).expect("valid hypothesis schema")
}

fn get<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&strategy::get(deps, ctx).await?)
    })
}

fn knowledge_get<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&jt_app::usecases::knowledge::read::knowledge_get(deps, ctx).await?)
    })
}

fn start_consultation<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&strategy::start_consultation(deps, ctx).await?)
    })
}

fn record<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let RecordArgs {
            kind,
            section_key,
            text,
        } = args(raw)?;
        let input = RecordInput {
            kind: kind.into(),
            section_key,
            text,
        };
        let id = strategy::record(deps, ctx, input).await?;
        Ok(json!({ "id": id }))
    })
}

fn write_section<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let WriteSectionArgs { section_key, value } = args(raw)?;
        to_json(&strategy::write_section(deps, ctx, section_key, value).await?)
    })
}

fn set_hypotheses<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let SetHypothesesArgs { hypotheses } = args(raw)?;
        to_json(&strategy::set_hypotheses(deps, ctx, hypotheses).await?)
    })
}

fn submit<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&strategy::submit(deps, ctx).await?)
    })
}

fn approve<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let ApproveArgs {
            version_id,
            submitted_at,
        } = args(raw)?;
        let input = ApproveInput::parse(StrategyVersionId(version_id), &submitted_at)?;
        to_json(&strategy::approve(deps, ctx, input).await?)
    })
}

fn archive<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let ArchiveArgs {
            version_id,
            confirm,
        } = args(raw)?;
        let input = ArchiveInput {
            version_id: StrategyVersionId(version_id),
            confirm,
        };
        strategy::archive(deps, ctx, input).await?;
        Ok(json!({ "version_id": version_id, "archived": true }))
    })
}

fn list_versions<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        listed("versions", &strategy::list_versions(deps, ctx).await?)
    })
}

fn consultation<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let ConsultationArgs {
            version_id,
            limit,
            before_at,
            before_id,
        } = args(raw)?;
        let before = strategy::consultation_cursor(
            before_at.as_deref(),
            before_id.map(ConsultationEntryId),
        )?;
        let limit = limit.unwrap_or(DEFAULT_CONSULTATION_PAGE);
        let entries =
            strategy::consultation(deps, ctx, StrategyVersionId(version_id), limit, before).await?;
        listed("entries", &entries)
    })
}

// ---------------------------------------------------------------------------------------------
// The agents' side of the knowledge base (design 2026-11-19 §5.1)
// ---------------------------------------------------------------------------------------------

/// A segment of the audience, as `knowledge_get` frame.audience has it.
fn segment_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["key", "name", "description"],
        "properties": {
            "key": { "type": "string", "description": "2 to 32 of a-z, 0-9, _" },
            "name": { "type": "string" },
            "description": { "type": "string" }
        }
    })
}

/// A cadence of one lane: posts a week and the content types' shares.
fn cadence_schema() -> Value {
    json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["slots_per_week", "content_types"],
        "properties": {
            "slots_per_week": { "type": "integer", "minimum": 0 },
            "exploration_bps": { "type": "integer", "minimum": 0, "maximum": 10000 },
            "content_types": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["key", "min_bps", "max_bps"],
                    "properties": {
                        "key": { "type": "string" },
                        "min_bps": { "type": "integer", "minimum": 0, "maximum": 10000 },
                        "max_bps": { "type": "integer", "minimum": 0, "maximum": 10000 }
                    }
                }
            }
        }
    })
}

/// `jeeta.strategy.frame_apply`'s arguments. The shapes of ICP entries and the rubric are those
/// of `knowledge_get` frame.prospecting (and of `jeeta.prospects.playbook`'s workspace section).
fn frame_apply_schema() -> Schema {
    let schema = json!({
        "type": "object",
        "additionalProperties": false,
        "required": ["request_key", "kb_revision"],
        "properties": {
            "request_key": { "type": "string", "minLength": 1, "maxLength": 128 },
            "kb_revision": {
                "type": "integer", "minimum": 0,
                "description": "The revision of jeeta.strategy.knowledge_get you derived from."
            },
            "parts": {
                "type": "array",
                "items": { "type": "string", "enum": ["posting", "prospecting"] },
                "description": "The derivations this call answers; empty only with paid_cadence."
            },
            "audience": {
                "type": "array", "items": segment_schema(),
                "description": "posting: every segment, kept ones exactly as frame.audience has them."
            },
            "objective": { "type": "string", "maxLength": 2000, "description": "posting" },
            "topics": {
                "type": "array",
                "maxItems": 30,
                "description": "posting: every topic that should stay (with its id) and the new ones (no id).",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["title", "segment_key", "angle", "metric"],
                    "properties": {
                        "id": { "type": ["string", "null"], "format": "uuid" },
                        "title": { "type": "string" },
                        "segment_key": { "type": "string" },
                        "angle": { "type": "string" },
                        "metric": { "type": "string" },
                        "prior_confidence": { "type": ["number", "null"], "minimum": 0, "maximum": 1 },
                        "cadence": {
                            "type": ["object", "null"],
                            "additionalProperties": false,
                            "properties": { "organic": cadence_schema() },
                            "description": "Organic only; leave it out to keep the topic's own (or the default for a new one)."
                        }
                    }
                }
            },
            "prospecting": {
                "type": "object",
                "required": ["icp", "rubric"],
                "description": "prospecting: icp (entries {key, segment_key, sectors, areas, signals, exclusions, size_hint, language?, daily_cap, backlog_target}), rubric ({criteria: [{key, description, weight}] summing to 100, qualify_at}) and segments (new audience segments the entries name).",
                "properties": {
                    "icp": { "type": "array", "items": { "type": "object" } },
                    "rubric": { "type": "object" },
                    "segments": { "type": "array", "items": segment_schema() }
                }
            },
            "paid_cadence": {
                "type": "array",
                "description": "ads.work: the paid cadence of named live topics; retires nothing.",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["topic_id", "cadence"],
                    "properties": {
                        "topic_id": { "type": "string", "format": "uuid" },
                        "cadence": cadence_schema()
                    }
                }
            }
        }
    });
    Schema::try_from(schema).expect("valid frame_apply schema")
}

fn note_claim_schema() -> Schema {
    json_schema!({
        "type": "object",
        "additionalProperties": false,
        "required": ["note_id", "expected_revision"],
        "properties": {
            "note_id": { "type": "string", "format": "uuid" },
            "expected_revision": { "type": "integer", "minimum": 1 }
        }
    })
}

fn note_release_schema() -> Schema {
    json_schema!({
        "type": "object",
        "additionalProperties": false,
        "required": ["note_id", "claim_token"],
        "properties": {
            "note_id": { "type": "string", "format": "uuid" },
            "claim_token": { "type": "string" }
        }
    })
}

fn note_file_schema() -> Schema {
    json_schema!({
        "type": "object",
        "additionalProperties": false,
        "required": ["note_id", "claim_token"],
        "properties": {
            "note_id": { "type": "string", "format": "uuid" },
            "claim_token": { "type": "string" },
            "request_key": {
                "type": "string", "minLength": 1, "maxLength": 128,
                "description": "Required to file; a dismissal needs none."
            },
            "summary": {
                "type": "string", "minLength": 1, "maxLength": 300,
                "description": "One line in Turkish the owner reads under the note."
            },
            "cards": {
                "type": "array",
                "maxItems": 3,
                "items": {
                    "oneOf": [
                        {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["card_id", "expected_revision", "body"],
                            "properties": {
                                "card_id": { "type": "string", "format": "uuid" },
                                "expected_revision": { "type": "integer", "minimum": 1 },
                                "title": { "type": "string", "maxLength": 80 },
                                "body": {
                                    "type": "string", "maxLength": 8000,
                                    "description": "The card's whole new body, keeping what the owner wrote."
                                }
                            }
                        },
                        {
                            "type": "object",
                            "additionalProperties": false,
                            "required": ["new"],
                            "properties": {
                                "new": {
                                    "type": "object",
                                    "additionalProperties": false,
                                    "required": ["title", "body"],
                                    "properties": {
                                        "title": { "type": "string", "minLength": 1, "maxLength": 80 },
                                        "body": { "type": "string", "maxLength": 8000 }
                                    }
                                }
                            }
                        }
                    ]
                }
            },
            "attachments": {
                "type": "array",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "required": ["card"],
                    "properties": {
                        "card": { "type": "integer", "minimum": 0, "description": "Index in cards." },
                        "file_id": { "type": "string", "format": "uuid" },
                        "url": { "type": "string" }
                    }
                }
            },
            "rules": { "type": "array", "maxItems": 10, "items": { "type": "string", "maxLength": 500 } },
            "goals": { "type": "array", "maxItems": 5, "items": { "type": "string", "maxLength": 300 } },
            "post_request": {
                "type": "object",
                "additionalProperties": false,
                "description": "{} when the owner asks for a post: a content opens as if the owner wrote the note on the Paylasimlar page (the note's text, its images and MP4 videos)."
            },
            "proposals": {
                "type": "array", "maxItems": 5,
                "items": { "type": "string", "format": "uuid" }
            },
            "dismiss": {
                "type": "object",
                "additionalProperties": false,
                "required": ["reason"],
                "properties": { "reason": { "type": "string", "minLength": 1 } }
            }
        }
    })
}

fn proposal_create_schema() -> Schema {
    json_schema!({
        "type": "object",
        "additionalProperties": false,
        "required": ["request_key", "kind", "body", "reason"],
        "properties": {
            "request_key": { "type": "string", "minLength": 1, "maxLength": 128 },
            "kind": { "type": "string", "enum": ["card_new", "card_edit", "rule_add", "goal_add"] },
            "card_id": { "type": "string", "format": "uuid", "description": "card_edit: the card." },
            "title": { "type": "string", "maxLength": 80, "description": "card_new: required." },
            "body": { "type": "string", "minLength": 1, "maxLength": 8000 },
            "reason": {
                "type": "string", "minLength": 1, "maxLength": 300,
                "description": "One line in Turkish."
            }
        }
    })
}

fn frame_apply<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: derive::FrameApplyInput = args(raw)?;
        to_json(&derive::frame_apply(deps, ctx, input).await?)
    })
}

fn note_claim<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: notes::NoteClaimInput = args(raw)?;
        to_json(&notes::note_claim(deps, ctx, input).await?)
    })
}

fn note_file<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: notes::NoteFileInput = args(raw)?;
        to_json(&notes::note_file(deps, ctx, input).await?)
    })
}

fn note_release<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: notes::NoteReleaseInput = args(raw)?;
        to_json(&notes::note_release(deps, ctx, input).await?)
    })
}

fn proposal_create<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: proposals::ProposalCreateInput = args(raw)?;
        to_json(&proposals::proposal_create(deps, ctx, input).await?)
    })
}
