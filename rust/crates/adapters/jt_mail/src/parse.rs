//! MIME bodies are parsed only for message text and attachment metadata. Protocol errors and
//! attachment contents are never copied into an error, event debug record or status payload.
use jt_app::ports::connectors::InboundEventDraft;
use jt_connector::{ConnectorError, EventKind};
use mailparse::{MailHeaderMap, ParsedMail};
use serde_json::{Value, json};
use time::OffsetDateTime;

/// Bound recursion and the number of MIME parts before entering mailparse's recursive parser.
/// Every multipart level requires a literal Content-Type header, and every child requires a
/// boundary line starting with '--'. Counting conservatively also includes occurrences in text;
/// rejecting an unusually complex message is preferable to exhausting the poller's stack.
fn bounded_parse(raw: &[u8]) -> Result<ParsedMail<'_>, ConnectorError> {
    if raw
        .windows(b"content-type".len())
        .filter(|w| w.eq_ignore_ascii_case(b"content-type"))
        .take(65)
        .count()
        > 64
        || raw
            .split(|b| *b == b'\n')
            .filter(|line| line.starts_with(b"--"))
            .take(513)
            .count()
            > 512
    {
        return Err(invalid());
    }
    mailparse::parse_mail(raw).map_err(|_| invalid())
}

pub(crate) fn rejected(
    account: &str,
    mailbox: &str,
    validity: u32,
    uid: u32,
    reason: &'static str,
) -> InboundEventDraft {
    InboundEventDraft {
        external_id: format!("imap:{account}:{mailbox}:{validity}:{uid}"),
        kind: EventKind::Unknown("mail_rejected".into()),
        payload: json!({"account_id":account, "mailbox":mailbox, "uid":uid, "reason":reason}),
        occurred_at: None,
    }
}
fn invalid() -> ConnectorError {
    ConnectorError::permanent("invalid MIME message")
}
fn header(mail: &ParsedMail<'_>, name: &str) -> Option<String> {
    mail.headers.get_first_value(name)
}
/// The longest sender display name a payload carries.
const MAX_DISPLAY_NAME: usize = 200;
/// The display name of a `From` address (`Ada Lovelace <ada@example.com>`), its encoded words
/// decoded, control characters dropped, trimmed and cut to [`MAX_DISPLAY_NAME`]; `None` when it
/// is empty or merely repeats the address.
fn display_name(name: Option<&str>, addr: &str) -> Option<String> {
    let name: String = name?
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .trim_matches('"')
        .trim()
        .chars()
        .take(MAX_DISPLAY_NAME)
        .collect();
    let name = name.trim();
    (!name.is_empty() && !name.eq_ignore_ascii_case(addr)).then(|| name.to_owned())
}
fn attachment(mail: &ParsedMail<'_>) -> bool {
    mail.get_content_disposition().disposition == mailparse::DispositionType::Attachment
        || mail
            .get_content_disposition()
            .params
            .contains_key("filename")
        || mail.ctype.params.contains_key("name")
}
fn parts(
    mail: &ParsedMail<'_>,
    text: &mut Vec<String>,
    html: &mut Vec<String>,
    attachments: &mut Vec<Value>,
    depth: usize,
) -> Result<(), ConnectorError> {
    if depth > 30 {
        return Err(invalid());
    }
    if attachment(mail) {
        let name = mail
            .get_content_disposition()
            .params
            .get("filename")
            .cloned()
            .or_else(|| mail.ctype.params.get("name").cloned())
            .unwrap_or_default();
        attachments.push(
            json!({"filename":name, "size":mail.get_body_raw().map_err(|_| invalid())?.len()}),
        );
    } else if mail.ctype.mimetype == "text/plain" {
        text.push(mail.get_body().map_err(|_| invalid())?);
    } else if mail.ctype.mimetype == "text/html" {
        html.push(mail.get_body().map_err(|_| invalid())?);
    } else if mail.ctype.mimetype.starts_with("multipart/") {
        for child in &mail.subparts {
            parts(child, text, html, attachments, depth + 1)?;
        }
    }
    Ok(())
}
// HTML is tokenized without a DOM or recursion. Decode entities, preserve word boundaries,
// and omit comments, scripts, styles and document metadata. This is a plain-text fallback,
// never a sanitizer whose output may be inserted into an HTML document. Only raw metadata
// elements are hidden: </head> and <body> may legally be omitted, so head cannot gate text.
fn html_text(body: &str) -> Result<String, ConnectorError> {
    use html5gum::{DefaultEmitter, Token, Tokenizer};
    let mut emitter = DefaultEmitter::<()>::default();
    emitter.naively_switch_states(true);
    let mut text = String::new();
    let mut hidden: Option<Vec<u8>> = None;
    for token in Tokenizer::new_with_emitter(body, emitter) {
        match token.map_err(|_| invalid())? {
            Token::StartTag(tag) => {
                let name = tag.name.as_slice();
                if matches!(name, b"script" | b"style" | b"title") && hidden.is_none() {
                    hidden = Some(name.to_vec());
                }
                if block_tag(name) {
                    text.push('\n');
                }
            }
            Token::EndTag(tag) => {
                let name = tag.name.as_slice();
                if hidden.as_deref() == Some(name) {
                    hidden = None;
                }
                if block_tag(name) {
                    text.push('\n');
                }
            }
            Token::String(value) if hidden.is_none() => {
                text.push_str(&String::from_utf8_lossy(&value));
            }
            _ => {}
        }
    }
    let mut rendered = String::new();
    for line in text.lines() {
        let mut words = line.split_whitespace();
        if let Some(first) = words.next() {
            if !rendered.is_empty() {
                rendered.push('\n');
            }
            rendered.push_str(first);
            for word in words {
                rendered.push(' ');
                rendered.push_str(word);
            }
        }
    }
    Ok(rendered)
}
fn block_tag(name: &[u8]) -> bool {
    matches!(
        name,
        b"p" | b"div"
            | b"br"
            | b"hr"
            | b"li"
            | b"ul"
            | b"ol"
            | b"tr"
            | b"td"
            | b"th"
            | b"h1"
            | b"h2"
            | b"h3"
            | b"h4"
            | b"h5"
            | b"h6"
            | b"section"
            | b"article"
            | b"blockquote"
            | b"pre"
    )
}
fn find_part<'a, 'b>(mail: &'a ParsedMail<'b>, mime: &str) -> Option<&'a ParsedMail<'b>> {
    if mail.ctype.mimetype == mime {
        return Some(mail);
    }
    mail.subparts.iter().find_map(|part| find_part(part, mime))
}
fn original_id(mail: &ParsedMail<'_>) -> Option<String> {
    for mime in ["text/rfc822-headers", "message/rfc822"] {
        if let Some(part) = find_part(mail, mime) {
            let body = part.get_body_raw().ok()?;
            let original = bounded_parse(&body).ok()?;
            if let Some(id) = header(&original, "Message-ID") {
                return Some(id);
            }
        }
    }
    if let Some(part) = find_part(mail, "message/delivery-status") {
        let body = part.get_body_raw().ok()?;
        let parsed = bounded_parse(&body).ok()?;
        return header(&parsed, "Original-Message-ID");
    }
    None
}
/// Decode one mailbox message into a provider event without performing network I/O.
pub fn event(
    account: &str,
    mailbox: &str,
    validity: u32,
    uid: u32,
    raw: &[u8],
    is_sent: bool,
) -> Result<InboundEventDraft, ConnectorError> {
    let mail = bounded_parse(raw)?;
    let mut texts = Vec::new();
    let mut html = Vec::new();
    let mut attachments = Vec::new();
    parts(&mail, &mut texts, &mut html, &mut attachments, 0)?;
    if texts.iter().all(|text| text.trim().is_empty()) {
        texts.clear();
        for body in html {
            texts.push(html_text(&body)?);
        }
    }
    let text = texts.join("\n");
    let date = header(&mail, "Date");
    let occurred_at = date
        .as_deref()
        .and_then(|d| mailparse::dateparse(d).ok())
        .and_then(|d| OffsetDateTime::from_unix_timestamp(d).ok());
    let sender = mail
        .headers
        .get_first_header("From")
        .and_then(|h| mailparse::addrparse_header(h).ok())
        .and_then(|list| list.extract_single_info());
    let name = sender
        .as_ref()
        .and_then(|single| display_name(single.display_name.as_deref(), &single.addr));
    let from = sender.map(|single| single.addr);
    let subject = header(&mail, "Subject").unwrap_or_default();
    // `name` (the sender's display name) is one of the keys erasure masks, like `from`.
    let mut payload = json!({"from":from, "name":name, "to":header(&mail,"To"), "subject":subject,
        "text":text, "message_id":header(&mail,"Message-ID"), "in_reply_to":header(&mail,"In-Reply-To"),
        "date":date, "attachments":attachments, "mailbox":mailbox, "account_id":account});
    let mut kind = EventKind::Message;
    if is_sent {
        kind = EventKind::Status;
        payload["status"] = json!("sent");
    } else if mail.ctype.mimetype == "multipart/report"
        && mail
            .ctype
            .params
            .get("report-type")
            .is_some_and(|t| t.eq_ignore_ascii_case("feedback-report"))
    {
        let feedback = find_part(&mail, "message/feedback-report").ok_or_else(invalid)?;
        let body = feedback.get_body_raw().map_err(|_| invalid())?;
        let report = bounded_parse(&body)?;
        let feedback_type = header(&report, "Feedback-Type").ok_or_else(invalid)?;
        if ["abuse", "fraud", "virus"]
            .iter()
            .any(|kind| feedback_type.trim().eq_ignore_ascii_case(kind))
        {
            let original = original_id(&mail).ok_or_else(invalid)?;
            kind = EventKind::Status;
            payload = json!({"status":"complaint","message_id":original,"mailbox":mailbox,"account_id":account,"date":date});
        } else {
            kind = EventKind::Unknown("mail_feedback".into());
            payload = json!({"mailbox":mailbox,"account_id":account});
        }
    } else if let Some(dsn) = find_part(&mail, "message/delivery-status") {
        let status = dsn.get_body().map_err(|_| invalid())?;
        if status
            .lines()
            .any(|l| l.trim().eq_ignore_ascii_case("Action: failed"))
        {
            // A bounce's own Message-ID cannot reconcile the original outbound message.
            let original = original_id(&mail).ok_or_else(invalid)?;
            kind = EventKind::Status;
            payload = json!({"status":"failed", "message_id":original, "mailbox":mailbox,
                "account_id":account, "from":header(&mail,"From"), "to":header(&mail,"To"), "date":date});
        }
    } else if ["unsubscribe", "withdraw consent", "withdrawal"]
        .iter()
        .any(|word| {
            subject.trim().eq_ignore_ascii_case(word) || text.trim().eq_ignore_ascii_case(word)
        })
    {
        // List-Unsubscribe on ordinary incoming newsletters advertises an endpoint; it is not
        // evidence that this person withdrew consent. Require an actual withdrawal request.
        kind = EventKind::Consent;
        payload["withdrawn"] = json!(true);
        payload["channel"] = json!("email");
    }
    Ok(InboundEventDraft {
        external_id: format!("imap:{account}:{mailbox}:{validity}:{uid}"),
        kind,
        payload,
        occurred_at,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn display_name_from_yields_single_mailbox_identity() {
        let draft = super::event("support@example.com", "INBOX", 7, 1,
            b"From: Ada Lovelace <ADA@Example.com>\r\nTo: support@example.com\r\nMessage-ID: <a@example.com>\r\nSubject: Help\r\n\r\nHello", false).unwrap();
        assert_eq!(draft.payload["from"], "ADA@Example.com");
        assert_eq!(draft.payload["name"], "Ada Lovelace");
    }

    #[test]
    fn the_display_name_is_decoded_cleaned_and_absent_when_it_says_nothing() {
        let draft = |from: &str| {
            let raw = format!(
                "From: {from}\r\nTo: support@example.com\r\nMessage-ID: <a@example.com>\r\nSubject: Help\r\n\r\nHello"
            );
            super::event("support@example.com", "INBOX", 7, 1, raw.as_bytes(), false).unwrap()
        };
        // An RFC 2047 encoded word, as Turkish names usually arrive.
        assert_eq!(
            draft("=?UTF-8?B?QXnFn2UgWcSxbG1heg==?= <ayse@example.com>").payload["name"],
            "Ayşe Yılmaz"
        );
        assert_eq!(
            draft("\"  Ada  \" <ada@example.com>").payload["name"],
            "Ada"
        );
        assert!(draft("ada@example.com").payload["name"].is_null());
        assert!(draft("<ada@example.com>").payload["name"].is_null());
        assert!(draft("\"ada@example.com\" <ada@example.com>").payload["name"].is_null());
        let long = format!("{} <ada@example.com>", "A".repeat(300));
        assert_eq!(
            draft(&long).payload["name"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            super::MAX_DISPLAY_NAME
        );
    }
}
