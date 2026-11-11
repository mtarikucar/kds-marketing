//! Ad campaigns in an X ads account, against the in-process mock of X's Ads API: the ads
//! accounts a sign-in may build in, the probe, the campaign, the line item with its countries,
//! the image, the website card, the promoted-only post and its promotion, the switches (an ad is
//! paused by deleting its promotion), and reading the state and the daily numbers back. Every
//! value is synthetic; nothing here has been run against X.

mod support;

use jt_app::ports::connectors::{
    AdAudience, AdBudgetWriter, AdCampaignWriter, AdLevel, AdObjective, AdPlacement, AdPlacements,
    AdSetGoal, AdSetSpec, AdSpec, AdStatus, CampaignSpec, Connector, CreativeAction, CreativeSpec,
    OAuthApp, OAuthProvider, ProviderAdStatus, PublishRequest, Publisher, XApp,
};
use jt_connector::{ConnectorError, Credential};
use jt_x::{AD_SCOPES, XBases};
use serde_json::{Value, json};
use support::*;
use time::macros::datetime;
use time::{Date, Duration, Month, OffsetDateTime};

const ACCOUNT: &str = "18ce54d4x5t";
const CAMPAIGN: &str = "xa:18ce54d4x5t:campaign:hwtbm";
const LINE: &str = "xa:18ce54d4x5t:line:8v7jo";
const POST: &str = "1822333526255120384";
const AD: &str = "xa:18ce54d4x5t:ad:8v7jo:1822333526255120384";
const MEDIA_KEY: &str = "3_1880028106020515840";
const CARD: &str = "card://1321554298900107264";

const NAME: &str = "jeeta:01a1c9ad-2710-76fc-bfee-95daa5f786da";

fn path(rest: &str) -> String {
    format!("/ads/12/{rest}")
}

fn account_path(rest: &str) -> String {
    format!("/ads/12/accounts/{ACCOUNT}/{rest}")
}

/// A credential of a flow that asked for the ad scopes.
fn ads_cred() -> Credential {
    Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: Some(REFRESH_TOKEN.into()),
        expires_at: Some(OffsetDateTime::now_utc() + Duration::hours(2)),
        scopes: [
            "tweet.read",
            "tweet.write",
            "users.read",
            "offline.access",
            "media.write",
            "ads.read",
            "ads.write",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect(),
    }
}

fn ads_public() -> Value {
    json!({"provider": "x", "kind_key": "x_ads", "external_id": ACCOUNT, "name": "Jeeta Test"})
}

/// The Ads API's answer around `data`.
fn data(data: Value) -> Reply {
    ok(json!({"request": {"params": {}}, "next_cursor": null, "data": data}))
}

fn account() -> Value {
    json!({"id": ACCOUNT, "name": "Jeeta Test Reklam", "timezone": "Europe/Istanbul",
           "approval_status": "ACCEPTED", "deleted": false})
}

fn funding(id: &str, able: bool) -> Value {
    json!({"id": id, "currency": "TRY", "entity_status": "ACTIVE", "able_to_fund": able,
           "type": "CREDIT_CARD", "deleted": false})
}

/// The user an ads account advertises as: its `FULL` promotable user.
fn promotable(user: &str) -> Value {
    json!([
        {"id": "l310s", "user_id": user, "promotable_user_type": "FULL", "deleted": false},
        {"id": "l311t", "user_id": "1700000000000000009",
         "promotable_user_type": "RETWEETS_ONLY", "deleted": false},
    ])
}

/// Scripts an ads account the signed-in user may build in: accepted, permitted, advertising as
/// the signed-in user, one funding instrument that can pay.
fn usable(r: &Rig) {
    r.mock.set(
        "GET",
        &path(&format!("accounts/{ACCOUNT}")),
        data(account()),
    );
    r.mock.set(
        "GET",
        &account_path("authenticated_user_access"),
        data(json!({"user_id": USER_ID, "permissions": ["AD_MANAGER"]})),
    );
    r.mock.set(
        "GET",
        &account_path("promotable_users"),
        data(promotable(USER_ID)),
    );
    r.mock.set(
        "GET",
        &account_path("funding_instruments"),
        data(json!([funding("lygyi", true), funding("old1", false)])),
    );
}

fn campaign_spec() -> CampaignSpec {
    CampaignSpec {
        name: format!("{NAME}:campaign"),
        objective: AdObjective::Traffic,
        lifetime_budget_minor: 150_000,
        start_at: datetime!(2026-11-12 01:30:05 +03:00),
        end_at: datetime!(2026-11-19 01:30:05 +03:00),
    }
}

fn adset_spec(countries: &[&str]) -> AdSetSpec {
    AdSetSpec {
        name: format!("{NAME}:adset"),
        campaign_id: CAMPAIGN.into(),
        goal: AdSetGoal::LinkClicks,
        audience: AdAudience {
            countries: countries.iter().map(|c| (*c).to_owned()).collect(),
            regions: vec![],
            cities: vec![],
            age_min: 18,
            age_max: 65,
            genders: vec![],
            interests: vec![],
            broad: false,
        },
        placements: AdPlacements::Automatic,
        start_at: datetime!(2026-11-12 01:30:05 +03:00),
        end_at: datetime!(2026-11-19 01:30:05 +03:00),
        budget_minor: 150_000,
        keywords: vec![],
    }
}

fn creative() -> CreativeSpec {
    CreativeSpec {
        name: format!("{NAME}:creative:0:0"),
        identity_id: None,
        instagram_user_id: None,
        image: Some(MEDIA_KEY.into()),
        primary_text: " Yeni sezon kayıtları açıldı ".into(),
        headline: " Kayıt ol ".into(),
        description: None,
        headlines: vec![],
        descriptions: vec![],
        call_to_action: None,
        action: CreativeAction::Link {
            url: "https://jeeta.test/kayit".parse().unwrap(),
        },
    }
}

fn ad_spec() -> AdSpec {
    AdSpec {
        name: format!("{NAME}:ad:0:0"),
        adset_id: LINE.into(),
        creative_id: CARD.into(),
        creative: creative(),
    }
}

fn reason(e: &ConnectorError) -> String {
    e.reason().unwrap_or_default().to_owned()
}

/// The decoded query of a recorded request, in the order sent, without the paging count.
fn params(request: &Recorded) -> Vec<(String, String)> {
    request
        .query
        .iter()
        .filter(|(name, _)| name != "count")
        .cloned()
        .collect()
}

fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
        .collect()
}

fn turkey() -> Reply {
    data(
        json!([{"name": "Turkey", "country_code": "TR", "location_type": "COUNTRIES",
                 "targeting_value": "682c5a667856ef42", "targeting_type": "LOCATION"}]),
    )
}

// ---------------------------------------------------------------------------------------------
// The sign-in and the ads accounts it reaches
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_sign_in_asks_for_the_ads_api_only_when_the_platform_app_has_it() {
    let r = rig().await;
    let redirect: url::Url = "https://panel.test/api/connectors/oauth/callback/x"
        .parse()
        .unwrap();
    let scope = |ad_scopes: bool| {
        let app = OAuthApp::X(XApp {
            ad_scopes,
            ..x_app()
        });
        let url =
            r.x.authorize_url(&app, &redirect, "state-1", Some("challenge"))
                .unwrap();
        url.query_pairs()
            .find(|(name, _)| name == "scope")
            .map(|(_, value)| value.into_owned())
            .unwrap()
    };
    assert_eq!(
        scope(false),
        "tweet.read tweet.write users.read offline.access media.write"
    );
    assert_eq!(
        scope(true),
        "tweet.read tweet.write users.read offline.access media.write ads.read ads.write"
    );
    assert_eq!(AD_SCOPES, ["ads.read", "ads.write"]);
    // The Ads API is one more fixed host of this adapter, and nothing else.
    assert_eq!(XBases::production().ads.as_str(), "https://ads-api.x.com/");
    assert!(r.x.hosts().contains(&"ads-api.x.com"));
    assert_eq!(r.x.provider().kinds(), ["x", "x_ads"]);
}

#[tokio::test]
async fn a_sign_in_with_the_ad_scope_offers_the_ads_accounts_it_may_build_in() {
    let r = rig().await;
    r.mock.on("GET", ME, answer("users_me"));
    usable(&r);
    r.mock.on(
        "GET",
        &path("accounts"),
        data(json!([
            account(),
            // Not accepted by X: its own reads say so, and it is left out.
            {"id": "pending1", "name": "Bekleyen", "timezone": "UTC",
             "approval_status": "UNDER_REVIEW", "deleted": false},
            {"id": "gone1", "name": "Silinmiş", "timezone": "UTC",
             "approval_status": "ACCEPTED", "deleted": true},
        ])),
    );
    r.mock.on(
        "GET",
        &path("accounts/pending1"),
        data(
            json!({"id": "pending1", "name": "Bekleyen", "timezone": "UTC",
                    "approval_status": "UNDER_REVIEW", "deleted": false}),
        ),
    );
    let assets = r.x.list_assets(&ads_cred()).await.unwrap();
    let kinds: Vec<&str> = assets.iter().map(|a| a.kind_key.as_str()).collect();
    assert_eq!(kinds, ["x", "x_ads"]);
    assert_eq!(assets[1].external_id, ACCOUNT);
    assert_eq!(assets[1].name, "Jeeta Test Reklam");
    assert_eq!(
        assets[1].public,
        json!({"currency": "TRY", "time_zone": "Europe/Istanbul"})
    );
    let listing = r.mock.request("GET", &path("accounts"));
    assert_eq!(listing.bearer(), Some(ACCESS_TOKEN));
    // The deleted account is never read.
    assert!(r.mock.requests("GET", &path("accounts/gone1")).is_empty());

    // Without the ad scope the Ads API is not asked at all.
    r.mock.clear();
    let assets = r.x.list_assets(&cred()).await.unwrap();
    assert_eq!(assets.len(), 1);
    assert!(r.mock.requests("GET", &path("accounts")).is_empty());
}

#[tokio::test]
async fn an_ads_account_is_usable_only_with_permission_and_one_way_to_pay() {
    let r = rig().await;
    usable(&r);
    let probe = r.x.probe(&ads_cred(), &ads_public()).await;
    assert!(probe.ok, "{probe:?}");
    assert_eq!(
        probe.facts,
        json!({"account_id": ACCOUNT, "name": "Jeeta Test Reklam", "currency": "TRY",
               "time_zone": "Europe/Istanbul"})
    );
    let limits =
        r.x.account_limits(&ads_cred(), &ads_public())
            .await
            .unwrap();
    assert_eq!(
        (limits.currency.as_str(), limits.timezone.as_str()),
        ("TRY", "Europe/Istanbul")
    );
    // X documents no least budget.
    assert_eq!(
        (limits.min_daily_budget_minor, limits.min_total_budget_minor),
        (0, 0)
    );

    // May read but not build.
    r.mock.set(
        "GET",
        &account_path("authenticated_user_access"),
        data(json!({"user_id": USER_ID, "permissions": ["CAMPAIGN_ANALYST", "TWEET_COMPOSER"]})),
    );
    let refused = |probe: &jt_connector::ProbeResult, expected: &str| {
        assert!(
            probe
                .error
                .as_ref()
                .is_some_and(|e| reason(e).contains(expected)),
            "{probe:?}"
        );
    };
    refused(
        &r.x.probe(&ads_cred(), &ads_public()).await,
        "the X user may not build campaigns in this ads account",
    );
    // The account advertises as another user: the signed-in one writes its promoted-only posts
    // only with X's permission to; with it, the account is usable.
    usable(&r);
    r.mock.set(
        "GET",
        &account_path("promotable_users"),
        data(promotable("1700000000000000002")),
    );
    refused(
        &r.x.probe(&ads_cred(), &ads_public()).await,
        "the X user may not write promoted-only posts for this ads account",
    );
    r.mock.set(
        "GET",
        &account_path("authenticated_user_access"),
        data(json!({"user_id": USER_ID, "permissions": ["ACCOUNT_ADMIN", "TWEET_COMPOSER"]})),
    );
    assert!(r.x.probe(&ads_cred(), &ads_public()).await.ok);
    // An account that names no user it advertises as is not guessed at.
    r.mock.set(
        "GET",
        &account_path("promotable_users"),
        data(json!([{"id": "l311t", "user_id": "1700000000000000009",
                     "promotable_user_type": "RETWEETS_ONLY", "deleted": false}])),
    );
    refused(
        &r.x.probe(&ads_cred(), &ads_public()).await,
        "the X ads account names no single user it advertises as",
    );
    usable(&r);
    // No funding instrument that can pay; then two of them: which pays is never guessed.
    for (instruments, expected) in [
        (
            json!([funding("old1", false)]),
            "the X ads account has no funding instrument that can pay",
        ),
        (
            json!([funding("lygyi", true), funding("abcde", true)]),
            "the X ads account has more than one funding instrument that can pay",
        ),
    ] {
        r.mock.set(
            "GET",
            &account_path("funding_instruments"),
            data(instruments),
        );
        let probe = r.x.probe(&ads_cred(), &ads_public()).await;
        assert!(
            probe
                .error
                .as_ref()
                .is_some_and(|e| reason(e).contains(expected)),
            "{probe:?}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Building a campaign
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_campaign_carries_the_budget_as_its_total_and_is_paused() {
    let r = rig().await;
    usable(&r);
    r.mock
        .on("GET", &account_path("campaigns"), data(json!([])));
    r.mock.on(
        "POST",
        &account_path("campaigns"),
        data(json!({"id": "hwtbm", "entity_status": "PAUSED", "currency": "TRY"})),
    );
    let spec = campaign_spec();
    let found =
        r.x.find_by_name(&ads_cred(), &ads_public(), AdLevel::Campaign, &spec.name)
            .await
            .unwrap();
    assert_eq!(found, None);
    assert_eq!(
        params(&r.mock.request("GET", &account_path("campaigns"))),
        pairs(&[("q", &spec.name)])
    );
    let id =
        r.x.create_campaign(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(id, CAMPAIGN);
    let sent = r.mock.request("POST", &account_path("campaigns"));
    assert_eq!(sent.bearer(), Some(ACCESS_TOKEN));
    assert!(sent.bytes.is_empty(), "the parameters travel in the query");
    // 1,500.00 lira in micros; the daily budget X asks for is the total itself.
    assert_eq!(
        params(&sent),
        pairs(&[
            ("funding_instrument_id", "lygyi"),
            ("name", &spec.name),
            ("total_budget_amount_local_micro", "1500000000"),
            ("daily_budget_amount_local_micro", "1500000000"),
            ("entity_status", "PAUSED"),
        ])
    );
}

#[tokio::test]
async fn a_name_is_matched_exactly_though_x_matches_its_beginning() {
    let r = rig().await;
    let name = format!("{NAME}:campaign");
    r.mock.on(
        "GET",
        &account_path("campaigns"),
        data(json!([
            {"id": "other", "name": format!("{name}-2"), "deleted": false},
            {"id": "gone", "name": name, "deleted": true},
            {"id": "hwtbm", "name": name, "deleted": false},
        ])),
    );
    let found =
        r.x.find_by_name(&ads_cred(), &ads_public(), AdLevel::Campaign, &name)
            .await
            .unwrap();
    assert_eq!(found.as_deref(), Some(CAMPAIGN));
    // A card is found by its name too; the line item and the ad are adopted by their own steps.
    r.mock.on(
        "GET",
        &account_path("cards"),
        data(json!([{"name": "card-name", "card_uri": CARD, "deleted": false}])),
    );
    let found =
        r.x.find_by_name(&ads_cred(), &ads_public(), AdLevel::Creative, "card-name")
            .await
            .unwrap();
    assert_eq!(found.as_deref(), Some(CARD));
    r.mock.clear();
    for level in [AdLevel::AdSet, AdLevel::Ad] {
        let found =
            r.x.find_by_name(&ads_cred(), &ads_public(), level, "x")
                .await
                .unwrap();
        assert_eq!(found, None);
    }
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn the_line_item_is_paused_and_answers_only_once_every_country_is_on_it() {
    let r = rig().await;
    usable(&r);
    r.mock
        .on("GET", &path("targeting_criteria/locations"), turkey());
    r.mock
        .on("GET", &account_path("line_items"), data(json!([])));
    r.mock.on(
        "POST",
        &account_path("line_items"),
        data(json!({"id": "8v7jo", "advertiser_user_id": USER_ID, "entity_status": "PAUSED"})),
    );
    r.mock
        .on("GET", &account_path("targeting_criteria"), data(json!([])));
    r.mock.on(
        "POST",
        &account_path("targeting_criteria"),
        data(json!({"id": "fbyjlr", "line_item_id": "8v7jo"})),
    );
    let spec = adset_spec(&["TR"]);
    let id =
        r.x.create_adset(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(id, LINE);
    assert_eq!(
        params(&r.mock.request("GET", &path("targeting_criteria/locations"))),
        pairs(&[("location_type", "COUNTRIES"), ("country_code", "TR")])
    );
    assert_eq!(
        params(&r.mock.request("POST", &account_path("line_items"))),
        pairs(&[
            ("campaign_id", "hwtbm"),
            ("name", &spec.name),
            ("objective", "WEBSITE_CLICKS"),
            ("product_type", "PROMOTED_TWEETS"),
            ("placements", "ALL_ON_TWITTER"),
            ("start_time", "2026-11-11T22:30:05Z"),
            ("end_time", "2026-11-18T22:30:05Z"),
            ("total_budget_amount_local_micro", "1500000000"),
            ("bid_strategy", "AUTO"),
            ("goal", "LINK_CLICKS"),
            ("entity_status", "PAUSED"),
        ])
    );
    assert_eq!(
        params(&r.mock.request("POST", &account_path("targeting_criteria"))),
        pairs(&[
            ("line_item_id", "8v7jo"),
            ("operator_type", "EQ"),
            ("targeting_type", "LOCATION"),
            ("targeting_value", "682c5a667856ef42"),
        ])
    );
}

#[tokio::test]
async fn a_line_item_made_before_a_lost_answer_is_adopted_and_gets_the_country_it_lacks() {
    let r = rig().await;
    usable(&r);
    r.mock
        .on("GET", &path("targeting_criteria/locations"), turkey());
    let spec = adset_spec(&["TR"]);
    // The line item is there, but its country never arrived: everybody, everywhere.
    r.mock.on(
        "GET",
        &account_path("line_items"),
        data(json!([{"id": "8v7jo", "name": spec.name, "deleted": false}])),
    );
    r.mock
        .on("GET", &account_path("targeting_criteria"), data(json!([])));
    r.mock.on(
        "POST",
        &account_path("targeting_criteria"),
        data(json!({"id": "fbyjlr"})),
    );
    let id =
        r.x.create_adset(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(id, LINE);
    assert!(
        r.mock
            .requests("POST", &account_path("line_items"))
            .is_empty()
    );
    assert_eq!(
        r.mock
            .requests("POST", &account_path("targeting_criteria"))
            .len(),
        1
    );

    // With the country already on it, nothing is written at all.
    r.mock.clear();
    r.mock.set(
        "GET",
        &account_path("targeting_criteria"),
        data(
            json!([{"id": "fbyjlr", "line_item_id": "8v7jo", "targeting_type": "LOCATION",
                     "targeting_value": "682c5a667856ef42", "deleted": false}]),
        ),
    );
    r.x.create_adset(&ads_cred(), &ads_public(), &spec)
        .await
        .unwrap();
    assert!(
        r.mock
            .recorded()
            .iter()
            .all(|request| request.method == "GET")
    );
}

#[tokio::test]
async fn a_country_x_does_not_know_stops_the_step_before_anything_is_made() {
    let r = rig().await;
    usable(&r);
    r.mock.on(
        "GET",
        &path("targeting_criteria/locations"),
        data(json!([])),
    );
    let e =
        r.x.create_adset(&ads_cred(), &ads_public(), &adset_spec(&["ZZ"]))
            .await
            .unwrap_err();
    assert_eq!(reason(&e), "X names no single location for the country ZZ");
    assert!(
        r.mock
            .recorded()
            .iter()
            .all(|request| request.method == "GET")
    );
}

#[tokio::test]
async fn the_image_goes_to_the_media_library_and_the_card_carries_it_with_the_title_and_the_address()
 {
    let r = rig().await;
    usable(&r);
    r.mock.on(
        "POST",
        UPLOAD,
        ok(
            json!({"data": {"id": "1880028106020515840", "media_key": MEDIA_KEY,
                           "expires_after_secs": 86400}}),
        ),
    );
    r.mock.on(
        "POST",
        &account_path("media_library"),
        data(json!({"media_key": MEDIA_KEY, "media_type": "IMAGE", "name": "jeeta-ad-0"})),
    );
    let png = b"\x89PNG\r\n\x1a\n-synthetic-image-bytes";
    let key =
        r.x.upload_image(&ads_cred(), &ads_public(), png, "jeeta-ad-0")
            .await
            .unwrap();
    assert_eq!(key, MEDIA_KEY);
    // The upload is the signed-in user's own, who is the user the account advertises as: no
    // other owner is named. Then the image is put in the account's media library.
    let upload = r.mock.request("POST", UPLOAD);
    let fields: Vec<String> = upload.parts().into_iter().map(|part| part.name).collect();
    assert_eq!(fields, ["media", "media_category"]);
    assert_eq!(
        params(&r.mock.request("POST", &account_path("media_library"))),
        pairs(&[("media_key", MEDIA_KEY), ("name", "jeeta-ad-0")])
    );
    // An answer that names no key: an image's key is its media id behind `3_`.
    r.mock.clear();
    r.mock.set(
        "POST",
        UPLOAD,
        ok(json!({"data": {"id": "1880028106020515840"}})),
    );
    let key =
        r.x.upload_image(&ads_cred(), &ads_public(), png, "jeeta-ad-0")
            .await
            .unwrap();
    assert_eq!(key, MEDIA_KEY);
    assert_eq!(
        r.mock
            .request("POST", &account_path("media_library"))
            .param("media_key"),
        Some(MEDIA_KEY)
    );
    // A post written on behalf of the account's user: that user is named as another owner of
    // the upload.
    r.mock.clear();
    r.mock.set(
        "GET",
        &account_path("promotable_users"),
        data(promotable("1700000000000000002")),
    );
    r.mock.set(
        "GET",
        &account_path("authenticated_user_access"),
        data(json!({"user_id": USER_ID, "permissions": ["AD_MANAGER", "TWEET_COMPOSER"]})),
    );
    r.x.upload_image(&ads_cred(), &ads_public(), png, "jeeta-ad-0")
        .await
        .unwrap();
    let owner = r
        .mock
        .request("POST", UPLOAD)
        .parts()
        .into_iter()
        .find(|part| part.name == "additional_owners")
        .map(|part| String::from_utf8(part.data).unwrap());
    assert_eq!(owner.as_deref(), Some("1700000000000000002"));
    // A library that does not take the image stops the step: no card is made of it.
    r.mock.set(
        "POST",
        &account_path("media_library"),
        status(
            400,
            json!({"errors": [{"code": "INVALID_PARAMETER", "message": "media_key is invalid"}]}),
        ),
    );
    let e =
        r.x.upload_image(&ads_cred(), &ads_public(), png, "jeeta-ad-0")
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    // Another type, or an image too large for a card, is refused before anything is sent.
    r.mock.clear();
    let e =
        r.x.upload_image(&ads_cred(), &ads_public(), b"GIF89a....", "jeeta-ad-0")
            .await
            .unwrap_err();
    assert_eq!(reason(&e), "an X ad image is a JPG or a PNG");
    let mut large = png.to_vec();
    large.resize(3 * 1024 * 1024 + 1, 0);
    let e =
        r.x.upload_image(&ads_cred(), &ads_public(), &large, "jeeta-ad-0")
            .await
            .unwrap_err();
    assert_eq!(reason(&e), "an X ad image is at most 3 MB");
    assert!(r.mock.recorded().is_empty());

    r.mock.on(
        "POST",
        &account_path("cards"),
        data(json!({"id": "1321554298900107264", "card_uri": CARD, "card_type": "IMAGE_WEBSITE"})),
    );
    let spec = creative();
    let card =
        r.x.create_creative(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(card, CARD);
    let sent = r.mock.request("POST", &account_path("cards"));
    assert!(
        sent.header("content-type")
            .is_some_and(|t| t.starts_with("application/json"))
    );
    // A website card has a title and an address, and no button.
    assert_eq!(
        sent.json(),
        json!({"name": spec.name, "components": [
            {"type": "MEDIA", "media_key": MEDIA_KEY},
            {"type": "DETAILS", "title": "Kayıt ol",
             "destination": {"type": "WEBSITE", "url": "https://jeeta.test/kayit"}},
        ]})
    );
}

/// Scripts what the ad step reads and writes: no post of the name yet, and the post X makes.
fn script_ad(r: &Rig) {
    r.mock.on("GET", &account_path("tweets"), data(json!([])));
    r.mock.on(
        "POST",
        &account_path("tweet"),
        data(json!({"id": 1_822_333_526_255_120_384_u64, "id_str": POST, "name": "n"})),
    );
}

#[tokio::test]
async fn the_ad_is_a_promoted_only_post_of_the_accounts_user_and_is_created_off() {
    let r = rig().await;
    script_ad(&r);
    let spec = ad_spec();
    let id =
        r.x.create_ad(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(id, AD);
    assert_eq!(
        params(&r.mock.request("GET", &account_path("tweets"))),
        pairs(&[
            ("tweet_type", "PUBLISHED"),
            ("timeline_type", "NULLCAST"),
            ("name", &spec.name),
        ])
    );
    // No user is named: X writes the post for the user the account advertises as.
    assert_eq!(
        params(&r.mock.request("POST", &account_path("tweet"))),
        pairs(&[
            ("text", "Yeni sezon kayıtları açıldı"),
            ("card_uri", CARD),
            ("nullcast", "true"),
            ("name", &spec.name),
        ])
    );
    // X has no paused promotion: the post is not promoted until the ad is switched on, so an
    // ad made for a campaign that already runs does not run before the build says so.
    assert_eq!(r.mock.recorded().len(), 2);
    assert!(
        r.mock
            .requests("POST", &account_path("promoted_tweets"))
            .is_empty()
    );
}

#[tokio::test]
async fn a_post_made_before_a_lost_answer_is_not_written_twice() {
    let r = rig().await;
    script_ad(&r);
    let spec = ad_spec();
    r.mock.set(
        "GET",
        &account_path("tweets"),
        data(json!([
            {"id_str": "1999", "name": format!("{}-2", spec.name)},
            {"id_str": POST, "name": spec.name},
        ])),
    );
    let id =
        r.x.create_ad(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(id, AD);
    assert!(
        r.mock
            .recorded()
            .iter()
            .all(|request| request.method == "GET")
    );
}

#[tokio::test]
async fn an_ad_x_cannot_show_is_refused_before_anything_is_sent() {
    let r = rig().await;
    type Change = Box<dyn Fn(&mut AdSpec)>;
    let cases: Vec<(Change, &str)> = vec![
        (
            Box::new(|a| a.creative.image = Some("hash".into())),
            "an X ad needs its image",
        ),
        (
            Box::new(|a| a.creative.primary_text = "x".repeat(281)),
            "an X ad's text is 1 to 280 characters",
        ),
        // X counts an emoji twice: 141 of them are 282.
        (
            Box::new(|a| a.creative.primary_text = "🎉".repeat(141)),
            "an X ad's text is 1 to 280 characters",
        ),
        // The card carries the address: X takes a card or a link in the post, not both.
        (
            Box::new(|a| a.creative.primary_text = "Kayıt: https://jeeta.test/kayit".into()),
            "an X ad's text carries no link: its card does",
        ),
        (
            Box::new(|a| a.creative.primary_text = "Kayıt: www.jeeta.test".into()),
            "an X ad's text carries no link: its card does",
        ),
        (
            Box::new(|a| a.creative.headline = "x".repeat(71)),
            "an X ad's card title is 1 to 70 characters",
        ),
        (
            Box::new(|a| a.name = "n".repeat(81)),
            "an X card or post name is at most 80 characters",
        ),
        (
            Box::new(|a| a.creative_id = "inline".into()),
            "an X ad needs its card",
        ),
        (
            Box::new(|a| a.adset_id = CAMPAIGN.into()),
            "not an X ad object of the expected kind",
        ),
        (
            Box::new(|a| a.adset_id = "xa:other:line:8v7jo".into()),
            "the object is of another X ads account",
        ),
    ];
    for (change, expected) in cases {
        let mut spec = ad_spec();
        change(&mut spec);
        let e =
            r.x.create_ad(&ads_cred(), &ads_public(), &spec)
                .await
                .unwrap_err();
        assert_eq!(reason(&e), expected);
    }
    assert!(r.mock.recorded().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Switching on and off
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_campaigns_switch_takes_its_line_items_and_an_ad_is_paused_by_deleting_its_promotion() {
    let r = rig().await;
    for rest in ["campaigns/hwtbm", "line_items/8v7jo"] {
        r.mock.on("PUT", &account_path(rest), data(json!({})));
    }
    r.mock.on(
        "GET",
        &account_path("line_items"),
        data(json!([{"id": "8v7jo", "deleted": false}, {"id": "gone1", "deleted": true}])),
    );
    r.x.set_status(&ads_cred(), LINE, AdStatus::Active)
        .await
        .unwrap();
    assert_eq!(
        params(&r.mock.request("PUT", &account_path("line_items/8v7jo"))),
        pairs(&[("entity_status", "ACTIVE")])
    );
    // The writes of the calls so far, in order: the level and what it was switched to.
    let switched = |r: &Rig| -> Vec<(String, String)> {
        r.mock
            .recorded()
            .iter()
            .filter(|request| request.method == "PUT")
            .map(|request| {
                (
                    request.path.rsplit('/').nth(1).unwrap().to_owned(),
                    request.param("entity_status").unwrap().to_owned(),
                )
            })
            .collect()
    };
    // X's total is no hard limit, so Jeeta's pause is the limit: the campaign goes off first,
    // then its line item (a deleted one is left alone).
    r.mock.clear();
    r.x.set_status(&ads_cred(), CAMPAIGN, AdStatus::Paused)
        .await
        .unwrap();
    assert_eq!(
        switched(&r),
        pairs(&[("campaigns", "PAUSED"), ("line_items", "PAUSED")])
    );
    assert_eq!(
        params(&r.mock.request("GET", &account_path("line_items"))),
        pairs(&[("campaign_ids", "hwtbm")])
    );
    assert!(
        r.mock
            .requests("PUT", &account_path("line_items/gone1"))
            .is_empty()
    );
    // A release turns the line item on first and the campaign last.
    r.mock.clear();
    r.x.set_status(&ads_cred(), CAMPAIGN, AdStatus::Active)
        .await
        .unwrap();
    assert_eq!(
        switched(&r),
        pairs(&[("line_items", "ACTIVE"), ("campaigns", "ACTIVE")])
    );
    // A pause that did not reach the line item is not a pause: the next try sends both again.
    r.mock.clear();
    r.mock.set(
        "PUT",
        &account_path("line_items/8v7jo"),
        status(
            503,
            json!({"errors": [{"code": "SERVICE_UNAVAILABLE", "message": "later"}]}),
        ),
    );
    let e =
        r.x.set_status(&ads_cred(), CAMPAIGN, AdStatus::Paused)
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "transient");
    r.mock
        .set("PUT", &account_path("line_items/8v7jo"), data(json!({})));
    // A campaign whose own switch does not answer still has its line item turned off: one
    // switch off is better than none. The pause is told as failed, and is sent again.
    r.mock.clear();
    r.mock.set(
        "PUT",
        &account_path("campaigns/hwtbm"),
        status(
            503,
            json!({"errors": [{"code": "SERVICE_UNAVAILABLE", "message": "later"}]}),
        ),
    );
    let e =
        r.x.set_status(&ads_cred(), CAMPAIGN, AdStatus::Paused)
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "transient");
    assert_eq!(
        switched(&r),
        pairs(&[("campaigns", "PAUSED"), ("line_items", "PAUSED")])
    );
    r.mock
        .set("PUT", &account_path("campaigns/hwtbm"), data(json!({})));

    // Pausing the ad deletes the promotion that is there; the post stays.
    r.mock.clear();
    r.mock.set(
        "GET",
        &account_path("promoted_tweets"),
        data(json!([
            {"id": "1e8i2k", "line_item_id": "8v7jo", "tweet_id": POST, "deleted": false},
            {"id": "other1", "line_item_id": "8v7jo", "tweet_id": "1999", "deleted": false},
        ])),
    );
    r.mock.on(
        "DELETE",
        &account_path("promoted_tweets/1e8i2k"),
        data(json!({"id": "1e8i2k", "deleted": true})),
    );
    r.x.set_status(&ads_cred(), AD, AdStatus::Paused)
        .await
        .unwrap();
    assert_eq!(
        r.mock
            .requests("DELETE", &account_path("promoted_tweets/1e8i2k"))
            .len(),
        1
    );
    assert!(
        r.mock
            .requests("DELETE", &account_path("promoted_tweets/other1"))
            .is_empty()
    );
    // Resuming it makes the promotion again; an ad that is already promoted is left alone.
    r.mock.clear();
    r.mock
        .set("GET", &account_path("promoted_tweets"), data(json!([])));
    r.mock.on(
        "POST",
        &account_path("promoted_tweets"),
        data(json!([{"id": "2f9j3l"}])),
    );
    r.x.set_status(&ads_cred(), AD, AdStatus::Active)
        .await
        .unwrap();
    assert_eq!(
        params(&r.mock.request("POST", &account_path("promoted_tweets"))),
        pairs(&[("line_item_id", "8v7jo"), ("tweet_ids", POST)])
    );
    r.mock.clear();
    r.mock.set(
        "GET",
        &account_path("promoted_tweets"),
        data(json!([{"id": "2f9j3l", "line_item_id": "8v7jo", "tweet_id": POST}])),
    );
    r.x.set_status(&ads_cred(), AD, AdStatus::Active)
        .await
        .unwrap();
    assert!(
        r.mock
            .requests("POST", &account_path("promoted_tweets"))
            .is_empty()
    );

    r.mock.clear();
    let e =
        r.x.set_status(&ads_cred(), "hwtbm", AdStatus::Active)
            .await
            .unwrap_err();
    assert_eq!(reason(&e), "not an X ad object of the expected kind");
    assert!(r.mock.recorded().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_state_is_the_campaigns_switch_and_each_ads_promotion_that_is_there() {
    let r = rig().await;
    r.mock.on(
        "GET",
        &account_path("campaigns/hwtbm"),
        data(
            json!({"id": "hwtbm", "entity_status": "ACTIVE", "servable": true,
                    "deleted": false}),
        ),
    );
    r.mock.on(
        "GET",
        &account_path("line_items"),
        data(json!([{"id": "8v7jo", "deleted": false}])),
    );
    r.mock.on(
        "GET",
        &account_path("promoted_tweets"),
        data(json!([
            // Paused once (its first promotion was deleted) and resumed: it runs.
            {"id": "1e8i2k", "line_item_id": "8v7jo", "tweet_id": POST, "deleted": true,
             "entity_status": "ACTIVE", "approval_status": "ACCEPTED"},
            {"id": "2f9j3l", "line_item_id": "8v7jo", "tweet_id": POST, "deleted": false,
             "entity_status": "ACTIVE", "approval_status": "ACCEPTED"},
            // Paused: nothing of it is there.
            {"id": "3g0k4m", "line_item_id": "8v7jo", "tweet_id": "1900", "deleted": true,
             "entity_status": "ACTIVE", "approval_status": "ACCEPTED"},
            // Not reviewed yet; turned down.
            {"id": "4h1l5n", "line_item_id": "8v7jo", "tweet_id": "1901", "deleted": false,
             "entity_status": "ACTIVE", "approval_status": "PENDING"},
            {"id": "5i2m6o", "line_item_id": "8v7jo", "tweet_id": "1902", "deleted": false,
             "entity_status": "ACTIVE", "approval_status": "REJECTED"},
        ])),
    );
    let state =
        r.x.campaign_state(&ads_cred(), &ads_public(), CAMPAIGN)
            .await
            .unwrap();
    assert_eq!(state.campaign, ProviderAdStatus::Active);
    let seen: Vec<(&str, &ProviderAdStatus)> = state
        .ads
        .iter()
        .map(|ad| (ad.ad_id.as_str(), &ad.status))
        .collect();
    assert_eq!(
        seen,
        [
            (AD, &ProviderAdStatus::Active),
            ("xa:18ce54d4x5t:ad:8v7jo:1900", &ProviderAdStatus::Paused),
            ("xa:18ce54d4x5t:ad:8v7jo:1901", &ProviderAdStatus::InReview),
            (
                "xa:18ce54d4x5t:ad:8v7jo:1902",
                &ProviderAdStatus::Disapproved
            ),
        ]
    );
    assert_eq!(
        params(&r.mock.request("GET", &account_path("promoted_tweets"))),
        pairs(&[("line_item_ids", "8v7jo"), ("with_deleted", "true")])
    );
}

/// Scripts a campaign of one line item whose one ad was paused once and resumed: two promotions.
fn script_promotions(r: &Rig) {
    usable(r);
    r.mock.on(
        "GET",
        &account_path("line_items"),
        data(json!([{"id": "8v7jo", "deleted": false}])),
    );
    r.mock.on(
        "GET",
        &account_path("promoted_tweets"),
        data(json!([
            {"id": "1e8i2k", "line_item_id": "8v7jo", "tweet_id": POST, "deleted": true},
            {"id": "2f9j3l", "line_item_id": "8v7jo", "tweet_id": POST, "deleted": false},
        ])),
    );
}

fn stats() -> String {
    path(&format!("stats/accounts/{ACCOUNT}"))
}

#[tokio::test]
async fn the_days_add_up_every_promotion_an_ad_ever_had_a_week_at_a_time() {
    let r = rig().await;
    script_promotions(&r);
    // The first week begins a day before the first day asked for (11 November): nothing
    // happened on it. The ad ran through its first promotion on the 12th and through both on
    // the 13th.
    r.mock.on(
        "GET",
        &stats(),
        ok(
            json!({"data_type": "stats", "time_series_length": 7, "data": [
                {"id": "1e8i2k", "id_data": [{"segment": null, "metrics": {
                    "impressions": [0, 1000, 0, 0, 0, 0, 0], "clicks": [0, 40, 0, 0, 0, 0, 0],
                    "url_clicks": [0, 25, 0, 0, 0, 0, 0],
                    "billed_charge_local_micro": [0, 12_345_678, 4_000, 0, 0, 0, 0]}}]},
                {"id": "2f9j3l", "id_data": [{"segment": null, "metrics": {
                    "impressions": [0, 0, 500, 0, 0, 0, 0], "clicks": null,
                    "url_clicks": [0, 0, 10, 0, 0, 0, 0],
                    "billed_charge_local_micro": [0, 0, 5_004_000, 0, 0, 0, 0]}}]},
            ]}),
        ),
    );
    // The second piece ends a day after the last day asked for (21 November): east of UTC the
    // ads account's day has begun by then, and what was spent on it is told.
    r.mock.on(
        "GET",
        &stats(),
        ok(
            json!({"data_type": "stats", "time_series_length": 4, "data": [
                {"id": "2f9j3l", "id_data": [{"segment": null, "metrics": {
                    "impressions": [0, 0, 0, 70], "clicks": null, "url_clicks": null,
                    "billed_charge_local_micro": [0, 0, 0, 1_500_000]}}]},
            ]}),
        ),
    );
    let since = Date::from_calendar_date(2026, Month::November, 12).unwrap();
    let until = Date::from_calendar_date(2026, Month::November, 20).unwrap();
    let days =
        r.x.ad_days(
            &ads_cred(),
            &ads_public(),
            CAMPAIGN,
            AdObjective::Traffic,
            since,
            until,
        )
        .await
        .unwrap();
    assert!(days.iter().all(|d| d.ad_id == AD));
    let of = |day: Date| days.iter().find(|d| d.day == day);
    // The day before the first: nothing happened, nothing is told.
    assert!(of(since.previous_day().unwrap()).is_none());
    let first = of(since).unwrap();
    // 12.345678 lira is 1,235 kuruş.
    assert_eq!(first.spend_minor, Some(1235));
    assert_eq!(
        (first.impressions, first.clicks, first.results),
        (Some(1000), Some(40), Some(25))
    );
    // The two promotions' numbers of the same day are one ad's, and are added before the spend
    // is rounded: 0.004 and 5.004 lira are 5.008, which is 501 kuruş (not 0 and 500).
    let second = of(since.next_day().unwrap()).unwrap();
    assert_eq!(second.spend_minor, Some(501));
    assert_eq!(
        (second.impressions, second.clicks, second.results),
        (Some(500), Some(0), Some(10))
    );
    // A day of the range on which nothing happened is told as such.
    assert_eq!(of(until).unwrap().spend_minor, Some(0));
    // The day after the last: 1.50 lira were spent on the account's own day.
    let ahead = of(until.next_day().unwrap()).unwrap();
    assert_eq!(
        (ahead.spend_minor, ahead.impressions),
        (Some(150), Some(70))
    );

    let calls = r.mock.requests("GET", &stats());
    assert_eq!(calls.len(), 2);
    assert_eq!(
        params(&calls[0]),
        pairs(&[
            ("entity", "PROMOTED_TWEET"),
            ("entity_ids", "1e8i2k,2f9j3l"),
            ("start_time", "2026-11-11"),
            // The end is the first day left out.
            ("end_time", "2026-11-18"),
            ("granularity", "DAY"),
            ("placement", "ALL_ON_TWITTER"),
            ("metric_groups", "ENGAGEMENT,BILLING"),
        ])
    );
    assert_eq!(calls[1].param("start_time"), Some("2026-11-18"));
    assert_eq!(calls[1].param("end_time"), Some("2026-11-22"));
    // What a line item spent before somebody deleted it is still spent.
    assert_eq!(
        params(&r.mock.request("GET", &account_path("line_items"))),
        pairs(&[("campaign_ids", "hwtbm"), ("with_deleted", "true")])
    );
}

#[tokio::test]
async fn a_day_ahead_that_x_does_not_take_is_left_out_and_the_rest_is_still_read() {
    let r = rig().await;
    script_promotions(&r);
    // X refuses the range that reaches a day ahead; the same range without it answers.
    r.mock.on(
        "GET",
        &stats(),
        status(
            400,
            json!({"errors": [{"code": "INVALID_PARAMETER", "message": "end_time is invalid"}]}),
        ),
    );
    r.mock.on(
        "GET",
        &stats(),
        ok(
            json!({"data_type": "stats", "time_series_length": 2, "data": [
                {"id": "2f9j3l", "id_data": [{"segment": null, "metrics": {
                    "impressions": [0, 300], "clicks": [0, 9], "url_clicks": [0, 4],
                    "billed_charge_local_micro": [0, 2_000_000]}}]},
            ]}),
        ),
    );
    let day = Date::from_calendar_date(2026, Month::November, 12).unwrap();
    let days =
        r.x.ad_days(
            &ads_cred(),
            &ads_public(),
            CAMPAIGN,
            AdObjective::Traffic,
            day,
            day,
        )
        .await
        .unwrap();
    assert_eq!(days.len(), 1);
    assert_eq!((days[0].day, days[0].spend_minor), (day, Some(200)));
    let calls = r.mock.requests("GET", &stats());
    assert_eq!(calls.len(), 2);
    assert_eq!(
        (calls[0].param("start_time"), calls[0].param("end_time")),
        (Some("2026-11-11"), Some("2026-11-14"))
    );
    assert_eq!(
        (calls[1].param("start_time"), calls[1].param("end_time")),
        (Some("2026-11-11"), Some("2026-11-13"))
    );
    // A refusal of the range itself is told: nothing is read as "no spend".
    r.mock.set(
        "GET",
        &stats(),
        status(
            400,
            json!({"errors": [{"code": "INVALID_PARAMETER", "message": "entity_ids is invalid"}]}),
        ),
    );
    let e =
        r.x.ad_days(
            &ads_cred(),
            &ads_public(),
            CAMPAIGN,
            AdObjective::Traffic,
            day,
            day,
        )
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent");
}

// ---------------------------------------------------------------------------------------------
// What an ads account is not, and what an error says
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn an_ads_account_posts_nothing_and_another_kind_builds_no_campaign() {
    let r = rig().await;
    let e =
        r.x.publish(
            &ads_cred(),
            &ads_public(),
            &PublishRequest {
                text: "Merhaba".into(),
                ..PublishRequest::default()
            },
        )
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    let e =
        r.x.account_limits(&ads_cred(), &public())
            .await
            .unwrap_err();
    assert_eq!(reason(&e), "not an X ads account");
    let mut malformed = ads_public();
    malformed["external_id"] = json!("18ce/../x");
    let e =
        r.x.account_limits(&ads_cred(), &malformed)
            .await
            .unwrap_err();
    assert_eq!(reason(&e), "the X ads account id is missing");
    let e =
        r.x.preview(
            &ads_cred(),
            &ads_public(),
            &creative(),
            AdPlacement::FacebookFeed,
        )
        .await
        .unwrap_err();
    assert_eq!(
        reason(&e),
        "an ad preview is not offered for an X ads account"
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn an_ads_api_error_names_its_code_and_no_secret() {
    let r = rig().await;
    usable(&r);
    r.mock.on(
        "POST",
        &account_path("campaigns"),
        status(
            400,
            json!({"errors": [{"code": "INVALID_PARAMETER",
                "message": format!("Invalid total budget for token {ACCESS_TOKEN}"),
                "parameter": "total_budget_amount_local_micro"}],
                "request": {"params": {}}}),
        ),
    );
    let e =
        r.x.create_campaign(&ads_cred(), &ads_public(), &campaign_spec())
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    let said = reason(&e);
    assert!(said.contains("INVALID_PARAMETER"), "{said}");
    assert!(said.contains("Invalid total budget"), "{said}");
    assert_no_secret(&format!("{e:?} {said}"));

    // A write whose answer never arrived is not sent again: the next run looks by name.
    r.mock.set(
        "POST",
        &account_path("campaigns"),
        status(
            503,
            json!({"errors": [{"code": "SERVICE_UNAVAILABLE", "message": "later"}]}),
        ),
    );
    let e =
        r.x.create_campaign(&ads_cred(), &ads_public(), &campaign_spec())
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "transient");
}
