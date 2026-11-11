//! Reading a built campaign back: how it and each of its ads stand (their status and Google's
//! review of them) and what each ad cost and brought, day by day.

use jt_app::ports::connectors::{
    AdDay, AdObjective, CampaignProviderState, ProviderAd, ProviderAdStatus,
};
use jt_connector::{ConnectorError, Credential};
use serde_json::Value;
use time::{Date, format_description::FormatItem, macros::format_description};

use crate::GoogleConnector;
use crate::account::account_of;
use crate::campaigns::{Entity, exponent, minor, owned};
use crate::client::{int, missing, text};

/// A day as Google writes it in `segments.date` and takes it in a query.
const DAY: &[FormatItem<'static>] = format_description!("[year]-[month]-[day]");

/// How an ad stands, from its own status and Google's review of it. First match wins: an ad
/// Google turned down is that whatever its switch says, and so is one approved only for people
/// interested in the targeted countries ("Will not serve in targeted countries": the campaign
/// targets people present in them, so it runs nowhere); a paused ad is paused; an ad still in
/// review (or under appeal) is in review; any other enabled ad runs.
fn ad_status(ad: &Value) -> ProviderAdStatus {
    let summary = &ad["policySummary"];
    let approval = summary["approvalStatus"].as_str().unwrap_or_default();
    let review = summary["reviewStatus"].as_str().unwrap_or_default();
    match ad["status"].as_str().unwrap_or_default() {
        _ if matches!(approval, "DISAPPROVED" | "AREA_OF_INTEREST_ONLY") => {
            ProviderAdStatus::Disapproved
        }
        "PAUSED" => ProviderAdStatus::Paused,
        "REMOVED" => ProviderAdStatus::Archived,
        "ENABLED" if matches!(review, "REVIEW_IN_PROGRESS" | "UNDER_APPEAL") => {
            ProviderAdStatus::InReview
        }
        // Reviewed, or eligible to serve while the review goes on.
        "ENABLED" => ProviderAdStatus::Active,
        other => ProviderAdStatus::Other(other.to_owned()),
    }
}

/// What Google's review says of an ad, for a person to act on: the policy topics it names, each
/// with how it weighs on the ad (`TOPIC (PROHIBITED)`); `None` when it names none.
fn feedback(ad: &Value) -> Option<String> {
    let topics: Vec<String> = ad["policySummary"]["policyTopicEntries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let topic = entry["topic"].as_str().filter(|t| !t.trim().is_empty())?;
            Some(match entry["type"].as_str() {
                Some(kind) if !kind.is_empty() => format!("{topic} ({kind})"),
                _ => topic.to_owned(),
            })
        })
        .collect();
    let limited = ad["policySummary"]["approvalStatus"].as_str() == Some("AREA_OF_INTEREST_ONLY");
    match (topics.is_empty(), limited) {
        (true, false) => None,
        (true, true) => Some("AREA_OF_INTEREST_ONLY".to_owned()),
        (false, false) => Some(topics.join(", ")),
        (false, true) => Some(format!("AREA_OF_INTEREST_ONLY: {}", topics.join(", "))),
    }
}

pub(crate) async fn campaign_state(
    c: &GoogleConnector,
    cred: &Credential,
    public: &Value,
    campaign_id: &str,
) -> Result<CampaignProviderState, ConnectorError> {
    let customer = account_of(public)?;
    let campaign = owned(campaign_id, Entity::Campaign, &customer)?;
    let token = c.access_token(cred).await?;
    let rows = c
        .search(
            &token,
            &customer,
            &format!(
                "SELECT campaign.resource_name, campaign.status FROM campaign WHERE \
                 campaign.resource_name = '{campaign}'"
            ),
        )
        .await?;
    let row = rows.first().ok_or_else(|| missing("campaign"))?;
    let status = match row["campaign"]["status"].as_str().unwrap_or_default() {
        "ENABLED" => ProviderAdStatus::Active,
        "PAUSED" => ProviderAdStatus::Paused,
        "REMOVED" => ProviderAdStatus::Archived,
        other => ProviderAdStatus::Other(other.to_owned()),
    };
    let rows = c
        .search(
            &token,
            &customer,
            &format!(
                "SELECT ad_group_ad.resource_name, ad_group_ad.status, \
                 ad_group_ad.policy_summary.approval_status, \
                 ad_group_ad.policy_summary.review_status, \
                 ad_group_ad.policy_summary.policy_topic_entries FROM ad_group_ad WHERE \
                 campaign.resource_name = '{campaign}' AND ad_group_ad.status != 'REMOVED'"
            ),
        )
        .await?;
    let ads = rows
        .iter()
        .map(|row| {
            let ad = &row["adGroupAd"];
            let ad_id = text(&ad["resourceName"]).ok_or_else(|| missing("ad resource name"))?;
            owned(&ad_id, Entity::Ad, &customer)?;
            Ok(ProviderAd {
                name: ad_id.clone(),
                ad_id,
                status: ad_status(ad),
                feedback: feedback(ad),
            })
        })
        .collect::<Result<Vec<_>, ConnectorError>>()?;
    Ok(CampaignProviderState {
        campaign: status,
        ads,
    })
}

/// A count Google gives for a day; `None` when the row carries none (never zero for it).
fn count(metrics: &Value, name: &str) -> Result<Option<i64>, ConnectorError> {
    match &metrics[name] {
        Value::Null => Ok(None),
        value => int(value)
            .filter(|n| *n >= 0)
            .map(Some)
            .ok_or_else(|| ConnectorError::permanent(format!("Google's {name} is not a count"))),
    }
}

pub(crate) async fn ad_days(
    c: &GoogleConnector,
    cred: &Credential,
    public: &Value,
    campaign_id: &str,
    objective: AdObjective,
    since: Date,
    until: Date,
) -> Result<Vec<AdDay>, ConnectorError> {
    let customer = account_of(public)?;
    let campaign = owned(campaign_id, Entity::Campaign, &customer)?;
    if objective != AdObjective::Traffic {
        return Err(ConnectorError::permanent(
            "a Google search campaign brings visits to a website only",
        ));
    }
    // Google's day is the account's own: one day more on each side loses none of them.
    let (since, until) = (
        since.previous_day().unwrap_or(since),
        until.next_day().unwrap_or(until),
    );
    let day = |date: Date| {
        date.format(DAY)
            .map_err(|_| ConnectorError::permanent("the day cannot be written"))
    };
    let token = c.access_token(cred).await?;
    let rows = c
        .search(
            &token,
            &customer,
            &format!(
                "SELECT customer.currency_code, ad_group_ad.resource_name, segments.date, \
                 metrics.impressions, metrics.clicks, metrics.cost_micros FROM ad_group_ad WHERE \
                 campaign.resource_name = '{campaign}' AND segments.date BETWEEN '{}' AND '{}'",
                day(since)?,
                day(until)?
            ),
        )
        .await?;
    rows.iter()
        .map(|row| {
            let ad_id = text(&row["adGroupAd"]["resourceName"])
                .ok_or_else(|| missing("ad resource name"))?;
            owned(&ad_id, Entity::Ad, &customer)?;
            let day = row["segments"]["date"]
                .as_str()
                .and_then(|date| Date::parse(date, DAY).ok())
                .ok_or_else(|| missing("day"))?;
            let currency =
                text(&row["customer"]["currencyCode"]).ok_or_else(|| missing("currency"))?;
            let metrics = &row["metrics"];
            let spend_minor = match count(metrics, "costMicros")? {
                Some(micros) => Some(minor(micros, exponent(&currency)?)?),
                None => None,
            };
            let clicks = count(metrics, "clicks")?;
            Ok(AdDay {
                ad_id,
                day,
                spend_minor,
                impressions: count(metrics, "impressions")?,
                clicks,
                // What a search campaign is for here is the visit: a click on the ad.
                results: clicks,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn an_ads_state_is_googles_review_first_then_its_switch() {
        let ad = |status: &str, approval: &str, review: &str| {
            json!({"status":status,"policySummary":{"approvalStatus":approval,
                "reviewStatus":review}})
        };
        for (status, approval, review, expected) in [
            ("ENABLED", "APPROVED", "REVIEWED", ProviderAdStatus::Active),
            (
                "ENABLED",
                "APPROVED_LIMITED",
                "REVIEWED",
                ProviderAdStatus::Active,
            ),
            (
                "ENABLED",
                "",
                "ELIGIBLE_MAY_SERVE",
                ProviderAdStatus::Active,
            ),
            (
                "ENABLED",
                "",
                "REVIEW_IN_PROGRESS",
                ProviderAdStatus::InReview,
            ),
            (
                "ENABLED",
                "DISAPPROVED",
                "UNDER_APPEAL",
                ProviderAdStatus::Disapproved,
            ),
            (
                "PAUSED",
                "DISAPPROVED",
                "REVIEWED",
                ProviderAdStatus::Disapproved,
            ),
            (
                "ENABLED",
                "AREA_OF_INTEREST_ONLY",
                "REVIEWED",
                ProviderAdStatus::Disapproved,
            ),
            ("PAUSED", "APPROVED", "REVIEWED", ProviderAdStatus::Paused),
            ("PAUSED", "", "REVIEW_IN_PROGRESS", ProviderAdStatus::Paused),
            ("REMOVED", "", "", ProviderAdStatus::Archived),
            ("UNKNOWN", "", "", ProviderAdStatus::Other("UNKNOWN".into())),
        ] {
            assert_eq!(
                ad_status(&ad(status, approval, review)),
                expected,
                "{status} {approval} {review}"
            );
        }
    }

    #[test]
    fn feedback_names_the_policy_topics() {
        let ad = json!({"policySummary":{"policyTopicEntries":[
            {"topic":"TRADEMARKS_IN_AD_TEXT","type":"PROHIBITED"},
            {"topic":"ALCOHOL","type":"LIMITED"},
            {"topic":" "}]}});
        assert_eq!(
            feedback(&ad).as_deref(),
            Some("TRADEMARKS_IN_AD_TEXT (PROHIBITED), ALCOHOL (LIMITED)")
        );
        assert_eq!(feedback(&json!({"policySummary":{}})), None);
        assert_eq!(
            feedback(
                &json!({"policySummary":{"approvalStatus":"AREA_OF_INTEREST_ONLY",
                "policyTopicEntries":[{"topic":"ALCOHOL"}]}})
            )
            .as_deref(),
            Some("AREA_OF_INTEREST_ONLY: ALCOHOL")
        );
    }
}
