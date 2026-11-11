//! System-only publication. Sending is durable before I/O; no outcome is ever rescheduled.
use super::chain::{self, ExecutionInput, authorize_execution_at};
use crate::{
    error::AppError,
    ports::{
        TenantRepos,
        connectors::{PublishReceipt, PublishRequest, PublishResolution, Publisher, Scheduled},
        studio::{ApprovalTarget, PublishOutcome, SlotId, SlotQuery},
    },
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
        failure,
    },
};
use jt_capability::{Capability, CapabilityId};
use jt_connector::{ConnectorError, Credential, Provider, provider_for_kind};
use jt_studio::{MediaAsset, Piece, PublishAttempt, PublishState, SlotState, TiktokPost};
use jt_tenancy::WorkspaceId;
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

/// How long a post a provider publishes in the background ([`Publisher::resolve`], TikTok) may
/// stay unsettled after it was sent: the recovery job asks again every run until then, and then
/// records it as failed.
pub const RESOLVE_WINDOW: Duration = Duration::minutes(30);

/// How long after it was sent a post chosen public that is posted but has no public id yet
/// ([`PublishResolution::AwaitingPublicId`]: TikTok names one once its moderation passed the
/// post) waits for one: until then each status read may bring it (the recovery job's, or one a
/// webhook asks for at once); then the post settles as posted, under the id it has (no
/// permalink, no counters yet), and TikTok's later `post.publish.publicly_available` webhook
/// upgrades it to its public id ([`resolve_observed`]). A post fewer may see, or a draft, has
/// none to wait for and settles at once.
pub const PUBLIC_ID_WAIT: Duration = Duration::minutes(15);

/// How far ahead of its time a ready post is looked at for its platform's own scheduler
/// (design 2026-11-10 §7.3); each provider names the window it takes ([`Publisher::schedule_window`]).
pub const HOLD_HORIZON: Duration = Duration::days(30);

/// How close to a held post's time Jeeta still asks its platform to take it back: nearer than
/// this the post is going out, and a post that is out is never deleted.
pub const WITHDRAW_MARGIN: Duration = Duration::minutes(2);

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
/// The request publishing `p` on `c`, as a post of `format` when the slot carries a planned post
/// (an Instagram story goes out as one). A TikTok post (`tiktok`, the posting screen's choice)
/// goes out as the human left it there: its caption in place of the drafted text and link, its
/// privacy in place of the adaptation's.
async fn request(
    d: &Deps,
    ws: WorkspaceId,
    p: &Piece,
    c: &Capability,
    tiktok: Option<&TiktokPost>,
    format: Option<jt_studio::PostFormat>,
) -> Result<PublishRequest, AppError> {
    p.validate_persisted()
        .map_err(|_| AppError::validation("invalid piece", json!({"reason":"invalid_piece"})))?;
    let (text, media, link, privacy) = content(p, c);
    let (media_urls, media_mimes, media) =
        super::files::resolve_typed_media(d, ws, media, &c.kind_key).await?;
    let out = match tiktok {
        // A draft names no privacy: it is chosen in TikTok.
        Some(post) => PublishRequest {
            text: post.title.clone(),
            link: None,
            media_urls,
            media,
            privacy: (!post.is_draft()).then(|| post.privacy_level.clone()),
            tiktok: Some(post.clone()),
            format,
            media_mimes: media_mimes.clone(),
        },
        None => PublishRequest {
            text: text.to_owned(),
            link: link.cloned(),
            media_urls,
            media,
            privacy: privacy.map(str::to_owned),
            tiktok: None,
            format,
            media_mimes,
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
                    // A slot waiting for a human is not a failed run: `studio.pending` names it.
                    if !chain::awaits_human(&e) {
                        refusal = Some(e);
                    }
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
                let format = r.studio_posts().get_post(s.id).await?.map(|x| x.format);
                found = Some((s, p, c, choice, format));
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
        let Some((slot, piece, cap, choice, format)) = candidate else {
            break;
        };
        let provider = provider_for_kind(&cap.kind_key)
            .ok_or_else(|| chain::refuse("connector_unavailable"))?;
        let publisher = d
            .connectors
            .publisher(provider)
            .ok_or_else(|| chain::refuse("connector_unavailable"))?;
        let req = request(d, ws, &piece, &cap, choice.as_ref(), format).await;
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
                    super::posts::retire_post_of(
                        r.as_mut(),
                        slot.id,
                        jt_studio::RetirementReason::Cancelled,
                        d.clock.now(),
                    )
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
                let public_id = choice.as_ref().is_some_and(TiktokPost::expects_public_id);
                match settled {
                    // The provider published synchronously: the receipt is the post.
                    Ok(None) => finish(d, ws, &attempt, PublishOutcome::Succeeded(receipt)).await?,
                    Ok(Some(PublishResolution::Published(post))) => {
                        finish(d, ws, &attempt, PublishOutcome::Succeeded(post)).await?
                    }
                    // Posted, with no public id to wait for.
                    Ok(Some(PublishResolution::AwaitingPublicId(post))) if !public_id => {
                        finish(d, ws, &attempt, PublishOutcome::Succeeded(post)).await?
                    }
                    Ok(Some(PublishResolution::Failed(e))) => {
                        fail(d, ws, &attempt, provider, &e).await?
                    }
                    // Still processing, waiting for its public id, or the status could not be
                    // read: the recovery job asks again (`recover_publications`).
                    Ok(Some(
                        PublishResolution::Pending | PublishResolution::AwaitingPublicId(_),
                    ))
                    | Err(_) => {}
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
/// receipt is to be verified by reading the post back. `public_id`: whether the post was chosen
/// public, so that one posted without a public id yet waits for it ([`PUBLIC_ID_WAIT`]).
async fn settle_observed(
    d: &Deps,
    ws: WorkspaceId,
    a: &PublishAttempt,
    (provider, publisher): (Provider, &dyn Publisher),
    (cred, public): (&Credential, &Value),
    receipt: &PublishReceipt,
    public_id: bool,
) -> Result<Option<bool>, AppError> {
    let settled = publisher.resolve(cred, public, receipt).await;
    let pending = match settled {
        Ok(None) => return Ok(None),
        Ok(Some(PublishResolution::Published(post))) => {
            finish(d, ws, a, PublishOutcome::Succeeded(post)).await?;
            return Ok(Some(true));
        }
        Ok(Some(PublishResolution::AwaitingPublicId(post))) => {
            if public_id && d.clock.now() - a.claimed_at() < PUBLIC_ID_WAIT {
                return Ok(Some(false));
            }
            // Posted: under the id it has, once no public id is to come or the wait is over.
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
        } else if let Some(jt_studio::PublishOutcome::Observed(receipt)) = a.outcome()
            && recover_observed(d, ws, &a, receipt).await?
        {
            count += 1;
        }
    }
    Ok(count)
}

/// Recovers the observed attempt `a` (its captured `receipt`) as [`recover_publications`] does,
/// under the attempt's historical authority: `true` once settled.
async fn recover_observed(
    d: &Deps,
    ws: WorkspaceId,
    a: &PublishAttempt,
    receipt: &PublishReceipt,
) -> Result<bool, AppError> {
    let prepared = {
        let mut r = d.uow.tenant(ws).await?;
        match chain::authorize_publication_recovery(r.as_mut(), a, d.clock.now()).await {
            Ok(c) => {
                let cred = credential(d, r.as_mut(), &c).await?;
                // The posting screen's choice approved for the revision sent, for a TikTok post.
                let public_id = r
                    .studio()
                    .get_approval(ApprovalTarget::Slot(a.slot_id()), a.slot_revision())
                    .await?
                    .and_then(|approval| approval.tiktok)
                    .is_some_and(|post| post.expects_public_id());
                // A story has no counters: it is confirmed by reading it back by its id.
                let story = r
                    .studio_posts()
                    .get_post(a.slot_id())
                    .await?
                    .is_some_and(|p| p.format == jt_studio::PostFormat::Story);
                Some((c, cred, public_id, story))
            }
            Err(_) => None,
        }
    };
    let Some((c, cred, public_id, story)) = prepared else {
        return Ok(false);
    };
    let provider = provider_for_kind(&c.kind_key);
    if let Some((provider, publisher)) =
        provider.and_then(|p| d.connectors.publisher(p).map(|publisher| (p, publisher)))
    {
        let public = adapter_public(&c);
        // A post left with the platform's scheduler is asked about there, from its time on.
        if let Some(at) = a.held_until() {
            return settle_held(
                d,
                ws,
                a,
                (provider, publisher.as_ref()),
                (&cred, &public),
                receipt,
                at,
            )
            .await;
        }
        if let Some(settled) = settle_observed(
            d,
            ws,
            a,
            (provider, publisher.as_ref()),
            (&cred, &public),
            receipt,
            public_id,
        )
        .await?
        {
            return Ok(settled);
        }
        if story {
            if publisher
                .read_back(&cred, &public, &receipt.external_id)
                .await
                .is_err()
            {
                return Ok(false);
            }
            finish(
                d,
                ws,
                a,
                PublishOutcome::Succeeded(PublishReceipt {
                    external_id: receipt.external_id.clone(),
                    url: receipt.url.clone(),
                }),
            )
            .await?;
            return Ok(true);
        }
    }
    let Some(reader) = provider_for_kind(&c.kind_key).and_then(|p| d.connectors.insights(p)) else {
        return Ok(false);
    };
    if reader
        .post_metrics(&cred, &adapter_public(&c), &receipt.external_id)
        .await
        .is_err()
    {
        return Ok(false);
    }
    finish(
        d,
        ws,
        a,
        PublishOutcome::Succeeded(PublishReceipt {
            external_id: receipt.external_id.clone(),
            url: receipt.url.clone(),
        }),
    )
    .await?;
    Ok(true)
}

/// The attempt of capability `capability_id` whose receipt, observed or settled, is
/// `external_id` (TikTok's publish id), in the open bundle `r` (one read:
/// `StudioRepo::attempt_by_receipt`); `None` when none is.
pub(crate) async fn attempt_by_receipt(
    r: &mut dyn TenantRepos,
    capability_id: CapabilityId,
    external_id: &str,
) -> Result<Option<PublishAttempt>, AppError> {
    r.studio()
        .attempt_by_receipt(capability_id, external_id)
        .await
}

/// Reads back at once the post `external_id` (its receipt's id: TikTok's publish id) that
/// capability `capability_id` published, when the provider's webhook says it moved (TikTok's
/// `post.publish.*`):
///
/// - an attempt still observed is read back with the very read [`recover_publications`] makes,
///   so that a webhook and the recovery job settle it alike and whichever comes second finds it
///   settled;
/// - an attempt that settled under it as a provisional receipt (no page: TikTok named no public
///   id within [`PUBLIC_ID_WAIT`]) is asked about again, and once the provider names the post's
///   public id, the attempt and its publication take that public receipt
///   (`studio.publish.public_id`): its page and its counters, a late public id included;
/// - anything else (a post settled with its page, one no attempt of the capability sent) is
///   left alone.
///
/// `true` when an attempt settled or was upgraded now. A status read that fails while upgrading
/// is the error (`UPSTREAM_UNAVAILABLE`), so that its caller knows the read did not happen.
pub async fn resolve_observed(
    d: &Deps,
    ws: WorkspaceId,
    capability_id: CapabilityId,
    external_id: &str,
) -> Result<bool, AppError> {
    let found = {
        let mut r = d.uow.tenant(ws).await?;
        chain::active(r.as_mut()).await?;
        attempt_by_receipt(r.as_mut(), capability_id, external_id).await?
    };
    let Some(a) = found else {
        return Ok(false);
    };
    match a.outcome() {
        Some(jt_studio::PublishOutcome::Observed(receipt)) => {
            recover_observed(d, ws, &a, receipt).await
        }
        Some(jt_studio::PublishOutcome::Succeeded(receipt)) if receipt.url.is_none() => {
            upgrade_settled(d, ws, &a, receipt).await
        }
        _ => Ok(false),
    }
}

/// Asks the provider again about the post succeeded attempt `a` settled under the provisional
/// `receipt`, and upgrades the attempt and its publication to the public receipt it names now
/// (see [`resolve_observed`]): `true` when upgraded.
async fn upgrade_settled(
    d: &Deps,
    ws: WorkspaceId,
    a: &PublishAttempt,
    receipt: &PublishReceipt,
) -> Result<bool, AppError> {
    let prepared = {
        let mut r = d.uow.tenant(ws).await?;
        match chain::authorize_publication_recovery(r.as_mut(), a, d.clock.now()).await {
            Ok(c) => {
                let cred = credential(d, r.as_mut(), &c).await?;
                Some((c, cred))
            }
            Err(_) => None,
        }
    };
    let Some((c, cred)) = prepared else {
        return Ok(false);
    };
    let Some(publisher) = provider_for_kind(&c.kind_key).and_then(|p| d.connectors.publisher(p))
    else {
        return Ok(false);
    };
    let public = match publisher.resolve(&cred, &adapter_public(&c), receipt).await {
        Ok(Some(PublishResolution::Published(post))) if post.external_id != receipt.external_id => {
            post
        }
        Ok(_) => return Ok(false),
        Err(e) => {
            return Err(AppError {
                code: crate::error::ErrorCode::UpstreamUnavailable,
                message: "the post's status could not be read".into(),
                details: json!({"provider_error": e.kind()}),
            });
        }
    };
    // As a completion keeps it: the page without its query or fragment.
    let jt_studio::PublishOutcome::Succeeded(public) =
        PublishOutcome::Succeeded(public).into_redacted()
    else {
        return Ok(false);
    };
    let mut r = d.uow.tenant(ws).await?;
    let upgraded = r
        .studio()
        .upgrade_receipt(a.id(), public, d.clock.now())
        .await?;
    r.commit().await?;
    Ok(upgraded)
}

/// Leaves with their platform's own scheduler the ready posts whose time is ahead, where the
/// workspace switched that on and the platform can hold the post (design 2026-11-10 §7.3, B47).
///
/// It is the slot's one attempt, made early: the same authorization, claim fence and spend
/// reservation as a send, judged as of the post's time (its account's hours, the material gate,
/// the connection's approval), and then `schedule` instead of `publish`. The captured receipt
/// names the scheduled post; from its time on the recovery job asks the platform whether it
/// went out ([`recover_publications`]). A post that cannot be left there (another platform,
/// media, a story, too near or too far, a refusal as of its time) is not touched: Jeeta sends it
/// at its time. Answers how many posts were handed over.
pub async fn hold_ahead(d: &Deps, ws: WorkspaceId) -> Result<u32, AppError> {
    let now = d.clock.now();
    let slots = {
        let mut r = d.uow.tenant(ws).await?;
        chain::active(r.as_mut()).await?;
        if !r
            .studio_posts()
            .posting_settings()
            .await?
            .provider_scheduling
        {
            return Ok(0);
        }
        r.studio().list_slots(query(now + HOLD_HORIZON)).await?
    };
    let internal = |e: &AppError| e.code == crate::error::ErrorCode::Internal;
    let mut count = 0;
    for slot in slots {
        if slot.state != SlotState::Ready || slot.scheduled_at <= now {
            continue;
        }
        let at = slot.scheduled_at;
        // Can its platform hold it, and would Jeeta send it at its time? Nothing is prepared
        // for a post that stays with Jeeta.
        let found = {
            let mut r = d.uow.tenant(ws).await?;
            if !r.studio().slot_evidence(slot.id).await?.0.is_empty() {
                continue;
            }
            let Some(c) = r.capabilities().find(slot.capability_id).await? else {
                continue;
            };
            let Some(piece) = r.studio().get_piece(slot.id, slot.revision).await? else {
                continue;
            };
            let Some((provider, publisher)) = provider_for_kind(&c.kind_key)
                .and_then(|p| d.connectors.publisher(p).map(|publisher| (p, publisher)))
            else {
                continue;
            };
            let format = r.studio_posts().get_post(slot.id).await?.map(|x| x.format);
            // Can this account's platform hold a post of this format at all?
            let shape = PublishRequest {
                format,
                ..Default::default()
            };
            if publisher
                .schedule_window(&adapter_public(&c), &shape)
                .is_none()
            {
                continue;
            }
            match authorize_execution_at(r.as_mut(), input(&slot), at).await {
                Ok(_) => {}
                Err(e) if internal(&e) => return Err(e),
                Err(_) => continue,
            }
            (c, piece, provider, publisher, format)
        };
        let (cap, piece, provider, publisher, format) = found;
        let req = match request(d, ws, &piece, &cap, None, format).await {
            Ok(req) => req,
            Err(e) if internal(&e) => return Err(e),
            // Its media cannot be prepared now: it stays with Jeeta, which says why at its time.
            Err(_) => continue,
        };
        // This very post, this far ahead?
        match publisher.schedule_window(&adapter_public(&cap), &req) {
            Some((earliest, latest)) if at - now >= earliest && at - now <= latest => {}
            _ => continue,
        }
        let (attempt, cred, public, spend) = {
            let mut r = d.uow.tenant(ws).await?;
            let permit = match authorize_execution_at(r.as_mut(), input(&slot), at).await {
                Ok(permit) => permit,
                Err(e) if internal(&e) => return Err(e),
                Err(_) => continue,
            };
            let Some(c) = r.capabilities().find(slot.capability_id).await? else {
                continue;
            };
            if c.external_id != cap.external_id || c.kind_key != cap.kind_key {
                continue;
            }
            let cred = match credential(d, r.as_mut(), &c).await {
                Ok(cred) => cred,
                Err(e) if internal(&e) => return Err(e),
                Err(_) => continue,
            };
            let a = match r.studio().claim_publication_held(slot.id, now, at).await {
                Ok(Some(a)) => a,
                Ok(None) => continue,
                Err(e) if e.details["reason"] == "daily_ops_cap" => continue,
                Err(e) => return Err(e),
            };
            if a.slot_id() != slot.id
                || a.piece() != &piece
                || a.executed_version_id() != permit.strategy_version_id
                || a.control_revision() != permit.control_revision
            {
                continue;
            }
            let spend = match super::budget::reserve_metered(
                r.as_mut(),
                &c,
                Some(slot.chain.clone()),
                Some(1),
                format!("publish:{}:{}", slot.id, slot.revision),
                now,
            )
            .await
            {
                Ok(spend) => spend,
                Err(e) if internal(&e) => return Err(e),
                Err(_) => continue,
            };
            r.commit().await?;
            (a, cred, adapter_public(&c), spend)
        };
        let result = publisher.schedule(&cred, &public, &req, at).await;
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
            // The receipt names the scheduled post: asked about from its time on.
            Ok(receipt) => finish(d, ws, &attempt, PublishOutcome::Observed(receipt)).await?,
            Err(e) => fail(d, ws, &attempt, provider, &e).await?,
        }
        count += 1;
    }
    Ok(count)
}

/// Where a post left with its platform's scheduler stands, from its time `at` on: out (the
/// attempt succeeds with the post's receipt), gone from the platform (it fails: it will not go
/// out), or still waiting, which is asked again every run for [`RESOLVE_WINDOW`] after its time
/// and then recorded as unknown, for a person. `true` once settled.
async fn settle_held(
    d: &Deps,
    ws: WorkspaceId,
    a: &PublishAttempt,
    (provider, publisher): (Provider, &dyn Publisher),
    (cred, public): (&Credential, &Value),
    receipt: &PublishReceipt,
    at: OffsetDateTime,
) -> Result<bool, AppError> {
    let late = d.clock.now() - at >= RESOLVE_WINDOW;
    let e = match publisher.scheduled(cred, public, receipt).await {
        Ok(Scheduled::Published(post)) => {
            finish(d, ws, a, PublishOutcome::Succeeded(post)).await?;
            return Ok(true);
        }
        Ok(Scheduled::Gone) => ConnectorError::permanent(
            "the scheduled post is no longer at the platform: it was not published",
        ),
        Ok(Scheduled::Waiting) if late => ConnectorError::unknown(format!(
            "the platform still held the scheduled post {} minutes after its time",
            RESOLVE_WINDOW.whole_minutes()
        )),
        Err(_) if late => ConnectorError::unknown(format!(
            "the scheduled post could not be read {} minutes after its time",
            RESOLVE_WINDOW.whole_minutes()
        )),
        Ok(Scheduled::Waiting) | Err(_) => return Ok(false),
    };
    fail(d, ws, a, provider, &e).await?;
    Ok(true)
}

/// What became of taking a post back from its platform's scheduler (`withdraw_held`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Withdrawal {
    /// The slot has no post waiting at a platform.
    NotHeld,
    /// Taken back: it will not go out.
    Withdrawn,
    /// It had already gone out.
    WentOut,
    /// Its time is nearer than [`WITHDRAW_MARGIN`]: it is going out.
    TooLate,
    /// The platform did not confirm; a refusal is recorded as an unknown outcome for a person.
    Unconfirmed,
}

/// Takes the post of `slot` back from its platform's scheduler, because of `why` (design
/// 2026-11-10 §7.3: whatever would stop Jeeta from sending also takes a held post back).
///
/// Taken back, the attempt ends as refused (`withdrawn: <why>`) and `studio.publish.withdrawn`
/// is written; with `release` the slot is cancelled too and, for a version of a content package,
/// the version waits for a time again. A platform that refuses (not a passing failure) leaves
/// the attempt as an unknown outcome with `studio.publish.withdraw_unconfirmed`: a person looks
/// at the platform, and nothing is sent again. A passing failure changes nothing: it is asked
/// again.
pub(crate) async fn withdraw_held(
    d: &Deps,
    ws: WorkspaceId,
    slot: SlotId,
    why: &str,
    release: bool,
) -> Result<Withdrawal, AppError> {
    let now = d.clock.now();
    let (a, receipt, access) = {
        let mut r = d.uow.tenant(ws).await?;
        let Some(a) = r
            .studio()
            .slot_evidence(slot)
            .await?
            .0
            .into_iter()
            .find(PublishAttempt::is_held)
        else {
            return Ok(Withdrawal::NotHeld);
        };
        let Some(jt_studio::PublishOutcome::Observed(receipt)) = a.outcome().cloned() else {
            return Ok(Withdrawal::NotHeld);
        };
        if a.held_until().is_none_or(|at| at - now <= WITHDRAW_MARGIN) {
            return Ok(Withdrawal::TooLate);
        }
        // The account that holds it, as it was when the post was left there.
        let access = match chain::authorize_publication_recovery(r.as_mut(), &a, now).await {
            Ok(c) => match credential(d, r.as_mut(), &c).await {
                Ok(cred) => Ok((c, cred)),
                Err(e) => Err(e),
            },
            Err(e) => Err(e),
        };
        (a, receipt, access)
    };
    let result = match access {
        Ok((c, cred)) => {
            let Some((provider, publisher)) = provider_for_kind(&c.kind_key)
                .and_then(|p| d.connectors.publisher(p).map(|publisher| (p, publisher)))
            else {
                return Ok(Withdrawal::Unconfirmed);
            };
            publisher
                .withdraw(&cred, &adapter_public(&c), &receipt)
                .await
                .map_err(|e| (Some(provider), e))
        }
        Err(e) if e.code == crate::error::ErrorCode::Internal => return Err(e),
        Err(_) => Err((
            None,
            ConnectorError::permission("the account that holds the post cannot be used"),
        )),
    };
    let frame = Some(a.executed_version_id().0);
    match result {
        Ok(true) => {
            let mut r = d.uow.tenant(ws).await?;
            let refused = AppError::conflict("publication withdrawn");
            let refused = AppError {
                details: json!({"provider_reason": format!("withdrawn: {why}")}),
                ..refused
            };
            r.studio()
                .finish_publication(a.id(), PublishOutcome::Refused(refused), now)
                .await?;
            if release {
                if let Some(s) = r.studio().get_slot(slot).await?
                    && matches!(s.state, SlotState::Planned | SlotState::Ready)
                {
                    r.studio()
                        .retire_slot(s.id, s.revision, "cancelled")
                        .await?;
                    super::posts::retire_post_of(
                        r.as_mut(),
                        s.id,
                        jt_studio::RetirementReason::Cancelled,
                        now,
                    )
                    .await?;
                }
                crate::usecases::social::schedule::free_version_of(
                    r.as_mut(),
                    &super::measure::system_ctx(ws, now),
                    slot,
                )
                .await?;
            }
            let mut entry = jt_ledger::LedgerEntry::new(
                ws,
                a.actor().clone(),
                jt_ledger::Action::new("studio.publish.withdrawn")
                    .map_err(|_| AppError::internal("action"))?,
                json!({"attempt_id":a.id(),"slot_id":slot,"reason":why}),
                now,
            );
            entry.strategy_version_id = frame;
            r.ledger().append(entry).await?;
            r.commit().await?;
            Ok(Withdrawal::Withdrawn)
        }
        Ok(false) => Ok(Withdrawal::WentOut),
        // A passing failure: asked again by the next run, or by the person's next try.
        Err((_, ConnectorError::Transient { .. } | ConnectorError::Throttle { .. })) => {
            Ok(Withdrawal::Unconfirmed)
        }
        Err((provider, e)) => {
            let reason = failure::failure_reason(provider, &e);
            let error = AppError::validation(
                "withdrawal unconfirmed",
                json!({"provider_error":"unknown",
                       "provider_reason":format!("withdraw ({why}): {reason}")}),
            );
            let mut r = d.uow.tenant(ws).await?;
            r.studio()
                .finish_publication(a.id(), PublishOutcome::Unknown(error), now)
                .await?;
            let mut entry = jt_ledger::LedgerEntry::new(
                ws,
                a.actor().clone(),
                jt_ledger::Action::new("studio.publish.withdraw_unconfirmed")
                    .map_err(|_| AppError::internal("action"))?,
                json!({"attempt_id":a.id(),"slot_id":slot,"reason":why,
                       "provider_error":e.kind(),"provider_reason":reason}),
                now,
            );
            entry.strategy_version_id = frame;
            r.ledger().append(entry).await?;
            r.commit().await?;
            Ok(Withdrawal::Unconfirmed)
        }
    }
}

/// Takes the post of `slot` back from its platform's scheduler before a person's own action
/// on it goes on (cancelling the slot, "Olmamış" on its content): `Ok` when nothing waits at a
/// platform, when it was taken back, or when it is out or going out (the action then meets a
/// published post, as it always could); `CONFLICT` (`withdraw_unconfirmed`) when the platform
/// did not confirm, so that nothing is cancelled here while it may still go out there.
pub(crate) async fn withdraw_for_person(
    d: &Deps,
    ws: WorkspaceId,
    slot: SlotId,
    why: &str,
) -> Result<(), AppError> {
    match withdraw_held(d, ws, slot, why, false).await? {
        Withdrawal::Unconfirmed => Err(AppError {
            code: crate::error::ErrorCode::Conflict,
            message: "the platform did not confirm taking the scheduled post back".into(),
            details: json!({"reason":"withdraw_unconfirmed","slot_id":slot}),
        }),
        _ => Ok(()),
    }
}

/// Takes back from their platforms the held posts Jeeta would no longer send (design
/// 2026-11-10 §7.3): the slot was cancelled or its content replaced, or what authorizes a send
/// refuses it as of its time (a brake, the module removed, the account paused, the connection's
/// approval switched on, a share permission revoked, the strategy gone). Run every minute by the
/// publisher job, before anything is sent; a post taken back is cancelled and, for a version of
/// a content package, waits for a time again. Answers how many were taken back.
pub async fn withdraw_stopped(d: &Deps, ws: WorkspaceId) -> Result<u32, AppError> {
    let now = d.clock.now();
    let held = {
        let mut r = d.uow.tenant(ws).await?;
        chain::active(r.as_mut()).await?;
        let mut held = vec![];
        let slots = r.studio().list_slots(query(now + HOLD_HORIZON)).await?;
        for s in slots {
            if s.scheduled_at <= now {
                continue;
            }
            for a in r.studio().slot_evidence(s.id).await?.0 {
                if a.is_held() {
                    held.push((s.clone(), a));
                }
            }
        }
        held
    };
    let mut count = 0;
    for (s, a) in held {
        let why = if s.state != SlotState::Ready || s.revision != a.slot_revision() {
            Some("slot_changed".to_owned())
        } else {
            let mut r = d.uow.tenant(ws).await?;
            match authorize_execution_at(r.as_mut(), input(&s), s.scheduled_at).await {
                Ok(_) => None,
                Err(e) if e.code == crate::error::ErrorCode::Internal => return Err(e),
                Err(e) => Some(
                    e.details["reason"]
                        .as_str()
                        .unwrap_or(e.code.as_str())
                        .to_owned(),
                ),
            }
        };
        if let Some(why) = why
            && withdraw_held(d, ws, s.id, &why, true).await? == Withdrawal::Withdrawn
        {
            count += 1;
        }
    }
    Ok(count)
}
