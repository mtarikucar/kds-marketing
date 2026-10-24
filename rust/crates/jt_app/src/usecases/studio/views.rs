//! Shared five-region projection and a tenant-scoped, redacted ledger export.
use super::{chain, learning, work};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        CapabilityFilter, LedgerFilter, TenantRepos,
        studio::{ApprovalTarget, SlotQuery},
    },
    usecases::{Deps, ledger::LedgerEntryOut},
};
use jt_strategy::{Goals, Hypothesis, HypothesisId, LaneKind, StrategyVersion};
use jt_studio::{AdSetBinding, Chain, Slot, StudioControl};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use time::OffsetDateTime;

pub type StudioQuery = learning::LearnedQuery;
#[derive(Clone, Debug, Serialize)]
pub struct LaneAvailability {
    pub visible: bool,
    pub supported: bool,
    pub reason: Option<String>,
}
#[derive(Clone, Debug, Serialize)]
pub struct LaneSupport {
    pub organic: LaneAvailability,
    pub paid: LaneAvailability,
}
#[derive(Clone, Debug, Serialize)]
pub struct StudioOverview {
    pub strategy: StrategyVersion,
    pub goals: Goals,
    pub hypotheses: Vec<Hypothesis>,
    pub control: StudioControl,
    pub lane_support: LaneSupport,
    pub slots: Vec<Slot>,
    pub today: work::PendingStudioOut,
    pub learned: learning::LearnedOut,
    pub bindings: Vec<AdSetBinding>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudioLedgerQuery {
    pub hypothesis_id: Option<HypothesisId>,
    pub lane: Option<LaneKind>,
    #[serde(with = "time::serde::rfc3339")]
    pub from: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub until: OffsetDateTime,
    pub before: Option<i64>,
    #[serde(default = "default_limit")]
    pub limit: u32,
}
fn default_limit() -> u32 {
    50
}
#[derive(Clone, Debug, Serialize)]
pub struct StudioLedgerPage {
    pub entries: Vec<LedgerEntryOut>,
    pub next_before: Option<i64>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StudioLedgerExportInput {
    pub filter: StudioLedgerQuery,
}
#[derive(Clone, Debug, Serialize)]
pub struct LedgerExportOut {
    pub filename: String,
    pub media_type: String,
    pub content: String,
}
fn window(from: OffsetDateTime, until: OffsetDateTime) -> Result<(), AppError> {
    if from >= until {
        return Err(AppError::validation(
            "invalid result window",
            json!({"field":"until"}),
        ));
    }
    Ok(())
}
pub async fn overview(d: &Deps, ctx: &Ctx, q: StudioQuery) -> Result<StudioOverview, AppError> {
    ctx.require(Permission::StudioWork)?;
    window(q.from, q.until)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    let strategy = work::gated(r.as_mut(), ctx).await?;
    let hypotheses = r
        .hypotheses()
        .list(strategy.id)
        .await?
        .into_iter()
        .filter(|h| q.hypothesis_id.is_none_or(|id| id == h.id))
        .collect();
    let control = r.studio_control().lock_control().await?;
    let caps = r.capabilities().list(CapabilityFilter::default()).await?;
    let groups = r.capability_groups().list().await?;
    let selected = |c: &jt_capability::Capability| {
        strategy.sections.channels.iter().any(|ch| {
            (ch.channel == c.kind_key || ch.channel == "any")
                && ch.group_id.is_none_or(|id| {
                    groups
                        .iter()
                        .any(|(g, ids)| g.id.0 == id && ids.contains(&c.id))
                })
        })
    };
    let paid = strategy.sections.paid_enabled
        && caps.iter().any(|c| {
            c.kind_key == "meta_ads"
                && c.external_id.is_some()
                && c.has_sealed_config
                && selected(c)
                && chain::capability_access(c, ctx.now, false).is_ok()
        });
    let organic = caps.iter().any(|c| {
        matches!(c.kind_key.as_str(), "x" | "instagram" | "facebook_page")
            && selected(c)
            && chain::capability_access(c, ctx.now, false).is_ok()
            && jt_connector::provider_for_kind(&c.kind_key)
                .is_some_and(|p| d.connectors.publisher(p).is_some())
    });
    let lane_support = LaneSupport {
        organic: LaneAvailability {
            visible: true,
            supported: organic,
            reason: (!organic).then(|| "connector_unavailable".into()),
        },
        paid: LaneAvailability {
            visible: paid,
            supported: paid,
            reason: (!paid).then(|| "paid_lane_unavailable".into()),
        },
    };
    let slots = r
        .studio()
        .list_slots(SlotQuery {
            from: q.from,
            until: q.until,
            hypothesis_id: q.hypothesis_id,
            lane: q.lane,
        })
        .await?;
    let arms = r.studio().list_arms().await?;
    let matches = |c: &Chain| {
        q.hypothesis_id.is_none_or(|h| h == c.hypothesis_id)
            && q.lane
                .is_none_or(|l| arms.iter().any(|a| a.id == c.arm_id && a.key.lane == l))
    };
    let bindings: Vec<_> = r
        .studio()
        .list_bindings()
        .await?
        .into_iter()
        .filter(|b| matches(&b.chain))
        .collect();
    let mut today = work::pending_in(r.as_mut(), ctx).await?;
    today.slots.retain(|s| {
        matches(&s.slot.chain) && s.slot.scheduled_at >= q.from && s.slot.scheduled_at < q.until
    });
    today.budget_moves = r
        .studio()
        .list_budget_moves()
        .await?
        .into_iter()
        .filter(|m| matches(&m.chain))
        .collect();
    let slot_ids: BTreeSet<_> = slots.iter().map(|s| s.id).collect();
    let move_ids: BTreeSet<_> = today.budget_moves.iter().map(|m| m.id).collect();
    let target_matches = |t: &ApprovalTarget| match t {
        ApprovalTarget::Slot(id) => slot_ids.contains(id),
        ApprovalTarget::BudgetMove(id) => move_ids.contains(id),
    };
    today.approvals.retain(&target_matches);
    today.blockers.retain(|b| target_matches(&b.target));
    today
        .paid_alerts
        .retain(|a| bindings.iter().any(|b| json!(b.id) == a["binding_id"]));
    // Release the tenant bundle before entering another shared service (the fake serializes it).
    drop(r);
    let learned = learning::learned(d, ctx, q).await?;
    Ok(StudioOverview {
        goals: strategy.sections.goals.clone(),
        strategy,
        hypotheses,
        control,
        lane_support,
        slots,
        today,
        learned,
        bindings,
    })
}

/// Resolve targets from durable tenant records, including historical records after retirement.
async fn targets(
    r: &mut dyn TenantRepos,
) -> Result<BTreeMap<String, (HypothesisId, LaneKind)>, AppError> {
    let arms = r.studio().list_arms().await?;
    let mut out = BTreeMap::new();
    let mut add = |id: String, c: &Chain| {
        if let Some(a) = arms.iter().find(|a| a.id == c.arm_id) {
            out.insert(id, (c.hypothesis_id, a.key.lane));
        }
    };
    for s in r
        .studio()
        .list_slots(SlotQuery {
            from: time::Date::MIN.midnight().assume_utc(),
            until: time::Date::MAX.midnight().assume_utc(),
            hypothesis_id: None,
            lane: None,
        })
        .await?
    {
        add(s.id.to_string(), &s.chain);
    }
    for b in r.studio().list_bindings().await? {
        add(b.id.to_string(), &b.chain);
    }
    for m in r.studio().list_budget_moves().await? {
        add(m.id.to_string(), &m.chain);
    }
    for p in r.studio().list_publications().await? {
        add(p.id.to_string(), &p.chain);
    }
    for m in r.studio().list_measurements().await? {
        add(m.id.to_string(), &m.chain);
    }
    for a in arms {
        out.insert(a.id.to_string(), (a.key.hypothesis_id, a.key.lane));
    }
    Ok(out)
}
fn matching_payload(
    v: &Value,
    q: &StudioLedgerQuery,
    targets: &BTreeMap<String, (HypothesisId, LaneKind)>,
) -> bool {
    match v {
        Value::Object(m) => {
            let h = m
                .get("hypothesis_id")
                .and_then(Value::as_str)
                .and_then(|s| s.parse::<uuid::Uuid>().ok())
                .map(HypothesisId);
            let lane = m
                .get("lane")
                .and_then(Value::as_str)
                .and_then(LaneKind::parse);
            if h.is_some()
                && q.hypothesis_id.is_none_or(|want| Some(want) == h)
                && q.lane.is_none_or(|want| Some(want) == lane)
            {
                return true;
            }
            m.iter().any(|(key, value)| {
                let reference = matches!(
                    key.as_str(),
                    "slot"
                        | "slot_id"
                        | "arm_id"
                        | "binding_id"
                        | "budget_move"
                        | "move_id"
                        | "publication_id"
                        | "measurement_id"
                );
                (reference
                    && value
                        .as_str()
                        .and_then(|id| targets.get(id))
                        .is_some_and(|(h, l)| {
                            q.hypothesis_id.is_none_or(|want| want == *h)
                                && q.lane.is_none_or(|want| want == *l)
                        }))
                    || matching_payload(value, q, targets)
            })
        }
        Value::Array(a) => a.iter().any(|v| matching_payload(v, q, targets)),
        _ => false,
    }
}
fn redact_transport(v: &mut Value) {
    match v {
        Value::Object(m) => {
            for (key, value) in m.iter_mut() {
                let k = key.to_ascii_lowercase();
                if k.contains("url")
                    || matches!(
                        k.as_str(),
                        "bytes"
                            | "data"
                            | "credential"
                            | "credentials"
                            | "sealed"
                            | "content"
                            | "body"
                    )
                {
                    *value = json!("[redacted]");
                } else {
                    redact_transport(value);
                }
            }
        }
        Value::Array(a) => a.iter_mut().for_each(redact_transport),
        Value::String(s) if s.contains("https://") || s.contains("http://") => {
            *s = "[redacted URL]".into()
        }
        _ => {}
    }
}
pub async fn ledger(
    d: &Deps,
    ctx: &Ctx,
    q: StudioLedgerQuery,
) -> Result<StudioLedgerPage, AppError> {
    ctx.require(Permission::StudioWork)?;
    window(q.from, q.until)?;
    if !(1..=500).contains(&q.limit) || q.before.is_some_and(|b| b <= 0) {
        return Err(AppError::validation(
            "invalid ledger page",
            json!({"field":"limit"}),
        ));
    }
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    chain::active(r.as_mut()).await?;
    let targets = if q.hypothesis_id.is_some() || q.lane.is_some() {
        targets(r.as_mut()).await?
    } else {
        BTreeMap::new()
    };
    let mut entries = Vec::new();
    let mut before = q.before;
    loop {
        let page = r
            .ledger()
            .list(LedgerFilter {
                action_prefix: Some("studio.".into()),
                actor_kind: None,
                agent_connection_id: None,
                limit: 500,
                before_id: before,
            })
            .await?;
        if page.is_empty() {
            return Ok(StudioLedgerPage {
                entries,
                next_before: None,
            });
        }
        for row in page {
            before = Some(row.id);
            let e = &row.entry;
            if e.at < q.from || e.at >= q.until {
                continue;
            }
            if q.hypothesis_id.is_some() || q.lane.is_some() {
                let global = matches!(e.action.as_str(), "studio.brake" | "studio.policy_set")
                    && e.payload
                        .get("lane")
                        .and_then(Value::as_str)
                        .is_none_or(|l| q.lane.is_none_or(|want| want.key() == l));
                let subject = e
                    .subject
                    .as_ref()
                    .and_then(|s| targets.get(&s.id))
                    .is_some_and(|(h, l)| {
                        q.hypothesis_id.is_none_or(|want| want == *h)
                            && q.lane.is_none_or(|want| want == *l)
                    });
                if !global && !subject && !matching_payload(&e.payload, &q, &targets) {
                    continue;
                }
            }
            let mut entry = e.redacted();
            redact_transport(&mut entry.payload);
            entries.push(LedgerEntryOut { id: row.id, entry });
            if entries.len() == q.limit as usize {
                return Ok(StudioLedgerPage {
                    entries,
                    next_before: before,
                });
            }
        }
    }
}
fn csv_cell(value: &str) -> String {
    let dangerous = value.starts_with(['\t', '\r', '\n'])
        || value.trim_start().starts_with(['=', '+', '-', '@']);
    format!(
        "\"{}{}\"",
        if dangerous { "'" } else { "" },
        value.replace('"', "\"\"")
    )
}
pub async fn ledger_export(
    d: &Deps,
    ctx: &Ctx,
    input: StudioLedgerExportInput,
) -> Result<LedgerExportOut, AppError> {
    let mut q = input.filter;
    let mut content = "id,time,actor,action,target,version,evidence\r\n".to_owned();
    loop {
        let page = ledger(d, ctx, q.clone()).await?;
        for row in page.entries {
            let e = row.entry;
            let cells = [
                row.id.to_string(),
                e.at.format(&time::format_description::well_known::Rfc3339)
                    .map_err(|_| AppError::internal("timestamp"))?,
                serde_json::to_string(&e.actor)?,
                e.action.as_str().into(),
                e.subject.map(|s| s.id).unwrap_or_default(),
                e.strategy_version_id
                    .map(|v| v.to_string())
                    .unwrap_or_default(),
                serde_json::to_string(&e.payload)?,
            ];
            content.push_str(
                &cells
                    .iter()
                    .map(|c| csv_cell(c))
                    .collect::<Vec<_>>()
                    .join(","),
            );
            content.push_str("\r\n");
        }
        match page.next_before {
            Some(before) => q.before = Some(before),
            None => break,
        }
    }
    Ok(LedgerExportOut {
        filename: "studio-ledger.csv".into(),
        media_type: "text/csv; charset=utf-8".into(),
        content,
    })
}
