//! Lead-gen form submissions: `GET /{leadgen_id}?fields=field_data,form_id,ad_id,campaign_id,
//! campaign_name,created_time` with the page's token.

use std::collections::BTreeMap;

use jt_app::ports::connectors::LeadGenRecord;
use jt_connector::{ConnectorError, Credential};
use serde_json::Value;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;

use crate::MetaConnector;
use crate::credential::MetaCred;
use crate::graph::{node, text};

/// The fields read for a submission.
const FIELDS: &str = "field_data,form_id,ad_id,campaign_id,campaign_name,created_time";

/// A Graph time: RFC 3339, or Graph's `2026-10-01T12:00:00+0000` (no colon in the offset).
pub(crate) fn graph_time(value: &Value) -> Option<OffsetDateTime> {
    let text = value.as_str()?;
    OffsetDateTime::parse(text, &Rfc3339).ok().or_else(|| {
        let graph = format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second][offset_hour sign:mandatory][offset_minute]"
        );
        OffsetDateTime::parse(text, &graph).ok()
    })
}

/// Submission `leadgen_id`, its answers by field name.
pub(crate) async fn fetch(
    connector: &MetaConnector,
    cred: &Credential,
    leadgen_id: &str,
) -> Result<LeadGenRecord, ConnectorError> {
    let cred = MetaCred::of(cred, "read lead-gen submissions")?;
    if matches!(cred, MetaCred::Instagram { .. }) {
        return Err(ConnectorError::permanent(
            "lead-gen submissions are read with a Page token",
        ));
    }
    let app = connector.graph_app()?;
    let answer = connector
        .graph_get(
            &app,
            cred.token(),
            &[node(leadgen_id)?],
            &[("fields", FIELDS)],
        )
        .await?;
    let mut fields: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for field in answer["field_data"].as_array().into_iter().flatten() {
        let Some(name) = field["name"].as_str() else {
            continue;
        };
        let values = field["values"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned).or_else(|| text(v)))
            .collect();
        fields.insert(name.to_owned(), values);
    }
    Ok(LeadGenRecord {
        leadgen_id: text(&answer["id"]).unwrap_or_else(|| leadgen_id.to_owned()),
        form_id: text(&answer["form_id"]),
        ad_id: text(&answer["ad_id"]),
        campaign_id: text(&answer["campaign_id"]),
        campaign_name: answer["campaign_name"].as_str().map(str::to_owned),
        created_time: graph_time(&answer["created_time"]),
        fields,
    })
}
