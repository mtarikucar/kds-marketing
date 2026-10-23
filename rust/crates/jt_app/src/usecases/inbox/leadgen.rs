//! Page lead intake. Provider reads are lock-free; all domain effects use the consumer's claim.
use super::{consumer, journeys, people, record};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{TenantRepos, connectors::LeadGenRecord, inbox::JourneyAttribution},
    usecases::{Deps, connector::open_credential},
};
use jt_capability::{Capability, StoredStatus};
use jt_connector::{Credential, EventKind, InboundEvent, Provider};
use jt_inbox::*;
use jt_tenancy::WorkspaceStatus;
use serde_json::json;
use time::{Duration, OffsetDateTime};

pub(super) struct Fetched {
    cap: Capability,
    sealed: Vec<u8>,
    lead: LeadGenRecord,
    acquired_at: OffsetDateTime,
}
fn invalid() -> AppError {
    AppError::validation("invalid lead-gen submission", json!({"field":"leadgen"}))
}

/// Drop the read transaction before calling Meta. Recheck the credential binding in intake.
pub(super) async fn fetch(deps: &Deps, event: &InboundEvent) -> Result<Option<Fetched>, AppError> {
    if event.provider != Provider::Meta || event.kind != EventKind::LeadGen {
        return Ok(None);
    }
    let Some(id) = event.capability_id else {
        return Ok(None);
    };
    let (cap, sealed, credential) = {
        let mut r = deps.uow.tenant(event.workspace_id).await?;
        if !matches!(
            r.workspace().get().await?.status,
            WorkspaceStatus::Active | WorkspaceStatus::PendingPayment
        ) {
            return Ok(None);
        }
        let Some(cap) = r.capabilities().find(id).await? else {
            return Ok(None);
        };
        if !matches!(cap.kind_key.as_str(), "facebook_page" | "messenger")
            || cap.status == StoredStatus::Retired
        {
            return Ok(None);
        }
        let sealed = r
            .capabilities()
            .read_sealed(id)
            .await?
            .ok_or_else(|| AppError::conflict("lead-gen Page credentials unavailable"))?;
        let credential = open_credential(deps, event.workspace_id, &sealed)?;
        match &credential {
            Credential::PageToken { page_id, .. }
                if cap.external_id.as_deref() == Some(page_id)
                    && event.payload["leadgen"]["page_id"].as_str() == Some(page_id) => {}
            _ => return Err(invalid()),
        }
        (cap, sealed, credential)
    };
    let id = event.payload["leadgen"]["leadgen_id"]
        .as_str()
        .filter(|id| !id.trim().is_empty())
        .ok_or_else(invalid)?;
    let fetcher = deps
        .connectors
        .leadgen(Provider::Meta)
        .ok_or_else(|| AppError::conflict("lead-gen connector unavailable"))?;
    let lead = fetcher
        .fetch(&credential, id)
        .await
        .map_err(|_| AppError::conflict("lead-gen fetch failed"))?;
    if lead.leadgen_id != id {
        return Err(invalid());
    }
    // Acquisition time must come from the provider, never ingestion or retry time.
    let acquired_at = lead
        .created_time
        .or_else(|| {
            event.payload["leadgen"]["created_time"]
                .as_i64()
                .and_then(|ts| OffsetDateTime::from_unix_timestamp(ts).ok())
        })
        .ok_or_else(invalid)?;
    Ok(Some(Fetched {
        cap,
        sealed,
        lead,
        acquired_at,
    }))
}

pub(super) async fn intake(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    cap: &Capability,
    fetched: &Fetched,
) -> Result<&'static str, AppError> {
    let cap = r
        .capabilities()
        .lock(cap.id)
        .await?
        .ok_or_else(|| AppError::conflict("lead-gen Page unavailable"))?;
    if cap.id != fetched.cap.id
        || cap.kind_key != fetched.cap.kind_key
        || cap.status == StoredStatus::Retired
        || cap.external_id != fetched.cap.external_id
        || r.capabilities().read_sealed(cap.id).await?.as_ref() != Some(&fetched.sealed)
    {
        return Err(AppError::conflict("lead-gen Page binding changed"));
    }
    let lead = &fetched.lead;
    let key = format!("leadgen:meta:{}", lead.leadgen_id);
    if r.journeys().event_by_key(&key).await?.is_some() {
        return Ok("duplicate");
    }
    let mut identities = Vec::new();
    for (field, channel) in [
        ("email", IdentityChannel::Email),
        ("phone_number", IdentityChannel::Phone),
        ("phone", IdentityChannel::Phone),
    ] {
        for value in lead
            .fields
            .get(field)
            .into_iter()
            .flatten()
            .filter(|v| !v.trim().is_empty())
        {
            identities.push(people::IdentityInput {
                channel,
                value: value.clone(),
                capability_id: Some(cap.id),
            });
        }
    }
    let name = lead
        .fields
        .get("full_name")
        .and_then(|v| v.first())
        .cloned()
        .unwrap_or_default();
    let matched = people::match_or_create(
        deps,
        ctx,
        r,
        people::CreateInput {
            display_name: name,
            identities,
            source: Source::MetaAds,
        },
        None,
    )
    .await?;
    let previous = super::active_or_latest_journey(r, matched.person.id).await?;
    let journey = consumer::journey(deps, ctx, r, &matched.person).await?;
    // Only the submission that opened this journey may establish its attribution.
    if matched.created || previous.as_ref().is_none_or(|j| j.id != journey.id) {
        r.attribution()
            .insert_once(JourneyAttribution {
                workspace_id: ctx.workspace_id,
                journey_id: journey.id,
                provider: "meta".into(),
                ad_id: lead.ad_id.clone(),
                adset_id: None,
                campaign_id: lead.campaign_id.clone(),
                form_id: lead.form_id.clone(),
                leadgen_id: lead.leadgen_id.clone(),
                acquired_at: fetched.acquired_at,
            })
            .await?;
    }
    let event = JourneyEvent {
        id: JourneyEventId::from(deps.ids.uuid()),
        workspace_id: ctx.workspace_id,
        journey_id: journey.id,
        source: EventSource::System,
        idempotency_key: key,
        kind: JourneyEventKind::LeadReceived {
            leadgen_id: lead.leadgen_id.clone(),
            acquired_at: fetched.acquired_at,
        },
        reason_label: None,
        at: ctx.now,
    };
    let transition = reduce(&journey, &event, &ReducePolicy::default())
        .map_err(|_| AppError::conflict("lead-gen journey transition refused"))?;
    let effects = transition.effects().to_vec();
    r.journeys()
        .apply_transition(journey.id, transition, event)
        .await?;
    journeys::apply_effects(deps, ctx, r, &journey, &effects).await?;
    let task = Task {
        id: TaskId::from(deps.ids.uuid()),
        workspace_id: ctx.workspace_id,
        journey_id: journey.id,
        title: if journey.status == JourneyStatus::Lost {
            "Review lead and reopen lost journey"
        } else {
            "Follow up on lead form"
        }
        .into(),
        due_at: ctx.now + Duration::hours(1),
        assignee: journey.owner,
        status: TaskStatus::Open,
    };
    r.tasks().insert(task.clone()).await?;
    record(r, ctx, "inbox.leadgen.received", "journey", journey.id, json!({"person_id":matched.person.id,"source":"meta_ads","task_id":task.id,"first_touch":matched.created})).await?;
    Ok("consumed")
}
