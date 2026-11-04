//! Tenant-scoped compliance persistence, buffered in the same transaction as inbox writes.
use async_trait::async_trait;
use jt_app::{error::AppError, ports::compliance::*, ports::connectors::MailboxCursor};
use jt_capability::CapabilityId;
use jt_inbox::*;
use jt_tenancy::UserId;
use time::OffsetDateTime;
use uuid::Uuid;

use super::capability::ensure_capability;
use super::inbox::{journey, person, touch_person};
use super::state::{MemBundle, exists, same_workspace, unique};
use super::tenant::MemTenant;

#[async_trait]
impl ConsentRepo for MemTenant {
    async fn insert(&mut self, row: Consent) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            person(t.state(), ws, row.person_id)?;
            unique(
                !t.state().inbox.consents.iter().any(|(_, r)| r.id == row.id),
                "consent id is taken",
            )?;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                s.inbox.consents.push((ws, row.clone()));
                touch_person(s, ws, row.person_id, at);
            });
            Ok(())
        })
    }
    async fn list(&mut self, person: PersonId) -> Result<Vec<Consent>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .consents
            .iter()
            .filter(|(ws, r)| *ws == self.ws && r.person_id == person)
            .map(|(_, r)| r.clone())
            .collect();
        rows.sort_by_key(|r| (r.at, r.id));
        Ok(rows)
    }
    async fn pending_sync(&mut self, limit: u32) -> Result<Vec<Consent>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .consents
            .iter()
            .filter(|(ws, r)| {
                *ws == self.ws
                    && matches!(r.sync_state, SyncState::Pending | SyncState::Failed)
                    && matches!(r.channel, Channel::Sms | Channel::Phone | Channel::Email)
                    && self.state().inbox.people.iter().any(|p| {
                        p.workspace_id == self.ws && p.id == r.person_id && p.erased_at.is_none()
                    })
            })
            .map(|(_, r)| r.clone())
            .collect();
        rows.sort_by_key(|r| (r.at, r.id));
        rows.truncate(limit.clamp(1, 1000) as usize);
        Ok(rows)
    }
    async fn set_sync(
        &mut self,
        id: ConsentId,
        state: SyncState,
        attempts: u32,
    ) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            if !t
                .state()
                .inbox
                .consents
                .iter()
                .any(|(w, r)| *w == ws && r.id == id)
            {
                return Err(AppError::not_found("no such consent"));
            }
            t.tx.write(move |s| {
                if let Some((_, r)) = s
                    .inbox
                    .consents
                    .iter_mut()
                    .find(|(w, r)| *w == ws && r.id == id)
                {
                    r.sync_state = state;
                    r.attempts = attempts;
                }
            });
            Ok(())
        })
    }
}

fn channel_key(channel: Channel) -> &'static str {
    match channel {
        Channel::WhatsApp => "whats_app",
        Channel::InstagramDm => "instagram_dm",
        Channel::Messenger => "messenger",
        Channel::Sms => "sms",
        Channel::Email => "email",
        Channel::Webchat => "webchat",
        Channel::Phone => "phone",
        Channel::InstagramComment => "instagram_comment",
        Channel::FacebookComment => "facebook_comment",
        Channel::TrendyolQuestion => "trendyol_question",
        Channel::HepsiburadaQuestion => "hepsiburada_question",
    }
}
fn reason_key(reason: SuppressionReason) -> &'static str {
    match reason {
        SuppressionReason::Unsubscribe => "unsubscribe",
        SuppressionReason::Bounce => "bounce",
        SuppressionReason::Complaint => "complaint",
        SuppressionReason::Manual => "manual",
    }
}
#[async_trait]
impl SuppressionRepo for MemTenant {
    async fn insert(&mut self, row: Suppression) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            person(t.state(), ws, row.person_id)?;
            if !t
                .state()
                .inbox
                .suppressions
                .iter()
                .any(|(w, r)| *w == ws && *r == row)
            {
                let at = t.inbox_write_at();
                t.tx.write(move |s| {
                    s.inbox.suppressions.push((ws, row.clone()));
                    touch_person(s, ws, row.person_id, at);
                });
            }
            Ok(())
        })
    }
    async fn list(&mut self, person: PersonId) -> Result<Vec<Suppression>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .suppressions
            .iter()
            .filter(|(ws, r)| *ws == self.ws && r.person_id == person)
            .map(|(_, r)| r.clone())
            .collect();
        rows.sort_by_key(|r| (channel_key(r.channel), reason_key(r.reason)));
        Ok(rows)
    }
    async fn remove(
        &mut self,
        person: PersonId,
        channel: Channel,
        reason: SuppressionReason,
    ) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            let at = t.inbox_write_at();
            t.tx.write(move |s| {
                let before = s.inbox.suppressions.len();
                s.inbox.suppressions.retain(|(w, r)| {
                    !(*w == ws
                        && r.person_id == person
                        && r.channel == channel
                        && r.reason == reason)
                });
                if before != s.inbox.suppressions.len() {
                    let mut next = Some(person);
                    let mut seen = std::collections::BTreeSet::new();
                    while let Some(id) = next {
                        if !seen.insert(id) {
                            break;
                        }
                        next = s
                            .inbox
                            .people
                            .iter()
                            .find(|p| p.workspace_id == ws && p.id == id)
                            .and_then(|p| p.merged_into);
                        touch_person(s, ws, id, at);
                    }
                }
            });
            Ok(())
        })
    }
}

#[async_trait]
impl QuoteRepo for MemTenant {
    async fn insert(&mut self, row: QuoteRow) -> Result<(), AppError> {
        self.call(|t| {
            same_workspace(t.ws, row.workspace_id)?;
            journey(t.state(), t.ws, row.quote.journey_id)?;
            row.quote
                .validate()
                .map_err(|e| AppError::validation(e.to_string(), serde_json::json!({})))?;
            unique(
                !t.state().inbox.quotes.iter().any(|r| r.id == row.id),
                "quote id is taken",
            )?;
            t.tx.write(move |s| s.inbox.quotes.push(row.clone()));
            Ok(())
        })
    }
    async fn get(&mut self, id: Uuid) -> Result<Option<QuoteRow>, AppError> {
        Ok(self
            .state()
            .inbox
            .quotes
            .iter()
            .find(|r| r.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn list(&mut self, journey: JourneyId) -> Result<Vec<QuoteRow>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .quotes
            .iter()
            .filter(|r| r.workspace_id == self.ws && r.quote.journey_id == journey)
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.created_at, r.id));
        Ok(rows)
    }
    async fn set_state(&mut self, id: Uuid, state: QuoteState) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            if !t
                .state()
                .inbox
                .quotes
                .iter()
                .any(|r| r.workspace_id == ws && r.id == id)
            {
                return Err(AppError::not_found("no such quote"));
            }
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .quotes
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == id)
                {
                    r.quote.state = state;
                }
            });
            Ok(())
        })
    }
}

#[async_trait]
impl AppointmentRepo for MemTenant {
    async fn insert(&mut self, row: AppointmentRow) -> Result<(), AppError> {
        self.call(|t| {
            same_workspace(t.ws, row.workspace_id)?;
            journey(t.state(), t.ws, row.appointment.journey_id)?;
            row.appointment
                .validate()
                .map_err(|e| AppError::validation(e.to_string(), serde_json::json!({})))?;
            unique(
                !t.state().inbox.appointments.iter().any(|r| r.id == row.id),
                "appointment id is taken",
            )?;
            t.tx.write(move |s| s.inbox.appointments.push(row.clone()));
            Ok(())
        })
    }
    async fn get(&mut self, id: Uuid) -> Result<Option<AppointmentRow>, AppError> {
        Ok(self
            .state()
            .inbox
            .appointments
            .iter()
            .find(|r| r.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn list(&mut self, journey: JourneyId) -> Result<Vec<AppointmentRow>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .appointments
            .iter()
            .filter(|r| r.workspace_id == self.ws && r.appointment.journey_id == journey)
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.created_at, r.id));
        Ok(rows)
    }
    async fn set_state(&mut self, id: Uuid, state: AppointmentState) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            if !t
                .state()
                .inbox
                .appointments
                .iter()
                .any(|r| r.workspace_id == ws && r.id == id)
            {
                return Err(AppError::not_found("no such appointment"));
            }
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .appointments
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == id)
                {
                    r.appointment.state = state;
                }
            });
            Ok(())
        })
    }
}

#[async_trait]
impl CommissionRepo for MemTenant {
    async fn insert(&mut self, row: CommissionRow) -> Result<(), AppError> {
        self.call(|t| {
            same_workspace(t.ws, row.workspace_id)?;
            journey(t.state(), t.ws, row.commission.journey_id)?;
            if let Some(payee) = row.commission.payee {
                exists(t.state().user(payee).is_some(), "commissions.user_id")?;
            }
            unique(
                !t.state().inbox.commissions.iter().any(|r| {
                    r.id == row.id
                        || (r.workspace_id == row.workspace_id
                            && r.commission.journey_id == row.commission.journey_id)
                }),
                "commission id or journey is taken",
            )?;
            t.tx.write(move |s| s.inbox.commissions.push(row.clone()));
            Ok(())
        })
    }
    async fn get(&mut self, id: Uuid) -> Result<Option<CommissionRow>, AppError> {
        Ok(self
            .state()
            .inbox
            .commissions
            .iter()
            .find(|r| r.workspace_id == self.ws && r.id == id)
            .cloned())
    }
    async fn by_journey(&mut self, journey: JourneyId) -> Result<Option<CommissionRow>, AppError> {
        Ok(self
            .state()
            .inbox
            .commissions
            .iter()
            .find(|r| r.workspace_id == self.ws && r.commission.journey_id == journey)
            .cloned())
    }
    async fn list(&mut self) -> Result<Vec<CommissionRow>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .commissions
            .iter()
            .filter(|r| r.workspace_id == self.ws)
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.created_at, r.id));
        Ok(rows)
    }
    async fn set_state(&mut self, id: Uuid, state: CommissionState) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            if !t
                .state()
                .inbox
                .commissions
                .iter()
                .any(|r| r.workspace_id == ws && r.id == id)
            {
                return Err(AppError::not_found("no such commission"));
            }
            t.tx.write(move |s| {
                if let Some(r) = s
                    .inbox
                    .commissions
                    .iter_mut()
                    .find(|r| r.workspace_id == ws && r.id == id)
                {
                    r.commission.state = state;
                }
            });
            Ok(())
        })
    }
    async fn default_rate(&mut self) -> Result<Option<u16>, AppError> {
        Ok(self
            .state()
            .inbox
            .commission_defaults
            .iter()
            .find(|(w, _)| *w == self.ws)
            .map(|(_, rate)| *rate))
    }
    async fn set_default_rate(&mut self, rate_bp: u16) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            exists(
                t.state().workspace(ws).is_some(),
                "commission_default.workspace_id",
            )?;
            t.tx.write(move |s| {
                s.inbox.commission_defaults.retain(|(w, _)| *w != ws);
                s.inbox.commission_defaults.push((ws, rate_bp));
            });
            Ok(())
        })
    }
    async fn user_rate(&mut self, user: UserId) -> Result<Option<u16>, AppError> {
        Ok(self
            .state()
            .inbox
            .commission_user_rates
            .iter()
            .find(|(w, u, _)| *w == self.ws && *u == user)
            .map(|(_, _, rate)| *rate))
    }
    async fn set_user_rate(&mut self, user: UserId, rate_bp: Option<u16>) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            if rate_bp.is_some() {
                exists(
                    t.state().workspace(ws).is_some(),
                    "commission_user_rates.workspace_id",
                )?;
                exists(
                    t.state().user(user).is_some(),
                    "commission_user_rates.user_id",
                )?;
            }
            t.tx.write(move |s| {
                s.inbox
                    .commission_user_rates
                    .retain(|(w, u, _)| !(*w == ws && *u == user));
                if let Some(rate) = rate_bp {
                    s.inbox.commission_user_rates.push((ws, user, rate));
                }
            });
            Ok(())
        })
    }
}

#[async_trait]
impl ErasureRepo for MemTenant {
    async fn scrub(&mut self, person: PersonId) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            if !t
                .state()
                .inbox
                .erasure_logs
                .iter()
                .any(|e| e.workspace_id == ws && e.person_id == person)
            {
                return Err(AppError::conflict(
                    "erasure must be recorded before scrubbing",
                ));
            }
            t.tx.write(move |s| {
                let log = s
                    .inbox
                    .erasure_logs
                    .iter()
                    .find(|e| e.workspace_id == ws && e.person_id == person)
                    .expect("recorded erasure")
                    .clone();
                let mut family = vec![person];
                loop {
                    let added: Vec<_> = s
                        .inbox
                        .people
                        .iter()
                        .filter(|p| {
                            p.workspace_id == ws
                                && !family.contains(&p.id)
                                && p.merged_into.is_some_and(|id| family.contains(&id))
                        })
                        .map(|p| p.id)
                        .collect();
                    if added.is_empty() {
                        break;
                    }
                    family.extend(added);
                }
                for person in family {
                    if !s
                        .inbox
                        .erasure_logs
                        .iter()
                        .any(|e| e.workspace_id == ws && e.person_id == person)
                    {
                        s.inbox.erasure_logs.push(ErasureLog {
                            person_id: person,
                            ..log.clone()
                        });
                    }
                    for i in &s.inbox.identities {
                        if i.workspace_id == ws && i.person_id == person {
                            let key =
                                (ws, i.channel, identity_hash(i.channel, &i.value_normalized));
                            if !s.inbox.erased_identities.contains(&key) {
                                s.inbox.erased_identities.push(key);
                            }
                        }
                    }
                    super::erasure::scrub(s, ws, person);
                    if let Some(p) = s
                        .inbox
                        .people
                        .iter_mut()
                        .find(|p| p.workspace_id == ws && p.id == person)
                    {
                        p.erased_at = Some(log.at);
                        p.updated_at = log.at;
                    }
                }
            });
            Ok(())
        })
    }

    async fn record(&mut self, row: ErasureLog) -> Result<(), AppError> {
        self.call(|t| {
            same_workspace(t.ws, row.workspace_id)?;
            person(t.state(), t.ws, row.person_id)?;
            if !t
                .state()
                .inbox
                .erasure_logs
                .iter()
                .any(|r| r.workspace_id == t.ws && r.person_id == row.person_id)
            {
                t.tx.write(move |s| s.inbox.erasure_logs.push(row.clone()));
            }
            Ok(())
        })
    }
    async fn get(&mut self, person: PersonId) -> Result<Option<ErasureLog>, AppError> {
        Ok(self
            .state()
            .inbox
            .erasure_logs
            .iter()
            .find(|r| r.workspace_id == self.ws && r.person_id == person)
            .cloned())
    }
    async fn remember_identity(
        &mut self,
        channel: IdentityChannel,
        value_hash: &str,
    ) -> Result<(), AppError> {
        self.call(|t| {
            let ws = t.ws;
            exists(
                t.state().workspace(ws).is_some(),
                "erased_identities.workspace_id",
            )?;
            if value_hash.len() != 64
                || !value_hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(AppError::validation(
                    "invalid identity hash",
                    serde_json::json!({}),
                ));
            }
            let row = (ws, channel, value_hash.to_owned());
            if !t.state().inbox.erased_identities.contains(&row) {
                t.tx.write(move |s| s.inbox.erased_identities.push(row.clone()));
            }
            Ok(())
        })
    }
    async fn is_erased_identity(
        &mut self,
        channel: IdentityChannel,
        value_hash: &str,
    ) -> Result<bool, AppError> {
        Ok(self
            .state()
            .inbox
            .erased_identities
            .iter()
            .any(|(ws, c, v)| *ws == self.ws && *c == channel && v == value_hash))
    }
}

#[async_trait]
impl MailCursorRepo for MemTenant {
    async fn get(&mut self, capability: CapabilityId) -> Result<MailboxCursor, AppError> {
        Ok(self
            .state()
            .inbox
            .mail_cursors
            .iter()
            .find(|(ws, c, _)| *ws == self.ws && *c == capability)
            .map(|(_, _, r)| r.clone())
            .unwrap_or_default())
    }
    async fn store(
        &mut self,
        capability: CapabilityId,
        cursor: MailboxCursor,
    ) -> Result<(), AppError> {
        self.call(|t| {
            if t.tx.mail_cursor_fails() {
                return Err(AppError::internal("injected cursor failure"));
            }
            let ws = t.ws;
            ensure_capability(t.state(), ws, capability)?;
            t.tx.write(move |s| {
                if let Some((_, _, r)) = s
                    .inbox
                    .mail_cursors
                    .iter_mut()
                    .find(|(w, c, _)| *w == ws && *c == capability)
                {
                    r.mailboxes.extend(cursor.mailboxes.clone());
                } else {
                    s.inbox.mail_cursors.push((ws, capability, cursor.clone()));
                }
            });
            Ok(())
        })
    }
}

#[async_trait]
impl AttributionRepo for MemTenant {
    async fn insert_once(&mut self, row: JourneyAttribution) -> Result<bool, AppError> {
        self.call(|t| {
            same_workspace(t.ws, row.workspace_id)?;
            journey(t.state(), t.ws, row.journey_id)?;
            if t.state()
                .inbox
                .attribution
                .iter()
                .any(|r| r.journey_id == row.journey_id)
            {
                return Ok(false);
            }
            t.tx.write(move |s| s.inbox.attribution.push(row.clone()));
            Ok(true)
        })
    }
    async fn by_journey(
        &mut self,
        journey: JourneyId,
    ) -> Result<Option<JourneyAttribution>, AppError> {
        Ok(self
            .state()
            .inbox
            .attribution
            .iter()
            .find(|r| r.workspace_id == self.ws && r.journey_id == journey)
            .cloned())
    }
    async fn by_ad(
        &mut self,
        ad_id: &str,
        from: OffsetDateTime,
        to: OffsetDateTime,
    ) -> Result<Vec<JourneyAttribution>, AppError> {
        let mut rows: Vec<_> = self
            .state()
            .inbox
            .attribution
            .iter()
            .filter(|r| {
                r.workspace_id == self.ws
                    && r.ad_id.as_deref() == Some(ad_id)
                    && r.acquired_at >= from
                    && r.acquired_at < to
            })
            .cloned()
            .collect();
        rows.sort_by_key(|r| (r.acquired_at, r.journey_id));
        Ok(rows)
    }
}
