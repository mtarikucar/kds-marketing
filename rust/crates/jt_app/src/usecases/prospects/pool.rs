//! Recording, checking, editing and reading prospects (spec §3.1, §3.3, §3.7 caps; §7.1
//! `prospects.{create,check,update,list,get}`).

use jt_prospects::{
    Bucket, CreateInput, Key, KeyKind, Prospect, ProspectId, ProspectStatus, ResearchTaskId,
    TaskStatus, UpdateInput, derive_keys, name_city, normalise_handle, normalise_key, purge_after,
    website_domain,
};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use super::{dedupe, invalid_from, leads_policy, no_such_prospect, record, recorder, refused};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::prospects::{
    Inserted, ListCursor, MAX_PROSPECT_PAGE, ProspectQuery, ProspectRow, ScoreRow, Updated,
};
use crate::ports::{LedgerFilter, LedgerRow, TenantRepos};
use crate::usecases::{Deps, hours, invalid, keyset_cursor};

/// The prefix that keeps a create's request keys apart from the inbox's.
const REQUEST_KEY_PREFIX: &str = "prospects.create:";

/// The scores `prospects.get` answers with, newest first.
const GET_SCORES: u32 = 20;

/// The ledger entries `prospects.get` answers with, newest first, and how far back it looks for
/// them among the pool's entries.
const GET_LEDGER: usize = 50;
const GET_LEDGER_SCAN: usize = 1_000;

/// A prospect as the pool answers it: the record with its evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProspectOut {
    pub prospect: Prospect,
}

/// A prospect that shares a soft key (the website's domain, or name and city) with another.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DuplicateCandidate {
    pub prospect_id: ProspectId,
    pub business_name: String,
    pub city: Option<String>,
    /// The soft keys it shares: `domain`, `name_city`.
    pub matched: Vec<KeyKind>,
}

/// Opens a tenant bundle of the caller's workspace.
async fn bundle(deps: &Deps, ctx: &Ctx) -> Result<Box<dyn TenantRepos>, AppError> {
    deps.uow.tenant(ctx.workspace_id).await
}

/// `CONFLICT {reason: daily_cap}` unless the workspace and the task may take one more prospect
/// today, in the workspace's time zone.
async fn check_caps(
    r: &mut dyn TenantRepos,
    tz: &str,
    task: Option<(ResearchTaskId, u16)>,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let (from, to) = hours::local_day(tz, now)?;
    let resets_at = to.format(&Rfc3339).unwrap_or_default();
    let today = r.prospects().created_between(None, from, to).await?;
    if today >= jt_prospects::MAX_DAILY_PROSPECTS {
        return Err(refused(
            ErrorCode::Conflict,
            "daily_cap",
            "the workspace recorded its prospects for today",
            json!({ "scope": "workspace", "cap": jt_prospects::MAX_DAILY_PROSPECTS, "resets_at": resets_at }),
        ));
    }
    if let Some((id, cap)) = task {
        let found = r.prospects().created_between(Some(id), from, to).await?;
        if found >= u32::from(cap) {
            return Err(refused(
                ErrorCode::Conflict,
                "daily_cap",
                "the research task recorded its prospects for today",
                json!({ "scope": "task", "task_id": id, "cap": cap, "resets_at": resets_at }),
            ));
        }
    }
    Ok(())
}

/// `jeeta.prospects.create`: records one business. The recorder is the caller; the checks run in
/// spec §3.3's order under the pool lock; a request key replays the first answer for 24 hours.
pub async fn create(deps: &Deps, ctx: &Ctx, input: CreateInput) -> Result<ProspectOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let recorder = recorder(ctx)?;
    jt_prospects::validate_create(&input, ctx.now, &recorder).map_err(invalid_from)?;
    let mut r = bundle(deps, ctx).await?;
    let key = input
        .request_key
        .as_deref()
        .map(|k| format!("{REQUEST_KEY_PREFIX}{}", k.trim()));
    if let Some(key) = &key
        && let Some(stored) = r.request_keys().get(key, ctx.now).await?
    {
        return serde_json::from_value(stored)
            .map_err(|_| AppError::conflict("request key belongs to another operation"));
    }
    r.prospects().lock_pool().await?;
    let policy = leads_policy(r.as_mut()).await?;
    let task = match input.research_task_id {
        None => None,
        Some(id) => {
            let t = r
                .research_tasks()
                .get(id)
                .await?
                .ok_or_else(|| AppError::not_found("no such research task"))?;
            if t.status != TaskStatus::Open {
                return Err(refused(
                    ErrorCode::Conflict,
                    "task_closed",
                    "the research task is closed",
                    json!({ "task_id": id, "status": t.status.key() }),
                ));
            }
            Some((id, t.daily_cap))
        }
    };
    check_caps(r.as_mut(), &policy.timezone, task, ctx.now).await?;
    let mut p = jt_prospects::build(
        input,
        ProspectId::from(deps.ids.uuid()),
        ctx.workspace_id,
        ctx.now,
        recorder,
    );
    p.purge_after = purge_after(&policy.prospects, p.status, None, p.updated_at);
    let keys = derive_keys(&p);
    dedupe::check(
        deps,
        ctx,
        r.as_mut(),
        &keys,
        &p.origin.distinct_from,
        None,
        ctx.now,
    )
    .await?;
    if let Inserted::DuplicateKey { prospect_id, .. } = r.prospects().insert(&p, &keys).await? {
        return Err(duplicate(prospect_id));
    }
    let fields: Vec<&str> = p.field_names().into_iter().map(|f| f.key()).collect();
    record(
        r.as_mut(),
        ctx,
        "prospects.created",
        p.id,
        json!({
            "prospect_id": p.id,
            "research_task_id": p.research_task_id,
            "via": p.origin.via,
            "fields": fields,
            "distinct_from": p.origin.distinct_from.len(),
        }),
    )
    .await?;
    let out = ProspectOut { prospect: p };
    if let Some(key) = &key
        && !r
            .request_keys()
            .store(key, serde_json::to_value(&out)?, ctx.now)
            .await?
    {
        return Err(AppError::conflict("request key changed while recording"));
    }
    r.commit().await?;
    Ok(out)
}

fn duplicate(holder: ProspectId) -> AppError {
    refused(
        ErrorCode::Conflict,
        "duplicate",
        "another prospect holds this contact",
        json!({ "prospect_id": holder }),
    )
}

/// `jeeta.prospects.check`'s input: what is known of a business, raw. Values never go into a URL
/// (the route is a `POST`).
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CheckInput {
    #[serde(default)]
    pub business_name: Option<String>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub phone: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub website: Option<String>,
    #[serde(default)]
    pub instagram: Option<String>,
    #[serde(default)]
    pub tiktok: Option<String>,
    /// Prospects the caller knows this business is not.
    #[serde(default)]
    pub distinct_from: Vec<ProspectId>,
}

/// What `prospects.check` answers: `ok`, or the refusal `create` would meet (its `reason` and
/// details), never a hash.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CheckOut {
    pub ok: bool,
    #[serde(flatten)]
    pub refusal: Value,
}

/// The keys `input` names, each normalised by its kind; `VALIDATION` for a value that is not one.
fn check_keys(input: &CheckInput) -> Result<Vec<Key>, AppError> {
    let mut keys = Vec::new();
    let mut add = |kind: KeyKind, value: String| keys.push(Key { kind, value });
    for (kind, raw) in [
        (KeyKind::Phone, &input.phone),
        (KeyKind::Email, &input.email),
    ] {
        if let Some(raw) = raw {
            let value = normalise_key(kind, raw).map_err(invalid_from)?;
            if kind == KeyKind::Email
                && let Some((_, domain)) = value.rsplit_once('@')
                && !jt_prospects::FREE_MAIL_DOMAINS.contains(&domain)
                && let Ok(d) = normalise_key(KeyKind::Domain, domain)
            {
                add(KeyKind::Domain, d);
            }
            add(kind, value);
        }
    }
    for (kind, raw) in [
        (KeyKind::Instagram, &input.instagram),
        (KeyKind::Tiktok, &input.tiktok),
    ] {
        if let Some(raw) = raw {
            add(kind, normalise_handle(kind, raw).map_err(invalid_from)?);
        }
    }
    if let Some(raw) = &input.website {
        if let Some(domain) = website_domain(raw).map_err(invalid_from)? {
            add(KeyKind::Domain, domain);
        }
        for kind in [KeyKind::Instagram, KeyKind::Tiktok] {
            if let Ok(handle) = normalise_handle(kind, raw)
                && raw.to_ascii_lowercase().contains(match kind {
                    KeyKind::Instagram => "instagram.com/",
                    _ => "tiktok.com/",
                })
            {
                add(kind, handle);
            }
        }
    }
    if let (Some(name), Some(city)) = (&input.business_name, &input.city)
        && let Some(v) = name_city(name, city)
    {
        add(KeyKind::NameCity, v);
    }
    keys.sort();
    keys.dedup();
    if keys.is_empty() {
        return Err(invalid(
            "business_name",
            "name a phone, an email, a website, a handle, or a business name with its city",
        ));
    }
    Ok(keys)
}

/// `jeeta.prospects.check`: runs `create`'s dedupe checks for what the caller knows of a
/// business, writing nothing.
pub async fn check(deps: &Deps, ctx: &Ctx, input: CheckInput) -> Result<CheckOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let keys = check_keys(&input)?;
    let mut r = bundle(deps, ctx).await?;
    match dedupe::check(
        deps,
        ctx,
        r.as_mut(),
        &keys,
        &input.distinct_from,
        None,
        ctx.now,
    )
    .await
    {
        Ok(()) => Ok(CheckOut {
            ok: true,
            refusal: json!({}),
        }),
        Err(e) if e.details.get("reason").is_some() => Ok(CheckOut {
            ok: false,
            refusal: e.details,
        }),
        Err(e) => Err(e),
    }
}

/// `jeeta.prospects.update`: sets and clears fields of a `new`, `qualified` or `rejected`
/// prospect at a known revision, each set field with new evidence; the checks run again for the
/// keys the edit adds.
pub async fn update(
    deps: &Deps,
    ctx: &Ctx,
    id: ProspectId,
    input: UpdateInput,
) -> Result<ProspectOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let recorder = recorder(ctx)?;
    let mut r = bundle(deps, ctx).await?;
    r.prospects().lock_pool().await?;
    let mut p = r.prospects().lock(id).await?.ok_or_else(no_such_prospect)?;
    if !matches!(
        p.status,
        ProspectStatus::New | ProspectStatus::Qualified | ProspectStatus::Rejected
    ) {
        return Err(refused(
            ErrorCode::Conflict,
            "not_editable",
            "a promoted or do-not-contact prospect is not edited in the pool",
            json!({ "status": p.status.key() }),
        ));
    }
    let expected = input.expected_revision;
    if p.revision != expected {
        return Err(stale(p.revision));
    }
    let before = derive_keys(&p);
    let changed =
        jt_prospects::apply_update(&mut p, input, ctx.now, recorder).map_err(invalid_from)?;
    let policy = leads_policy(r.as_mut()).await?;
    p.purge_after = purge_after(
        &policy.prospects,
        p.status,
        p.decision.as_ref().map(|d| d.at),
        p.updated_at,
    );
    let keys = derive_keys(&p);
    let added: Vec<Key> = keys
        .iter()
        .filter(|k| !before.contains(k))
        .cloned()
        .collect();
    if !added.is_empty() {
        dedupe::check(
            deps,
            ctx,
            r.as_mut(),
            &added,
            &p.origin.distinct_from,
            Some(p.id),
            ctx.now,
        )
        .await?;
    }
    match r.prospects().update(&p, &keys, expected).await? {
        Updated::Ok => {}
        Updated::Stale => return Err(stale(expected + 1)),
        Updated::DuplicateKey { prospect_id, .. } => return Err(duplicate(prospect_id)),
    }
    let fields: Vec<&str> = changed.iter().map(|f| f.key()).collect();
    record(
        r.as_mut(),
        ctx,
        "prospects.updated",
        p.id,
        json!({ "prospect_id": p.id, "fields": fields, "revision": p.revision }),
    )
    .await?;
    r.commit().await?;
    Ok(ProspectOut { prospect: p })
}

/// `CONFLICT {reason: stale_revision, revision}`: the caller read an older revision.
pub(crate) fn stale(current: u32) -> AppError {
    refused(
        ErrorCode::Conflict,
        "stale_revision",
        "the prospect changed since it was read: read it again",
        json!({ "revision": current }),
    )
}

/// `jeeta.prospects.list`'s input: filters, a page size and the previous page's `next`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ListInput {
    #[serde(default)]
    pub status: Option<ProspectStatus>,
    #[serde(default)]
    pub research_task_id: Option<ResearchTaskId>,
    #[serde(default)]
    pub city: Option<String>,
    #[serde(default)]
    pub segment_key: Option<String>,
    #[serde(default)]
    pub bucket: Option<Bucket>,
    /// `1..=200`, 50 unless given.
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub before_at: Option<String>,
    #[serde(default)]
    pub before_id: Option<Uuid>,
}

/// Where the next page starts: pass both back as `before_at` and `before_id`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NextPage {
    pub before_at: String,
    pub before_id: Uuid,
}

/// A page of the pool, newest first; rows carry no contact values and no evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ListOut {
    pub items: Vec<ProspectRow>,
    pub next: Option<NextPage>,
}

/// `jeeta.prospects.list`.
pub async fn list(deps: &Deps, ctx: &Ctx, input: ListInput) -> Result<ListOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let limit = input.limit.unwrap_or(50);
    if !(1..=MAX_PROSPECT_PAGE).contains(&limit) {
        return Err(invalid("limit", "limit is 1..=200"));
    }
    let after = keyset_cursor(input.before_at.as_deref(), input.before_id)?
        .map(|(created_at, id)| ListCursor { created_at, id });
    let mut r = bundle(deps, ctx).await?;
    let page = r
        .prospects()
        .list(&ProspectQuery {
            status: input.status,
            research_task_id: input.research_task_id,
            city: input.city.map(|c| c.trim().to_owned()),
            segment_key: input.segment_key,
            bucket: input.bucket,
            limit,
            after,
        })
        .await?;
    Ok(ListOut {
        items: page.items,
        next: page.next.map(|c| NextPage {
            before_at: c.created_at.format(&Rfc3339).unwrap_or_default(),
            before_id: c.id,
        }),
    })
}

/// What `prospects.get` answers.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct GetOut {
    pub prospect: Prospect,
    /// The latest scores, newest first.
    pub scores: Vec<ScoreRow>,
    /// Prospects sharing a soft key with it now.
    pub duplicate_candidates: Vec<DuplicateCandidate>,
    /// The pool's ledger entries about it, newest first.
    pub ledger: Vec<LedgerRow>,
}

/// `jeeta.prospects.get`: the prospect with its evidence, its latest scores, the prospects it may
/// duplicate and its ledger history.
pub async fn get(deps: &Deps, ctx: &Ctx, id: ProspectId) -> Result<GetOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let mut r = bundle(deps, ctx).await?;
    let prospect = r.prospects().get(id).await?.ok_or_else(no_such_prospect)?;
    let scores = r.prospects().scores(id, GET_SCORES).await?;
    let soft: Vec<Key> = derive_keys(&prospect)
        .into_iter()
        .filter(|k| !k.kind.hard())
        .collect();
    let duplicate_candidates = dedupe::candidates(r.as_mut(), &soft, Some(id)).await?;
    let subject = id.to_string();
    let mut ledger = Vec::new();
    let (mut before_id, mut scanned) = (None, 0);
    while ledger.len() < GET_LEDGER && scanned < GET_LEDGER_SCAN {
        let page = r
            .ledger()
            .list(LedgerFilter {
                action_prefix: Some("prospects.".into()),
                actor_kind: None,
                agent_connection_id: None,
                limit: 200,
                before_id,
            })
            .await?;
        let Some(last) = page.last() else { break };
        before_id = Some(last.id);
        scanned += page.len();
        ledger.extend(page.into_iter().filter(|row| {
            row.entry
                .subject
                .as_ref()
                .is_some_and(|s| s.kind == "prospect" && s.id == subject)
        }));
    }
    ledger.truncate(GET_LEDGER);
    Ok(GetOut {
        prospect,
        scores,
        duplicate_candidates,
        ledger,
    })
}
