//! Approvals through the old tools, until they are removed (design §4.3.4, D24): the
//! consultation tools and `strategy.approve` keep working for external routines, and on a seeded
//! workspace an old approval keeps the two layers equal, in its own transaction:
//!
//! 1. before validating, `prepare` writes the draft's system fields as the frame makes them:
//!    `channels = [any]`, every live topic on `any` posting organically, no channel mix, the
//!    budget lanes from the caps after step 3's lowering;
//! 2. after approving, `after` rewrites from the approved version each seed card no person has
//!    changed since it was seeded or re-synced (`cause = resync`); a card the owner, a note or a
//!    proposal changed is left as it is, and when the version's text differs, a `card_edit`
//!    proposal (`strategy_resync`) carries it. Only the parts the routine changed count: a card
//!    whose text the frame in force before the approval gives alike is left as it is (the frame
//!    mirrors the cards, so its identity reads back the cards themselves, cut to the frame's
//!    length), "Hesaplar ve kanallar" is built from the channels as the routine wrote them (the
//!    approved version's are the system's `[any]`), and no card is emptied;
//! 3. the prohibitions and the goal lines the version adds are appended (none removed); the ad
//!    cap and the paid-message limit are lowered to the version's lanes when those are lower,
//!    never raised, and the general ad budget follows a lowered ad cap;
//! 4. the knowledge base's revision moves once, and the posting and prospecting revisions and
//!    what they were derived from all become it: the cards now say what the frame says.
//!
//! A workspace not seeded yet is seeded from the version just approved instead
//! (`seed::ensure_in`), in the same transaction.

use jt_knowledge::frame::{self as kframe, posts_organically, prorate};
use jt_knowledge::seed::{RESYNC_REASON, SeedParts, goal_lines, prohibitions};
use jt_knowledge::{
    Cap, Cause, KnowledgeProposalId, KnowledgeSettings, MAX_GOALS, MAX_PROHIBITIONS, Proposal,
    ProposalKind, ProposalStatus, Proposer, RESYNC_COMPONENT, SEED_CARDS, SYSTEM_PROPOSAL_TTL,
    Subject, append_lines,
};
use jt_strategy::{ChannelChoice, LaneKind, Sections, StrategyVersion};
use jt_tenancy::UserId;

use super::{Change, Locked, seed};
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::TenantRepos;
use crate::usecases::Deps;
use crate::usecases::studio::owner_request;

/// What [`prepare`] keeps for [`after`]: the caps after the version's lowering, and what the
/// cards are re-synced against.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Prepared {
    pub caps: Caps,
    /// The draft's channels as the routine wrote them, before the frame's `[any]` replaced them:
    /// what "Hesaplar ve kanallar" is re-synced from.
    pub channels: Vec<ChannelChoice>,
    /// What the frame in force before the approval gives the seed cards (none without one): a
    /// card is re-synced only where the approved version says something else.
    pub before: Option<SeedParts>,
}

/// The caps an old approval leaves: those of the knowledge base, lowered to the version's lanes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Caps {
    pub ad_cap: Option<Cap>,
    pub message_cap: Option<Cap>,
}

/// The caps `settings` holds, lowered to what the lanes of `sections` allow (never raised): the
/// ad cap to the paid lane brought to its period (none, or paid channels off: nothing for ads,
/// so 0), the paid-message limit to the organic lane (a limit of its own where it had none).
/// A lane of another currency than the cap's is not compared.
pub(crate) fn lowered(settings: &KnowledgeSettings, sections: &Sections) -> Caps {
    let lane = |kind: LaneKind| sections.budget_frame.lanes.iter().find(|l| l.lane == kind);
    let ad_cap = settings.ad_cap.as_ref().map(|cap| {
        let allowed = match lane(LaneKind::Paid).filter(|_| sections.paid_enabled) {
            None => 0,
            Some(l) if l.currency == cap.currency => prorate(l.cap_minor, l.period, cap.period),
            Some(_) => cap.amount_minor,
        };
        Cap {
            amount_minor: allowed.clamp(0, cap.amount_minor),
            ..cap.clone()
        }
    });
    let message_cap = match (&settings.message_cap, lane(LaneKind::Organic)) {
        (None, Some(l)) => Some(Cap {
            amount_minor: l.cap_minor.max(0),
            period: l.period,
            currency: l.currency.clone(),
        }),
        (Some(cap), Some(l)) if l.currency == cap.currency => Some(Cap {
            amount_minor: prorate(l.cap_minor, l.period, cap.period).clamp(0, cap.amount_minor),
            ..cap.clone()
        }),
        (cap, _) => cap.clone(),
    };
    Caps {
        ad_cap,
        message_cap,
    }
}

/// Step 1: writes `draft`'s system fields (design §4.3.4) and answers the lowered caps, with the
/// routine's own channels and what `previous` (the frame in force) gives the cards. The caller
/// holds the draft and frame locks; `draft` is updated as it was written.
pub(crate) async fn prepare(
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    draft: &mut StrategyVersion,
    previous: Option<&StrategyVersion>,
    settings: &KnowledgeSettings,
) -> Result<Prepared, AppError> {
    let before = match previous {
        Some(v) => {
            let topics = owner_request::without(ctx.workspace_id, r.hypotheses().list(v.id).await?);
            Some(SeedParts::from_version(&v.sections, &topics))
        }
        None => None,
    };
    let prepared = Prepared {
        caps: lowered(settings, &draft.sections),
        channels: draft.sections.channels.clone(),
        before,
    };
    let caps = KnowledgeSettings {
        ad_cap: prepared.caps.ad_cap.clone(),
        message_cap: prepared.caps.message_cap.clone(),
        ..settings.clone()
    };
    let mut sections = draft.sections.clone();
    sections.channels = kframe::any_channels();
    sections.cadence.channel_mix.clear();
    sections.budget_frame.lanes = kframe::lanes(&caps);
    sections.paid_enabled = sections
        .budget_frame
        .lanes
        .iter()
        .any(|l| l.lane == LaneKind::Paid);
    if sections != draft.sections {
        r.strategy()
            .update_sections(draft.id, sections.clone(), ctx.now)
            .await?;
        draft.sections = sections;
    }
    let per_week = draft.sections.cadence.per_week.max(1);
    for mut h in r.hypotheses().list(draft.id).await? {
        if !h.state.is_live() || owner_request::is(ctx.workspace_id, h.id) {
            continue;
        }
        if h.channel == jt_strategy::ANY_CHANNEL && posts_organically(&h) {
            continue;
        }
        h.channel = jt_strategy::ANY_CHANNEL.to_owned();
        if !posts_organically(&h) {
            h.cadence
                .insert(LaneKind::Organic, kframe::default_organic_cadence(per_week));
        }
        r.hypotheses().upsert(draft.id, h).await?;
    }
    Ok(prepared)
}

/// Steps 2 to 4, after `approved` was approved by `by` in the caller's bundle, which holds the
/// draft, frame and settings locks (`settings` as locked) and, by now, the studio control.
pub(crate) async fn after(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    settings: KnowledgeSettings,
    prepared: Prepared,
    approved: &StrategyVersion,
    by: Option<UserId>,
) -> Result<(), AppError> {
    let mut kb = Locked {
        revisions_at_lock: (settings.posting_revision, settings.prospecting_revision),
        settings,
        frame: Some(approved.id),
        bumped: false,
    };
    let topics = owner_request::without(ctx.workspace_id, r.hypotheses().list(approved.id).await?);
    // The channels as the routine wrote them: the approved version's are the system's `[any]`.
    let mut sections = approved.sections.clone();
    sections.channels = prepared.channels.clone();
    let parts = SeedParts::from_version(&sections, &topics);

    // The seed cards no person changed since they were seeded follow the version; for the
    // others, a proposal carries its text. Only what the routine changed counts: a text the
    // frame in force gave alike is the cards' own (the frame mirrors them), and no card is
    // emptied.
    let cards = r.knowledge().cards().await?;
    let pending = r
        .knowledge()
        .proposals(Some(ProposalStatus::Pending))
        .await?;
    for (key, _) in SEED_CARDS {
        let Some(card) = cards
            .iter()
            .find(|c| c.key.as_deref() == Some(key) && c.is_live())
        else {
            continue;
        };
        let text = parts.body(key);
        let unchanged = prepared
            .before
            .as_ref()
            .is_some_and(|b| b.body(key) == text);
        if text == card.body || text.trim().is_empty() || unchanged {
            continue;
        }
        let newest = r
            .knowledge()
            .revisions(Subject::Card, Some(card.id), None, 1)
            .await?;
        let systems = newest
            .first()
            .is_none_or(|rev| matches!(rev.cause, Cause::Seed | Cause::Backfill | Cause::Resync));
        if systems {
            let Some(mut card) = r.knowledge().lock_card(card.id).await? else {
                continue;
            };
            card.body = text.to_owned();
            card.revision += 1;
            card.updated_at = ctx.now;
            card.updated_by = ctx.actor.clone();
            r.knowledge().save_card(&card).await?;
            super::cards::supersede_edits(r, card.id, ctx.now).await?;
            kb.record(
                r,
                deps,
                ctx,
                Change {
                    subject: Subject::Card,
                    card: Some(&card),
                    cause: Cause::Resync,
                    source_id: None,
                    person: by,
                    posting: false,
                    prospecting: false,
                },
            )
            .await?;
        } else if !pending.iter().any(|p| {
            p.kind == ProposalKind::CardEdit && p.card_id == Some(card.id) && p.body == text
        }) {
            r.knowledge()
                .insert_proposal(&Proposal {
                    id: KnowledgeProposalId(deps.ids.uuid()),
                    kind: ProposalKind::CardEdit,
                    card_id: Some(card.id),
                    title: None,
                    body: text.to_owned(),
                    reason: RESYNC_REASON.to_owned(),
                    status: ProposalStatus::Pending,
                    base_revision: Some(card.revision),
                    proposed_at: ctx.now,
                    proposed_by: Proposer::System {
                        component: RESYNC_COMPONENT.to_owned(),
                    },
                    expires_at: ctx.now + SYSTEM_PROPOSAL_TTL,
                    decided_at: None,
                    decided_by: None,
                    applied_revision: None,
                })
                .await?;
        }
    }

    // The rules: lines the version adds, appended as far as the box takes them; the caps
    // lowered, never raised.
    let mut rules_changed = false;
    for line in prohibitions(&approved.sections.prohibitions) {
        if kb.settings.prohibitions.len() >= MAX_PROHIBITIONS {
            break;
        }
        let added = append_lines(
            "prohibitions",
            &mut kb.settings.prohibitions,
            &[line],
            MAX_PROHIBITIONS,
        )
        .unwrap_or_default();
        rules_changed |= !added.is_empty();
    }
    let lowered_ad = prepared.caps.ad_cap != kb.settings.ad_cap;
    if lowered_ad || prepared.caps.message_cap != kb.settings.message_cap {
        kb.settings.ad_cap = prepared.caps.ad_cap.clone();
        kb.settings.message_cap = prepared.caps.message_cap.clone();
        rules_changed = true;
    }
    if rules_changed {
        kb.settings.rules_revision += 1;
        kb.record(r, deps, ctx, change(Subject::Rules, by)).await?;
    }
    let mut goals_changed = false;
    for line in goal_lines(&approved.sections.goals) {
        if kb.settings.goals.len() >= MAX_GOALS {
            break;
        }
        let added =
            append_lines("goals", &mut kb.settings.goals, &[line], MAX_GOALS).unwrap_or_default();
        goals_changed |= !added.is_empty();
    }
    if goals_changed {
        kb.settings.goals_revision += 1;
        kb.record(r, deps, ctx, change(Subject::Goals, by)).await?;
    }
    if lowered_ad && let Some(cap) = &kb.settings.ad_cap {
        seed::hold_general(ctx, r, cap, approved.id, RESYNC_COMPONENT).await?;
    }

    // Step 4: the cards now say what the frame says.
    if !kb.bumped {
        kb.settings.revision += 1;
        kb.settings.changed_at = Some(ctx.now);
        kb.settings.changed_by = by;
        kb.bumped = true;
    }
    let s = &mut kb.settings;
    (s.posting_revision, s.prospecting_revision) = (s.revision, s.revision);
    (s.posting_derived, s.prospecting_derived) = (s.revision, s.revision);
    let live: Vec<_> = r
        .hypotheses()
        .list(approved.id)
        .await?
        .into_iter()
        .filter(|h| h.state.is_live())
        .map(|h| h.id)
        .collect();
    kb.settings.closing_topic_ids.retain(|id| live.contains(id));
    kb.save(r).await
}

/// The change of the rules or the goals a re-sync records, as `by`'s.
fn change(subject: Subject, by: Option<UserId>) -> Change<'static> {
    Change {
        subject,
        card: None,
        cause: Cause::Resync,
        source_id: None,
        person: by,
        posting: false,
        prospecting: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use jt_strategy::{Lane, Period};
    use time::OffsetDateTime;

    fn settings(ad: Option<i64>, message: Option<i64>) -> KnowledgeSettings {
        let mut s = KnowledgeSettings::new(
            jt_tenancy::WorkspaceId::new_v7(),
            jt_knowledge::SeedSource::Approved,
            OffsetDateTime::UNIX_EPOCH,
        );
        let cap = |amount_minor| Cap {
            amount_minor,
            period: Period::Monthly,
            currency: "TRY".into(),
        };
        s.ad_cap = ad.map(cap);
        s.message_cap = message.map(cap);
        s
    }

    fn sections(paid: Option<(i64, Period)>, organic: Option<i64>) -> Sections {
        let mut s = Sections::default();
        if let Some((cap_minor, period)) = paid {
            s.paid_enabled = true;
            s.budget_frame.lanes.push(Lane {
                lane: LaneKind::Paid,
                period,
                cap_minor,
                currency: "TRY".into(),
            });
        }
        if let Some(cap_minor) = organic {
            s.budget_frame.lanes.push(Lane {
                lane: LaneKind::Organic,
                period: Period::Monthly,
                cap_minor,
                currency: "TRY".into(),
            });
        }
        s
    }

    #[test]
    fn an_old_approval_lowers_the_caps_and_never_raises_them() {
        let amount = |c: &Option<Cap>| c.as_ref().map(|c| c.amount_minor);
        // A higher lane leaves the cap; a lower one lowers it, brought to the cap's period.
        let p = lowered(
            &settings(Some(500_000), Some(0)),
            &sections(Some((900_000, Period::Monthly)), Some(10)),
        );
        assert_eq!(
            (amount(&p.ad_cap), amount(&p.message_cap)),
            (Some(500_000), Some(0))
        );
        let p = lowered(
            &settings(Some(500_000), Some(100)),
            &sections(Some((70_000, Period::Weekly)), Some(40)),
        );
        assert_eq!(
            (amount(&p.ad_cap), amount(&p.message_cap)),
            (Some(300_000), Some(40))
        );
        // No paid lane: nothing for ads. No ads already: never raised.
        let p = lowered(&settings(Some(500_000), None), &sections(None, None));
        assert_eq!((amount(&p.ad_cap), amount(&p.message_cap)), (Some(0), None));
        let p = lowered(
            &settings(None, None),
            &sections(Some((900_000, Period::Monthly)), Some(5)),
        );
        assert_eq!(
            (amount(&p.ad_cap), amount(&p.message_cap)),
            (None, Some(5)),
            "a message limit where there was none is a lowering"
        );
    }
}
