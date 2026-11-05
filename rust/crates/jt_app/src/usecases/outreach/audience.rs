//! A campaign's audience (spec §3.10, §3.12; §7.1 `outreach.audience_preview`): whom its filters
//! name and, for each person, whether an outreach email may reach them and on what basis. The
//! preview and enrollment (plan L4-T5) share `resolve` and `person_verdict`, so a preview's
//! counts are what an enrollment run would do now.
//!
//! - **People** come from the explicit list and the people filter (open journeys: stage, owner,
//!   source, recipient kind, opening time, and the linked prospect's segment, city and sector).
//! - **Prospects** come from the prospect filter over qualified prospects, which enrollment
//!   promotes first: before a promotion their verdict is predicted from the prospect itself (a
//!   deliverable email, the blocklist, the business-recipient basis), so nothing is promoted
//!   only to be skipped.
//! - **A person's verdict** (in this order): erased or merged (`person_gone`), journey won or lost
//!   (`journey_closed`), not exactly one active email identity (`no_deliverable_email`), email
//!   suppressed (`suppressed`), a hard key on the do-not-contact list or an erased identity
//!   (`do_not_contact`), no commercial basis (`no_basis`: neither an effective consent nor, while
//!   the platform switch is on, the business-recipient basis), active in another campaign
//!   (`active_elsewhere`); else eligible with its basis.
//!
//! The audience is capped at `MAX_ENROLLMENTS` people and prospects together (`truncated`).

use std::collections::{BTreeMap, BTreeSet};

use jt_capability::CapabilityId;
use jt_inbox::{
    Channel, CommercialBasis, IdentityChannel, Journey, JourneyId, JourneyStatus, PersonId,
    commercial_basis, fold, source_kind,
};
use jt_outreach::{
    Audience, CampaignId, MAX_ENROLLMENTS, OwnerFilter, PeopleFilter, ProspectFilter, SkipReason,
};
use jt_prospects::{Key, KeyKind, ProspectId, ProspectStatus, normalise_key};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

use super::campaigns::mailbox;
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::TenantRepos;
use crate::ports::prospects::{MAX_PROSPECT_PAGE, ProspectQuery};
use crate::usecases::Deps;

/// How many open journeys one read of the people filter takes.
const JOURNEY_PAGE: u32 = 500;

/// Whether an outreach email may reach a person, and on what.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Verdict {
    Eligible(CommercialBasis),
    Skip(SkipReason),
}

/// One person of an audience.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Candidate {
    pub person_id: PersonId,
    pub journey_id: Option<JourneyId>,
    /// The prospect the person was promoted from.
    pub prospect_id: Option<ProspectId>,
    pub verdict: Verdict,
}

/// One qualified prospect of an audience, not promoted yet: what its promotion would come to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProspectCandidate {
    pub prospect_id: ProspectId,
    /// `Eligible(BusinessRecipient)` when it is worth promoting.
    pub verdict: Verdict,
}

/// An audience resolved now.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Resolved {
    pub people: Vec<Candidate>,
    pub prospects: Vec<ProspectCandidate>,
    /// More matched than `MAX_ENROLLMENTS`; the rest wait for a later run.
    pub truncated: bool,
}

/// The facts every verdict of one run shares.
pub(crate) struct Basis {
    /// The channels the business-recipient basis covers now (none while the platform switch is
    /// off, D53).
    pub b2b_channels: Vec<Channel>,
    pub now: OffsetDateTime,
}

impl Basis {
    pub(crate) async fn read(
        deps: &Deps,
        r: &mut dyn TenantRepos,
        now: OffsetDateTime,
    ) -> Result<Basis, AppError> {
        let b2b_channels = if deps.apps.outreach_enabled() {
            super::outreach_policy(r).await?.b2b_channels()
        } else {
            Vec::new()
        };
        Ok(Basis { b2b_channels, now })
    }

    fn business_email(&self) -> bool {
        self.b2b_channels.contains(&Channel::Email)
    }
}

/// A filter list matches when it is empty or holds `value` (compared Turkish-aware, case and
/// diacritics folded); a fact the record does not have never matches a non-empty list.
fn listed(list: &[String], value: Option<&str>) -> bool {
    if list.is_empty() {
        return true;
    }
    let Some(v) = value else { return false };
    let v = fold(v);
    list.iter().any(|l| fold(l) == v)
}

/// Whether an open journey (and its person's linked prospect facts) passes the people filter.
async fn people_match(
    r: &mut dyn TenantRepos,
    f: &PeopleFilter,
    j: &Journey,
) -> Result<bool, AppError> {
    if !f.journey_statuses.is_empty() && !f.journey_statuses.contains(&j.status) {
        return Ok(false);
    }
    match f.owner {
        Some(OwnerFilter::User { user_id }) if j.owner != Some(user_id) => return Ok(false),
        Some(OwnerFilter::Unowned) if j.owner.is_some() => return Ok(false),
        _ => {}
    }
    if !f.source_kinds.is_empty() && !f.source_kinds.contains(&source_kind(&j.source)) {
        return Ok(false);
    }
    if f.opened_after.is_some_and(|at| j.opened_at < at)
        || f.opened_before.is_some_and(|at| j.opened_at >= at)
    {
        return Ok(false);
    }
    if let Some(kind) = f.recipient_kind {
        let person = r.people().get(j.person_id).await?;
        if person.is_none_or(|p| p.recipient_kind != kind) {
            return Ok(false);
        }
    }
    if f.segments.is_empty() && f.cities.is_empty() && f.sectors.is_empty() {
        return Ok(true);
    }
    let p = r.prospects().by_person(j.person_id).await?;
    let p = p.as_ref();
    Ok(
        listed(&f.segments, p.and_then(|p| p.segment_key.as_deref()))
            && listed(&f.cities, p.and_then(|p| p.city.as_deref()))
            && listed(&f.sectors, p.and_then(|p| p.sector.as_deref())),
    )
}

/// The people (in order, each once) and the qualified prospects an audience names now, at most
/// `MAX_ENROLLMENTS` together.
async fn members(
    r: &mut dyn TenantRepos,
    a: &Audience,
) -> Result<(Vec<PersonId>, Vec<ProspectId>, bool), AppError> {
    let cap = MAX_ENROLLMENTS as usize;
    let mut people: Vec<PersonId> = Vec::new();
    let mut seen: BTreeSet<PersonId> = BTreeSet::new();
    let mut truncated = false;
    for id in &a.explicit {
        if seen.insert(*id) {
            people.push(*id);
        }
    }
    if let Some(f) = &a.people {
        let mut after = None;
        'pages: loop {
            let page = r.journeys().list_open(after, JOURNEY_PAGE).await?;
            let Some(last) = page.last() else { break };
            after = Some(last.id);
            let full = page.len() == JOURNEY_PAGE as usize;
            for j in page {
                if seen.contains(&j.person_id) || !people_match(r, f, &j).await? {
                    continue;
                }
                if people.len() >= cap {
                    truncated = true;
                    break 'pages;
                }
                seen.insert(j.person_id);
                people.push(j.person_id);
            }
            if !full {
                break;
            }
        }
    }
    let mut prospects = Vec::new();
    if let Some(f) = &a.prospects {
        prospects = qualified(r, f, cap.saturating_sub(people.len()), &mut truncated).await?;
    }
    Ok((people, prospects, truncated))
}

/// The qualified prospects the filter names, at most `room`.
async fn qualified(
    r: &mut dyn TenantRepos,
    f: &ProspectFilter,
    room: usize,
    truncated: &mut bool,
) -> Result<Vec<ProspectId>, AppError> {
    let mut out = Vec::new();
    let mut after = None;
    loop {
        let page = r
            .prospects()
            .list(&ProspectQuery {
                status: Some(ProspectStatus::Qualified),
                limit: MAX_PROSPECT_PAGE,
                after,
                ..ProspectQuery::default()
            })
            .await?;
        for p in &page.items {
            let task = p.research_task_id;
            let pass = listed(&f.segment_keys, p.segment_key.as_deref())
                && listed(&f.cities, p.city.as_deref())
                && listed(&f.sectors, p.sector.as_deref())
                && (f.research_task_ids.is_empty()
                    || task.is_some_and(|t| f.research_task_ids.contains(&t)))
                && f.min_score
                    .is_none_or(|min| p.latest_score.as_ref().is_some_and(|s| s.score >= min));
            if !pass {
                continue;
            }
            if out.len() >= room {
                *truncated = true;
                return Ok(out);
            }
            out.push(p.id);
        }
        match page.next {
            Some(next) => after = Some(next),
            None => return Ok(out),
        }
    }
}

/// The hard keys a person is reached or known by: their active email and phone identities, and
/// the hard keys of the prospect they were promoted from.
pub(crate) async fn person_keys(
    r: &mut dyn TenantRepos,
    person: PersonId,
    emails: &[String],
) -> Result<Vec<Key>, AppError> {
    let mut keys = Vec::new();
    for e in emails {
        if let Ok(value) = normalise_key(KeyKind::Email, e) {
            keys.push(Key {
                kind: KeyKind::Email,
                value,
            });
        }
    }
    for i in r.identities().list(person).await? {
        if i.active
            && i.channel == IdentityChannel::Phone
            && let Ok(value) = normalise_key(KeyKind::Phone, &i.value_normalized)
        {
            keys.push(Key {
                kind: KeyKind::Phone,
                value,
            });
        }
    }
    if let Some(p) = r.prospects().by_person(person).await? {
        keys.extend(crate::usecases::prospects::blocklist::all_keys(r, &p).await?);
    }
    Ok(keys)
}

/// A person's verdict now (the order of the module docs). `campaign`: an enrollment of this
/// campaign is not "elsewhere".
pub(crate) async fn person_verdict(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    person: PersonId,
    basis: &Basis,
    campaign: Option<CampaignId>,
) -> Result<Candidate, AppError> {
    let mut c = Candidate {
        person_id: person,
        journey_id: None,
        prospect_id: None,
        verdict: Verdict::Skip(SkipReason::PersonGone),
    };
    let Some(p) = r.people().get(person).await? else {
        return Ok(c);
    };
    if p.erased_at.is_some() || p.merged_into.is_some() {
        return Ok(c);
    }
    c.prospect_id = r.prospects().by_person(person).await?.map(|p| p.id);
    let journey = crate::usecases::inbox::active_or_latest_journey(r, person).await?;
    c.journey_id = journey.as_ref().map(|j| j.id);
    if journey
        .as_ref()
        .is_some_and(|j| matches!(j.status, JourneyStatus::Won | JourneyStatus::Lost))
    {
        c.verdict = Verdict::Skip(SkipReason::JourneyClosed);
        return Ok(c);
    }
    let emails: Vec<String> = r
        .identities()
        .list(person)
        .await?
        .into_iter()
        .filter(|i| i.active && i.channel == IdentityChannel::Email)
        .map(|i| i.value_normalized)
        .collect();
    if emails.len() != 1 {
        c.verdict = Verdict::Skip(SkipReason::NoDeliverableEmail);
        return Ok(c);
    }
    let history = crate::usecases::inbox::consent::history(r, person).await?;
    let consents: Vec<_> = history
        .consents
        .into_iter()
        .map(|mut row| {
            row.person_id = person;
            row
        })
        .collect();
    let suppressions: Vec<_> = history
        .suppressions
        .into_iter()
        .map(|mut row| {
            row.person_id = person;
            row
        })
        .collect();
    if suppressions.iter().any(|s| s.channel == Channel::Email) {
        c.verdict = Verdict::Skip(SkipReason::Suppressed);
        return Ok(c);
    }
    let keys = person_keys(r, person, &emails).await?;
    if crate::usecases::prospects::dedupe::blocked(deps, ctx, r, &keys, basis.now)
        .await?
        .is_some()
    {
        c.verdict = Verdict::Skip(SkipReason::DoNotContact);
        return Ok(c);
    }
    let Ok(b) = commercial_basis(
        &consents,
        &suppressions,
        Channel::Email,
        p.recipient_kind,
        &basis.b2b_channels,
    ) else {
        c.verdict = Verdict::Skip(SkipReason::NoBasis);
        return Ok(c);
    };
    if let Some(e) = r.outreach_enrollments().active_for(person).await?
        && Some(e.campaign_id) != campaign
    {
        c.verdict = Verdict::Skip(SkipReason::ActiveElsewhere);
        return Ok(c);
    }
    c.verdict = Verdict::Eligible(b);
    Ok(c)
}

/// What promoting a qualified prospect would come to: no deliverable email, its hard keys on the
/// do-not-contact list, no basis (a promoted prospect has no consent: only the business-recipient
/// basis reaches it), else eligible on the business-recipient basis.
pub(crate) async fn prospect_verdict(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    id: ProspectId,
    basis: &Basis,
) -> Result<ProspectCandidate, AppError> {
    let skip = |reason| ProspectCandidate {
        prospect_id: id,
        verdict: Verdict::Skip(reason),
    };
    let Some(p) = r.prospects().get(id).await? else {
        return Ok(skip(SkipReason::PersonGone));
    };
    if !p.contact.email.as_ref().is_some_and(|e| e.deliverable) {
        return Ok(skip(SkipReason::NoDeliverableEmail));
    }
    let keys = crate::usecases::prospects::blocklist::all_keys(r, &p).await?;
    if crate::usecases::prospects::dedupe::blocked(deps, ctx, r, &keys, basis.now)
        .await?
        .is_some()
    {
        return Ok(skip(SkipReason::DoNotContact));
    }
    if !basis.business_email() {
        return Ok(skip(SkipReason::NoBasis));
    }
    Ok(ProspectCandidate {
        prospect_id: id,
        verdict: Verdict::Eligible(CommercialBasis::BusinessRecipient),
    })
}

/// The audience `a` now: every member with its verdict.
pub(crate) async fn resolve(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    a: &Audience,
    campaign: Option<CampaignId>,
) -> Result<Resolved, AppError> {
    let basis = Basis::read(deps, r, ctx.now).await?;
    let (people, prospects, truncated) = members(r, a).await?;
    let mut out = Resolved {
        truncated,
        ..Resolved::default()
    };
    for id in people {
        out.people
            .push(person_verdict(deps, ctx, r, id, &basis, campaign).await?);
    }
    for id in prospects {
        out.prospects
            .push(prospect_verdict(deps, ctx, r, id, &basis).await?);
    }
    Ok(out)
}

/// `jeeta.outreach.audience_preview`'s input: the audience and the mailbox it would be sent from.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PreviewInput {
    pub audience: Audience,
    pub mailbox_id: CapabilityId,
}

/// How many eligible people rest on each basis.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct BasisCounts {
    pub consent: u32,
    pub business_recipient: u32,
}

/// What an enrollment would do now.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PreviewOut {
    /// People and prospects an outreach email may reach now.
    pub eligible: u32,
    /// The others, by skip reason key.
    pub by_skip_reason: BTreeMap<String, u32>,
    pub basis: BasisCounts,
    /// Qualified prospects among the eligible, which enrollment promotes first (within the
    /// pool's daily promotion cap; the rest wait for the next refresh).
    pub promotions_needed: u32,
    /// Whether the business-recipient basis counts now (the platform switch on, a human owner's
    /// counsel confirmation recorded, email). While it does not, outreach reaches only consented
    /// people.
    pub business_basis_in_force: bool,
    /// More matched than a campaign enrolls.
    pub truncated: bool,
}

/// Counts a resolved audience as the preview answers it.
pub(crate) fn count(resolved: &Resolved, business_basis_in_force: bool) -> PreviewOut {
    let mut out = PreviewOut {
        eligible: 0,
        by_skip_reason: BTreeMap::new(),
        basis: BasisCounts::default(),
        promotions_needed: 0,
        business_basis_in_force,
        truncated: resolved.truncated,
    };
    let verdicts = resolved
        .people
        .iter()
        .map(|c| (c.verdict, false))
        .chain(resolved.prospects.iter().map(|p| (p.verdict, true)));
    for (v, prospect) in verdicts {
        match v {
            Verdict::Eligible(b) => {
                out.eligible += 1;
                match b {
                    CommercialBasis::Consent => out.basis.consent += 1,
                    CommercialBasis::BusinessRecipient => out.basis.business_recipient += 1,
                }
                if prospect {
                    out.promotions_needed += 1;
                }
            }
            Verdict::Skip(reason) => {
                *out.by_skip_reason
                    .entry(reason.key().to_owned())
                    .or_default() += 1;
            }
        }
    }
    out
}

/// `jeeta.outreach.audience_preview`: what an enrollment of `audience` from `mailbox_id` would
/// do now; writes nothing. A `POST`: the filters may carry values that do not belong in a URL.
pub async fn audience_preview(
    deps: &Deps,
    ctx: &Ctx,
    input: PreviewInput,
) -> Result<PreviewOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    jt_outreach::validate_audience(&input.audience).map_err(super::campaign_error)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    mailbox(r.as_mut(), input.mailbox_id).await?;
    let resolved = resolve(deps, ctx, r.as_mut(), &input.audience, None).await?;
    let basis = Basis::read(deps, r.as_mut(), ctx.now).await?;
    Ok(count(&resolved, basis.business_email()))
}
