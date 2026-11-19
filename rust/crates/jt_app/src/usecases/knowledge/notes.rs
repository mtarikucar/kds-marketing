//! "Ajanlara bir şey anlat" (design §4.8): `strategy.note_add` and `strategy.note_withdraw`
//! (a person in person), `strategy.note_claim`, `strategy.note_file` and `strategy.note_release`
//! (an agent with a work permission).
//!
//! A note binds the agents at once, open; an agent claims it (a lease of 30 minutes, its token
//! kept only as a hash) and files it with what it asks, as the note's person's own words:
//!
//! | Outcome | Effect |
//! |---|---|
//! | `cards` (1 to 3) | each card's whole new text, or a new card (`cause = note`); a filing that leaves a card's body shorter than half of what it was is `CONFLICT` `filing_removes_text` |
//! | `attachments` | the note's files and links onto those cards (knowledge, never library materials) |
//! | `rules` (1 to 10) | prohibitions appended, duplicates skipped |
//! | `goals` (1 to 5) | goals appended, duplicates skipped |
//! | `proposals` (1 to 5) | none: the proposals this connection made wait for the owner |
//! | `post_request` | the content a person's note asks for: refused here (`VALIDATION` `not_available`) until the posts page's composer write exists |
//!
//! or dismisses it with a reason in Turkish. The ad budget, the message limit and the approval
//! switch are never an outcome: a note asking to change them is dismissed, sending the owner to
//! Kurallar. A filing is a knowledge write (see the module docs of [`super`]); a stale card is
//! `CONFLICT` `card_changed`, a withdrawn note `CONFLICT` `note_withdrawn`, another closed one
//! `CONFLICT` `note_closed`, a claim that is not the caller's or has lapsed `CONFLICT`
//! `not_claimed`.

use jt_knowledge::{
    Attachment, Card, Cause, FiledCard, KnowledgeCardId, KnowledgeNoteId, KnowledgeProposalId,
    MAX_CARD_ATTACHMENTS, MAX_DISMISS_REASON_CHARS, MAX_GOAL_CHARS, MAX_GOALS, MAX_LIVE_CARDS,
    MAX_NOTE_FILES, MAX_PROHIBITION_CHARS, MAX_PROHIBITIONS, MAX_SUMMARY_CHARS, NOTE_CLAIM_LEASE,
    Note, NoteClaim, NoteOutcome, NoteStatus, Proposer, Subject, append_lines, validate_body,
    validate_lines, validate_links, validate_note_text, validate_text, validate_title,
};
use jt_studio::FileId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;

use super::cards::{file, live, locked_card, next_position, too_many_cards};
use super::{
    Change, FrameWrite, WORK_PERMISSIONS, agent, conflict, editor, invalid, lock, moves, person,
    refused, seed,
};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::usecases::{Deps, hash_token, ledger_entry};

/// The request receipts' actions.
const NOTE_ADD: &str = "strategy.note_add";
const NOTE_FILE: &str = "strategy.note_file";

/// `strategy.note_add`'s input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteAddInput {
    /// 1 to 128 characters; a replay answers the same note.
    pub request_key: String,
    pub text: String,
    #[serde(default)]
    pub links: Vec<String>,
    /// Uploaded studio files: images, MP4s, PDFs.
    #[serde(default)]
    pub file_ids: Vec<FileId>,
}

/// `strategy.note_withdraw`'s input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteWithdrawInput {
    pub expected_revision: u64,
}

/// `strategy.note_claim`'s input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteClaimInput {
    pub note_id: KnowledgeNoteId,
    pub expected_revision: u64,
}

/// What a claim answers: the token the filing names, until when, and the note.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NoteClaimOut {
    pub claim_token: String,
    #[serde(with = "time::serde::rfc3339")]
    pub until: OffsetDateTime,
    pub note: Note,
}

/// `strategy.note_release`'s input.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteReleaseInput {
    pub note_id: KnowledgeNoteId,
    pub claim_token: String,
}

/// A card a filing writes: an existing one's whole new text, or a new one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FiledCardInput {
    Existing(ExistingCardInput),
    New(NewCardInput),
}

/// An existing card's whole new text, at the revision read.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExistingCardInput {
    pub card_id: KnowledgeCardId,
    pub expected_revision: u64,
    #[serde(default)]
    pub title: Option<String>,
    pub body: String,
}

/// `{"new": {"title", "body"}}`: a card of the owner's own.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewCardInput {
    pub new: NewCard,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewCard {
    pub title: String,
    pub body: String,
}

/// One of the note's files or links onto the card `card` (an index of `cards`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FiledAttachmentInput {
    pub card: usize,
    #[serde(default)]
    pub file_id: Option<FileId>,
    #[serde(default)]
    pub url: Option<String>,
}

/// Why a note is dismissed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DismissInput {
    /// One line in Turkish that says where the answer is.
    pub reason: String,
}

/// `strategy.note_file`'s input: the outcomes, or `dismiss`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NoteFileInput {
    pub note_id: KnowledgeNoteId,
    pub claim_token: String,
    /// Needed to file (a replay answers the same note); a dismissal needs none.
    #[serde(default)]
    pub request_key: Option<String>,
    /// One line in Turkish the owner reads under the note.
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub cards: Vec<FiledCardInput>,
    #[serde(default)]
    pub attachments: Vec<FiledAttachmentInput>,
    #[serde(default)]
    pub rules: Vec<String>,
    #[serde(default)]
    pub goals: Vec<String>,
    #[serde(default)]
    pub post_request: Option<Value>,
    #[serde(default)]
    pub proposals: Vec<KnowledgeProposalId>,
    #[serde(default)]
    pub dismiss: Option<DismissInput>,
}

/// Adds a note, open. Needs `team.manage` in person. The files must be live studio files of the
/// workspace (images, MP4s, PDFs): they stay knowledge, never library materials.
pub async fn note_add(deps: &Deps, ctx: &Ctx, input: NoteAddInput) -> Result<Note, AppError> {
    let person = editor(ctx)?;
    let key = request_key(&input.request_key)?;
    let text = validate_note_text(&input.text).map_err(invalid)?;
    let links = validate_links("links", &input.links).map_err(invalid)?;
    let mut file_ids: Vec<FileId> = Vec::new();
    for id in &input.file_ids {
        if !file_ids.contains(id) {
            file_ids.push(*id);
        }
    }
    if file_ids.len() > MAX_NOTE_FILES {
        return Err(AppError::validation(
            format!("a note holds at most {MAX_NOTE_FILES} files"),
            json!({ "field": "file_ids", "reason": "too_many" }),
        ));
    }
    seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let payload = digest(&input)?;
    if let Some(id) = replayed(r.as_mut(), NOTE_ADD, &key, &payload).await? {
        return reread(r.as_mut(), id).await;
    }
    for (i, id) in file_ids.iter().enumerate() {
        file(r.as_mut(), *id, &format!("file_ids[{i}]")).await?;
    }
    let note = Note {
        id: KnowledgeNoteId(deps.ids.uuid()),
        text,
        links,
        file_ids,
        status: NoteStatus::Open,
        claim: None,
        revision: 1,
        created_at: ctx.now,
        created_by: person,
        closed_at: None,
        closed_by_user: None,
        closed_by_connection: None,
        outcome: None,
    };
    r.knowledge().insert_note(&note).await?;
    r.studio()
        .request_receipt(NOTE_ADD, &key, &payload, &json!(note.id))
        .await?;
    ledger(
        r.as_mut(),
        ctx,
        "strategy.note_added",
        &note,
        json!({ "links": note.links.len(), "files": note.file_ids.len() }),
    )
    .await?;
    r.commit().await?;
    Ok(note)
}

/// Takes back an open note (a claim held on it ends). The person who added it, or an owner or a
/// manager, in person.
pub async fn note_withdraw(
    deps: &Deps,
    ctx: &Ctx,
    id: KnowledgeNoteId,
    input: NoteWithdrawInput,
) -> Result<Note, AppError> {
    let person = person(ctx)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut note = locked_note(r.as_mut(), id).await?;
    if note.created_by != person && !ctx.is_owner_or_manager() {
        return Err(refused(
            ErrorCode::Forbidden,
            "owner_or_manager",
            "only the person who added the note, an owner or a manager takes it back",
            json!({}),
        ));
    }
    expected(&note, input.expected_revision)?;
    open(&note)?;
    note.status = NoteStatus::Withdrawn;
    note.claim = None;
    note.closed_at = Some(ctx.now);
    note.closed_by_user = Some(person);
    note.revision += 1;
    r.knowledge().save_note(&note).await?;
    ledger(r.as_mut(), ctx, "strategy.note_withdrawn", &note, json!({})).await?;
    r.commit().await?;
    Ok(note)
}

/// Claims an open note for the caller's connection for 30 minutes (renewing its own claim), at
/// `expected_revision`. Another connection's live claim is `CONFLICT` `note_claimed` with its
/// `until`.
pub async fn note_claim(
    deps: &Deps,
    ctx: &Ctx,
    input: NoteClaimInput,
) -> Result<NoteClaimOut, AppError> {
    let connection = agent(ctx)?;
    ctx.require_any(WORK_PERMISSIONS)?;
    seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut note = locked_note(r.as_mut(), input.note_id).await?;
    expected(&note, input.expected_revision)?;
    open(&note)?;
    if let Some(claim) = note.live_claim(ctx.now)
        && claim.connection_id != connection
    {
        return Err(refused(
            ErrorCode::Conflict,
            "note_claimed",
            "another agent is filing this note",
            json!({ "until": claim.until.format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_default() }),
        ));
    }
    let token = deps.tokens.token(32);
    let until = ctx.now + NOTE_CLAIM_LEASE;
    note.claim = Some(NoteClaim {
        connection_id: connection,
        token_hash: hash_token(&token),
        until,
    });
    note.revision += 1;
    r.knowledge().save_note(&note).await?;
    ledger(r.as_mut(), ctx, "strategy.note_claimed", &note, json!({})).await?;
    r.commit().await?;
    Ok(NoteClaimOut {
        claim_token: token,
        until,
        note,
    })
}

/// Gives a claimed note back unfiled.
pub async fn note_release(
    deps: &Deps,
    ctx: &Ctx,
    input: NoteReleaseInput,
) -> Result<Note, AppError> {
    let connection = agent(ctx)?;
    ctx.require_any(WORK_PERMISSIONS)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut note = locked_note(r.as_mut(), input.note_id).await?;
    open(&note)?;
    claimant(&note, ctx, connection, &input.claim_token)?;
    note.claim = None;
    note.revision += 1;
    r.knowledge().save_note(&note).await?;
    ledger(r.as_mut(), ctx, "strategy.note_released", &note, json!({})).await?;
    r.commit().await?;
    Ok(note)
}

/// Closes the claimed note with what it asks, or dismisses it (see the module docs).
pub async fn note_file(deps: &Deps, ctx: &Ctx, input: NoteFileInput) -> Result<Note, AppError> {
    let connection = agent(ctx)?;
    ctx.require_any(WORK_PERMISSIONS)?;
    if let Some(dismiss) = &input.dismiss {
        return dismiss_note(deps, ctx, connection, &input, dismiss).await;
    }
    let filing = Filing::of(&input)?;
    seed::ensure(deps, ctx).await?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let frame_write = if filing.cards.is_empty() {
        FrameWrite::Never
    } else {
        FrameWrite::WithoutFrame
    };
    let mut kb = lock(r.as_mut(), frame_write).await?;
    let payload = digest(&input)?;
    if let Some(id) = replayed(r.as_mut(), NOTE_FILE, &filing.key, &payload).await? {
        return reread(r.as_mut(), id).await;
    }
    let mut note = locked_note(r.as_mut(), input.note_id).await?;
    open(&note)?;
    claimant(&note, ctx, connection, &input.claim_token)?;
    let mut outcome = NoteOutcome {
        summary: Some(filing.summary.clone()),
        ..NoteOutcome::default()
    };

    // Cards: each its whole new text, or a new card; the note's files and links onto them.
    let mut all = r.knowledge().cards().await?;
    let mut position = next_position(&all);
    for (i, written) in filing.cards.iter().enumerate() {
        let extra = filed_attachments(r.as_mut(), &note, &input.attachments, i).await?;
        let (before, mut card) = match written {
            WrittenCard::Existing {
                card_id,
                expected_revision,
                title,
                body,
            } => {
                let before = locked_card(r.as_mut(), *card_id, *expected_revision).await?;
                if !before.is_live() {
                    return Err(conflict(
                        "card_archived",
                        "the card is removed: file into another card",
                    ));
                }
                if body.chars().count() * 2 < before.body.chars().count() {
                    return Err(refused(
                        ErrorCode::Conflict,
                        "filing_removes_text",
                        "a filing adds to a card: keep what the owner wrote",
                        json!({ "card_id": card_id }),
                    ));
                }
                let mut card = before.clone();
                if let Some(title) = title {
                    card.title = title.clone();
                }
                card.body = body.clone();
                card.revision += 1;
                card.updated_at = ctx.now;
                card.updated_by = ctx.actor.clone();
                (Some(before), card)
            }
            WrittenCard::New { title, body } => {
                if live(&all) >= MAX_LIVE_CARDS {
                    return Err(too_many_cards());
                }
                let card = Card {
                    id: KnowledgeCardId(deps.ids.uuid()),
                    key: None,
                    title: title.clone(),
                    body: body.clone(),
                    attachments: Vec::new(),
                    position,
                    revision: 1,
                    created_at: ctx.now,
                    created_by: ctx.actor.clone(),
                    updated_at: ctx.now,
                    updated_by: ctx.actor.clone(),
                    archived_at: None,
                };
                position = position.saturating_add(1);
                (None, card)
            }
        };
        for a in extra {
            if !card.attachments.contains(&a) {
                card.attachments.push(a);
            }
        }
        if card.attachments.len() > MAX_CARD_ATTACHMENTS {
            return Err(AppError::validation(
                format!("a card holds at most {MAX_CARD_ATTACHMENTS} attachments"),
                json!({ "field": format!("cards[{i}]"), "reason": "too_many_attachments" }),
            ));
        }
        match &before {
            Some(_) => r.knowledge().save_card(&card).await?,
            None => {
                r.knowledge().insert_card(&card).await?;
                all.push(card.clone());
            }
        }
        let (posting, prospecting) = moves(before.as_ref(), &card);
        kb.record(
            r.as_mut(),
            deps,
            ctx,
            Change {
                subject: Subject::Card,
                card: Some(&card),
                cause: Cause::Note,
                source_id: Some(note.id.as_uuid()),
                person: Some(note.created_by),
                posting,
                prospecting,
            },
        )
        .await?;
        outcome.cards.push(FiledCard {
            card_id: card.id,
            revision: card.revision,
        });
    }

    // Rules and goals: appended as the note's person's words.
    let note_change = |subject| Change {
        subject,
        card: None,
        cause: Cause::Note,
        source_id: Some(note.id.as_uuid()),
        person: Some(note.created_by),
        posting: false,
        prospecting: false,
    };
    if !filing.rules.is_empty() {
        let added = append_lines(
            "rules",
            &mut kb.settings.prohibitions,
            &filing.rules,
            MAX_PROHIBITIONS,
        )
        .map_err(invalid)?;
        if !added.is_empty() {
            kb.settings.rules_revision += 1;
            kb.record(r.as_mut(), deps, ctx, note_change(Subject::Rules))
                .await?;
        }
        outcome.rules = added;
    }
    if !filing.goals.is_empty() {
        let added = append_lines("goals", &mut kb.settings.goals, &filing.goals, MAX_GOALS)
            .map_err(invalid)?;
        if !added.is_empty() {
            kb.settings.goals_revision += 1;
            kb.record(r.as_mut(), deps, ctx, note_change(Subject::Goals))
                .await?;
        }
        outcome.goals = added;
    }

    // Proposals: this connection's own.
    for (i, id) in input.proposals.iter().enumerate() {
        let own = r.knowledge().proposal(*id).await?.is_some_and(|p| {
            p.proposed_by
                == Proposer::Agent {
                    connection_id: connection,
                }
        });
        if !own {
            return Err(refused(
                ErrorCode::NotFound,
                "no_such_proposal",
                "no such proposal of this agent",
                json!({ "field": format!("proposals[{i}]") }),
            ));
        }
        if !outcome.proposals.contains(id) {
            outcome.proposals.push(*id);
        }
    }

    note.status = NoteStatus::Filed;
    note.claim = None;
    note.closed_at = Some(ctx.now);
    note.closed_by_connection = Some(connection);
    note.revision += 1;
    let counts = json!({
        "cards": outcome.cards.len(),
        "rules": outcome.rules.len(),
        "goals": outcome.goals.len(),
        "proposals": outcome.proposals.len(),
    });
    note.outcome = Some(outcome);
    r.knowledge().save_note(&note).await?;
    kb.save(r.as_mut()).await?;
    r.studio()
        .request_receipt(NOTE_FILE, &filing.key, &payload, &json!(note.id))
        .await?;
    ledger(r.as_mut(), ctx, "strategy.note_filed", &note, counts).await?;
    r.commit().await?;
    Ok(note)
}

/// Dismisses the claimed note with a reason.
async fn dismiss_note(
    deps: &Deps,
    ctx: &Ctx,
    connection: jt_tenancy::AgentConnectionId,
    input: &NoteFileInput,
    dismiss: &DismissInput,
) -> Result<Note, AppError> {
    let outcomes = !input.cards.is_empty()
        || !input.attachments.is_empty()
        || !input.rules.is_empty()
        || !input.goals.is_empty()
        || input.post_request.is_some()
        || !input.proposals.is_empty();
    if outcomes {
        return Err(AppError::validation(
            "a dismissal carries no outcome",
            json!({ "field": "dismiss", "reason": "not_allowed" }),
        ));
    }
    let reason = validate_text(
        "dismiss.reason",
        &dismiss.reason,
        1,
        MAX_DISMISS_REASON_CHARS,
    )
    .map_err(invalid)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut note = locked_note(r.as_mut(), input.note_id).await?;
    open(&note)?;
    claimant(&note, ctx, connection, &input.claim_token)?;
    note.status = NoteStatus::Dismissed;
    note.claim = None;
    note.closed_at = Some(ctx.now);
    note.closed_by_connection = Some(connection);
    note.revision += 1;
    note.outcome = Some(NoteOutcome {
        dismissed: Some(reason),
        ..NoteOutcome::default()
    });
    r.knowledge().save_note(&note).await?;
    ledger(r.as_mut(), ctx, "strategy.note_dismissed", &note, json!({})).await?;
    r.commit().await?;
    Ok(note)
}

/// A card a filing writes, checked.
enum WrittenCard {
    Existing {
        card_id: KnowledgeCardId,
        expected_revision: u64,
        title: Option<String>,
        body: String,
    },
    New {
        title: String,
        body: String,
    },
}

/// A filing's outcomes, checked before anything is read.
struct Filing {
    key: String,
    summary: String,
    cards: Vec<WrittenCard>,
    rules: Vec<String>,
    goals: Vec<String>,
}

impl Filing {
    fn of(input: &NoteFileInput) -> Result<Filing, AppError> {
        let key = request_key(input.request_key.as_deref().unwrap_or_default())?;
        let summary = validate_text(
            "summary",
            input.summary.as_deref().unwrap_or_default(),
            1,
            MAX_SUMMARY_CHARS,
        )
        .map_err(invalid)?;
        if input.post_request.is_some() {
            return Err(AppError::validation(
                "a post request is not filed yet: dismiss the note, saying the owner asks for it \
                 on Paylaşımlar",
                json!({ "field": "post_request", "reason": "not_available" }),
            ));
        }
        if input.cards.len() > 3 {
            return Err(too_many("cards", 3));
        }
        let mut cards = Vec::new();
        for (i, c) in input.cards.iter().enumerate() {
            let at = |e: jt_knowledge::Invalid| {
                invalid(jt_knowledge::Invalid {
                    field: format!("cards[{i}].{}", e.field),
                    ..e
                })
            };
            cards.push(match c {
                FiledCardInput::Existing(c) => WrittenCard::Existing {
                    card_id: c.card_id,
                    expected_revision: c.expected_revision,
                    title: c
                        .title
                        .as_deref()
                        .map(validate_title)
                        .transpose()
                        .map_err(at)?,
                    body: validate_body(&c.body).map_err(at)?,
                },
                FiledCardInput::New(c) => WrittenCard::New {
                    title: validate_title(&c.new.title).map_err(at)?,
                    body: validate_body(&c.new.body).map_err(at)?,
                },
            });
        }
        let rules =
            validate_lines("rules", &input.rules, 10, MAX_PROHIBITION_CHARS).map_err(invalid)?;
        let goals = validate_lines("goals", &input.goals, 5, MAX_GOAL_CHARS).map_err(invalid)?;
        if input.proposals.len() > 5 {
            return Err(too_many("proposals", 5));
        }
        for (i, a) in input.attachments.iter().enumerate() {
            if a.card >= cards.len() || a.file_id.is_some() == a.url.is_some() {
                return Err(AppError::validation(
                    "an attachment names one of the filed cards, and a file or a link",
                    json!({ "field": format!("attachments[{i}]"), "reason": "invalid" }),
                ));
            }
        }
        if cards.is_empty() && rules.is_empty() && goals.is_empty() && input.proposals.is_empty() {
            return Err(AppError::validation(
                "a filing carries at least one outcome; dismiss a note with nothing to act on",
                json!({ "field": "cards", "reason": "nothing_to_file" }),
            ));
        }
        Ok(Filing {
            key,
            summary,
            cards,
            rules,
            goals,
        })
    }
}

/// The note's files and links `attachments` puts onto the card at index `card`: each must be
/// the note's own.
async fn filed_attachments(
    r: &mut dyn TenantRepos,
    note: &Note,
    attachments: &[FiledAttachmentInput],
    card: usize,
) -> Result<Vec<Attachment>, AppError> {
    let mut out = Vec::new();
    for (i, a) in attachments
        .iter()
        .enumerate()
        .filter(|(_, a)| a.card == card)
    {
        let field = format!("attachments[{i}]");
        let not_in_note = || {
            AppError::validation(
                "an attachment is one of the note's own files or links",
                json!({ "field": field, "reason": "not_in_note" }),
            )
        };
        match (&a.file_id, &a.url) {
            (Some(id), None) => {
                if !note.file_ids.contains(id) {
                    return Err(not_in_note());
                }
                out.push(file(r, *id, &format!("{field}.file_id")).await?);
            }
            (None, Some(url)) => {
                let url = url.trim();
                if !note.links.iter().any(|l| l == url) {
                    return Err(not_in_note());
                }
                out.push(Attachment::Link {
                    url: url.to_owned(),
                    title: None,
                });
            }
            _ => return Err(not_in_note()),
        }
    }
    Ok(out)
}

/// `VALIDATION` `too_many` naming `field`.
fn too_many(field: &str, max: usize) -> AppError {
    AppError::validation(
        format!("at most {max}"),
        json!({ "field": field, "reason": "too_many" }),
    )
}

/// A request key as written: trimmed, 1 to 128 characters.
fn request_key(raw: &str) -> Result<String, AppError> {
    validate_text("request_key", raw, 1, 128).map_err(invalid)
}

/// The digest a request receipt keeps of an input.
fn digest<T: Serialize>(input: &T) -> Result<Value, AppError> {
    let text = serde_json::to_string(input)
        .map_err(|e| AppError::internal(format!("cannot encode the input: {e}")))?;
    Ok(json!(hash_token(&text)))
}

/// The note a receipt of `action` and `key` names, when the request was made before (another
/// input under the same key is `CONFLICT`).
async fn replayed(
    r: &mut dyn TenantRepos,
    action: &str,
    key: &str,
    payload: &Value,
) -> Result<Option<KnowledgeNoteId>, AppError> {
    r.studio()
        .request_replay(action, key, payload)
        .await?
        .map(|v| {
            serde_json::from_value(v)
                .map_err(|_| AppError::internal("a request receipt holds no note"))
        })
        .transpose()
}

/// Note `id` as it stands.
async fn reread(r: &mut dyn TenantRepos, id: KnowledgeNoteId) -> Result<Note, AppError> {
    r.knowledge()
        .note(id)
        .await?
        .ok_or_else(|| AppError::internal("a note a receipt names is gone"))
}

/// Note `id`, locked; `NOT_FOUND` without it.
async fn locked_note(r: &mut dyn TenantRepos, id: KnowledgeNoteId) -> Result<Note, AppError> {
    r.knowledge()
        .lock_note(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such note"))
}

/// `CONFLICT` `note_changed` unless the note is at `revision`.
fn expected(note: &Note, revision: u64) -> Result<(), AppError> {
    if note.revision != revision {
        return Err(refused(
            ErrorCode::Conflict,
            "note_changed",
            "the note changed since it was read",
            json!({ "revision": note.revision }),
        ));
    }
    Ok(())
}

/// `CONFLICT` `note_withdrawn` or `note_closed` unless the note is open.
fn open(note: &Note) -> Result<(), AppError> {
    match note.status {
        NoteStatus::Open => Ok(()),
        NoteStatus::Withdrawn => Err(conflict("note_withdrawn", "the person took the note back")),
        NoteStatus::Filed | NoteStatus::Dismissed => {
            Err(conflict("note_closed", "the note is already closed"))
        }
    }
}

/// `CONFLICT` `not_claimed` unless `connection` holds a live claim of the note with `token`.
fn claimant(
    note: &Note,
    ctx: &Ctx,
    connection: jt_tenancy::AgentConnectionId,
    token: &str,
) -> Result<(), AppError> {
    let held = note
        .live_claim(ctx.now)
        .is_some_and(|c| c.connection_id == connection && c.token_hash == hash_token(token));
    if held {
        Ok(())
    } else {
        Err(conflict(
            "not_claimed",
            "claim the note first: the claim is not this agent's, or it lapsed",
        ))
    }
}

/// Appends the ledger entry `action` about `note`, with `payload` and its id.
async fn ledger(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    note: &Note,
    payload: Value,
) -> Result<(), AppError> {
    let mut payload = payload;
    if let Some(map) = payload.as_object_mut() {
        map.insert("note_id".into(), json!(note.id));
    }
    let mut entry = ledger_entry(ctx, action, "knowledge_note", note.id, payload)?;
    entry.strategy_version_id = r
        .strategy()
        .current_approved()
        .await?
        .map(|v| v.id.as_uuid());
    r.ledger().append(entry).await?;
    Ok(())
}
