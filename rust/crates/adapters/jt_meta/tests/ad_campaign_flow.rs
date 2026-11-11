//! One ad campaign from a person's goal to a running ad, a read of what it brought, a stop and an
//! end: the application's own use cases (in memory) on the real Meta adapter, against the
//! in-process Graph mock. Nothing here is scripted at the port: every request the mock sees is
//! what the adapter made of what `usecases::ads` asked for, so a step whose two sides do not fit
//! (an id the next call refuses, a body Graph would not take as the adapter shapes it) fails here.
//!
//! This is as near to a real run as a test gets without an ad account. It is not one: the mock
//! answers what Meta's documents say Meta answers.

mod support;

use jt_app::ctx::Ctx;
use jt_app::ports::ads::{AdCampaign, CampaignState, StopBy};
use jt_app::usecases::ads::{self, watch::watch_all};
use jt_app::usecases::{Deps, budget, spending};
use jt_capability::CapabilityId;
use jt_tenancy::WorkspaceId;
use jt_testkit::fakes::FIXED_NOW;
use serde_json::{Value, json};
use support::workspace::{FLOW_TOKEN as TOKEN, Workspace, workspace};
use support::*;
use time::{Duration, format_description::well_known::Rfc3339};

const ACCOUNT: &str = "/fb/v27.0/act_123";

/// A use case's input from its JSON, as a transport hands it over.
macro_rules! input {
    ($($json:tt)+) => {
        serde_json::from_value(json!($($json)+)).unwrap()
    };
}

fn at(time: time::OffsetDateTime) -> String {
    time.format(&Rfc3339).unwrap()
}

struct Flow {
    mock: Mock,
    deps: Deps,
    ws: WorkspaceId,
    owner: Ctx,
    agent: Ctx,
    account: CapabilityId,
    page: CapabilityId,
    hypothesis: Value,
    material: Value,
}

/// The workspace with a paid lane in its strategy, the materials and ads modules, a general ad
/// budget, a connected ad account and Facebook Page, one shareable image, and an agent with the
/// ads permission.
async fn flow() -> Flow {
    let w = workspace(
        &[
            (
                "budget_frame",
                json!({"lanes":[
                    {"lane":"organic","period":"monthly","cap_minor":0,"currency":"TRY"},
                    {"lane":"paid","period":"monthly","cap_minor":100_000,"currency":"TRY"}]}),
            ),
            ("paid_enabled", json!(true)),
        ],
        &["materials", "ads"],
    )
    .await;
    budget::create_item(
        &w.deps,
        &w.owner,
        input!({"name":"Ad budget","kind":"ad_budget",
            "unit":{"kind":"currency","value":"TRY"},"cap":100_000,"period":"monthly",
            "general":true}),
    )
    .await
    .unwrap();
    let scopes = ["ads_read", "ads_management"];
    let account = w
        .connected(
            "meta_ads",
            "Ad account",
            "act_123",
            Workspace::user_token(&scopes),
            &scopes,
        )
        .await;
    let page = w
        .connected(
            "facebook_page",
            "Page",
            "1234567890",
            Workspace::user_token(&["pages_manage_posts"]),
            &["pages_manage_posts"],
        )
        .await;
    let material = w.image().await;
    let agent = w.agent(&["ads.work", "materials.work"]).await;
    Flow {
        mock: w.mock,
        deps: w.deps,
        ws: w.id,
        owner: w.owner,
        agent,
        account,
        page,
        hypothesis: w.hypothesis,
        material,
    }
}

impl Flow {
    /// What Meta answers while the campaign is built: the account, nothing found under any
    /// name, an id for each object made, and a confirmed status change.
    fn provider_builds(&self) {
        let m = &self.mock;
        m.set(
            "GET",
            ACCOUNT,
            ok(json!({"account_id":"123","currency":"TRY",
                "timezone_name":"Europe/Istanbul","min_daily_budget":100})),
        );
        for edge in ["campaigns", "adsets", "adcreatives", "ads"] {
            m.set("GET", &format!("{ACCOUNT}/{edge}"), ok(json!({"data":[]})));
        }
        m.set(
            "POST",
            &format!("{ACCOUNT}/campaigns"),
            ok(json!({"id":"1001"})),
        );
        m.set(
            "POST",
            &format!("{ACCOUNT}/adsets"),
            ok(json!({"id":"2001"})),
        );
        m.set(
            "POST",
            &format!("{ACCOUNT}/adimages"),
            ok(json!({"images":{"ad.png":{"hash":"abc123"}}})),
        );
        m.set(
            "POST",
            &format!("{ACCOUNT}/adcreatives"),
            ok(json!({"id":"3001"})),
        );
        m.set("POST", &format!("{ACCOUNT}/ads"), ok(json!({"id":"4001"})));
        for id in ["1001", "2001", "4001"] {
            m.set(
                "POST",
                &format!("/fb/v27.0/{id}"),
                ok(json!({"success":true})),
            );
        }
    }

    /// What Meta answers when the campaign is read.
    fn provider_reports(&self, ad_status: &str, day: Value) {
        let m = &self.mock;
        m.set(
            "GET",
            "/fb/v27.0/1001",
            ok(json!({"account_id":"123","effective_status":"ACTIVE"})),
        );
        m.set(
            "GET",
            "/fb/v27.0/1001/ads",
            ok(json!({"data":[{"id":"4001","name":"ad","effective_status":ad_status}]})),
        );
        m.set("GET", "/fb/v27.0/1001/insights", ok(json!({"data":[day]})));
    }

    fn plan(&self) -> Value {
        json!({"ad_account":self.account,"result":"link_click",
            "destination":{"kind":"website","url":"https://ornek.example/kayit"},
            "special_ad_categories":[],
            "audience":{"countries":["TR"],"age_min":18,"age_max":65,"broad":true},
            "placements":"automatic","end_at":at(FIXED_NOW + Duration::days(7)),
            "ads":[{"name":"Workshop","material_ids":[self.material],
                "primary_text":"The weekend workshop is open for booking.",
                "headline":"Book your place","description":null,
                "call_to_action":"LEARN_MORE","page":self.page,"instagram":null,
                "hypothesis_id":self.hypothesis}],
            "summary":"Traffic to the booking page","audience_summary":"Turkey, broad"})
    }

    async fn get(&self, id: &Value) -> AdCampaign {
        ads::campaign_get(&self.deps, &self.owner, input!({"campaign_id":id}))
            .await
            .unwrap()
            .campaign
    }

    /// The statuses sent to Meta, in order: `(object id, status)`.
    fn statuses(&self) -> Vec<(String, String)> {
        self.mock
            .recorded()
            .into_iter()
            .filter(|r| r.method == "POST" && !r.path.starts_with(ACCOUNT))
            .map(|r| {
                (
                    r.path.trim_start_matches("/fb/v27.0/").to_owned(),
                    r.json()["status"].as_str().unwrap_or_default().to_owned(),
                )
            })
            .collect()
    }
}

#[tokio::test]
async fn a_campaign_goes_from_a_goal_to_a_running_ad_a_read_a_stop_and_an_end() {
    let f = flow().await;
    f.provider_builds();

    // A person opens the campaign; the agent claims it and delivers its plan.
    let opened = ads::campaign_open(
        &f.deps,
        &f.owner,
        input!({"request_key":"open-1","goal":"Fill the weekend workshop",
            "budget_minor":50_000,"start_at":at(FIXED_NOW)}),
    )
    .await
    .unwrap();
    let id = opened.id;
    let claim = ads::campaign_claim(
        &f.deps,
        &f.agent,
        input!({"campaign_id":id,"expected_revision":opened.revision}),
    )
    .await
    .unwrap();
    let planned = ads::plan_submit(
        &f.deps,
        &f.agent,
        input!({"campaign_id":id,"claim_token":claim.claim_token,
            "request_key":"plan-1","plan":f.plan()}),
    )
    .await
    .unwrap_or_else(|e| panic!("{e:?}"));

    // Jeeta built it at Meta itself, everything paused, then switched it on: ad, ad set, campaign.
    let built = planned.built.as_ref().expect("built");
    assert_eq!(built.campaign_id.as_deref(), Some("1001"));
    assert_eq!(built.adset_id.as_deref(), Some("2001"));
    assert_eq!(built.ads[0].image_hash.as_deref(), Some("abc123"));
    assert_eq!(built.ads[0].creative_id.as_deref(), Some("3001"));
    assert_eq!(built.ads[0].ad_id.as_deref(), Some("4001"));
    assert!(built.activated_at.is_some(), "{built:?}");
    assert_eq!(built.failed, None);

    let campaign = f.mock.request("POST", &format!("{ACCOUNT}/campaigns"));
    assert_graph_auth(&campaign, TOKEN);
    assert_eq!(
        campaign.json(),
        json!({"name":format!("jeeta:{id}:campaign"),"objective":"OUTCOME_TRAFFIC",
            "status":"PAUSED","special_ad_categories":[],"lifetime_budget":50_000,
            "bid_strategy":"LOWEST_COST_WITHOUT_CAP"})
    );
    let adset = f.mock.request("POST", &format!("{ACCOUNT}/adsets")).json();
    assert_eq!(adset["campaign_id"], "1001");
    assert_eq!(adset["status"], "PAUSED");
    assert_eq!(adset["optimization_goal"], "LINK_CLICKS");
    assert_eq!(adset["end_time"], at(FIXED_NOW + Duration::days(7)));
    // A broad audience goes out without an upper age (Meta fixes it).
    assert_eq!(
        adset["targeting"],
        json!({"geo_locations":{"countries":["TR"]},"age_min":18,
            "targeting_automation":{"advantage_audience":1}})
    );
    let image = f
        .mock
        .request("POST", &format!("{ACCOUNT}/adimages"))
        .json();
    assert!(!image["bytes"].as_str().unwrap().is_empty());
    let creative = f
        .mock
        .request("POST", &format!("{ACCOUNT}/adcreatives"))
        .json();
    assert_eq!(
        creative["object_story_spec"],
        json!({"page_id":"1234567890","link_data":{
            "link":"https://ornek.example/kayit",
            "message":"The weekend workshop is open for booking.",
            "name":"Book your place","image_hash":"abc123",
            "call_to_action":{"type":"LEARN_MORE","value":{"link":"https://ornek.example/kayit"}}}})
    );
    assert_eq!(
        creative["degrees_of_freedom_spec"]["creative_features_spec"]["product_extensions"]["enroll_status"],
        "OPT_OUT",
        "Meta adds nothing of its own to the ad"
    );
    let ad = f.mock.request("POST", &format!("{ACCOUNT}/ads")).json();
    assert_eq!(
        (
            &ad["adset_id"],
            &ad["creative"]["creative_id"],
            &ad["status"]
        ),
        (&json!("2001"), &json!("3001"), &json!("PAUSED"))
    );
    assert_eq!(
        f.statuses(),
        [("4001", "ACTIVE"), ("2001", "ACTIVE"), ("1001", "ACTIVE")]
            .map(|(id, status)| (id.to_owned(), status.to_owned()))
    );

    // An hour later the watch reads it: the ad is live, and what Meta reports as spent is in
    // the general ad budget. Only the campaign's own result counts (link clicks, not the leads).
    f.provider_reports(
        "ACTIVE",
        json!({"ad_id":"4001","date_start":FIXED_NOW.date().to_string(),"spend":"12.34",
            "impressions":"1000","clicks":"40",
            "actions":[{"action_type":"lead","value":"5"},{"action_type":"link_click","value":"31"}]}),
    );
    let later = FIXED_NOW + Duration::hours(2);
    watch_all(&f.deps, f.ws, later).await.unwrap();
    let live = f.get(&json!(id)).await;
    assert_eq!(live.state.as_ref().unwrap().state, CampaignState::Live);
    let totals = live.totals.as_ref().unwrap();
    assert_eq!(
        (totals.spent_minor, totals.results, totals.impressions),
        (1_234, Some(31), Some(1_000))
    );
    let insights = f.mock.request("GET", "/fb/v27.0/1001/insights");
    assert_eq!(insights.param("level"), Some("ad"));
    assert_eq!(insights.param("time_increment"), Some("1"));
    let budget_item = &budget::list_items(&f.deps, &f.owner).await.unwrap()[0];
    assert_eq!(budget_item.spent_in_period, 1_234);

    // A person stops ad spending in the budget page: the campaign is paused at Meta at once.
    let revision = spending::breakdown(&f.deps, &f.owner, input!({}))
        .await
        .unwrap()
        .stop
        .revision;
    spending::stop(
        &f.deps,
        &f.owner,
        input!({"scope":{"module":"ads"},"stopped":true,"expected_revision":revision}),
    )
    .await
    .unwrap();
    assert_eq!(
        f.statuses().last().unwrap(),
        &("1001".to_owned(), "PAUSED".to_owned())
    );
    let stopped = f.get(&json!(id)).await;
    assert_eq!(
        stopped.stop.as_ref().map(|s| (s.by, s.reason.as_str())),
        Some((StopBy::Budget, "spend_stopped"))
    );
    assert!(stopped.built.as_ref().unwrap().provider_paused);

    // The person ends it: it is already paused there, so nothing more is sent, and what it held
    // of the general ad budget is free again.
    let sent = f.statuses().len();
    let ended = ads::campaign_end(
        &f.deps,
        &f.owner,
        input!({"campaign_id":id,"expected_revision":stopped.revision}),
    )
    .await
    .unwrap();
    assert_eq!(ended.state.as_ref().unwrap().state, CampaignState::Ended);
    assert_eq!(ended.state.as_ref().unwrap().note, None);
    assert_eq!(f.statuses().len(), sent);
    let held: i64 = spending::breakdown(&f.deps, &f.owner, input!({}))
        .await
        .unwrap()
        .items
        .iter()
        .map(|i| i.held_minor)
        .sum();
    assert_eq!(held, 0);

    // Each object was made once, and every request to Meta carried its token and its proof.
    for edge in ["campaigns", "adsets", "adimages", "adcreatives", "ads"] {
        assert_eq!(
            f.mock.requests("POST", &format!("{ACCOUNT}/{edge}")).len(),
            1,
            "{edge}"
        );
    }
    assert_eq!(f.mock.violations(), Vec::<String>::new());
}
