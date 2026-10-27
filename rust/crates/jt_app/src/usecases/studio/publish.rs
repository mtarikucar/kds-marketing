//! System-only publication. Sending is durable before I/O; no outcome is ever rescheduled.
use super::chain::{self, ExecutionInput, authorize_execution_at};
use crate::{
    error::AppError,
    ports::{
        TenantRepos,
        connectors::{PublishReceipt, PublishRequest},
        studio::{ApprovalTarget, PublishOutcome, SlotQuery},
    },
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
        failure,
    },
};
use jt_capability::Capability;
use jt_connector::{ConnectorError, Credential, provider_for_kind};
use jt_studio::{Piece, PublishAttempt, PublishState, SlotState};
use jt_tenancy::WorkspaceId;
use serde_json::json;
use time::{Duration, OffsetDateTime};

fn query(until: OffsetDateTime) -> SlotQuery {
    SlotQuery {
        from: time::Date::MIN.midnight().assume_utc(),
        until,
        hypothesis_id: None,
        lane: Some(jt_strategy::LaneKind::Organic),
    }
}
async fn credential(
    d: &Deps,
    r: &mut dyn TenantRepos,
    c: &Capability,
) -> Result<Credential, AppError> {
    let sealed = r
        .capabilities()
        .read_sealed(c.id)
        .await?
        .ok_or_else(|| chain::refuse("capability_unavailable"))?;
    open_credential(d, c.workspace_id, &sealed)
}
fn input(s: &jt_studio::Slot) -> ExecutionInput {
    ExecutionInput {
        chain: s.chain.clone(),
        capability_id: s.capability_id,
        target: ApprovalTarget::Slot(s.id),
        expected_revision: s.revision,
    }
}
async fn request(
    d: &Deps,
    ws: WorkspaceId,
    p: &Piece,
    c: &Capability,
) -> Result<PublishRequest, AppError> {
    p.validate_persisted()
        .map_err(|_| AppError::validation("invalid piece", json!({"reason":"invalid_piece"})))?;
    let adaptation = c.external_id.as_ref().and_then(|id| p.adaptations.get(id));
    let (text, media, link, privacy) = match adaptation {
        Some(a) => (a.text.clone(), &a.media, a.link.clone(), a.privacy.clone()),
        None => (p.text.clone(), &p.media, None, None),
    };
    let (media_urls, media) = super::files::resolve_media(d, ws, media, &c.kind_key).await?;
    let out = PublishRequest {
        text,
        link,
        media_urls,
        media,
        privacy,
    };
    Ok(out)
}
async fn record_daily_cap(
    r: &mut dyn TenantRepos,
    slot: &jt_studio::Slot,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let entry = jt_ledger::LedgerEntry::new(
        slot.chain.workspace_id,
        jt_ledger::Actor::System {
            component: "studio.publisher".into(),
        },
        jt_ledger::Action::new("studio.publish.skipped")
            .map_err(|_| AppError::internal("action"))?,
        json!({"slot_id":slot.id,"capability_id":slot.capability_id,"reason":"daily_ops_cap"}),
        now,
    );
    r.ledger().append(entry).await?;
    Ok(())
}
/// Each iteration releases discovery locks for media preparation, then checks the current
/// frame under the claim fence. A racing worker can win the claim; it cannot duplicate I/O.
pub async fn publish_due(d: &Deps, ws: WorkspaceId) -> Result<u32, AppError> {
    let mut count = 0;
    let mut spend_refusal = None;
    let mut skipped = std::collections::HashSet::new();
    for _ in 0..100 {
        let candidate = {
            let slots = {
                let mut r = d.uow.tenant(ws).await?;
                chain::active(r.as_mut()).await?;
                r.studio()
                    .list_slots(query(d.clock.now() + Duration::nanoseconds(1)))
                    .await?
            };
            let mut found = None;
            let mut refusal = None;
            for s in slots {
                // Release each refused candidate's transaction before considering another.
                let mut r = d.uow.tenant(ws).await?;
                if skipped.contains(&s.id)
                    || s.state != SlotState::Ready
                    || !r.studio().slot_evidence(s.id).await?.0.is_empty()
                {
                    continue;
                }
                if let Err(e) = authorize_execution_at(r.as_mut(), input(&s), d.clock.now()).await {
                    if e.details["reason"] == "daily_ops_cap" {
                        record_daily_cap(r.as_mut(), &s, d.clock.now()).await?;
                        r.commit().await?;
                        skipped.insert(s.id);
                        continue;
                    }
                    if e.code == crate::error::ErrorCode::Internal {
                        return Err(e);
                    }
                    refusal = Some(e);
                    continue;
                }
                let c = r
                    .capabilities()
                    .find(s.capability_id)
                    .await?
                    .ok_or_else(|| AppError::not_found("capability"))?;
                let p = r
                    .studio()
                    .get_piece(s.id, s.revision)
                    .await?
                    .ok_or_else(|| AppError::not_found("piece"))?;
                found = Some((s, p, c));
                break;
            }
            if found.is_none()
                && count == 0
                && let Some(e) = refusal
            {
                return Err(e);
            }
            found
        };
        let Some((slot, piece, cap)) = candidate else {
            break;
        };
        let provider = provider_for_kind(&cap.kind_key)
            .ok_or_else(|| chain::refuse("connector_unavailable"))?;
        let publisher = d
            .connectors
            .publisher(provider)
            .ok_or_else(|| chain::refuse("connector_unavailable"))?;
        let req = request(d, ws, &piece, &cap).await;
        if let Err(e) = &req
            && !matches!(
                e.code,
                crate::error::ErrorCode::Validation
                    | crate::error::ErrorCode::NotFound
                    | crate::error::ErrorCode::HostNotAllowed
                    | crate::error::ErrorCode::UpstreamUnavailable
            )
        {
            return Err(e.clone());
        }
        let (attempt, cred, public, spend) = {
            let mut r = d.uow.tenant(ws).await?;
            let permit = match authorize_execution_at(r.as_mut(), input(&slot), d.clock.now()).await
            {
                Ok(permit) => permit,
                Err(e) if e.details["reason"] == "daily_ops_cap" => {
                    record_daily_cap(r.as_mut(), &slot, d.clock.now()).await?;
                    r.commit().await?;
                    skipped.insert(slot.id);
                    continue;
                }
                Err(e) => return Err(e),
            };
            let c = r
                .capabilities()
                .find(slot.capability_id)
                .await?
                .ok_or_else(|| AppError::not_found("capability"))?;
            if c.external_id != cap.external_id || c.kind_key != cap.kind_key {
                return Err(chain::refuse("publication_account_changed"));
            }
            let cred = credential(d, r.as_mut(), &c).await?;
            let a = match r
                .studio()
                .claim_publication_for(slot.id, d.clock.now())
                .await
            {
                Ok(Some(a)) => a,
                Ok(None) => {
                    skipped.insert(slot.id);
                    continue;
                }
                Err(e) if e.details["reason"] == "daily_ops_cap" => {
                    record_daily_cap(r.as_mut(), &slot, d.clock.now()).await?;
                    r.commit().await?;
                    skipped.insert(slot.id);
                    continue;
                }
                Err(e) => return Err(e),
            };
            if a.slot_id() != slot.id
                || a.piece() != &piece
                || a.executed_version_id() != permit.strategy_version_id
                || a.control_revision() != permit.control_revision
            {
                break;
            }
            if let Err(e) = &req {
                let permanent = e.code != crate::error::ErrorCode::UpstreamUnavailable;
                let kind = if permanent { "permanent" } else { "transient" };
                // The code and stable reason only: the message may quote a media URL.
                let reason = match e.details["reason"].as_str() {
                    Some(why) => format!("{kind}: media: {} {why}", e.code.as_str()),
                    None => format!("{kind}: media: {}", e.code.as_str()),
                };
                let error = AppError::validation(
                    "media preparation failed",
                    json!({"provider_error": kind, "provider_reason": reason}),
                );
                r.studio()
                    .finish_publication(a.id(), PublishOutcome::Failed(error), d.clock.now())
                    .await?;
                if permanent {
                    r.studio()
                        .retire_slot(slot.id, slot.revision, "cancelled")
                        .await?;
                }
                r.commit().await?;
                count += 1;
                continue;
            }
            let spend = match super::budget::reserve_metered(
                r.as_mut(),
                &c,
                Some(slot.chain.clone()),
                Some(1),
                format!("publish:{}:{}", slot.id, slot.revision),
                d.clock.now(),
            )
            .await
            {
                Ok(spend) => spend,
                Err(e) if e.code != crate::error::ErrorCode::Internal => {
                    spend_refusal = Some(e);
                    skipped.insert(slot.id);
                    continue;
                }
                Err(e) => return Err(e),
            };
            r.commit().await?;
            (a, cred, adapter_public(&c), spend)
        };
        let result = publisher
            .publish(&cred, &public, &req.expect("prepared request"))
            .await;
        if let Some(spend) = spend {
            let mut r = d.uow.tenant(ws).await?;
            r.strategy().lock_execution_frame().await?;
            super::budget::settle_metered(
                r.as_mut(),
                spend,
                result.as_ref().map(|_| None).map_err(|e| e.kind()),
            )
            .await?;
            r.commit().await?;
        }
        match result {
            Ok(receipt) => {
                // The small receipt checkpoint survives interruption before final bookkeeping.
                finish(d, ws, &attempt, PublishOutcome::Observed(receipt.clone())).await?;
                finish(d, ws, &attempt, PublishOutcome::Succeeded(receipt)).await?;
            }
            Err(e) => {
                let reason = failure::failure_reason(Some(provider), &e);
                tracing::warn!(
                    workspace_id = %ws,
                    capability_id = %attempt.capability_id().0,
                    error_kind = e.kind(),
                    http_status = ?failure::http_status(&reason),
                    provider_code = ?failure::provider_code(&reason),
                    "a Studio piece could not be published"
                );
                let error = AppError::validation(
                    "publication failed",
                    json!({"provider_error":e.kind(),"provider_reason":reason}),
                );
                let outcome = if matches!(e, ConnectorError::Unknown { .. }) {
                    PublishOutcome::Unknown(error)
                } else {
                    PublishOutcome::Failed(error)
                };
                let mut r = d.uow.tenant(ws).await?;
                r.studio()
                    .finish_publication(attempt.id(), outcome, d.clock.now())
                    .await?;
                let retry_after_s = match &e {
                    ConnectorError::Throttle { retry_after } => {
                        retry_after.map(|v| v.whole_seconds())
                    }
                    _ => None,
                };
                let mut entry = jt_ledger::LedgerEntry::new(
                    ws,
                    attempt.actor().clone(),
                    jt_ledger::Action::new("studio.publish.failure")
                        .map_err(|_| AppError::internal("action"))?,
                    json!({"attempt_id":attempt.id(),"slot_id":attempt.slot_id(),"born_version_id":attempt.piece().chain.born_version_id,"executed_version_id":attempt.executed_version_id(),"arm_id":attempt.piece().chain.arm_id,"provider_error":e.kind(),"provider_reason":reason,"retry_after_s":retry_after_s}),
                    d.clock.now(),
                );
                entry.strategy_version_id = Some(attempt.executed_version_id().0);
                r.ledger().append(entry).await?;
                r.commit().await?;
            }
        }
        count += 1;
    }
    if count == 0
        && let Some(e) = spend_refusal
    {
        return Err(e);
    }
    Ok(count)
}
async fn finish(
    d: &Deps,
    ws: WorkspaceId,
    a: &PublishAttempt,
    outcome: PublishOutcome,
) -> Result<(), AppError> {
    let mut r = d.uow.tenant(ws).await?;
    r.studio()
        .finish_publication(a.id(), outcome, d.clock.now())
        .await?;
    r.commit().await
}
/// Recovery only reads providers. Abandoned Sending becomes Unknown after two minutes;
/// an exact captured receipt can be verified even after strategy retirement, never guessed.
pub async fn recover_publications(d: &Deps, ws: WorkspaceId) -> Result<u32, AppError> {
    let attempts = {
        let mut r = d.uow.tenant(ws).await?;
        chain::active(r.as_mut()).await?;
        let mut attempts = vec![];
        for s in r
            .studio()
            .list_slots(query(d.clock.now() + Duration::nanoseconds(1)))
            .await?
        {
            attempts.extend(r.studio().slot_evidence(s.id).await?.0);
        }
        attempts
    };
    let mut count = 0;
    for a in attempts {
        if a.state() == PublishState::Sending
            && a.claimed_at() < d.clock.now() - Duration::minutes(2)
        {
            // Re-read under the completion lock so recovery cannot overwrite a late success.
            let mut r = d.uow.tenant(ws).await?;
            r.strategy().lock_execution_frame().await?;
            r.studio_control().lock_control().await?;
            let current = r
                .studio()
                .slot_evidence(a.slot_id())
                .await?
                .0
                .into_iter()
                .find(|v| v.id() == a.id());
            if current.is_some_and(|v| v.state() == PublishState::Sending) {
                r.studio()
                    .finish_publication(
                        a.id(),
                        PublishOutcome::Unknown(AppError::internal("publication interrupted")),
                        d.clock.now(),
                    )
                    .await?;
                r.commit().await?;
                count += 1;
            }
        } else if let Some(jt_studio::PublishOutcome::Observed(receipt)) = a.outcome() {
            let prepared = {
                let mut r = d.uow.tenant(ws).await?;
                match chain::authorize_publication_recovery(r.as_mut(), &a, d.clock.now()).await {
                    Ok(c) => {
                        let cred = credential(d, r.as_mut(), &c).await?;
                        Some((c, cred))
                    }
                    Err(_) => None,
                }
            };
            let Some((c, cred)) = prepared else { continue };
            let Some(reader) =
                provider_for_kind(&c.kind_key).and_then(|p| d.connectors.insights(p))
            else {
                continue;
            };
            if reader
                .post_metrics(&cred, &adapter_public(&c), &receipt.external_id)
                .await
                .is_ok()
            {
                finish(
                    d,
                    ws,
                    &a,
                    PublishOutcome::Succeeded(PublishReceipt {
                        external_id: receipt.external_id.clone(),
                        url: receipt.url.clone(),
                    }),
                )
                .await?;
                count += 1;
            }
        }
    }
    Ok(count)
}
