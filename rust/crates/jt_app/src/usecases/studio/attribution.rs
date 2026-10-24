//! Read-only joins of immutable M2b acquisition evidence; never an intake or reward writer.
use super::chain::{active, capability_access, same_account};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{EventOrder, EventQuery, TenantRepos, inbox::AttributionReader},
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
    },
};
use jt_capability::{Capability, CapabilityId};
use jt_connector::{EventKind, Provider};
use jt_inbox::JourneyId;
use jt_strategy::LaneKind;
use jt_studio::{AdSetBinding, AdSetBindingId, Chain};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use time::OffsetDateTime;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AttributionQuery {
    pub binding_id: AdSetBindingId,
    pub ad_id: String,
    #[serde(with = "time::serde::rfc3339")]
    pub from: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339")]
    pub to: OffsetDateTime,
}
/// No provider lead/form identifiers, bodies, names or contact details escape this projection.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct AttributedJourney {
    pub journey_id: JourneyId,
    #[serde(with = "time::serde::rfc3339")]
    pub acquired_at: OffsetDateTime,
    pub binding_id: Option<AdSetBindingId>,
    pub chain: Option<Chain>,
    pub erased: bool,
}
/// Internal learned/overview projection, not a new catalog operation. Historical reads use
/// the birth frame after archive; current group restrictions apply while a frame is active.
pub async fn attribution_for_ad(
    d: &Deps,
    ctx: &Ctx,
    input: AttributionQuery,
) -> Result<Vec<AttributedJourney>, AppError> {
    ctx.require(Permission::StudioWork)?;
    if input.from >= input.to || input.ad_id.trim().is_empty() || input.ad_id.len() > 200 {
        return Err(AppError::validation(
            "invalid attribution query",
            json!({"field":"ad_id/from/to"}),
        ));
    }
    let before = {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        active(r.as_mut()).await?;
        proof_context(r.as_mut(), input.binding_id, d.clock.now()).await?
    };
    let evidence = d
        .attribution()
        .by_ad(ctx.workspace_id, &input.ad_id, input.from, input.to)
        .await?;
    if evidence.is_empty() {
        return Ok(Vec::new());
    }
    // Provider calls carry only the Ads credential, and never hold tenant locks.
    let proof = if let Some(context) = &before {
        account_proof(
            d,
            context,
            &input.ad_id,
            evidence.iter().any(|a| a.adset_id.is_none()),
        )
        .await?
    } else {
        None
    };
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    active(r.as_mut()).await?;
    let fresh = proof_context(r.as_mut(), input.binding_id, d.clock.now()).await?;
    // Recheck connector identity, group membership and binding uniqueness after I/O.
    let proof = proof.filter(|_| before == fresh);
    let pages = if proof.is_some() {
        acquisition_pages(
            r.as_mut(),
            evidence.iter().map(|a| a.leadgen_id.clone()).collect(),
        )
        .await?
    } else {
        BTreeMap::new()
    };
    let mut out = Vec::with_capacity(evidence.len());
    for a in evidence {
        let Some(j) = r.journeys().get(a.journey_id).await? else {
            continue;
        };
        let Some(person) = r.people().get(j.person_id).await? else {
            continue;
        };
        let proven = match (&fresh, &proof) {
            (Some(context), Some(proof)) => {
                a.provider == "meta"
                    && a.ad_id.as_deref() == Some(input.ad_id.as_str())
                    && pages
                        .get(&a.leadgen_id)
                        .is_some_and(|(id, page)| context.pages.get(id) == Some(page))
                    && a.adset_id.as_deref().or(proof.resolved_adset.as_deref())
                        == Some(context.binding.adset_id.as_str())
                    && a.adset_id.as_deref().is_none_or(|id| {
                        proof
                            .resolved_adset
                            .as_deref()
                            .is_none_or(|resolved| id == resolved)
                    })
                    && a.campaign_id
                        .as_ref()
                        .is_none_or(|id| proof.campaign_id.as_ref() == Some(id))
            }
            _ => false,
        };
        out.push(AttributedJourney {
            journey_id: a.journey_id,
            acquired_at: a.acquired_at,
            binding_id: proven.then_some(input.binding_id),
            chain: fresh
                .as_ref()
                .filter(|_| proven)
                .map(|c| c.binding.chain.clone()),
            erased: person.erased_at.is_some(),
        });
    }
    Ok(out)
}

#[derive(PartialEq)]
struct ProofContext {
    binding: AdSetBinding,
    capability: Capability,
    sealed: Vec<u8>,
    pages: BTreeMap<CapabilityId, String>,
}
async fn proof_context(
    r: &mut dyn TenantRepos,
    id: AdSetBindingId,
    now: OffsetDateTime,
) -> Result<Option<ProofContext>, AppError> {
    let b = r
        .studio()
        .get_binding(id)
        .await?
        .ok_or_else(|| AppError::not_found("binding"))?;
    let Some(c) = r.capabilities().find(b.capability_id).await? else {
        return Ok(None);
    };
    if c.kind_key != "meta_ads"
        || capability_access(&c, now, false).is_err()
        || !c
            .external_id
            .as_deref()
            .is_some_and(|id| same_account("meta_ads", id, &b.account_id))
    {
        return Ok(None);
    }
    let Some(sealed) = r.capabilities().read_sealed(c.id).await? else {
        return Ok(None);
    };
    let Some(arm) = r.studio().get_arm(b.chain.arm_id).await? else {
        return Ok(None);
    };
    let Some(birth) = r.strategy().find(b.chain.born_version_id).await? else {
        return Ok(None);
    };
    if b.chain.workspace_id != c.workspace_id
        || arm.workspace_id != c.workspace_id
        || arm.key.hypothesis_id != b.chain.hypothesis_id
        || arm.key.lane != LaneKind::Paid
        || arm.key.channel != "meta_ads"
        || !r
            .hypotheses()
            .list(birth.id)
            .await?
            .iter()
            .any(|h| h.id == b.chain.hypothesis_id)
    {
        return Ok(None);
    }
    // Multiple capabilities for the same provider account must not credit multiple arms.
    let count = r
        .studio()
        .list_bindings()
        .await?
        .iter()
        .filter(|other| {
            same_account("meta_ads", &other.account_id, &b.account_id)
                && other.adset_id == b.adset_id
        })
        .count();
    if count != 1 {
        return Ok(None);
    }
    let frame = r.strategy().current_approved().await?.unwrap_or(birth);
    let selected: BTreeSet<_> = frame
        .sections
        .channels
        .iter()
        .filter(|choice| matches!(choice.channel.as_str(), "meta_ads" | "any"))
        .filter_map(|choice| choice.group_id)
        .collect();
    let mut pages = BTreeMap::new();
    for (group, members) in r.capability_groups().list().await? {
        if !selected.contains(&group.id.0) || !members.contains(&c.id) {
            continue;
        }
        for id in members {
            if let Some(page) = r.capabilities().find(id).await?
                && matches!(page.kind_key.as_str(), "facebook_page" | "messenger")
                && let Some(external) = page.external_id
            {
                pages.insert(id, external);
            }
        }
    }
    if pages.is_empty() {
        return Ok(None);
    }
    Ok(Some(ProofContext {
        binding: b,
        capability: c,
        sealed,
        pages,
    }))
}
struct AccountProof {
    resolved_adset: Option<String>,
    campaign_id: Option<String>,
}
async fn account_proof(
    d: &Deps,
    c: &ProofContext,
    ad: &str,
    needs_resolution: bool,
) -> Result<Option<AccountProof>, AppError> {
    let Some(ads) = d.connectors.ads(Provider::Meta) else {
        return Ok(None);
    };
    let credential = open_credential(d, c.capability.workspace_id, &c.sealed)?;
    let public = adapter_public(&c.capability);
    let Ok(account) = ads.account_context(&credential, &public).await else {
        return Ok(None);
    };
    if !same_account("meta_ads", &account.account_id, &c.binding.account_id) {
        return Ok(None);
    }
    let Ok(sets) = ads.list_adsets(&credential, &public).await else {
        return Ok(None);
    };
    let matches: Vec<_> = sets.iter().filter(|s| s.id == c.binding.adset_id).collect();
    if matches.len() != 1 {
        return Ok(None);
    }
    let set = matches[0];
    if c.binding
        .campaign_id
        .as_ref()
        .is_some_and(|id| set.campaign_id.as_ref() != Some(id))
    {
        return Ok(None);
    }
    let resolved_adset = if needs_resolution {
        // Resolution failure leaves missing evidence missing; it does not erase independently
        // stored ad-set evidence that the account listing just verified.
        ads.resolve_adset(&credential, &public, ad)
            .await
            .ok()
            .flatten()
    } else {
        None
    };
    Ok(Some(AccountProof {
        resolved_adset,
        campaign_id: set.campaign_id.clone(),
    }))
}

/// M2b retains event identity/capability after raw retention. Walk keyset pages so old
/// acquisitions cannot disappear behind a listing limit. Payloads never leave this helper.
async fn acquisition_pages(
    r: &mut dyn TenantRepos,
    mut leads: BTreeSet<String>,
) -> Result<BTreeMap<String, (CapabilityId, String)>, AppError> {
    let mut out = BTreeMap::new();
    let mut after = None;
    while !leads.is_empty() {
        let events = r
            .inbound_events()
            .list(EventQuery {
                pending_only: false,
                provider: Some(Provider::Meta),
                kind: Some(EventKind::LeadGen),
                order: EventOrder::OldestFirst { after },
                limit: 100,
            })
            .await?;
        let Some(last) = events.last() else { break };
        after = Some((last.received_at, last.id));
        for event in events {
            if let Some(lead) = event.external_id.strip_prefix("leadgen:")
                && leads.remove(lead)
                && let Some(id) = event.capability_id
                && let Some(page) = event.payload["leadgen"]["page_id"].as_str()
            {
                out.insert(lead.to_owned(), (id, page.to_owned()));
            }
        }
    }
    Ok(out)
}
