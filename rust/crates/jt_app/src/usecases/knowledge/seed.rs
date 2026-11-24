//! Seeding (design §4.3): every workspace gets its knowledge base once, by the application (so the
//! mapping is tested Rust), from its strategy versions, in a short write bundle of its own.
//!
//! [`ensure`] runs first in every knowledge use case. It inserts the settings `on conflict do
//! nothing`; only the bundle that inserted them writes the rest, so two concurrent seeds make one,
//! and a seeded workspace is never seeded again. Every id it writes is derived from the workspace
//! and what it is (`stable_id`), so the same versions always give the same rows.
//!
//! | Workspace | Seeded from | Then |
//! |---|---|---|
//! | an approved version | it (`approved`): the cards' texts, the prohibitions and goals, the caps, the approval switch | an open draft's differences become proposals and the draft is archived |
//! | only an open draft | blank cards (`draft`) | every part of the draft becomes a proposal, its log a "Önceki görüşmeler" one; the draft is archived |
//! | only an archived version | blank cards (`empty`) | the newest archived version's parts become proposals |
//! | nothing | blank cards (`empty`) | — |
//!
//! The caps come only from an approved version: the ad cap is the lower of its paid lane (when
//! paid channels are on) and the live general ad budget in the lane's currency brought to the
//! lane's period, and that item is lowered to the cap brought back to its own period when it is
//! above; a workspace with no general ad budget gets one ("Reklam bütçesi", in the lane's
//! currency and period) at 0, since nothing could be spent on ads without one: the owner opens ad
//! spend in Bütçe, up to the cap. The paid-message limit is its organic lane as it is. The approval list holds every social account whose stored flag holds its posts today,
//! and, from an approved version, the switch is on when every postable account but TikTok has it;
//! more flagged accounts than the list holds turn the switch on instead, so none is dropped.
//! Nothing a draft says takes effect, and no limit is lifted.
//!
//! Locks, in the order of design §4.10.13: the draft, the execution frame, the settings (the
//! insert), then the general ad budget item, before anything is worked out from it.

use jt_capability::{BudgetItem, BudgetItemId, BudgetKind, NewBudgetItem, StoredStatus, Unit};
use jt_knowledge::seed::{
    AD_BUDGET_NAME, ARCHIVED_REASON, DRAFT_CLOSED_NOTE, DRAFT_REASON, SeedParts,
    past_conversations, unapplied,
};
use jt_knowledge::{
    BACKFILL_COMPONENT, Cap, Card, Cause, KnowledgeCardId, KnowledgeProposalId, KnowledgeSettings,
    PAST_CONVERSATIONS, Proposal, ProposalKind, ProposalStatus, Proposer, SYSTEM_PROPOSAL_TTL,
    SeedSource, Subject,
};
use jt_strategy::{ConsultationEntry, ConsultationKind, LaneKind, StrategyVersion, VersionStatus};
use serde_json::json;

use super::{Change, Locked, system};
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::{CapabilityFilter, MAX_CONSULTATION_PAGE, TenantRepos};
use crate::usecases::studio::chain::ORGANIC_KINDS;
use crate::usecases::studio::owner_request;
use crate::usecases::studio::planner::stable_id;
use crate::usecases::studio::posts::postable;
use crate::usecases::{Deps, ledger_entry};

/// Seeds the workspace's knowledge base when it has none (see the module docs); whether this call
/// seeded it. A workspace already seeded, or seeded by a concurrent call, is left as it is.
pub async fn ensure(deps: &Deps, ctx: &Ctx) -> Result<bool, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    if r.knowledge().settings().await?.is_some() {
        return Ok(false);
    }
    if !ensure_in(deps, ctx, r.as_mut()).await? {
        return Ok(false);
    }
    r.commit().await?;
    Ok(true)
}

/// [`ensure`] in the caller's bundle, which commits: an approval through the old tools seeds a
/// workspace not seeded yet from the version it just approved, in its own transaction (design
/// §4.3.4). Takes the draft and the execution frame locks first (re-entrant for a caller holding
/// them).
pub(crate) async fn ensure_in(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
) -> Result<bool, AppError> {
    let sys = system(ctx, BACKFILL_COMPONENT);
    let draft = r.strategy().lock_draft().await?;
    let approved = r.strategy().lock_execution_frame().await?;
    let source = match (&approved, &draft) {
        (Some(_), _) => SeedSource::Approved,
        (None, Some(_)) => SeedSource::Draft,
        (None, None) => SeedSource::Empty,
    };
    let settings = KnowledgeSettings::new(ctx.workspace_id, source, ctx.now);
    if !r.knowledge().insert_settings(&settings).await? {
        return Ok(false);
    }
    seed_in(deps, &sys, r, settings, approved, draft).await?;
    Ok(true)
}

/// Everything after the settings' insert, in the same bundle.
async fn seed_in(
    deps: &Deps,
    sys: &Ctx,
    r: &mut dyn TenantRepos,
    settings: KnowledgeSettings,
    approved: Option<StrategyVersion>,
    draft: Option<StrategyVersion>,
) -> Result<(), AppError> {
    let ws = sys.workspace_id;
    let versions = r.strategy().list().await?;
    let archived = if approved.is_none() && draft.is_none() {
        versions
            .iter()
            .filter(|v| v.status == VersionStatus::Archived)
            .max_by_key(|v| v.number)
            .cloned()
    } else {
        None
    };
    let log = past_conversations(&log_entries(r, &versions).await?);
    let applied = match &approved {
        Some(v) => parts(r, v).await?,
        None => SeedParts::blank(),
    };
    let (pending, reason) = match (&approved, &draft, &archived) {
        (_, Some(d), _) => (Some(parts(r, d).await?), DRAFT_REASON),
        (None, None, Some(a)) => (Some(parts(r, a).await?), ARCHIVED_REASON),
        _ => (None, DRAFT_REASON),
    };
    let cause = if approved.is_some() {
        Cause::Backfill
    } else {
        Cause::Seed
    };
    let mut kb = Locked {
        revisions_at_lock: (settings.posting_revision, settings.prospecting_revision),
        settings,
        frame: approved.as_ref().map(|v| v.id),
        bumped: false,
    };

    // The cards: the eight seed cards in their positions, then the past conversations of a
    // workspace with an approved version.
    let mut cards: Vec<Card> = Vec::new();
    for (i, seed) in applied.cards.iter().enumerate() {
        cards.push(card(sys, seed.key, seed.title, &seed.body, i));
    }
    if approved.is_some()
        && let Some(log) = &log
    {
        cards.push(card(
            sys,
            PAST_CONVERSATIONS.0,
            PAST_CONVERSATIONS.1,
            log,
            cards.len(),
        ));
    }
    for c in &cards {
        r.knowledge().insert_card(c).await?;
        kb.record(
            r,
            deps,
            sys,
            Change {
                subject: Subject::Card,
                card: Some(c),
                cause,
                source_id: None,
                person: None,
                posting: false,
                prospecting: false,
            },
        )
        .await?;
    }

    // The rules and the goals; the caps and the approval.
    kb.settings.prohibitions = applied.prohibitions.clone();
    kb.settings.goals = applied.goals.clone();
    let social = social_accounts(r).await?;
    let flagged: Vec<uuid::Uuid> = social
        .iter()
        .filter(|c| c.policy.requires_human_approval)
        .map(|c| c.id.as_uuid())
        .collect();
    let flagged_count = flagged.len();
    kb.settings.post_approval_accounts = flagged
        .into_iter()
        .take(jt_knowledge::MAX_POST_APPROVAL_ACCOUNTS)
        .collect();
    kb.settings.post_gate_seeded_at = Some(sys.now);
    if let Some(v) = &approved {
        let gated: Vec<&jt_capability::Capability> = social
            .iter()
            .filter(|c| c.kind_key != "tiktok" && postable(deps, c, sys.now))
            .collect();
        kb.settings.post_approval =
            !gated.is_empty() && gated.iter().all(|c| c.policy.requires_human_approval);
        kb.settings.message_cap = lane(v, LaneKind::Organic);
        kb.settings.ad_cap = ad_cap(deps, sys, r, v).await?;
    }
    // More flagged accounts than the list holds: every post waits instead, so no account whose
    // posts wait today goes out (the ledger entry counts both).
    if flagged_count > kb.settings.post_approval_accounts.len() {
        kb.settings.post_approval = true;
    }
    for subject in [Subject::Rules, Subject::Goals] {
        kb.record(
            r,
            deps,
            sys,
            Change {
                subject,
                card: None,
                cause,
                source_id: None,
                person: None,
                posting: false,
                prospecting: false,
            },
        )
        .await?;
    }
    // The cards were made from the frame in force: nothing to derive again.
    if approved.is_some() {
        let s = &mut kb.settings;
        (s.posting_revision, s.prospecting_revision) = (s.revision, s.revision);
        (s.posting_derived, s.prospecting_derived) = (s.revision, s.revision);
    }
    kb.save(r).await?;

    // What was written and never applied waits as proposals.
    let mut proposals = 0usize;
    if let Some(pending) = &pending {
        let log = if approved.is_none() {
            log.as_deref()
        } else {
            None
        };
        let base = approved.is_some().then_some(&applied);
        for (n, p) in unapplied(base, pending, log).into_iter().enumerate() {
            let card_id = p.card_key.and_then(|key| {
                cards
                    .iter()
                    .find(|c| c.key.as_deref() == Some(key))
                    .map(|c| c.id)
            });
            let proposal = Proposal {
                card_key: None,
                id: KnowledgeProposalId(stable_id(ws, &format!("knowledge.proposal:seed:{n}"))),
                kind: p.kind,
                card_id,
                title: p.title,
                body: p.body,
                reason: reason.to_owned(),
                status: ProposalStatus::Pending,
                base_revision: (p.kind == ProposalKind::CardEdit).then_some(1),
                proposed_at: sys.now,
                proposed_by: Proposer::System {
                    component: BACKFILL_COMPONENT.to_owned(),
                },
                expires_at: sys.now + SYSTEM_PROPOSAL_TTL,
                decided_at: None,
                decided_by: None,
                applied_revision: None,
            };
            r.knowledge().insert_proposal(&proposal).await?;
            proposals += 1;
        }
    }

    // The knowledge base replaces drafts.
    if let Some(d) = &draft {
        if r.strategy()
            .set_status(d.id, VersionStatus::Archived, sys.now, None)
            .await?
            == 0
        {
            return Err(AppError::conflict("the draft has already moved"));
        }
        let entry = ConsultationEntry::new(
            d.id,
            ConsultationKind::Archived,
            None,
            DRAFT_CLOSED_NOTE.to_owned(),
            sys.actor.clone(),
            sys.now,
        )
        .map_err(|e| AppError::internal(e.to_string()))?;
        r.consultation().append(entry).await?;
    }

    let mut entry = ledger_entry(
        sys,
        "strategy.knowledge_seeded",
        "knowledge_settings",
        ws,
        json!({
            "source": kb.settings.seed_source.key(),
            "cards": cards.len(),
            "proposals": proposals,
            "draft_closed": draft.as_ref().map(|d| d.number),
            "ad_cap": kb.settings.ad_cap,
            "message_cap": kb.settings.message_cap,
            "post_approval": kb.settings.post_approval,
            "post_approval_accounts": kb.settings.post_approval_accounts.len(),
            "post_approval_flagged": flagged_count,
        }),
    )?;
    entry.strategy_version_id = kb.frame.map(|v| v.as_uuid());
    r.ledger().append(entry).await?;
    Ok(())
}

/// A seed card with `body`, made by the system at `position`.
fn card(sys: &Ctx, key: &str, title: &str, body: &str, position: usize) -> Card {
    Card {
        id: KnowledgeCardId(stable_id(
            sys.workspace_id,
            &format!("knowledge.card:{key}"),
        )),
        key: Some(key.to_owned()),
        title: title.to_owned(),
        body: body.to_owned(),
        attachments: Vec::new(),
        position: u32::try_from(position).unwrap_or(u32::MAX),
        revision: 1,
        created_at: sys.now,
        created_by: sys.actor.clone(),
        updated_at: sys.now,
        updated_by: sys.actor.clone(),
        archived_at: None,
    }
}

/// What version `v` gives: its sections, and its live hypotheses without the owner's request.
async fn parts(r: &mut dyn TenantRepos, v: &StrategyVersion) -> Result<SeedParts, AppError> {
    let topics = owner_request::without(v.workspace_id, r.hypotheses().list(v.id).await?);
    Ok(SeedParts::from_version(&v.sections, &topics))
}

/// The answers and notes of every version's consultation log.
async fn log_entries(
    r: &mut dyn TenantRepos,
    versions: &[StrategyVersion],
) -> Result<Vec<ConsultationEntry>, AppError> {
    let mut out = Vec::new();
    for v in versions {
        for kind in [ConsultationKind::Answer, ConsultationKind::Note] {
            out.extend(
                r.consultation()
                    .list_kind(v.id, kind, MAX_CONSULTATION_PAGE)
                    .await?,
            );
        }
    }
    Ok(out)
}

/// The workspace's social accounts (the kinds posts go out on), retired ones left out.
async fn social_accounts(
    r: &mut dyn TenantRepos,
) -> Result<Vec<jt_capability::Capability>, AppError> {
    Ok(r.capabilities()
        .list(CapabilityFilter::default())
        .await?
        .into_iter()
        .filter(|c| {
            ORGANIC_KINDS.contains(&c.kind_key.as_str()) && c.status != StoredStatus::Retired
        })
        .collect())
}

/// Version `v`'s lane of `kind` as a cap.
fn lane(v: &StrategyVersion, kind: LaneKind) -> Option<Cap> {
    v.sections
        .budget_frame
        .lanes
        .iter()
        .find(|l| l.lane == kind)
        .map(|l| Cap {
            amount_minor: l.cap_minor,
            period: l.period,
            currency: l.currency.clone(),
        })
}

/// How many days a budget period counts as when caps are compared (as `budget::check_general`
/// does); none for `total`, which has no rate.
pub(crate) fn item_days(period: jt_capability::Period) -> Option<i128> {
    match period {
        jt_capability::Period::Daily => Some(1),
        jt_capability::Period::Weekly => Some(7),
        jt_capability::Period::Monthly => Some(30),
        jt_capability::Period::Total => None,
    }
}

/// How many days a lane's period counts as.
pub(crate) fn lane_days(period: jt_strategy::Period) -> i128 {
    match period {
        jt_strategy::Period::Weekly => 7,
        jt_strategy::Period::Monthly => 30,
    }
}

/// The budget period of a lane's.
pub(crate) fn item_period(period: jt_strategy::Period) -> jt_capability::Period {
    match period {
        jt_strategy::Period::Weekly => jt_capability::Period::Weekly,
        jt_strategy::Period::Monthly => jt_capability::Period::Monthly,
    }
}

/// The ad cap version `v` seeds (see the module docs), lowering the general ad budget to it, or
/// creating one at 0 in the paid lane's currency and period when the workspace has none; each
/// change ledgered with the reason `knowledge_backfill`.
///
/// The general item is locked before anything is worked out from it (after the settings, as
/// design §4.10.13 orders), so an edit of it that committed meanwhile (Bütçe's writes lock only
/// the item) is what the cap is taken from and what is lowered, never raised back. One retired or
/// no longer general by then is `CONFLICT`: nothing is seeded, and the next call seeds again.
async fn ad_cap(
    deps: &Deps,
    sys: &Ctx,
    r: &mut dyn TenantRepos,
    v: &StrategyVersion,
) -> Result<Option<Cap>, AppError> {
    let Some(paid) = lane(v, LaneKind::Paid).filter(|_| v.sections.paid_enabled) else {
        return Ok(None);
    };
    let unit = Unit::Currency(paid.currency.clone());
    let live_general = |i: &BudgetItem| i.general && i.retired_at.is_none();
    let items = r.budget().list_items().await?;
    let Some(id) = items
        .iter()
        .find(|i| live_general(i) && i.unit == unit)
        .map(|i| i.id)
    else {
        if !items.iter().any(live_general) {
            create_general(deps, sys, r, v, &paid).await?;
        }
        return Ok(Some(paid));
    };
    let mut item = r
        .budget()
        .lock_item(id)
        .await?
        .filter(live_general)
        .ok_or_else(|| {
            AppError::conflict("the general ad budget changed while the knowledge base was seeded")
        })?;
    let Some(days) = item_days(item.period) else {
        return Ok(Some(paid));
    };
    let lane_days = lane_days(paid.period);
    let item_in_lane = i128::from(item.cap) * lane_days / days;
    let amount =
        i64::try_from(item_in_lane.min(i128::from(paid.amount_minor))).unwrap_or(paid.amount_minor);
    let cap = Cap {
        amount_minor: amount,
        ..paid
    };
    // The item is held to the cap brought back to its period, prorated as `check_general` does,
    // whichever of the two was the lower: so the cap, the item and the lane agree under that
    // check's rounding (an item the lower one in another period may lose a few minor units).
    let allowed = i64::try_from(i128::from(amount) * days / lane_days).unwrap_or(i64::MAX);
    if item.cap > allowed {
        let previous = item.cap;
        item.cap = allowed;
        r.budget().update_item(item).await?;
        let mut entry = ledger_entry(
            sys,
            "budget.items.update",
            "budget_item",
            id,
            json!({
                "cap": allowed,
                "previous": { "cap": previous },
                "reason": BACKFILL_COMPONENT,
            }),
        )?;
        entry.strategy_version_id = Some(v.id.as_uuid());
        r.ledger().append(entry).await?;
    }
    Ok(Some(cap))
}

/// Holds the live general ad budget in `cap`'s currency to `cap` brought to the item's period,
/// as the seeding does (design §4.3.2): lowered when it is above, never raised; ledgered
/// `budget.items.update` with `reason` under version `version`. Locks the item (the last lock of
/// design §4.10.13). No such item, or one of a `total` period: nothing.
pub(crate) async fn hold_general(
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    cap: &Cap,
    version: jt_strategy::StrategyVersionId,
    reason: &str,
) -> Result<(), AppError> {
    let unit = Unit::Currency(cap.currency.clone());
    let live_general = |i: &BudgetItem| i.general && i.retired_at.is_none();
    let Some(id) = r
        .budget()
        .list_items()
        .await?
        .iter()
        .find(|i| live_general(i) && i.unit == unit)
        .map(|i| i.id)
    else {
        return Ok(());
    };
    let Some(mut item) = r.budget().lock_item(id).await?.filter(live_general) else {
        return Ok(());
    };
    let Some(days) = item_days(item.period) else {
        return Ok(());
    };
    let allowed = i64::try_from(i128::from(cap.amount_minor) * days / lane_days(cap.period))
        .unwrap_or(i64::MAX);
    if item.cap <= allowed {
        return Ok(());
    }
    let previous = item.cap;
    item.cap = allowed;
    r.budget().update_item(item).await?;
    let mut entry = ledger_entry(
        ctx,
        "budget.items.update",
        "budget_item",
        id,
        json!({ "cap": allowed, "previous": { "cap": previous }, "reason": reason }),
    )?;
    entry.strategy_version_id = Some(version.as_uuid());
    r.ledger().append(entry).await?;
    Ok(())
}

/// The general ad budget of a workspace that has none, in the paid lane `paid`'s currency and
/// period, at 0: without one no campaign could open (`no_general_ad_budget`), so the seed lifts
/// no ad spend (design §4.3.2, §7.3); the owner raises it in Bütçe, up to the ad cap.
async fn create_general(
    deps: &Deps,
    sys: &Ctx,
    r: &mut dyn TenantRepos,
    v: &StrategyVersion,
    paid: &Cap,
) -> Result<(), AppError> {
    let mut item = BudgetItem::new(
        BudgetItemId(deps.ids.uuid()),
        sys.workspace_id,
        NewBudgetItem {
            name: AD_BUDGET_NAME.to_owned(),
            kind: BudgetKind::AdBudget,
            unit: Unit::Currency(paid.currency.clone()),
            cap: 0,
            unit_cost_minor: None,
            period: item_period(paid.period),
        },
        sys.now,
    )
    .map_err(|e| AppError::internal(e.to_string()))?;
    item.general = true;
    item.strategy_version_id = Some(v.id.as_uuid());
    r.budget().insert_item(item.clone()).await?;
    let mut entry = ledger_entry(
        sys,
        "budget.items.create",
        "budget_item",
        item.id,
        json!({
            "name": item.name,
            "kind": item.kind,
            "unit": item.unit,
            "cap": item.cap,
            "unit_cost_minor": item.unit_cost_minor,
            "period": item.period,
            "general": true,
            "reason": BACKFILL_COMPONENT,
        }),
    )?;
    entry.strategy_version_id = Some(v.id.as_uuid());
    r.ledger().append(entry).await?;
    Ok(())
}
