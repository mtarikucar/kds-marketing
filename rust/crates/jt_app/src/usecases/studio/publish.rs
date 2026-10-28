//! System-only publication. Sending is durable before I/O; no outcome is ever rescheduled.
use super::chain::{self, ExecutionInput, authorize_execution_at};
use crate::{
    error::AppError,
    ports::{
        TenantRepos,
        connectors::{PublishReceipt, PublishRequest, PublishResolution, Publisher},
        studio::{ApprovalTarget, PublishOutcome, SlotQuery},
    },
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
        failure,
    },
};
use jt_capability::Capability;
use jt_connector::{ConnectorError, Credential, Provider, provider_for_kind};
use jt_studio::{MediaAsset, Piece, PublishAttempt, PublishState, SlotState, TiktokPost};
use jt_tenancy::WorkspaceId;
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

/// How long a post a provider publishes in the background ([`Publisher::resolve`], TikTok) may
/// stay unsettled after it was sent: the recovery job asks again every run until then, and then
/// records it as failed.
pub const RESOLVE_WINDOW: Duration = Duration::minutes(30);

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
/// What piece `p` posts on capability `c`: its text, media, link and privacy, from its adaptation
/// for `c`'s account when it has one, else its own text and media (no link, no privacy).
pub(crate) fn content<'a>(
    p: &'a Piece,
    c: &Capability,
) -> (
    &'a str,
    &'a [MediaAsset],
    Option<&'a url::Url>,
    Option<&'a str>,
) {
    match c.external_id.as_ref().and_then(|id| p.adaptations.get(id)) {
        Some(a) => (&a.text, &a.media, a.link.as_ref(), a.privacy.as_deref()),
        None => (&p.text, &p.media, None, None),
    }
}
/// The request publishing `p` on `c`. A TikTok post (`tiktok`, the posting screen's choice) goes
/// out as the human left it there: its caption in place of the drafted text and link, its
/// privacy in place of the adaptation's.
async fn request(
    d: &Deps,
    ws: WorkspaceId,
    p: &Piece,
    c: &Capability,
    tiktok: Option<&TiktokPost>,
) -> Result<PublishRequest, AppError> {
    p.validate_persisted()
        .map_err(|_| AppError::validation("invalid piece", json!({"reason":"invalid_piece"})))?;
    let (text, media, link, privacy) = content(p, c);
    let (media_urls, media) = super::files::resolve_media(d, ws, media, &c.kind_key).await?;
    let out = match tiktok {
        Some(post) => PublishRequest {
            text: post.title.clone(),
            link: None,
            media_urls,
            media,
            privacy: Some(post.privacy_level.clone()),
            tiktok: Some(post.clone()),
        },
        None => PublishRequest {
            text: text.to_owned(),
            link: link.cloned(),
            media_urls,
            media,
            privacy: privacy.map(str::to_owned),
            tiktok: None,
        },
    };
    Ok(out)
}
/// The posting screen's choice approved for `s`'s revision, for a TikTok slot; `None` otherwise.
async fn screen_choice(
    r: &mut dyn TenantRepos,
    s: &jt_studio::Slot,
    c: &Capability,
) -> Result<Option<TiktokPost>, AppError> {
    if !jt_studio::requires_posting_screen(&c.kind_key) {
        return Ok(None);
    }
    Ok(r.studio()
        .get_approval(ApprovalTarget::Slot(s.id), s.revision)
        .await?
        .and_then(|a| a.tiktok))
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
                let choice = screen_choice(r.as_mut(), &s, &c).await?;
                found = Some((s, p, c, choice));
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
        let Some((slot, piece, cap, choice)) = candidate else {
            break;
        };
        let provider = provider_for_kind(&cap.kind_key)
            .ok_or_else(|| chain::refuse("connector_unavailable"))?;
        let publisher = d
            .connectors
            .publisher(provider)
            .ok_or_else(|| chain::refuse("connector_unavailable"))?;
        let req = request(d, ws, &piece, &cap, choice.as_ref()).await;
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
            // The posting screen passed again since the request was built: the next run posts
            // the new choice instead.
            if screen_choice(r.as_mut(), &slot, &c).await? != choice {
                break;
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
                let settled = publisher.resolve(&cred, &public, &receipt).await;
                match settled {
                    // The provider published synchronously: the receipt is the post.
                    Ok(None) => finish(d, ws, &attempt, PublishOutcome::Succeeded(receipt)).await?,
                    Ok(Some(PublishResolution::Published(post))) => {
                        finish(d, ws, &attempt, PublishOutcome::Succeeded(post)).await?
                    }
                    Ok(Some(PublishResolution::Failed(e))) => {
                        fail(d, ws, &attempt, provider, &e).await?
                    }
                    // Still processing, or the status could not be read: the recovery job asks
                    // again (`recover_publications`).
                    Ok(Some(PublishResolution::Pending)) | Err(_) => {}
                }
            }
            Err(e) => fail(d, ws, &attempt, provider, &e).await?,
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
/// Records that the provider refused or gave up on `attempt` with `e`: the attempt fails
/// (`Unknown` when the outcome is unknown) with its failure line, and `studio.publish.failure` is
/// written.
async fn fail(
    d: &Deps,
    ws: WorkspaceId,
    attempt: &PublishAttempt,
    provider: Provider,
    e: &ConnectorError,
) -> Result<(), AppError> {
    let reason = failure::failure_reason(Some(provider), e);
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
    let retry_after_s = match e {
        ConnectorError::Throttle { retry_after } => retry_after.map(|v| v.whole_seconds()),
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
    r.commit().await
}
/// Where an observed post of a provider that publishes in the background stands (see
/// [`recover_publications`]): `true` when the attempt was settled (succeeded or failed), `false`
/// when it is left for a later run; `None` when the provider publishes synchronously, and the
/// receipt is to be verified by reading the post back.
async fn settle_observed(
    d: &Deps,
    ws: WorkspaceId,
    a: &PublishAttempt,
    (provider, publisher): (Provider, &dyn Publisher),
    (cred, public): (&Credential, &Value),
    receipt: &PublishReceipt,
) -> Result<Option<bool>, AppError> {
    let settled = publisher.resolve(cred, public, receipt).await;
    let pending = match settled {
        Ok(None) => return Ok(None),
        Ok(Some(PublishResolution::Published(post))) => {
            finish(d, ws, a, PublishOutcome::Succeeded(post)).await?;
            return Ok(Some(true));
        }
        Ok(Some(PublishResolution::Failed(e))) => {
            fail(d, ws, a, provider, &e).await?;
            return Ok(Some(true));
        }
        Ok(Some(PublishResolution::Pending)) => None,
        Err(e) => Some(e),
    };
    if d.clock.now() - a.claimed_at() < RESOLVE_WINDOW {
        return Ok(Some(false));
    }
    // Past the window: what the last read said, or that it never settled.
    let e = pending.unwrap_or_else(|| {
        ConnectorError::transient(format!(
            "the post was still processing {} minutes after it was sent: timed out",
            RESOLVE_WINDOW.whole_minutes()
        ))
    });
    fail(d, ws, a, provider, &e).await?;
    Ok(Some(true))
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
/// an exact captured receipt can be verified even after strategy retirement, never guessed. A
/// provider that publishes in the background ([`Publisher::resolve`]) is asked where the post
/// stands: published (succeeded, with the post's own receipt), given up (failed, with its failure
/// line), or still processing (asked again next run, for at most [`RESOLVE_WINDOW`] after it was
/// sent, then failed); any other provider's receipt is verified by reading the post back.
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
            let provider = provider_for_kind(&c.kind_key);
            if let Some((provider, publisher)) =
                provider.and_then(|p| d.connectors.publisher(p).map(|publisher| (p, publisher)))
            {
                let public = adapter_public(&c);
                match settle_observed(
                    d,
                    ws,
                    &a,
                    (provider, publisher.as_ref()),
                    (&cred, &public),
                    receipt,
                )
                .await?
                {
                    Some(true) => {
                        count += 1;
                        continue;
                    }
                    Some(false) => continue,
                    None => {}
                }
            }
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
