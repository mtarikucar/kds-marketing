//! The prospect pool's pure domain (spec 2026-10-30-leads-pool-outreach-design.md §3.1–§3.8):
//! businesses an agent or a person researched, each contact field with its evidence, the dedupe
//! keys, the status machine, score writes against the strategy's rubric, the research brief, the
//! retention arithmetic and the agents' playbook. No I/O.
//!
//! Inputs (`CreateInput`, `UpdateInput`, `ScoreInput`, …) refuse unknown fields and never carry
//! a [`Recorder`]: the application fills it from the authenticated actor. Stored records
//! (`Prospect` and its parts) read tolerantly where they can, as `jt_inbox` does.
//!
//! Errors name a field and a stable reason key, never the value: a prospect's values are
//! personal data of a sole trader or a named contact person (spec D3).

mod brief;
mod evidence;
mod ids;
mod keys;
pub mod playbook;
mod policy;
mod prospect;
mod score;
mod status;

pub use brief::{Brief, Claim, ResearchTask, TaskKind, TaskStatus, validate_brief};
pub use evidence::{Evidence, Recorder, SourceRef, SourceRefInput};
pub use ids::{ProspectId, ResearchTaskId};
pub use keys::{
    FREE_MAIL_DOMAINS, Key, KeyKind, PLATFORM_HOSTS, blocklist_material, derive_keys, name_city,
    normalise_handle, normalise_key, website_domain,
};
pub use policy::{MAX_DAILY_PROSPECTS, ProspectsPolicy, purge_after};
pub use prospect::{
    ContactFields, ContactPerson, CreateInput, Decision, DecisionKind, EmployeeBand, EntityKind,
    Field, FieldInput, FieldName, Origin, OriginVia, Promotion, Prospect, ScoreSummary, SetFields,
    Signal, SignalInput, SizeHint, UpdateInput, apply_update, build, validate_create,
};
pub use score::{Bucket, Reason, ReasonInput, ScoreInput, bucket, validate_score};
pub use status::{
    DncReason, ProspectStatus, RejectReason, StatusError, StatusEvent, next_status, scrub_for_dnc,
};

/// A pool rule refused an input. `field` is the input's field name (`"phone"`, `"signals"`, …)
/// and `reason` a stable snake_case key (`"source_required"`, `"website_is_a_platform_profile"`,
/// …); neither carries the value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ProspectError {
    #[error("{field}: {reason}")]
    Invalid {
        field: &'static str,
        reason: &'static str,
    },
}

pub(crate) fn invalid(field: &'static str, reason: &'static str) -> ProspectError {
    ProspectError::Invalid { field, reason }
}

/// Characters, not bytes: every length bound of the spec counts characters.
pub(crate) fn chars(s: &str) -> usize {
    s.chars().count()
}

/// A trimmed text of `min..=max` characters, else `length`.
pub(crate) fn bounded(
    field: &'static str,
    s: &str,
    min: usize,
    max: usize,
) -> Result<(), ProspectError> {
    let n = chars(s.trim());
    if (min..=max).contains(&n) {
        Ok(())
    } else {
        Err(invalid(field, "length"))
    }
}

/// A BCP 47 primary language tag: 2 to 8 ASCII letters (`tr`, `en`).
pub(crate) fn language_ok(s: &str) -> bool {
    let s = s.trim();
    (2..=8).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphabetic())
}
