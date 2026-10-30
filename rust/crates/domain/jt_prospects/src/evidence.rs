//! Provenance: where a value was seen, when, and who recorded it (spec §3.1, D4).

use jt_tenancy::{AgentConnectionId, UserId};
use serde::{Deserialize, Serialize};
use time::{Duration, OffsetDateTime};

use crate::{ProspectError, chars, invalid};

/// The most sources one field, signal list entry or origin names.
pub(crate) const MAX_SOURCES: usize = 5;
/// The longest source URL, in characters.
pub(crate) const MAX_URL_CHARS: usize = 2_048;
/// The longest note on a source, in characters.
pub(crate) const MAX_NOTE_CHARS: usize = 200;

/// The evidence of one recorded value.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    /// `1..=5` when an agent recorded it; a human may give one manual note instead.
    #[serde(default)]
    pub sources: Vec<SourceRef>,
    /// When the recorder saw the value: within `[now − 365 d, now + 5 min]` at the write.
    #[serde(with = "time::serde::rfc3339")]
    pub captured_at: OffsetDateTime,
    /// Set by Jeeta from the authenticated actor; never read from input.
    pub recorder: Recorder,
}

/// Where a value was seen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SourceRef {
    /// A public page where the business publishes the value.
    Url {
        url: String,
        #[serde(default)]
        note: Option<String>,
    },
    /// A person's note ("business card at a fair"): humans only.
    Manual { note: String },
    /// A record of an imported system ("v1"): the importer only.
    Import { system: String, record: String },
}

/// Who recorded a value: always the authenticated actor, never input.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Recorder {
    /// An agent, through its connection, on behalf of the user who issued the connection.
    Agent {
        connection_id: AgentConnectionId,
        user_id: UserId,
    },
    /// A signed-in person.
    Human { user_id: UserId },
    /// The operator's import of another system's record.
    Import { system: String, record: String },
}

impl Recorder {
    /// Whether the recorder is an agent.
    pub fn is_agent(&self) -> bool {
        matches!(self, Recorder::Agent { .. })
    }
}

/// A source as an agent or a person sends it. An import source is the importer's own and is
/// never accepted as input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SourceRefInput {
    Url {
        url: String,
        #[serde(default)]
        note: Option<String>,
    },
    Manual {
        note: String,
    },
}

impl SourceRefInput {
    /// The stored source: the URL and notes trimmed.
    pub(crate) fn into_source(self) -> SourceRef {
        match self {
            SourceRefInput::Url { url, note } => SourceRef::Url {
                url: url.trim().to_owned(),
                note: note.map(|n| n.trim().to_owned()).filter(|n| !n.is_empty()),
            },
            SourceRefInput::Manual { note } => SourceRef::Manual {
                note: note.trim().to_owned(),
            },
        }
    }
}

/// An absolute `http`/`https` URL of at most [`MAX_URL_CHARS`] characters.
pub(crate) fn http_url_ok(raw: &str) -> Result<(), &'static str> {
    let raw = raw.trim();
    if chars(raw) > MAX_URL_CHARS {
        return Err("too_long");
    }
    match url::Url::parse(raw) {
        Ok(u) if matches!(u.scheme(), "http" | "https") && u.host().is_some() => Ok(()),
        _ => Err("not_http"),
    }
}

/// One source as `recorder` may give it: a manual note is a person's, never an agent's.
/// Errors are reported on `field`.
pub(crate) fn validate_source(
    field: &'static str,
    source: &SourceRefInput,
    recorder: &Recorder,
) -> Result<(), ProspectError> {
    if matches!(source, SourceRefInput::Manual { .. }) && recorder.is_agent() {
        return Err(invalid(field, "manual_source_is_for_humans"));
    }
    validate_source_format(field, source)
}

/// One source's shape, whoever gives it: an `http(s)` URL with a short note, or a manual note of
/// `1..=200` characters.
pub(crate) fn validate_source_format(
    field: &'static str,
    source: &SourceRefInput,
) -> Result<(), ProspectError> {
    match source {
        SourceRefInput::Url { url, note } => {
            http_url_ok(url).map_err(|reason| {
                invalid(
                    field,
                    if reason == "too_long" {
                        "source_too_long"
                    } else {
                        "source_not_http"
                    },
                )
            })?;
            if note
                .as_deref()
                .is_some_and(|n| chars(n.trim()) > MAX_NOTE_CHARS)
            {
                return Err(invalid(field, "source_note_too_long"));
            }
            Ok(())
        }
        SourceRefInput::Manual { note } => {
            if (1..=MAX_NOTE_CHARS).contains(&chars(note.trim())) {
                Ok(())
            } else {
                Err(invalid(field, "manual_note_length"))
            }
        }
    }
}

/// The sources of one recorded value: `1..=5`, each valid for `recorder`.
pub(crate) fn validate_sources(
    field: &'static str,
    sources: &[SourceRefInput],
    recorder: &Recorder,
) -> Result<(), ProspectError> {
    if sources.is_empty() {
        return Err(invalid(field, "source_required"));
    }
    if sources.len() > MAX_SOURCES {
        return Err(invalid(field, "too_many_sources"));
    }
    sources
        .iter()
        .try_for_each(|s| validate_source(field, s, recorder))
}

/// `captured_at` within `[now − 365 d, now + 5 min]`.
pub(crate) fn validate_captured_at(
    field: &'static str,
    captured_at: OffsetDateTime,
    now: OffsetDateTime,
) -> Result<(), ProspectError> {
    if captured_at < now - Duration::days(365) || captured_at > now + Duration::minutes(5) {
        Err(invalid(field, "captured_at_out_of_window"))
    } else {
        Ok(())
    }
}
