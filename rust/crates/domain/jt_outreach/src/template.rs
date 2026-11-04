//! Templates and rendering (spec §3.10, D12): a one-line subject and a plain-text body with
//! variables `{{name}}` or `{{name|fallback}}` from a fixed set, parsed by hand.
//!
//! Grammar: `{{`, a variable name (surrounding spaces allowed), optionally `|` and a fallback
//! of 1 to 80 characters without braces or control characters, then `}}`. A literal brace pair
//! is written `{{"{{"}}` (or `{{"}}"}}`; a literal holds braces only). A `{{` without its `}}`, a
//! lone `}}` and an empty name are `unbalanced_braces`; single braces are plain text. Links are
//! `http://` or `https://` up to whitespace, trailing `.,;:!?)]'">` trimmed; every other scheme
//! (`javascript:`, `data:`, `mailto:`, …) is refused, and so is a link that runs into a variable
//! or a literal (it could not be rewritten) or sits in the subject.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};

use crate::links::{Kind, scan};
use crate::{Footer, MAX_LINK_CHARS, StepSnapshot, TemplateId, chars, line, rewrite_links};

/// The longest template name, in characters.
pub const MAX_TEMPLATE_NAME_CHARS: usize = 120;
/// The longest subject, in characters, before and after substitution.
pub const MAX_SUBJECT_CHARS: usize = 200;
/// The longest body, in characters.
pub const MAX_BODY_CHARS: usize = 20_000;
/// The longest fallback (and brace literal), in characters.
pub const MAX_FALLBACK_CHARS: usize = 80;
/// The longest `custom.<key>` key: `[a-z0-9_]{1,32}`.
pub const MAX_CUSTOM_KEY_CHARS: usize = 32;
/// The most distinct links one body holds (a click link names its index).
pub const MAX_LINKS: usize = 20;

/// Where a variable stood, while links and schemes are scanned: no template holds it, since a
/// body refuses control characters other than line breaks and tabs, and a subject all of them.
const VAR_MARK: char = '\0';

/// A template's language; the footer follows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Lang {
    Tr,
    En,
}

impl Lang {
    /// Every language.
    pub const ALL: &[Lang] = &[Lang::Tr, Lang::En];

    /// The stable key, as stored.
    pub fn key(self) -> &'static str {
        match self {
            Lang::Tr => "tr",
            Lang::En => "en",
        }
    }

    /// The language with this key, if any.
    pub fn parse(key: &str) -> Option<Lang> {
        Lang::ALL.iter().copied().find(|l| l.key() == key)
    }
}

/// A template variable. Serialises as its key (`company`, `custom.opener`).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Var {
    FirstName,
    ContactName,
    Company,
    City,
    District,
    Sector,
    SenderName,
    SenderCompany,
    /// `custom.<key>`: a value the agent supplies per enrollment.
    Custom(String),
}

impl Var {
    /// The variable's key, as templates and [`RenderVars`] name it.
    pub fn key(&self) -> String {
        match self {
            Var::FirstName => "first_name".into(),
            Var::ContactName => "contact_name".into(),
            Var::Company => "company".into(),
            Var::City => "city".into(),
            Var::District => "district".into(),
            Var::Sector => "sector".into(),
            Var::SenderName => "sender_name".into(),
            Var::SenderCompany => "sender_company".into(),
            Var::Custom(key) => format!("custom.{key}"),
        }
    }

    /// The variable a name names: `Err("unknown_variable")` for a name outside the set,
    /// `Err("custom_key")` for a `custom.` key that is not `[a-z0-9_]{1,32}`.
    pub fn parse(name: &str) -> Result<Var, &'static str> {
        Ok(match name {
            "first_name" => Var::FirstName,
            "contact_name" => Var::ContactName,
            "company" => Var::Company,
            "city" => Var::City,
            "district" => Var::District,
            "sector" => Var::Sector,
            "sender_name" => Var::SenderName,
            "sender_company" => Var::SenderCompany,
            _ => match name.strip_prefix("custom.") {
                Some(key) if custom_key_ok(key) => Var::Custom(key.to_owned()),
                Some(_) => return Err("custom_key"),
                None => return Err("unknown_variable"),
            },
        })
    }

    /// The key of a `custom.*` variable.
    pub fn custom_key(&self) -> Option<&str> {
        match self {
            Var::Custom(key) => Some(key),
            _ => None,
        }
    }
}

impl Serialize for Var {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.key())
    }
}

impl<'de> Deserialize<'de> for Var {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Var, D::Error> {
        let key = String::deserialize(d)?;
        Var::parse(&key).map_err(D::Error::custom)
    }
}

/// `[a-z0-9_]{1,32}`: a `custom.*` key, also a personalization key.
pub(crate) fn custom_key_ok(key: &str) -> bool {
    (1..=MAX_CUSTOM_KEY_CHARS).contains(&key.len())
        && key
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// A stored template.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Template {
    pub id: TemplateId,
    pub name: String,
    pub language: Lang,
    pub subject: String,
    pub body: String,
    /// Starts at 1; each save is the next revision.
    pub revision: u32,
    #[serde(default)]
    pub archived: bool,
}

/// A template rule refused a subject or a body (`field` is `"subject"` or `"body"`).
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum TemplateError {
    #[error("{field}: {reason}")]
    Invalid {
        field: &'static str,
        reason: &'static str,
    },
    /// A variable outside the set; its name is the template's own text, never a recipient's.
    #[error("{field}: unknown_variable:{name}")]
    UnknownVariable { field: &'static str, name: String },
}

impl TemplateError {
    /// `"name"`, `"subject"` or `"body"`.
    pub fn field(&self) -> &'static str {
        match self {
            TemplateError::Invalid { field, .. } | TemplateError::UnknownVariable { field, .. } => {
                field
            }
        }
    }

    /// The stable reason key.
    pub fn reason(&self) -> &'static str {
        match self {
            TemplateError::Invalid { reason, .. } => reason,
            TemplateError::UnknownVariable { .. } => "unknown_variable",
        }
    }
}

fn invalid(field: &'static str, reason: &'static str) -> TemplateError {
    TemplateError::Invalid { field, reason }
}

/// What a valid template uses: its variables (each once, in first appearance order, the
/// subject's first) and its body's links (each once, in order, as written).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TemplateFacts {
    pub vars: Vec<Var>,
    pub links: Vec<String>,
}

/// A parsed piece of a subject or a body.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum Segment<'a> {
    Text(&'a str),
    /// Braces written as `{{"{{"}}`.
    Literal(&'a str),
    Var {
        var: Var,
        fallback: Option<&'a str>,
    },
}

/// `s` as segments, or the first grammar error.
pub(crate) fn parse<'a>(
    field: &'static str,
    s: &'a str,
) -> Result<Vec<Segment<'a>>, TemplateError> {
    let unbalanced = || invalid(field, "unbalanced_braces");
    let mut out = Vec::new();
    let mut rest = s;
    loop {
        let open = match (rest.find("{{"), rest.find("}}")) {
            (None, None) => {
                if !rest.is_empty() {
                    out.push(Segment::Text(rest));
                }
                return Ok(out);
            }
            (None, Some(_)) => return Err(unbalanced()),
            (Some(open), Some(close)) if close < open => return Err(unbalanced()),
            (Some(open), _) => open,
        };
        if open > 0 {
            out.push(Segment::Text(&rest[..open]));
        }
        let after = &rest[open + 2..];
        if let Some(literal) = after.strip_prefix('"') {
            let end = literal.find("\"}}").ok_or_else(unbalanced)?;
            let text = &literal[..end];
            if text.is_empty()
                || chars(text) > MAX_FALLBACK_CHARS
                || !text.chars().all(|c| c == '{' || c == '}')
            {
                return Err(invalid(field, "literal_invalid"));
            }
            out.push(Segment::Literal(text));
            rest = &literal[end + 3..];
            continue;
        }
        let end = after.find("}}").ok_or_else(unbalanced)?;
        let inner = &after[..end];
        let (name, fallback) = match inner.split_once('|') {
            Some((name, fallback)) => (name.trim(), Some(fallback.trim())),
            None => (inner.trim(), None),
        };
        if name.is_empty() || name.contains(['{', '}']) {
            return Err(unbalanced());
        }
        let var = Var::parse(name).map_err(|reason| match reason {
            "unknown_variable" => TemplateError::UnknownVariable {
                field,
                name: name.chars().take(64).collect(),
            },
            reason => invalid(field, reason),
        })?;
        if let Some(f) = fallback
            && (f.is_empty()
                || chars(f) > MAX_FALLBACK_CHARS
                || f.contains(['{', '}'])
                || f.chars().any(char::is_control))
        {
            return Err(invalid(field, "fallback_invalid"));
        }
        out.push(Segment::Var { var, fallback });
        rest = &after[end + 2..];
    }
}

/// The text links and schemes are looked for in: literals as written, each variable as
/// [`VAR_MARK`].
fn skeleton(parts: &[Segment<'_>]) -> String {
    let mut out = String::new();
    for p in parts {
        match p {
            Segment::Text(t) | Segment::Literal(t) => out.push_str(t),
            Segment::Var { .. } => out.push(VAR_MARK),
        }
    }
    out
}

/// A found link: no variable or brace inside, at most [`MAX_LINK_CHARS`], an `http(s)` URL
/// with a host.
fn check_link(link: &str) -> Result<(), TemplateError> {
    if link.contains(VAR_MARK) {
        return Err(invalid("body", "link_has_variable"));
    }
    if link.contains(['{', '}']) {
        return Err(invalid("body", "link_has_braces"));
    }
    if chars(link) > MAX_LINK_CHARS {
        return Err(invalid("body", "link_too_long"));
    }
    match url::Url::parse(link) {
        Ok(u)
            if matches!(u.scheme(), "http" | "https")
                && u.host_str().is_some_and(|h| !h.is_empty()) =>
        {
            Ok(())
        }
        _ => Err(invalid("body", "link_invalid")),
    }
}

/// A template's name: 1 to [`MAX_TEMPLATE_NAME_CHARS`] characters on one line.
pub fn validate_template_name(name: &str) -> Result<(), TemplateError> {
    line(name, 1, MAX_TEMPLATE_NAME_CHARS).map_err(|reason| invalid("name", reason))
}

/// Checks a template at save and answers what it uses. The subject is one line of 1 to
/// [`MAX_SUBJECT_CHARS`] characters without links; the body 1 to [`MAX_BODY_CHARS`] characters
/// without control characters other than line breaks and tabs, with at most [`MAX_LINKS`]
/// distinct `http(s)` links and no other scheme.
pub fn validate_template(subject: &str, body: &str) -> Result<TemplateFacts, TemplateError> {
    if subject.chars().any(char::is_control) {
        return Err(invalid("subject", "subject_line"));
    }
    if subject.trim().is_empty() || chars(subject) > MAX_SUBJECT_CHARS {
        return Err(invalid("subject", "length"));
    }
    if body
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err(invalid("body", "control_character"));
    }
    if body.trim().is_empty() || chars(body) > MAX_BODY_CHARS {
        return Err(invalid("body", "length"));
    }
    let subject_parts = parse("subject", subject)?;
    let body_parts = parse("body", body)?;
    if let Some(f) = scan(&skeleton(&subject_parts)).first() {
        return Err(invalid(
            "subject",
            match f.kind {
                Kind::Http => "link_in_subject",
                Kind::HttpWithoutSlashes => "link_invalid",
                Kind::OtherScheme => "link_scheme",
            },
        ));
    }
    let text = skeleton(&body_parts);
    let mut links: Vec<String> = Vec::new();
    for f in scan(&text) {
        match f.kind {
            Kind::OtherScheme => return Err(invalid("body", "link_scheme")),
            Kind::HttpWithoutSlashes => return Err(invalid("body", "link_invalid")),
            Kind::Http => {
                let link = &text[f.start..f.end];
                check_link(link)?;
                if !links.iter().any(|l| l == link) {
                    links.push(link.to_owned());
                }
            }
        }
    }
    if links.len() > MAX_LINKS {
        return Err(invalid("body", "too_many_links"));
    }
    let mut vars: Vec<Var> = Vec::new();
    for p in subject_parts.iter().chain(&body_parts) {
        if let Segment::Var { var, .. } = p
            && !vars.contains(var)
        {
            vars.push(var.clone());
        }
    }
    Ok(TemplateFacts { vars, links })
}

/// The values a step renders with, by variable key (`company`, `custom.opener`, …).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderVars {
    pub values: BTreeMap<String, String>,
}

/// A rendered email: the subject header and the text body with its footer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rendered {
    pub subject: String,
    pub text: String,
}

/// Why a step was not rendered. A missing variable stops that enrollment (never sent with a
/// blank); the others are the campaign's or the stored snapshot's.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum RenderError {
    /// A variable without a value (blank counts as none) and without a fallback; its key.
    #[error("missing_variable:{0}")]
    MissingVariable(String),
    /// The subject would not stay one line of 1 to [`MAX_SUBJECT_CHARS`] characters.
    #[error("header_unsafe")]
    HeaderUnsafe,
    /// A footer field is blank or holds a control character: the footer is mandatory.
    #[error("footer_incomplete")]
    FooterIncomplete,
    /// The stored snapshot does not parse (it was validated when saved).
    #[error("template_invalid")]
    TemplateInvalid,
}

/// Renders `s` with `vars` and appends `footer` in the snapshot's language. With `link_url`,
/// every occurrence of one of the snapshot's links in the template's own text becomes
/// `link_url(its index in s.links)`; links a variable's value brings in, and the footer's, are
/// left as they are.
pub fn render(
    s: &StepSnapshot,
    vars: &RenderVars,
    footer: &Footer,
    link_url: Option<&dyn Fn(usize) -> String>,
) -> Result<Rendered, RenderError> {
    footer.render(s.language)?;
    let body = render_body(s, vars, link_url)?;
    Ok(Rendered {
        text: crate::append_footer(&body.text, footer, s.language)?,
        subject: body.subject,
    })
}

/// [`render`] without the footer: the subject and the body as the template and the values make
/// them, links rewritten as `render` does. The footer is appended where the email is queued
/// ([`crate::append_footer`]), so every commercial email gets it in one place.
pub fn render_body(
    s: &StepSnapshot,
    vars: &RenderVars,
    link_url: Option<&dyn Fn(usize) -> String>,
) -> Result<Rendered, RenderError> {
    let subject_parts = parse("subject", &s.subject).map_err(|_| RenderError::TemplateInvalid)?;
    let body_parts = parse("body", &s.body).map_err(|_| RenderError::TemplateInvalid)?;
    let subject = substitute(&subject_parts, vars, None)?;
    let subject = subject.trim();
    if subject.is_empty()
        || subject.chars().any(char::is_control)
        || chars(subject) > MAX_SUBJECT_CHARS
    {
        return Err(RenderError::HeaderUnsafe);
    }
    let rewrite = link_url.map(|f| (s.links.as_slice(), f));
    let body = substitute(&body_parts, vars, rewrite)?;
    Ok(Rendered {
        subject: subject.to_owned(),
        text: body.trim_end().to_owned(),
    })
}

type Rewrite<'a> = (&'a [String], &'a dyn Fn(usize) -> String);

fn substitute(
    parts: &[Segment<'_>],
    vars: &RenderVars,
    rewrite: Option<Rewrite<'_>>,
) -> Result<String, RenderError> {
    let mut out = String::new();
    for p in parts {
        match p {
            Segment::Text(t) => match rewrite {
                Some((links, url_for)) => out.push_str(&rewrite_links(t, links, url_for)),
                None => out.push_str(t),
            },
            Segment::Literal(t) => out.push_str(t),
            Segment::Var { var, fallback } => {
                let key = var.key();
                let value = vars
                    .values
                    .get(&key)
                    .map(|v| v.trim())
                    .filter(|v| !v.is_empty());
                match (value, *fallback) {
                    (Some(v), _) | (None, Some(v)) => out.push_str(v),
                    (None, None) => return Err(RenderError::MissingVariable(key)),
                }
            }
        }
    }
    Ok(out)
}
