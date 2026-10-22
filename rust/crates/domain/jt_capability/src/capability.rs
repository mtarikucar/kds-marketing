//! The capability: one thing a workspace can act through (spec §6.1).

use jt_tenancy::{AgentConnectionId, WorkspaceId, define_id};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::budget::BudgetItemId;
use crate::kind::{CapabilityKind, Reach};
use crate::policy::{Policy, validate_policy};
use crate::status::StoredStatus;
use crate::{CapabilityError, Gap, Gaps, MAX_DESCRIPTION_CHARS, REDACTED_KEYS};
use crate::{check_len, checked_name, epoch};

define_id!(
    /// A capability.
    CapabilityId
);

/// The longest external id (the provider's account or page id), in characters.
pub const MAX_EXTERNAL_ID_CHARS: usize = 256;

/// The longest evidence text, in characters.
pub const MAX_EVIDENCE_TEXT_CHARS: usize = 4_000;

/// The most references one piece of evidence may carry.
pub const MAX_EVIDENCE_REFS: usize = 20;

/// The longest evidence reference, in characters.
pub const MAX_EVIDENCE_REF_CHARS: usize = 256;

/// The agent's proof of an agent or device capability: what it ran or saw, and references to
/// what backs it (a file id, a serial number, a screenshot id). The system records it and never
/// checks it (spec §6.4).
///
/// Stored, so reading is tolerant: a missing field reads as empty and an unknown one is ignored.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Evidence {
    pub text: String,
    pub refs: Vec<String>,
}

/// One capability of a workspace. Each kind may have many (spec K6, B10).
///
/// Stored, so reading is tolerant: an unknown field is ignored and every missing field but the
/// identity (`id`, `workspace_id`, `kind_key`) reads as the default named on it. The kind is kept
/// as its key so a capability whose kind later leaves [`crate::KINDS`] still reads;
/// [`Capability::kind`] finds the kind itself. The sealed credentials are never part of it: only
/// whether there are any (`has_sealed_config`).
///
/// Only [`Capability::new`] validates: a deserialised value is unchecked, so repositories and use
/// cases must never trust one as input for a write.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Capability {
    pub id: CapabilityId,
    pub workspace_id: WorkspaceId,
    /// The [`CapabilityKind::key`].
    pub kind_key: String,
    /// The tool's name for the third-party kind `other` (`[a-z0-9_-]{2,40}`); `None` for every
    /// other kind. Missing reads as `None`.
    #[serde(default)]
    pub key_detail: Option<String>,
    /// The tenant's name for it. Missing reads as empty.
    #[serde(default)]
    pub name: String,
    /// Missing reads as empty.
    #[serde(default)]
    pub description: String,
    /// Missing reads as `Connector` (see [`Reach`]).
    #[serde(default)]
    pub reach: Reach,
    /// Missing reads as `Declared`.
    #[serde(default)]
    pub status: StoredStatus,
    /// The provider's id of the account, page or line, when it has one. Missing reads as `None`.
    #[serde(default)]
    pub external_id: Option<String>,
    /// Public connector settings (a page name, a handle, granted scopes), never a secret: see
    /// [`validate_connector_public`]. Missing reads as `{}`.
    #[serde(default = "empty_object")]
    pub connector_public: Value,
    /// Whether sealed credentials are stored for it. Missing reads as `false`.
    #[serde(default)]
    pub has_sealed_config: bool,
    /// When it was last verified. Missing reads as `None`.
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub last_verified_at: Option<OffsetDateTime>,
    /// The evidence of the last verification by an agent. Missing reads as `None`.
    #[serde(default)]
    pub evidence: Option<Evidence>,
    /// Missing reads as [`Policy::default`].
    #[serde(default)]
    pub policy: Policy,
    /// The budget items it spends from. Missing reads as none.
    #[serde(default)]
    pub budget_item_ids: Vec<BudgetItemId>,
    /// The strategy version its policies came from. Missing reads as `None`.
    #[serde(default)]
    pub strategy_version_id: Option<Uuid>,
    /// The agent connection that declared it, when an agent did; `None` when a person did.
    /// An agent may verify a capability on its own evidence with `workspace.read` alone only
    /// through this connection. Missing reads as `None`.
    #[serde(default)]
    pub declared_by_connection: Option<AgentConnectionId>,
    /// Missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    /// Missing reads as the Unix epoch.
    #[serde(default = "epoch", with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

fn empty_object() -> Value {
    Value::Object(Map::new())
}

/// What a new capability is declared with; [`Capability::new`] checks it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct NewCapability {
    /// One of the [`crate::KINDS`] keys.
    pub kind_key: String,
    /// Required for the third-party kind `other`, refused for every other kind.
    pub key_detail: Option<String>,
    pub name: String,
    pub description: String,
    pub external_id: Option<String>,
    /// An object, or `null` for none (read as `{}`).
    pub connector_public: Value,
    pub policy: Policy,
}

impl Capability {
    /// A new, declared capability with the reach of its kind, created and updated at `now`, no
    /// verification, no sealed credentials, no budget links, no strategy version (the use case
    /// sets one when a strategy is approved) and no declaring connection (the use case sets the
    /// agent's).
    ///
    /// Refuses, in this order: a kind not on the list (`UnknownKind`); a missing, malformed or
    /// unexpected `key_detail` ([`validate_key_detail`]); a bad name (trimmed, then
    /// [`crate::validate_name`]); a description over [`MAX_DESCRIPTION_CHARS`] characters; a
    /// blank or over-long external id; public connector fields that are not an object or hold a
    /// secret-looking key (`InvalidConnectorPublic`, with every gap); a policy with gaps
    /// (`InvalidPolicy`, with every gap).
    pub fn new(
        id: CapabilityId,
        workspace_id: WorkspaceId,
        input: NewCapability,
        now: OffsetDateTime,
    ) -> Result<Capability, CapabilityError> {
        let NewCapability {
            kind_key,
            key_detail,
            name,
            description,
            external_id,
            connector_public,
            policy,
        } = input;

        let Some(kind) = CapabilityKind::parse(&kind_key) else {
            return Err(CapabilityError::UnknownKind(kind_key));
        };
        validate_key_detail(kind, key_detail.as_deref())?;
        let name = checked_name(name)?;
        check_len("description", &description, MAX_DESCRIPTION_CHARS)?;
        if let Some(external_id) = &external_id {
            if external_id.trim().is_empty() {
                return Err(CapabilityError::BlankExternalId);
            }
            check_len("external_id", external_id, MAX_EXTERNAL_ID_CHARS)?;
        }
        let connector_public = match connector_public {
            Value::Null => empty_object(),
            other => other,
        };
        let gaps = validate_connector_public(&connector_public);
        if !gaps.is_empty() {
            return Err(CapabilityError::InvalidConnectorPublic(gaps));
        }
        let gaps = validate_policy(&policy);
        if !gaps.is_empty() {
            return Err(CapabilityError::InvalidPolicy(gaps));
        }

        Ok(Capability {
            id,
            workspace_id,
            kind_key,
            key_detail,
            name,
            description,
            reach: kind.default_reach(),
            status: StoredStatus::Declared,
            external_id,
            connector_public,
            has_sealed_config: false,
            last_verified_at: None,
            evidence: None,
            policy,
            budget_item_ids: Vec::new(),
            strategy_version_id: None,
            declared_by_connection: None,
            created_at: now,
            updated_at: now,
        })
    }

    /// Its kind, or `None` when `kind_key` is not (or no longer) on the list.
    pub fn kind(&self) -> Option<&'static CapabilityKind> {
        CapabilityKind::parse(&self.kind_key)
    }
}

/// `Ok` when `key_detail` fits `kind`: the third-party kind `other` needs one
/// (`KeyDetailRequired`) of 2 to 40 characters of `a-z`, `0-9`, `_` and `-` (`InvalidKeyDetail`);
/// every other kind takes none (`KeyDetailNotAllowed`).
pub fn validate_key_detail(
    kind: &CapabilityKind,
    key_detail: Option<&str>,
) -> Result<(), CapabilityError> {
    match (kind.requires_key_detail(), key_detail) {
        (true, None) => Err(CapabilityError::KeyDetailRequired),
        (true, Some(detail)) => {
            let well_formed = (2..=40).contains(&detail.len())
                && detail.bytes().all(|b| {
                    b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-'
                });
            if well_formed {
                Ok(())
            } else {
                Err(CapabilityError::InvalidKeyDetail(detail.to_owned()))
            }
        }
        (false, None) => Ok(()),
        (false, Some(_)) => Err(CapabilityError::KeyDetailNotAllowed(kind.key.to_owned())),
    }
}

/// Every gap in public connector fields, under `connector_public`: the value is an object, and no
/// object key at any depth (inside arrays too) is one of [`REDACTED_KEYS`] by its exact name in
/// any case (`token` and `Token` are refused, `token_count` is not). A refused key's value is not
/// looked into. Keys are visited in sorted order, so the gaps come in a stable order.
pub fn validate_connector_public(value: &Value) -> Vec<Gap> {
    let mut gaps = Gaps::default();
    if value.is_object() {
        find_secret_keys(value, "connector_public", &mut gaps);
    } else {
        gaps.add(
            "connector_public",
            "the public connector fields must be an object",
        );
    }
    gaps.0
}

fn find_secret_keys(value: &Value, path: &str, gaps: &mut Gaps) {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            for key in keys {
                let field = format!("{path}.{key}");
                if REDACTED_KEYS.iter().any(|s| key.eq_ignore_ascii_case(s)) {
                    gaps.add(
                        field,
                        "a secret-looking key: secrets belong in the sealed configuration, \
                         never in the public fields",
                    );
                } else {
                    find_secret_keys(&map[key], &field, gaps);
                }
            }
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                find_secret_keys(item, &format!("{path}[{i}]"), gaps);
            }
        }
        _ => {}
    }
}

/// Every gap in a piece of evidence, under `evidence`: the text is not blank and has at most
/// [`MAX_EVIDENCE_TEXT_CHARS`] characters; at most [`MAX_EVIDENCE_REFS`] references, each not
/// blank and at most [`MAX_EVIDENCE_REF_CHARS`] characters.
pub fn validate_evidence(e: &Evidence) -> Vec<Gap> {
    let mut gaps = Gaps::default();
    let text_len = e.text.chars().count();
    if e.text.trim().is_empty() {
        gaps.add("evidence.text", "the evidence needs a text");
    } else if text_len > MAX_EVIDENCE_TEXT_CHARS {
        gaps.add(
            "evidence.text",
            format!("the text is {text_len} characters, at most {MAX_EVIDENCE_TEXT_CHARS} allowed"),
        );
    }
    if e.refs.len() > MAX_EVIDENCE_REFS {
        gaps.add(
            "evidence.refs",
            format!(
                "at most {MAX_EVIDENCE_REFS} references, got {}",
                e.refs.len()
            ),
        );
    } else {
        for (i, r) in e.refs.iter().enumerate() {
            let len = r.chars().count();
            if r.trim().is_empty() {
                gaps.add(
                    format!("evidence.refs[{i}]"),
                    "a reference must not be blank",
                );
            } else if len > MAX_EVIDENCE_REF_CHARS {
                gaps.add(
                    format!("evidence.refs[{i}]"),
                    format!(
                        "the reference is {len} characters, at most {MAX_EVIDENCE_REF_CHARS} allowed"
                    ),
                );
            }
        }
    }
    gaps.0
}
