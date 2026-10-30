//! The pool's dedupe checks (spec §3.3), in their fixed order, on every create, on every update
//! that changes a key, and for `prospects.check`:
//! 1. each phone and email against erased identities (`FORBIDDEN {reason: erased_identity}`),
//!    then every key against the blocklist (`FORBIDDEN {reason: do_not_contact}`, or
//!    `CONFLICT {reason: previously_rejected}` for a remembered rejection); no other detail;
//! 2. phone and email against the inbox's active identities (`CONFLICT {reason: in_inbox,
//!    person_id}`): the business is a relationship already;
//! 3. hard keys against live prospects (`CONFLICT {reason: duplicate, prospect_id}`);
//! 4. soft keys against live prospects (`CONFLICT {reason: possible_duplicate, candidates}`)
//!    unless every candidate is named in `distinct_from`.
//!
//! Reads only: no lock beyond the caller's pool lock, no write.

use std::collections::BTreeMap;

use jt_inbox::IdentityChannel;
use jt_prospects::{Key, KeyKind, ProspectId};
use serde_json::json;
use time::OffsetDateTime;

use super::{blocklist_hash, refused};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::prospects::BlockReason;
use crate::usecases::Deps;

use super::pool::DuplicateCandidate;

fn identity_channel(kind: KeyKind) -> Option<IdentityChannel> {
    match kind {
        KeyKind::Phone => Some(IdentityChannel::Phone),
        KeyKind::Email => Some(IdentityChannel::Email),
        _ => None,
    }
}

/// Runs the checks for `keys` of a prospect that is `except` (an update) or new (`None`).
pub(crate) async fn check(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    keys: &[Key],
    distinct_from: &[ProspectId],
    except: Option<ProspectId>,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    // 1. Erased identities, then the blocklist.
    for key in keys {
        if let Some(channel) = identity_channel(key.kind) {
            crate::usecases::inbox::erasure::check_identity(r, channel, &key.value).await?;
        }
    }
    for key in keys {
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
    for key in keys {
        if let Some(channel) = identity_channel(key.kind)
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
    let hard: Vec<Key> = keys.iter().filter(|k| k.kind.hard()).cloned().collect();
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
    // 4. Soft keys of other prospects, unless named as distinct.
    let soft: Vec<Key> = keys.iter().filter(|k| !k.kind.hard()).cloned().collect();
    let candidates = candidates(r, &soft, except).await?;
    let open: Vec<DuplicateCandidate> = candidates
        .into_iter()
        .filter(|c| !distinct_from.contains(&c.prospect_id))
        .collect();
    if !open.is_empty() {
        return Err(refused(
            ErrorCode::Conflict,
            "possible_duplicate",
            "prospects with the same website or name and city exist: resend with distinct_from \
             naming them if this is another business",
            json!({ "candidates": open }),
        ));
    }
    Ok(())
}

/// The prospects other than `except` holding one of the soft `keys`, each with what matched.
pub(crate) async fn candidates(
    r: &mut dyn TenantRepos,
    keys: &[Key],
    except: Option<ProspectId>,
) -> Result<Vec<DuplicateCandidate>, AppError> {
    let mut matched: BTreeMap<ProspectId, Vec<KeyKind>> = BTreeMap::new();
    for (kind, id) in r.prospects().find_by_keys(keys).await? {
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
                matched: kinds,
            });
        }
    }
    Ok(out)
}
