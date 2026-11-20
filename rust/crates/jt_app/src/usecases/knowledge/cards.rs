//! Cards (design §4.4): `strategy.card_create`, `card_update`, `card_archive` and
//! `card_history`, the owner's page writes. Each needs `team.manage` and a person in person.
//!
//! Refusals: `VALIDATION` per field (`details.field`, `details.reason`: the limits of
//! `jt_knowledge`), `CONFLICT` `card_changed` (the card moved past `expected_revision`, with its
//! `revision`), `CONFLICT` `card_archived` (an edit of a removed card), `CONFLICT`
//! `too_many_cards` (more than 50 live cards), `NOT_FOUND` (no such card, or a file that is not a
//! live file of the workspace).
//!
//! A change of a card the frame is derived from (its title, body, attachments, or its removal
//! or restoration; a new card of the owner's own counts for both parts) moves the posting or the
//! prospecting revision (`moves`); a position alone moves neither. An owner's edit of a
//! card's title or body, or its removal, supersedes the card's pending `card_edit` proposals:
//! accepting one would overwrite the owner's newer text. A new position or new attachments leave
//! them pending (an edit rewrites neither).
//!
//! The first card text of a workspace without a frame bootstraps one in the same transaction
//! (design §4.10.5, D4): the gate opens the moment the owner writes a card.

use jt_knowledge::{
    Attachment, AttachmentInput, Card, Cause, HISTORY_PAGE, KnowledgeCardId, MAX_CARD_ATTACHMENTS,
    MAX_CARD_POSITION, MAX_LIVE_CARDS, ProposalKind, ProposalStatus, Revision, Subject, cut,
    is_knowledge_mime, validate_body, validate_position, validate_title,
};
use jt_studio::FileId;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;

use super::frame::Waking;
use super::{Change, FrameWrite, conflict, editor, invalid, lock, moves, refused, seed};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::usecases::{Deps, nothing_to_change};

/// `strategy.card_create`'s input.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CardCreateInput {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub attachments: Vec<AttachmentInput>,
    /// Where it stands; none: after every live card.
    #[serde(default)]
    pub position: Option<u32>,
}

/// `strategy.card_update`'s input: the fields given replace the card's.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CardUpdateInput {
    pub expected_revision: u64,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub attachments: Option<Vec<AttachmentInput>>,
    #[serde(default)]
    pub position: Option<u32>,
}

/// `strategy.card_archive`'s input: remove (`archived: true`) or restore the card.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CardArchiveInput {
    pub expected_revision: u64,
    pub archived: bool,
}

/// A page of a card's history, newest first; `next_before` continues it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HistoryOut {
    pub revisions: Vec<Revision>,
    pub next_before: Option<u64>,
}

/// Adds a card of the owner's own (no key) at revision 1, after every live card unless
/// `position` says where.
pub async fn card_create(deps: &Deps, ctx: &Ctx, input: CardCreateInput) -> Result<Card, AppError> {
    let person = editor(ctx)?;
    let title = validate_title(&input.title).map_err(invalid)?;
    let body = validate_body(&input.body).map_err(invalid)?;
    let position = input
        .position
        .map(validate_position)
        .transpose()
        .map_err(invalid)?;
    seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut kb = lock(r.as_mut(), FrameWrite::WithoutFrame).await?;
    let attachments = attachments(r.as_mut(), &input.attachments).await?;
    let cards = r.knowledge().cards().await?;
    if live(&cards) >= MAX_LIVE_CARDS {
        return Err(too_many_cards());
    }
    let card = Card {
        id: KnowledgeCardId(deps.ids.uuid()),
        key: None,
        title,
        body,
        attachments,
        position: position.unwrap_or_else(|| next_position(&cards)),
        revision: 1,
        created_at: ctx.now,
        created_by: ctx.actor.clone(),
        updated_at: ctx.now,
        updated_by: ctx.actor.clone(),
        archived_at: None,
    };
    r.knowledge().insert_card(&card).await?;
    let (posting, prospecting) = moves(None, &card);
    kb.record(
        r.as_mut(),
        deps,
        ctx,
        Change {
            subject: Subject::Card,
            card: Some(&card),
            cause: Cause::Owner,
            source_id: None,
            person: Some(person),
            posting,
            prospecting,
        },
    )
    .await?;
    kb.bootstrap(deps, ctx, r.as_mut(), person, Waking::InPerson)
        .await?;
    kb.save(r.as_mut()).await?;
    r.commit().await?;
    Ok(card)
}

/// Replaces the fields `input` gives of card `id` at `input.expected_revision`. An edit naming
/// no field is `VALIDATION` (`details.fields`); one that changes nothing writes nothing and
/// answers the card as it is.
pub async fn card_update(
    deps: &Deps,
    ctx: &Ctx,
    id: KnowledgeCardId,
    input: CardUpdateInput,
) -> Result<Card, AppError> {
    let person = editor(ctx)?;
    if input.title.is_none()
        && input.body.is_none()
        && input.attachments.is_none()
        && input.position.is_none()
    {
        return Err(nothing_to_change(&[
            "title",
            "body",
            "attachments",
            "position",
        ]));
    }
    let title = input
        .title
        .as_deref()
        .map(validate_title)
        .transpose()
        .map_err(invalid)?;
    let body = input
        .body
        .as_deref()
        .map(validate_body)
        .transpose()
        .map_err(invalid)?;
    let position = input
        .position
        .map(validate_position)
        .transpose()
        .map_err(invalid)?;
    seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut kb = lock(r.as_mut(), FrameWrite::WithoutFrame).await?;
    let before = locked_card(r.as_mut(), id, input.expected_revision).await?;
    if !before.is_live() {
        return Err(conflict(
            "card_archived",
            "the card is removed: restore it first",
        ));
    }
    let mut card = before.clone();
    if let Some(title) = title {
        card.title = title;
    }
    if let Some(body) = body {
        card.body = body;
    }
    if let Some(raw) = &input.attachments {
        card.attachments = attachments(r.as_mut(), raw).await?;
    }
    if let Some(position) = position {
        card.position = position;
    }
    if card == before {
        return Ok(before);
    }
    let card = write(deps, ctx, r.as_mut(), &mut kb, &before, card, person).await?;
    r.commit().await?;
    Ok(card)
}

/// Removes card `id` (`archived: true`) or restores it, at `input.expected_revision`. A card
/// already as asked is answered as it is; a restoration past 50 live cards is `too_many_cards`.
pub async fn card_archive(
    deps: &Deps,
    ctx: &Ctx,
    id: KnowledgeCardId,
    input: CardArchiveInput,
) -> Result<Card, AppError> {
    let person = editor(ctx)?;
    seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut kb = lock(r.as_mut(), FrameWrite::WithoutFrame).await?;
    let before = locked_card(r.as_mut(), id, input.expected_revision).await?;
    if before.is_live() != input.archived {
        return Ok(before);
    }
    if !input.archived && live(&r.knowledge().cards().await?) >= MAX_LIVE_CARDS {
        return Err(too_many_cards());
    }
    let mut card = before.clone();
    card.archived_at = input.archived.then_some(ctx.now);
    let card = write(deps, ctx, r.as_mut(), &mut kb, &before, card, person).await?;
    r.commit().await?;
    Ok(card)
}

/// Card `id`'s revisions, newest first, [`HISTORY_PAGE`] a page, before the revision `before`
/// when given. Restoring an old text is a `card_update` with that text.
pub async fn card_history(
    deps: &Deps,
    ctx: &Ctx,
    id: KnowledgeCardId,
    before: Option<u64>,
) -> Result<HistoryOut, AppError> {
    editor(ctx)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    if r.knowledge().card(id).await?.is_none() {
        return Err(AppError::not_found("no such card"));
    }
    let revisions = r
        .knowledge()
        .revisions(Subject::Card, Some(id), before, HISTORY_PAGE)
        .await?;
    let next_before = (revisions.len() == HISTORY_PAGE as usize)
        .then(|| revisions.last().map(|r| r.revision))
        .flatten();
    Ok(HistoryOut {
        revisions,
        next_before,
    })
}

/// Stores `card`, changed from `before` by `person`, at the next revision, records the change,
/// supersedes the card's pending edits when its text moved ([`text_moved`]) and saves the
/// settings; the caller commits.
async fn write(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    kb: &mut super::Locked,
    before: &Card,
    mut card: Card,
    person: jt_tenancy::UserId,
) -> Result<Card, AppError> {
    card.revision += 1;
    card.updated_at = ctx.now;
    card.updated_by = ctx.actor.clone();
    r.knowledge().save_card(&card).await?;
    let (posting, prospecting) = moves(Some(before), &card);
    kb.record(
        r,
        deps,
        ctx,
        Change {
            subject: Subject::Card,
            card: Some(&card),
            cause: Cause::Owner,
            source_id: None,
            person: Some(person),
            posting,
            prospecting,
        },
    )
    .await?;
    if text_moved(before, &card) {
        supersede_edits(r, card.id, ctx.now).await?;
    }
    kb.bootstrap(deps, ctx, r, person, Waking::InPerson).await?;
    kb.save(r).await?;
    Ok(card)
}

/// Whether a change of a card from `before` to `after` moved what a `card_edit` rewrites (its
/// title or body) or removed the card: only then do its pending edits stop being current.
pub(crate) fn text_moved(before: &Card, after: &Card) -> bool {
    before.title != after.title || before.body != after.body || !after.is_live()
}

/// Card `id`, locked, at `expected` revision: `NOT_FOUND`, or `CONFLICT` `card_changed` with
/// the card's revision.
pub(crate) async fn locked_card(
    r: &mut dyn TenantRepos,
    id: KnowledgeCardId,
    expected: u64,
) -> Result<Card, AppError> {
    let card = r
        .knowledge()
        .lock_card(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such card"))?;
    if card.revision != expected {
        return Err(card_changed(&card));
    }
    Ok(card)
}

/// `CONFLICT` `card_changed`, with the card's revision.
pub(crate) fn card_changed(card: &Card) -> AppError {
    refused(
        ErrorCode::Conflict,
        "card_changed",
        "the card changed since it was read",
        json!({ "card_id": card.id, "revision": card.revision }),
    )
}

/// `CONFLICT` `too_many_cards`.
pub(crate) fn too_many_cards() -> AppError {
    refused(
        ErrorCode::Conflict,
        "too_many_cards",
        &format!("a knowledge base holds at most {MAX_LIVE_CARDS} live cards"),
        json!({ "max": MAX_LIVE_CARDS }),
    )
}

/// How many of `cards` are live.
pub(crate) fn live(cards: &[Card]) -> usize {
    cards.iter().filter(|c| c.is_live()).count()
}

/// The position after every live card (at most [`MAX_CARD_POSITION`]).
pub(crate) fn next_position(cards: &[Card]) -> u32 {
    cards
        .iter()
        .filter(|c| c.is_live())
        .map(|c| c.position.saturating_add(1).min(MAX_CARD_POSITION))
        .max()
        .unwrap_or(0)
}

/// Marks the pending `card_edit` proposals of card `id` superseded at `now`.
pub(crate) async fn supersede_edits(
    r: &mut dyn TenantRepos,
    id: KnowledgeCardId,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let pending = r
        .knowledge()
        .proposals(Some(ProposalStatus::Pending))
        .await?;
    for mut p in pending
        .into_iter()
        .filter(|p| p.kind == ProposalKind::CardEdit && p.card_id == Some(id))
    {
        p.status = ProposalStatus::Superseded;
        p.decided_at = Some(now);
        p.decided_by = None;
        r.knowledge().save_proposal(&p).await?;
    }
    Ok(())
}

/// The attachments as stored, from what was written: at most [`MAX_CARD_ATTACHMENTS`], links
/// checked, files read (a live studio file of the workspace, an image, MP4 or PDF: else
/// `NOT_FOUND` or `VALIDATION` `file_not_knowledge` naming it), each once.
pub(crate) async fn attachments(
    r: &mut dyn TenantRepos,
    raw: &[AttachmentInput],
) -> Result<Vec<Attachment>, AppError> {
    if raw.len() > MAX_CARD_ATTACHMENTS {
        return Err(AppError::validation(
            format!("a card holds at most {MAX_CARD_ATTACHMENTS} attachments"),
            json!({ "field": "attachments", "reason": "too_many" }),
        ));
    }
    let mut out: Vec<Attachment> = Vec::new();
    for (i, item) in raw.iter().enumerate() {
        let field = format!("attachments[{i}]");
        let attachment = match item {
            AttachmentInput::Link { .. } => item
                .link(&field)
                .map_err(invalid)?
                .ok_or_else(|| AppError::internal("a link reads as a link"))?,
            AttachmentInput::File { file_id } => {
                file(r, *file_id, &format!("{field}.file_id")).await?
            }
        };
        if !out.contains(&attachment) {
            out.push(attachment);
        }
    }
    Ok(out)
}

/// The studio file `id` as an attachment.
pub(crate) async fn file(
    r: &mut dyn TenantRepos,
    id: FileId,
    field: &str,
) -> Result<Attachment, AppError> {
    let stored = r
        .studio()
        .get_file(id)
        .await?
        .filter(|f| f.deleted_at.is_none())
        .ok_or_else(|| {
            refused(
                ErrorCode::NotFound,
                "no_such_file",
                "no such file",
                json!({ "field": field }),
            )
        })?;
    if !is_knowledge_mime(&stored.mime) {
        return Err(AppError::validation(
            "a knowledge file is an image, an MP4 video or a PDF",
            json!({ "field": field, "reason": "file_not_knowledge" }),
        ));
    }
    Ok(Attachment::File {
        file_id: id,
        name: cut(&stored.filename, jt_knowledge::MAX_ATTACHMENT_LABEL_CHARS),
        mime: stored.mime,
    })
}
