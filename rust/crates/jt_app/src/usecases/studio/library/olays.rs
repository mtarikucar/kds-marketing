//! Olays: the real context of a material (spec §4.1, D3). A human owner or manager creates them
//! confirmed; an agent (or another person) proposes them, and only a confirmed olay makes a
//! material eligible.
use super::{check_people, conflict, decider, invalid, items::MaterialDetail, nullable, open};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::materials::{HumanMark, Olay, OlayClient, OlayId, OlayKind, OlayStatus, ShootRequest},
    usecases::{
        Deps, ledger_entry,
        studio::{
            control::human_required,
            files::{decode, encode, key},
        },
    },
};
use jt_studio::{ShootReason, ShootStatus};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use time::Date;

/// `studio.olay_create`'s input.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OlayCreateInput {
    pub request_key: String,
    pub kind: OlayKind,
    pub title: String,
    #[serde(with = "jt_studio::time_compat::date")]
    pub starts_on: Date,
    #[serde(with = "jt_studio::time_compat::date")]
    pub ends_on: Date,
    #[serde(default)]
    pub place: Option<String>,
    #[serde(default)]
    pub client: Option<OlayClient>,
    #[serde(default)]
    pub notes: String,
    /// The calendar key of a season or special day; absent for the other kinds.
    #[serde(default)]
    pub occasion: Option<String>,
}

/// `studio.olay_update`'s input: the fields given change; `null` clears an optional one.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OlayUpdateInput {
    pub olay_id: OlayId,
    pub expected_revision: u64,
    #[serde(default)]
    pub kind: Option<OlayKind>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default, with = "jt_studio::time_compat::date_option")]
    pub starts_on: Option<Date>,
    #[serde(default, with = "jt_studio::time_compat::date_option")]
    pub ends_on: Option<Date>,
    #[serde(default, deserialize_with = "nullable")]
    pub place: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    pub client: Option<Option<OlayClient>>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub occasion: Option<Option<String>>,
}

/// `studio.olay_confirm`'s input.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OlayConfirmInput {
    pub olay_id: OlayId,
    pub expected_revision: u64,
}

/// One olay, by id.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OlayIdInput {
    pub olay_id: OlayId,
}

/// `studio.olays_list`'s filter.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct OlaysQuery {
    #[serde(default)]
    pub status: Option<OlayStatus>,
}

/// An olay in the list, with how many live materials it has.
#[derive(Clone, Debug, Serialize)]
pub struct OlayListItem {
    pub olay: Olay,
    pub materials: u32,
}

/// An olay with its materials (each with where it was used) and its open çekim listesi requests.
#[derive(Clone, Debug, Serialize)]
pub struct OlayDetail {
    pub olay: Olay,
    pub materials: Vec<MaterialDetail>,
    pub shoot_requests: Vec<ShootRequest>,
}

/// The olay's client person, if any.
fn client_person(client: Option<&OlayClient>) -> Option<uuid::Uuid> {
    client.and_then(|c| c.person_id)
}

/// Every olay, newest start first, with its live materials' count; `status` filters.
pub async fn olays_list(d: &Deps, ctx: &Ctx, q: OlaysQuery) -> Result<Vec<OlayListItem>, AppError> {
    let mut r = open(d, ctx).await?;
    let materials = r.studio_materials().list_materials().await?;
    Ok(r.studio_materials()
        .list_olays()
        .await?
        .into_iter()
        .filter(|o| q.status.is_none_or(|s| o.status == s))
        .map(|olay| OlayListItem {
            materials: materials
                .iter()
                .filter(|m| m.erased_at.is_none() && m.olay_id() == Some(olay.id))
                .count() as u32,
            olay,
        })
        .collect())
}

/// The olay with its materials, their uses and its open requests.
pub async fn olay_get(d: &Deps, ctx: &Ctx, i: OlayIdInput) -> Result<OlayDetail, AppError> {
    let mut r = open(d, ctx).await?;
    let olay = r
        .studio_materials()
        .get_olay(i.olay_id)
        .await?
        .ok_or_else(|| AppError::not_found("olay"))?;
    let mut materials = Vec::new();
    for m in r.studio_materials().list_materials().await? {
        if m.olay_id() == Some(olay.id) {
            materials.push(super::items::detail(r.as_mut(), m).await?);
        }
    }
    let shoot_requests = r
        .studio_materials()
        .list_shoot_requests()
        .await?
        .into_iter()
        .filter(|q| {
            q.status == ShootStatus::Open
                && q.reason == (ShootReason::OlayUpcoming { olay_id: olay.id })
        })
        .collect();
    Ok(OlayDetail {
        olay,
        materials,
        shoot_requests,
    })
}

/// The ledger payload of an olay: its id, kind, status, occasion key and revision.
fn summary(o: &Olay) -> Value {
    json!({"olay_id":o.id,"kind":o.kind,"status":o.status,"occasion":o.occasion,"revision":o.revision})
}

/// Creates an olay: confirmed when an owner or manager creates it in person (D3), proposed when an
/// agent or another person does. Replayed by `request_key`.
pub async fn olay_create(d: &Deps, ctx: &Ctx, i: OlayCreateInput) -> Result<Olay, AppError> {
    key(&i.request_key)?;
    let payload = json!(crate::usecases::hash_token(&encode(&i)?.to_string()));
    let mut r = open(d, ctx).await?;
    let person = client_person(i.client.as_ref());
    if person.is_some() {
        r.people().lock_workspace().await?;
    }
    if let Some(v) = r
        .studio()
        .request_replay("studio.olay_create", &i.request_key, &payload)
        .await?
    {
        return decode(v);
    }
    r.studio_control().lock_control().await?;
    let by = decider(ctx);
    let olay = Olay {
        id: OlayId(d.ids.uuid()),
        workspace_id: ctx.workspace_id,
        kind: i.kind,
        title: i.title,
        starts_on: i.starts_on,
        ends_on: i.ends_on,
        place: i.place,
        client: i.client,
        notes: i.notes,
        occasion: i.occasion,
        status: if by.is_some() {
            OlayStatus::Confirmed
        } else {
            OlayStatus::Proposed
        },
        confirmed: by.map(|by| HumanMark { by, at: ctx.now }),
        revision: 1,
        created_at: ctx.now,
    };
    olay.validate().map_err(invalid)?;
    check_people(r.as_mut(), person).await?;
    r.studio_materials().insert_olay(olay.clone()).await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.olay.created",
            "studio_olay",
            olay.id,
            summary(&olay),
        )?)
        .await?;
    r.studio()
        .request_receipt(
            "studio.olay_create",
            &i.request_key,
            &payload,
            &encode(&olay)?,
        )
        .await?;
    r.commit().await?;
    Ok(olay)
}

/// Changes an olay at its expected revision. A proposed olay may be changed by anyone with
/// `studio.work`; a confirmed one only by an owner or manager in person (an agent may not move a
/// confirmed event's dates or client).
pub async fn olay_update(d: &Deps, ctx: &Ctx, i: OlayUpdateInput) -> Result<Olay, AppError> {
    let mut changed: Vec<&str> = Vec::new();
    for (field, given) in [
        ("kind", i.kind.is_some()),
        ("title", i.title.is_some()),
        ("starts_on", i.starts_on.is_some()),
        ("ends_on", i.ends_on.is_some()),
        ("place", i.place.is_some()),
        ("client", i.client.is_some()),
        ("notes", i.notes.is_some()),
        ("occasion", i.occasion.is_some()),
    ] {
        if given {
            changed.push(field);
        }
    }
    if changed.is_empty() {
        return Err(crate::usecases::nothing_to_change(&[
            "kind",
            "title",
            "starts_on",
            "ends_on",
            "place",
            "client",
            "notes",
            "occasion",
        ]));
    }
    let mut r = open(d, ctx).await?;
    let person = i.client.as_ref().and_then(|c| client_person(c.as_ref()));
    if person.is_some() {
        r.people().lock_workspace().await?;
    }
    r.studio_control().lock_control().await?;
    let current = r
        .studio_materials()
        .get_olay(i.olay_id)
        .await?
        .ok_or_else(|| AppError::not_found("olay"))?;
    if current.is_confirmed() && decider(ctx).is_none() {
        return Err(human_required());
    }
    if current.revision != i.expected_revision {
        return Err(AppError::conflict("olay revision changed"));
    }
    let mut olay = current.clone();
    if let Some(k) = i.kind {
        olay.kind = k;
    }
    if let Some(t) = i.title {
        olay.title = t;
    }
    if let Some(s) = i.starts_on {
        olay.starts_on = s;
    }
    if let Some(e) = i.ends_on {
        olay.ends_on = e;
    }
    if let Some(p) = i.place {
        olay.place = p;
    }
    if let Some(c) = i.client {
        olay.client = c;
    }
    if let Some(n) = i.notes {
        olay.notes = n;
    }
    if let Some(o) = i.occasion {
        olay.occasion = o;
    }
    olay.revision = current
        .revision
        .checked_add(1)
        .ok_or_else(|| AppError::conflict("revision overflow"))?;
    olay.validate().map_err(invalid)?;
    if person != client_person(current.client.as_ref()) {
        check_people(r.as_mut(), person).await?;
    }
    r.studio_materials()
        .update_olay(olay.clone(), i.expected_revision)
        .await?;
    let mut payload = summary(&olay);
    payload["fields"] = json!(changed);
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.olay.updated",
            "studio_olay",
            olay.id,
            payload,
        )?)
        .await?;
    r.commit().await?;
    Ok(olay)
}

/// A human owner or manager confirms a proposed olay (D3, D4): from now on its materials may be
/// eligible.
pub async fn olay_confirm(d: &Deps, ctx: &Ctx, i: OlayConfirmInput) -> Result<Olay, AppError> {
    let by = super::super::control::human_approver(ctx)?;
    let mut r = open(d, ctx).await?;
    r.studio_control().lock_control().await?;
    let current = r
        .studio_materials()
        .get_olay(i.olay_id)
        .await?
        .ok_or_else(|| AppError::not_found("olay"))?;
    if current.revision != i.expected_revision {
        return Err(AppError::conflict("olay revision changed"));
    }
    if current.is_confirmed() {
        return Err(conflict("already_confirmed"));
    }
    let olay = Olay {
        status: OlayStatus::Confirmed,
        confirmed: Some(HumanMark { by, at: ctx.now }),
        revision: current
            .revision
            .checked_add(1)
            .ok_or_else(|| AppError::conflict("revision overflow"))?,
        ..current
    };
    olay.validate().map_err(invalid)?;
    r.studio_materials()
        .update_olay(olay.clone(), i.expected_revision)
        .await?;
    r.ledger()
        .append(ledger_entry(
            ctx,
            "studio.olay.confirmed",
            "studio_olay",
            olay.id,
            summary(&olay),
        )?)
        .await?;
    r.commit().await?;
    Ok(olay)
}
