//! Cards: what the agents know about the business, one subject a card.

use jt_ledger::Actor;
use jt_studio::FileId;
use jt_tenancy::define_id;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;

use crate::Invalid;
use crate::limits::{
    MAX_ATTACHMENT_LABEL_CHARS, MAX_CARD_BODY_CHARS, MAX_CARD_POSITION, MAX_CARD_TITLE_CHARS,
    MAX_LINK_CHARS,
};
use crate::text::validate_text;

define_id!(
    /// A card of a workspace's knowledge base.
    KnowledgeCardId
);

/// The seed cards, in their positions (0 to 7): each `(key, title)`. The keys are fixed and
/// ASCII, for the agents; the titles are the owner's words.
pub const SEED_CARDS: [(&str, &str); 8] = [
    ("who_we_are", "Biz kimiz"),
    ("products_prices", "Ürünler ve fiyat"),
    ("voice", "Ses tonu"),
    ("customers", "Müşterilerimiz"),
    ("post_ideas", "Paylaşım fikirleri"),
    ("who_we_seek", "Kimi arıyoruz"),
    ("accounts_channels", "Hesaplar ve kanallar"),
    ("references", "Referanslar"),
];

/// The card the answers and notes of an approved strategy's consultation are kept in, after the
/// seed cards: `(key, title)`.
pub const PAST_CONVERSATIONS: (&str, &str) = ("past_conversations", "Önceki görüşmeler");

/// Whether a card of `key` is one the posting part of the frame is derived from (audience,
/// objective, topics): `who_we_are`, `products_prices`, `customers`, `post_ideas`,
/// `past_conversations`, and every card of the owner's own (no key).
pub fn feeds_posting(key: Option<&str>) -> bool {
    match key {
        None => true,
        Some(key) => matches!(
            key,
            "who_we_are" | "products_prices" | "customers" | "post_ideas" | "past_conversations"
        ),
    }
}

/// Whether a card of `key` is one the prospecting part of the frame is derived from (the ICP and
/// the rubric): `who_we_seek`, `customers`, and every card of the owner's own (no key).
pub fn feeds_prospecting(key: Option<&str>) -> bool {
    match key {
        None => true,
        Some(key) => matches!(key, "who_we_seek" | "customers"),
    }
}

/// Whether `key` is a card key: a lowercase ASCII letter, then 1 to 39 of `a-z`, `0-9` and `_`.
pub fn valid_key(key: &str) -> bool {
    let mut bytes = key.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_lowercase())
        && (2..=40).contains(&key.len())
        && bytes.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// What a card shows besides its text: a link, or a file of the workspace's studio files (an
/// image, an MP4 or a PDF; knowledge, never a library material).
///
/// Stored, so reading is tolerant of missing labels.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Attachment {
    Link {
        url: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    File {
        file_id: FileId,
        #[serde(default)]
        name: String,
        #[serde(default)]
        mime: String,
    },
}

/// An attachment as it is written: a link with an optional title, or the id of an uploaded file
/// (its name and type are the stored file's).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum AttachmentInput {
    Link {
        url: String,
        #[serde(default)]
        title: Option<String>,
    },
    File {
        file_id: FileId,
    },
}

/// One card of the knowledge base.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Card {
    pub id: KnowledgeCardId,
    /// A seed card's fixed key ([`SEED_CARDS`], [`PAST_CONVERSATIONS`]); none for the owner's own.
    #[serde(default)]
    pub key: Option<String>,
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
    /// Where the card stands; cards are listed by it (ties by creation).
    #[serde(default)]
    pub position: u32,
    /// 1 when created, +1 at every change.
    pub revision: u64,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub created_by: Actor,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub updated_by: Actor,
    /// When the owner removed it ("Kaldır"); a removed card can be restored.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub archived_at: Option<OffsetDateTime>,
}

impl Card {
    /// Not removed.
    pub fn is_live(&self) -> bool {
        self.archived_at.is_none()
    }

    /// Its body has a character that is not whitespace.
    pub fn has_text(&self) -> bool {
        !self.body.trim().is_empty()
    }

    /// What one of its revision rows keeps: the card as it now is, without its identity and its
    /// audit columns.
    pub fn content(&self) -> Value {
        json!({
            "key": self.key,
            "title": self.title,
            "body": self.body,
            "attachments": self.attachments,
            "position": self.position,
            "archived": self.archived_at.is_some(),
        })
    }
}

/// The knowledge base is empty when no live card has a body with a character that is not
/// whitespace (design §4.5.1). The rules and the goals do not count: they say what the agents
/// must not do and aim at, not who the business is.
pub fn is_empty<'a>(cards: impl IntoIterator<Item = &'a Card>) -> bool {
    !cards.into_iter().any(|c| c.is_live() && c.has_text())
}

/// A card's title as written: trimmed, 1 to [`MAX_CARD_TITLE_CHARS`] characters, naming `title`.
pub fn validate_title(raw: &str) -> Result<String, Invalid> {
    validate_text("title", raw, 1, MAX_CARD_TITLE_CHARS)
}

/// A card's body as written: trimmed, at most [`MAX_CARD_BODY_CHARS`] characters, naming `body`.
pub fn validate_body(raw: &str) -> Result<String, Invalid> {
    validate_text("body", raw, 0, MAX_CARD_BODY_CHARS)
}

/// A card's position as written: at most [`MAX_CARD_POSITION`]; else `out_of_range` naming
/// `position`.
pub fn validate_position(position: u32) -> Result<u32, Invalid> {
    if position > MAX_CARD_POSITION {
        return Err(Invalid::new(
            "position",
            "out_of_range",
            format!("a position is 0 to {MAX_CARD_POSITION}"),
        ));
    }
    Ok(position)
}

/// A link as written: trimmed, `https://` and a host, no whitespace, at most
/// [`MAX_LINK_CHARS`] characters; else `not_https` or `too_long` naming `field`.
pub fn validate_link(field: &str, raw: &str) -> Result<String, Invalid> {
    let url = validate_text(field, raw, 1, MAX_LINK_CHARS)?;
    let host = url
        .strip_prefix("https://")
        .map(|rest| rest.split(['/', '?', '#']).next().unwrap_or_default());
    let well_formed = host.is_some_and(|h| !h.is_empty() && !h.starts_with(':'))
        && !url.chars().any(|c| c.is_whitespace() || c.is_control());
    if !well_formed {
        return Err(Invalid::new(
            field,
            "not_https",
            "a link is an https:// address",
        ));
    }
    Ok(url)
}

/// A link's title as written: trimmed, at most [`MAX_ATTACHMENT_LABEL_CHARS`] characters; none
/// when nothing is left.
pub(crate) fn validate_label(field: &str, raw: &str) -> Result<Option<String>, Invalid> {
    let label = validate_text(field, raw, 0, MAX_ATTACHMENT_LABEL_CHARS)?;
    Ok((!label.is_empty()).then_some(label))
}

impl AttachmentInput {
    /// A link as stored, checked (`field` names the attachment, e.g. `attachments[2]`); `None`
    /// for a file, whose name and type the caller reads from the stored file.
    pub fn link(&self, field: &str) -> Result<Option<Attachment>, Invalid> {
        match self {
            AttachmentInput::Link { url, title } => Ok(Some(Attachment::Link {
                url: validate_link(&format!("{field}.url"), url)?,
                title: match title {
                    Some(t) => validate_label(&format!("{field}.title"), t)?,
                    None => None,
                },
            })),
            AttachmentInput::File { .. } => Ok(None),
        }
    }
}

/// Whether a stored file of type `mime` may be knowledge: an image, an MP4 video or a PDF.
pub fn is_knowledge_mime(mime: &str) -> bool {
    let mime = mime.trim().to_ascii_lowercase();
    mime.starts_with("image/") || mime == "video/mp4" || mime == "application/pdf"
}
