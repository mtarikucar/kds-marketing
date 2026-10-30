//! The prospect record (spec §3.1), its write inputs, and the rules that turn an input into a
//! record: `validate_create`, `build` and `apply_update`.

use jt_inbox::{IdentityChannel, JourneyId, PersonId, normalise};
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use crate::evidence::{
    MAX_SOURCES, http_url_ok, validate_captured_at, validate_source, validate_sources,
};
use crate::keys::{KeyKind, normalise_handle, website_domain};
use crate::{
    Bucket, DncReason, Evidence, ProspectError, ProspectId, ProspectStatus, Recorder, RejectReason,
    ResearchTaskId, SourceRef, SourceRefInput, bounded, chars, invalid, language_ok,
};

/// The most labels a prospect carries.
const MAX_LABELS: usize = 20;
/// The most signals a prospect carries.
const MAX_SIGNALS: usize = 20;
/// The most prospects one write names as distinct from it.
const MAX_DISTINCT_FROM: usize = 50;
/// The longest request key, in characters.
const MAX_REQUEST_KEY_CHARS: usize = 128;

/// A business in the pool. Never a private individual (spec D3).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Prospect {
    pub id: ProspectId,
    pub workspace_id: WorkspaceId,
    pub status: ProspectStatus,
    /// `1..=200` characters, trimmed; `"—"` once scrubbed.
    pub business_name: String,
    pub entity_kind: EntityKind,
    /// `1..=80`, in the workspace's words ("kafe").
    #[serde(default)]
    pub sector: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub district: Option<String>,
    /// ISO 3166-1 alpha-2, upper-case; `"TR"` unless given.
    #[serde(default = "default_country")]
    pub country: String,
    /// A BCP 47 primary tag, lower-case.
    #[serde(default)]
    pub language: Option<String>,
    /// A strategy audience segment key.
    #[serde(default)]
    pub segment_key: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub contact: ContactFields,
    #[serde(default)]
    pub size: Option<Field<SizeHint>>,
    #[serde(default)]
    pub signals: Vec<Signal>,
    /// About the business, never about a person.
    #[serde(default)]
    pub notes: String,
    pub origin: Origin,
    #[serde(default)]
    pub research_task_id: Option<ResearchTaskId>,
    /// Written only together with a score row.
    #[serde(default)]
    pub latest_score: Option<ScoreSummary>,
    #[serde(default)]
    pub decision: Option<Decision>,
    #[serde(default)]
    pub promoted: Option<Promotion>,
    #[serde(default, with = "time::serde::rfc3339::option")]
    pub purge_after: Option<OffsetDateTime>,
    pub revision: u32,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

fn default_country() -> String {
    "TR".to_owned()
}

fn yes() -> bool {
    true
}

/// What kind of business it is. There is no individual kind (spec D3).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    /// A company: A.Ş., Ltd. Şti. and the like.
    LegalEntity,
    /// A sole proprietorship or esnaf: its data is personal data (spec L-02).
    SoleTrader,
    /// A business whose form the recorder could not tell.
    UnknownBusiness,
}

impl EntityKind {
    /// The stable key, as stored.
    pub fn key(self) -> &'static str {
        match self {
            EntityKind::LegalEntity => "legal_entity",
            EntityKind::SoleTrader => "sole_trader",
            EntityKind::UnknownBusiness => "unknown_business",
        }
    }

    /// The kind with this key, if any.
    pub fn parse(key: &str) -> Option<EntityKind> {
        [
            EntityKind::LegalEntity,
            EntityKind::SoleTrader,
            EntityKind::UnknownBusiness,
        ]
        .into_iter()
        .find(|k| k.key() == key)
    }
}

/// The business's published contact data, every field with its evidence.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ContactFields {
    /// E.164.
    pub phone: Option<Field<String>>,
    /// Lower-cased.
    pub email: Option<Field<String>>,
    /// An absolute `http`/`https` URL, never on a platform host.
    pub website: Option<Field<String>>,
    /// A handle, `[a-z0-9._]{1,30}`.
    pub instagram: Option<Field<String>>,
    /// A handle, `[a-z0-9._]{2,24}`.
    pub tiktok: Option<Field<String>>,
    /// At most 300 characters.
    pub address: Option<Field<String>>,
    pub contact_person: Option<Field<ContactPerson>>,
}

/// A person the business itself publishes as its contact: a name and a role, nothing else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ContactPerson {
    /// `1..=120` characters.
    pub name: String,
    /// At most 80 characters.
    #[serde(default)]
    pub role: String,
}

/// A recorded value with its evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Field<T> {
    pub value: T,
    pub evidence: Evidence,
    /// False once an address hard-bounced (or v1 said so): the value stays as evidence but is
    /// no identity for promotion. Missing reads as true.
    #[serde(default = "yes")]
    pub deliverable: bool,
}

/// Why the business fits, with where that was seen.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Signal {
    /// `1..=200` characters.
    pub text: String,
    pub source: SourceRef,
}

/// How big the business is.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SizeHint {
    #[serde(default)]
    pub branches: Option<u16>,
    #[serde(default)]
    pub employees: Option<EmployeeBand>,
    /// At most 120 characters.
    #[serde(default)]
    pub note: Option<String>,
}

/// An employee count band.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum EmployeeBand {
    #[serde(rename = "1-9")]
    B1To9,
    #[serde(rename = "10-49")]
    B10To49,
    #[serde(rename = "50-249")]
    B50To249,
    #[serde(rename = "250+")]
    B250Plus,
}

/// Record-level provenance: how the business was found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Origin {
    pub via: OriginVia,
    /// `0..=5` pages it was discovered on (a directory listing, a search result).
    #[serde(default)]
    pub discovered_at: Vec<SourceRef>,
    /// Prospects the recorders said this one is not (a branch sharing a website or a name).
    #[serde(default)]
    pub distinct_from: Vec<ProspectId>,
    pub recorder: Recorder,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

/// How a prospect entered the pool.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OriginVia {
    /// Recorded for a research task.
    ResearchTask,
    /// Recorded by a person.
    Manual,
    /// Recorded by an agent outside a task.
    Agent,
    /// Imported from v1.
    V1Import,
}

/// The latest score, kept on the record for lists and filters.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScoreSummary {
    pub score: u8,
    /// The rubric digest the score was computed under.
    pub digest: String,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

/// A rejection or a do-not-contact decision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Decision {
    pub kind: DecisionKind,
    #[serde(default)]
    pub note: String,
    pub by: Recorder,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
}

/// What was decided.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DecisionKind {
    Rejected(RejectReason),
    DoNotContact(DncReason),
}

/// The inbox person and journey a prospect became.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Promotion {
    pub person_id: PersonId,
    pub journey_id: JourneyId,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    /// The score at promotion, frozen: the learning loop's input.
    #[serde(default)]
    pub score: Option<u8>,
    #[serde(default)]
    pub bucket: Option<Bucket>,
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

/// A value as an agent or a person sends it: no recorder, Jeeta fills it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FieldInput<T> {
    pub value: T,
    /// `1..=5`; agents give URLs, humans may give a manual note.
    pub sources: Vec<SourceRefInput>,
    #[serde(with = "time::serde::rfc3339")]
    pub captured_at: OffsetDateTime,
}

/// A signal as sent.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignalInput {
    pub text: String,
    pub source: SourceRefInput,
}

/// `jeeta.prospects.create`'s input.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInput {
    pub business_name: String,
    pub entity_kind: EntityKind,
    #[serde(default)]
    pub sector: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub district: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub segment_key: Option<String>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub phone: Option<FieldInput<String>>,
    #[serde(default)]
    pub email: Option<FieldInput<String>>,
    #[serde(default)]
    pub website: Option<FieldInput<String>>,
    #[serde(default)]
    pub instagram: Option<FieldInput<String>>,
    #[serde(default)]
    pub tiktok: Option<FieldInput<String>>,
    #[serde(default)]
    pub address: Option<FieldInput<String>>,
    #[serde(default)]
    pub contact_person: Option<FieldInput<ContactPerson>>,
    #[serde(default)]
    pub size: Option<FieldInput<SizeHint>>,
    #[serde(default)]
    pub signals: Vec<SignalInput>,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub research_task_id: Option<ResearchTaskId>,
    #[serde(default)]
    pub discovered_at: Vec<SourceRefInput>,
    #[serde(default)]
    pub distinct_from: Vec<ProspectId>,
    #[serde(default)]
    pub request_key: Option<String>,
}

/// The fields an update sets; each one given replaces the stored one, with new evidence.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetFields {
    #[serde(default)]
    pub sector: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub district: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub segment_key: Option<String>,
    #[serde(default)]
    pub labels: Option<Vec<String>>,
    #[serde(default)]
    pub phone: Option<FieldInput<String>>,
    #[serde(default)]
    pub email: Option<FieldInput<String>>,
    #[serde(default)]
    pub website: Option<FieldInput<String>>,
    #[serde(default)]
    pub instagram: Option<FieldInput<String>>,
    #[serde(default)]
    pub tiktok: Option<FieldInput<String>>,
    #[serde(default)]
    pub address: Option<FieldInput<String>>,
    #[serde(default)]
    pub contact_person: Option<FieldInput<ContactPerson>>,
    #[serde(default)]
    pub size: Option<FieldInput<SizeHint>>,
    #[serde(default)]
    pub signals: Option<Vec<SignalInput>>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// `jeeta.prospects.update`'s input: set some fields, clear others, at a known revision.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateInput {
    pub expected_revision: u32,
    #[serde(default)]
    pub set: SetFields,
    #[serde(default)]
    pub clear: Vec<FieldName>,
    #[serde(default)]
    pub distinct_from: Vec<ProspectId>,
}

/// A field an update names. The business name and kind are not among them: a wrong one is a
/// rejection (`duplicate` or `other`) and a new record.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FieldName {
    Sector,
    City,
    District,
    Language,
    SegmentKey,
    Labels,
    Phone,
    Email,
    Website,
    Instagram,
    Tiktok,
    Address,
    ContactPerson,
    Size,
    Signals,
    Notes,
}

impl FieldName {
    /// The stable key, as the ledger's `fields` names it.
    pub fn key(self) -> &'static str {
        match self {
            FieldName::Sector => "sector",
            FieldName::City => "city",
            FieldName::District => "district",
            FieldName::Language => "language",
            FieldName::SegmentKey => "segment_key",
            FieldName::Labels => "labels",
            FieldName::Phone => "phone",
            FieldName::Email => "email",
            FieldName::Website => "website",
            FieldName::Instagram => "instagram",
            FieldName::Tiktok => "tiktok",
            FieldName::Address => "address",
            FieldName::ContactPerson => "contact_person",
            FieldName::Size => "size",
            FieldName::Signals => "signals",
            FieldName::Notes => "notes",
        }
    }

    /// Whether clearing or setting this field changes the prospect's dedupe keys.
    pub fn touches_keys(self) -> bool {
        matches!(
            self,
            FieldName::City
                | FieldName::Phone
                | FieldName::Email
                | FieldName::Website
                | FieldName::Instagram
                | FieldName::Tiktok
        )
    }
}

impl Prospect {
    /// The fields that hold a value now, as the ledger names them (`prospects.created`).
    pub fn field_names(&self) -> Vec<FieldName> {
        let c = &self.contact;
        [
            (FieldName::Sector, self.sector.is_some()),
            (FieldName::City, self.city.is_some()),
            (FieldName::District, self.district.is_some()),
            (FieldName::Language, self.language.is_some()),
            (FieldName::SegmentKey, self.segment_key.is_some()),
            (FieldName::Labels, !self.labels.is_empty()),
            (FieldName::Phone, c.phone.is_some()),
            (FieldName::Email, c.email.is_some()),
            (FieldName::Website, c.website.is_some()),
            (FieldName::Instagram, c.instagram.is_some()),
            (FieldName::Tiktok, c.tiktok.is_some()),
            (FieldName::Address, c.address.is_some()),
            (FieldName::ContactPerson, c.contact_person.is_some()),
            (FieldName::Size, self.size.is_some()),
            (FieldName::Signals, !self.signals.is_empty()),
            (FieldName::Notes, !self.notes.is_empty()),
        ]
        .into_iter()
        .filter_map(|(f, has)| has.then_some(f))
        .collect()
    }
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

fn optional_text(
    field: &'static str,
    value: Option<&str>,
    max: usize,
) -> Result<(), ProspectError> {
    value.map_or(Ok(()), |v| bounded(field, v, 1, max))
}

fn validate_language(value: Option<&str>) -> Result<(), ProspectError> {
    match value {
        Some(v) if !language_ok(v) => Err(invalid("language", "invalid")),
        _ => Ok(()),
    }
}

fn validate_segment(value: Option<&str>) -> Result<(), ProspectError> {
    match value {
        Some(v) if jt_strategy::validate_segment_key(v.trim()).is_err() => {
            Err(invalid("segment_key", "invalid"))
        }
        _ => Ok(()),
    }
}

fn validate_labels(labels: &[String]) -> Result<(), ProspectError> {
    if labels.len() > MAX_LABELS {
        return Err(invalid("labels", "too_many"));
    }
    labels.iter().try_for_each(|l| bounded("labels", l, 1, 40))
}

fn validate_signals(signals: &[SignalInput], recorder: &Recorder) -> Result<(), ProspectError> {
    if signals.len() > MAX_SIGNALS {
        return Err(invalid("signals", "too_many"));
    }
    signals.iter().try_for_each(|s| {
        bounded("signals", &s.text, 1, 200)?;
        validate_source("signals", &s.source, recorder)
    })
}

fn validate_field<T>(
    field: &'static str,
    input: &FieldInput<T>,
    now: OffsetDateTime,
    recorder: &Recorder,
    value: impl FnOnce(&T) -> Result<(), &'static str>,
) -> Result<(), ProspectError> {
    value(&input.value).map_err(|reason| invalid(field, reason))?;
    validate_sources(field, &input.sources, recorder)?;
    validate_captured_at(field, input.captured_at, now)
}

// The validators of a `FieldInput<T>` take `&T`.
#[allow(clippy::ptr_arg)]
fn phone_ok(v: &String) -> Result<(), &'static str> {
    normalise(IdentityChannel::Phone, v)
        .map(drop)
        .map_err(|_| "invalid")
}

// The validators of a `FieldInput<T>` take `&T`.
#[allow(clippy::ptr_arg)]
fn email_ok(v: &String) -> Result<(), &'static str> {
    if chars(v.trim()) > 254 {
        return Err("too_long");
    }
    normalise(IdentityChannel::Email, v)
        .map(drop)
        .map_err(|_| "invalid")
}

// The validators of a `FieldInput<T>` take `&T`.
#[allow(clippy::ptr_arg)]
fn website_ok(v: &String) -> Result<(), &'static str> {
    http_url_ok(v)?;
    match website_domain(v) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err("website_is_a_platform_profile"),
        Err(_) => Err("not_http"),
    }
}

fn handle_ok(kind: KeyKind) -> impl Fn(&String) -> Result<(), &'static str> {
    move |v| normalise_handle(kind, v).map(drop).map_err(|_| "invalid")
}

// The validators of a `FieldInput<T>` take `&T`.
#[allow(clippy::ptr_arg)]
fn address_ok(v: &String) -> Result<(), &'static str> {
    match chars(v.trim()) {
        0 => Err("empty"),
        1..=300 => Ok(()),
        _ => Err("too_long"),
    }
}

fn contact_person_ok(v: &ContactPerson) -> Result<(), &'static str> {
    if !(1..=120).contains(&chars(v.name.trim())) {
        return Err("name_length");
    }
    if chars(v.role.trim()) > 80 {
        return Err("role_too_long");
    }
    Ok(())
}

fn size_ok(v: &SizeHint) -> Result<(), &'static str> {
    if v.note.as_deref().is_some_and(|n| chars(n.trim()) > 120) {
        return Err("note_too_long");
    }
    Ok(())
}

/// Every contact field, the size and the signals of a create or of an update's `set`.
#[allow(clippy::too_many_arguments)]
fn validate_contact(
    phone: Option<&FieldInput<String>>,
    email: Option<&FieldInput<String>>,
    website: Option<&FieldInput<String>>,
    instagram: Option<&FieldInput<String>>,
    tiktok: Option<&FieldInput<String>>,
    address: Option<&FieldInput<String>>,
    contact_person: Option<&FieldInput<ContactPerson>>,
    size: Option<&FieldInput<SizeHint>>,
    now: OffsetDateTime,
    recorder: &Recorder,
) -> Result<(), ProspectError> {
    if let Some(f) = phone {
        validate_field("phone", f, now, recorder, phone_ok)?;
    }
    if let Some(f) = email {
        validate_field("email", f, now, recorder, email_ok)?;
    }
    if let Some(f) = website {
        validate_field("website", f, now, recorder, website_ok)?;
    }
    if let Some(f) = instagram {
        validate_field("instagram", f, now, recorder, handle_ok(KeyKind::Instagram))?;
    }
    if let Some(f) = tiktok {
        validate_field("tiktok", f, now, recorder, handle_ok(KeyKind::Tiktok))?;
    }
    if let Some(f) = address {
        validate_field("address", f, now, recorder, address_ok)?;
    }
    if let Some(f) = contact_person {
        validate_field("contact_person", f, now, recorder, contact_person_ok)?;
    }
    if let Some(f) = size {
        validate_field("size", f, now, recorder, size_ok)?;
    }
    Ok(())
}

/// Checks a create input as `recorder` sends it at `now`: bounds of every field (spec §3.1),
/// evidence per contact field (agents give `http(s)` URLs; a manual note is for humans), the
/// `captured_at` window, a website that is not a platform profile.
pub fn validate_create(
    input: &CreateInput,
    now: OffsetDateTime,
    recorder: &Recorder,
) -> Result<(), ProspectError> {
    bounded("business_name", &input.business_name, 1, 200)?;
    optional_text("sector", input.sector.as_deref(), 80)?;
    optional_text("city", input.city.as_deref(), 80)?;
    optional_text("district", input.district.as_deref(), 80)?;
    validate_language(input.language.as_deref())?;
    validate_segment(input.segment_key.as_deref())?;
    if let Some(c) = &input.country {
        let c = c.trim();
        if c.len() != 2 || !c.bytes().all(|b| b.is_ascii_alphabetic()) {
            return Err(invalid("country", "invalid"));
        }
    }
    validate_labels(&input.labels)?;
    validate_contact(
        input.phone.as_ref(),
        input.email.as_ref(),
        input.website.as_ref(),
        input.instagram.as_ref(),
        input.tiktok.as_ref(),
        input.address.as_ref(),
        input.contact_person.as_ref(),
        input.size.as_ref(),
        now,
        recorder,
    )?;
    validate_signals(&input.signals, recorder)?;
    if chars(&input.notes) > 2_000 {
        return Err(invalid("notes", "too_long"));
    }
    if input.discovered_at.len() > MAX_SOURCES {
        return Err(invalid("discovered_at", "too_many_sources"));
    }
    input
        .discovered_at
        .iter()
        .try_for_each(|s| validate_source("discovered_at", s, recorder))?;
    if input.distinct_from.len() > MAX_DISTINCT_FROM {
        return Err(invalid("distinct_from", "too_many"));
    }
    if let Some(k) = &input.request_key
        && !(1..=MAX_REQUEST_KEY_CHARS).contains(&chars(k))
    {
        return Err(invalid("request_key", "length"));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------------------------

fn trimmed(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_owned())
}

fn labels_of(labels: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::with_capacity(labels.len());
    for l in labels {
        let l = l.trim().to_owned();
        if !out.contains(&l) {
            out.push(l);
        }
    }
    out
}

fn evidence_of(
    sources: Vec<SourceRefInput>,
    captured_at: OffsetDateTime,
    recorder: &Recorder,
) -> Evidence {
    Evidence {
        sources: sources
            .into_iter()
            .map(SourceRefInput::into_source)
            .collect(),
        captured_at,
        recorder: recorder.clone(),
    }
}

/// A validated field input as stored: its value normalised by `normal`, with evidence.
fn field_of<T>(input: FieldInput<T>, recorder: &Recorder, normal: impl FnOnce(T) -> T) -> Field<T> {
    Field {
        value: normal(input.value),
        evidence: evidence_of(input.sources, input.captured_at, recorder),
        deliverable: true,
    }
}

fn normal_phone(v: String) -> String {
    normalise(IdentityChannel::Phone, &v).unwrap_or(v)
}

fn normal_email(v: String) -> String {
    normalise(IdentityChannel::Email, &v).unwrap_or(v)
}

fn normal_handle(kind: KeyKind) -> impl FnOnce(String) -> String {
    move |v| normalise_handle(kind, &v).unwrap_or(v)
}

fn normal_text(v: String) -> String {
    v.trim().to_owned()
}

fn normal_person(v: ContactPerson) -> ContactPerson {
    ContactPerson {
        name: v.name.trim().to_owned(),
        role: v.role.trim().to_owned(),
    }
}

fn normal_size(v: SizeHint) -> SizeHint {
    SizeHint {
        note: v
            .note
            .map(|n| n.trim().to_owned())
            .filter(|n| !n.is_empty()),
        ..v
    }
}

fn signals_of(signals: Vec<SignalInput>) -> Vec<Signal> {
    signals
        .into_iter()
        .map(|s| Signal {
            text: s.text.trim().to_owned(),
            source: s.source.into_source(),
        })
        .collect()
}

fn dedup_ids(ids: Vec<ProspectId>) -> Vec<ProspectId> {
    let mut out: Vec<ProspectId> = Vec::with_capacity(ids.len());
    for id in ids {
        if !out.contains(&id) {
            out.push(id);
        }
    }
    out
}

/// The record a validated create input makes, recorded by `recorder` at `now`: status `new`,
/// revision 1, values normalised (an E.164 phone, a lower-cased email, bare handles), each
/// field's evidence naming the recorder. `purge_after` is the caller's, from its policy.
pub fn build(
    input: CreateInput,
    id: ProspectId,
    ws: WorkspaceId,
    now: OffsetDateTime,
    recorder: Recorder,
) -> Prospect {
    let via = match (&recorder, input.research_task_id) {
        (Recorder::Import { .. }, _) => OriginVia::V1Import,
        (_, Some(_)) => OriginVia::ResearchTask,
        (Recorder::Agent { .. }, None) => OriginVia::Agent,
        (Recorder::Human { .. }, None) => OriginVia::Manual,
    };
    let r = &recorder;
    let contact = ContactFields {
        phone: input.phone.map(|f| field_of(f, r, normal_phone)),
        email: input.email.map(|f| field_of(f, r, normal_email)),
        website: input.website.map(|f| field_of(f, r, normal_text)),
        instagram: input
            .instagram
            .map(|f| field_of(f, r, normal_handle(KeyKind::Instagram))),
        tiktok: input
            .tiktok
            .map(|f| field_of(f, r, normal_handle(KeyKind::Tiktok))),
        address: input.address.map(|f| field_of(f, r, normal_text)),
        contact_person: input.contact_person.map(|f| field_of(f, r, normal_person)),
    };
    Prospect {
        id,
        workspace_id: ws,
        status: ProspectStatus::New,
        business_name: input.business_name.trim().to_owned(),
        entity_kind: input.entity_kind,
        sector: trimmed(input.sector),
        city: trimmed(input.city),
        district: trimmed(input.district),
        country: input
            .country
            .map(|c| c.trim().to_ascii_uppercase())
            .unwrap_or_else(default_country),
        language: input.language.map(|l| l.trim().to_ascii_lowercase()),
        segment_key: trimmed(input.segment_key),
        labels: labels_of(input.labels),
        contact,
        size: input.size.map(|f| field_of(f, r, normal_size)),
        signals: signals_of(input.signals),
        notes: input.notes.trim().to_owned(),
        origin: Origin {
            via,
            discovered_at: input
                .discovered_at
                .into_iter()
                .map(SourceRefInput::into_source)
                .collect(),
            distinct_from: dedup_ids(input.distinct_from),
            recorder: recorder.clone(),
            at: now,
        },
        research_task_id: input.research_task_id,
        latest_score: None,
        decision: None,
        promoted: None,
        purge_after: None,
        revision: 1,
        created_at: now,
        updated_at: now,
    }
}

/// Applies an update recorded by `recorder` at `now`: each set field is validated as on create
/// and replaces the stored one with new evidence; each cleared field is emptied; the names in
/// `distinct_from` join the origin's. A field both set and cleared, or an update that names
/// nothing, is refused and changes nothing. On success the revision is one higher and
/// `updated_at` is `now` (the repository compares `expected_revision` with the stored one);
/// answers the changed fields in [`FieldName`] order.
pub fn apply_update(
    p: &mut Prospect,
    input: UpdateInput,
    now: OffsetDateTime,
    recorder: Recorder,
) -> Result<Vec<FieldName>, ProspectError> {
    let s = &input.set;
    let set: Vec<FieldName> = [
        (FieldName::Sector, s.sector.is_some()),
        (FieldName::City, s.city.is_some()),
        (FieldName::District, s.district.is_some()),
        (FieldName::Language, s.language.is_some()),
        (FieldName::SegmentKey, s.segment_key.is_some()),
        (FieldName::Labels, s.labels.is_some()),
        (FieldName::Phone, s.phone.is_some()),
        (FieldName::Email, s.email.is_some()),
        (FieldName::Website, s.website.is_some()),
        (FieldName::Instagram, s.instagram.is_some()),
        (FieldName::Tiktok, s.tiktok.is_some()),
        (FieldName::Address, s.address.is_some()),
        (FieldName::ContactPerson, s.contact_person.is_some()),
        (FieldName::Size, s.size.is_some()),
        (FieldName::Signals, s.signals.is_some()),
        (FieldName::Notes, s.notes.is_some()),
    ]
    .into_iter()
    .filter_map(|(f, given)| given.then_some(f))
    .collect();
    if set.iter().any(|f| input.clear.contains(f)) {
        return Err(invalid("clear", "set_and_cleared"));
    }
    if set.is_empty() && input.clear.is_empty() && input.distinct_from.is_empty() {
        return Err(invalid("set", "nothing_to_update"));
    }
    optional_text("sector", s.sector.as_deref(), 80)?;
    optional_text("city", s.city.as_deref(), 80)?;
    optional_text("district", s.district.as_deref(), 80)?;
    validate_language(s.language.as_deref())?;
    validate_segment(s.segment_key.as_deref())?;
    if let Some(l) = &s.labels {
        validate_labels(l)?;
    }
    validate_contact(
        s.phone.as_ref(),
        s.email.as_ref(),
        s.website.as_ref(),
        s.instagram.as_ref(),
        s.tiktok.as_ref(),
        s.address.as_ref(),
        s.contact_person.as_ref(),
        s.size.as_ref(),
        now,
        &recorder,
    )?;
    if let Some(signals) = &s.signals {
        validate_signals(signals, &recorder)?;
    }
    if s.notes.as_deref().is_some_and(|n| chars(n) > 2_000) {
        return Err(invalid("notes", "too_long"));
    }
    if p.origin.distinct_from.len() + input.distinct_from.len() > MAX_DISTINCT_FROM {
        return Err(invalid("distinct_from", "too_many"));
    }

    for f in &input.clear {
        let c = &mut p.contact;
        match f {
            FieldName::Sector => p.sector = None,
            FieldName::City => p.city = None,
            FieldName::District => p.district = None,
            FieldName::Language => p.language = None,
            FieldName::SegmentKey => p.segment_key = None,
            FieldName::Labels => p.labels.clear(),
            FieldName::Phone => c.phone = None,
            FieldName::Email => c.email = None,
            FieldName::Website => c.website = None,
            FieldName::Instagram => c.instagram = None,
            FieldName::Tiktok => c.tiktok = None,
            FieldName::Address => c.address = None,
            FieldName::ContactPerson => c.contact_person = None,
            FieldName::Size => p.size = None,
            FieldName::Signals => p.signals.clear(),
            FieldName::Notes => p.notes.clear(),
        }
    }
    let r = &recorder;
    let s = input.set;
    if let Some(v) = s.sector {
        p.sector = Some(normal_text(v));
    }
    if let Some(v) = s.city {
        p.city = Some(normal_text(v));
    }
    if let Some(v) = s.district {
        p.district = Some(normal_text(v));
    }
    if let Some(v) = s.language {
        p.language = Some(v.trim().to_ascii_lowercase());
    }
    if let Some(v) = s.segment_key {
        p.segment_key = Some(normal_text(v));
    }
    if let Some(v) = s.labels {
        p.labels = labels_of(v);
    }
    let c = &mut p.contact;
    if let Some(f) = s.phone {
        c.phone = Some(field_of(f, r, normal_phone));
    }
    if let Some(f) = s.email {
        c.email = Some(field_of(f, r, normal_email));
    }
    if let Some(f) = s.website {
        c.website = Some(field_of(f, r, normal_text));
    }
    if let Some(f) = s.instagram {
        c.instagram = Some(field_of(f, r, normal_handle(KeyKind::Instagram)));
    }
    if let Some(f) = s.tiktok {
        c.tiktok = Some(field_of(f, r, normal_handle(KeyKind::Tiktok)));
    }
    if let Some(f) = s.address {
        c.address = Some(field_of(f, r, normal_text));
    }
    if let Some(f) = s.contact_person {
        c.contact_person = Some(field_of(f, r, normal_person));
    }
    if let Some(f) = s.size {
        p.size = Some(field_of(f, r, normal_size));
    }
    if let Some(v) = s.signals {
        p.signals = signals_of(v);
    }
    if let Some(v) = s.notes {
        p.notes = v.trim().to_owned();
    }
    let mut distinct = std::mem::take(&mut p.origin.distinct_from);
    distinct.extend(input.distinct_from);
    p.origin.distinct_from = dedup_ids(distinct);

    p.revision += 1;
    p.updated_at = now;
    let mut changed = set;
    changed.extend(input.clear);
    changed.sort();
    changed.dedup();
    Ok(changed)
}
