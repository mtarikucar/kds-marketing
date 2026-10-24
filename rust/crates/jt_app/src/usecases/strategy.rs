//! The workspace's strategy (spec §5): `strategy.get`, `strategy.start_consultation`,
//! `strategy.record`, `strategy.write_section`, `strategy.set_hypotheses`, `strategy.submit`,
//! `strategy.approve`, `strategy.archive`, `strategy.list_versions` and `strategy.consultation`.
//!
//! A strategy is worked out as a draft version in a recorded consultation: the agent (or a
//! person) opens a draft, records the questions, answers, assumptions and notes, writes the
//! sections and the hypotheses, and submits the draft; an owner or a manager approves it,
//! archiving the version it replaces. An owner or a manager may also archive the version in
//! force without a successor, naming the version they mean, which closes the strategy gate
//! again.
//!
//! **Who may do what.** A key's scopes always narrow its authority: a role alone is never enough.
//! Reading needs `workspace.read`. Running the consultation (starting it, recording, writing
//! sections and hypotheses, submitting) needs `team.manage`, so a custom role holding it may run
//! it, and an agent may only through a key that holds it, whoever issued the key. Approving and
//! archiving need the role `owner` or `manager` (spec K11; an agent acts with its issuer's role),
//! else `FORBIDDEN` with `details.reason = "owner_or_manager"`, and then `team.manage` as well
//! (else `FORBIDDEN` naming it in `details.permission`); no one-time code is asked.
//!
//! **The draft lock.** Every use case that changes the draft reads it through
//! `StrategyRepo::lock_draft` first, in its one tenant bundle, and decides on what that returns;
//! approval and archival then lock the workspace execution frame before moving the approved
//! version. The lock order is draft → workspace frame → approved version. A move that finds the
//! version already moved (`set_status` changed no row) is `CONFLICT` "the version has already
//! moved"; an approval refused by the one-approved rule is `CONFLICT` "another approval won".
//!
//! **Writing is strict, reading is not.** A section or a hypothesis list is parsed with
//! `jt_strategy`'s strict parsers, so an unknown key at any depth or a wrong type is `VALIDATION`
//! listing every problem in `details.gaps` (`[{field, message}]`), and nothing is written. Gaps of
//! completeness do not stop a write; they are answered in `VersionOut::gaps` and stop
//! submission and approval (`VALIDATION`, `details.gaps`). Editing a submitted draft withdraws
//! the submission: an owner approves what was last submitted, never a later edit. Recording an
//! assumption is such an edit too (approval reads the assumptions to the owner), so it withdraws
//! the submission as well.
//!
//! **Hypotheses** keep their identity across versions: a draft starts from the approved version
//! with each hypothesis in force `kept`; a hypothesis written without an id is `added`; one of
//! the approved version left out of a write is `retired` (kept in the list as such).
//!
//! **The record.** Each change writes one ledger entry about the version it changed
//! (`subject.kind = "strategy_version"`), carrying in `strategy_version_id` the version in force
//! when it was made; an approval carries the version it puts in force. Consultation texts stay in
//! the consultation log, which only `workspace.read` reads; the ledger names their kind only.

use std::collections::BTreeSet;

use async_trait::async_trait;
use jt_strategy::{
    ANY_CHANNEL, ConsultationEntry, ConsultationEntryId, ConsultationKind, Gap, Hypothesis,
    HypothesisId, HypothesisInput, HypothesisState, MAX_CONSULTATION_TEXT_CHARS, Sections,
    StrategyVersion, StrategyVersionId, VersionStatus, next_draft_from, parse_hypotheses_strict,
    parse_section_strict, validate_for_approval,
};
use jt_tenancy::{Email, MembershipStatus, Permission, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use super::{Deps, acting_user, invalid, keyset_cursor, ledger_entry};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::{ChannelCatalog, MAX_CONSULTATION_PAGE, StrategyArchivedHook, TenantRepos};

const NO_SUCH_VERSION: &str = "no such strategy version";

// ---------------------------------------------------------------------------------------------
// Inputs and outputs
// ---------------------------------------------------------------------------------------------

/// A strategy version as the strategy page and the agent see it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct VersionOut {
    pub id: StrategyVersionId,
    pub number: i32,
    pub status: VersionStatus,
    pub sections: Sections,
    /// In order, retired ones included.
    pub hypotheses: Vec<Hypothesis>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// When a draft was submitted for approval; `None` while it is not.
    #[serde(with = "time::serde::rfc3339::option")]
    pub submitted_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub approved_at: Option<OffsetDateTime>,
    /// The approver's email, while they are still an active member.
    pub approved_by_email: Option<Email>,
    /// Entries in the version's consultation log.
    pub consultation_count: i64,
    /// For a draft, everything that stops it from being approved today (completeness, the
    /// workspace's channels and the capability groups they are narrowed to, the hypotheses);
    /// empty for any other version.
    pub gaps: Vec<Gap>,
    /// For a draft, the assumptions its consultation recorded (made without the owner's answer),
    /// newest first, at most [`MAX_CONSULTATION_PAGE`]: listed to whoever approves it (spec §5).
    /// Empty for any other version.
    pub assumptions: Vec<ConsultationEntryOut>,
}

/// A consultation log entry as the strategy page and the agent read it: the same shape
/// `strategy.consultation` answers.
pub type ConsultationEntryOut = ConsultationEntry;

/// The strategy in force and the draft being worked out, either of which may be missing.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StrategyOut {
    pub approved: Option<VersionOut>,
    pub draft: Option<VersionOut>,
    /// The draft's gaps; empty without a draft.
    pub gaps: Vec<Gap>,
}

/// A version as the version list shows it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VersionSummary {
    pub id: StrategyVersionId,
    pub number: i32,
    pub status: VersionStatus,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub submitted_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub approved_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub archived_at: Option<OffsetDateTime>,
}

impl From<StrategyVersion> for VersionSummary {
    fn from(v: StrategyVersion) -> Self {
        VersionSummary {
            id: v.id,
            number: v.number,
            status: v.status,
            created_at: v.created_at,
            submitted_at: v.submitted_at,
            approved_at: v.approved_at,
            archived_at: v.archived_at,
        }
    }
}

/// What a caller may record in the consultation log; the other kinds are written by the use
/// cases themselves.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordKind {
    /// A question put to the owner.
    Question,
    /// The owner's answer.
    Answer,
    /// Something assumed without an answer; listed at approval.
    Assumption,
    /// A note, such as a small correction kept within the version.
    Note,
}

impl From<RecordKind> for ConsultationKind {
    fn from(kind: RecordKind) -> Self {
        match kind {
            RecordKind::Question => ConsultationKind::Question,
            RecordKind::Answer => ConsultationKind::Answer,
            RecordKind::Assumption => ConsultationKind::Assumption,
            RecordKind::Note => ConsultationKind::Note,
        }
    }
}

/// What archiving asks for: the approved version meant, and the confirmation a destructive call
/// needs. A missing `confirm` reads as `false`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
pub struct ArchiveInput {
    /// The approved version to archive; another one in force refuses the call.
    pub version_id: StrategyVersionId,
    #[serde(default)]
    pub confirm: bool,
}

/// What approving asks for: the draft the caller read, as it read it. Should the draft have
/// changed since (another draft, or the same one submitted again), the approval is refused, so an
/// owner never approves a draft other than the one they went through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ApproveInput {
    /// The draft's id.
    pub version_id: StrategyVersionId,
    /// The draft's `submitted_at`, as read.
    pub submitted_at: OffsetDateTime,
}

impl ApproveInput {
    /// The input from the two values a caller sends: the draft's id and its `submitted_at` as an
    /// RFC 3339 time, exactly as `strategy.get` answered it. A time that does not parse is
    /// `VALIDATION` naming `submitted_at`. The panel and the MCP tool read their arguments through
    /// it alike.
    pub fn parse(version_id: StrategyVersionId, submitted_at: &str) -> Result<Self, AppError> {
        let submitted_at = OffsetDateTime::parse(submitted_at, &Rfc3339).map_err(|_| {
            invalid(
                "submitted_at",
                "submitted_at must be the draft's submitted_at, an RFC 3339 time",
            )
        })?;
        Ok(ApproveInput {
            version_id,
            submitted_at,
        })
    }
}

/// One entry to record in the draft's consultation log.
#[derive(Clone, Debug, Deserialize)]
pub struct RecordInput {
    pub kind: RecordKind,
    /// The section it is about, one of [`Sections::KEYS`], if any.
    #[serde(default)]
    pub section_key: Option<String>,
    /// Trimmed; 1 to [`MAX_CONSULTATION_TEXT_CHARS`] characters.
    pub text: String,
}

// ---------------------------------------------------------------------------------------------
// Use cases
// ---------------------------------------------------------------------------------------------

/// The approved version and the draft, each with its hypotheses, and the draft's gaps. Needs
/// `workspace.read`.
pub async fn get(deps: &Deps, ctx: &Ctx) -> Result<StrategyOut, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let known = channel_kinds(deps, ctx).await?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let approved = match repos.strategy().current_approved().await? {
        Some(v) => Some(version_out(repos.as_mut(), v, &known).await?),
        None => None,
    };
    let draft = match repos.strategy().current_draft().await? {
        Some(v) => Some(version_out(repos.as_mut(), v, &known).await?),
        None => None,
    };
    let gaps = draft.as_ref().map(|d| d.gaps.clone()).unwrap_or_default();
    Ok(StrategyOut {
        approved,
        draft,
        gaps,
    })
}

/// Opens the next draft and returns it; while a draft is open, returns that one instead and
/// changes nothing. Needs `team.manage`.
///
/// The new draft is numbered after the workspace's highest version. It starts as a copy of the
/// approved version, with its hypotheses in force `kept` (`next_draft_from`), or empty when none
/// is approved. Its log starts with the note "consultation started". Writes
/// `strategy.start_consultation` (payload `number`, `based_on`: the approved version's number or
/// `null`). A draft opened by a concurrent call at the same moment is `CONFLICT`; asking again
/// returns it.
pub async fn start_consultation(deps: &Deps, ctx: &Ctx) -> Result<VersionOut, AppError> {
    require_consultant(ctx)?;
    let known = channel_kinds(deps, ctx).await?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    if let Some(draft) = repos.strategy().lock_draft().await? {
        return version_out(repos.as_mut(), draft, &known).await;
    }
    let approved = repos.strategy().current_approved().await?;
    let (sections, hypotheses) = match &approved {
        Some(v) => {
            let hypotheses = repos.hypotheses().list(v.id).await?;
            next_draft_from(v, &hypotheses)
        }
        None => (Sections::default(), Vec::new()),
    };
    let number = repos.strategy().next_number().await?;
    let draft = StrategyVersion {
        id: StrategyVersionId(deps.ids.uuid()),
        workspace_id: ctx.workspace_id,
        number,
        status: VersionStatus::Draft,
        sections,
        created_at: ctx.now,
        created_by: ctx.actor.clone(),
        submitted_at: None,
        approved_at: None,
        approved_by: None,
        archived_at: None,
    };
    repos
        .strategy()
        .insert(draft.clone())
        .await
        .map_err(|e| match e.code {
            ErrorCode::Conflict => conflict(
                "a consultation was started at the same moment; ask again",
                "started_concurrently",
            ),
            _ => e,
        })?;
    if !hypotheses.is_empty() {
        repos.hypotheses().replace_all(draft.id, hypotheses).await?;
    }
    log(
        repos.as_mut(),
        deps,
        ctx,
        draft.id,
        ConsultationKind::Note,
        None,
        "consultation started".to_owned(),
    )
    .await?;
    let in_force = approved.as_ref().map(|v| v.id);
    append_ledger(
        repos.as_mut(),
        ctx,
        "strategy.start_consultation",
        draft.id,
        in_force,
        json!({ "number": number, "based_on": approved.as_ref().map(|v| v.number) }),
    )
    .await?;
    let out = version_out(repos.as_mut(), draft, &known).await?;
    repos.commit().await?;
    Ok(out)
}

/// Appends a question, answer, assumption or note to the draft's consultation log and returns
/// its id. Needs `team.manage`.
///
/// The text is trimmed and must be 1 to [`MAX_CONSULTATION_TEXT_CHARS`] characters, and a
/// section key one of [`Sections::KEYS`], else `VALIDATION` naming `text` or `section_key`.
/// Without a draft, `CONFLICT` "no draft". Writes `strategy.record` (payload `kind`,
/// `section_key`: never the text, which only the consultation log keeps).
///
/// An assumption recorded against a submitted draft withdraws the submission in the same
/// transaction: approval lists the assumptions to the owner, so a submission stamp read before
/// the assumption must not approve the draft that has it. Then `strategy.submission_withdrawn`
/// is written too (payload `version_id`, `reason: "assumption_recorded"`). A question, an answer
/// or a note leaves the submission standing.
pub async fn record(
    deps: &Deps,
    ctx: &Ctx,
    input: RecordInput,
) -> Result<ConsultationEntryId, AppError> {
    require_consultant(ctx)?;
    let section_key = input.section_key.as_deref().map(section_key).transpose()?;
    let text = consultation_text(&input.text)?;
    let kind = ConsultationKind::from(input.kind);
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let draft = locked_draft(repos.as_mut()).await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    let id = log(
        repos.as_mut(),
        deps,
        ctx,
        draft.id,
        kind,
        section_key.map(str::to_owned),
        text,
    )
    .await?;
    append_ledger(
        repos.as_mut(),
        ctx,
        "strategy.record",
        draft.id,
        in_force,
        json!({ "kind": kind.key(), "section_key": section_key }),
    )
    .await?;
    if kind == ConsultationKind::Assumption && draft.submitted_at.is_some() {
        withdraw_submission(repos.as_mut(), &draft).await?;
        append_ledger(
            repos.as_mut(),
            ctx,
            "strategy.submission_withdrawn",
            draft.id,
            in_force,
            json!({ "version_id": draft.id, "reason": "assumption_recorded" }),
        )
        .await?;
    }
    repos.commit().await?;
    Ok(id)
}

/// Writes the draft's section `section_key` (one of [`Sections::KEYS`], else `VALIDATION` naming
/// `section_key`) and returns the draft. Needs `team.manage`.
///
/// `value` is parsed strictly (`parse_section_strict`): every unknown key and any wrong type is
/// `VALIDATION` with `details.gaps`, and nothing is written. Gaps of completeness do not stop the
/// write; the answer lists them. Without a draft, `CONFLICT` "no draft". A submitted draft is
/// withdrawn from approval. The section as written goes into the consultation log as a section
/// draft. Writes `strategy.write_section` (payload `section_key`, `gaps`: how many the draft has
/// now).
pub async fn write_section(
    deps: &Deps,
    ctx: &Ctx,
    section_key: String,
    value: Value,
) -> Result<VersionOut, AppError> {
    require_consultant(ctx)?;
    let key = self::section_key(&section_key)?;
    let section = parse_section_strict(key, &value)
        .map_err(|gaps| gaps_error("the section is not valid", gaps))?;
    let known = channel_kinds(deps, ctx).await?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let draft = locked_draft(repos.as_mut()).await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    let mut sections = draft.sections.clone();
    section.apply(&mut sections);
    repos
        .strategy()
        .update_sections(draft.id, sections, ctx.now)
        .await?;
    withdraw_submission(repos.as_mut(), &draft).await?;
    log(
        repos.as_mut(),
        deps,
        ctx,
        draft.id,
        ConsultationKind::SectionDraft,
        Some(key.to_owned()),
        section_text(key, &value),
    )
    .await?;
    let out = reread(repos.as_mut(), draft.id, &known).await?;
    append_ledger(
        repos.as_mut(),
        ctx,
        "strategy.write_section",
        draft.id,
        in_force,
        json!({ "section_key": key, "gaps": out.gaps.len() }),
    )
    .await?;
    repos.commit().await?;
    Ok(out)
}

/// Makes `hypotheses` (a JSON list of hypotheses as written, without states) the draft's list
/// and returns the draft. Needs `team.manage`.
///
/// The list is parsed strictly (`parse_hypotheses_strict`). Each entry with an `id` keeps that
/// hypothesis: it is `kept` when the approved version has it (one it had retired comes back),
/// and stays `added` when only this draft has it; any other id is a gap. An entry without an id
/// is a new hypothesis with a fresh id, `added`. Then every hypothesis in force in the approved
/// version that the list leaves out follows as `retired`, as the draft last had it; an added one
/// left out is dropped. An id listed twice and a prior_confidence outside `0.0..=1.0` are gaps too;
/// any gap is `VALIDATION` with `details.gaps` (paths `hypotheses[i].<field>`), and nothing is
/// written. Without a draft, `CONFLICT` "no draft". A submitted draft is withdrawn from
/// approval. Writes `strategy.set_hypotheses` (payload `added`, `retired`, `kept`: how many of
/// each the list has now).
pub async fn set_hypotheses(
    deps: &Deps,
    ctx: &Ctx,
    hypotheses: Value,
) -> Result<VersionOut, AppError> {
    require_consultant(ctx)?;
    let inputs = parse_hypotheses_strict(&hypotheses)
        .map_err(|gaps| gaps_error("the hypotheses are not valid", gaps))?;
    let known = channel_kinds(deps, ctx).await?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let draft = locked_draft(repos.as_mut()).await?;
    let approved = repos.strategy().current_approved().await?;
    let base = match &approved {
        Some(v) => repos.hypotheses().list(v.id).await?,
        None => Vec::new(),
    };
    let current = repos.hypotheses().list(draft.id).await?;
    let list = plan_hypotheses(inputs, &base, &current, || HypothesisId(deps.ids.uuid()))?;
    let count = |state: HypothesisState| list.iter().filter(|h| h.state == state).count();
    let payload = json!({
        "added": count(HypothesisState::Added),
        "retired": count(HypothesisState::Retired),
        "kept": count(HypothesisState::Kept),
    });
    repos.hypotheses().replace_all(draft.id, list).await?;
    withdraw_submission(repos.as_mut(), &draft).await?;
    append_ledger(
        repos.as_mut(),
        ctx,
        "strategy.set_hypotheses",
        draft.id,
        approved.as_ref().map(|v| v.id),
        payload,
    )
    .await?;
    let out = reread(repos.as_mut(), draft.id, &known).await?;
    repos.commit().await?;
    Ok(out)
}

/// Submits the draft for approval and returns it. Needs `team.manage`.
///
/// The draft must have no gap (see [`VersionOut::gaps`]), else `VALIDATION` with `details.gaps`.
/// Without a draft, `CONFLICT` "no draft". Submitting again records the new time. Logs the
/// submission and writes `strategy.submit` (payload `number`).
pub async fn submit(deps: &Deps, ctx: &Ctx) -> Result<VersionOut, AppError> {
    require_consultant(ctx)?;
    let known = channel_kinds(deps, ctx).await?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let draft = locked_draft(repos.as_mut()).await?;
    let in_force = version_in_force(repos.as_mut()).await?;
    let hypotheses = repos.hypotheses().list(draft.id).await?;
    let groups = group_ids(repos.as_mut()).await?;
    let gaps = approval_gaps(&draft.sections, &hypotheses, &known, &groups);
    if !gaps.is_empty() {
        return Err(not_ready(gaps));
    }
    repos
        .strategy()
        .set_submitted(draft.id, Some(ctx.now))
        .await?;
    log(
        repos.as_mut(),
        deps,
        ctx,
        draft.id,
        ConsultationKind::Submitted,
        None,
        format!("version {} submitted for approval", draft.number),
    )
    .await?;
    append_ledger(
        repos.as_mut(),
        ctx,
        "strategy.submit",
        draft.id,
        in_force,
        json!({ "number": draft.number }),
    )
    .await?;
    let out = reread(repos.as_mut(), draft.id, &known).await?;
    repos.commit().await?;
    Ok(out)
}

/// Approves the submitted draft `input.version_id`, as submitted at `input.submitted_at`, putting
/// it in force, and returns it. Needs the role `owner` or `manager` (else `FORBIDDEN`,
/// `details.reason = "owner_or_manager"`) and `team.manage` (else `FORBIDDEN` naming it).
///
/// Without a draft, `CONFLICT` "no draft"; a draft not submitted (or edited since) is `CONFLICT`
/// "not submitted". Once the locks are taken, a draft other than `input.version_id`, or one
/// submitted at another time than `input.submitted_at` (submitted again since it was read), is
/// `CONFLICT` "the draft changed since you read it" with the draft as it stands in
/// `details.version_id` and `details.submitted_at`, and nothing changes. The draft is validated
/// again: any gap is `VALIDATION` with `details.gaps`. In
/// one transaction the approved version, if any, is archived (its log notes it was superseded),
/// the draft becomes the approved version with `approved_by` the user behind the caller (for an
/// agent, the user who issued its key), its log records the approval, and `strategy.approve` is
/// written (payload `number`, `hypotheses`: how many are in force). Should another approval have
/// committed first, `CONFLICT` "another approval won", and nothing changes.
pub async fn approve(deps: &Deps, ctx: &Ctx, input: ApproveInput) -> Result<VersionOut, AppError> {
    require_owner_or_manager(ctx)?;
    let known = channel_kinds(deps, ctx).await?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    // Draft before frame, matching draft edits and archival.
    let draft = locked_draft(repos.as_mut()).await?;
    let previous = repos.strategy().lock_execution_frame().await?;
    if draft.submitted_at.is_none() {
        return Err(conflict("not submitted", "not_submitted"));
    }
    if draft.id != input.version_id || draft.submitted_at != Some(input.submitted_at) {
        return Err(draft_changed(&draft));
    }
    let hypotheses = repos.hypotheses().list(draft.id).await?;
    let groups = group_ids(repos.as_mut()).await?;
    let gaps = approval_gaps(&draft.sections, &hypotheses, &known, &groups);
    if !gaps.is_empty() {
        return Err(not_ready(gaps));
    }
    let by = acting_user(&ctx.actor);
    if let Some(previous) = &previous {
        let moved = repos
            .strategy()
            .set_status(previous.id, VersionStatus::Archived, ctx.now, by)
            .await?;
        ensure_moved(moved)?;
        log(
            repos.as_mut(),
            deps,
            ctx,
            previous.id,
            ConsultationKind::Archived,
            None,
            format!("superseded by version {}", draft.number),
        )
        .await?;
    }
    match repos
        .strategy()
        .set_status(draft.id, VersionStatus::Approved, ctx.now, by)
        .await
    {
        Ok(moved) => ensure_moved(moved)?,
        // The one-approved-version rule: another approval committed first.
        Err(e) if e.code == ErrorCode::Conflict => {
            return Err(conflict("another approval won", "another_approval_won"));
        }
        Err(e) => return Err(e),
    }
    log(
        repos.as_mut(),
        deps,
        ctx,
        draft.id,
        ConsultationKind::Approved,
        None,
        format!("version {} approved", draft.number),
    )
    .await?;
    let in_force = hypotheses.iter().filter(|h| h.state.is_live()).count();
    append_ledger(
        repos.as_mut(),
        ctx,
        "strategy.approve",
        draft.id,
        Some(draft.id),
        json!({ "number": draft.number, "hypotheses": in_force }),
    )
    .await?;
    let change = crate::ports::studio::StrategyChange {
        previous: previous.map(|v| v.id),
        current: Some(draft.id),
        at: ctx.now,
        kept: hypotheses
            .iter()
            .filter(|h| h.state == HypothesisState::Kept)
            .map(|h| h.id)
            .collect(),
        retired: hypotheses
            .iter()
            .filter(|h| h.state == HypothesisState::Retired)
            .map(|h| h.id)
            .collect(),
        added: hypotheses
            .iter()
            .filter(|h| h.state == HypothesisState::Added)
            .map(|h| h.id)
            .collect(),
    };
    deps.transition_hook.apply(repos.as_mut(), &change).await?;
    let out = reread(repos.as_mut(), draft.id, &known).await?;
    repos.commit().await?;
    Ok(out)
}

/// Archives the approved version `input.version_id`, closing the strategy gate until another is
/// approved. Needs the role `owner` or `manager` (else `FORBIDDEN`,
/// `details.reason = "owner_or_manager"`), `team.manage` (else `FORBIDDEN` naming it) and
/// `input.confirm` (else `VALIDATION` naming `confirm`).
///
/// Without an approved version, `CONFLICT` (`details.reason = "no_approved_version"`). When the
/// approved version is not `input.version_id` (say, an approval committed while this call waited
/// for the locks), `CONFLICT` "the approved version changed" with the one in force in
/// `details.approved_version_id`, and nothing changes: an archive never takes down a version its
/// caller did not name. An open draft stays open. Logs the archive in the version's consultation
/// log and writes `strategy.archive` (payload `number`, `version_id`). Once committed,
/// `Deps::archived_hook` is told; its error is returned, though the archive holds.
pub async fn archive(deps: &Deps, ctx: &Ctx, input: ArchiveInput) -> Result<(), AppError> {
    require_owner_or_manager(ctx)?;
    if !input.confirm {
        return Err(invalid(
            "confirm",
            "confirm must be true to archive the approved strategy",
        ));
    }
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    // Draft before frame, including when there is no draft to lock.
    repos.strategy().lock_draft().await?;
    let approved = repos
        .strategy()
        .lock_execution_frame()
        .await?
        .ok_or_else(|| conflict("no approved version", "no_approved_version"))?;
    if approved.id != input.version_id {
        return Err(AppError {
            code: ErrorCode::Conflict,
            message: "the approved version changed".into(),
            details: json!({ "approved_version_id": approved.id }),
        });
    }
    let moved = repos
        .strategy()
        .set_status(
            approved.id,
            VersionStatus::Archived,
            ctx.now,
            acting_user(&ctx.actor),
        )
        .await?;
    ensure_moved(moved)?;
    log(
        repos.as_mut(),
        deps,
        ctx,
        approved.id,
        ConsultationKind::Archived,
        None,
        format!("version {} archived", approved.number),
    )
    .await?;
    append_ledger(
        repos.as_mut(),
        ctx,
        "strategy.archive",
        approved.id,
        Some(approved.id),
        json!({ "number": approved.number, "version_id": approved.id }),
    )
    .await?;
    let retired = repos
        .hypotheses()
        .list(approved.id)
        .await?
        .into_iter()
        .filter(|h| h.state.is_live())
        .map(|h| h.id)
        .collect();
    let change = crate::ports::studio::StrategyChange {
        previous: Some(approved.id),
        current: None,
        kept: Vec::new(),
        added: Vec::new(),
        retired,
        at: ctx.now,
    };
    deps.transition_hook.apply(repos.as_mut(), &change).await?;
    repos.commit().await?;
    deps.archived_hook
        .on_archived(ctx.workspace_id, approved.id)
        .await
}

/// Every version of the workspace's strategy, newest first. Needs `workspace.read`.
pub async fn list_versions(deps: &Deps, ctx: &Ctx) -> Result<Vec<VersionSummary>, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    let versions = repos.strategy().list().await?;
    Ok(versions.into_iter().map(VersionSummary::from).collect())
}

/// One page of version `version_id`'s consultation log, newest first: at most `limit` entries
/// (clamped to `1..=MAX_CONSULTATION_PAGE`) ordered before `before`, the `(at, id)` of the
/// previous page's last entry. Needs `workspace.read`; a version that is not this workspace's is
/// `NOT_FOUND`.
pub async fn consultation(
    deps: &Deps,
    ctx: &Ctx,
    version_id: StrategyVersionId,
    limit: u32,
    before: Option<(OffsetDateTime, ConsultationEntryId)>,
) -> Result<Vec<ConsultationEntry>, AppError> {
    ctx.require(Permission::WorkspaceRead)?;
    let mut repos = deps.uow.tenant(ctx.workspace_id).await?;
    if repos.strategy().find(version_id).await?.is_none() {
        return Err(AppError::not_found(NO_SUCH_VERSION));
    }
    repos.consultation().list(version_id, limit, before).await
}

/// How many consultation entries a page holds when the caller names no limit.
pub const DEFAULT_CONSULTATION_PAGE: u32 = 50;

/// The `before` cursor of [`consultation`] from the two halves a caller sends: `before_at`, an
/// RFC 3339 time as an entry's `at` reads, and `before_id`, that entry's id. Both or neither,
/// else `VALIDATION` naming the missing one; a `before_at` that does not parse is `VALIDATION`
/// naming it. The panel and the MCP tool read their parameters through it alike.
pub fn consultation_cursor(
    before_at: Option<&str>,
    before_id: Option<ConsultationEntryId>,
) -> Result<Option<(OffsetDateTime, ConsultationEntryId)>, AppError> {
    keyset_cursor(before_at, before_id)
}

// ---------------------------------------------------------------------------------------------
// Defaults for the ports this module adds
// ---------------------------------------------------------------------------------------------

/// A channel catalog in which no workspace has a channel kind, so only the `any` channel can be
/// approved: for tests that need no capability registry. The binary reads the registry
/// ([`super::capabilities::UowChannelCatalog`]).
#[derive(Clone, Copy, Debug, Default)]
pub struct NoChannelsYet;

#[async_trait]
impl ChannelCatalog for NoChannelsYet {
    async fn kinds_in_use(&self, _ws: WorkspaceId) -> Result<BTreeSet<String>, AppError> {
        Ok(BTreeSet::new())
    }
}

/// An archive hook with nothing to call off.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoopArchivedHook;

#[async_trait]
impl StrategyArchivedHook for NoopArchivedHook {
    async fn on_archived(
        &self,
        _ws: WorkspaceId,
        _version_id: StrategyVersionId,
    ) -> Result<(), AppError> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

/// `Ok` for a caller who may run the consultation: one holding `team.manage` (for an agent, in
/// its key's scopes, whatever its issuer's role); else `FORBIDDEN` naming `team.manage`, as
/// `Ctx::require`.
fn require_consultant(ctx: &Ctx) -> Result<(), AppError> {
    ctx.require(Permission::TeamManage)
}

/// `Ok` for a caller with the role `owner` or `manager` who also holds `team.manage`, so a key's
/// scopes narrow its issuer's role. Without the role, `FORBIDDEN` with
/// `details.reason = "owner_or_manager"`; without the permission, `FORBIDDEN` naming it.
fn require_owner_or_manager(ctx: &Ctx) -> Result<(), AppError> {
    if !ctx.is_owner_or_manager() {
        return Err(AppError {
            code: ErrorCode::Forbidden,
            message: "only an owner or a manager can approve or archive the strategy".into(),
            details: json!({ "reason": "owner_or_manager" }),
        });
    }
    ctx.require(Permission::TeamManage)
}

/// `key` as one of [`Sections::KEYS`], or `VALIDATION` naming `section_key`.
fn section_key(key: &str) -> Result<&'static str, AppError> {
    Sections::KEYS
        .iter()
        .copied()
        .find(|k| *k == key)
        .ok_or_else(|| {
            invalid(
                "section_key",
                &format!(
                    "unknown section {key:?}; expected one of {}",
                    Sections::KEYS.join(", ")
                ),
            )
        })
}

/// `raw` trimmed, when 1 to [`MAX_CONSULTATION_TEXT_CHARS`] characters are left; else
/// `VALIDATION` naming `text`.
fn consultation_text(raw: &str) -> Result<String, AppError> {
    let text = raw.trim();
    if text.is_empty() {
        return Err(invalid("text", "text must not be empty"));
    }
    if text.chars().count() > MAX_CONSULTATION_TEXT_CHARS {
        return Err(invalid(
            "text",
            &format!("text must be at most {MAX_CONSULTATION_TEXT_CHARS} characters"),
        ));
    }
    Ok(text.to_owned())
}

/// What the consultation log keeps of a section as written: its JSON, or, should that be longer
/// than a log entry may be, a note saying so.
fn section_text(key: &str, value: &Value) -> String {
    let text = value.to_string();
    let len = text.chars().count();
    if len <= MAX_CONSULTATION_TEXT_CHARS {
        text
    } else {
        format!("the {key} section was written ({len} characters, too long for the log)")
    }
}

/// The workspace's channel kinds, and `any`, which every strategy may name.
async fn channel_kinds(deps: &Deps, ctx: &Ctx) -> Result<BTreeSet<String>, AppError> {
    let mut kinds = deps.channels.kinds_in_use(ctx.workspace_id).await?;
    kinds.insert(ANY_CHANNEL.to_owned());
    Ok(kinds)
}

/// Every gap that stops a draft with `sections` and `hypotheses` from being approved, given the
/// workspace's channel kinds `known` and capability group ids `groups`: all of
/// `validate_for_approval`, where a live hypothesis's channel must moreover be one the strategy
/// chose itself (or `any`), not merely one the workspace has; then, after those, every chosen
/// channel narrowed to a capability group the workspace does not have (`channels[i].group_id`).
fn approval_gaps(
    sections: &Sections,
    hypotheses: &[Hypothesis],
    known: &BTreeSet<String>,
    groups: &BTreeSet<Uuid>,
) -> Vec<Gap> {
    let chosen: BTreeSet<String> = sections
        .channels
        .iter()
        .map(|c| c.channel.clone())
        .collect();
    // Checking against the known kinds the strategy chose adds exactly the hypothesis rule, with
    // its gap in its place among the others: a chosen channel is chosen by definition, so the
    // check of the choices themselves is unchanged.
    let usable: BTreeSet<String> = known.intersection(&chosen).cloned().collect();
    let mut gaps = validate_for_approval(sections, hypotheses, &usable);
    // A kind the workspace has but the strategy did not choose: say which rule it breaks.
    for (i, h) in hypotheses.iter().enumerate() {
        if known.contains(&h.channel) && !chosen.contains(&h.channel) {
            let field = format!("hypotheses[{i}].channel");
            if let Some(gap) = gaps.iter_mut().find(|g| g.field == field) {
                gap.message = format!("{:?} is not one of the strategy's channels", h.channel);
            }
        }
    }
    for (i, choice) in sections.channels.iter().enumerate() {
        if let Some(group) = choice.group_id
            && !groups.contains(&group)
        {
            gaps.push(Gap {
                field: format!("channels[{i}].group_id"),
                message: "the workspace has no such capability group".to_owned(),
            });
        }
    }
    gaps
}

/// The ids of the workspace's capability groups, which a chosen channel may be narrowed to.
async fn group_ids(repos: &mut dyn TenantRepos) -> Result<BTreeSet<Uuid>, AppError> {
    Ok(repos
        .capability_groups()
        .list()
        .await?
        .into_iter()
        .map(|(group, _)| group.id.as_uuid())
        .collect())
}

/// The draft's new hypothesis list from what was written (see [`set_hypotheses`]): the written
/// ones in order, then the approved version's hypotheses in force that were left out, retired.
/// `base` is the approved version's list, `current` the draft's, `new_id` gives fresh ids.
fn plan_hypotheses(
    inputs: Vec<HypothesisInput>,
    base: &[Hypothesis],
    current: &[Hypothesis],
    mut new_id: impl FnMut() -> HypothesisId,
) -> Result<Vec<Hypothesis>, AppError> {
    let has = |list: &[Hypothesis], id: HypothesisId| list.iter().any(|h| h.id == id);
    let mut gaps = Vec::new();
    let mut gap = |i: usize, field: &str, message: &str| {
        gaps.push(Gap {
            field: format!("hypotheses[{i}].{field}"),
            message: message.to_owned(),
        });
    };
    let mut listed = BTreeSet::new();
    let mut list = Vec::new();
    for (i, input) in inputs.into_iter().enumerate() {
        let (id, state) = match input.id {
            Some(id) if has(base, id) => (id, HypothesisState::Kept),
            Some(id) if has(current, id) => (id, HypothesisState::Added),
            Some(_) => {
                gap(i, "id", "no such hypothesis in this strategy");
                continue;
            }
            None => (new_id(), HypothesisState::Added),
        };
        if !listed.insert(id) {
            gap(i, "id", "the hypothesis is listed more than once");
        }
        if !(0.0..=1.0).contains(&input.prior_confidence) {
            gap(
                i,
                "prior_confidence",
                "the prior_confidence must be between 0 and 1",
            );
        }
        list.push(Hypothesis {
            cadence: input.cadence.clone(),
            derived_confidence: None,
            id,
            title: input.title,
            segment_key: input.segment_key,
            angle: input.angle,
            channel: input.channel,
            metric: input.metric,
            prior_confidence: input.prior_confidence,
            state,
        });
    }
    if !gaps.is_empty() {
        return Err(gaps_error("the hypotheses are not valid", gaps));
    }
    for h in base
        .iter()
        .filter(|h| h.state.is_live() && !listed.contains(&h.id))
    {
        let latest = current.iter().find(|c| c.id == h.id).unwrap_or(h);
        list.push(Hypothesis {
            state: HypothesisState::Retired,
            ..latest.clone()
        });
    }
    Ok(list)
}

// ---------------------------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------------------------

/// The draft, locked until the bundle ends; `CONFLICT` "no draft" without one.
async fn locked_draft(repos: &mut dyn TenantRepos) -> Result<StrategyVersion, AppError> {
    repos
        .strategy()
        .lock_draft()
        .await?
        .ok_or_else(|| conflict("no draft", "no_draft"))
}

/// The id of the version in force, if any.
async fn version_in_force(
    repos: &mut dyn TenantRepos,
) -> Result<Option<StrategyVersionId>, AppError> {
    Ok(repos.strategy().current_approved().await?.map(|v| v.id))
}

/// Withdraws `draft` from approval if it was submitted: it has just been edited.
async fn withdraw_submission(
    repos: &mut dyn TenantRepos,
    draft: &StrategyVersion,
) -> Result<(), AppError> {
    if draft.submitted_at.is_some() {
        repos.strategy().set_submitted(draft.id, None).await?;
    }
    Ok(())
}

/// Appends an entry to version `version_id`'s consultation log, by the caller at its time.
async fn log(
    repos: &mut dyn TenantRepos,
    deps: &Deps,
    ctx: &Ctx,
    version_id: StrategyVersionId,
    kind: ConsultationKind,
    section_key: Option<String>,
    text: String,
) -> Result<ConsultationEntryId, AppError> {
    let mut entry = ConsultationEntry::new(
        version_id,
        kind,
        section_key,
        text,
        ctx.actor.clone(),
        ctx.now,
    )
    .map_err(|e| invalid("text", &e.to_string()))?;
    entry.id = ConsultationEntryId(deps.ids.uuid());
    repos.consultation().append(entry).await
}

/// Writes the ledger entry `action` about version `version_id`, under the version in force
/// `in_force`.
async fn append_ledger(
    repos: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    version_id: StrategyVersionId,
    in_force: Option<StrategyVersionId>,
    payload: Value,
) -> Result<(), AppError> {
    let mut entry = ledger_entry(ctx, action, "strategy_version", version_id, payload)?;
    entry.strategy_version_id = in_force.map(|id| id.as_uuid());
    repos.ledger().append(entry).await?;
    Ok(())
}

/// Version `id` as it now stands in this bundle, as [`VersionOut`].
async fn reread(
    repos: &mut dyn TenantRepos,
    id: StrategyVersionId,
    known: &BTreeSet<String>,
) -> Result<VersionOut, AppError> {
    let version =
        repos.strategy().find(id).await?.ok_or_else(|| {
            AppError::internal("a version written in this transaction is missing")
        })?;
    version_out(repos, version, known).await
}

/// `version` with its hypotheses, its log's size, its approver's email and, for a draft, its
/// gaps against the channel kinds `known`.
async fn version_out(
    repos: &mut dyn TenantRepos,
    version: StrategyVersion,
    known: &BTreeSet<String>,
) -> Result<VersionOut, AppError> {
    let hypotheses = repos.hypotheses().list(version.id).await?;
    let consultation_count = repos.consultation().count(version.id).await?;
    let approved_by_email = match version.approved_by {
        Some(user) => repos
            .memberships()
            .list()
            .await?
            .into_iter()
            .find(|m| m.user_id == Some(user) && m.status == MembershipStatus::Active)
            .map(|m| m.email),
        None => None,
    };
    let (gaps, assumptions) = match version.status {
        VersionStatus::Draft => {
            let groups = group_ids(repos).await?;
            let assumptions = repos
                .consultation()
                .list_kind(
                    version.id,
                    ConsultationKind::Assumption,
                    MAX_CONSULTATION_PAGE,
                )
                .await?;
            (
                approval_gaps(&version.sections, &hypotheses, known, &groups),
                assumptions,
            )
        }
        VersionStatus::Approved | VersionStatus::Archived => (Vec::new(), Vec::new()),
    };
    Ok(VersionOut {
        id: version.id,
        number: version.number,
        status: version.status,
        sections: version.sections,
        hypotheses,
        created_at: version.created_at,
        submitted_at: version.submitted_at,
        approved_at: version.approved_at,
        approved_by_email,
        consultation_count,
        gaps,
        assumptions,
    })
}

/// `CONFLICT` with `message` and `details.reason`.
fn conflict(message: &str, reason: &str) -> AppError {
    AppError {
        code: ErrorCode::Conflict,
        message: message.to_owned(),
        details: json!({ "reason": reason }),
    }
}

/// `CONFLICT` "the draft changed since you read it", naming the draft as it now stands.
fn draft_changed(draft: &StrategyVersion) -> AppError {
    #[derive(Serialize)]
    struct Stands {
        version_id: StrategyVersionId,
        #[serde(with = "time::serde::rfc3339::option")]
        submitted_at: Option<OffsetDateTime>,
    }
    let details = serde_json::to_value(Stands {
        version_id: draft.id,
        submitted_at: draft.submitted_at,
    })
    .unwrap_or_else(|_| json!({ "version_id": draft.id }));
    AppError {
        code: ErrorCode::Conflict,
        message: "the draft changed since you read it".to_owned(),
        details,
    }
}

/// `Ok` when a status move changed the version; when it changed nothing, another transaction
/// moved the version first: `CONFLICT`.
fn ensure_moved(rows: u64) -> Result<(), AppError> {
    if rows == 0 {
        return Err(conflict("the version has already moved", "version_moved"));
    }
    Ok(())
}

/// `VALIDATION` with `message`, listing `gaps` in `details.gaps`.
fn gaps_error(message: &str, gaps: Vec<Gap>) -> AppError {
    AppError::validation(message, json!({ "gaps": gaps }))
}

/// `VALIDATION`: the draft has `gaps` that stop its approval.
fn not_ready(gaps: Vec<Gap>) -> AppError {
    gaps_error("the draft is not ready for approval", gaps)
}

/// Shared strict write schema; semantic cadence constraints are checked by the parser.
pub fn hypotheses_schema() -> Value {
    json!({
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
                "prior_confidence": { "type": "number", "minimum": 0, "maximum": 1 },
                "cadence": {"type":"object","properties":{"organic":{"type":"object","properties":{"slots_per_week":{"type":"integer","minimum":0,"maximum":65535},"exploration_bps":{"type":"integer","minimum":0,"maximum":10000,"default":0},"content_types":{"type":"array","items":{"type":"object","properties":{"key":{"type":"string","minLength":1},"min_bps":{"type":"integer","minimum":0,"maximum":10000},"max_bps":{"type":"integer","minimum":0,"maximum":10000}},"required":["key","min_bps","max_bps"],"additionalProperties":false}}},"required":["slots_per_week","content_types"],"additionalProperties":false},"paid":{"type":"object","properties":{"slots_per_week":{"type":"integer","minimum":0,"maximum":65535},"exploration_bps":{"type":"integer","minimum":0,"maximum":10000,"default":0},"content_types":{"type":"array","items":{"type":"object","properties":{"key":{"type":"string","minLength":1},"min_bps":{"type":"integer","minimum":0,"maximum":10000},"max_bps":{"type":"integer","minimum":0,"maximum":10000}},"required":["key","min_bps","max_bps"],"additionalProperties":false}}},"required":["slots_per_week","content_types"],"additionalProperties":false}},"additionalProperties":false},
            },
            "additionalProperties": false,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_consultation_cursor_is_both_halves_or_neither() {
        let id = ConsultationEntryId(uuid::Uuid::from_u128(7));
        assert_eq!(consultation_cursor(None, None).unwrap(), None);
        let (at, got) = consultation_cursor(Some("2026-10-22T09:00:00.000123Z"), Some(id))
            .unwrap()
            .unwrap();
        assert_eq!(got, id);
        assert_eq!(at.microsecond(), 123);
        let field = |e: AppError| (e.code, e.details["field"].as_str().unwrap().to_owned());
        assert_eq!(
            field(consultation_cursor(Some("2026-10-22T09:00:00Z"), None).unwrap_err()),
            (ErrorCode::Validation, "before_id".to_owned())
        );
        assert_eq!(
            field(consultation_cursor(None, Some(id)).unwrap_err()),
            (ErrorCode::Validation, "before_at".to_owned())
        );
        assert_eq!(
            field(consultation_cursor(Some("yesterday"), Some(id)).unwrap_err()),
            (ErrorCode::Validation, "before_at".to_owned())
        );
    }

    fn h(id: u128, state: HypothesisState) -> Hypothesis {
        Hypothesis {
            cadence: Default::default(),
            derived_confidence: None,
            id: HypothesisId(uuid::Uuid::from_u128(id)),
            title: format!("h{id}"),
            segment_key: "s".into(),
            angle: "a".into(),
            channel: "any".into(),
            metric: "m".into(),
            prior_confidence: 0.5,
            state,
        }
    }

    fn input(id: Option<u128>) -> HypothesisInput {
        HypothesisInput {
            id: id.map(|n| HypothesisId(uuid::Uuid::from_u128(n))),
            title: "t".into(),
            prior_confidence: 0.5,
            ..HypothesisInput::default()
        }
    }

    #[test]
    fn a_hypothesis_already_retired_is_not_retired_again() {
        let base = [h(1, HypothesisState::Kept), h(2, HypothesisState::Retired)];
        let list = plan_hypotheses(vec![], &base, &[], || unreachable!()).unwrap();
        let ids: Vec<_> = list.iter().map(|h| (h.id.0.as_u128(), h.state)).collect();
        assert_eq!(ids, [(1, HypothesisState::Retired)]);
    }

    #[test]
    fn new_ids_are_drawn_only_for_entries_without_one() {
        let mut next = 10;
        let list = plan_hypotheses(vec![input(None), input(None)], &[], &[], || {
            next += 1;
            HypothesisId(uuid::Uuid::from_u128(next))
        })
        .unwrap();
        let ids: Vec<_> = list.iter().map(|h| h.id.0.as_u128()).collect();
        assert_eq!(ids, [11, 12]);
    }

    #[test]
    fn section_text_falls_back_to_a_note_when_too_long() {
        let long = Value::String("x".repeat(MAX_CONSULTATION_TEXT_CHARS));
        let text = section_text("identity", &long);
        assert!(text.starts_with("the identity section was written ("));
        let short = json!({ "product": "Kahve" });
        assert_eq!(section_text("identity", &short), short.to_string());
    }
}
