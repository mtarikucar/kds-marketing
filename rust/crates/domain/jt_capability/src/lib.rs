//! Capability domain: what a workspace can act through (spec §6) — the closed list of kinds, the
//! capability itself, groups, policies, budget items and spend, and the status a capability
//! effectively has at a given time. Pure, no I/O.
//!
//! Stored types (`Capability`, `Policy`, `Hours`, `Evidence`, `CapabilityGroup`, `BudgetItem`,
//! `BudgetSpend`, `Unit`) are tolerant on read: an unknown field is ignored and every missing
//! field but the identity (ids, a capability's `kind_key`, a budget item's `kind`) reads as a
//! default, so a row written by an older or a newer binary still reads. Each default is the
//! cautious one and is named on its field. Strictness belongs to the write side: the constructors
//! (`Capability::new`, `CapabilityGroup::new`, `BudgetItem::new`, `BudgetSpend::new`) and the
//! `validate_*` rules.
//!
//! Rules over a composite value (a policy, evidence, the public connector fields) never stop at
//! the first problem: they return every [`Gap`] at once, in field order.

mod budget;
mod capability;
mod group;
mod kind;
mod policy;
mod status;

use serde::{Deserialize, Serialize};

pub use budget::{
    BudgetItem, BudgetItemId, BudgetKind, BudgetSpend, BudgetSpendId, END_OF_TIME,
    MAX_REFERENCE_CHARS, MAX_UNIT_LABEL_CHARS, NewBudgetItem, NewBudgetSpend, Period, SpendSource,
    Unit, can_link_budget, period_window, remaining, unit_fits, validate_currency, validate_unit,
};
pub use capability::{
    Capability, CapabilityId, Evidence, MAX_EVIDENCE_REF_CHARS, MAX_EVIDENCE_REFS,
    MAX_EVIDENCE_TEXT_CHARS, MAX_EXTERNAL_ID_CHARS, NewCapability, validate_connector_public,
    validate_evidence, validate_key_detail,
};
pub use group::{CapabilityGroup, CapabilityGroupId};
/// The key names that must never appear in public fields: the ledger's redaction list.
pub use jt_ledger::REDACTED_KEYS;
pub use kind::{CapabilityKind, KINDS, KindGroup, Reach, kinds_in_group};
pub use policy::{DEFAULT_VERIFY_MAX_AGE_DAYS, Hours, MAX_TZ_CHARS, Policy, validate_policy};
pub use status::{EffectiveStatus, StoredStatus, effective_status};

/// The longest name of a capability, a group or a budget item, in characters.
pub const MAX_NAME_CHARS: usize = 64;

/// The longest description of a capability or purpose of a group, in characters.
pub const MAX_DESCRIPTION_CHARS: usize = 2_000;

/// A capability rule refused a value.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum CapabilityError {
    /// The kind key is not on the closed list ([`KINDS`]).
    #[error("unknown capability kind {0:?}")]
    UnknownKind(String),
    /// The third-party kind `other` needs a `key_detail` naming the tool.
    #[error("the kind \"other\" needs a key_detail naming the tool: 2 to 40 of a-z, 0-9, _ and -")]
    KeyDetailRequired,
    /// A `key_detail` is not `[a-z0-9_-]{2,40}`.
    #[error("invalid key_detail {0:?}: use 2 to 40 of a-z, 0-9, _ and -")]
    InvalidKeyDetail(String),
    /// A `key_detail` was given for a kind other than `other`.
    #[error("the kind {0:?} takes no key_detail")]
    KeyDetailNotAllowed(String),
    /// A name is empty or only whitespace.
    #[error("a name is required")]
    BlankName,
    /// A name is longer than [`MAX_NAME_CHARS`] characters.
    #[error("the name is {len} characters, at most {MAX_NAME_CHARS} allowed")]
    NameTooLong { len: usize },
    /// A name contains a control character (a line break, a tab, ...).
    #[error("a name must not contain control characters")]
    NameHasControlCharacter,
    /// A free text is longer than its bound.
    #[error("{field} is {len} characters, at most {max} allowed")]
    TextTooLong {
        field: &'static str,
        len: usize,
        max: usize,
    },
    /// An external id was given but is empty or only whitespace.
    #[error("an external id, when given, must not be blank")]
    BlankExternalId,
    /// The public connector fields are not an object or hold a secret-looking key.
    #[error("the public connector fields have {} problem(s)", .0.len())]
    InvalidConnectorPublic(Vec<Gap>),
    /// The policy breaks a rule of [`validate_policy`].
    #[error("the policy has {} problem(s)", .0.len())]
    InvalidPolicy(Vec<Gap>),
    /// A currency is not three uppercase ASCII letters (ISO 4217).
    #[error("invalid currency {0:?}: use an ISO 4217 code such as TRY")]
    InvalidCurrency(String),
    /// A count's unit label is blank or longer than [`MAX_UNIT_LABEL_CHARS`] characters.
    #[error("invalid unit label {0:?}: use 1 to {MAX_UNIT_LABEL_CHARS} characters")]
    InvalidUnitLabel(String),
    /// A budget cap is negative.
    #[error("the cap must not be negative, got {0}")]
    NegativeCap(i64),
    /// A spend amount is zero or negative.
    #[error("a spend amount must be positive, got {0}")]
    NonPositiveAmount(i64),
}

/// One problem with a value, for a `VALIDATION` answer that lists them all.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Gap {
    /// Dotted path of the field, e.g. `"policy.active_hours.days[2]"`.
    pub field: String,
    /// What is wrong, in English.
    pub message: String,
}

/// Collects gaps in the order they are found.
#[derive(Default)]
pub(crate) struct Gaps(pub(crate) Vec<Gap>);

impl Gaps {
    pub(crate) fn add(&mut self, field: impl Into<String>, message: impl Into<String>) {
        self.0.push(Gap {
            field: field.into(),
            message: message.into(),
        });
    }
}

/// `Ok` when `name` is not blank, has at most [`MAX_NAME_CHARS`] characters (characters, not
/// bytes) and no control character. Leading and trailing whitespace is allowed here; the
/// constructors trim it before storing the name.
pub fn validate_name(name: &str) -> Result<(), CapabilityError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(CapabilityError::BlankName);
    }
    let len = name.chars().count();
    if len > MAX_NAME_CHARS {
        return Err(CapabilityError::NameTooLong { len });
    }
    if name.chars().any(char::is_control) {
        return Err(CapabilityError::NameHasControlCharacter);
    }
    Ok(())
}

/// The name trimmed, once [`validate_name`] accepts it.
pub(crate) fn checked_name(name: String) -> Result<String, CapabilityError> {
    validate_name(&name)?;
    Ok(name.trim().to_owned())
}

/// `Ok` when `text` has at most `max` characters; else `TextTooLong` naming `field`.
pub(crate) fn check_len(
    field: &'static str,
    text: &str,
    max: usize,
) -> Result<(), CapabilityError> {
    let len = text.chars().count();
    if len > max {
        Err(CapabilityError::TextTooLong { field, len, max })
    } else {
        Ok(())
    }
}

/// The Unix epoch: what a missing stored timestamp reads as.
pub(crate) fn epoch() -> time::OffsetDateTime {
    time::OffsetDateTime::UNIX_EPOCH
}
