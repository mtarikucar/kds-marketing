//! The pool's dedupe checks (spec §3.3), in their fixed order, on every create, on every update
//! that changes a key, and for `prospects.check`. Only hard keys (phone, email, Instagram,
//! TikTok) refuse:
//! 1. each phone and email against erased identities (`FORBIDDEN {reason: erased_identity}`),
//!    then each hard key against the blocklist (`FORBIDDEN {reason: do_not_contact}`, or
//!    `CONFLICT {reason: previously_rejected}` for a remembered rejection); no other detail;
//! 2. phone and email against the inbox's active identities (`CONFLICT {reason: in_inbox,
//!    person_id}`): the business is a relationship already;
//! 3. hard keys against live prospects (`CONFLICT {reason: duplicate, prospect_id}`).
//!
//! Soft keys (a website's domain, name and city) are shared by branches and chains, so they
//! never refuse: the live prospects holding one come back as [`Flag`]s (`possible_duplicate`,
//! or `previously_rejected_soft` for a rejection not purged yet), except those named in
//! `distinct_from`.
//!
//! Reads only: no lock beyond the caller's pool lock, no write.

use std::collections::BTreeMap;

use jt_inbox::IdentityChannel;
use jt_prospects::{Key, KeyKind, ProspectId, ProspectStatus, phone_is_dialable};
use serde::Serialize;
use serde_json::json;
use time::OffsetDateTime;

use super::{blocklist_hash, refused};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::prospects::BlockReason;
use crate::usecases::Deps;

use super::pool::DuplicateCandidate;

/// What a write or a check reports about soft keys it shares with live prospects. Never a
/// refusal: a branch or a chain shares its website and its name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "flag", rename_all = "snake_case")]
pub enum Flag {
    /// New, qualified or promoted prospects with the same domain or name and city: look at them;
    /// if this is another business, name them in `distinct_from`.
    PossibleDuplicate { candidates: Vec<DuplicateCandidate> },
    /// Rejected prospects (not purged yet) with the same domain or name and city: maybe the
    /// same business, rejected before.
    PreviouslyRejectedSoft { candidates: Vec<DuplicateCandidate> },
}

/// The inbox identity channel of a key, when it is one: a phone in E.164 (not a `tr444:` number)
/// or an email.
fn identity_channel(key: &Key) -> Option<IdentityChannel> {
    match key.kind {
        KeyKind::Phone if phone_is_dialable(&key.value) => Some(IdentityChannel::Phone),
        KeyKind::Email => Some(IdentityChannel::Email),
        _ => None,
    }
}

/// Runs the checks for `keys` of a prospect that is `except` (an update) or new (`None`); the
/// soft-key flags when nothing refuses.
pub(crate) async fn check(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    keys: &[Key],
    distinct_from: &[ProspectId],
    except: Option<ProspectId>,
    now: OffsetDateTime,
) -> Result<Vec<Flag>, AppError> {
    let hard: Vec<Key> = keys.iter().filter(|k| k.kind.hard()).cloned().collect();
    // 1. Erased identities, then the blocklist.
    for key in &hard {
        if let Some(channel) = identity_channel(key) {
            crate::usecases::inbox::erasure::check_identity(r, channel, &key.value).await?;
        }
    }
    for key in &hard {
        let hash = blocklist_hash(deps, ctx, key)?;
        match r
            .prospect_blocklist()
            .contains(key.kind, &hash, now)
            .await?
        {
            Some(BlockReason::DoNotContact | BlockReason::Erased) => {
                return Err(refused(
                    ErrorCode::Forbidden,
                    "do_not_contact",
                    "the business is on the do-not-contact list",
                    json!({}),
                ));
            }
            Some(BlockReason::Rejected) => {
                return Err(refused(
                    ErrorCode::Conflict,
                    "previously_rejected",
                    "the business was rejected before",
                    json!({}),
                ));
            }
            None => {}
        }
    }
    // 2. The inbox.
    for key in &hard {
        if let Some(channel) = identity_channel(key)
            && let Some(person) = r.people().find_by_identity(channel, &key.value).await?
        {
            return Err(refused(
                ErrorCode::Conflict,
                "in_inbox",
                "the business is already a person in the inbox",
                json!({ "person_id": person.id }),
            ));
        }
    }
    // 3. Hard keys of other prospects.
    if let Some((_, holder)) = r
        .prospects()
        .find_by_keys(&hard)
        .await?
        .into_iter()
        .find(|(_, id)| Some(*id) != except)
    {
        return Err(refused(
            ErrorCode::Conflict,
            "duplicate",
            "another prospect holds this contact",
            json!({ "prospect_id": holder }),
        ));
    }
    // Soft keys of other prospects: flags, unless named as distinct.
    let soft: Vec<Key> = keys.iter().filter(|k| !k.kind.hard()).cloned().collect();
    flags(r, &soft, except, distinct_from).await
}

/// Step 1 again, for a promotion (the lists may have changed since the prospect was recorded):
/// `erased_identity` when a phone or an email was erased, `do_not_contact` when a hard key is
/// listed as an objection or an erasure. A remembered rejection does not refuse: it was written
/// after this prospect was recorded, by the purge of another one.
pub(crate) async fn blocked(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    keys: &[Key],
    now: OffsetDateTime,
) -> Result<Option<&'static str>, AppError> {
    for key in keys.iter().filter(|k| k.kind.hard()) {
        if let Some(channel) = identity_channel(key)
            && let Err(e) =
                crate::usecases::inbox::erasure::check_identity(r, channel, &key.value).await
        {
            return if e.details["reason"] == "erased_identity" {
                Ok(Some("erased_identity"))
            } else {
                Err(e)
            };
        }
        let hash = blocklist_hash(deps, ctx, key)?;
        if matches!(
            r.prospect_blocklist()
                .contains(key.kind, &hash, now)
                .await?,
            Some(BlockReason::DoNotContact | BlockReason::Erased)
        ) {
            return Ok(Some("do_not_contact"));
        }
    }
    Ok(None)
}

/// The flags of the soft `keys` of a prospect that is `except` or new: the live prospects
/// holding one, but those in `distinct_from`, rejected ones apart.
pub(crate) async fn flags(
    r: &mut dyn TenantRepos,
    keys: &[Key],
    except: Option<ProspectId>,
    distinct_from: &[ProspectId],
) -> Result<Vec<Flag>, AppError> {
    let (rejected, others): (Vec<DuplicateCandidate>, Vec<DuplicateCandidate>) =
        candidates(r, keys, except)
            .await?
            .into_iter()
            .filter(|c| !distinct_from.contains(&c.prospect_id))
            .partition(|c| c.status == ProspectStatus::Rejected);
    let mut out = Vec::new();
    if !others.is_empty() {
        out.push(Flag::PossibleDuplicate { candidates: others });
    }
    if !rejected.is_empty() {
        out.push(Flag::PreviouslyRejectedSoft {
            candidates: rejected,
        });
    }
    Ok(out)
}

/// The prospects other than `except` holding one of the soft `keys`, each with what matched.
pub(crate) async fn candidates(
    r: &mut dyn TenantRepos,
    keys: &[Key],
    except: Option<ProspectId>,
) -> Result<Vec<DuplicateCandidate>, AppError> {
    let soft: Vec<Key> = keys.iter().filter(|k| !k.kind.hard()).cloned().collect();
    let mut matched: BTreeMap<ProspectId, Vec<KeyKind>> = BTreeMap::new();
    for (kind, id) in r.prospects().find_by_keys(&soft).await? {
        if Some(id) != except {
            matched.entry(id).or_default().push(kind);
        }
    }
    let mut out = Vec::with_capacity(matched.len());
    for (id, kinds) in matched {
        if let Some(p) = r.prospects().get(id).await? {
            out.push(DuplicateCandidate {
                prospect_id: id,
                business_name: p.business_name,
                city: p.city,
                status: p.status,
                matched: kinds,
            });
        }
    }
    Ok(out)
}
