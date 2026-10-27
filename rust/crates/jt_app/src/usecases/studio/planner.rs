//! Hourly materialization of fixed calendar positions. No provider I/O or agent wake-up.
use super::chain::{active, capability_access};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{CapabilityFilter, studio::SlotQuery},
    usecases::{Deps, ledger_entry},
};
use jt_ledger::Actor;
use jt_strategy::LaneKind;
use jt_studio::*;
use jt_tenancy::WorkspaceId;
use serde_json::json;
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

pub(crate) fn stable_id(ws: WorkspaceId, key: &str) -> Uuid {
    let mut hash = Sha256::new();
    hash.update(ws.0.as_bytes());
    hash.update(key.as_bytes());
    let bytes = hash.finalize();
    let mut id = [0; 16];
    id.copy_from_slice(&bytes[..16]);
    id[6] = (id[6] & 15) | 0x80;
    id[8] = (id[8] & 63) | 0x80;
    Uuid::from_bytes(id)
}
fn position_key(h: jt_strategy::HypothesisId, l: LaneKind, week: OffsetDateTime, n: u16) -> String {
    format!("studio.plan:{h}:{l:?}:{}:{n}", week.unix_timestamp())
}
pub(crate) fn validation(e: StudioError) -> AppError {
    AppError::validation(
        e.to_string(),
        json!({"field":"cadence","reason":e.to_string()}),
    )
}
/// Samples Beta using two independent Gamma draws (Marsaglia–Tsang); no editable prior or
/// trend contributes pseudocounts. Rejection sampling is confined to this application boundary.
fn gamma(shape: f64) -> f64 {
    if shape < 1.0 {
        return gamma(shape + 1.0) * uniform().powf(1.0 / shape);
    }
    let d = shape - 1.0 / 3.0;
    let c = (9.0 * d).sqrt().recip();
    loop {
        let x = (-2.0 * uniform().ln()).sqrt() * (std::f64::consts::TAU * uniform()).cos();
        let v = 1.0 + c * x;
        if v <= 0.0 {
            continue;
        }
        let v = v * v * v;
        let u = uniform();
        if u < 1.0 - 0.0331 * x.powi(4) || u.ln() < 0.5 * x * x + d * (1.0 - v + v.ln()) {
            return d * v;
        }
    }
}
fn uniform() -> f64 {
    loop {
        let u = rand::random::<f64>();
        if u > 0.0 {
            return u;
        }
    }
}
fn beta(a: &Arm) -> f64 {
    let x = gamma(a.alpha);
    let y = gamma(a.beta);
    x / (x + y)
}

pub async fn plan(d: &Deps, ws: WorkspaceId, now: OffsetDateTime) -> Result<u64, AppError> {
    let mut r = d.uow.tenant(ws).await?;
    let frame = r.strategy().lock_execution_frame().await?;
    active(r.as_mut()).await?;
    let control = r.studio_control().lock_control().await?;
    let start = istanbul_week_start(now);
    let ctx = Ctx {
        workspace_id: ws,
        actor: Actor::System {
            component: "scheduler:studio_plan".into(),
        },
        permissions: Default::default(),
        role_key: None,
        now,
        agent_connection_id: None,
    };
    let slots = r
        .studio()
        .list_slots(SlotQuery {
            from: time::Date::MIN.midnight().assume_utc(),
            until: start + Duration::days(14),
            hypothesis_id: None,
            lane: None,
        })
        .await?;
    for s in slots
        .iter()
        .filter(|s| s.state == SlotState::Planned && s.scheduled_at < start)
    {
        r.studio()
            .retire_slot(s.id, s.revision, "week_ended")
            .await?;
        let mut e = ledger_entry(
            &ctx,
            "studio.slot.week_ended",
            "studio_slot",
            s.id,
            json!({"born_version_id":s.chain.born_version_id,"reason":"week_ended"}),
        )?;
        e.strategy_version_id = frame.as_ref().map(|v| v.id.0);
        r.ledger().append(e).await?;
    }
    let Some(frame) = frame else {
        r.commit().await?;
        return Ok(0);
    };
    let hypotheses = r.hypotheses().list(frame.id).await?;
    let groups = r.capability_groups().list().await?;
    let caps = r.capabilities().list(CapabilityFilter::default()).await?;
    let mut accounts = Vec::new();
    for c in &caps {
        if capability_access(c, now, true).is_err() {
            continue;
        }
        let Some(provider) = jt_connector::provider_for_kind(&c.kind_key) else {
            continue;
        };
        let lane = if c.kind_key == "meta_ads" && d.connectors.ads(provider).is_some() {
            LaneKind::Paid
        } else if super::chain::ORGANIC_KINDS.contains(&c.kind_key.as_str())
            && d.connectors.publisher(provider).is_some()
        {
            LaneKind::Organic
        } else {
            continue;
        };
        if control.is_braked(lane) {
            continue;
        }
        accounts.push(PlanningAccount {
            capability_id: c.id,
            channel: c.kind_key.clone(),
            lane,
            group_ids: groups
                .iter()
                .filter(|(_, ids)| ids.contains(&c.id))
                .map(|(g, _)| g.id.0)
                .collect(),
        });
    }
    let mut lanes = Vec::new();
    for h in hypotheses.iter().filter(|h| h.state.is_live()) {
        for (&lane, cadence) in &h.cadence {
            integer_quotas(cadence).map_err(validation)?;
            if control.is_braked(lane) || (lane == LaneKind::Paid && !frame.sections.paid_enabled) {
                continue;
            }
            lanes.push(PlanningLane {
                hypothesis_id: h.id,
                lane,
                channel: h.channel.clone(),
                cadence: cadence.clone(),
            });
            for a in accounts.iter().filter(|a| {
                a.lane == lane
                    && (h.channel == "any" || a.channel == h.channel)
                    && frame.sections.channels.iter().any(|s| {
                        (s.channel == "any" || s.channel == a.channel)
                            && s.group_id.is_none_or(|g| a.group_ids.contains(&g))
                    })
            }) {
                for t in cadence.content_types.iter().filter(|t| t.max_bps > 0) {
                    r.studio()
                        .insert_arm(
                            Arm::new(
                                ArmId(d.ids.uuid()),
                                ws,
                                ArmKey {
                                    hypothesis_id: h.id,
                                    content_type: t.key.clone(),
                                    channel: a.channel.clone(),
                                    lane,
                                },
                            )
                            .map_err(validation)?,
                        )
                        .await?;
                }
            }
        }
    }
    let arms = r.studio().list_arms().await?;
    let mut existing = Vec::new();
    let by_id: std::collections::BTreeMap<_, _> = slots.iter().map(|s| (s.id, s)).collect();
    for l in &lanes {
        for week in [start, start + Duration::days(7)] {
            for n in 0..l.cadence.slots_per_week {
                if let Some(s) = by_id.get(&SlotId(stable_id(
                    ws,
                    &position_key(l.hypothesis_id, l.lane, week, n),
                ))) {
                    existing.push(ExistingPosition {
                        hypothesis_id: l.hypothesis_id,
                        lane: l.lane,
                        week_start: week,
                        ordinal: n,
                        arm_id: s.chain.arm_id,
                    });
                }
            }
        }
    }
    let positions: usize = lanes
        .iter()
        .map(|l| usize::from(l.cadence.slots_per_week) * 2)
        .sum();
    let mut draws = Vec::with_capacity(positions * (arms.len() + 2));
    for _ in 0..positions {
        for arm in &arms {
            draws.push(beta(arm));
        }
        draws.extend([uniform(), uniform()]);
    }
    let planned = plan_week(
        &PlanningInput {
            now,
            lanes,
            selected_channels: frame.sections.channels.clone(),
            paid_enabled: frame.sections.paid_enabled,
            accounts,
            arms: arms.clone(),
            existing,
            trends: vec![],
        },
        &draws,
    )
    .map_err(validation)?;
    let count = planned.len() as u64;
    for p in planned {
        let a = arms.iter().find(|a| a.id == p.arm_id).expect("planned arm");
        let key = position_key(
            a.key.hypothesis_id,
            a.key.lane,
            istanbul_week_start(p.scheduled_at),
            p.ordinal,
        );
        let slot = Slot {
            id: SlotId(stable_id(ws, &key)),
            chain: Chain {
                workspace_id: ws,
                born_version_id: frame.id,
                hypothesis_id: a.key.hypothesis_id,
                arm_id: a.id,
            },
            capability_id: p.capability_id,
            scheduled_at: p.scheduled_at,
            state: SlotState::Planned,
            revision: 0,
        };
        r.studio().insert_slots(&key, vec![slot.clone()]).await?;
        let mut e = ledger_entry(
            &ctx,
            "studio.slot.planned",
            "studio_slot",
            slot.id,
            json!({"born_version_id":frame.id,"executed_version_id":frame.id,"hypothesis_id":a.key.hypothesis_id,"arm_id":a.id,"scheduled_at":p.scheduled_at,"ordinal":p.ordinal}),
        )?;
        e.strategy_version_id = Some(frame.id.0);
        r.ledger().append(e).await?;
    }
    r.commit().await?;
    Ok(count)
}
