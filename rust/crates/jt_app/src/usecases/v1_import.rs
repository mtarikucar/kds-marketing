//! Operator-only, reversible v1 lead intake. No providers, jobs or public catalog surface.
use crate::{
    error::AppError,
    ports::v1_import::{ImportRepos, ImportStore},
};
use jt_inbox::*;
use jt_ledger::{Action, Actor, LedgerEntry};
use jt_tenancy::WorkspaceId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeSet, HashMap, HashSet};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

/// Strict export allowlist. Intentionally no Debug implementation for personal data.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Lead {
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
}

/// Counts are the entire stdout/log/ledger contract; no field values or identifiers.
#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct Report {
    pub total: u64,
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
        for value in [&self.next_follow_up, &self.email_bounced_at]
            .into_iter()
            .flatten()
        {
            timestamp(value)?;
        }
        Ok(())
    }
    /// Canonical values for new imports; matching also checks shared-intake aliases.
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
            let mut aliases = vec![canonical.clone()];
            if let Ok(shared) = normalise(channel, raw) {
                aliases.push(shared);
            }
            // Existing intake omits TR for ten-digit national numbers. Check that historical
            // key even when the export spells the same number with 0 or +90, but never store it.
            if channel == IdentityChannel::Phone
                && canonical.len() == 13
                && canonical.starts_with("+90")
                && let Ok(national) = normalise(channel, &canonical[3..])
            {
                aliases.push(national);
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
        if let Some(fields) = self.custom_fields.as_object() {
            for (key, value) in fields {
                if !value.is_null() && value != "" {
                    block.push(format!(
                        "{key}: {}",
                        value
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| value.to_string())
                    ));
                }
            }
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

/// Projected writes survive rolled-back dry-run chunks only in memory.
#[derive(Default)]
struct Preview {
    leads: HashSet<String>,
    new_people: HashSet<PersonId>,
    identities: HashMap<(IdentityChannel, String), PersonId>,
}

async fn intake(
    r: &mut dyn ImportRepos,
    ws: WorkspaceId,
    lead: &Lead,
    now: OffsetDateTime,
    report: &mut Report,
    markers: &mut HashMap<String, PersonId>,
    preview: Option<&mut Preview>,
) -> Result<(), AppError> {
    report.total += 1;
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
            if preview.as_ref().is_some_and(|p| p.new_people.contains(&id))
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
    if let Some(preview) = preview {
        if person.is_none() {
            preview.new_people.insert(person_id);
        }
        for (key, owners) in keys.into_iter().zip(owners) {
            if owners.is_empty() {
                preview
                    .identities
                    .insert((key.channel, key.canonical), person_id);
            }
        }
        preview.leads.insert(lead.id.clone());
        let status = map_status(&lead.status)?;
        if !matches!(status, JourneyStatus::Won | JourneyStatus::Lost)
            && let Some(due) = &lead.next_follow_up
            && timestamp(due)? > now
        {
            report.tasks += 1;
        }
        report.opt_outs += lead.withdrawals().len() as u64;
        report.imported += 1;
        return Ok(());
    }
    if person.is_none() {
        r.people()
            .insert(Person {
                id: person_id,
                workspace_id: ws,
                display_name: lead.contact_person.clone(),
                company: lead.business_name.clone(),
                first_touch: FirstTouch {
                    source: Source::Import,
                    capability_id: None,
                    at: created,
                },
                merged_into: None,
                erased_at: None,
                created_at: created,
                updated_at: updated,
            })
            .await?;
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
                value_normalized: key.canonical,
                active: true,
                first_seen_at: created,
            })
            .await?;
    }
    let status = map_status(&lead.status)?;
    // The first open opportunity wins for duplicate input. Terminal rows remain closed histories.
    let open = if matches!(status, JourneyStatus::Won | JourneyStatus::Lost) {
        None
    } else {
        r.journeys().open_for(person_id).await?
    };
    let journey = if let Some(journey) = open {
        journey
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
        r.journeys().insert_initial(initial).await?;
        journey
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
    report.imported += 1;
    Ok(())
}
fn invalid_input() -> AppError {
    invalid()
}

/// Prevalidate before any commit. Every mode uses 100-row transactions; dry runs roll each
/// chunk back and retain projected identities and lead IDs in memory for duplicate accounting.
pub async fn run(
    store: &dyn ImportStore,
    ws: WorkspaceId,
    leads: &[Lead],
    mode: Mode,
    now: OffsetDateTime,
) -> Result<Report, AppError> {
    for lead in leads {
        lead.validate()?;
    }
    let guard = store.lock_run(ws).await?;
    let mut report = Report::default();
    let mut preview = (mode == Mode::DryRun).then(Preview::default);
    let mut visited = BTreeSet::new();
    let mut markers = HashMap::new();
    for (index, chunk) in leads.chunks(100).enumerate() {
        let mut r = store.begin(ws).await?;
        r.workspace().get().await?;
        r.people().lock_workspace().await?;
        r.people().set_write_time(now).await?;
        if index == 0 {
            markers = r.imported_leads().await?;
        }
        for lead in chunk {
            if mode == Mode::Rollback {
                report.total += 1;
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
            } else {
                intake(
                    &mut *r,
                    ws,
                    lead,
                    now,
                    &mut report,
                    &mut markers,
                    preview.as_mut(),
                )
                .await?;
            }
        }
        if mode == Mode::DryRun {
            r.rollback().await?;
        } else {
            r.commit().await?;
        }
    }
    // A dry run must leave absolutely no durable writes, including ledger entries.
    if mode != Mode::DryRun {
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
        r.commit().await?;
    }
    guard.release().await?;
    Ok(report)
}
