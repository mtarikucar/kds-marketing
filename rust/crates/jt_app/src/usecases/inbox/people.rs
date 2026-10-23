//! Identity matching is shared with inbound consumption. It never steals an active identity.
use super::record;
use crate::{
    ctx::Ctx,
    error::{AppError, ErrorCode},
    ports::{TenantRepos, inbox::MergeRow},
    usecases::{Deps, invalid, required},
};
use jt_capability::CapabilityId;
use jt_inbox::*;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeSet;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IdentityInput {
    pub channel: IdentityChannel,
    pub value: String,
    pub capability_id: Option<CapabilityId>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInput {
    pub display_name: String,
    pub identities: Vec<IdentityInput>,
    pub source: Source,
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SearchInput {
    #[serde(default)]
    pub q: String,
    pub limit: Option<u32>,
}
#[derive(Debug, Serialize)]
pub struct CreateOut {
    pub person: Person,
    pub created: bool,
}
#[derive(Debug, Serialize)]
pub struct PersonOut {
    pub person: Person,
    pub identities: Vec<Identity>,
    pub open_journey: Option<Journey>,
    pub conversations: Vec<Conversation>,
}

pub async fn search(deps: &Deps, ctx: &Ctx, input: SearchInput) -> Result<Vec<Person>, AppError> {
    ctx.require(Permission::InboxWork)?;
    deps.uow
        .tenant(ctx.workspace_id)
        .await?
        .people()
        .search(&input.q, input.limit.unwrap_or(50))
        .await
}
pub async fn get(deps: &Deps, ctx: &Ctx, id: PersonId) -> Result<PersonOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let person = resolve(r.as_mut(), id).await?;
    Ok(PersonOut {
        identities: r.identities().list(person.id).await?,
        open_journey: r.journeys().open_for(person.id).await?,
        conversations: r.conversations().list(Some(person.id), 500).await?,
        person,
    })
}
pub async fn create(deps: &Deps, ctx: &Ctx, input: CreateInput) -> Result<CreateOut, AppError> {
    ctx.require(Permission::InboxWork)?;
    required("display_name", &input.display_name)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let result = match_or_create(deps, ctx, r.as_mut(), input, None).await;
    // A split persists only its review suggestion; no person, identity or journey has changed.
    match result {
        Ok(out) => {
            r.commit().await?;
            Ok(out)
        }
        Err(e) if e.details["reason"] == "identity_split" => {
            r.commit().await?;
            Err(e)
        }
        Err(e) => Err(e),
    }
}

/// Reuse inside the consumer's transaction. `own_identity` is the index of the message sender's
/// identity in `input.identities`, never a client-controlled preferred person. Acquire the
/// workspace lock before matching so simultaneous first contacts cannot create extra people.
pub(crate) async fn match_or_create(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    input: CreateInput,
    own_identity: Option<usize>,
) -> Result<CreateOut, AppError> {
    if input.identities.is_empty() {
        return Err(invalid("identities", "at least one identity is required"));
    }
    if own_identity.is_some_and(|i| i >= input.identities.len()) {
        return Err(AppError::internal("missing own-channel identity"));
    }
    r.people().lock_workspace().await?;
    let mut normalized = Vec::new();
    let mut matches = Vec::new();
    for identity in &input.identities {
        let value = normalize(r, identity).await?;
        super::erasure::check_identity(r, identity.channel, &value).await?;
        let found = r
            .people()
            .find_by_identity(identity.channel, &value)
            .await?;
        normalized.push(value);
        matches.push(found);
    }
    let ids: BTreeSet<_> = matches.iter().flatten().map(|p| p.id).collect();
    if ids.len() > 1 && own_identity.is_none() {
        let persons: Vec<_> = matches.iter().flatten().collect();
        let first = persons[0];
        let other = persons
            .iter()
            .find(|p| p.id != first.id)
            .expect("two distinct matches");
        let suggestion = suggest(deps, ctx, r, first, other, true).await?;
        return Err(AppError {
            code: ErrorCode::Conflict,
            message: "identities belong to different people".into(),
            details: json!({"reason":"identity_split", "person_ids":ids, "merge_suggestion":suggestion}),
        });
    }
    let selected = choose_person(&matches, own_identity);
    let created = selected.is_none();
    let person = if let Some(person) = selected {
        resolve(r, person.id).await?
    } else {
        let person = Person {
            id: PersonId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            display_name: input.display_name,
            company: String::new(),
            first_touch: FirstTouch {
                source: input.source.clone(),
                capability_id: own_identity.and_then(|i| input.identities[i].capability_id),
                at: ctx.now,
            },
            merged_into: None,
            erased_at: None,
            created_at: ctx.now,
            updated_at: ctx.now,
        };
        r.people().insert(person.clone()).await?;
        let journey = super::journeys::initial(deps, ctx, person.id, input.source);
        r.journeys().insert_initial(journey).await?;
        record(
            r,
            ctx,
            "inbox.person.created",
            "person",
            person.id,
            json!({}),
        )
        .await?;
        person
    };
    let mut suggested = BTreeSet::new();
    for ((identity, value), existing) in input.identities.iter().zip(normalized).zip(matches) {
        if let Some(other) = existing {
            if other.id != person.id && suggested.insert(other.id) {
                suggest(deps, ctx, r, &person, &other, true).await?;
            }
            continue;
        }
        // Repeated equivalent identities within a single request insert only once.
        if r.people()
            .find_by_identity(identity.channel, &value)
            .await?
            .is_none()
        {
            insert_identity(deps, ctx, r, person.id, identity, value).await?;
            if !created {
                record(
                    r,
                    ctx,
                    "inbox.identity.added",
                    "person",
                    person.id,
                    json!({"channel": identity.channel}),
                )
                .await?;
            }
        }
    }
    Ok(CreateOut { person, created })
}

pub(crate) async fn resolve(r: &mut dyn TenantRepos, mut id: PersonId) -> Result<Person, AppError> {
    let mut seen = BTreeSet::new();
    loop {
        if !seen.insert(id) {
            return Err(AppError::internal("cyclic person alias"));
        }
        let person = r
            .people()
            .lock(id)
            .await?
            .ok_or_else(|| AppError::not_found("no such person"))?;
        if person.erased_at.is_some() {
            return Err(AppError::not_found("person was erased"));
        }
        if let Some(keeper) = person.merged_into {
            id = keeper;
        } else {
            return Ok(person);
        }
    }
}
async fn normalize(r: &mut dyn TenantRepos, input: &IdentityInput) -> Result<String, AppError> {
    let value =
        normalise(input.channel, &input.value).map_err(|_| invalid("value", "invalid identity"))?;
    if matches!(
        input.channel,
        IdentityChannel::Phone | IdentityChannel::Email
    ) {
        return Ok(value);
    }
    let id = input
        .capability_id
        .ok_or_else(|| invalid("capability_id", "opaque identities require an account"))?;
    let capability = r
        .capabilities()
        .find(id)
        .await?
        .ok_or_else(|| AppError::not_found("no such capability"))?;
    if channel_for_kind(&capability.kind_key).map(Channel::identity_channel) != Some(input.channel)
    {
        return Err(invalid(
            "capability_id",
            "capability channel does not match identity",
        ));
    }
    Ok(scope_opaque(
        capability
            .external_id
            .as_deref()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| invalid("capability_id", "capability has no external account id"))?,
        &value,
    ))
}
async fn insert_identity(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    person_id: PersonId,
    input: &IdentityInput,
    value: String,
) -> Result<(), AppError> {
    r.identities()
        .insert(Identity {
            id: IdentityId::from(deps.ids.uuid()),
            workspace_id: ctx.workspace_id,
            person_id,
            channel: input.channel,
            value_normalized: value,
            value_display: input.value.clone(),
            active: true,
            first_seen_at: ctx.now,
        })
        .await
}
async fn view(r: &mut dyn TenantRepos, p: &Person) -> Result<PersonView, AppError> {
    let ids = r.identities().list(p.id).await?;
    let value = |channel| {
        ids.iter()
            .find(|i| i.channel == channel)
            .map(|i| i.value_normalized.clone())
            .unwrap_or_default()
    };
    Ok(PersonView {
        id: p.id,
        created_at: p.created_at,
        open_journeys: u32::from(r.journeys().open_for(p.id).await?.is_some()),
        display_name: p.display_name.clone(),
        company: p.company.clone(),
        email: value(IdentityChannel::Email),
        phone: value(IdentityChannel::Phone),
    })
}
async fn suggest(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    a: &Person,
    b: &Person,
    split: bool,
) -> Result<Value, AppError> {
    let decision = decide_merge(&view(r, a).await?, &view(r, b).await?);
    let conflicts = match &decision {
        MergeDecision::Suggest(c) => c.clone(),
        MergeDecision::Auto { .. } => vec![],
    };
    let decision = MergeDecision::Suggest(conflicts.clone());
    let id = MergeId::from(deps.ids.uuid());
    // Identity splits always require an explicit decision, including otherwise compatible pairs.
    r.merges().insert(MergeRow { id, workspace_id: ctx.workspace_id, source_id: b.id, target_id: a.id, decision: MergeDecision::Suggest(conflicts.clone()), conflicts, status: "suggested".into(), moved_snapshot: json!({"reason":if split {"identity_split"} else {"identity_collision"}}), at: ctx.now, applied_by: None, undone_at: None }).await?;
    record(
        r,
        ctx,
        "inbox.merge.suggested",
        "merge",
        id,
        json!({"source_id":b.id,"target_id":a.id}),
    )
    .await?;
    Ok(json!({"id":id,"person_ids":[a.id,b.id],"decision":decision}))
}
pub async fn add_identity(
    deps: &Deps,
    ctx: &Ctx,
    id: PersonId,
    input: IdentityInput,
) -> Result<Value, AppError> {
    ctx.require(Permission::InboxWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    r.people().lock_workspace().await?;
    let person = resolve(r.as_mut(), id).await?;
    let value = normalize(r.as_mut(), &input).await?;
    super::erasure::check_identity(r.as_mut(), input.channel, &value).await?;
    let out = if let Some(other) = r.people().find_by_identity(input.channel, &value).await? {
        if other.id == person.id {
            json!({"status":"added","person_id":person.id})
        } else {
            let suggestion = suggest(deps, ctx, r.as_mut(), &person, &other, false).await?;
            json!({"status":"merge_suggested","merge_suggestion":suggestion})
        }
    } else {
        insert_identity(deps, ctx, r.as_mut(), person.id, &input, value).await?;
        record(
            r.as_mut(),
            ctx,
            "inbox.identity.added",
            "person",
            person.id,
            json!({"channel":input.channel}),
        )
        .await?;
        json!({"status":"added","person_id":person.id})
    };
    r.commit().await?;
    Ok(out)
}

/// Prefer the message sender. Without that match, a single unambiguous person can be reused.
fn choose_person(matches: &[Option<Person>], own_identity: Option<usize>) -> Option<Person> {
    if let Some(person) = own_identity
        .and_then(|i| matches.get(i))
        .and_then(Option::as_ref)
    {
        return Some(person.clone());
    }
    let ids: BTreeSet<_> = matches.iter().flatten().map(|p| p.id).collect();
    if ids.len() == 1 {
        matches.iter().flatten().next().cloned()
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn message_own_channel_wins_over_other_identity() {
        let a: Person = serde_json::from_value(json!({"id":PersonId::new_v7(),"workspace_id":jt_tenancy::WorkspaceId::new_v7(),"first_touch":{"source":"form"}})).unwrap();
        let b = Person {
            id: PersonId::new_v7(),
            ..a.clone()
        };
        let matches = vec![Some(a.clone()), Some(b.clone())];
        assert_eq!(choose_person(&matches, Some(0)).unwrap().id, a.id);
        assert_eq!(choose_person(&matches, Some(1)).unwrap().id, b.id);
        assert!(choose_person(&matches, None).is_none());
        assert!(choose_person(&[None, Some(a), Some(b)], Some(0)).is_none());
    }
}
