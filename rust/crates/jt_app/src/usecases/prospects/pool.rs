//! Recording, checking, editing and reading prospects (spec §3.1, §3.3, §3.7 caps; §7.1
//! `prospects.{create,check,update,list,get}`).

use jt_prospects::{
    Bucket, CreateInput, Key, KeyKind, Prospect, ProspectError, ProspectId, ProspectStatus,
    ResearchTask, ResearchTaskId, TaskStatus, UpdateInput, derive_keys, name_city,
    normalise_handle, normalise_key, purge_after, website_domain, website_handle,
};
use jt_strategy::Rubric;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use uuid::Uuid;

use super::dedupe::Flag;
use super::{
    REQUEST_KEY_PREFIX, dedupe, invalid_from, leads_policy, no_such_prospect, record, recorder,
    refused, with_purge_after,
};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::prospects::{
    CountBy, Inserted, ListCursor, MAX_PROSPECT_PAGE, ProspectQuery, ProspectRow, ScoreRow, Updated,
};
use crate::ports::{LedgerFilter, LedgerRow, TenantRepos};
use crate::usecases::{Deps, hours, invalid, keyset_cursor};

/// The scores `prospects.get` answers with, newest first.
const GET_SCORES: u32 = 20;

/// The ledger entries `prospects.get` answers with, newest first, and how far back it looks for
/// them among the pool's entries.
const GET_LEDGER: usize = 50;
const GET_LEDGER_SCAN: usize = 1_000;

/// A prospect as the pool answers it: the record with its evidence and its purge time under the
/// current policy, and what its soft keys share with other prospects (never a refusal).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ProspectOut {
    pub prospect: Prospect,
    pub flags: Vec<Flag>,
}

/// A prospect that shares a soft key (the website's domain, or name and city) with another.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DuplicateCandidate {
    pub prospect_id: ProspectId,
    pub business_name: String,
    pub city: Option<String>,
    pub status: ProspectStatus,
    /// The soft keys it shares: `domain`, `name_city`.
    pub matched: Vec<KeyKind>,
}

/// The answer a create request key recorded: the prospect it made, read again now (a request
/// key stores only `{prospect_id}`). `None` when the key is not live.
async fn replay(
    r: &mut dyn TenantRepos,
    key: &str,
    now: OffsetDateTime,
) -> Result<Option<ProspectOut>, AppError> {
    let Some(stored) = r.request_keys().get(key, now).await? else {
        return Ok(None);
    };
    let id: ProspectId = stored
        .get("prospect_id")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .ok_or_else(|| AppError::conflict("request key belongs to another operation"))?;
    let p = r
        .prospects()
        .get(id)
        .await?
        .ok_or_else(|| AppError::not_found("the prospect this request recorded is gone"))?;
    let policy = leads_policy(r).await?;
    let soft: Vec<Key> = derive_keys(&p)
        .into_iter()
        .filter(|k| !k.kind.hard())
        .collect();
    let flags = dedupe::flags(r, &soft, Some(p.id), &p.origin.distinct_from).await?;
    Ok(Some(ProspectOut {
        prospect: with_purge_after(p, &policy.prospects),
        flags,
    }))
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

/// `VALIDATION {field: icp_key, reason}` for a purpose the pool does not record.
fn bad_purpose(reason: &'static str) -> AppError {
    invalid_from(ProspectError::Invalid {
        field: "icp_key",
        reason,
    })
}

/// The purpose (`icp_key`) a write records: the research task's ICP entry when the task names
/// one (`given`, if any, must be that entry: `not_the_tasks_entry`), else `given`, which must be
/// an entry of the approved strategy's ICP (`unknown_icp_entry`; `invalid` when it is no key).
async fn purpose(
    r: &mut dyn TenantRepos,
    task: Option<&ResearchTask>,
    given: Option<String>,
) -> Result<Option<String>, AppError> {
    let given = given.map(|k| k.trim().to_owned());
    if let Some(entry) = task.and_then(|t| t.kind.icp_key()) {
        return match given {
            Some(k) if k != entry => Err(bad_purpose("not_the_tasks_entry")),
            _ => Ok(Some(entry.to_owned())),
        };
    }
    let Some(key) = given else {
        return Ok(None);
    };
    if jt_strategy::validate_segment_key(&key).is_err() {
        return Err(bad_purpose("invalid"));
    }
    let known = r
        .strategy()
        .current_approved()
        .await?
        .is_some_and(|v| v.sections.prospecting.icp.iter().any(|e| e.key == key));
    if known {
        Ok(Some(key))
    } else {
        Err(bad_purpose("unknown_icp_entry"))
    }
}

/// `jeeta.prospects.create`: records one business. The recorder is the caller; the checks run in
/// spec §3.3's order under the pool lock; a request key replays the prospect it recorded, read
/// again, for 24 hours (a create racing with the same key replays once the first commits). The
/// prospect's purpose is its research task's ICP entry, else the `icp_key` given, which must be
/// an entry of the approved ICP.
pub async fn create(
    deps: &Deps,
    ctx: &Ctx,
    mut input: CreateInput,
) -> Result<ProspectOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let recorder = recorder(ctx)?;
    jt_prospects::validate_create(&input, ctx.now, &recorder).map_err(invalid_from)?;
    let mut r = bundle(deps, ctx).await?;
    let key = input
        .request_key
        .as_deref()
        .map(|k| format!("{REQUEST_KEY_PREFIX}{}", k.trim()));
    if let Some(key) = &key
        && let Some(out) = replay(r.as_mut(), key, ctx.now).await?
    {
        return Ok(out);
    }
    r.prospects().lock_pool().await?;
    // Again under the lock: a create with the same key may have committed while this one waited.
    if let Some(key) = &key
        && let Some(out) = replay(r.as_mut(), key, ctx.now).await?
    {
        return Ok(out);
    }
    let policy = leads_policy(r.as_mut()).await?;
    // The task row is held to the end: an ad-hoc task closes when this one reaches its target.
    let task = match input.research_task_id {
        None => None,
        Some(id) => {
            let t = r
                .research_tasks()
                .lock(id)
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
            Some(t)
        }
    };
    input.icp_key = purpose(r.as_mut(), task.as_ref(), input.icp_key.take()).await?;
    check_caps(
        r.as_mut(),
        &policy.timezone,
        task.as_ref().map(|t| (t.id, t.daily_cap)),
        ctx.now,
    )
    .await?;
    let p = jt_prospects::build(
        input,
        ProspectId::from(deps.ids.uuid()),
        ctx.workspace_id,
        ctx.now,
        recorder,
    );
    let keys = derive_keys(&p);
    let flags = dedupe::check(
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
    if let Some(t) = &task {
        crate::usecases::research::close_if_found(r.as_mut(), ctx, t).await?;
    }
    // The request key holds the id only: no contact value outlives the row in it.
    if let Some(key) = &key
        && !r
            .request_keys()
            .store(key, json!({ "prospect_id": p.id }), ctx.now)
            .await?
    {
        return Err(AppError::conflict("request key changed while recording"));
    }
    r.commit().await?;
    Ok(ProspectOut {
        prospect: with_purge_after(p, &policy.prospects),
        flags,
    })
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

/// What `prospects.check` answers: `ok` with the soft-key flags `create` would report, or the
/// refusal `create` would meet (its `reason` and details), never a hash.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct CheckOut {
    pub ok: bool,
    #[serde(flatten)]
    pub refusal: Value,
    pub flags: Vec<Flag>,
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
            if let Some(handle) = website_handle(kind, raw) {
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
        Ok(flags) => Ok(CheckOut {
            ok: true,
            refusal: json!({}),
            flags,
        }),
        Err(e) if e.details.get("reason").is_some() => Ok(CheckOut {
            ok: false,
            refusal: e.details,
            flags: Vec::new(),
        }),
        Err(e) => Err(e),
    }
}

/// `jeeta.prospects.update`: sets and clears fields of a `new`, `qualified` or `rejected`
/// prospect at a known revision, each set field with new evidence; the checks run again for the
/// keys the edit adds. A purpose set must be an entry of the approved strategy's ICP.
pub async fn update(
    deps: &Deps,
    ctx: &Ctx,
    id: ProspectId,
    mut input: UpdateInput,
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
    if let Some(given) = input.set.icp_key.take() {
        input.set.icp_key = purpose(r.as_mut(), None, Some(given)).await?;
    }
    let before = derive_keys(&p);
    let changed =
        jt_prospects::apply_update(&mut p, input, ctx.now, recorder).map_err(invalid_from)?;
    let policy = leads_policy(r.as_mut()).await?;
    let keys = derive_keys(&p);
    let added: Vec<Key> = keys
        .iter()
        .filter(|k| !before.contains(k))
        .cloned()
        .collect();
    let flags = if added.is_empty() {
        Vec::new()
    } else {
        dedupe::check(
            deps,
            ctx,
            r.as_mut(),
            &added,
            &p.origin.distinct_from,
            Some(p.id),
            ctx.now,
        )
        .await?
    };
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
    Ok(ProspectOut {
        prospect: with_purge_after(p, &policy.prospects),
        flags,
    })
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
    /// The ICP entry the prospects were sought for (their purpose).
    #[serde(default)]
    pub icp_key: Option<String>,
    /// `1..=200`, 50 unless given.
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub before_at: Option<String>,
    #[serde(default)]
    pub before_id: Option<Uuid>,
    /// Also answer [`PoolCounts`]: how many prospects each value of every filter holds.
    #[serde(default)]
    pub counts: bool,
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
    /// With `counts`: the pool's classes and how full each is.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub counts: Option<PoolCounts>,
}

/// One value of a filter and how many prospects hold it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CountOut {
    /// The status key, segment, ICP entry, bucket key, city or task id; `None`: the prospects
    /// without one.
    pub key: Option<String>,
    pub count: u32,
}

/// How many prospects each value of every list filter holds, each filter counted under all the
/// others (its own choice never narrows its counts), cursor aside. Largest first, then by key, the
/// prospects without a value last.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct PoolCounts {
    /// The prospects every filter selects: what the pages hold together.
    pub total: u32,
    pub status: Vec<CountOut>,
    pub segment_key: Vec<CountOut>,
    pub icp_key: Vec<CountOut>,
    pub bucket: Vec<CountOut>,
    pub city: Vec<CountOut>,
    pub research_task_id: Vec<CountOut>,
}

/// [`PoolCounts`] of the prospects `q` selects.
async fn counts_of(r: &mut dyn TenantRepos, q: &ProspectQuery) -> Result<PoolCounts, AppError> {
    let mut out = PoolCounts::default();
    for &by in CountBy::ALL {
        let mut rows = r.prospects().count_by(&by.others(q), by).await?;
        rows.sort_by(|a, b| {
            b.1.cmp(&a.1)
                .then_with(|| a.0.is_none().cmp(&b.0.is_none()))
                .then_with(|| a.0.cmp(&b.0))
        });
        let rows: Vec<CountOut> = rows
            .into_iter()
            .map(|(key, count)| CountOut { key, count })
            .collect();
        match by {
            CountBy::Status => {
                out.total = rows
                    .iter()
                    .filter(|c| q.status.is_none_or(|s| c.key.as_deref() == Some(s.key())))
                    .map(|c| c.count)
                    .sum();
                out.status = rows;
            }
            CountBy::Segment => out.segment_key = rows,
            CountBy::Purpose => out.icp_key = rows,
            CountBy::Bucket => out.bucket = rows,
            CountBy::City => out.city = rows,
            CountBy::Task => out.research_task_id = rows,
        }
    }
    Ok(out)
}

/// `jeeta.prospects.list`; with `counts`, also how many prospects each filter value holds.
pub async fn list(deps: &Deps, ctx: &Ctx, input: ListInput) -> Result<ListOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let limit = input.limit.unwrap_or(50);
    if !(1..=MAX_PROSPECT_PAGE).contains(&limit) {
        return Err(invalid("limit", "limit is 1..=200"));
    }
    let after = keyset_cursor(input.before_at.as_deref(), input.before_id)?
        .map(|(created_at, id)| ListCursor { created_at, id });
    let mut r = bundle(deps, ctx).await?;
    let policy = leads_policy(r.as_mut()).await?;
    let query = ProspectQuery {
        status: input.status,
        research_task_id: input.research_task_id,
        city: input.city.map(|c| c.trim().to_owned()),
        segment_key: input.segment_key,
        bucket: input.bucket,
        icp_key: input.icp_key.map(|k| k.trim().to_owned()),
        limit,
        after,
    };
    let mut page = r.prospects().list(&query).await?;
    for row in &mut page.items {
        row.purge_after = purge_after(
            &policy.prospects,
            row.status,
            row.decided_at,
            row.updated_at,
        );
    }
    let counts = if input.counts {
        Some(counts_of(r.as_mut(), &query).await?)
    } else {
        None
    };
    Ok(ListOut {
        items: page.items,
        next: page.next.map(|c| NextPage {
            before_at: c.created_at.format(&Rfc3339).unwrap_or_default(),
            before_id: c.id,
        }),
        counts,
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
    /// The research task it was recorded for (its brief, kind and ICP entry, who made it and
    /// when), while that task is stored.
    pub research_task: Option<ResearchTask>,
    /// The rubric its latest score was computed under (its criteria with their descriptions and
    /// weights, and the score that qualifies), while that strategy version is stored.
    pub scored_under: Option<Rubric>,
}

/// `jeeta.prospects.get`: the prospect with its evidence, its latest scores and the rubric the
/// latest was computed under, the research task it came from, the prospects it may duplicate and
/// its ledger history.
pub async fn get(deps: &Deps, ctx: &Ctx, id: ProspectId) -> Result<GetOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    let mut r = bundle(deps, ctx).await?;
    let policy = leads_policy(r.as_mut()).await?;
    let prospect = r.prospects().get(id).await?.ok_or_else(no_such_prospect)?;
    let prospect = with_purge_after(prospect, &policy.prospects);
    let scores = r.prospects().scores(id, GET_SCORES).await?;
    let research_task = match prospect.research_task_id {
        Some(task) => r.research_tasks().get(task).await?,
        None => None,
    };
    let scored_under = match scores.first().and_then(|s| s.strategy_version_id) {
        Some(version) => r
            .strategy()
            .find(version)
            .await?
            .map(|v| v.sections.prospecting.rubric),
        None => None,
    };
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
        research_task,
        scored_under,
    })
}
