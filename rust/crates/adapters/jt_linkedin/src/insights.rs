//! Counters of an organization's posts and of the organization (see the crate docs,
//! "Counters"); a member has none LinkedIn opens to apps.

use std::collections::BTreeMap;

use jt_app::ports::connectors::{AccountMetrics, PostMetrics};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::Value;

use crate::client::{Auth, Body, Endpoint, missing, pct};
use crate::credential::{Kind, ORGANIZATION_URN, account_of, kind_of, post_urn, token_of};
use crate::{FOLLOWER_COUNT, LinkedinConnector, POST_METRICS};

/// Why a member's post counters are refused: LinkedIn opens none to apps (`r_member_social` is
/// restricted).
pub(crate) const MEMBER_POST_METRICS: &str = "LinkedIn exposes no member post metrics";

/// Why a member's account counters are refused.
pub(crate) const MEMBER_ACCOUNT_METRICS: &str = "LinkedIn exposes no member account metrics";

/// The counters of `statistics` (a `totalShareStatistics`), whole numbers only, under
/// [`POST_METRICS`]' names.
fn counters(statistics: &Value) -> BTreeMap<String, i64> {
    POST_METRICS
        .iter()
        .filter_map(|(linkedin, ours)| {
            statistics[*linkedin]
                .as_i64()
                .map(|v| ((*ours).to_owned(), v))
        })
        .collect()
}

/// The counters of the page post `post` (its URN: `urn:li:share:N` or `urn:li:ugcPost:N`).
pub(crate) async fn post_metrics(
    connector: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
    post: &str,
) -> Result<PostMetrics, ConnectorError> {
    if kind_of(public)? == Kind::Member {
        return Err(ConnectorError::permanent(MEMBER_POST_METRICS));
    }
    let token = token_of(cred, "read counters")?;
    let organization = account_of(Kind::Page, public)?;
    let urn = post_urn(post.trim())
        .ok_or_else(|| ConnectorError::permanent("not a LinkedIn post URN"))?;
    let (list, field) = if urn.starts_with("urn:li:ugcPost:") {
        ("ugcPosts", "ugcPost")
    } else {
        ("shares", "share")
    };
    let query = format!(
        "q=organizationalEntity&organizationalEntity={}&{list}=List({})",
        pct(&format!("{ORGANIZATION_URN}{organization}")),
        pct(urn)
    );
    let url = connector.rest_url(&["organizationalEntityShareStatistics"], Some(&query));
    let answer = connector
        .call(
            Method::GET,
            url,
            Auth::Bearer(token),
            &Body::Empty,
            Endpoint::Rest,
        )
        .await?;
    let elements = answer.json()?["elements"]
        .as_array()
        .ok_or_else(|| missing("share statistics"))?;
    // LinkedIn leaves a post with no actions and no impressions out: every counter is zero.
    let metrics = match elements.iter().find(|e| e[field].as_str() == Some(urn)) {
        Some(element) => counters(&element["totalShareStatistics"]),
        None => POST_METRICS
            .iter()
            .map(|(_, ours)| ((*ours).to_owned(), 0))
            .collect(),
    };
    Ok(PostMetrics { metrics })
}

/// The counters of the page itself: `follower_count`, its `firstDegreeSize`.
pub(crate) async fn account_metrics(
    connector: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
) -> Result<AccountMetrics, ConnectorError> {
    if kind_of(public)? == Kind::Member {
        return Err(ConnectorError::permanent(MEMBER_ACCOUNT_METRICS));
    }
    let token = token_of(cred, "read counters")?;
    let organization = account_of(Kind::Page, public)?;
    let urn = pct(&format!("{ORGANIZATION_URN}{organization}"));
    let url = connector.rest_url(
        &["networkSizes", &urn],
        Some("edgeType=COMPANY_FOLLOWED_BY_MEMBER"),
    );
    let answer = connector
        .call(
            Method::GET,
            url,
            Auth::Bearer(token),
            &Body::Empty,
            Endpoint::Rest,
        )
        .await?;
    let followers = answer.json()?["firstDegreeSize"]
        .as_i64()
        .ok_or_else(|| missing("follower count"))?;
    Ok(AccountMetrics {
        metrics: BTreeMap::from([(FOLLOWER_COUNT.to_owned(), followers)]),
    })
}
