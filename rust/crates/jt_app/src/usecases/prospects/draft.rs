//! `prospects.message_draft`: a draft of the first message to a prospect, written by the model
//! for the channel the person chose, from what the research recorded about the prospect and what
//! the knowledge base says about the business. The draft goes to the panel's message field, for
//! the person to read, change and send; **the server never sends it**. When it is sent, it takes
//! the send path a hand-written message takes, with every check (footer, unsubscribe, basis,
//! consent, suppression, caps).
//!
//! No draft (`draft: null`, the field stays empty, nothing else changes) when the platform has no
//! model (`ConnectorRegistry::draft_model`), when the workspace made
//! [`DRAFTS_PER_WORKSPACE_DAILY`] drafts this UTC day, or when the model gave none. Each call is
//! counted on the ledger (`drafts.first_message`): the channel, the model, the tokens and the
//! cost; never a prospect's or a draft's text. Drafts are not stored.

use jt_prospects::{Prospect, ProspectId, SourceRef};
use jt_strategy::Identity;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;

use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::draft_model::{
    DRAFT_MAX_TOKENS, DRAFTS_PER_WORKSPACE_DAILY, DraftRequest, DraftShape,
};
use crate::ports::{LedgerFilter, TenantRepos};
use crate::usecases::Deps;
use crate::usecases::knowledge::read::Live;

/// The ledger action each model call is counted under.
pub const DRAFT_ACTION: &str = "drafts.first_message";

/// The channel the first message goes on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DraftChannel {
    Email,
    Sms,
    Whatsapp,
    Instagram,
}

impl DraftChannel {
    fn key(self) -> &'static str {
        match self {
            DraftChannel::Email => "email",
            DraftChannel::Sms => "sms",
            DraftChannel::Whatsapp => "whatsapp",
            DraftChannel::Instagram => "instagram",
        }
    }

    fn shape(self) -> DraftShape {
        match self {
            DraftChannel::Email => DraftShape::Email,
            _ => DraftShape::Short,
        }
    }
}

/// `prospects.message_draft`'s input.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DraftInput {
    pub channel: DraftChannel,
}

/// The draft (a subject only for an email).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DraftText {
    pub subject: Option<String>,
    pub body: String,
}

/// Why there is no draft.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoDraft {
    /// The platform has no model configured.
    NoModel,
    /// The workspace's drafts for today are used up.
    DailyLimit,
    /// The model failed or gave no draft.
    Failed,
}

/// What `prospects.message_draft` answers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DraftOut {
    pub draft: Option<DraftText>,
    pub reason: Option<NoDraft>,
}

/// The instructions every workspace shares.
pub const SYSTEM_FIXED: &str = "You write the first message a small business sends to another \
business it has never written to before. A person at the sending business reads your draft, \
may change it, and sends it themselves.\n\
Rules:\n\
- Write only from the facts given: the business's own cards and the prospect's recorded facts. \
Never invent a fact, a customer, a number, a discount or a promise.\n\
- State no price unless a card states it, and then exactly as the card does.\n\
- Never break a line under \"Rules: never break them\".\n\
- Say why you write to this prospect in particular, from its recorded facts, in one sentence.\n\
- Be short, warm and plain; no exclamation marks in a row, no emojis, no marketing slogans.\n\
- Do not add an unsubscribe line, a legal footer, a postal address or a privacy notice: they \
are added when the message is sent.\n\
- Write in the language named under \"Language\".\n\
- Answer only through the `draft` tool.";

fn shape_rules(shape: DraftShape) -> &'static str {
    match shape {
        DraftShape::Email => {
            "An email: a subject of at most 8 words, and a body of at most 120 words with a \
             natural greeting, two or three short paragraphs and a sign-off with the business's \
             name."
        }
        DraftShape::Short => {
            "A short message (SMS, WhatsApp or a direct message): two or three short sentences, \
             at most 300 characters, a greeting and the business's name, no subject."
        }
    }
}

/// The workspace's part: who the business is, its cards and its prohibitions.
pub(crate) fn workspace_part(live: &Live, identity: &Identity) -> String {
    let mut out = format!("# The business\nName: {}\n", live.workspace_name());
    for (label, value) in [
        ("What it offers", &identity.product),
        ("How it speaks", &identity.voice),
        ("Its position", &identity.positioning),
        ("What sets it apart", &identity.usp),
    ] {
        if !value.trim().is_empty() {
            out.push_str(&format!("{label}: {}\n", value.trim()));
        }
    }
    out.push_str("\n# Knowledge cards\n");
    for (title, body) in live.reply_cards() {
        out.push_str(&format!("\n## {title}\n{body}\n"));
    }
    let brief = live.brief();
    if !brief.rules.is_empty() {
        out.push_str("\n# Rules: never break them\n");
        for line in &brief.rules {
            out.push_str(&format!("- {line}\n"));
        }
    }
    if !brief.notes.is_empty() {
        out.push_str("\n# The owner's latest notes\n");
        for line in &brief.notes {
            out.push_str(&format!("- {line}\n"));
        }
    }
    out
}

/// The language a prospect is written to in: its own, else its market's (Turkish by default).
fn language(p: &Prospect) -> &'static str {
    match p.language.as_deref() {
        Some("en") => "English",
        Some("de") => "German",
        Some("ar") => "Arabic",
        Some("ru") => "Russian",
        Some("tr") => "Turkish",
        _ if p.country != "TR" => "English",
        _ => "Turkish",
    }
}

fn source(s: &SourceRef) -> Option<String> {
    match s {
        SourceRef::Url { url, .. } => Some(url.clone()),
        SourceRef::Manual { note } => Some(format!("a person's note: {note}")),
        SourceRef::Import { .. } => None,
    }
}

/// The prospect's recorded facts, the channel and the language: the one user turn.
pub(crate) fn prospect_part(p: &Prospect, channel: DraftChannel) -> String {
    let mut out = format!("# The prospect\nName: {}\n", p.business_name);
    if let Some(sector) = &p.sector {
        out.push_str(&format!("Sector: {sector}\n"));
    }
    let place: Vec<&str> = [p.district.as_deref(), p.city.as_deref()]
        .into_iter()
        .flatten()
        .collect();
    if !place.is_empty() {
        out.push_str(&format!("Place: {}, {}\n", place.join(", "), p.country));
    }
    if let Some(note) = p.size.as_ref().and_then(|s| s.value.note.as_deref()) {
        out.push_str(&format!("Size: {note}\n"));
    }
    if !p.signals.is_empty() {
        out.push_str("\nWhy it fits (recorded by the research, with where it was seen):\n");
        for s in &p.signals {
            match source(&s.source) {
                Some(src) => out.push_str(&format!("- {} (source: {src})\n", s.text)),
                None => out.push_str(&format!("- {}\n", s.text)),
            }
        }
    }
    if !p.notes.trim().is_empty() {
        out.push_str(&format!("\nNotes about the business: {}\n", p.notes.trim()));
    }
    out.push_str(&format!(
        "\n# Channel\n{}: {}\n\n# Language\n{}\n",
        channel.key(),
        shape_rules(channel.shape()),
        language(p)
    ));
    out
}

/// How many drafts the workspace asked the model for since `since`, up to `cap`.
async fn made_since(
    r: &mut dyn TenantRepos,
    since: OffsetDateTime,
    cap: u32,
) -> Result<u32, AppError> {
    let rows = r
        .ledger()
        .list(LedgerFilter {
            action_prefix: Some(DRAFT_ACTION.to_owned()),
            actor_kind: None,
            agent_connection_id: None,
            limit: cap,
            before_id: None,
        })
        .await?;
    Ok(u32::try_from(rows.iter().filter(|row| row.entry.at >= since).count()).unwrap_or(u32::MAX))
}

/// `prospects.message_draft` (see the module docs).
pub async fn message_draft(
    deps: &Deps,
    ctx: &Ctx,
    id: ProspectId,
    input: DraftInput,
) -> Result<DraftOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let none = |reason| DraftOut {
        draft: None,
        reason: Some(reason),
    };
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let prospect = r
        .prospects()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such prospect"))?;
    let Some(model) = deps.connectors.draft_model() else {
        return Ok(none(NoDraft::NoModel));
    };
    let day_start = ctx.now.replace_time(time::Time::MIDNIGHT);
    if made_since(r.as_mut(), day_start, DRAFTS_PER_WORKSPACE_DAILY).await?
        >= DRAFTS_PER_WORKSPACE_DAILY
    {
        return Ok(none(NoDraft::DailyLimit));
    }
    let live = Live::read(r.as_mut()).await?;
    let frame = r.strategy().current_approved().await?;
    let system_workspace = match &live {
        Some(live) => workspace_part(live, &live.identity(frame.as_ref())),
        None => String::new(),
    };
    let shape = input.channel.shape();
    let request = DraftRequest {
        system_fixed: SYSTEM_FIXED.to_owned(),
        system_workspace,
        prospect: prospect_part(&prospect, input.channel),
        shape,
        max_tokens: DRAFT_MAX_TOKENS,
    };
    // The read is done; the model is asked outside any transaction.
    drop(r);
    let answer = model.draft(&request).await;
    let (draft, usage, failed) = match answer {
        Ok(a) => (a.draft, a.usage, None),
        Err(e) => (
            None,
            Default::default(),
            Some(match e {
                crate::ports::draft_model::ModelError::RateLimited { .. } => "rate_limited",
                crate::ports::draft_model::ModelError::Unavailable { .. } => "unavailable",
                crate::ports::draft_model::ModelError::Rejected { .. } => "rejected",
            }),
        ),
    };
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let version = crate::usecases::capabilities::version_in_force(r.as_mut()).await?;
    crate::usecases::capabilities::append(
        r.as_mut(),
        ctx,
        DRAFT_ACTION,
        "workspace",
        ctx.workspace_id,
        version,
        json!({
            "channel": input.channel.key(),
            "model": model.model(),
            "made": draft.is_some(),
            "error": failed,
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "cache_read_tokens": usage.cache_read_tokens,
            "cache_write_tokens": usage.cache_write_tokens,
            "cost_micro_usd": usage.cost_micro_usd,
        }),
    )
    .await?;
    r.commit().await?;
    let draft = draft
        .filter(|d| !d.body.trim().is_empty())
        .map(|d| DraftText {
            subject: match shape {
                DraftShape::Email => d
                    .subject
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty()),
                DraftShape::Short => None,
            },
            body: d.body.trim().to_owned(),
        });
    Ok(match draft {
        Some(d) => DraftOut {
            draft: Some(d),
            reason: None,
        },
        None => none(NoDraft::Failed),
    })
}
