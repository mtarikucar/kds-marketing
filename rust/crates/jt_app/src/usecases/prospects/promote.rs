//! Promotion (spec 2026-10-30-leads-pool-outreach-design.md §3.5): a prospect becomes an inbox
//! person with a journey through the inbox's one matching function, with no consent recorded, as
//! a business recipient, linked to the prospect. Each prospect is promoted in its own transaction
//! (the inbox lock, then the pool lock) and the answer lists one outcome per prospect.
//!
//! The prospect's facts stay on the prospect (the inbox context reads them through the link);
//! nothing is copied into notes. The score at promotion is frozen on the prospect: the learning
//! loop's input.

use jt_inbox::{
    IdentityChannel, Journey, JourneyId, JourneyStatus, PersonId, RecipientKind, Source,
};
use jt_ledger::Actor;
use jt_prospects::{
    KeyKind, Promotion, Prospect, ProspectId, ProspectStatus, Reason, ScoreSummary, Signal,
    SourceRef, bucket, derive_keys, normalise_key, phone_is_dialable,
};
use jt_tenancy::{Permission, UserId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::{dedupe, leads_policy, record};
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::TenantRepos;
use crate::ports::prospects::Promoted;
use crate::usecases::inbox::people::{self, CreateInput, IdentityInput, NewPerson};
use crate::usecases::{Deps, hours, invalid};

/// The most prospects one call promotes.
pub const MAX_PROMOTE_BATCH: usize = 50;

/// The prefix that keeps a promotion's request keys apart from every other operation's.
const REQUEST_KEY_PREFIX: &str = "prospects.promote:";

/// `jeeta.prospects.promote`'s input.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PromoteInput {
    /// `1..=50` prospects, each promoted in its own transaction, in this order.
    pub prospect_ids: Vec<ProspectId>,
    /// Replays each prospect's outcome for 24 hours (stored per prospect, ids only).
    #[serde(default)]
    pub request_key: Option<String>,
}

/// What became of one prospect.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum PromoteOutcome {
    /// Now an inbox person with a journey; `created_person` when the person is new.
    Promoted {
        prospect_id: ProspectId,
        person_id: PersonId,
        journey_id: JourneyId,
        created_person: bool,
        /// The journey's owner after distribution (none until someone is eligible).
        owner_id: Option<UserId>,
    },
    /// Promoted before: its person and journey.
    AlreadyPromoted {
        prospect_id: ProspectId,
        person_id: PersonId,
        journey_id: JourneyId,
    },
    /// Not promoted: `reason` (`not_found`, `not_qualified`, `daily_cap`,
    /// `no_contact_identity`, `do_not_contact`, `erased_identity`, `identity_split`,
    /// `lost_journey_exists`, `person_already_linked`) and its details.
    Refused {
        prospect_id: ProspectId,
        reason: String,
        #[serde(skip_serializing_if = "Value::is_null")]
        details: Value,
    },
}

/// `jeeta.prospects.promote`'s answer: one outcome per prospect, in the input's order.
#[derive(Clone, Debug, Serialize)]
pub struct PromoteOut {
    pub items: Vec<PromoteOutcome>,
}

/// `jeeta.prospects.promote`: promotes each prospect in its own transaction. An agent promotes
/// only qualified prospects (unless the policy lets it promote new ones); a person may also
/// promote a new one. Needs `prospects.work` and `inbox.work`.
pub async fn promote(deps: &Deps, ctx: &Ctx, input: PromoteInput) -> Result<PromoteOut, AppError> {
    ctx.require(Permission::ProspectsWork)?;
    ctx.require(Permission::InboxWork)?;
    let n = input.prospect_ids.len();
    if n == 0 || n > MAX_PROMOTE_BATCH {
        return Err(invalid(
            "prospect_ids",
            &format!("name 1 to {MAX_PROMOTE_BATCH} prospects"),
        ));
    }
    let key = match input.request_key.as_deref().map(str::trim) {
        Some("") => return Err(invalid("request_key", "must not be blank")),
        Some(k) if k.chars().count() > 200 => {
            return Err(invalid("request_key", "at most 200 characters"));
        }
        other => other.map(str::to_owned),
    };
    let mut items = Vec::with_capacity(n);
    let mut seen = std::collections::BTreeSet::new();
    for id in input.prospect_ids {
        if !seen.insert(id) {
            continue;
        }
        let item_key = key
            .as_ref()
            .map(|k| format!("{REQUEST_KEY_PREFIX}{k}:{id}"));
        items.push(promote_one(deps, ctx, id, item_key.as_deref()).await?);
    }
    Ok(PromoteOut { items })
}

/// Promotes prospect `id` in a transaction of its own and commits what the outcome needs (a
/// refusal commits nothing, but an identity split's merge suggestion). Reused by outreach
/// enrollment (plan L4-T5).
pub(crate) async fn promote_one(
    deps: &Deps,
    ctx: &Ctx,
    id: ProspectId,
    request_key: Option<&str>,
) -> Result<PromoteOutcome, AppError> {
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    if let Some(key) = request_key
        && let Some(out) = replay(r.as_mut(), key, id, ctx.now).await?
    {
        return Ok(out);
    }
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    r.prospects().lock_pool().await?;
    // Again under the locks: a promotion with the same key may have committed meanwhile.
    if let Some(key) = request_key
        && let Some(out) = replay(r.as_mut(), key, id, ctx.now).await?
    {
        return Ok(out);
    }
    let outcome = match promote_in(deps, ctx, r.as_mut(), id).await? {
        Step::Done(outcome) => outcome,
        Step::Refused(outcome) => return Ok(outcome),
        Step::RefusedKeepingSuggestion(outcome) => {
            r.commit().await?;
            return Ok(outcome);
        }
    };
    if let (Some(key), PromoteOutcome::Promoted { .. }) = (request_key, &outcome) {
        let stored = serde_json::to_value(&outcome)
            .map_err(|_| AppError::internal("cannot encode a promotion"))?;
        if !r.request_keys().store(key, stored, ctx.now).await? {
            return Err(AppError::conflict("request key changed while promoting"));
        }
    }
    r.commit().await?;
    Ok(outcome)
}

/// How a promotion inside the caller's bundle ended.
enum Step {
    /// Commit, and answer this.
    Done(PromoteOutcome),
    /// Drop the bundle (nothing changes), and answer this.
    Refused(PromoteOutcome),
    /// Commit only the merge suggestion an identity split wrote, and answer this.
    RefusedKeepingSuggestion(PromoteOutcome),
}

fn refusal(id: ProspectId, reason: &str, details: Value) -> Step {
    Step::Refused(PromoteOutcome::Refused {
        prospect_id: id,
        reason: reason.to_owned(),
        details,
    })
}

/// The promotion of `id` in `r`, which holds the inbox lock and then the pool lock.
async fn promote_in(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    id: ProspectId,
) -> Result<Step, AppError> {
    let Some(p) = r.prospects().lock(id).await? else {
        return Ok(refusal(id, "not_found", Value::Null));
    };
    match p.status {
        ProspectStatus::Promoted => {
            let Some(promoted) = &p.promoted else {
                return Err(AppError::internal("a promoted prospect has no promotion"));
            };
            return Ok(Step::Done(PromoteOutcome::AlreadyPromoted {
                prospect_id: id,
                person_id: promoted.person_id,
                journey_id: promoted.journey_id,
            }));
        }
        ProspectStatus::Qualified => {}
        ProspectStatus::New => {
            let policy = leads_policy(r).await?;
            let human = matches!(ctx.actor, Actor::Human { .. });
            if !human && policy.prospects.agents_promote_qualified_only {
                return Ok(refusal(
                    id,
                    "not_qualified",
                    json!({ "status": p.status.key(), "rule": "promote_requires_qualified" }),
                ));
            }
        }
        ProspectStatus::Rejected | ProspectStatus::DoNotContact => {
            return Ok(refusal(
                id,
                "not_qualified",
                json!({ "status": p.status.key() }),
            ));
        }
    }
    let policy = leads_policy(r).await?;
    let (from, to) = hours::local_day(&policy.timezone, ctx.now)?;
    let cap = u32::from(policy.prospects.max_promotions_per_day);
    if r.prospects().promoted_between(from, to).await? >= cap {
        return Ok(refusal(
            id,
            "daily_cap",
            json!({ "cap": cap, "resets_at": to.format(&Rfc3339).unwrap_or_default() }),
        ));
    }
    let identities = identities_of(&p);
    if identities.is_empty() {
        return Ok(refusal(id, "no_contact_identity", Value::Null));
    }
    let keys = derive_keys(&p);
    if let Some(reason) = dedupe::blocked(deps, ctx, r, &keys, ctx.now).await? {
        return Ok(refusal(id, reason, Value::Null));
    }
    let display_name = p
        .contact
        .contact_person
        .as_ref()
        .map(|c| c.value.name.trim().to_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| p.business_name.clone());
    let source = Source::Prospect {
        prospect_id: p.id.as_uuid(),
        origin: origin_key(&p),
    };
    let matched = people::match_or_create_with(
        deps,
        ctx,
        r,
        CreateInput {
            display_name,
            identities,
            source: source.clone(),
        },
        None,
        Some(NewPerson {
            company: p.business_name.clone(),
            recipient_kind: RecipientKind::Business,
        }),
        true,
    )
    .await;
    let matched = match matched {
        Ok(m) => m,
        Err(e) if e.details["reason"] == "identity_split" => {
            return Ok(Step::RefusedKeepingSuggestion(PromoteOutcome::Refused {
                prospect_id: id,
                reason: "identity_split".into(),
                details: json!({
                    "person_ids": e.details["person_ids"],
                    "merge_suggestion": e.details["merge_suggestion"],
                }),
            }));
        }
        Err(e) if e.details["reason"] == "erased_identity" => {
            return Ok(refusal(id, "erased_identity", Value::Null));
        }
        Err(e) => return Err(e),
    };
    let person = matched.person;
    let journey = match journey_for(deps, ctx, r, id, person.id, &source).await? {
        Ok(j) => j,
        Err(step) => return Ok(step),
    };
    // A business unless a person said this is a private individual (L-02).
    if person.recipient_kind == RecipientKind::Unknown {
        r.people()
            .set_recipient_kind(person.id, RecipientKind::Business, ctx.now)
            .await?;
    }
    let score = p.latest_score.as_ref().map(|s| s.score);
    let promotion = Promotion {
        person_id: person.id,
        journey_id: journey.id,
        at: ctx.now,
        score,
        bucket: score.map(bucket),
    };
    match r.prospects().set_promoted(p.id, &promotion).await? {
        Promoted::Ok => {}
        Promoted::NotPromotable { status } => {
            return Ok(refusal(
                id,
                "not_qualified",
                json!({ "status": status.key() }),
            ));
        }
        Promoted::PersonAlreadyLinked { prospect_id } => {
            return Ok(refusal(
                id,
                "person_already_linked",
                json!({ "person_id": person.id, "prospect_id": prospect_id }),
            ));
        }
    }
    // Distribution runs inline: the journey has an owner (or a recorded reason it has none) when
    // this commits.
    crate::usecases::distribution::assign_in(deps, ctx, r, journey.id, false).await?;
    record(
        r,
        ctx,
        "prospects.promoted",
        p.id,
        json!({
            "prospect_id": p.id,
            "person_id": person.id,
            "journey_id": journey.id,
            "created_person": matched.created,
        }),
    )
    .await?;
    let owner_id = r.journeys().get(journey.id).await?.and_then(|j| j.owner);
    Ok(Step::Done(PromoteOutcome::Promoted {
        prospect_id: id,
        person_id: person.id,
        journey_id: journey.id,
        created_person: matched.created,
        owner_id,
    }))
}

/// The journey a promoted person continues on: the open one (a new person's first journey
/// included); a new one after a won journey (`Source::Repeat`, as `inbox.journeys.open`), or
/// when the person has none; a refusal after a lost one (a person reopens it).
async fn journey_for(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    id: ProspectId,
    person: PersonId,
    source: &Source,
) -> Result<Result<Journey, Step>, AppError> {
    if let Some(open) = r.journeys().open_for(person).await? {
        return Ok(Ok(open));
    }
    let latest = r.journeys().latest_for(person).await?;
    let source = match latest.as_ref().map(|j| j.status) {
        Some(JourneyStatus::Lost) => {
            return Ok(Err(refusal(
                id,
                "lost_journey_exists",
                json!({
                    "person_id": person,
                    "journey_id": latest.as_ref().map(|j| j.id),
                }),
            )));
        }
        Some(JourneyStatus::Won) => Source::Repeat,
        _ => source.clone(),
    };
    let initial = crate::usecases::inbox::journeys::initial(deps, ctx, person, source);
    let row = initial.journey().clone();
    r.journeys().insert_initial(initial).await?;
    crate::usecases::inbox::record(
        r,
        ctx,
        "inbox.journey.opened",
        "journey",
        row.id,
        json!({ "person_id": person }),
    )
    .await?;
    Ok(Ok(row))
}

/// The inbox identities a prospect gives: its deliverable email and its deliverable, dialable
/// phone (a `tr444:` number is never one), normalised as their keys are.
fn identities_of(p: &Prospect) -> Vec<IdentityInput> {
    let mut out = Vec::new();
    if let Some(field) = &p.contact.email
        && field.deliverable
        && let Ok(value) = normalise_key(KeyKind::Email, &field.value)
    {
        out.push(IdentityInput {
            channel: IdentityChannel::Email,
            value,
            capability_id: None,
        });
    }
    if let Some(field) = &p.contact.phone
        && field.deliverable
        && let Ok(value) = normalise_key(KeyKind::Phone, &field.value)
        && phone_is_dialable(&value)
    {
        out.push(IdentityInput {
            channel: IdentityChannel::Phone,
            value,
            capability_id: None,
        });
    }
    out
}

/// How the prospect entered the pool, as `Source::Prospect.origin` names it.
fn origin_key(p: &Prospect) -> String {
    serde_json::to_value(p.origin.via)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_default()
}

/// The outcome a promotion request key recorded for prospect `id`, read again. `None` when the
/// key is not live.
async fn replay(
    r: &mut dyn TenantRepos,
    key: &str,
    id: ProspectId,
    now: OffsetDateTime,
) -> Result<Option<PromoteOutcome>, AppError> {
    let Some(stored) = r.request_keys().get(key, now).await? else {
        return Ok(None);
    };
    let same = stored.get("prospect_id").and_then(Value::as_str) == Some(&id.as_uuid().to_string());
    if stored.get("outcome").and_then(Value::as_str) != Some("promoted") || !same {
        return Err(AppError::conflict(
            "request key belongs to another operation",
        ));
    }
    let Some(p) = r.prospects().get(id).await? else {
        return Err(AppError::not_found(
            "the prospect this request promoted is gone",
        ));
    };
    let Some(promoted) = p.promoted else {
        return Err(AppError::conflict(
            "the prospect this request promoted changed",
        ));
    };
    let owner_id = r
        .journeys()
        .get(promoted.journey_id)
        .await?
        .and_then(|j| j.owner);
    Ok(Some(PromoteOutcome::Promoted {
        prospect_id: id,
        person_id: promoted.person_id,
        journey_id: promoted.journey_id,
        created_person: stored
            .get("created_person")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        owner_id,
    }))
}

/// What the inbox shows about a promoted person's prospect (`inbox.context`,
/// `inbox.people.get`): the business facts, each contact field's evidence (its sources and when
/// they were read, never the value: the person's identities hold that), the signals, and the
/// latest score with its reasons. Read through the link, so the agent sees why this business was
/// chosen.
#[derive(Clone, Debug, Serialize)]
pub struct ProspectSummary {
    pub prospect_id: ProspectId,
    pub business_name: String,
    pub entity_kind: jt_prospects::EntityKind,
    pub sector: Option<String>,
    pub city: Option<String>,
    pub district: Option<String>,
    pub segment_key: Option<String>,
    pub language: Option<String>,
    pub origin: jt_prospects::OriginVia,
    pub research_task_id: Option<jt_prospects::ResearchTaskId>,
    pub evidence: Vec<FieldEvidence>,
    pub signals: Vec<Signal>,
    pub latest_score: Option<ScoreSummary>,
    /// The reasons of the latest score still held.
    pub reasons: Vec<Reason>,
    pub promotion: Option<Promotion>,
}

/// One contact field's evidence.
#[derive(Clone, Debug, Serialize)]
pub struct FieldEvidence {
    pub field: &'static str,
    pub sources: Vec<SourceRef>,
    #[serde(with = "time::serde::rfc3339")]
    pub captured_at: OffsetDateTime,
    pub deliverable: bool,
}

/// The summary of the prospect promoted into `person`, if one was.
pub(crate) async fn summary_for(
    r: &mut dyn TenantRepos,
    person: PersonId,
) -> Result<Option<ProspectSummary>, AppError> {
    let Some(p) = r.prospects().by_person(person).await? else {
        return Ok(None);
    };
    let reasons = r
        .prospects()
        .scores(p.id, 1)
        .await?
        .into_iter()
        .next()
        .filter(|s| p.latest_score.as_ref().is_some_and(|l| l.at == s.at))
        .map(|s| s.reasons)
        .unwrap_or_default();
    let mut evidence = Vec::new();
    let c = &p.contact;
    for (name, field) in [
        ("phone", c.phone.as_ref()),
        ("email", c.email.as_ref()),
        ("website", c.website.as_ref()),
        ("instagram", c.instagram.as_ref()),
        ("tiktok", c.tiktok.as_ref()),
        ("address", c.address.as_ref()),
    ] {
        if let Some(f) = field {
            evidence.push(FieldEvidence {
                field: name,
                sources: f.evidence.sources.clone(),
                captured_at: f.evidence.captured_at,
                deliverable: f.deliverable,
            });
        }
    }
    if let Some(f) = &c.contact_person {
        evidence.push(FieldEvidence {
            field: "contact_person",
            sources: f.evidence.sources.clone(),
            captured_at: f.evidence.captured_at,
            deliverable: f.deliverable,
        });
    }
    Ok(Some(ProspectSummary {
        prospect_id: p.id,
        business_name: p.business_name,
        entity_kind: p.entity_kind,
        sector: p.sector,
        city: p.city,
        district: p.district,
        segment_key: p.segment_key,
        language: p.language,
        origin: p.origin.via,
        research_task_id: p.research_task_id,
        evidence,
        signals: p.signals,
        latest_score: p.latest_score,
        reasons,
        promotion: p.promoted,
    }))
}
