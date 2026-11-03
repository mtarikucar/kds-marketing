//! The do-not-contact list, erasure and the pool's purge (spec §3.6; §7.1
//! `prospects.{do_not_contact,dnc_lift,erase}`; the `prospects_purge` job). The list holds keyed
//! hashes of hard keys only (`super::blocklist_hash`): it outlives every purge, and no value is
//! kept. A soft key (a domain, a name and city) is never listed: it is shared by others.

use std::collections::BTreeSet;

use jt_inbox::PersonId;
use jt_prospects::{
    Decision, DecisionKind, DncReason, Key, KeyKind, Prospect, ProspectId, ProspectStatus,
    Recorder, StatusEvent, derive_keys, next_status, normalise_key, purge_cutoffs, scrub_for_dnc,
};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::{Duration, OffsetDateTime};

use super::score::{decision_note, human_only};
use super::{
    blocklist_fingerprint, blocklist_hash, forget_requests, invalid_from, leads_policy,
    no_such_prospect, record, recorder, refused,
};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::prospects::{BlockReason, Updated};
use crate::usecases::prospects::pool::stale;
use crate::usecases::{Deps, invalid};

/// The most raw keys one `prospects.do_not_contact` names.
const MAX_RAW_KEYS: usize = 20;

/// The most prospects one purge batch deletes in a workspace, each batch in its own
/// transaction.
pub const PURGE_BATCH: u32 = 500;

/// The most batches one purge run makes in a workspace: a backlog beyond
/// `PURGE_BATCH * MAX_PURGE_BATCHES` waits for the next run.
pub const MAX_PURGE_BATCHES: u32 = 20;

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

/// What `prospects.do_not_contact` answers: the prospects now `do_not_contact` (scrubbed), the
/// promoted ones whose inbox person should record the objection too, and the kinds of key now on
/// the list, never a value or a hash.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DncOut {
    /// The prospect named, if one was.
    pub prospect_id: Option<ProspectId>,
    /// Every prospect this call marked `do_not_contact`: the one named, or those holding a raw
    /// key.
    pub prospects: Vec<ProspectId>,
    /// The inbox people of promoted prospects holding a raw key: record the objection on them
    /// (`inbox.suppressions.add`).
    pub people: Vec<PersonId>,
    pub kinds: Vec<KeyKind>,
}

/// Writes every hard key of `keys` to the list with `reason` (and `expires_at` for a
/// rejection), under the workspace key's fingerprint; the kinds written.
pub(crate) async fn block(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    keys: &[Key],
    reason: BlockReason,
    expires_at: Option<OffsetDateTime>,
) -> Result<Vec<KeyKind>, AppError> {
    let fingerprint = blocklist_fingerprint(deps, ctx)?;
    let mut kinds = BTreeSet::new();
    for key in keys.iter().filter(|k| k.kind.hard()) {
        let hash = blocklist_hash(deps, ctx, key)?;
        r.prospect_blocklist()
            .insert(key.kind, &hash, reason, ctx.now, expires_at, &fingerprint)
            .await?;
        kinds.insert(key.kind);
    }
    Ok(kinds.into_iter().collect())
}

/// The keys a prospect holds and would derive now, together.
pub(crate) async fn all_keys(r: &mut dyn TenantRepos, p: &Prospect) -> Result<Vec<Key>, AppError> {
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

/// `VALIDATION {field, reason: not_a_hard_key}`: only a phone, an email or a handle is listed.
fn not_a_hard_key(field: &str) -> AppError {
    AppError::validation(
        format!("{field}: only a phone, an email, an Instagram or a TikTok handle is listed"),
        json!({ "field": field, "reason": "not_a_hard_key" }),
    )
}

/// Marks `p` do-not-contact for `reason`: its personal fields emptied, its score rows deleted
/// (their reasons are evidence about the business; the latest score number stays), its keys
/// gone from the pool and its hard keys listed, the create requests that recorded it forgotten;
/// one `prospects.do_not_contact` entry. The kinds listed.
async fn mark_dnc(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    mut p: Prospect,
    reason: DncReason,
    note: &str,
    recorder: &Recorder,
) -> Result<Vec<KeyKind>, AppError> {
    let to = next_status(p.status, &StatusEvent::DoNotContact { reason }).map_err(|e| {
        refused(
            ErrorCode::Conflict,
            "invalid_transition",
            &e.to_string(),
            json!({ "status": e.from }),
        )
    })?;
    let keys = all_keys(r, &p).await?;
    let expected = p.revision;
    scrub_for_dnc(&mut p);
    p.status = to;
    p.decision = Some(Decision {
        kind: DecisionKind::DoNotContact(reason),
        note: note.to_owned(),
        by: recorder.clone(),
        at: ctx.now,
    });
    p.purge_after = None;
    p.updated_at = ctx.now;
    p.revision = expected + 1;
    match r.prospects().update(&p, &[], expected).await? {
        Updated::Ok => {}
        Updated::Stale | Updated::DuplicateKey { .. } => return Err(stale(expected)),
    }
    r.prospects().delete_scores(p.id).await?;
    forget_requests(r, p.id).await?;
    let kinds = block(deps, ctx, r, &keys, BlockReason::DoNotContact, None).await?;
    record(
        r,
        ctx,
        "prospects.do_not_contact",
        p.id,
        json!({ "prospect_id": p.id, "reason": reason.key(), "keys": kinds }),
    )
    .await?;
    Ok(kinds)
}

/// `jeeta.prospects.do_not_contact`: puts a business on the list. With a prospect, the prospect
/// becomes `do_not_contact`, its personal fields and score history are emptied and its hard keys
/// live on only as hashes; with raw values, each is normalised by its kind and hashed, and every
/// live prospect holding one is marked as if named (a promoted one is the inbox person's: its
/// person is answered so the objection is recorded there too). Agents may call it (an objection
/// is honoured at once); only a person lifts it. Runs in a suspended workspace too.
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
    if input.keys.iter().any(|k| !k.kind.hard()) {
        return Err(not_a_hard_key("keys"));
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
    let out = match input.prospect_id {
        Some(id) => {
            let p = r.prospects().lock(id).await?.ok_or_else(no_such_prospect)?;
            if p.status == ProspectStatus::Promoted {
                let person = p.promoted.as_ref().map(|x| x.person_id);
                return Err(refused(
                    ErrorCode::Conflict,
                    "promoted",
                    "the business is an inbox person: record the objection there",
                    json!({ "person_id": person }),
                ));
            }
            let kinds = mark_dnc(deps, ctx, r.as_mut(), p, input.reason, &note, &recorder).await?;
            DncOut {
                prospect_id: Some(id),
                prospects: vec![id],
                people: Vec::new(),
                kinds,
            }
        }
        None => {
            let holders: BTreeSet<ProspectId> = r
                .prospects()
                .find_by_keys(&raw)
                .await?
                .into_iter()
                .map(|(_, id)| id)
                .collect();
            let (mut prospects, mut people) = (Vec::new(), Vec::new());
            for id in holders {
                let Some(p) = r.prospects().lock(id).await? else {
                    continue;
                };
                match p.status {
                    ProspectStatus::Promoted => {
                        people.extend(p.promoted.as_ref().map(|x| x.person_id));
                    }
                    ProspectStatus::DoNotContact => {}
                    ProspectStatus::New | ProspectStatus::Qualified | ProspectStatus::Rejected => {
                        mark_dnc(deps, ctx, r.as_mut(), p, input.reason, &note, &recorder).await?;
                        prospects.push(id);
                    }
                }
            }
            let kinds = block(deps, ctx, r.as_mut(), &raw, BlockReason::DoNotContact, None).await?;
            record_pool(
                r.as_mut(),
                ctx,
                "prospects.do_not_contact",
                json!({
                    "reason": input.reason.key(),
                    "keys": kinds,
                    "prospects": prospects.len(),
                    "people": people.len(),
                }),
            )
            .await?;
            DncOut {
                prospect_id: None,
                prospects,
                people,
                kinds,
            }
        }
    };
    r.commit().await?;
    Ok(out)
}

/// A pool ledger entry about no one prospect (raw keys, a lift, a purge).
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
    if !input.kind.hard() {
        return Err(not_a_hard_key("kind"));
    }
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

/// `jeeta.prospects.erase`: a person with `prospects.manage` deletes a prospect now (its keys and
/// scores with it, and the create requests that recorded it) and writes every hard key it held
/// as an erased hash, so it is never recorded again. A promoted prospect is erased with its
/// person (`inbox.people.erase`). Runs in a suspended workspace too.
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
    forget_requests(r.as_mut(), id).await?;
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

/// What a person's erasure did to the pool.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct PersonErased {
    /// The prospect promoted into the person, scrubbed (ids kept).
    pub linked: Option<ProspectId>,
    /// The unlinked prospects holding the person's phone or email, deleted.
    pub deleted: Vec<ProspectId>,
}

/// Runs in `inbox.people.erase`'s transaction, after the inbox lock (it takes the pool lock):
/// the prospect promoted into the person is scrubbed as a do-not-contact one is (personal
/// fields, evidence, score rows and the create requests that recorded it gone; ids, status and
/// promotion kept: its lifetime is the person's), and every unlinked live prospect holding one of
/// the person's `keys` (phone, email) is deleted with the requests that recorded it. Every hard
/// key each held is hashed as `erased`, so the business is not collected again (L-06): its
/// handles, and its phone and email too (a `tr444:` number or an undeliverable address is no
/// erased identity). One `prospects.erased {via: person}` entry per prospect.
pub(crate) async fn on_person_erased(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    person: PersonId,
    keys: &[Key],
) -> Result<PersonErased, AppError> {
    r.prospects().lock_pool().await?;
    let mut out = PersonErased::default();
    if let Some(mut p) = r.prospects().by_person(person).await? {
        let held = all_keys(r, &p).await?;
        let expected = p.revision;
        scrub_for_dnc(&mut p);
        p.updated_at = ctx.now;
        p.revision = expected + 1;
        match r.prospects().update(&p, &[], expected).await? {
            Updated::Ok => {}
            Updated::Stale | Updated::DuplicateKey { .. } => return Err(stale(expected)),
        }
        r.prospects().delete_scores(p.id).await?;
        forget_requests(r, p.id).await?;
        let kinds = block(deps, ctx, r, &held, BlockReason::Erased, None).await?;
        record(
            r,
            ctx,
            "prospects.erased",
            p.id,
            json!({ "prospect_id": p.id, "keys": kinds, "via": "person", "person_id": person }),
        )
        .await?;
        out.linked = Some(p.id);
    }
    let hard: Vec<Key> = keys.iter().filter(|k| k.kind.hard()).cloned().collect();
    let holders: BTreeSet<ProspectId> = r
        .prospects()
        .find_by_keys(&hard)
        .await?
        .into_iter()
        .map(|(_, id)| id)
        .filter(|id| Some(*id) != out.linked)
        .collect();
    for id in holders {
        let Some(p) = r.prospects().lock(id).await? else {
            continue;
        };
        // Another person's prospect: that person's erasure decides about it.
        if p.status == ProspectStatus::Promoted {
            continue;
        }
        let held = all_keys(r, &p).await?;
        r.prospects().delete(id).await?;
        forget_requests(r, id).await?;
        let kinds = block(deps, ctx, r, &held, BlockReason::Erased, None).await?;
        record(
            r,
            ctx,
            "prospects.erased",
            id,
            json!({ "prospect_id": id, "keys": kinds, "via": "person", "person_id": person }),
        )
        .await?;
        out.deleted.push(id);
    }
    Ok(out)
}

/// What one workspace's purge did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Purged {
    /// Prospects past their retention under the current policy.
    pub due: u64,
    /// Prospects deleted.
    pub deleted: u64,
    /// Expired rejection hashes deleted.
    pub expired_hashes: u64,
    /// The batches it took.
    pub batches: u32,
}

/// The `prospects_purge` job's body for one workspace (whatever its status), in batches of
/// [`PURGE_BATCH`], each in its own transaction under the pool lock, until a batch finds fewer
/// than that or [`MAX_PURGE_BATCHES`] ran: deletes the prospects past their retention under the
/// current policy (`jt_prospects::purge_cutoffs`: a shortened retention reaches every existing
/// prospect), a rejection's hard keys first remembered as `rejected` hashes for
/// `rejected_memory_days`, each with the create requests that recorded it; then the expired
/// rejection hashes. One `prospects.purged {count}` system entry per batch that deleted
/// anything. No identifier is logged.
pub async fn purge(deps: &Deps, ctx: &Ctx) -> Result<Purged, AppError> {
    let mut out = Purged::default();
    for batch in 0..MAX_PURGE_BATCHES {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        r.prospects().lock_pool().await?;
        let policy = leads_policy(r.as_mut()).await?;
        let cutoffs = purge_cutoffs(&policy.prospects, ctx.now);
        let due = r.prospects().due_for_purge(cutoffs, PURGE_BATCH).await?;
        let memory = i64::from(policy.prospects.rejected_memory_days);
        let mut deleted = 0u64;
        for id in &due {
            let Some(p) = r.prospects().get(*id).await? else {
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
            r.prospects().delete(*id).await?;
            forget_requests(r.as_mut(), *id).await?;
            deleted += 1;
        }
        if batch == 0 {
            out.expired_hashes = r.prospect_blocklist().purge_expired(ctx.now).await?;
        }
        if deleted > 0 {
            record_pool(
                r.as_mut(),
                ctx,
                "prospects.purged",
                json!({ "count": deleted }),
            )
            .await?;
        }
        r.commit().await?;
        out.due += due.len() as u64;
        out.deleted += deleted;
        out.batches += 1;
        if (due.len() as u64) < u64::from(PURGE_BATCH) {
            break;
        }
    }
    Ok(out)
}
