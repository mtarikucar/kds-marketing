//! Enrollment and personalization (spec §3.10, §3.11; §7.1 `outreach.enroll`,
//! `outreach.personalize`): a campaign's audience frozen into enrollments, one active
//! enrollment per person in the workspace, and the per-recipient values an agent writes.
//!
//! - **Who**: [`super::audience`]'s resolver, so an enrollment does what the preview says. A
//!   qualified prospect is promoted first (`prospects::promote::promote_one`, its own
//!   transaction, within the pool's daily promotion cap); one that would only be skipped (no
//!   deliverable email, the do-not-contact list, no basis) is not promoted at all.
//! - **What is written**: an eligible person an `active` enrollment from step 1, due at the
//!   campaign's start (or now), on the basis the verdict found; anyone else a `skipped` one with
//!   its reason (a skipped prospect has no person and no row). Batches of
//!   `MAX_ENROLLMENT_BATCH`, each its own transaction, with an `outreach.enrolled {campaign_id,
//!   count, skipped}` entry (counts by reason, never a value).
//! - Nothing is sent here: the dispatcher re-checks every rule at each send (D16).

use std::collections::BTreeMap;

use jt_inbox::PersonId;
use jt_outreach::{
    Audience, CampaignId, CampaignStatus, EnrollmentId, EnrollmentStatus, MAX_ENROLLMENTS,
    MAX_EXPLICIT, SkipReason, validate_personalization,
};
use jt_prospects::ProspectId;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::audience::{
    Basis, Candidate, ProspectCandidate, Resolved, Verdict, person_verdict, prospect_verdict,
    resolve,
};
use super::campaigns::no_such_campaign;
use super::{campaign_error, record, refused};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::outreach::{CampaignRow, EnrollmentRow, MAX_ENROLLMENT_BATCH};
use crate::usecases::prospects::PromoteOutcome;
use crate::usecases::{Deps, invalid};

/// The most enrollments one personalization call writes.
pub const MAX_PERSONALIZE_ITEMS: usize = 100;

/// `jeeta.outreach.enroll`'s input: exactly one of the campaign's own `audience` (as it resolves
/// now), people named one by one, or prospects named one by one (promoted first).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EnrollInput {
    #[serde(default)]
    pub audience: bool,
    /// At most `MAX_EXPLICIT`.
    #[serde(default)]
    pub person_ids: Vec<PersonId>,
    /// At most `MAX_EXPLICIT`.
    #[serde(default)]
    pub prospect_ids: Vec<ProspectId>,
}

/// What an enrollment run did.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct EnrollOut {
    pub campaign_id: Option<CampaignId>,
    /// Active enrollments written.
    pub enrolled: u32,
    /// Not enrolled, by skip reason key (prospects that were not promoted included).
    pub skipped: BTreeMap<String, u32>,
    /// People already in this campaign: nothing written.
    pub already_enrolled: u32,
    /// Prospects promoted into the inbox by this run.
    pub promoted: u32,
    /// Qualified prospects left for a later run: the day's promotions are used up.
    pub waiting_for_promotion: u32,
    /// More matched than a campaign enrolls.
    pub truncated: bool,
}

impl EnrollOut {
    fn skip(&mut self, reason: SkipReason) {
        *self.skipped.entry(reason.key().to_owned()).or_default() += 1;
    }
}

/// Whether a campaign takes enrollments: launched and not over.
fn enrollable(status: CampaignStatus) -> bool {
    matches!(
        status,
        CampaignStatus::Scheduled | CampaignStatus::Running | CampaignStatus::Paused
    )
}

/// `jeeta.outreach.enroll`: enrolls people into a scheduled, running or paused campaign (see the
/// module docs); the people a campaign's launch reaches are enrolled by the launch itself.
pub async fn enroll(
    deps: &Deps,
    ctx: &Ctx,
    id: CampaignId,
    input: EnrollInput,
) -> Result<EnrollOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    let given = [
        input.audience,
        !input.person_ids.is_empty(),
        !input.prospect_ids.is_empty(),
    ];
    if given.iter().filter(|g| **g).count() != 1 {
        return Err(invalid(
            "audience",
            "name exactly one of audience: true, person_ids or prospect_ids",
        ));
    }
    if input.person_ids.len() > MAX_EXPLICIT || input.prospect_ids.len() > MAX_EXPLICIT {
        return Err(invalid(
            "person_ids",
            &format!("name at most {MAX_EXPLICIT} people or prospects"),
        ));
    }
    let campaign = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        r.outreach_campaigns()
            .get(id)
            .await?
            .ok_or_else(no_such_campaign)?
    };
    if !enrollable(campaign.status) {
        return Err(refused(
            ErrorCode::Conflict,
            "not_enrollable",
            "a campaign takes enrollments once launched and until it is over",
            json!({ "status": campaign.status.key() }),
        ));
    }
    let resolved = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        if input.audience {
            resolve(
                deps,
                ctx,
                r.as_mut(),
                &campaign.definition.audience,
                Some(id),
            )
            .await?
        } else if !input.prospect_ids.is_empty() {
            let basis = Basis::read(deps, r.as_mut(), ctx.now).await?;
            let mut out = Resolved::default();
            let mut seen = std::collections::BTreeSet::new();
            for p in input.prospect_ids.iter().filter(|p| seen.insert(**p)) {
                out.prospects
                    .push(prospect_verdict(deps, ctx, r.as_mut(), *p, &basis).await?);
            }
            out
        } else {
            let audience = Audience {
                explicit: input.person_ids.clone(),
                ..Audience::default()
            };
            resolve(deps, ctx, r.as_mut(), &audience, Some(id)).await?
        }
    };
    write(deps, ctx, &campaign, resolved).await
}

/// Enrolls the campaign's own audience: what a launch (or the approval that starts it) runs
/// once the campaign is scheduled or running.
pub(crate) async fn enroll_audience(
    deps: &Deps,
    ctx: &Ctx,
    campaign: &CampaignRow,
) -> Result<EnrollOut, AppError> {
    let resolved = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        resolve(
            deps,
            ctx,
            r.as_mut(),
            &campaign.definition.audience,
            Some(campaign.id),
        )
        .await?
    };
    write(deps, ctx, campaign, resolved).await
}

/// Promotes the prospects worth promoting, then writes the enrollments.
async fn write(
    deps: &Deps,
    ctx: &Ctx,
    campaign: &CampaignRow,
    resolved: Resolved,
) -> Result<EnrollOut, AppError> {
    let mut out = EnrollOut {
        campaign_id: Some(campaign.id),
        truncated: resolved.truncated,
        ..EnrollOut::default()
    };
    let mut people: Vec<Candidate> = resolved.people;
    for ProspectCandidate {
        prospect_id,
        verdict,
    } in resolved.prospects
    {
        if let Verdict::Skip(reason) = verdict {
            out.skip(reason);
            continue;
        }
        let person =
            match crate::usecases::prospects::promote::promote_one(deps, ctx, prospect_id, None)
                .await?
            {
                PromoteOutcome::Promoted { person_id, .. } => {
                    out.promoted += 1;
                    person_id
                }
                PromoteOutcome::AlreadyPromoted { person_id, .. } => person_id,
                PromoteOutcome::Refused { reason, .. } => {
                    match reason.as_str() {
                        "daily_cap" => out.waiting_for_promotion += 1,
                        "do_not_contact" | "erased_identity" => out.skip(SkipReason::DoNotContact),
                        "no_contact_identity" => out.skip(SkipReason::NoDeliverableEmail),
                        "lost_journey_exists" => out.skip(SkipReason::JourneyClosed),
                        _ => out.skip(SkipReason::PersonGone),
                    }
                    continue;
                }
            };
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        let basis = Basis::read(deps, r.as_mut(), ctx.now).await?;
        let mut c =
            person_verdict(deps, ctx, r.as_mut(), person, &basis, Some(campaign.id)).await?;
        c.prospect_id = Some(prospect_id);
        people.push(c);
    }
    let active = {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        r.outreach_enrollments().count_active(campaign.id).await?
    };
    let mut room = MAX_ENROLLMENTS.saturating_sub(active);
    let due = campaign
        .definition
        .schedule
        .start_at
        .map_or(ctx.now, |at| at.max(ctx.now));
    let mut rows = Vec::with_capacity(people.len());
    for c in people {
        let (status, skip, basis, next_send_at) = match c.verdict {
            Verdict::Eligible(_) if room == 0 => {
                out.truncated = true;
                continue;
            }
            Verdict::Eligible(b) => {
                room -= 1;
                (EnrollmentStatus::Active, None, Some(b), Some(due))
            }
            Verdict::Skip(reason) => (EnrollmentStatus::Skipped, Some(reason), None, None),
        };
        rows.push(EnrollmentRow {
            id: EnrollmentId::from(deps.ids.uuid()),
            campaign_id: campaign.id,
            person_id: c.person_id,
            journey_id: c.journey_id,
            prospect_id: c.prospect_id,
            status,
            stop: None,
            skip,
            next_step: 1,
            next_send_at,
            personalization: BTreeMap::new(),
            basis,
            enrolled_at: ctx.now,
            stopped_at: None,
            last_sent_at: None,
        });
    }
    for batch in rows.chunks(MAX_ENROLLMENT_BATCH) {
        let mut r = deps.uow.tenant(ctx.workspace_id).await?;
        let report = r.outreach_enrollments().insert_many(batch).await?;
        let mut skipped: BTreeMap<String, u32> = BTreeMap::new();
        for row in batch {
            if report.inserted.contains(&row.id)
                && let Some(reason) = row.skip
            {
                *skipped.entry(reason.key().to_owned()).or_default() += 1;
            }
        }
        if !report.active_elsewhere.is_empty() {
            *skipped
                .entry(SkipReason::ActiveElsewhere.key().to_owned())
                .or_default() += report.active_elsewhere.len() as u32;
        }
        let enrolled = batch
            .iter()
            .filter(|row| {
                row.status == EnrollmentStatus::Active && report.inserted.contains(&row.id)
            })
            .count() as u32;
        out.enrolled += enrolled;
        out.already_enrolled += report.already_enrolled.len() as u32;
        for (k, n) in &skipped {
            *out.skipped.entry(k.clone()).or_default() += n;
        }
        record(
            r.as_mut(),
            ctx,
            "outreach.enrolled",
            "outreach_campaign",
            campaign.id,
            json!({
                "campaign_id": campaign.id,
                "count": enrolled,
                "skipped": skipped,
                "already_enrolled": report.already_enrolled.len(),
            }),
        )
        .await?;
        r.commit().await?;
    }
    Ok(out)
}

/// One enrollment's personalization: `custom.*` keys (with or without the `custom.` prefix)
/// and their values. The whole personalization is replaced.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersonalizeItem {
    pub enrollment_id: EnrollmentId,
    pub values: BTreeMap<String, String>,
}

/// `jeeta.outreach.personalize`'s input: 1 to [`MAX_PERSONALIZE_ITEMS`] enrollments.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PersonalizeInput {
    pub items: Vec<PersonalizeItem>,
}

/// What `jeeta.outreach.personalize` wrote.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PersonalizeOut {
    pub updated: u32,
}

/// The `custom.*` keys (without the prefix) the campaign's steps use: their snapshots once
/// launched, else their templates.
async fn custom_keys(
    r: &mut dyn crate::ports::TenantRepos,
    c: &CampaignRow,
) -> Result<Vec<String>, AppError> {
    let mut keys = Vec::new();
    for s in &c.definition.steps {
        let (subject, body) = match &s.snapshot {
            Some(snap) => (snap.subject.clone(), snap.body.clone()),
            None => match r.outreach_templates().get(s.template_id).await? {
                Some(t) => (t.template.subject, t.template.body),
                None => continue,
            },
        };
        if let Ok(facts) = jt_outreach::validate_template(&subject, &body) {
            for v in facts.vars {
                if let Some(k) = v.custom_key()
                    && !keys.iter().any(|x| x == k)
                {
                    keys.push(k.to_owned());
                }
            }
        }
    }
    Ok(keys)
}

/// `jeeta.outreach.personalize`: writes each active enrollment's `custom.*` values (spec §3.10);
/// a key its campaign's steps do not use is refused (`VALIDATION personalization: unused_key`),
/// as is a value out of `jt_outreach::validate_personalization`'s bounds. One transaction;
/// ledger `outreach.personalized {count}` (keys and values are not recorded).
pub async fn personalize(
    deps: &Deps,
    ctx: &Ctx,
    input: PersonalizeInput,
) -> Result<PersonalizeOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    if input.items.is_empty() || input.items.len() > MAX_PERSONALIZE_ITEMS {
        return Err(invalid(
            "items",
            &format!("personalize 1 to {MAX_PERSONALIZE_ITEMS} enrollments a call"),
        ));
    }
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut campaigns: BTreeMap<CampaignId, Vec<String>> = BTreeMap::new();
    for item in &input.items {
        let values: BTreeMap<String, String> = item
            .values
            .iter()
            .map(|(k, v)| {
                (
                    k.strip_prefix("custom.").unwrap_or(k).to_owned(),
                    v.trim().to_owned(),
                )
            })
            .collect();
        validate_personalization(&values).map_err(campaign_error)?;
        let e = r
            .outreach_enrollments()
            .get(item.enrollment_id)
            .await?
            .ok_or_else(|| AppError::not_found("no such enrollment"))?;
        if e.status != EnrollmentStatus::Active {
            return Err(refused(
                ErrorCode::Conflict,
                "enrollment_not_active",
                "only an active enrollment is personalized",
                json!({ "enrollment_id": e.id, "status": e.status.key() }),
            ));
        }
        let used = match campaigns.get(&e.campaign_id) {
            Some(keys) => keys.clone(),
            None => {
                let c = r
                    .outreach_campaigns()
                    .get(e.campaign_id)
                    .await?
                    .ok_or_else(no_such_campaign)?;
                let keys = custom_keys(r.as_mut(), &c).await?;
                campaigns.insert(e.campaign_id, keys.clone());
                keys
            }
        };
        if values.keys().any(|k| !used.contains(k)) {
            return Err(AppError::validation(
                "a key the campaign's steps do not use",
                json!({ "field": "personalization", "reason": "unused_key" }),
            ));
        }
        r.outreach_enrollments().personalize(e.id, &values).await?;
    }
    record(
        r.as_mut(),
        ctx,
        "outreach.personalized",
        "outreach_settings",
        ctx.workspace_id,
        json!({ "count": input.items.len() }),
    )
    .await?;
    r.commit().await?;
    Ok(PersonalizeOut {
        updated: input.items.len() as u32,
    })
}
