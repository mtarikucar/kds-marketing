//! Links in plain text (spec §3.10, §3.14): finding `http(s)` links, spotting every other
//! scheme, rewriting a snapshot's links for click tracking, and the MAC input bytes and paths of
//! the public unsubscribe and click links. The MAC itself is the application's (its seal holds
//! the keys): first [`MAC_BYTES`] bytes of HMAC-SHA256 under the purpose's key, base64url
//! without padding.
//!
//! **One token for every commercial email** (spec D63): a public link names the email's outbox
//! entry id (the id its Message-ID `<id@host>` carries), whichever path sent it. An outreach
//! email's send row is found from it (`outreach_sends.outbox_id`); an inbox send has no send row,
//! and its outbox entry leads to the person.

use jt_tenancy::WorkspaceId;
use uuid::Uuid;

/// The longest link a template may hold, in characters.
pub const MAX_LINK_CHARS: usize = 2_048;

/// How many bytes of the HMAC-SHA256 a public link carries.
pub const MAC_BYTES: usize = 16;

/// Trimmed from the end of a link: punctuation that closes a sentence or a bracket around it.
const TRAILING: &[char] = &['.', ',', ';', ':', '!', '?', ')', ']', '\'', '"', '>'];

/// What the scanner found.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// `http://` or `https://` up to whitespace, trailing punctuation trimmed.
    Http,
    /// `http:` or `https:` without `//`.
    HttpWithoutSlashes,
    /// Another scheme followed by a letter or a slash: `javascript:`, `data:`, `mailto:`, …
    OtherScheme,
}

/// One token of [`scan`]: `text[start..end]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Found {
    pub(crate) start: usize,
    pub(crate) end: usize,
    pub(crate) kind: Kind,
}

/// Every scheme-like token of `text`, in order. A scheme is ASCII `[A-Za-z][A-Za-z0-9+.-]*`
/// directly followed by `:`, starting where no letter, digit, `+`, `.` or `-` precedes it.
/// `http`/`https` followed by `//` is a link up to the next whitespace; any other scheme counts
/// only when a letter or a slash follows its colon, so `Not: …`, `10:30` and `Tel: +90…` are
/// plain text.
pub(crate) fn scan(text: &str) -> Vec<Found> {
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut prev: Option<char> = None;
    let mut i = 0;
    while i < text.len() {
        let c = text[i..].chars().next().expect("i is on a char boundary");
        let boundary = prev.is_none_or(|p| !(p.is_alphanumeric() || matches!(p, '+' | '.' | '-')));
        if !(c.is_ascii_alphabetic() && boundary) {
            prev = Some(c);
            i += c.len_utf8();
            continue;
        }
        let mut j = i;
        while j < bytes.len()
            && (bytes[j].is_ascii_alphanumeric() || matches!(bytes[j], b'+' | b'.' | b'-'))
        {
            j += 1;
        }
        if bytes.get(j) != Some(&b':') {
            // A plain word: skip it whole (its characters are ASCII).
            prev = Some(char::from(bytes[j - 1]));
            i = j;
            continue;
        }
        let scheme = text[i..j].to_ascii_lowercase();
        let after = &text[j + 1..];
        if matches!(scheme.as_str(), "http" | "https") {
            if after.starts_with("//") {
                let end = text[i..]
                    .find(char::is_whitespace)
                    .map_or(text.len(), |n| i + n);
                let token = text[i..end].trim_end_matches(TRAILING);
                found.push(Found {
                    start: i,
                    end: i + token.len(),
                    kind: Kind::Http,
                });
                prev = text[..end].chars().next_back();
                i = end;
                continue;
            }
            found.push(Found {
                start: i,
                end: j + 1,
                kind: Kind::HttpWithoutSlashes,
            });
        } else if after
            .chars()
            .next()
            .is_some_and(|n| n.is_ascii_alphabetic() || n == '/')
        {
            found.push(Found {
                start: i,
                end: j + 1,
                kind: Kind::OtherScheme,
            });
        }
        prev = Some(':');
        i = j + 1;
    }
    found
}

/// `text` with every link that is one of `links` replaced by `url_for(its index in links)`.
/// Links are found as [`crate::validate_template`] finds them; a link not in `links` (one a
/// variable's value brought in, say) is left as it is.
pub fn rewrite_links(text: &str, links: &[String], url_for: &dyn Fn(usize) -> String) -> String {
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    for f in scan(text) {
        if f.kind != Kind::Http {
            continue;
        }
        if let Some(index) = links.iter().position(|l| *l == text[f.start..f.end]) {
            out.push_str(&text[copied..f.start]);
            out.push_str(&url_for(index));
            copied = f.end;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// What a public link's MAC proves; each purpose has its own key in the seal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MacPurpose {
    /// `/u/{workspace}/{token}/{mac}`: one-click unsubscribe and its confirmation page.
    Unsubscribe,
    /// `/c/{workspace}/{token}/{link}/{mac}`: the click redirect.
    Click,
}

impl MacPurpose {
    /// The purpose the seal derives the HMAC key for (`seal.hmac_key(ws, key)`), also the label
    /// that opens the MAC input.
    pub fn key(self) -> &'static str {
        match self {
            MacPurpose::Unsubscribe => "outreach.unsubscribe",
            MacPurpose::Click => "outreach.click",
        }
    }
}

/// The bytes a public link's MAC is computed over: the purpose's label, a zero byte, the token's
/// 16 bytes (the email's outbox entry id), then `0` without a link or `1` and the link index as
/// two big-endian bytes. Fixed width after the label, so no two inputs collide.
pub fn mac_input(purpose: MacPurpose, token: Uuid, link: Option<u16>) -> Vec<u8> {
    let label = purpose.key().as_bytes();
    let mut out = Vec::with_capacity(label.len() + 20);
    out.extend_from_slice(label);
    out.push(0);
    out.extend_from_slice(token.as_bytes());
    match link {
        None => out.push(0),
        Some(index) => {
            out.push(1);
            out.extend_from_slice(&index.to_be_bytes());
        }
    }
    out
}

/// The unsubscribe link's path, `/u/{workspace_id}/{token}/{mac}` (`mac` already encoded; the
/// token is the email's outbox entry id).
pub fn unsubscribe_path(ws: WorkspaceId, token: Uuid, mac: &str) -> String {
    format!("/u/{ws}/{token}/{mac}")
}

/// The click redirect's path, `/c/{workspace_id}/{token}/{link}/{mac}`.
pub fn click_path(ws: WorkspaceId, token: Uuid, link: u16, mac: &str) -> String {
    format!("/c/{ws}/{token}/{link}/{mac}")
}
