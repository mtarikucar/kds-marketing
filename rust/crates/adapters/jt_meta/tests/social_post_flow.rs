//! One post from a person's area to the Facebook Page: an agent makes the content, an agent gives
//! it its account and time, and at that time the publisher sends it. The application's own use
//! cases (in memory) on the real Meta adapter, against the in-process Graph mock.
//!
//! The strategy is written the way a consultation writes one: its hypothesis names no cadence.
//! That a finished version then still finds its account (design 2026-11-10 B53) is what this
//! test is for, besides the join between the posting engine and the adapter.
//!
//! It is not a real run: the mock answers what Meta's documents say Meta answers.

mod support;

use std::sync::Arc;

use jt_app::ctx::Ctx;
use jt_app::usecases::studio::{projects, publish};
use jt_app::usecases::{Deps, content, social, work};
use jt_capability::CapabilityId;
use jt_connector::Credential;
use jt_testkit::fakes::{FIXED_NOW, FixedClock};
use serde_json::{Value, json};
use support::workspace::{FLOW_TOKEN, workspace};
use support::*;
use time::{Duration, format_description::well_known::Rfc3339};

const PAGE: &str = "1234567890";

/// A use case's input from its JSON, as a transport hands it over.
macro_rules! input {
    ($($json:tt)+) => {
        serde_json::from_value(json!($($json)+)).unwrap()
    };
}

/// The account as the panel reads it, as JSON.
async fn account(deps: &Deps, owner: &Ctx, page: CapabilityId) -> Value {
    serde_json::to_value(
        social::account_get(deps, owner, input!({"capability_id":page}))
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
async fn a_finished_package_is_scheduled_by_an_agent_and_goes_out_on_the_page() {
    let mut w = workspace(&[], &["materials", "content", "social"]).await;
    let scopes = ["pages_manage_posts", "pages_read_engagement"];
    let page = w
        .connected(
            "facebook_page",
            "Alfa Atölye",
            PAGE,
            Credential::PageToken {
                page_id: PAGE.into(),
                token: FLOW_TOKEN.into(),
            },
            &scopes,
        )
        .await;
    let image = w.image().await;
    let agent = w
        .agent(&[
            "workspace.read",
            "content.work",
            "social.work",
            "materials.work",
        ])
        .await;

    // A person opens an area; an agent takes it and delivers a package with one version.
    let area = projects::project_create(
        &w.deps,
        &w.owner,
        input!({"request_key":"area-1","brief":"Announce the new mugs","material_ids":[image]}),
    )
    .await
    .unwrap();
    let claim = content::area_claim(
        &w.deps,
        &agent,
        input!({"project_id":area.id,"expected_revision":area.revision}),
    )
    .await
    .unwrap();
    let delivered = content::area_deliver(
        &w.deps,
        &agent,
        input!({"project_id":area.id,"claim_token":claim.claim_token,
            "request_key":"delivery-1","summary":"One feed post",
            "versions":[{"format":"feed_post","text":"New mugs are taking shape in the workshop.",
                "tags":["ceramics"],"material_ids":[image],"hypothesis_id":w.hypothesis,
                "content_type":"announcement"}]}),
    )
    .await
    .unwrap_or_else(|e| panic!("{e:?}"))
    .project;
    let version = serde_json::to_value(&delivered.packages[0].versions[0]).unwrap()["id"].clone();

    // The version waits with the Page as the account that can take it, and is the agent's work,
    // although nobody wrote a cadence for the hypothesis and its label is not a type the
    // strategy names.
    let waiting = serde_json::to_value(
        social::versions_waiting(&w.deps, &agent, input!({}))
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        waiting[0]["versions"][0]["accounts"],
        json!([page]),
        "{waiting}"
    );
    assert_eq!(waiting[0]["versions"][0].get("blocked"), None);
    let items = serde_json::to_value(work::pending(&w.deps, &agent).await.unwrap().items).unwrap();
    assert!(
        items
            .as_array()
            .unwrap()
            .iter()
            .any(|i| i["kind"] == "social_schedule"),
        "{items}"
    );

    // The agent gives it its account and its time: it is planned and ready at once, and shows
    // under the account's coming posts. Nobody approves.
    let when = FIXED_NOW + Duration::days(2) + Duration::hours(1);
    let scheduled = social::version_schedule(
        &w.deps,
        &agent,
        input!({"project_id":area.id,"version_id":version,"capability_id":page,
            "publish_at":when.format(&Rfc3339).unwrap(),"request_key":"time-1"}),
    )
    .await
    .unwrap_or_else(|e| panic!("{e:?}"));
    let slot = serde_json::to_value(scheduled.publication.slot.id).unwrap();
    let before = account(&w.deps, &w.owner, page).await;
    assert_eq!(before["upcoming"][0]["slot_id"], slot, "{before}");
    assert_eq!(before["upcoming"][0]["state"], "ready");
    assert_eq!(before["upcoming"][0]["format"], "feed_post");
    assert_eq!(before["recent"], json!([]));
    assert!(
        w.mock.recorded().is_empty(),
        "nothing is sent before its time"
    );

    // At its time the publisher sends it: one photo post on the Page, with its text and tags.
    w.mock.set(
        "POST",
        &format!("/fb/v19.0/{PAGE}/photos"),
        ok(json!({"id":"777","post_id":format!("{PAGE}_555")})),
    );
    assert_eq!(publish::publish_due(&w.deps, w.id).await.unwrap(), 0);
    w.deps.clock = Arc::new(FixedClock(when));
    assert_eq!(publish::publish_due(&w.deps, w.id).await.unwrap(), 1);
    let sent = w.mock.request("POST", &format!("/fb/v19.0/{PAGE}/photos"));
    assert_graph_auth(&sent, FLOW_TOKEN);
    let body: Value = sent.json();
    assert_eq!(
        body["caption"],
        "New mugs are taking shape in the workshop.\n\n#ceramics"
    );
    assert!(body["url"].as_str().unwrap().starts_with("http"), "{body}");
    assert_eq!(body.get("published"), None, "sent to go out now");

    // It is among the account's posts that went out, with its address; nothing waits any more.
    let after = account(&w.deps, &w.owner, page).await;
    assert_eq!(after["upcoming"], json!([]), "{after}");
    assert_eq!(after["recent"][0]["slot_id"], slot);
    assert_eq!(
        after["recent"][0]["title"],
        "New mugs are taking shape in the workshop."
    );
    assert!(
        after["recent"][0]["url"]
            .as_str()
            .unwrap()
            .ends_with(&format!("{PAGE}_555")),
        "{after}"
    );
    assert!(
        social::versions_waiting(&w.deps, &agent, input!({}))
            .await
            .unwrap()
            .is_empty()
    );
    // Sent once, and every request carried its token and its proof.
    assert_eq!(publish::publish_due(&w.deps, w.id).await.unwrap(), 0);
    assert_eq!(w.mock.recorded().len(), 1);
    assert_eq!(w.mock.violations(), Vec::<String>::new());
}
