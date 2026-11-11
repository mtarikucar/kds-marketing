//! What a credential reaches: the member it signs in as (`GET /v2/userinfo`) and the
//! organizations the member administers (`GET /rest/organizationAcls`), as the assets an OAuth
//! flow offers and as the probe's identity.

use std::collections::BTreeMap;
use std::time::Instant;

use jt_app::ports::connectors::Asset;
use jt_connector::{ConnectorError, Credential, ProbeResult};
use jt_outbound::Method;
use serde_json::{Map, Value, json};

use crate::client::{Auth, Body, Endpoint, missing, text};
use crate::credential::{
    Kind, account_of, granted, kind_of, organization_of_urn, person_id, token_of,
};
use crate::{ACL_PAGE_SIZE, LinkedinConnector, MAX_ACL_PAGES};

/// The role and state of an organization access entry that makes the member its administrator.
const ADMINISTRATOR: &str = "ADMINISTRATOR";
const APPROVED: &str = "APPROVED";

/// The most organizations named in one batch lookup.
const LOOKUP_BATCH: usize = 50;

/// Why a page probe fails when the credential's access list does not name the organization.
pub(crate) const NOT_ADMINISTERED: &str = "the credential administers no such organization";

/// The member `token` signs in as: the answer of `GET /v2/userinfo`, and its `sub`.
pub(crate) async fn userinfo(
    connector: &LinkedinConnector,
    token: &str,
) -> Result<(String, Value), ConnectorError> {
    let url = connector.api_url(&["v2", "userinfo"], &[]);
    let answer = connector
        .call(
            Method::GET,
            url,
            Auth::Bearer(token),
            &Body::Empty,
            Endpoint::OpenId,
        )
        .await?;
    let info = answer.json()?.clone();
    let sub = text(&info["sub"])
        .filter(|s| person_id(s).is_some())
        .ok_or_else(|| missing("member id (sub)"))?;
    Ok((sub, info))
}

/// The organizations `token`'s member administers, by number, in the order LinkedIn lists them:
/// the access entries of `GET /rest/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED`
/// whose role is `ADMINISTRATOR` and state `APPROVED`, paged by `start` (a page with no entries, a
/// short page without a `next` link, or the `total` reached ends it), at most [`MAX_ACL_PAGES`]
/// pages. `stop` ends the reading early once it says so of an organization (the probe looks for
/// one).
pub(crate) async fn administered(
    connector: &LinkedinConnector,
    token: &str,
    stop: impl Fn(&str) -> bool,
) -> Result<Vec<String>, ConnectorError> {
    let mut organizations: Vec<String> = Vec::new();
    let mut start = 0usize;
    for _ in 0..MAX_ACL_PAGES {
        let query = format!(
            "q=roleAssignee&role={ADMINISTRATOR}&state={APPROVED}&start={start}&count={ACL_PAGE_SIZE}"
        );
        let url = connector.rest_url(&["organizationAcls"], Some(&query));
        let answer = connector
            .call(
                Method::GET,
                url,
                Auth::Bearer(token),
                &Body::Empty,
                Endpoint::Rest,
            )
            .await?;
        let page = answer.json()?;
        let elements = page["elements"]
            .as_array()
            .ok_or_else(|| missing("organization access list"))?;
        for element in elements {
            let administrator = element["role"].as_str() == Some(ADMINISTRATOR)
                && element["state"].as_str() == Some(APPROVED);
            let organization = [&element["organization"], &element["organizationTarget"]]
                .into_iter()
                .filter_map(Value::as_str)
                .find_map(organization_of_urn);
            if let (true, Some(id)) = (administrator, organization) {
                if !organizations.iter().any(|o| o == id) {
                    organizations.push(id.to_owned());
                }
                if stop(id) {
                    return Ok(organizations);
                }
            }
        }
        let next = page["paging"]["links"]
            .as_array()
            .is_some_and(|links| links.iter().any(|l| l["rel"].as_str() == Some("next")));
        let total = page["paging"]["total"].as_u64();
        start += elements.len();
        let done = elements.is_empty()
            || total.is_some_and(|t| start as u64 >= t)
            || (!next && elements.len() < ACL_PAGE_SIZE);
        if done {
            return Ok(organizations);
        }
    }
    Err(ConnectorError::permanent(format!(
        "the organization access list runs over more than {MAX_ACL_PAGES} pages"
    )))
}

/// The organizations `ids` as LinkedIn describes them to their administrator, by number
/// (`GET /rest/organizations?ids=List(...)`, in batches of [`LOOKUP_BATCH`]); one LinkedIn does
/// not describe is absent.
async fn organizations(
    connector: &LinkedinConnector,
    token: &str,
    ids: &[String],
) -> Result<BTreeMap<String, Value>, ConnectorError> {
    let mut found = BTreeMap::new();
    for batch in ids.chunks(LOOKUP_BATCH) {
        let query = format!("ids=List({})", batch.join(","));
        let url = connector.rest_url(&["organizations"], Some(&query));
        let answer = connector
            .call(
                Method::GET,
                url,
                Auth::Bearer(token),
                &Body::Empty,
                Endpoint::Rest,
            )
            .await?;
        if let Some(results) = answer.json()?["results"].as_object() {
            for (id, organization) in results {
                if batch.contains(id) {
                    found.insert(id.clone(), organization.clone());
                }
            }
        }
    }
    Ok(found)
}

/// Whether the part `part` of what a credential reaches may be left out after `e` (the member is
/// not allowed to read it, or LinkedIn refuses it): logged at `debug` with the error's kind and
/// reason (redacted when the error was built). Every other failure fails the call.
fn skippable(e: &ConnectorError, part: &'static str) -> bool {
    let skip = matches!(
        e,
        ConnectorError::Permission { .. } | ConnectorError::Permanent { .. }
    );
    if skip {
        tracing::debug!(
            part,
            error_kind = e.kind(),
            reason = e.reason().unwrap_or_default(),
            "a part of the LinkedIn lookup was left out"
        );
    }
    skip
}

/// The organization's name in `organization` (`localizedName`), when it has one.
fn name_of(organization: &Value) -> Option<String> {
    text(&organization["localizedName"])
}

/// What `cred` reaches: the member (with `openid` or `profile` granted) as `linkedin_member`,
/// and each organization the member administers (with `rw_organization_admin` granted) as
/// `linkedin_page`; nothing is asked about what the credential was not granted.
pub(crate) async fn list_assets(
    connector: &LinkedinConnector,
    cred: &Credential,
) -> Result<Vec<Asset>, ConnectorError> {
    let token = token_of(cred, "list accounts")?;
    let mut assets = Vec::new();
    if granted(cred, "openid") || granted(cred, "profile") {
        let (sub, info) = userinfo(connector, token).await?;
        let name = text(&info["name"]);
        let mut public = Map::new();
        if let Some(name) = &name {
            public.insert("name".to_owned(), json!(name));
        }
        if let Some(picture) = info["picture"]
            .as_str()
            .filter(|p| p.starts_with("https://"))
        {
            public.insert("picture".to_owned(), json!(picture));
        }
        assets.push(Asset {
            kind_key: "linkedin_member".to_owned(),
            name: name.unwrap_or_else(|| sub.clone()),
            external_id: sub,
            credential: cred.clone(),
            public: Value::Object(public),
        });
    }
    if granted(cred, "rw_organization_admin") {
        let ids = administered(connector, token, |_| false).await?;
        let described = match organizations(connector, token, &ids).await {
            Ok(described) => described,
            Err(e) if skippable(&e, "organization names") => BTreeMap::new(),
            Err(e) => return Err(e),
        };
        for id in ids {
            let organization = described.get(&id);
            let name = organization.and_then(name_of);
            let mut public = Map::new();
            public.insert(
                "organization_urn".to_owned(),
                json!(format!("urn:li:organization:{id}")),
            );
            if let Some(name) = &name {
                public.insert("name".to_owned(), json!(name));
            }
            if let Some(vanity) = organization.and_then(|o| text(&o["vanityName"])) {
                public.insert("vanity_name".to_owned(), json!(vanity));
            }
            assets.push(Asset {
                kind_key: "linkedin_page".to_owned(),
                name: name.unwrap_or_else(|| id.clone()),
                external_id: id,
                credential: cred.clone(),
                public: Value::Object(public),
            });
        }
    }
    Ok(assets)
}

/// The probe of `cred` for the capability whose public fields are `public` (never fails: a
/// failure is the result).
pub(crate) async fn probe(
    connector: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
) -> ProbeResult {
    let started = Instant::now();
    let outcome = facts(connector, cred, public).await;
    let latency_ms = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    match outcome {
        Ok(facts) => ProbeResult::success(latency_ms, facts),
        Err(e) => ProbeResult::failure(latency_ms, e),
    }
}

/// `{account_id, name}` of what the credential itself reaches (see the crate docs, "The probe").
async fn facts(
    connector: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
) -> Result<Value, ConnectorError> {
    let kind = kind_of(public)?;
    let token = token_of(cred, "be probed")?;
    match kind {
        Kind::Member => {
            let (sub, info) = userinfo(connector, token).await?;
            Ok(json!({ "account_id": sub, "name": text(&info["name"]) }))
        }
        Kind::Page => {
            let wanted = account_of(Kind::Page, public)?;
            let administered = administered(connector, token, |id| id == wanted).await?;
            // The number as the access list names it: a node LinkedIn serves only to the
            // member's own token, for an organization the member administers.
            let id = administered
                .into_iter()
                .find(|id| *id == wanted)
                .ok_or_else(|| ConnectorError::permission(NOT_ADMINISTERED))?;
            Ok(json!({ "account_id": id, "name": page_name(connector, token, &id).await }))
        }
    }
}

/// The organization `id`'s name (`GET /rest/organizations/{id}`, which LinkedIn answers for an
/// administrator), best effort: `None` when it cannot be read.
async fn page_name(connector: &LinkedinConnector, token: &str, id: &str) -> Option<String> {
    let url = connector.rest_url(&["organizations", id], None);
    match connector
        .call(
            Method::GET,
            url,
            Auth::Bearer(token),
            &Body::Empty,
            Endpoint::Rest,
        )
        .await
    {
        Ok(answer) => answer.json.as_ref().and_then(name_of),
        Err(e) => {
            tracing::debug!(
                error_kind = e.kind(),
                reason = e.reason().unwrap_or_default(),
                "the LinkedIn page's name could not be read for its probe"
            );
            None
        }
    }
}
