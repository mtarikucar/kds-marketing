mod support;

use jt_app::ports::connectors::*;
use jt_connector::Credential;
use serde_json::{Value, json};
use support::{assert_graph_auth, ok, rig, status};
use time::macros::{date, datetime};

const TOKEN: &str = "synthetic-ad-token";
// Recorded Graph response shapes with synthetic identifiers and content only.
fn response(name: &str) -> Value {
    let all: Value =
        serde_json::from_str(include_str!("fixtures/meta/graph/ad_campaigns.json")).unwrap();
    all[name].clone()
}
fn cred() -> Credential {
    Credential::OAuth {
        access_token: TOKEN.into(),
        refresh_token: None,
        expires_at: None,
        scopes: vec![],
    }
}
fn public() -> Value {
    json!({"external_id":"act_123"})
}
fn campaign() -> CampaignSpec {
    CampaignSpec {
        name: "test campaign".into(),
        objective: AdObjective::Traffic,
        lifetime_budget_minor: 12345,
        start_at: datetime!(2026-11-11 0:00 UTC),
        end_at: datetime!(2026-11-13 0:00 UTC),
    }
}
fn adset() -> AdSetSpec {
    AdSetSpec {
        name: "test set".into(),
        campaign_id: "campaign1".into(),
        goal: AdSetGoal::LinkClicks,
        audience: AdAudience {
            countries: vec!["TR".into()],
            regions: vec!["r1".into()],
            cities: vec!["c1".into()],
            age_min: 18,
            age_max: 65,
            genders: vec![AdGender::Female],
            interests: vec![AdInterest {
                id: "i1".into(),
                name: "Art".into(),
            }],
            broad: true,
        },
        placements: AdPlacements::Platforms(vec![AdPlatform::Facebook, AdPlatform::Instagram]),
        start_at: datetime!(2026-11-11 0:00 UTC),
        end_at: datetime!(2026-11-13 0:00 UTC),
        budget_minor: 12345,
        keywords: Vec::new(),
    }
}
fn creative() -> CreativeSpec {
    CreativeSpec {
        name: "test creative".into(),
        identity_id: Some("page1".into()),
        instagram_user_id: Some("ig1".into()),
        image: Some("hash1".into()),
        primary_text: "Synthetic primary text".into(),
        headline: "Synthetic headline".into(),
        description: Some("Synthetic description".into()),
        headlines: Vec::new(),
        descriptions: Vec::new(),
        call_to_action: Some(CallToAction::LearnMore),
        action: CreativeAction::Link {
            url: Url::parse("https://example.test/landing").unwrap(),
        },
    }
}
fn story() -> Value {
    json!({"page_id":"page1","instagram_user_id":"ig1","link_data":{"link":"https://example.test/landing","message":"Synthetic primary text","name":"Synthetic headline","description":"Synthetic description","image_hash":"hash1","call_to_action":{"type":"LEARN_MORE","value":{"link":"https://example.test/landing"}}}})
}
fn assert_auth(r: &support::Recorded, token: &str) {
    assert_graph_auth(r, token);
    assert!(!r.body.contains(token));
    assert!(!r.path.contains(token));
}

#[tokio::test]
async fn campaign_is_paused_with_a_total_budget_and_objective() {
    let r = rig().await;
    r.mock.on(
        "POST",
        "/fb/v27.0/act_123/campaigns",
        ok(response("campaign")),
    );
    for (objective, expected) in [
        (AdObjective::Traffic, "OUTCOME_TRAFFIC"),
        (AdObjective::Leads, "OUTCOME_LEADS"),
    ] {
        let mut spec = campaign();
        spec.objective = objective;
        assert_eq!(
            r.meta
                .create_campaign(&cred(), &public(), &spec)
                .await
                .unwrap(),
            "campaign1"
        );
        let req = r.mock.recorded().pop().unwrap();
        assert_auth(&req, TOKEN);
        assert_eq!(
            req.json(),
            json!({"name":"test campaign","objective":expected,"status":"PAUSED","special_ad_categories":[],"lifetime_budget":12345,"bid_strategy":"LOWEST_COST_WITHOUT_CAP"})
        );
    }
}

#[tokio::test]
async fn adset_encodes_audience_placements_dates_and_lead_destination_without_budget() {
    let r = rig().await;
    r.mock
        .on("POST", "/fb/v27.0/act_123/adsets", ok(response("adset")));
    let mut spec = adset();
    assert_eq!(
        r.meta
            .create_adset(&cred(), &public(), &spec)
            .await
            .unwrap(),
        "set1"
    );
    let req = r.mock.request("POST", "/fb/v27.0/act_123/adsets");
    assert_auth(&req, TOKEN);
    assert_eq!(
        req.json(),
        json!({"name":"test set","campaign_id":"campaign1","status":"PAUSED","billing_event":"IMPRESSIONS","optimization_goal":"LINK_CLICKS","start_time":"2026-11-11T00:00:00Z","end_time":"2026-11-13T00:00:00Z","targeting":{"geo_locations":{"countries":["TR"],"regions":[{"key":"r1"}],"cities":[{"key":"c1"}]},"age_min":18,"genders":[2],"flexible_spec":[{"interests":[{"id":"i1","name":"Art"}]}],"publisher_platforms":["facebook","instagram"],"targeting_automation":{"advantage_audience":1}}})
    );
    spec.goal = AdSetGoal::Leads {
        page_id: "page1".into(),
    };
    spec.placements = AdPlacements::Automatic;
    spec.audience.genders = vec![AdGender::Male, AdGender::Female];
    spec.audience.broad = false;
    r.meta
        .create_adset(&cred(), &public(), &spec)
        .await
        .unwrap();
    let body = r.mock.recorded().pop().unwrap().json();
    assert_eq!(body["optimization_goal"], "LEAD_GENERATION");
    assert_eq!(body["destination_type"], "ON_AD");
    assert_eq!(body["promoted_object"], json!({"page_id":"page1"}));
    assert!(body["targeting"].get("genders").is_none());
    assert!(body["targeting"].get("publisher_platforms").is_none());
    assert_eq!(
        body["targeting"]["targeting_automation"],
        json!({"advantage_audience":0})
    );
    // An audience that is not broad carries its own upper age; a broad one carries none (Meta
    // fixes it at 65), and is refused before anything is sent when its ages are not the
    // provider's.
    assert_eq!(body["targeting"]["age_max"], 65);
    let sent = r.mock.recorded().len();
    spec.audience.broad = true;
    spec.audience.age_min = 30;
    let e = r
        .meta
        .create_adset(&cred(), &public(), &spec)
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert_eq!(r.mock.recorded().len(), sent);
    assert!(body.get("daily_budget").is_none());
    assert!(body.get("lifetime_budget").is_none());
}

#[tokio::test]
async fn image_upload_returns_hash_and_encodes_the_bytes() {
    let r = rig().await;
    r.mock
        .on("POST", "/fb/v27.0/act_123/adimages", ok(response("image")));
    assert_eq!(
        r.meta
            .upload_image(&cred(), &public(), &[0, 1, 2, 255], "test.png")
            .await
            .unwrap(),
        "hash1"
    );
    let req = r.mock.request("POST", "/fb/v27.0/act_123/adimages");
    assert_auth(&req, TOKEN);
    assert_eq!(req.json(), json!({"name":"test.png","bytes":"AAEC/w=="}));
}

#[tokio::test]
async fn lead_form_uses_only_the_matching_page_credential() {
    let r = rig().await;
    r.mock.on(
        "POST",
        "/fb/v27.0/page1/leadgen_forms",
        ok(response("lead_form")),
    );
    let spec = LeadFormSpec {
        name: "test form".into(),
        questions: vec![
            LeadQuestion::FullName,
            LeadQuestion::Email,
            LeadQuestion::Phone,
        ],
        privacy_policy_url: Url::parse("https://example.test/privacy").unwrap(),
        thank_you_url: Url::parse("https://example.test/thanks").unwrap(),
        locale: "tr_TR".into(),
    };
    let page = Credential::PageToken {
        page_id: "page1".into(),
        token: "synthetic-page-token".into(),
    };
    assert_eq!(
        r.meta
            .create_lead_form(&page, &json!({"external_id":"page1"}), &spec)
            .await
            .unwrap(),
        "form1"
    );
    let req = r.mock.request("POST", "/fb/v27.0/page1/leadgen_forms");
    assert_auth(&req, "synthetic-page-token");
    assert_eq!(
        req.json(),
        json!({"name":"test form","questions":[{"type":"FULL_NAME"},{"type":"EMAIL"},{"type":"PHONE_NUMBER"}],"privacy_policy":{"url":"https://example.test/privacy"},"follow_up_action_url":"https://example.test/thanks","locale":"tr_TR"})
    );
    assert!(
        r.meta
            .create_lead_form(&cred(), &json!({"external_id":"page1"}), &spec)
            .await
            .is_err()
    );
    assert!(
        r.meta
            .create_lead_form(&page, &json!({"external_id":"page2"}), &spec)
            .await
            .is_err()
    );
    assert_eq!(r.mock.recorded().len(), 1);
}

#[tokio::test]
async fn creative_encodes_link_and_form_actions_and_all_ctas() {
    let r = rig().await;
    r.mock.on(
        "POST",
        "/fb/v27.0/act_123/adcreatives",
        ok(response("creative")),
    );
    let mut spec = creative();
    assert_eq!(
        r.meta
            .create_creative(&cred(), &public(), &spec)
            .await
            .unwrap(),
        "creative1"
    );
    let req = r.mock.request("POST", "/fb/v27.0/act_123/adcreatives");
    assert_auth(&req, TOKEN);
    // Meta's Product showcase is declined: nothing is shown with the ad that was not planned.
    assert_eq!(
        req.json(),
        json!({"name":"test creative","object_story_spec":story(),
            "degrees_of_freedom_spec":{"creative_features_spec":{"product_extensions":{
                "enroll_status":"OPT_OUT","action_metadata":{"type":"MANUAL"}}}}})
    );
    spec.action = CreativeAction::LeadForm {
        form_id: "form1".into(),
        url: Url::parse("https://example.test/landing").unwrap(),
    };
    spec.instagram_user_id = None;
    spec.description = None;
    for (cta, key) in [
        (CallToAction::LearnMore, "LEARN_MORE"),
        (CallToAction::SignUp, "SIGN_UP"),
        (CallToAction::ShopNow, "SHOP_NOW"),
        (CallToAction::ContactUs, "CONTACT_US"),
        (CallToAction::GetQuote, "GET_QUOTE"),
        (CallToAction::Subscribe, "SUBSCRIBE"),
        (CallToAction::ApplyNow, "APPLY_NOW"),
        (CallToAction::BookNow, "BOOK_NOW"),
        (CallToAction::Download, "DOWNLOAD"),
    ] {
        spec.call_to_action = Some(cta);
        r.meta
            .create_creative(&cred(), &public(), &spec)
            .await
            .unwrap();
        let body = r.mock.recorded().pop().unwrap().json();
        assert_eq!(
            body["object_story_spec"]["link_data"]["call_to_action"],
            json!({"type":key,"value":{"lead_gen_form_id":"form1"}})
        );
        assert!(body["object_story_spec"].get("instagram_user_id").is_none());
        assert!(
            body["object_story_spec"]["link_data"]
                .get("description")
                .is_none()
        );
    }
}

#[tokio::test]
async fn ad_is_created_paused_with_its_creative() {
    let r = rig().await;
    r.mock
        .on("POST", "/fb/v27.0/act_123/ads", ok(response("ad")));
    assert_eq!(
        r.meta
            .create_ad(
                &cred(),
                &public(),
                &AdSpec {
                    name: "test ad".into(),
                    adset_id: "set1".into(),
                    creative_id: "creative1".into(),
                    creative: creative(),
                }
            )
            .await
            .unwrap(),
        "ad1"
    );
    let req = r.mock.request("POST", "/fb/v27.0/act_123/ads");
    assert_auth(&req, TOKEN);
    assert_eq!(
        req.json(),
        json!({"name":"test ad","adset_id":"set1","creative":{"creative_id":"creative1"},"status":"PAUSED"})
    );
}

#[tokio::test]
async fn account_limits_use_currency_units_and_minimum_budget() {
    let r = rig().await;
    r.mock
        .on("GET", "/fb/v27.0/act_123", ok(response("limits")));
    assert_eq!(
        r.meta
            .account_limits(&cred(), &json!({"external_id":"123"}))
            .await
            .unwrap(),
        AdAccountLimits {
            currency: "TRY".into(),
            minor_unit_exponent: 2,
            timezone: "Europe/Istanbul".into(),
            min_daily_budget_minor: 500,
            min_total_budget_minor: 0,
        }
    );
    let req = r.mock.request("GET", "/fb/v27.0/act_123");
    assert_auth(&req, TOKEN);
    assert_eq!(
        req.param("fields"),
        Some("account_id,currency,timezone_name,min_daily_budget")
    );
}

#[tokio::test]
async fn find_by_name_requires_one_exact_match_and_follows_pages() {
    let r = rig().await;
    for (level, edge) in [
        (AdLevel::Campaign, "campaigns"),
        (AdLevel::AdSet, "adsets"),
        (AdLevel::Ad, "ads"),
        (AdLevel::Creative, "adcreatives"),
    ] {
        let path = format!("/fb/v27.0/act_123/{edge}");
        r.mock.set("GET", &path, ok(json!({"data":[]})));
        assert_eq!(
            r.meta
                .find_by_name(&cred(), &public(), level, "unique")
                .await
                .unwrap(),
            None
        );
        let req = r.mock.recorded().pop().unwrap();
        assert_auth(&req, TOKEN);
        assert_eq!(req.param("fields"), Some("id,name"));
        assert_eq!(
            serde_json::from_str::<Value>(req.param("filtering").unwrap()).unwrap(),
            json!([{"field":"name","operator":"EQUAL","value":"unique"}])
        );
        r.mock.set(
            "GET",
            &path,
            ok(json!({"data":[{"id":"one","name":"unique"}]})),
        );
        assert_eq!(
            r.meta
                .find_by_name(&cred(), &public(), level, "unique")
                .await
                .unwrap(),
            Some("one".into())
        );
        let next = format!("{}/v27.0/act_123/{edge}?after=next", r.mock.base("/fb"));
        r.mock.set(
            "GET",
            &path,
            ok(json!({"data":[{"id":"one","name":"unique"}],"paging":{"next":next}})),
        );
        r.mock.on(
            "GET",
            &path,
            ok(json!({"data":[{"id":"two","name":"unique"}]})),
        );
        let e = r
            .meta
            .find_by_name(&cred(), &public(), level, "unique")
            .await
            .unwrap_err();
        assert_eq!(e.kind(), "permanent");
        assert!(e.to_string().contains("one"));
        assert!(e.to_string().contains("two"));
    }
}

#[tokio::test]
async fn state_maps_all_review_states_and_joins_feedback() {
    let r = rig().await;
    r.mock.on(
        "GET",
        "/fb/v27.0/campaign1",
        ok(json!({"account_id":"123","effective_status":"PAUSED"})),
    );
    let statuses = [
        ("ACTIVE", ProviderAdStatus::Active),
        ("PAUSED", ProviderAdStatus::Paused),
        ("CAMPAIGN_PAUSED", ProviderAdStatus::Paused),
        ("ADSET_PAUSED", ProviderAdStatus::Paused),
        ("PENDING_REVIEW", ProviderAdStatus::InReview),
        ("IN_PROCESS", ProviderAdStatus::InReview),
        ("PREAPPROVED", ProviderAdStatus::InReview),
        ("DISAPPROVED", ProviderAdStatus::Disapproved),
        ("WITH_ISSUES", ProviderAdStatus::WithIssues),
        ("ARCHIVED", ProviderAdStatus::Archived),
        ("DELETED", ProviderAdStatus::Archived),
        ("FUTURE", ProviderAdStatus::Other("FUTURE".into())),
    ];
    r.mock.on("GET","/fb/v27.0/campaign1/ads",ok(json!({"data":statuses.iter().enumerate().map(|(i,(s,_))|json!({"id":format!("ad{i}"),"name":"test ad","effective_status":s,"ad_review_feedback":{"global":{"policy":"Synthetic reason","other":"Another reason"}}})).collect::<Vec<_>>()})));
    let state = r
        .meta
        .campaign_state(&cred(), &public(), "campaign1")
        .await
        .unwrap();
    assert_eq!(state.campaign, ProviderAdStatus::Paused);
    assert_eq!(state.ads.len(), statuses.len());
    for (ad, (_, expected)) in state.ads.iter().zip(statuses) {
        assert_eq!(ad.status, expected);
        assert_eq!(ad.name, "test ad");
        assert!(ad.feedback.as_ref().unwrap().contains("Synthetic reason"));
        assert!(ad.feedback.as_ref().unwrap().contains("Another reason"));
    }
    let req = r.mock.request("GET", "/fb/v27.0/campaign1");
    assert_auth(&req, TOKEN);
    assert_eq!(req.param("fields"), Some("account_id,effective_status"));
    let req = r.mock.request("GET", "/fb/v27.0/campaign1/ads");
    assert_auth(&req, TOKEN);
    assert_eq!(
        req.param("fields"),
        Some("id,name,effective_status,ad_review_feedback")
    );
}

#[tokio::test]
async fn daily_numbers_preserve_missing_counters_and_exact_currency_units() {
    let r = rig().await;
    r.mock.on(
        "GET",
        "/fb/v27.0/campaign1",
        ok(json!({"account_id":"123"})),
    );
    for (currency, spend, want) in [
        ("TRY", "1.23", Some(123)),
        ("JPY", "12", Some(12)),
        ("KWD", "1.234", None),
    ] {
        r.mock.set(
            "GET",
            "/fb/v27.0/act_123",
            ok(json!({"account_id":"123","currency":currency,"timezone_name":"UTC"})),
        );
        r.mock.set("GET","/fb/v27.0/campaign1/insights",ok(json!({"data":[{"ad_id":"ad1","date_start":"2026-11-11","spend":spend,"impressions":"12","clicks":"0","actions":[{"action_type":"link_click","value":"9"},{"action_type":"lead","value":"2"}]},{"ad_id":"ad2","date_start":"2026-11-11"},{"ad_id":"ad3","date_start":"2026-11-11","actions":[{"action_type":"link_click","value":"4"}]}]})));
        let days = r
            .meta
            .ad_days(
                &cred(),
                &public(),
                "campaign1",
                AdObjective::Leads,
                date!(2026 - 11 - 11),
                date!(2026 - 11 - 12),
            )
            .await;
        let Some(want) = want else {
            let error = days.unwrap_err();
            assert_eq!(error.kind(), "permanent");
            assert_eq!(error.reason(), Some("unsupported ad account currency"));
            continue;
        };
        let days = days.unwrap();
        assert_eq!(
            days[0],
            AdDay {
                ad_id: "ad1".into(),
                day: date!(2026 - 11 - 11),
                spend_minor: Some(want),
                impressions: Some(12),
                clicks: Some(0),
                results: Some(2)
            }
        );
        assert_eq!(
            days[1],
            AdDay {
                ad_id: "ad2".into(),
                day: date!(2026 - 11 - 11),
                spend_minor: None,
                impressions: None,
                clicks: None,
                results: None
            }
        );
        // A result is what the campaign is for: this leads campaign's ad with link clicks
        // alone has no result, and read as a traffic campaign the same rows count the clicks.
        assert_eq!(days[2].results, None);
        let clicks = r
            .meta
            .ad_days(
                &cred(),
                &public(),
                "campaign1",
                AdObjective::Traffic,
                date!(2026 - 11 - 11),
                date!(2026 - 11 - 12),
            )
            .await
            .unwrap();
        assert_eq!(
            clicks.iter().map(|d| d.results).collect::<Vec<_>>(),
            [Some(9), None, Some(4)]
        );
        let req = r.mock.recorded().pop().unwrap();
        assert_auth(&req, TOKEN);
        assert_eq!(req.param("level"), Some("ad"));
        assert_eq!(req.param("time_increment"), Some("1"));
        assert_eq!(
            req.param("fields"),
            Some("ad_id,date_start,spend,impressions,clicks,actions")
        );
        assert_eq!(
            serde_json::from_str::<Value>(req.param("time_range").unwrap()).unwrap(),
            json!({"since":"2026-11-11","until":"2026-11-12"})
        );
    }
}

#[tokio::test]
async fn preview_uses_unpublished_story_and_placement() {
    let r = rig().await;
    r.mock.on(
        "GET",
        "/fb/v27.0/act_123/generatepreviews",
        ok(response("preview")),
    );
    for (placement, format) in [
        (AdPlacement::FacebookFeed, "MOBILE_FEED_STANDARD"),
        (AdPlacement::InstagramFeed, "INSTAGRAM_STANDARD"),
        (AdPlacement::InstagramStory, "INSTAGRAM_STORY"),
        (AdPlacement::InstagramReels, "INSTAGRAM_REELS"),
    ] {
        assert_eq!(
            r.meta
                .preview(&cred(), &public(), &creative(), placement)
                .await
                .unwrap(),
            "<iframe>synthetic</iframe>"
        );
        let req = r.mock.recorded().pop().unwrap();
        assert_auth(&req, TOKEN);
        assert_eq!(req.param("ad_format"), Some(format));
        assert_eq!(
            serde_json::from_str::<Value>(req.param("creative").unwrap()).unwrap(),
            json!({"object_story_spec":story()})
        );
    }
}

#[tokio::test]
async fn validation_and_throttle_errors_are_safe_and_creation_is_not_retried() {
    let r = rig().await;
    let path = "/fb/v27.0/act_123/campaigns";
    r.mock.on("POST",path,status(400,json!({"error":{"code":100,"message":format!("invalid {TOKEN}"),"error_user_title":"Budget refused","error_user_msg":"Choose a larger budget"}})));
    let e = r
        .meta
        .create_campaign(&cred(), &public(), &campaign())
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    let printed = format!("{e} {e:?}");
    assert!(printed.contains("Budget refused"));
    assert!(printed.contains("Choose a larger budget"));
    assert!(!printed.contains(TOKEN));
    assert!(!printed.contains("test campaign"));
    assert!(!printed.contains("lifetime_budget"));
    r.mock.set(
        "POST",
        path,
        status(429, json!({"error":{"code":4,"message":TOKEN}})).with_header("retry-after", "17"),
    );
    let e = r
        .meta
        .create_campaign(&cred(), &public(), &campaign())
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "throttle");
    assert!(
        matches!(e,jt_connector::ConnectorError::Throttle {retry_after:Some(wait)} if wait==time::Duration::seconds(17))
    );
    r.mock.set(
        "POST",
        path,
        status(500, json!({"error":{"code":2,"message":"temporary"}})),
    );
    assert_eq!(
        r.meta
            .create_campaign(&cred(), &public(), &campaign())
            .await
            .unwrap_err()
            .kind(),
        "unknown"
    );
    assert_eq!(r.mock.recorded().len(), 3);
}

async fn call_method(r: &support::Rig, method: usize) -> Result<(), jt_connector::ConnectorError> {
    match method {
        0 => r.meta.account_limits(&cred(), &public()).await.map(|_| ()),
        1 => r
            .meta
            .find_by_name(&cred(), &public(), AdLevel::Campaign, "test campaign")
            .await
            .map(|_| ()),
        2 => r
            .meta
            .create_campaign(&cred(), &public(), &campaign())
            .await
            .map(|_| ()),
        3 => r
            .meta
            .create_adset(&cred(), &public(), &adset())
            .await
            .map(|_| ()),
        4 => r
            .meta
            .upload_image(&cred(), &public(), &[1, 2], "image.png")
            .await
            .map(|_| ()),
        5 => r
            .meta
            .create_lead_form(
                &Credential::PageToken {
                    page_id: "page1".into(),
                    token: TOKEN.into(),
                },
                &json!({"external_id":"page1"}),
                &LeadFormSpec {
                    name: "synthetic form".into(),
                    questions: vec![LeadQuestion::Email],
                    privacy_policy_url: Url::parse("https://example.test/privacy").unwrap(),
                    thank_you_url: Url::parse("https://example.test/thanks").unwrap(),
                    locale: "tr_TR".into(),
                },
            )
            .await
            .map(|_| ()),
        6 => r
            .meta
            .create_creative(&cred(), &public(), &creative())
            .await
            .map(|_| ()),
        7 => r
            .meta
            .create_ad(
                &cred(),
                &public(),
                &AdSpec {
                    name: "synthetic ad".into(),
                    adset_id: "set1".into(),
                    creative_id: "creative1".into(),
                    creative: creative(),
                },
            )
            .await
            .map(|_| ()),
        8 => r
            .meta
            .campaign_state(&cred(), &public(), "campaign1")
            .await
            .map(|_| ()),
        9 => r
            .meta
            .ad_days(
                &cred(),
                &public(),
                "campaign1",
                AdObjective::Traffic,
                date!(2026 - 11 - 11),
                date!(2026 - 11 - 12),
            )
            .await
            .map(|_| ()),
        10 => r
            .meta
            .preview(&cred(), &public(), &creative(), AdPlacement::FacebookFeed)
            .await
            .map(|_| ()),
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn every_method_maps_validation_refusals_and_rate_limits_without_secret_echoes() {
    let routes = [
        ("GET", "act_123"),
        ("GET", "act_123/campaigns"),
        ("POST", "act_123/campaigns"),
        ("POST", "act_123/adsets"),
        ("POST", "act_123/adimages"),
        ("POST", "page1/leadgen_forms"),
        ("POST", "act_123/adcreatives"),
        ("POST", "act_123/ads"),
        ("GET", "campaign1"),
        ("GET", "campaign1/insights"),
        ("GET", "act_123/generatepreviews"),
    ];
    for (index, (verb, edge)) in routes.into_iter().enumerate() {
        let r = rig().await;
        if index == 9 {
            r.mock.on(
                "GET",
                "/fb/v27.0/campaign1",
                ok(json!({"account_id":"123"})),
            );
            r.mock.on(
                "GET",
                "/fb/v27.0/act_123",
                ok(json!({"account_id":"123","currency":"TRY","timezone_name":"UTC"})),
            );
        }
        let path = format!("/fb/v27.0/{edge}");
        r.mock.on(verb,&path,status(400,json!({"error":{"code":100,"error_user_title":"Fix input","error_user_msg":format!("Refused {TOKEN} {}",support::META_APP_SECRET),"message":"technical error"}})));
        let e = call_method(&r, index).await.unwrap_err();
        assert_eq!(e.kind(), "permanent", "method {index}");
        let shown = format!("{e:?} {e}");
        assert!(shown.contains("Fix input"));
        assert!(shown.contains("Refused"));
        assert!(!shown.contains(TOKEN));
        assert!(!shown.contains(support::META_APP_SECRET));
        r.mock.set(
            verb,
            &path,
            status(429, json!({"error":{"code":4,"message":TOKEN}}))
                .with_header("retry-after", "23"),
        );
        assert!(
            matches!(call_method(&r,index).await.unwrap_err(),jt_connector::ConnectorError::Throttle {retry_after:Some(wait)} if wait==time::Duration::seconds(23)),
            "method {index}"
        );
        assert_eq!(r.mock.requests(verb, &path).len(), 2);
    }
}

#[tokio::test]
async fn echoed_creative_payload_and_encoded_ad_copy_are_redacted_before_truncation() {
    let r = rig().await;
    // The body as it is sent.
    let body = json!({"name":"test creative","object_story_spec":story(),
        "degrees_of_freedom_spec":{"creative_features_spec":{"product_extensions":{
            "enroll_status":"OPT_OUT","action_metadata":{"type":"MANUAL"}}}}})
    .to_string();
    for message in [
        format!("invalid {body} {TOKEN}"),
        format!(
            "invalid {} {}",
            support::form_encoded("Synthetic primary text"),
            support::lower_encoded(TOKEN)
        ),
    ] {
        r.mock.set("POST","/fb/v27.0/act_123/adcreatives",status(400,json!({"error":{"code":100,"error_user_title":"Fix creative","error_user_msg":message}})));
        let e = r
            .meta
            .create_creative(&cred(), &public(), &creative())
            .await
            .unwrap_err();
        let shown = format!("{e} {e:?}");
        assert!(shown.contains("Fix creative"));
        for secret in [
            TOKEN,
            "Synthetic primary text",
            "Synthetic headline",
            "test creative",
            "object_story_spec",
            "https://example.test/landing",
        ] {
            assert!(!shown.contains(secret), "{shown}");
            assert!(!shown.contains(&support::form_encoded(secret)), "{shown}");
        }
    }
}

#[tokio::test]
async fn incomplete_creation_responses_remain_ambiguous() {
    let r = rig().await;
    for (method, edge) in [
        (2, "act_123/campaigns"),
        (3, "act_123/adsets"),
        (4, "act_123/adimages"),
        (5, "page1/leadgen_forms"),
        (6, "act_123/adcreatives"),
        (7, "act_123/ads"),
    ] {
        r.mock.set(
            "POST",
            &format!("/fb/v27.0/{edge}"),
            ok(json!({"success":true})),
        );
        assert_eq!(call_method(&r, method).await.unwrap_err().kind(), "unknown");
    }
}

#[tokio::test]
async fn invalid_nodes_budgets_and_dates_never_reach_graph() {
    let r = rig().await;
    for id in [
        "../other",
        "123?access_token=secret",
        "https://example.test",
        "123/ads",
    ] {
        assert!(
            r.meta
                .create_campaign(&cred(), &json!({"external_id":id}), &campaign())
                .await
                .is_err()
        );
        assert!(r.meta.campaign_state(&cred(), &public(), id).await.is_err());
    }
    let mut spec = campaign();
    spec.lifetime_budget_minor = 0;
    assert!(
        r.meta
            .create_campaign(&cred(), &public(), &spec)
            .await
            .is_err()
    );
    let mut spec = adset();
    spec.end_at = spec.start_at;
    assert!(
        r.meta
            .create_adset(&cred(), &public(), &spec)
            .await
            .is_err()
    );
    assert!(
        r.meta
            .ad_days(
                &cred(),
                &public(),
                "campaign1",
                AdObjective::Traffic,
                date!(2026 - 11 - 12),
                date!(2026 - 11 - 11)
            )
            .await
            .is_err()
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn malformed_money_counters_dates_and_account_limits_refuse_instead_of_defaulting() {
    let r = rig().await;
    r.mock.on(
        "GET",
        "/fb/v27.0/campaign1",
        ok(json!({"account_id":"123"})),
    );
    for account in [
        json!({"account_id":"other","currency":"TRY","timezone_name":"UTC","min_daily_budget":1}),
        json!({"account_id":"123","currency":"ZZZ","timezone_name":"UTC","min_daily_budget":1}),
        json!({"account_id":"123","currency":"TRY","timezone_name":"UTC"}),
        json!({"account_id":"123","currency":"TRY","timezone_name":"UTC","min_daily_budget":-1}),
    ] {
        r.mock.set("GET", "/fb/v27.0/act_123", ok(account));
        assert_eq!(
            r.meta
                .account_limits(&cred(), &public())
                .await
                .unwrap_err()
                .kind(),
            "permanent"
        );
    }
    r.mock.set(
        "GET",
        "/fb/v27.0/act_123",
        ok(json!({"account_id":"123","currency":"TRY","timezone_name":"UTC"})),
    );
    for (field, bad) in [
        ("spend", json!("1.234")),
        ("spend", json!("9223372036854775808")),
        ("impressions", json!("bad")),
        ("clicks", json!(-1)),
        ("date_start", json!("2026-11-10")),
        // The campaign's own result kind (read here as a traffic campaign).
        (
            "actions",
            json!([{"action_type":"link_click","value":"bad"}]),
        ),
    ] {
        let mut row = json!({"ad_id":"ad1","date_start":"2026-11-11"});
        row[field] = bad;
        r.mock.set(
            "GET",
            "/fb/v27.0/campaign1/insights",
            ok(json!({"data":[row]})),
        );
        assert_eq!(
            r.meta
                .ad_days(
                    &cred(),
                    &public(),
                    "campaign1",
                    AdObjective::Traffic,
                    date!(2026 - 11 - 11),
                    date!(2026 - 11 - 12)
                )
                .await
                .unwrap_err()
                .kind(),
            "permanent",
            "{field}"
        );
    }
}

#[tokio::test]
async fn state_and_daily_numbers_follow_pages_and_refuse_foreign_paging_origins() {
    let r = rig().await;
    r.mock.on(
        "GET",
        "/fb/v27.0/campaign1",
        ok(json!({"account_id":"123","effective_status":"ACTIVE"})),
    );
    let next = format!("{}/v27.0/campaign1/ads?after=next", r.mock.base("/fb"));
    r.mock.on("GET","/fb/v27.0/campaign1/ads",ok(json!({"data":[{"id":"ad1","name":"one","effective_status":"ACTIVE"}],"paging":{"next":next}})));
    r.mock.on(
        "GET",
        "/fb/v27.0/campaign1/ads",
        ok(json!({"data":[{"id":"ad2","name":"two","effective_status":"PAUSED"}]})),
    );
    let state = r
        .meta
        .campaign_state(&cred(), &public(), "campaign1")
        .await
        .unwrap();
    assert_eq!(
        state
            .ads
            .iter()
            .map(|ad| ad.ad_id.as_str())
            .collect::<Vec<_>>(),
        ["ad1", "ad2"]
    );
    assert!(state.ads.iter().all(|ad| ad.feedback.is_none()));
    r.mock.on(
        "GET",
        "/fb/v27.0/act_123",
        ok(json!({"account_id":"123","currency":"TRY","timezone_name":"UTC"})),
    );
    let next = format!("{}/v27.0/campaign1/insights?after=next", r.mock.base("/fb"));
    r.mock.on(
        "GET",
        "/fb/v27.0/campaign1/insights",
        ok(json!({"data":[{"ad_id":"ad1","date_start":"2026-11-11"}],"paging":{"next":next}})),
    );
    r.mock.on(
        "GET",
        "/fb/v27.0/campaign1/insights",
        ok(json!({"data":[{"ad_id":"ad2","date_start":"2026-11-11"}]})),
    );
    let days = r
        .meta
        .ad_days(
            &cred(),
            &public(),
            "campaign1",
            AdObjective::Traffic,
            date!(2026 - 11 - 11),
            date!(2026 - 11 - 12),
        )
        .await
        .unwrap();
    assert_eq!(
        days.iter()
            .map(|day| day.ad_id.as_str())
            .collect::<Vec<_>>(),
        ["ad1", "ad2"]
    );
    r.mock.set(
        "GET",
        "/fb/v27.0/campaign1/ads",
        ok(json!({"data":[],"paging":{"next":"https://example.test/steal-token"}})),
    );
    assert_eq!(
        r.meta
            .campaign_state(&cred(), &public(), "campaign1")
            .await
            .unwrap_err()
            .kind(),
        "permanent"
    );
    for request in r.mock.recorded() {
        assert_auth(&request, TOKEN);
    }
}

#[tokio::test]
async fn malformed_pages_are_not_interpreted_as_no_objects_or_no_results() {
    let r = rig().await;
    r.mock.on(
        "GET",
        "/fb/v27.0/campaign1",
        ok(json!({"account_id":"123","effective_status":"ACTIVE"})),
    );
    r.mock.on(
        "GET",
        "/fb/v27.0/act_123",
        ok(json!({"account_id":"123","currency":"TRY","timezone_name":"UTC"})),
    );
    for malformed in [json!({}), json!({"data":null}), json!({"data":{}})] {
        for (method, edge) in [
            (1, "act_123/campaigns"),
            (8, "campaign1/ads"),
            (9, "campaign1/insights"),
        ] {
            r.mock
                .set("GET", &format!("/fb/v27.0/{edge}"), ok(malformed.clone()));
            assert_eq!(
                call_method(&r, method).await.unwrap_err().kind(),
                "permanent",
                "{edge}"
            );
        }
    }
}

#[tokio::test]
async fn campaign_reads_refuse_another_accounts_campaign_before_reading_ads_or_spend() {
    let r = rig().await;
    r.mock.on(
        "GET",
        "/fb/v27.0/act_123",
        ok(json!({"account_id":"123","currency":"JPY","timezone_name":"UTC"})),
    );
    for row in [
        json!({"account_id":"456","effective_status":"ACTIVE"}),
        json!({"effective_status":"ACTIVE"}),
    ] {
        r.mock.set("GET", "/fb/v27.0/campaign1", ok(row));
        assert_eq!(
            r.meta
                .campaign_state(&cred(), &public(), "campaign1")
                .await
                .unwrap_err()
                .kind(),
            "permanent"
        );
        assert_eq!(
            r.meta
                .ad_days(
                    &cred(),
                    &public(),
                    "campaign1",
                    AdObjective::Traffic,
                    date!(2026 - 11 - 11),
                    date!(2026 - 11 - 12)
                )
                .await
                .unwrap_err()
                .kind(),
            "permanent"
        );
    }
    assert!(r.mock.requests("GET", "/fb/v27.0/campaign1/ads").is_empty());
    assert!(
        r.mock
            .requests("GET", "/fb/v27.0/campaign1/insights")
            .is_empty()
    );
}

#[tokio::test]
async fn malformed_continuations_cannot_hide_a_duplicate() {
    let r = rig().await;
    for paging in [
        json!({"next":42}),
        json!({"next":null}),
        json!({"next":""}),
        json!([]),
        json!("bad"),
    ] {
        r.mock.set(
            "GET",
            "/fb/v27.0/act_123/campaigns",
            ok(json!({"data":[{"id":"one","name":"unique"}],"paging":paging})),
        );
        assert_eq!(
            r.meta
                .find_by_name(&cred(), &public(), AdLevel::Campaign, "unique")
                .await
                .unwrap_err()
                .kind(),
            "permanent"
        );
    }
}

#[tokio::test]
async fn json_escaped_ad_copy_is_not_exposed_in_validation_errors() {
    let r = rig().await;
    let mut spec = creative();
    spec.primary_text = "Synthetic first line\nSecond \"quoted\" line\\end".into();
    let escaped = serde_json::to_string(&spec.primary_text).unwrap();
    r.mock.on("POST","/fb/v27.0/act_123/adcreatives",status(400,json!({"error":{"code":100,"error_user_title":"Fix creative","error_user_msg":format!("Invalid text {escaped}")}})));
    let e = r
        .meta
        .create_creative(&cred(), &public(), &spec)
        .await
        .unwrap_err();
    let shown = format!("{e:?} {e}");
    assert!(shown.contains("Fix creative"));
    assert!(!shown.contains("Synthetic first line"), "{shown}");
    assert!(!shown.contains("Second"), "{shown}");
}
