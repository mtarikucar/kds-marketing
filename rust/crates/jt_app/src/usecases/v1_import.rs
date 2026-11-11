//! Operator-only, reversible v1 lead intake. No providers, jobs or public catalog surface.
//!
//! Each lead is routed (spec 2026-10-30-leads-pool-outreach-design.md §10, D23): a lead past
//! `NEW`, with any contact evidence, from an inbound source, or from a format-1 export goes to
//! the inbox as before; a never-contacted research lead goes to the prospect pool, recorded by
//! the importer (`Recorder::Import`), the one system actor that writes the pool. Inbox leads are
//! imported before pool leads, so a pool lead whose phone or email an inbox lead of the same file
//! holds is counted `pool_in_inbox` and imports nothing.
use crate::{
    error::AppError,
    ports::{
        SecretBox, TenantRepos,
        prospects::{BlockReason, Inserted, ScoreRow},
        v1_import::{ImportRepos, ImportStore},
    },
    usecases::prospects::{blocklist_fingerprint_in, blocklist_hash_in},
};
use jt_inbox::*;
use jt_ledger::{Action, Actor, LedgerEntry};
use jt_prospects::{
    ContactPerson, CreateInput, Evidence, FieldInput, Key, KeyKind, Prospect, ProspectId,
    ProspectStatus, Recorder, Signal, SizeHint, SourceRef, WebsiteHost, classify_website,
    derive_keys, normalise_handle, normalise_phone, phone_is_dialable,
};
use jt_tenancy::{Email, MembershipStatus, UserId, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

/// The sources whose leads reached us or whom we met: never the pool (spec §10).
pub const INBOUND_SOURCES: &[&str] = &[
    "INSTAGRAM",
    "WEBSITE",
    "PHONE",
    "EMAIL",
    "ADS",
    "REFERRAL",
    "HARDWARE_QUOTE",
    "FIELD_VISIT",
];

/// The rubric digest of a score v1 computed: no Jeeta rubric, so no strategy version.
pub const V1_SCORE_DIGEST: &str = "v1-legacy";

/// The export format this importer reads besides format 1 (which has no `format` field).
pub const EXPORT_FORMAT: u8 = 2;

/// The v1 activity type that is no note: the stage it records is the journey's.
const STATUS_CHANGE: &str = "STATUS_CHANGE";

/// Upper bounds of one lead's lists (the 1 MiB line bound holds them anyway).
const MAX_ACTIVITIES: usize = 5_000;
const MAX_OFFERS: usize = 500;
const MAX_TAGS: usize = 200;

/// Where a lead goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Inbox,
    Pool,
    SkipDeleted,
    SkipMerged,
}

/// Contact evidence counted at export (format 2). Any of it means the lead was contacted.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Contact {
    #[serde(default)]
    pub conversations_outbound: u64,
    #[serde(default)]
    pub conversations_inbound: u64,
    #[serde(default)]
    pub campaign_sent: u64,
    #[serde(default)]
    pub mail_sent: u64,
    #[serde(default)]
    pub activities_outbound: u64,
    #[serde(default)]
    pub offers: u64,
    #[serde(default)]
    pub last_contact_at: Option<String>,
}

impl Contact {
    /// Whether any contact evidence is there.
    pub fn any(&self) -> bool {
        self.conversations_outbound
            + self.conversations_inbound
            + self.campaign_sent
            + self.mail_sent
            + self.activities_outbound
            + self.offers
            > 0
            || self.last_contact_at.is_some()
    }
}

/// A v1 activity (`lead_activities`).
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Activity {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub outcome: Option<String>,
    pub created_at: String,
}

/// A v1 offer (`lead_offers`): no delivery channel, so never a Rust quote.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Offer {
    pub id: String,
    pub status: String,
    #[serde(default)]
    pub plan_name: Option<String>,
    #[serde(default)]
    pub price: Option<f64>,
    #[serde(default)]
    pub currency: Option<String>,
    #[serde(default)]
    pub valid_until: Option<String>,
    pub created_at: String,
}

/// The lead's attribution, query strings other than `utm_*` dropped at export.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Attribution {
    #[serde(default)]
    pub utm_source: Option<String>,
    #[serde(default)]
    pub utm_medium: Option<String>,
    #[serde(default)]
    pub utm_campaign: Option<String>,
    #[serde(default)]
    pub utm_content: Option<String>,
    #[serde(default)]
    pub utm_term: Option<String>,
    #[serde(default)]
    pub landing_path: Option<String>,
    #[serde(default)]
    pub referrer_host: Option<String>,
}

/// The v1 research candidate that became the lead (`research_candidates.leadId`), latest first.
#[derive(Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Research {
    #[serde(default)]
    pub evidence: Option<String>,
    #[serde(default)]
    pub pain_point: Option<String>,
    #[serde(default)]
    pub pitch: Option<String>,
    #[serde(default)]
    pub stage: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub instagram: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub created_at: Option<String>,
}

/// Strict export allowlist. Intentionally no Debug implementation for personal data. Format 1
/// has the fields up to `updated_at`; format 2 (`format: 2`) adds the optional rest.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lead {
    #[serde(default)]
    pub format: Option<u8>,
    pub id: String,
    pub business_name: String,
    pub contact_person: String,
    pub phone: Option<String>,
    pub whatsapp: Option<String>,
    pub email: Option<String>,
    pub address: Option<String>,
    pub city: Option<String>,
    pub region: Option<String>,
    pub business_type: String,
    pub table_count: Option<i64>,
    pub branch_count: Option<i64>,
    pub current_system: Option<String>,
    pub source: String,
    pub status: String,
    pub lost_reason: Option<String>,
    pub notes: Option<String>,
    pub next_follow_up: Option<String>,
    pub priority: String,
    pub custom_fields: Value,
    pub email_opt_out: bool,
    pub sms_opt_out: bool,
    pub wa_opt_out: bool,
    pub email_bounced_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default)]
    pub deleted_at: Option<String>,
    #[serde(default)]
    pub merged_into_id: Option<String>,
    #[serde(default)]
    pub contact: Option<Contact>,
    #[serde(default)]
    pub activities: Vec<Activity>,
    #[serde(default)]
    pub offers: Vec<Offer>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub attribution: Option<Attribution>,
    #[serde(default)]
    pub research: Option<Research>,
    #[serde(default)]
    pub ai_score: Option<i64>,
    #[serde(default)]
    pub ai_score_reason: Option<String>,
    #[serde(default)]
    pub scored_at: Option<String>,
    #[serde(default)]
    pub owner_email: Option<String>,
    #[serde(default)]
    pub email_verified_status: Option<String>,
}

/// Counts are the entire stdout/log/ledger contract; no field values or identifiers.
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct Report {
    pub total: u64,
    /// Inbox people written (or, in a dry run, that would be).
    pub imported: u64,
    pub already_present: u64,
    pub duplicates_merged: u64,
    pub identities_invalid: u64,
    pub identities_conflicting: u64,
    pub erased_skipped: u64,
    pub opt_outs: u64,
    pub tasks: u64,
    pub rolled_back: u64,
    pub kept: u64,
    /// Leads routed to the inbox and to the pool, and those skipped.
    pub to_inbox: u64,
    pub to_pool: u64,
    pub skipped_deleted: u64,
    pub skipped_merged: u64,
    /// Prospects written.
    pub pooled: u64,
    /// Pool leads whose hard key a prospect holds already.
    pub pool_duplicates: u64,
    /// Pool leads whose phone or email is an inbox identity: the relationship exists.
    pub pool_in_inbox: u64,
    /// Pool leads that opted out in v1: their keys are on the do-not-contact list, no prospect.
    pub pool_dnc: u64,
    /// Pool leads whose hard key the blocklist holds already (an objection, an erasure or a
    /// remembered rejection).
    pub pool_blocked: u64,
    /// Pool leads the pool cannot hold (a business name outside 1..=200, a key over 400).
    pub pool_invalid: u64,
    /// Imported journeys given their v1 owner, and v1 owners that are no active member.
    pub owners_mapped: u64,
    pub owners_unmapped: u64,
    pub activities_as_notes: u64,
    pub offers_as_notes: u64,
    /// Imported prospects deleted by a rollback, and those kept because they changed.
    pub prospects_rolled_back: u64,
    pub prospects_kept: u64,
}

/// What became of a lead's v1 owner.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    /// The lead had none.
    None,
    /// An active member with that email.
    Mapped(UserId),
    /// No active member has that email: the journey waits for `distribution.backfill`.
    Unmapped,
}

/// One v1 activity as an inbox note.
#[derive(Clone, PartialEq, Eq)]
pub struct ActivityNote {
    pub activity_id: String,
    pub text: String,
    pub at: OffsetDateTime,
}

/// A pool lead as the pool stores it: the prospect, its keys, and v1's score.
#[derive(Clone)]
pub struct PoolRecord {
    pub prospect: Prospect,
    pub keys: Vec<Key>,
    pub score: Option<ScoreRow>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Import,
    DryRun,
    Rollback,
}

fn invalid() -> AppError {
    AppError::validation("v1 import input_invalid", json!({}))
}
pub fn map_status(raw: &str) -> Result<JourneyStatus, AppError> {
    v1_journey_status(raw).ok_or_else(invalid)
}
fn timestamp(raw: &str) -> Result<OffsetDateTime, AppError> {
    // Prisma PostgreSQL DateTime is timestamp without time zone; v1 stored UTC.
    let raw = if raw.ends_with('Z')
        || raw
            .get(10..)
            .is_some_and(|s| s.contains('+') || s.contains('-'))
    {
        raw.to_owned()
    } else {
        format!("{raw}Z")
    };
    OffsetDateTime::parse(&raw, &Rfc3339).map_err(|_| invalid())
}
pub fn entity_id(ws: WorkspaceId, lead: &str, kind: &str) -> Uuid {
    let lead_namespace = Uuid::new_v5(&ws.as_uuid(), lead.as_bytes());
    Uuid::new_v5(&lead_namespace, kind.as_bytes())
}

struct IdentityKeys {
    channel: IdentityChannel,
    canonical: String,
    aliases: Vec<String>,
}

impl Lead {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.id.trim().is_empty() || self.id.len() > 256 || !self.custom_fields.is_object() {
            return Err(invalid());
        }
        map_status(&self.status)?;
        if timestamp(&self.updated_at)? < timestamp(&self.created_at)? {
            return Err(invalid());
        }
        if self.format.is_some_and(|f| f != EXPORT_FORMAT)
            || self.activities.len() > MAX_ACTIVITIES
            || self.offers.len() > MAX_OFFERS
            || self.tags.len() > MAX_TAGS
        {
            return Err(invalid());
        }
        let research_at = self.research.as_ref().and_then(|r| r.created_at.as_ref());
        let contact_at = self
            .contact
            .as_ref()
            .and_then(|c| c.last_contact_at.as_ref());
        for value in [
            &self.next_follow_up,
            &self.email_bounced_at,
            &self.deleted_at,
            &self.scored_at,
        ]
        .into_iter()
        .flatten()
        .chain(research_at)
        .chain(contact_at)
        .chain(self.activities.iter().map(|a| &a.created_at))
        .chain(self.offers.iter().map(|o| &o.created_at))
        .chain(self.offers.iter().filter_map(|o| o.valid_until.as_ref()))
        {
            timestamp(value)?;
        }
        Ok(())
    }
    /// Each activity but a status change as a note text, oldest first as exported.
    pub fn activity_notes(&self) -> Result<Vec<ActivityNote>, AppError> {
        self.activities
            .iter()
            .filter(|a| a.kind != STATUS_CHANGE)
            .map(|a| {
                let mut head = vec![format!("v1 {}", a.kind)];
                head.extend(
                    [a.outcome.as_deref(), Some(a.title.as_str())]
                        .into_iter()
                        .flatten()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                        .map(str::to_owned),
                );
                let mut text = head.join(" · ");
                if let Some(d) = a.description.as_deref().filter(|d| !d.trim().is_empty()) {
                    text.push('\n');
                    text.push_str(d);
                }
                Ok(ActivityNote {
                    activity_id: a.id.clone(),
                    text,
                    at: timestamp(&a.created_at)?,
                })
            })
            .collect()
    }
    /// The offers as one note ("v1 teklifleri"), one line each; none without offers.
    pub fn offers_note(&self) -> Option<String> {
        if self.offers.is_empty() {
            return None;
        }
        let mut lines = vec!["v1 teklifleri".to_owned()];
        for o in &self.offers {
            let price = o.price.map(|p| match o.currency.as_deref() {
                Some(c) if !c.trim().is_empty() => format!("{p} {}", c.trim()),
                _ => p.to_string(),
            });
            let valid = o.valid_until.as_ref().map(|v| format!("geçerlilik {v}"));
            let parts: Vec<String> = [
                Some(o.status.clone()),
                o.plan_name.clone(),
                price,
                valid,
                Some(o.created_at.clone()),
            ]
            .into_iter()
            .flatten()
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty())
            .collect();
            lines.push(parts.join(" · "));
        }
        Some(lines.join("\n"))
    }
    /// The hard keys v1 recorded an objection for: the email for an email opt-out, every phone
    /// number for an SMS or WhatsApp opt-out. Values that do not normalise are left out.
    pub fn dnc_keys(&self) -> Vec<Key> {
        let mut keys = BTreeSet::new();
        if self.email_opt_out
            && let Some(email) = self.email.as_deref().and_then(pool_email)
        {
            keys.insert(Key {
                kind: KeyKind::Email,
                value: email,
            });
        }
        if self.sms_opt_out || self.wa_opt_out {
            for raw in [&self.phone, &self.whatsapp].into_iter().flatten() {
                if let Some(phone) = pool_phone(raw) {
                    keys.insert(Key {
                        kind: KeyKind::Phone,
                        value: phone,
                    });
                }
            }
        }
        keys.into_iter().collect()
    }
    /// Canonical values for new imports; matching also checks legacy shared-intake aliases.
    pub fn identities(&self) -> (Vec<(IdentityChannel, String)>, u64) {
        let (keys, invalid) = self.identity_keys();
        (
            keys.into_iter()
                .map(|key| (key.channel, key.canonical))
                .collect(),
            invalid,
        )
    }
    fn identity_keys(&self) -> (Vec<IdentityKeys>, u64) {
        let mut result: Vec<IdentityKeys> = Vec::new();
        let mut invalid = 0;
        for (channel, raw) in [
            (IdentityChannel::Phone, &self.phone),
            (IdentityChannel::Phone, &self.whatsapp),
            (IdentityChannel::Email, &self.email),
        ] {
            let Some(raw) = raw.as_ref().filter(|v| !v.trim().is_empty()) else {
                continue;
            };
            let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
            let local = if channel == IdentityChannel::Phone
                && !raw.trim().starts_with('+')
                && digits.len() == 10
            {
                format!("0{digits}")
            } else {
                raw.clone()
            };
            let Ok(canonical) = normalise(channel, &local) else {
                invalid += 1;
                continue;
            };
            if (channel == IdentityChannel::Email && canonical.chars().count() > 254)
                || (channel == IdentityChannel::Phone
                    && canonical.chars().filter(char::is_ascii_digit).count() > 15)
            {
                invalid += 1;
                continue;
            }
            let mut aliases = vec![canonical.clone()];
            if let Ok(shared) = normalise(channel, raw) {
                aliases.push(shared);
            }
            // Legacy intake omitted TR for ten-digit national numbers. Check that historical
            // key explicitly: the current normaliser now adds TR. Never store this alias.
            if channel == IdentityChannel::Phone
                && canonical.len() == 13
                && canonical.starts_with("+90")
            {
                aliases.push(format!("+{}", &canonical[3..]));
            }
            if let Some(existing) = result
                .iter_mut()
                .find(|key| key.channel == channel && key.canonical == canonical)
            {
                existing.aliases.extend(aliases);
                existing.aliases.sort();
                existing.aliases.dedup();
            } else {
                aliases.sort();
                aliases.dedup();
                result.push(IdentityKeys {
                    channel,
                    canonical,
                    aliases,
                });
            }
        }
        (result, invalid)
    }
    pub fn note(&self) -> Option<String> {
        let mut block = Vec::new();
        for (key, value) in [
            ("city", self.city.clone()),
            ("region", self.region.clone()),
            ("address", self.address.clone()),
            ("businessType", Some(self.business_type.clone())),
            ("tableCount", self.table_count.map(|v| v.to_string())),
            ("branchCount", self.branch_count.map(|v| v.to_string())),
            ("currentSystem", self.current_system.clone()),
            ("priority", Some(self.priority.clone())),
        ] {
            if let Some(value) = value.filter(|v| !v.trim().is_empty()) {
                block.push(format!("{key}: {value}"));
            }
        }
        block.extend(self.custom_lines());
        let tags = self.tag_labels();
        if !tags.is_empty() {
            block.push(format!("tags: {}", tags.join(", ")));
        }
        if let Some(a) = &self.attribution {
            for (key, value) in [
                ("utm_source", &a.utm_source),
                ("utm_medium", &a.utm_medium),
                ("utm_campaign", &a.utm_campaign),
                ("utm_content", &a.utm_content),
                ("utm_term", &a.utm_term),
                ("landing_path", &a.landing_path),
                ("referrer_host", &a.referrer_host),
            ] {
                if let Some(value) = value.as_deref().filter(|v| !v.trim().is_empty()) {
                    block.push(format!("{key}: {value}"));
                }
            }
        }
        if let Some(score) = self.ai_score {
            block.push(format!("aiScore: {score}"));
        }
        let mut note = self.notes.clone().unwrap_or_default();
        if !block.is_empty() {
            if !note.trim().is_empty() {
                note.push_str("\n\n");
            }
            note.push_str("v1 bilgileri\n");
            note.push_str(&block.join("\n"));
        }
        (!note.trim().is_empty()).then_some(note)
    }
    /// The custom fields as `key: value` lines, empty values left out.
    fn custom_lines(&self) -> Vec<String> {
        let Some(fields) = self.custom_fields.as_object() else {
            return Vec::new();
        };
        fields
            .iter()
            .filter(|(_, value)| !value.is_null() && *value != "")
            .map(|(key, value)| {
                format!(
                    "{key}: {}",
                    value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string())
                )
            })
            .collect()
    }
    /// The tags, trimmed, without empties or repeats, in export order.
    fn tag_labels(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for tag in &self.tags {
            let tag = tag.trim();
            if !tag.is_empty() && !out.iter().any(|t| t == tag) {
                out.push(tag.to_owned());
            }
        }
        out
    }
    pub fn withdrawals(&self) -> Vec<Channel> {
        [
            (self.email_opt_out, Channel::Email),
            (self.sms_opt_out, Channel::Sms),
            (self.wa_opt_out, Channel::WhatsApp),
        ]
        .into_iter()
        .filter_map(|(yes, c)| yes.then_some(c))
        .collect()
    }
}

/// Where `l` goes (spec §10's table, in order). A format-1 lead, or a format-2 one without
/// contact counts, cannot show it was never contacted: the inbox, as before.
pub fn route(l: &Lead) -> Route {
    if l.deleted_at.is_some() {
        return Route::SkipDeleted;
    }
    if l.merged_into_id.is_some() {
        return Route::SkipMerged;
    }
    if l.format.is_none()
        || l.status != "NEW"
        || l.contact.as_ref().is_none_or(Contact::any)
        || INBOUND_SOURCES.contains(&l.source.as_str())
    {
        return Route::Inbox;
    }
    Route::Pool
}

/// The lead's v1 owner among the active members (`members`: normalised email → user).
pub fn owner_of(l: &Lead, members: &HashMap<String, UserId>) -> Owner {
    let Some(raw) = l.owner_email.as_deref().filter(|e| !e.trim().is_empty()) else {
        return Owner::None;
    };
    match Email::parse(raw)
        .ok()
        .and_then(|e| members.get(e.as_str()).copied())
    {
        Some(user) => Owner::Mapped(user),
        None => Owner::Unmapped,
    }
}

/// A v1 phone as the pool keys it; a ten-digit national number without its `0` gets it back
/// first, as on the inbox path.
fn pool_phone(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let digits: String = raw.chars().filter(char::is_ascii_digit).collect();
    let local = if !raw.starts_with('+') && digits.len() == 10 {
        format!("0{digits}")
    } else {
        raw.to_owned()
    };
    normalise_phone(&local).ok()
}

/// A v1 email as the pool keys it: normalised, at most 254 characters.
fn pool_email(raw: &str) -> Option<String> {
    normalise(IdentityChannel::Email, raw.trim())
        .ok()
        .filter(|e| e.chars().count() <= 254)
}

/// `s` trimmed, `None` when empty or longer than `max` characters.
fn within(s: Option<&str>, max: usize) -> Option<String> {
    s.map(str::trim)
        .filter(|s| !s.is_empty() && s.chars().count() <= max)
        .map(str::to_owned)
}

/// `s` trimmed and cut to `max` characters; `None` when empty.
fn cut(s: &str, max: usize) -> Option<String> {
    let s = s.trim();
    (!s.is_empty()).then(|| s.chars().take(max).collect::<String>().trim().to_owned())
}

/// The longest value of a `prospect_keys` row.
const MAX_KEY_CHARS: usize = 400;

/// The prospect pool lead `l` becomes in `ws`, recorded by the importer at `now` (spec §10's
/// pool route); `None` when the pool cannot hold it (a business name outside `1..=200`
/// characters, or a key over 400). Values the pool's rules refuse (a malformed phone, a
/// platform website) are left out; free texts are cut to the pool's bounds.
pub fn pool_record(ws: WorkspaceId, l: &Lead, now: OffsetDateTime) -> Option<PoolRecord> {
    let business_name = within(Some(&l.business_name), 200)?;
    let recorder = Recorder::Import {
        system: "v1".into(),
        record: l.id.clone(),
    };
    let source = SourceRef::Import {
        system: "v1".into(),
        record: l.id.clone(),
    };
    let captured = timestamp(&l.updated_at)
        .ok()
        .filter(|t| *t <= now)
        .unwrap_or(now);
    let field = |value: String| FieldInput {
        value,
        sources: Vec::new(),
        captured_at: captured,
    };
    let research = l.research.clone().unwrap_or_default();
    let phone = [&l.phone, &l.whatsapp]
        .into_iter()
        .flatten()
        .find_map(|p| pool_phone(p));
    let website = research
        .website
        .as_deref()
        .map(str::trim)
        .filter(|w| w.chars().count() <= 2_048)
        .filter(|w| matches!(classify_website(w), Ok(WebsiteHost::Domain(_))))
        .map(str::to_owned);
    let instagram = research
        .instagram
        .as_deref()
        .and_then(|i| normalise_handle(KeyKind::Instagram, i).ok());
    let size_note = l
        .table_count
        .filter(|t| *t > 0)
        .map(|t| format!("v1 masa sayısı: {t}"));
    let branches = l.branch_count.and_then(|b| u16::try_from(b).ok());
    let size = (branches.is_some() || size_note.is_some()).then(|| FieldInput {
        value: SizeHint {
            branches,
            employees: None,
            note: size_note,
        },
        sources: Vec::new(),
        captured_at: captured,
    });
    let input = CreateInput {
        business_name,
        entity_kind: jt_prospects::EntityKind::UnknownBusiness,
        sector: within(Some(&l.business_type.to_lowercase()), 80),
        city: within(l.city.as_deref(), 80),
        district: within(l.region.as_deref(), 80),
        language: None,
        segment_key: None,
        country: None,
        labels: l
            .tag_labels()
            .into_iter()
            .filter(|t| t.chars().count() <= 40)
            .take(20)
            .collect(),
        phone: phone.map(field),
        email: l.email.as_deref().and_then(pool_email).map(field),
        website: website.clone().map(field),
        instagram: instagram.map(field),
        tiktok: None,
        address: within(l.address.as_deref(), 300).map(field),
        contact_person: within(Some(&l.contact_person), 120).map(|name| FieldInput {
            value: ContactPerson {
                name,
                role: String::new(),
            },
            sources: Vec::new(),
            captured_at: captured,
        }),
        size,
        signals: Vec::new(),
        notes: String::new(),
        research_task_id: None,
        discovered_at: Vec::new(),
        distinct_from: Vec::new(),
        request_key: None,
    };
    let id = ProspectId::from(entity_id(ws, &l.id, "prospect"));
    let mut p = jt_prospects::build(input, id, ws, now, recorder.clone());
    // Every value's evidence is the v1 record, seen when v1 last changed it.
    let evidence = Evidence {
        sources: vec![source.clone()],
        captured_at: captured,
        recorder: recorder.clone(),
    };
    let c = &mut p.contact;
    for e in [
        c.phone.as_mut().map(|f| &mut f.evidence),
        c.email.as_mut().map(|f| &mut f.evidence),
        c.website.as_mut().map(|f| &mut f.evidence),
        c.instagram.as_mut().map(|f| &mut f.evidence),
        c.address.as_mut().map(|f| &mut f.evidence),
        c.contact_person.as_mut().map(|f| &mut f.evidence),
        p.size.as_mut().map(|f| &mut f.evidence),
    ]
    .into_iter()
    .flatten()
    {
        *e = evidence.clone();
    }
    if let Some(f) = p.contact.email.as_mut() {
        f.deliverable = l.email_bounced_at.is_none();
    }
    if let Some(f) = p.contact.phone.as_mut() {
        f.deliverable = phone_is_dialable(&f.value);
    }
    if let Some(w) = website {
        p.origin.discovered_at = vec![SourceRef::Url { url: w, note: None }];
    }
    p.signals = [
        l.current_system
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .and_then(|s| cut(&format!("Mevcut sistem: {s}"), 200)),
        research.pain_point.as_deref().and_then(|s| cut(s, 200)),
        research.evidence.as_deref().and_then(|s| cut(s, 200)),
    ]
    .into_iter()
    .flatten()
    .map(|text| Signal {
        text,
        source: source.clone(),
    })
    .collect();
    let mut notes: Vec<String> = Vec::new();
    if let Some(n) = l.notes.as_deref().filter(|n| !n.trim().is_empty()) {
        notes.push(n.trim().to_owned());
    }
    notes.extend(l.custom_lines());
    let whatsapp = l.whatsapp.as_deref().and_then(pool_phone);
    if whatsapp.is_some() && whatsapp != p.contact.phone.as_ref().map(|f| f.value.clone()) {
        notes.push(format!("v1 WhatsApp: {}", whatsapp.unwrap_or_default()));
    }
    if let Some(pitch) = research.pitch.as_deref().filter(|v| !v.trim().is_empty()) {
        notes.push(format!("v1 önerisi: {}", pitch.trim()));
    }
    if let Some(stage) = research.stage.as_deref().filter(|v| !v.trim().is_empty()) {
        notes.push(format!("v1 aşaması: {}", stage.trim()));
    }
    p.notes = cut(&notes.join("\n"), 2_000).unwrap_or_default();
    let keys = derive_keys(&p);
    if keys.iter().any(|k| k.value.chars().count() > MAX_KEY_CHARS) {
        return None;
    }
    let score = l
        .ai_score
        .and_then(|s| u8::try_from(s).ok())
        .filter(|s| *s <= 100)
        .map(|score| ScoreRow {
            id: entity_id(ws, &l.id, "score"),
            prospect_id: id,
            score,
            reasons: Vec::new(),
            rubric_digest: V1_SCORE_DIGEST.into(),
            strategy_version_id: None,
            recorder,
            at: l
                .scored_at
                .as_deref()
                .and_then(|t| timestamp(t).ok())
                .filter(|t| *t <= now)
                .unwrap_or(captured),
        });
    Some(PoolRecord {
        prospect: p,
        keys,
        score,
    })
}

/// Whether `p` is the prospect the importer made of lead `lead`.
fn imported_from(p: &Prospect, lead: &str) -> bool {
    matches!(&p.origin.recorder, Recorder::Import { system, record } if system == "v1" && record == lead)
}

/// The active members by normalised email.
async fn active_members(r: &mut dyn TenantRepos) -> Result<HashMap<String, UserId>, AppError> {
    Ok(r.memberships()
        .list()
        .await?
        .into_iter()
        .filter(|m| m.status == MembershipStatus::Active)
        .filter_map(|m| m.user_id.map(|u| (m.email.as_str().to_owned(), u)))
        .collect())
}

fn marker_candidates(
    ws: WorkspaceId,
    lead: &str,
    markers: &HashMap<String, PersonId>,
) -> Vec<PersonId> {
    let mut ids = vec![entity_id(ws, lead, "person").into()];
    if let Some(person) = markers.get(lead) {
        ids.push(*person);
    }
    ids.sort();
    ids.dedup();
    ids
}

/// Successful dry-run writes survive rollback only as duplicate-accounting and parent context.
/// Restore only a selected person/open journey, never replay earlier leads or their children.
#[derive(Default)]
struct Preview {
    leads: HashSet<String>,
    people: HashMap<PersonId, Person>,
    open_journeys: HashMap<PersonId, InitialJourney>,
    identities: HashMap<(IdentityChannel, String), PersonId>,
    /// The hard keys of the prospects earlier chunks wrote.
    pool_keys: HashSet<Key>,
}

#[allow(clippy::too_many_arguments)]
async fn intake(
    r: &mut dyn ImportRepos,
    ws: WorkspaceId,
    lead: &Lead,
    now: OffsetDateTime,
    report: &mut Report,
    markers: &mut HashMap<String, PersonId>,
    members: &HashMap<String, UserId>,
    mut preview: Option<&mut Preview>,
) -> Result<(), AppError> {
    if preview.as_ref().is_some_and(|p| p.leads.contains(&lead.id)) {
        report.already_present += 1;
        return Ok(());
    }
    if r.imported_lead(&lead.id, &marker_candidates(ws, &lead.id, markers))
        .await?
        .is_some()
    {
        report.already_present += 1;
        return Ok(());
    }
    let (keys, invalid) = lead.identity_keys();
    report.identities_invalid += invalid;
    for key in &keys {
        for alias in &key.aliases {
            if let Err(error) = super::inbox::erasure::check_identity(r, key.channel, alias).await {
                if error.details["reason"] == "erased_identity" {
                    report.erased_skipped += 1;
                    return Ok(());
                }
                return Err(error);
            }
        }
    }
    let mut owners = Vec::new();
    let mut person = None;
    for key in &keys {
        let mut matches = BTreeSet::new();
        for alias in &key.aliases {
            if let Some(id) = r.identity_owner(key.channel, alias).await? {
                matches.insert(id);
            }
            if let Some(id) = preview
                .as_ref()
                .and_then(|p| p.identities.get(&(key.channel, alias.clone())))
            {
                matches.insert(*id);
            }
        }
        // Multiple alias owners are ambiguous: never attach to or steal either identity.
        if matches.len() == 1 && person.is_none() {
            let id = *matches.first().expect("one owner");
            if preview.as_ref().is_some_and(|p| p.people.contains_key(&id))
                || r.untouched(id).await?
            {
                person = Some(id);
            }
        }
        owners.push(matches);
    }
    let created = timestamp(&lead.created_at)?;
    let updated = timestamp(&lead.updated_at)?;
    let person_id = person.unwrap_or_else(|| entity_id(ws, &lead.id, "person").into());
    // A deterministic collision must never overwrite a non-imported or edited person.
    if person.is_none() && r.people().get(person_id).await?.is_some() {
        return Err(AppError::conflict("v1 import person_conflict"));
    }
    if person.is_some() {
        report.duplicates_merged += 1;
    }
    report.identities_conflicting += owners
        .iter()
        .filter(|owners| !owners.is_empty() && (owners.len() != 1 || !owners.contains(&person_id)))
        .count() as u64;
    if person.is_none() {
        let row = Person {
            id: person_id,
            workspace_id: ws,
            display_name: lead.contact_person.clone(),
            company: lead.business_name.clone(),
            recipient_kind: jt_inbox::RecipientKind::Unknown,
            first_touch: FirstTouch {
                source: Source::Import,
                capability_id: None,
                at: created,
            },
            merged_into: None,
            erased_at: None,
            created_at: created,
            updated_at: updated,
        };
        r.people().insert(row.clone()).await?;
        if let Some(preview) = preview.as_mut() {
            preview.people.insert(person_id, row);
        }
    } else if let Some(row) = preview.as_ref().and_then(|p| p.people.get(&person_id))
        && r.people().get(person_id).await?.is_none()
    {
        // Its earlier chunk was rolled back. Recreate the exact parent via the tenant repo
        // so this chunk exercises the same foreign keys and write policies as import.
        r.people().insert(row.clone()).await?;
    }
    for (index, (key, owners)) in keys.into_iter().zip(owners).enumerate() {
        if !owners.is_empty() {
            continue;
        }
        r.identities()
            .insert(Identity {
                id: entity_id(ws, &lead.id, &format!("identity:{index}")).into(),
                workspace_id: ws,
                person_id,
                channel: key.channel,
                value_display: key.canonical.clone(),
                value_normalized: key.canonical.clone(),
                active: true,
                first_seen_at: created,
            })
            .await?;
        if let Some(preview) = preview.as_mut() {
            preview
                .identities
                .insert((key.channel, key.canonical), person_id);
        }
    }
    let status = map_status(&lead.status)?;
    // The first open opportunity wins for duplicate input. Terminal rows remain closed histories.
    let open = if matches!(status, JourneyStatus::Won | JourneyStatus::Lost) {
        None
    } else {
        let open = r.journeys().open_for(person_id).await?;
        if open.is_none()
            && let Some(initial) = preview
                .as_ref()
                .and_then(|p| p.open_journeys.get(&person_id))
        {
            r.journeys().insert_initial(initial.clone()).await?;
            Some(initial.journey().clone())
        } else {
            open
        }
    };
    let (journey, created_journey) = if let Some(journey) = open {
        (journey, false)
    } else {
        let initial = import_journey(ImportedJourney {
            id: entity_id(ws, &lead.id, "journey").into(),
            workspace_id: ws,
            person_id,
            lead_id: lead.id.clone(),
            source: lead.source.clone(),
            status: lead.status.clone(),
            lost_reason: lead.lost_reason.clone().unwrap_or_default(),
            created_at: created,
            updated_at: updated,
        })
        .ok_or_else(invalid_input)?;
        let journey = initial.journey().clone();
        r.journeys().insert_initial(initial.clone()).await?;
        if journey.closed_at.is_none()
            && let Some(preview) = preview.as_mut()
        {
            preview.open_journeys.insert(person_id, initial);
        }
        (journey, true)
    };
    if let Some(text) = lead.note() {
        r.notes()
            .insert(Note {
                id: entity_id(ws, &lead.id, "note").into(),
                workspace_id: ws,
                journey_id: journey.id,
                author: EventSource::System,
                text,
                at: created,
            })
            .await?;
    }
    for activity in lead.activity_notes()? {
        r.notes()
            .insert(Note {
                id: entity_id(ws, &lead.id, &format!("activity:{}", activity.activity_id)).into(),
                workspace_id: ws,
                journey_id: journey.id,
                author: EventSource::System,
                text: activity.text,
                at: activity.at,
            })
            .await?;
        report.activities_as_notes += 1;
    }
    if let Some(text) = lead.offers_note() {
        r.notes()
            .insert(Note {
                id: entity_id(ws, &lead.id, "offers").into(),
                workspace_id: ws,
                journey_id: journey.id,
                author: EventSource::System,
                text,
                at: updated,
            })
            .await?;
        report.offers_as_notes += 1;
    }
    // A journey this lead made gets its v1 owner with an `import` decision; a journey an
    // earlier duplicate made keeps the owner it has. An unmapped owner leaves it for
    // `distribution.backfill`.
    match owner_of(lead, members) {
        Owner::Mapped(user) if created_journey => {
            r.journeys().assign_owner(journey.id, Some(user)).await?;
            r.assignments()
                .insert(&crate::ports::distribution::AssignmentRow {
                    id: entity_id(ws, &lead.id, "assignment").into(),
                    journey_id: journey.id,
                    user_id: Some(user),
                    cause: Cause::Import,
                    rule_id: None,
                    assigned_at: now,
                    sla_due_at: None,
                    acted_at: None,
                    superseded_at: None,
                    by: Actor::System {
                        component: "v1_import".into(),
                    },
                })
                .await?;
            report.owners_mapped += 1;
        }
        Owner::Unmapped => report.owners_unmapped += 1,
        Owner::Mapped(_) | Owner::None => {}
    }
    if journey.closed_at.is_none()
        && let Some(due) = &lead.next_follow_up
    {
        let due_at = timestamp(due)?;
        if due_at > now {
            r.tasks()
                .insert(Task {
                    id: entity_id(ws, &lead.id, "task").into(),
                    workspace_id: ws,
                    journey_id: journey.id,
                    title: "v1 takip".into(),
                    due_at,
                    assignee: None,
                    status: TaskStatus::Open,
                })
                .await?;
            report.tasks += 1;
        }
    }
    for channel in lead.withdrawals() {
        r.consents()
            .insert(Consent {
                id: entity_id(ws, &lead.id, &format!("withdrawal:{channel:?}")).into(),
                person_id,
                channel,
                kind: ConsentKind::Withdrawn,
                source: ConsentSource::Import,
                at: updated,
                sync_state: SyncState::Pending,
                attempts: 0,
            })
            .await?;
        r.suppressions()
            .insert(Suppression {
                person_id,
                channel,
                reason: SuppressionReason::Manual,
            })
            .await?;
        report.opt_outs += 1;
    }
    if lead.email_bounced_at.is_some() {
        r.suppressions()
            .insert(Suppression {
                person_id,
                channel: Channel::Email,
                reason: SuppressionReason::Bounce,
            })
            .await?;
    }
    r.checkpoint(person_id, &lead.id, json!({"kind":"import","system":"v1", "v1_lead_id":lead.id, "v1_source":lead.source, "v1_status":lead.status})).await?;
    markers.insert(lead.id.clone(), person_id);
    if let Some(preview) = preview {
        preview.leads.insert(lead.id.clone());
    }
    report.imported += 1;
    Ok(())
}
fn invalid_input() -> AppError {
    invalid()
}

/// The pool route of `lead` (spec §10): in the pool's dedupe order, an erased phone or email
/// imports nothing (`erased_skipped`); a v1 opt-out lists the lead's keys as do-not-contact and
/// imports nothing else (`pool_dnc`: the objection is all the pool keeps); a hard key on the
/// blocklist (`pool_blocked`), an inbox identity (`pool_in_inbox`) or another prospect's hard
/// key (`pool_duplicates`) imports nothing; otherwise one prospect with v1's score.
async fn pool_intake(
    r: &mut dyn ImportRepos,
    seal: &dyn SecretBox,
    ws: WorkspaceId,
    lead: &Lead,
    now: OffsetDateTime,
    report: &mut Report,
    mut preview: Option<&mut Preview>,
) -> Result<(), AppError> {
    if preview.as_ref().is_some_and(|p| p.leads.contains(&lead.id)) {
        report.already_present += 1;
        return Ok(());
    }
    let id = ProspectId::from(entity_id(ws, &lead.id, "prospect"));
    if let Some(p) = r.prospects().get(id).await? {
        if imported_from(&p, &lead.id) {
            report.already_present += 1;
            return Ok(());
        }
        return Err(AppError::conflict("v1 import prospect_conflict"));
    }
    let (identities, invalid) = lead.identity_keys();
    report.identities_invalid += invalid;
    for key in &identities {
        for alias in &key.aliases {
            if let Err(error) = super::inbox::erasure::check_identity(r, key.channel, alias).await {
                if error.details["reason"] == "erased_identity" {
                    report.erased_skipped += 1;
                    return Ok(());
                }
                return Err(error);
            }
        }
    }
    let dnc = lead.dnc_keys();
    if !dnc.is_empty() {
        let fingerprint = blocklist_fingerprint_in(seal, ws)?;
        for key in &dnc {
            let hash = blocklist_hash_in(seal, ws, key)?;
            r.prospect_blocklist()
                .insert(
                    key.kind,
                    &hash,
                    BlockReason::DoNotContact,
                    now,
                    None,
                    &fingerprint,
                )
                .await?;
        }
        report.pool_dnc += 1;
        if let Some(preview) = preview {
            preview.leads.insert(lead.id.clone());
        }
        return Ok(());
    }
    let Some(record) = pool_record(ws, lead, now) else {
        report.pool_invalid += 1;
        return Ok(());
    };
    let hard: Vec<Key> = record
        .keys
        .iter()
        .filter(|k| k.kind.hard())
        .cloned()
        .collect();
    for key in &hard {
        let hash = blocklist_hash_in(seal, ws, key)?;
        if r.prospect_blocklist()
            .contains(key.kind, &hash, now)
            .await?
            .is_some()
        {
            report.pool_blocked += 1;
            return Ok(());
        }
    }
    // The inbox, by every spelling the inbox path matches and by the pool's own keys.
    let mut spellings: Vec<(IdentityChannel, String)> = identities
        .iter()
        .flat_map(|k| k.aliases.iter().map(|a| (k.channel, a.clone())))
        .collect();
    for key in &hard {
        match key.kind {
            KeyKind::Phone if phone_is_dialable(&key.value) => {
                spellings.push((IdentityChannel::Phone, key.value.clone()));
            }
            KeyKind::Email => spellings.push((IdentityChannel::Email, key.value.clone())),
            _ => {}
        }
    }
    for (channel, value) in &spellings {
        if preview
            .as_ref()
            .is_some_and(|p| p.identities.contains_key(&(*channel, value.clone())))
            || r.identity_owner(*channel, value).await?.is_some()
        {
            report.pool_in_inbox += 1;
            return Ok(());
        }
    }
    if preview
        .as_ref()
        .is_some_and(|p| hard.iter().any(|k| p.pool_keys.contains(k)))
        || (!hard.is_empty() && !r.prospects().find_by_keys(&hard).await?.is_empty())
    {
        report.pool_duplicates += 1;
        return Ok(());
    }
    if let Inserted::DuplicateKey { .. } =
        r.prospects().insert(&record.prospect, &record.keys).await?
    {
        report.pool_duplicates += 1;
        return Ok(());
    }
    if let Some(score) = &record.score {
        r.prospects().record_score(score).await?;
    }
    if let Some(preview) = preview.as_mut() {
        preview.pool_keys.extend(hard);
        preview.leads.insert(lead.id.clone());
    }
    report.pooled += 1;
    Ok(())
}

/// Whether the imported prospect `p` is as the import left it: `new`, revision 1, undecided and
/// unpromoted, with no score but v1's.
async fn untouched_prospect(r: &mut dyn ImportRepos, p: &Prospect) -> Result<bool, AppError> {
    if p.status != ProspectStatus::New
        || p.revision != 1
        || p.decision.is_some()
        || p.promoted.is_some()
        || p.latest_score
            .as_ref()
            .is_some_and(|s| s.digest != V1_SCORE_DIGEST)
    {
        return Ok(false);
    }
    let scores = r.prospects().scores(p.id, 2).await?;
    Ok(scores.len() <= 1 && scores.iter().all(|s| s.rubric_digest == V1_SCORE_DIGEST))
}

/// Rolls back the prospect the importer made of `lead`, if there is one: deleted (with its keys
/// and score) when untouched, kept otherwise. Objections v1 recorded stay on the blocklist.
async fn rollback_prospect(
    r: &mut dyn ImportRepos,
    ws: WorkspaceId,
    lead: &Lead,
    report: &mut Report,
) -> Result<(), AppError> {
    let id = ProspectId::from(entity_id(ws, &lead.id, "prospect"));
    let Some(p) = r.prospects().lock(id).await? else {
        return Ok(());
    };
    if !imported_from(&p, &lead.id) {
        return Ok(());
    }
    if untouched_prospect(r, &p).await? {
        r.prospects().delete(id).await?;
        report.prospects_rolled_back += 1;
    } else {
        report.prospects_kept += 1;
    }
    Ok(())
}

/// Prevalidate before any commit. Every mode uses 100-row transactions; dry runs roll each
/// chunk back after executing real writes, retaining duplicate keys and parent context in memory.
/// Inbox leads go first, then pool leads, so a pool lead's in-inbox check sees the whole file's
/// inbox. `seal` hashes the blocklist's keys (the `prospects.blocklist` purpose).
pub async fn run(
    store: &dyn ImportStore,
    seal: &dyn SecretBox,
    ws: WorkspaceId,
    leads: &[Lead],
    mode: Mode,
    now: OffsetDateTime,
) -> Result<Report, AppError> {
    for lead in leads {
        lead.validate()?;
    }
    let guard = store.lock_run(ws).await?;
    let mut report = Report {
        total: leads.len() as u64,
        ..Report::default()
    };
    let mut work: Vec<(&Lead, Route)> = Vec::with_capacity(leads.len());
    let mut pool: Vec<(&Lead, Route)> = Vec::new();
    for lead in leads {
        let to = route(lead);
        match to {
            Route::SkipDeleted => report.skipped_deleted += 1,
            Route::SkipMerged => report.skipped_merged += 1,
            Route::Inbox => report.to_inbox += 1,
            Route::Pool => report.to_pool += 1,
        }
        match (mode, to) {
            // A rollback looks for both imports of every lead, whatever its route now.
            (Mode::Rollback, _) | (_, Route::Inbox) => work.push((lead, to)),
            (_, Route::Pool) => pool.push((lead, to)),
            (_, Route::SkipDeleted | Route::SkipMerged) => {}
        }
    }
    work.extend(pool);
    let mut preview = (mode == Mode::DryRun).then(Preview::default);
    let mut visited = BTreeSet::new();
    let mut markers = HashMap::new();
    let mut members = HashMap::new();
    for (index, chunk) in work.chunks(100).enumerate() {
        let mut r = store.begin(ws).await?;
        r.workspace().get().await?;
        // The inbox lock, then the pool lock (the pool's lock order).
        r.people().lock_workspace().await?;
        r.prospects().lock_pool().await?;
        r.people().set_write_time(now).await?;
        if index == 0 {
            markers = r.imported_leads().await?;
            members = active_members(&mut *r).await?;
        }
        for &(lead, to) in chunk {
            match (mode, to) {
                (Mode::Rollback, _) => {
                    if let Some(person) = r
                        .imported_lead(&lead.id, &marker_candidates(ws, &lead.id, &markers))
                        .await?
                        && visited.insert(person)
                    {
                        if r.rollback_import(person).await? {
                            report.rolled_back += 1;
                        } else {
                            report.kept += 1;
                        }
                    }
                    rollback_prospect(&mut *r, ws, lead, &mut report).await?;
                }
                (_, Route::Pool) => {
                    pool_intake(&mut *r, seal, ws, lead, now, &mut report, preview.as_mut())
                        .await?;
                }
                _ => {
                    intake(
                        &mut *r,
                        ws,
                        lead,
                        now,
                        &mut report,
                        &mut markers,
                        &members,
                        preview.as_mut(),
                    )
                    .await?;
                }
            }
        }
        if mode == Mode::DryRun {
            r.rollback().await?;
        } else {
            r.commit().await?;
        }
    }
    // Rehearse the ledger write as well; a dry run must leave no durable entries.
    {
        let mut r = store.begin(ws).await?;
        r.ledger()
            .append(LedgerEntry::new(
                ws,
                Actor::System {
                    component: "v1_import".into(),
                },
                Action::new("import.v1_leads").map_err(|_| invalid())?,
                serde_json::to_value(report).map_err(|_| invalid())?,
                now,
            ))
            .await?;
        if mode == Mode::DryRun {
            r.rollback().await?;
        } else {
            r.commit().await?;
        }
    }
    guard.release().await?;
    Ok(report)
}
