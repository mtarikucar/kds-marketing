//! `jeeta.strategy.get`, `jeeta.strategy.start_consultation`, `jeeta.strategy.record`,
//! `jeeta.strategy.write_section`, `jeeta.strategy.set_hypotheses`, `jeeta.strategy.submit`,
//! `jeeta.strategy.approve`, `jeeta.strategy.archive`, `jeeta.strategy.list_versions` and
//! `jeeta.strategy.consultation`.
//!
//! Reading needs `workspace.read`; every change needs `team.manage` (approving and archiving also
//! the role owner or manager, which the use cases check). The arguments mirror the panel's
//! bodies; a section and the hypotheses are passed through as written, for the use cases' strict
//! parsers to judge.

use jt_app::ctx::Ctx;
use jt_app::usecases::Deps;
use jt_app::usecases::strategy::{
    self, ArchiveInput, DEFAULT_CONSULTATION_PAGE, RecordInput, RecordKind,
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
            description: "Read the workspace's strategy: the approved version in force (null \
                          until one is approved), the draft being worked out (null when none is \
                          open) and the gaps that stop the draft from being approved. Ask the \
                          owner the open questions, record each answer, write sections, set \
                          hypotheses, submit; the owner or a manager approves. Gated tools work \
                          only while a version is approved. [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<NoArgs>,
            run: get,
        },
        ToolDef {
            use_case: "strategy.start_consultation",
            description: "Open the consultation: a new draft version, copied from the approved \
                          version (its hypotheses kept) or empty when none is approved. While a \
                          draft is open, returns that draft instead and changes nothing. Returns \
                          the draft with its gaps. [risk: WRITE]",
            permission: Permission::TeamManage,
            schema: schema_for::<NoArgs>,
            run: start_consultation,
        },
        ToolDef {
            use_case: "strategy.record",
            description: "Record a question put to the owner, the owner's answer, an assumption \
                          made without an answer, or a note in the open draft's consultation \
                          log, optionally about one section. Returns {id}. [risk: WRITE]",
            permission: Permission::TeamManage,
            schema: schema_for::<RecordArgs>,
            run: record,
        },
        ToolDef {
            use_case: "strategy.write_section",
            description: "Write one section of the open draft, replacing it. Values by \
                          section_key: identity {product, voice, positioning, usp}; audience \
                          [{key, name, description}] (key: 2 to 32 of a-z, 0-9, _); channels \
                          [{channel, rationale, group_id?}] (channel: a capability kind or \
                          \"any\"); goals {objective, kpis: [{name, target}]}; budget_frame \
                          {lanes: [{lane: organic|paid, period: weekly|monthly, cap_minor, \
                          currency}]}; prohibitions [text]; cadence {per_week, channel_mix: \
                          [{channel, share_pct}]}; paid_enabled true|false. An unknown field is \
                          refused with details.gaps; missing content is allowed and listed in the \
                          returned draft's gaps. Editing withdraws a submission. \
                          [risk: WRITE]",
            permission: Permission::TeamManage,
            schema: schema_for::<WriteSectionArgs>,
            run: write_section,
        },
        ToolDef {
            use_case: "strategy.set_hypotheses",
            description: "Replace the open draft's hypotheses: each one says which audience \
                          segment responds to which angle on which channel, measured by a \
                          metric, with a prior confidence from 0 to 1. Give the id of a \
                          hypothesis to keep it; leave the id out to add a new one; one of the \
                          approved version left out is retired. Returns the draft with its \
                          gaps. Editing withdraws a submission. [risk: WRITE]",
            permission: Permission::TeamManage,
            schema: schema_for::<SetHypothesesArgs>,
            run: set_hypotheses,
        },
        ToolDef {
            use_case: "strategy.submit",
            description: "Submit the open draft for approval by the owner or a manager. A draft \
                          with gaps is refused with details.gaps. Returns the submitted draft. \
                          [risk: WRITE]",
            permission: Permission::TeamManage,
            schema: schema_for::<NoArgs>,
            run: submit,
        },
        ToolDef {
            use_case: "strategy.approve",
            description: "Approve the submitted draft, putting it in force and archiving the \
                          version it replaces; this opens the strategy gate. Only for a key of \
                          an owner or a manager; call it only once the owner has said to \
                          approve. Returns the approved version. [risk: WRITE]",
            permission: Permission::TeamManage,
            schema: schema_for::<NoArgs>,
            run: approve,
        },
        ToolDef {
            use_case: "strategy.archive",
            description: "Archive the approved version in force, named by version_id (from \
                          jeeta.strategy.get), without a successor: the strategy gate closes \
                          and gated tools stop until another version is approved. Only for a \
                          key of an owner or a manager, and only with confirm: true. An open \
                          draft stays open. [risk: DESTRUCTIVE]",
            permission: Permission::TeamManage,
            schema: schema_for::<ArchiveArgs>,
            run: archive,
        },
        ToolDef {
            use_case: "strategy.list_versions",
            description: "List every version of the workspace's strategy, newest first, with \
                          its number, status and dates. Returns {versions: [...]}. \
                          [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<NoArgs>,
            run: list_versions,
        },
        ToolDef {
            use_case: "strategy.consultation",
            description: "Read one page of a version's consultation log, newest first: the \
                          questions, answers, assumptions, notes, section drafts, submission, \
                          approval and archiving. Page back with before_at and before_id set to \
                          the at and id of the previous page's last entry. Returns \
                          {entries: [...]}. [risk: READ]",
            permission: Permission::WorkspaceRead,
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
    json_schema!({
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "id": {
                    "type": ["string", "null"],
                    "format": "uuid",
                    "description": "The id of a hypothesis to keep; leave it out (or null) to \
                                    add one.",
                },
                "title": { "type": "string" },
                "segment_key": {
                    "type": "string",
                    "description": "The key of one of the audience's segments.",
                },
                "angle": {
                    "type": "string",
                    "description": "What the segment is expected to respond to.",
                },
                "channel": {
                    "type": "string",
                    "description": "One of the strategy's channels, or \"any\".",
                },
                "metric": { "type": "string", "description": "The measure that decides it." },
                "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
            },
            "additionalProperties": false,
        },
    })
}

fn get<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&strategy::get(deps, ctx).await?)
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
        let NoArgs {} = args(raw)?;
        to_json(&strategy::approve(deps, ctx).await?)
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
