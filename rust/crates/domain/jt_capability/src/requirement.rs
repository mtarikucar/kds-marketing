//! A module's capability requirement (spec 2026-11-10-module-capability-gating-design.md).
//!
//! A blueprint's requirement line gates the module when it parses as a **requirement
//! expression**: one or more capability kind keys or group keys joined by `|`, any one of which
//! satisfies it (`messaging`, `mailbox|sms_line|whatsapp_cloud`). A line that does not parse is a
//! descriptive note and never gates. Kind keys and group keys share one namespace.

use crate::kind::{CapabilityKind, KindGroup};
use crate::status::StoredStatus;

/// One alternative of a requirement: a kind, or every kind of a group.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RequirementTerm {
    /// Exactly this kind.
    Kind(&'static CapabilityKind),
    /// Any kind of this group.
    Group(KindGroup),
}

impl RequirementTerm {
    /// The key it was written with.
    pub fn key(&self) -> &'static str {
        match self {
            RequirementTerm::Kind(kind) => kind.key,
            RequirementTerm::Group(group) => group.key(),
        }
    }

    fn admits(&self, kind_key: &str) -> bool {
        match self {
            RequirementTerm::Kind(kind) => kind.key == kind_key,
            RequirementTerm::Group(group) => {
                CapabilityKind::parse(kind_key).is_some_and(|kind| kind.group == *group)
            }
        }
    }
}

/// A gating requirement: satisfied by a connected capability of any of its terms.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Requirement {
    terms: Vec<RequirementTerm>,
}

impl Requirement {
    /// The requirement a line expresses, or `None` when the line is a free-text note. Blank
    /// alternatives, unknown keys and repeated keys make the whole line a note.
    pub fn parse(line: &str) -> Option<Requirement> {
        let mut terms = Vec::new();
        for raw in line.split('|') {
            let key = raw.trim();
            let term = KindGroup::parse(key)
                .map(RequirementTerm::Group)
                .or_else(|| CapabilityKind::parse(key).map(RequirementTerm::Kind))?;
            if terms.contains(&term) {
                return None;
            }
            terms.push(term);
        }
        Some(Requirement { terms })
    }

    /// Its alternatives, in the order written.
    pub fn terms(&self) -> &[RequirementTerm] {
        &self.terms
    }

    /// Its canonical text: the keys joined by `|`.
    pub fn text(&self) -> String {
        self.terms
            .iter()
            .map(RequirementTerm::key)
            .collect::<Vec<_>>()
            .join("|")
    }

    /// Whether one of `capabilities` (kind key and stored status) satisfies it.
    pub fn is_met<'a>(
        &self,
        capabilities: impl IntoIterator<Item = (&'a str, StoredStatus)>,
    ) -> bool {
        capabilities.into_iter().any(|(kind, status)| {
            counts_as_connected(status) && self.terms.iter().any(|term| term.admits(kind))
        })
    }
}

/// Whether a capability in `status` satisfies a requirement: once connected (verified), a
/// temporary failure (unreachable) must not lock a module; never connected (declared) and
/// retired do not count.
pub fn counts_as_connected(status: StoredStatus) -> bool {
    matches!(status, StoredStatus::Verified | StoredStatus::Unreachable)
}

/// The gating requirements of a blueprint's lines that `capabilities` leave unmet, in their
/// canonical text; empty when the module is ready. Free-text lines never gate.
pub fn missing_requirements<'a>(
    lines: impl IntoIterator<Item = &'a str>,
    capabilities: &[(&str, StoredStatus)],
) -> Vec<String> {
    lines
        .into_iter()
        .filter_map(Requirement::parse)
        .filter(|req| !req.is_met(capabilities.iter().copied()))
        .map(|req| req.text())
        .collect()
}
