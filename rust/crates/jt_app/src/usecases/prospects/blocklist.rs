//! The do-not-contact list, erasure and the pool's purge (spec §3.6; §7.1
//! `prospects.{do_not_contact,dnc_lift,erase}`; the `prospects_purge` job). The list holds keyed
//! hashes only (`super::blocklist_hash`): it outlives every purge, and no value is kept.

use std::collections::BTreeSet;

use jt_prospects::{
    Decision, DecisionKind, DncReason, Key, KeyKind, ProspectId, ProspectStatus, StatusEvent,
    derive_keys, next_status, normalise_key, scrub_for_dnc,
};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

use super::score::{decision_note, human_only};
use super::{
    blocklist_hash, invalid_from, leads_policy, no_such_prospect, record, recorder, refused,
};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::prospects::{BlockReason, Updated};
use crate::usecases::prospects::pool::stale;
use crate::usecases::{Deps, invalid};

/// The most raw keys one `prospects.do_not_contact` names.
const MAX_RAW_KEYS: usize = 20;

/// The most prospects one purge run deletes in a workspace.
pub const PURGE_BATCH: u32 = 500;

/// A value of one kind, as a person or an agent heard or saw it.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RawKey {
    pub kind: KeyKind,
    pub value: String,
}

/// `jeeta.prospects.do_not_contact`'s input: a prospect, or raw values (an objection that reached
/// a rep by phone), never both.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DncInput {
    #[serde(default)]
    pub confirm: bool,
    #[serde(default)]
    pub prospect_id: Option<ProspectId>,
    #[serde(default)]
    pub keys: Vec<RawKey>,
    pub reason: DncReason,
    /// Required with reason `other`; at most 500 characters.
    #[serde(default)]
    pub note: Option<String>,
}

/// What `prospects.do_not_contact` answers: the prospect (scrubbed) and the kinds of key now on
/// the list, never a value or a hash.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DncOut {
    pub prospect_id: Option<ProspectId>,
    pub kinds: Vec<KeyKind>,
}

/// Writes every key of `keys` to the list with `reason` (and `expires_at` for a rejection);
/// the kinds written.
async fn block(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    keys: &[Key],
    reason: BlockReason,
    expires_at: Option<OffsetDateTime>,
) -> Result<Vec<KeyKind>, AppError> {
    let mut kinds = BTreeSet::new();
    for key in keys {
        let hash = blocklist_hash(deps, ctx, key)?;
        r.prospect_blocklist()
            .insert(key.kind, &hash, reason, ctx.now, expires_at)
            .await?;
        kinds.insert(key.kind);
    }
    Ok(kinds.into_iter().collect())
}

/// The keys a prospect holds and would derive now, together.
async fn all_keys(
    r: &mut dyn TenantRepos,
    p: &jt_prospects::Prospect,
) -> Result<Vec<Key>, AppError> {
    let mut keys: BTreeSet<Key> = r.prospects().keys_of(p.id).await?.into_iter().collect();
    keys.extend(derive_keys(p));
    Ok(keys.into_iter().collect())
}

/// The confirmation a destructive call needs.
fn confirmed(confirm: bool, what: &str) -> Result<(), AppError> {
    if confirm {
        Ok(())
    } else {
        Err(invalid(
            "confirm",
            &format!("confirm must be true to {what}"),
        ))
    }
}

/// `jeeta.prospects.do_not_contact`: puts a business on the list. With a prospect, the prospect
/// becomes `do_not_contact`, its personal fields are emptied and its keys live on only as
/// hashes; with raw values, each is normalised by its kind and hashed. Agents may call it (an
/// objection is honoured at once); only a person lifts it.
pub async fn do_not_contact(deps: &Deps, ctx: &Ctx, input: DncInput) -> Result<DncOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let recorder = recorder(ctx)?;
    confirmed(input.confirm, "put a business on the do-not-contact list")?;
    let note = decision_note(input.note.as_deref(), input.reason == DncReason::Other)?;
    match (&input.prospect_id, input.keys.is_empty()) {
        (Some(_), false) | (None, true) => {
            return Err(invalid(
                "prospect_id",
                "name a prospect or raw keys, not both and not neither",
            ));
        }
        _ => {}
    }
    if input.keys.len() > MAX_RAW_KEYS {
        return Err(invalid("keys", "at most 20 keys"));
    }
    let raw: Vec<Key> = input
        .keys
        .iter()
        .map(|k| {
            normalise_key(k.kind, &k.value).map(|value| Key {
                kind: k.kind,
                value,
            })
        })
        .collect::<Result<_, _>>()
        .map_err(|e| {
            let mut err = invalid_from(e);
            err.details["field"] = json!("keys");
            err
        })?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.prospects().lock_pool().await?;
    let (prospect_id, kinds) = match input.prospect_id {
        Some(id) => {
            let mut p = r.prospects().lock(id).await?.ok_or_else(no_such_prospect)?;
            if p.status == ProspectStatus::Promoted {
                let person = p.promoted.as_ref().map(|x| x.person_id);
                return Err(refused(
                    ErrorCode::Conflict,
                    "promoted",
                    "the business is an inbox person: record the objection there",
                    json!({ "person_id": person }),
                ));
            }
            let to = next_status(
                p.status,
                &StatusEvent::DoNotContact {
                    reason: input.reason,
                },
            )
            .map_err(|e| {
                refused(
                    ErrorCode::Conflict,
                    "invalid_transition",
                    &e.to_string(),
                    json!({ "status": e.from }),
                )
            })?;
            let keys = all_keys(r.as_mut(), &p).await?;
            let expected = p.revision;
            scrub_for_dnc(&mut p);
            p.status = to;
            p.decision = Some(Decision {
                kind: DecisionKind::DoNotContact(input.reason),
                note,
                by: recorder,
                at: ctx.now,
            });
            p.purge_after = None;
            p.updated_at = ctx.now;
            p.revision = expected + 1;
            match r.prospects().update(&p, &[], expected).await? {
                Updated::Ok => {}
                Updated::Stale | Updated::DuplicateKey { .. } => return Err(stale(expected)),
            }
            let kinds = block(
                deps,
                ctx,
                r.as_mut(),
                &keys,
                BlockReason::DoNotContact,
                None,
            )
            .await?;
            (Some(id), kinds)
        }
        None => {
            let kinds = block(deps, ctx, r.as_mut(), &raw, BlockReason::DoNotContact, None).await?;
            (None, kinds)
        }
    };
    let payload = json!({
        "prospect_id": prospect_id,
        "reason": input.reason.key(),
        "keys": kinds,
    });
    match prospect_id {
        Some(id) => record(r.as_mut(), ctx, "prospects.do_not_contact", id, payload).await?,
        None => record_pool(r.as_mut(), ctx, "prospects.do_not_contact", payload).await?,
    }
    r.commit().await?;
    Ok(DncOut { prospect_id, kinds })
}

/// A pool ledger entry about no one prospect (raw keys, a purge).
async fn record_pool(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    action: &str,
    payload: Value,
) -> Result<(), AppError> {
    let version = crate::usecases::capabilities::version_in_force(r).await?;
    crate::usecases::capabilities::append(
        r,
        ctx,
        action,
        "prospect_pool",
        ctx.workspace_id,
        version,
        payload,
    )
    .await
}

/// `jeeta.prospects.dnc_lift`'s input: the raw value whose objection is lifted (the hash is
/// computed again; the list holds no value).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiftInput {
    pub kind: KeyKind,
    pub value: String,
}

/// What `prospects.dnc_lift` answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct LiftOut {
    pub kind: KeyKind,
    /// Whether a do-not-contact entry was there and is gone; an erasure is never lifted.
    pub lifted: bool,
}

/// `jeeta.prospects.dnc_lift`: a person with `prospects.manage` lifts a do-not-contact entry.
/// An agent never can; an erasure never lifts.
pub async fn dnc_lift(deps: &Deps, ctx: &Ctx, input: LiftInput) -> Result<LiftOut, AppError> {
    human_only(ctx, "lift a do-not-contact entry")?;
    ctx.require(Permission::ProspectsManage)?;
    let key = Key {
        kind: input.kind,
        value: normalise_key(input.kind, &input.value).map_err(invalid_from)?,
    };
    let hash = blocklist_hash(deps, ctx, &key)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.prospects().lock_pool().await?;
    let lifted = r.prospect_blocklist().lift(key.kind, &hash).await?;
    if lifted {
        record_pool(
            r.as_mut(),
            ctx,
            "prospects.dnc_lifted",
            json!({ "kind": key.kind }),
        )
        .await?;
    }
    r.commit().await?;
    Ok(LiftOut {
        kind: key.kind,
        lifted,
    })
}

/// `jeeta.prospects.erase`'s input.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EraseInput {
    #[serde(default)]
    pub confirm: bool,
}

/// What `prospects.erase` answers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct EraseOut {
    pub prospect_id: ProspectId,
    pub erased: bool,
    /// The kinds of key now on the list as erased.
    pub kinds: Vec<KeyKind>,
}

/// `jeeta.prospects.erase`: a person with `prospects.manage` deletes a prospect now and writes
/// every key it held as an erased hash, so it is never recorded again. A promoted prospect is
/// erased with its person (`inbox.people.erase`).
pub async fn erase(
    deps: &Deps,
    ctx: &Ctx,
    id: ProspectId,
    input: EraseInput,
) -> Result<EraseOut, AppError> {
    human_only(ctx, "erase a prospect")?;
    ctx.require(Permission::ProspectsManage)?;
    confirmed(input.confirm, "erase a prospect")?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.prospects().lock_pool().await?;
    let p = r.prospects().lock(id).await?.ok_or_else(no_such_prospect)?;
    if p.status == ProspectStatus::Promoted {
        return Err(refused(
            ErrorCode::Conflict,
            "erase_the_person",
            "the prospect is an inbox person: erase the person",
            json!({ "person_id": p.promoted.as_ref().map(|x| x.person_id) }),
        ));
    }
    let keys = all_keys(r.as_mut(), &p).await?;
    r.prospects().delete(id).await?;
    let kinds = block(deps, ctx, r.as_mut(), &keys, BlockReason::Erased, None).await?;
    record(
        r.as_mut(),
        ctx,
        "prospects.erased",
        id,
        json!({ "prospect_id": id, "keys": kinds }),
    )
    .await?;
    r.commit().await?;
    Ok(EraseOut {
        prospect_id: id,
        erased: true,
        kinds,
    })
}

/// What one workspace's purge did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Purged {
    /// Prospects past their `purge_after`.
    pub due: u64,
    /// Prospects deleted.
    pub deleted: u64,
    /// Expired rejection hashes deleted.
    pub expired_hashes: u64,
}

/// The `prospects_purge` job's body for one workspace (whatever its status): deletes up to
/// [`PURGE_BATCH`] prospects past their `purge_after` (a rejection's keys are first remembered as
/// `rejected` hashes for `rejected_memory_days`), then the expired rejection hashes; one
/// `prospects.purged {count}` system entry when anything was deleted. No identifier is logged.
pub async fn purge(deps: &Deps, ctx: &Ctx) -> Result<Purged, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.prospects().lock_pool().await?;
    let policy = leads_policy(r.as_mut()).await?;
    let due = r.prospects().due_for_purge(ctx.now, PURGE_BATCH).await?;
    let memory = i64::from(policy.prospects.rejected_memory_days);
    let mut out = Purged {
        due: due.len() as u64,
        ..Purged::default()
    };
    for id in due {
        let Some(p) = r.prospects().get(id).await? else {
            continue;
        };
        if p.status == ProspectStatus::Rejected && memory > 0 {
            let keys = all_keys(r.as_mut(), &p).await?;
            let until = ctx.now + Duration::days(memory);
            block(
                deps,
                ctx,
                r.as_mut(),
                &keys,
                BlockReason::Rejected,
                Some(until),
            )
            .await?;
        }
        r.prospects().delete(id).await?;
        out.deleted += 1;
    }
    out.expired_hashes = r.prospect_blocklist().purge_expired(ctx.now).await?;
    if out.deleted > 0 {
        record_pool(
            r.as_mut(),
            ctx,
            "prospects.purged",
            json!({ "count": out.deleted }),
        )
        .await?;
    }
    r.commit().await?;
    Ok(out)
}
