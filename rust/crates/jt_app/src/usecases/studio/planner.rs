//! The planner, `studio_plan` (every 10 minutes; spec 2026-11-03 §14). It never creates a post:
//! agents propose packages and `studio.posts_propose` materializes them.
//!
//! Each run, in one tenant transaction under the execution frame and the Studio control lock:
//! - once per workspace, retires every organic slot of the weekly quotas still planned or ready
//!   with no planned post (`replanned`, D34), one ledger entry each, its evidence kept;
//! - retires each planned post not sent by the end of its grace (`missed_grace`, D28, D46);
//! - expires the package requests nobody answered within seven days;
//! - with an approved strategy, keeps the paid lane's weekly positions as they were (D13, D33);
//! - unless the organic lane is braked, runs the three triggers that ask agents for packages,
//!   for the channels a live hypothesis can post on: an olay's new eligible materials, 30 minutes
//!   after their last change (D24); an occasion within its lead (D25); a channel without a feed
//!   post for `floor_days` (D26). With nothing eligible, the calendar and floor triggers add a
//!   çekim listesi item instead; the system's items close themselves once their condition holds.
//!
//! No provider I/O or agent wake-up.
use super::chain::{active, capability_access};
use super::posts::{self as post_rules, Channel};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        CapabilityFilter, TenantRepos,
        materials::{ShootReason, ShootRequest, ShootRequestId, ShootStatus},
        posts::{PackageHints, PackageRequest, PackageRequestId, PackageStatus, PackageTrigger},
        studio::SlotQuery,
    },
    usecases::{Deps, ledger_entry},
};
use jt_ledger::Actor;
use jt_strategy::{LaneKind, StrategyVersion};
use jt_studio::*;
use jt_tenancy::WorkspaceId;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
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

/// The replay action and key of the one-time retirement of the weekly quotas' slots (D34).
const REPLAN_ACTION: &str = "studio.replan";
const REPLAN_KEY: &str = "d34";

/// How far ahead the planner reads slots: past any post's horizon.
const SLOT_HORIZON: Duration = Duration::days(366);

/// One run of the planner for workspace `ws` at `now` (see the module docs): how many records it
/// wrote (slots and posts retired, requests opened or expired, çekim listesi items opened or
/// closed, paid positions planned).
pub async fn plan(d: &Deps, ws: WorkspaceId, now: OffsetDateTime) -> Result<u64, AppError> {
    let mut r = d.uow.tenant(ws).await?;
    let frame = r.strategy().lock_execution_frame().await?;
    active(r.as_mut()).await?;
    let control = r.studio_control().lock_control().await?;
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
    let version = frame.as_ref().map(|v| v.id.0);
    let mut changed = 0u64;
    let slots = r
        .studio()
        .list_slots(SlotQuery {
            from: time::Date::MIN.midnight().assume_utc(),
            until: now + SLOT_HORIZON,
            hypothesis_id: None,
            lane: None,
        })
        .await?;
    let posts = r.studio_posts().list_posts().await?;
    let with_post: BTreeSet<SlotId> = posts.iter().map(|p| p.slot_id).collect();
    let arms = r.studio().list_arms().await?;
    let lane_of = |s: &Slot| {
        arms.iter()
            .find(|a| a.id == s.chain.arm_id)
            .map(|a| a.key.lane)
    };
    let mut retired: BTreeSet<SlotId> = BTreeSet::new();

    // D34: the weekly quotas' organic slots retire once, their pieces and evidence kept.
    if r.studio()
        .request_replay(REPLAN_ACTION, REPLAN_KEY, &json!({"rule": REPLAN_KEY}))
        .await?
        .is_none()
    {
        let mut n = 0u64;
        for s in slots.iter().filter(|s| {
            matches!(s.state, SlotState::Planned | SlotState::Ready)
                && !with_post.contains(&s.id)
                && lane_of(s) == Some(LaneKind::Organic)
        }) {
            let next = r
                .studio()
                .retire_slot(s.id, s.revision, RetirementReason::Replanned.code())
                .await?;
            let mut e = ledger_entry(
                &ctx,
                "studio.slot.replanned",
                "studio_slot",
                s.id,
                json!({"reason": RetirementReason::Replanned.code(),
                    "born_version_id": s.chain.born_version_id, "state": s.state,
                    "revision": next.revision}),
            )?;
            e.strategy_version_id = version;
            r.ledger().append(e).await?;
            retired.insert(s.id);
            n += 1;
        }
        r.studio()
            .request_receipt(
                REPLAN_ACTION,
                REPLAN_KEY,
                &json!({"rule": REPLAN_KEY}),
                &json!({"retired": n}),
            )
            .await?;
        changed += n;
    }

    // A planned position of the weekly lanes that passed its week without a piece (the paid
    // lane's, or a slot stored without a post): posts retire by their grace instead.
    let start = istanbul_week_start(now);
    let ended: Vec<&Slot> = slots
        .iter()
        .filter(|s| {
            s.state == SlotState::Planned
                && s.scheduled_at < start
                && !with_post.contains(&s.id)
                && !retired.contains(&s.id)
        })
        .collect();
    for s in ended {
        r.studio()
            .retire_slot(s.id, s.revision, RetirementReason::WeekEnded.code())
            .await?;
        let mut e = ledger_entry(
            &ctx,
            "studio.slot.week_ended",
            "studio_slot",
            s.id,
            json!({"born_version_id":s.chain.born_version_id,"reason":"week_ended"}),
        )?;
        e.strategy_version_id = version;
        r.ledger().append(e).await?;
        retired.insert(s.id);
        changed += 1;
    }

    // D28: a post not sent by the end of its grace is retired, and the weekly summary names it.
    let by_id: BTreeMap<SlotId, &Slot> = slots.iter().map(|s| (s.id, s)).collect();
    for p in posts
        .iter()
        .filter(|p| p.retired.is_none() && now > p.grace_until)
    {
        let Some(s) = by_id.get(&p.slot_id) else {
            continue;
        };
        if !matches!(s.state, SlotState::Planned | SlotState::Ready) || retired.contains(&s.id) {
            continue;
        }
        // A post the publisher sent, or may have, is never retired here.
        if !r.studio().slot_evidence(s.id).await?.0.is_empty() {
            continue;
        }
        let next = r
            .studio()
            .retire_slot(s.id, s.revision, RetirementReason::MissedGrace.code())
            .await?;
        r.studio_posts()
            .retire_post(
                s.id,
                PostRetirement {
                    reason: RetirementReason::MissedGrace,
                    at: now,
                },
            )
            .await?;
        let mut e = ledger_entry(
            &ctx,
            "studio.slot.missed_grace",
            "studio_slot",
            s.id,
            json!({"reason": RetirementReason::MissedGrace.code(), "format": p.format,
                "state": s.state, "publish_at": p.publish_at, "grace_until": p.grace_until,
                "revision": next.revision}),
        )?;
        e.strategy_version_id = version;
        r.ledger().append(e).await?;
        retired.insert(s.id);
        changed += 1;
    }

    // An open request nobody answered within seven days expires.
    let mut requests = r.studio_posts().list_package_requests().await?;
    for q in requests
        .iter_mut()
        .filter(|q| q.status == PackageStatus::Open && now >= q.expires_at())
    {
        q.status = PackageStatus::Expired;
        q.closed_at = Some(now);
        r.studio_posts().update_package_request(q.clone()).await?;
        r.ledger()
            .append(ledger_entry(
                &ctx,
                "studio.package.expired",
                "studio_package_request",
                q.id,
                json!({"trigger": q.trigger, "key": q.key}),
            )?)
            .await?;
        changed += 1;
    }

    let Some(frame) = frame else {
        r.commit().await?;
        return Ok(changed);
    };
    changed += plan_paid(d, r.as_mut(), &ctx, &frame, &slots, &control).await?;
    if !control.is_braked(LaneKind::Organic) {
        let mut t = Triggers {
            d,
            ctx: &ctx,
            frame: &frame,
            requests,
            changed: 0,
        };
        t.run(r.as_mut(), &slots, &posts).await?;
        changed += t.changed;
    }
    r.commit().await?;
    Ok(changed)
}

/// The paid lane's weekly positions (D13, D33): its arms and slots, as before olay-driven
/// publishing. Organic slots come from packages only.
async fn plan_paid(
    d: &Deps,
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    frame: &StrategyVersion,
    slots: &[Slot],
    control: &StudioControl,
) -> Result<u64, AppError> {
    let ws = ctx.workspace_id;
    let now = ctx.now;
    if !frame.sections.paid_enabled || control.is_braked(LaneKind::Paid) {
        return Ok(0);
    }
    let start = istanbul_week_start(now);
    let hypotheses = r.hypotheses().list(frame.id).await?;
    let groups = r.capability_groups().list().await?;
    let caps = r.capabilities().list(CapabilityFilter::default()).await?;
    let mut accounts = Vec::new();
    for c in &caps {
        if c.kind_key != "meta_ads" || capability_access(c, now, true).is_err() {
            continue;
        }
        let Some(provider) = jt_connector::provider_for_kind(&c.kind_key) else {
            continue;
        };
        if d.connectors.ads(provider).is_none() {
            continue;
        }
        accounts.push(PlanningAccount {
            capability_id: c.id,
            channel: c.kind_key.clone(),
            lane: LaneKind::Paid,
            group_ids: groups
                .iter()
                .filter(|(_, ids)| ids.contains(&c.id))
                .map(|(g, _)| g.id.0)
                .collect(),
        });
    }
    let mut lanes = Vec::new();
    for h in hypotheses.iter().filter(|h| h.state.is_live()) {
        let Some(cadence) = h.cadence.get(&LaneKind::Paid) else {
            continue;
        };
        integer_quotas(cadence).map_err(validation)?;
        lanes.push(PlanningLane {
            hypothesis_id: h.id,
            lane: LaneKind::Paid,
            channel: h.channel.clone(),
            cadence: cadence.clone(),
        });
        for a in accounts.iter().filter(|a| {
            (h.channel == "any" || a.channel == h.channel)
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
                                lane: LaneKind::Paid,
                            },
                        )
                        .map_err(validation)?,
                    )
                    .await?;
            }
        }
    }
    if lanes.is_empty() {
        return Ok(0);
    }
    let arms = r.studio().list_arms().await?;
    let mut existing = Vec::new();
    let by_id: BTreeMap<_, _> = slots.iter().map(|s| (s.id, s)).collect();
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
            ctx,
            "studio.slot.planned",
            "studio_slot",
            slot.id,
            json!({"born_version_id":frame.id,"executed_version_id":frame.id,"hypothesis_id":a.key.hypothesis_id,"arm_id":a.id,"scheduled_at":p.scheduled_at,"ordinal":p.ordinal}),
        )?;
        e.strategy_version_id = Some(frame.id.0);
        r.ledger().append(e).await?;
    }
    Ok(count)
}

/// The three triggers of one run (D23–D26).
struct Triggers<'a> {
    d: &'a Deps,
    ctx: &'a Ctx,
    frame: &'a StrategyVersion,
    /// Every package request, the run's own included as it adds them.
    requests: Vec<PackageRequest>,
    changed: u64,
}

impl Triggers<'_> {
    async fn run(
        &mut self,
        r: &mut dyn TenantRepos,
        slots: &[Slot],
        posts: &[PlannedPost],
    ) -> Result<(), AppError> {
        let now = self.ctx.now;
        let channels = post_rules::channels(self.d, r, self.frame, now).await?;
        let lib = super::materials::library(r, now).await?;
        let materials: Vec<Material> = r
            .studio_materials()
            .list_materials()
            .await?
            .into_iter()
            .filter(|m| m.erased_at.is_none())
            .collect();
        let settings = r.studio_posts().posting_settings().await?;
        let policy = settings.policy;
        let outcomes = post_rules::outcomes(r, posts, &lib.olays).await?;
        let mut shoots = r.studio_materials().list_shoot_requests().await?;
        if !channels.is_empty() {
            // The calendar first: within an occasion's lead its olay's materials are its.
            self.calendar(r, &lib, &materials, &outcomes, &policy, &mut shoots)
                .await?;
            self.olays(r, &lib, &materials, &outcomes, &policy).await?;
            self.floor(
                r,
                &lib,
                &materials,
                &outcomes,
                &settings,
                &channels,
                slots,
                posts,
                &mut shoots,
            )
            .await?;
        }
        self.close_shoots(r, &lib, &materials, &policy, shoots)
            .await
    }

    /// Stores `q` unless its key is taken, with its ledger entry.
    async fn open(&mut self, r: &mut dyn TenantRepos, q: PackageRequest) -> Result<(), AppError> {
        if !r.studio_posts().insert_package_request(q.clone()).await? {
            return Ok(());
        }
        let mut e = ledger_entry(
            self.ctx,
            "studio.package.requested",
            "studio_package_request",
            q.id,
            json!({"trigger": q.trigger, "key": q.key, "olay_id": q.olay_id,
                "occasion": q.occasion, "year": q.year, "capability_id": q.capability_id,
                "material_ids": q.material_ids}),
        )?;
        e.strategy_version_id = Some(self.frame.id.0);
        r.ledger().append(e).await?;
        self.requests.push(q);
        self.changed += 1;
        Ok(())
    }

    fn request(&self, key: String, trigger: PackageTrigger) -> PackageRequest {
        PackageRequest {
            id: PackageRequestId(self.d.ids.uuid()),
            workspace_id: self.ctx.workspace_id,
            key,
            trigger,
            status: PackageStatus::Open,
            olay_id: None,
            occasion: None,
            year: None,
            capability_id: None,
            material_ids: Vec::new(),
            best_formats: Vec::new(),
            hints: PackageHints::default(),
            created_at: self.ctx.now,
            answered_at: None,
            closed_at: None,
        }
    }

    /// Adds a çekim listesi item unless its key is taken, with its ledger entry.
    async fn shoot(
        &mut self,
        r: &mut dyn TenantRepos,
        shoots: &mut Vec<ShootRequest>,
        key: String,
        reason: ShootReason,
        text: String,
    ) -> Result<(), AppError> {
        if shoots.iter().any(|q| q.key == key) {
            return Ok(());
        }
        let request = ShootRequest {
            id: ShootRequestId(self.d.ids.uuid()),
            workspace_id: self.ctx.workspace_id,
            key,
            reason,
            text,
            week_start: post_rules::monday(istanbul_day(self.ctx.now)),
            status: ShootStatus::Open,
            created_by: self.ctx.actor.clone(),
            created_at: self.ctx.now,
            resolved_by: None,
            resolved_at: None,
        };
        if !r
            .studio_materials()
            .insert_shoot_request(request.clone())
            .await?
        {
            return Ok(());
        }
        let kind = serde_json::to_value(&request.reason)?["kind"].clone();
        r.ledger()
            .append(ledger_entry(
                self.ctx,
                "studio.shoot.requested",
                "studio_shoot_request",
                request.id,
                json!({"reason": kind, "week_start": request.week_start.to_string()}),
            )?)
            .await?;
        shoots.push(request);
        self.changed += 1;
        Ok(())
    }

    /// Among `eligible`, olay `o`'s materials no request of `o` lists yet, oldest change first,
    /// once their clock (D48: the latest of their changes and `o`'s confirmation) is
    /// `debounce_minutes` old: 20 photos make one request. `None` while there is none, or while
    /// they are still settling.
    fn settled<'m>(
        &self,
        o: &Olay,
        eligible: Vec<&'m Material>,
        policy: &PostingPolicy,
    ) -> Option<(Vec<&'m Material>, OffsetDateTime)> {
        let listed: BTreeSet<MaterialId> = self
            .requests
            .iter()
            .filter(|q| q.olay_id == Some(o.id))
            .flat_map(|q| q.material_ids.iter().copied())
            .collect();
        let mut fresh: Vec<&Material> = eligible
            .into_iter()
            .filter(|m| !listed.contains(&m.id))
            .collect();
        if fresh.is_empty() {
            return None;
        }
        fresh.sort_by_key(|m| (material_changed_at(m), m.id));
        let last = fresh
            .iter()
            .map(|m| material_changed_at(m))
            .chain(o.confirmed.as_ref().map(|c| c.at))
            .max()?;
        let now = self.ctx.now;
        (now >= last + Duration::minutes(i64::from(policy.debounce_minutes)))
            .then_some((fresh, last))
    }

    /// D24: an olay's confirmed, eligible materials not yet in any of its requests, once they
    /// stopped changing for `debounce_minutes`: one request for them all.
    async fn olays(
        &mut self,
        r: &mut dyn TenantRepos,
        lib: &super::materials::Library,
        materials: &[Material],
        outcomes: &[PostOutcome],
        policy: &PostingPolicy,
    ) -> Result<(), AppError> {
        let now = self.ctx.now;
        for o in lib.olays.iter().filter(|o| o.is_confirmed()) {
            let Some(at) = post_rules::use_time(o, &lib.calendar, now) else {
                continue;
            };
            if at > now + policy.horizon() {
                continue;
            }
            let subject = Subject::Olay { olay_id: o.id };
            let cx = lib.context(at);
            let eligible: Vec<&Material> = materials
                .iter()
                .filter(|m| m.olay_id() == Some(o.id) && classify(m, &subject, &cx).is_ok())
                .collect();
            if !eligible
                .iter()
                .any(|m| check_use(m, UseRole::Anchor, &subject, &cx).is_ok())
            {
                continue;
            }
            let Some((fresh, last)) = self.settled(o, eligible, policy) else {
                continue;
            };
            let mut q = self.request(olay_package_key(o.id, last), PackageTrigger::Olay);
            q.olay_id = Some(o.id);
            q.material_ids = fresh
                .iter()
                .map(|m| m.id)
                .take(MAX_PACKAGE_MATERIALS)
                .collect();
            q.best_formats = format_scores(outcomes, Some(o.kind));
            q.hints.subject = Some(subject);
            self.open(r, q).await?;
        }
        Ok(())
    }

    /// D25, D49: from an occasion's `window_start − lead_days` (once the window is within the
    /// posting horizon), a request for its confirmed olay of the season year: the olay's eligible
    /// materials no request lists yet, once they settled as the olay trigger's do, so that one
    /// set of materials makes one request; with no eligible material (or no such olay), a çekim
    /// listesi item from the lead on.
    async fn calendar(
        &mut self,
        r: &mut dyn TenantRepos,
        lib: &super::materials::Library,
        materials: &[Material],
        outcomes: &[PostOutcome],
        policy: &PostingPolicy,
        shoots: &mut Vec<ShootRequest>,
    ) -> Result<(), AppError> {
        let now = self.ctx.now;
        let today = istanbul_day(now);
        let mpolicy = r.studio_materials().material_policy().await?;
        for entry in &lib.calendar.entries {
            let Some((start, end)) = entry.window() else {
                continue;
            };
            let lead = Duration::days(i64::from(entry.lead_days.unwrap_or(mpolicy.lead_days)));
            if today < start - lead || today > end {
                continue;
            }
            let key = calendar_package_key(&entry.key, entry.year);
            if self.requests.iter().any(|q| q.key == key) {
                continue;
            }
            let at = post_rules::istanbul_noon(start).max(now);
            let found = post_rules::season_olay(lib, materials, &entry.key, entry.year, at);
            match found {
                Some((o, ids)) if start <= today + policy.horizon() => {
                    let eligible: Vec<&Material> =
                        materials.iter().filter(|m| ids.contains(&m.id)).collect();
                    // Covered by a request of the olay already, or still settling.
                    let Some((fresh, _)) = self.settled(o, eligible, policy) else {
                        continue;
                    };
                    let mut q = self.request(key, PackageTrigger::Calendar);
                    q.olay_id = Some(o.id);
                    q.occasion = Some(entry.key.clone());
                    q.year = Some(entry.year);
                    q.material_ids = fresh
                        .iter()
                        .map(|m| m.id)
                        .take(MAX_PACKAGE_MATERIALS)
                        .collect();
                    q.best_formats = format_scores(outcomes, Some(o.kind));
                    q.hints.subject = Some(Subject::Olay { olay_id: o.id });
                    q.hints.window_start = Some(start);
                    q.hints.window_end = Some(end);
                    self.open(r, q).await?;
                }
                // Material waits for the window to come within the horizon.
                Some(_) => {}
                None => {
                    self.shoot(
                        r,
                        shoots,
                        season_request_key(&entry.key, entry.year),
                        ShootReason::SeasonAhead {
                            occasion: entry.key.clone(),
                            year: entry.year,
                        },
                        season_request_text(&entry.name, start),
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    /// D26: a channel without a feed post for `floor_days`, no request covering it open and no
    /// post pending on it: a request for ONE post on a generic material, the hypothesis chosen
    /// by the arms' posterior mean; with no generic material, a çekim listesi item.
    #[allow(clippy::too_many_arguments)]
    async fn floor(
        &mut self,
        r: &mut dyn TenantRepos,
        lib: &super::materials::Library,
        materials: &[Material],
        outcomes: &[PostOutcome],
        settings: &crate::ports::posts::PostingSettings,
        channels: &[Channel],
        slots: &[Slot],
        posts: &[PlannedPost],
        shoots: &mut Vec<ShootRequest>,
    ) -> Result<(), AppError> {
        let now = self.ctx.now;
        let policy = &settings.policy;
        let tz = post_rules::zone_or_default(&settings.tz);
        let publications = r.studio().list_publications().await?;
        let post_of: BTreeMap<SlotId, &PlannedPost> =
            posts.iter().map(|p| (p.slot_id, p)).collect();
        let state_of: BTreeMap<SlotId, SlotState> = slots.iter().map(|s| (s.id, s.state)).collect();
        let floor = Duration::days(i64::from(policy.floor_days));
        let arms = r.studio().list_arms().await?;
        for ch in channels {
            let kind = ch.capability.kind_key.as_str();
            let feed: Vec<PostFormat> = supported_formats(kind)
                .iter()
                .copied()
                .filter(|f| f.is_feed())
                .collect();
            if feed.is_empty() {
                continue;
            }
            // A publication of no post (the weekly quotas') counts as a feed post.
            let last = publications
                .iter()
                .filter(|p| {
                    p.capability_id == ch.capability.id
                        && post_of.get(&p.slot_id).is_none_or(|x| x.format.is_feed())
                })
                .map(|p| p.published_at)
                .max();
            if last.is_some_and(|at| now - at < floor) {
                continue;
            }
            let pending_request = self
                .requests
                .iter()
                .any(|q| q.status == PackageStatus::Open && q.covers(ch.capability.id));
            let pending_post = posts.iter().any(|p| {
                p.capability_id == ch.capability.id
                    && p.retired.is_none()
                    && state_of
                        .get(&p.slot_id)
                        .is_some_and(|s| matches!(s, SlotState::Planned | SlotState::Ready))
            });
            if pending_request || pending_post {
                continue;
            }
            let Some(choice) = post_rules::best_option(&ch.options, &arms, kind) else {
                continue;
            };
            let need = SlotNeed::from_keys(&choice.content_type, &choice.segment_key);
            let at = now + policy.lead(PostFormat::FeedPost);
            match post_rules::generic_anchor(r, lib, materials, posts, slots, &need, at).await? {
                Some(m) => {
                    let mut q = self.request(
                        floor_package_key(ch.capability.id, post_rules::local_day(tz, now)),
                        PackageTrigger::Floor,
                    );
                    q.capability_id = Some(ch.capability.id);
                    q.material_ids = vec![m];
                    q.best_formats = format_scores(outcomes, None)
                        .into_iter()
                        .filter(|f| feed.contains(&f.format))
                        .collect();
                    q.hints = PackageHints {
                        max_posts: Some(1),
                        subject: Some(Subject::Generic),
                        hypothesis_id: Some(choice.hypothesis_id),
                        content_type: Some(choice.content_type.clone()),
                        ..Default::default()
                    };
                    self.open(r, q).await?;
                }
                None => {
                    let week = post_rules::monday(istanbul_day(now));
                    self.shoot(
                        r,
                        shoots,
                        slot_request_key(choice.hypothesis_id, &choice.content_type, week),
                        ShootReason::SlotUnfilled {
                            hypothesis_id: choice.hypothesis_id,
                            content_type: choice.content_type.clone(),
                        },
                        slot_request_text(
                            &choice.title,
                            &choice.content_type,
                            &post_rules::need_text(&need),
                        ),
                    )
                    .await?;
                }
            }
        }
        Ok(())
    }

    /// The system's open çekim listesi items whose condition holds now close themselves: a
    /// season's once its request exists, its window ended, or its olay has eligible materials
    /// with an anchor at the window's start (what the item asked for); an unfilled position's
    /// once a generic material may anchor a post.
    async fn close_shoots(
        &mut self,
        r: &mut dyn TenantRepos,
        lib: &super::materials::Library,
        materials: &[Material],
        policy: &PostingPolicy,
        shoots: Vec<ShootRequest>,
    ) -> Result<(), AppError> {
        let now = self.ctx.now;
        let today = istanbul_day(now);
        let generic_at = now + policy.lead(PostFormat::FeedPost);
        let cx = lib.context(generic_at);
        for q in shoots.into_iter().filter(|q| q.status == ShootStatus::Open) {
            let holds = match &q.reason {
                ShootReason::SeasonAhead { occasion, year } => {
                    let window = lib.calendar.entry(occasion, *year).and_then(|e| e.window());
                    self.requests
                        .iter()
                        .any(|x| x.key == calendar_package_key(occasion, *year))
                        || window.is_none_or(|(_, end)| today > end)
                        || window.is_some_and(|(start, _)| {
                            let at = post_rules::istanbul_noon(start).max(now);
                            post_rules::season_olay(lib, materials, occasion, *year, at).is_some()
                        })
                }
                ShootReason::SlotUnfilled { .. } => materials
                    .iter()
                    .any(|m| check_use(m, UseRole::Anchor, &Subject::Generic, &cx).is_ok()),
                _ => false,
            };
            if !holds {
                continue;
            }
            let request = ShootRequest {
                status: ShootStatus::Done,
                resolved_by: Some(self.ctx.actor.clone()),
                resolved_at: Some(now),
                ..q
            };
            r.studio_materials()
                .update_shoot_request(request.clone())
                .await?;
            r.ledger()
                .append(ledger_entry(
                    self.ctx,
                    "studio.shoot.resolved",
                    "studio_shoot_request",
                    request.id,
                    json!({"status": ShootStatus::Done.key(), "system": true}),
                )?)
                .await?;
            self.changed += 1;
        }
        Ok(())
    }
}
