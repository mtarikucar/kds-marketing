//! Ad campaigns in a TikTok ad account, against the in-process mock of TikTok's API for
//! Business: the authorization of the platform's TikTok for Business app, the ad accounts it
//! covers, the probe, the campaign, the ad group, the image, the music, the ad, the switches,
//! and reading the state and the daily numbers back. Every value is synthetic; nothing here has
//! been run against TikTok.

mod support;

use jt_app::ports::connectors::{
    AdAudience, AdBudgetWriter, AdCampaignWriter, AdLevel, AdObjective, AdPlacement, AdPlacements,
    AdSetGoal, AdSetSpec, AdSpec, AdStatus, CallToAction, CampaignSpec, Connector, CreativeAction,
    CreativeSpec, OAuthApp, OAuthProvider, ProviderAdStatus, PublishRequest, Publisher,
    TiktokAdsApp,
};
use jt_connector::{ConnectorError, Credential};
use serde_json::{Value, json};
use support::*;
use time::macros::datetime;
use time::{Date, Month};
use url::Url;

const ADVERTISER: &str = "7200000000000000001";
const CAMPAIGN: &str = "tt:7200000000000000001:campaign:1810000000000001";
const ADGROUP: &str = "tt:7200000000000000001:adgroup:1820000000000001";
const AD: &str = "tt:7200000000000000001:ad:1830000000000001";
const IMAGE: &str = "ad-site-i18n-sg/20261111-synthetic-image";
const ADS_TOKEN: &str = "tt-ads-access-SECRET-0";
const AUTH_CODE: &str = "tt-ads-authcode-SECRET-0";

const B: &str = "/business/open_api/v1.3";
const NAME: &str = "jeeta:01a1c9ad-2710-76fc-bfee-95daa5f786da";

fn path(rest: &str) -> String {
    format!("{B}/{rest}/")
}

/// An advertiser's credential: no expiry, no refresh token, the permissions TikTok granted.
fn ads_cred() -> Credential {
    Credential::OAuth {
        access_token: ADS_TOKEN.into(),
        refresh_token: None,
        expires_at: None,
        scopes: ["1", "2", "4", "6"]
            .iter()
            .map(|id| format!("tiktok_business:{id}"))
            .collect(),
    }
}

fn ads_public() -> Value {
    json!({"provider": "tiktok", "kind_key": "tiktok_ads", "external_id": ADVERTISER,
           "name": "Jeeta Test Reklam"})
}

fn ads_app() -> OAuthApp {
    OAuthApp::TiktokAds(TiktokAdsApp {
        app_id: ADS_APP_ID.into(),
        secret: ADS_SECRET.into(),
    })
}

/// TikTok's answer envelope around `data`.
fn data(data: Value) -> Reply {
    ok(json!({"code": 0, "message": "OK", "request_id": "20261111000000synthetic", "data": data}))
}

/// TikTok's refusal: HTTP 200 with a return code.
fn refused(code: i64, message: &str) -> Reply {
    ok(
        json!({"code": code, "message": message, "request_id": "20261111000000synthetic",
              "data": {}}),
    )
}

fn account(status: &str) -> Value {
    json!({"advertiser_id": ADVERTISER, "name": "Jeeta Test Reklam", "status": status,
           "currency": "TRY", "timezone": "Etc/GMT-3", "display_timezone": "Europe/Istanbul",
           "country": "TR", "role": "ROLE_ADVERTISER", "balance": 0.0})
}

fn enabled(r: &Rig) {
    r.mock.on(
        "GET",
        &path("advertiser/info"),
        data(json!({"list": [account("STATUS_ENABLE")]})),
    );
}

fn listed(rows: Vec<Value>) -> Reply {
    data(
        json!({"list": rows, "page_info": {"page": 1, "page_size": 100, "total_number": rows.len(),
                "total_page": 1}}),
    )
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
        image: Some(IMAGE.into()),
        primary_text: " Yeni sezon kayıtları açıldı ".into(),
        headline: String::new(),
        description: None,
        headlines: vec![],
        descriptions: vec![],
        call_to_action: Some(CallToAction::Download),
        action: CreativeAction::Link {
            url: "https://jeeta.test/kayit".parse().unwrap(),
        },
    }
}

fn ad_spec() -> AdSpec {
    AdSpec {
        name: format!("{NAME}:ad:0:0"),
        adset_id: ADGROUP.into(),
        creative_id: "inline".into(),
        creative: creative(),
    }
}

fn reason(e: &ConnectorError) -> String {
    e.reason().unwrap_or_default().to_owned()
}

/// The JSON a `GET` carried in its query parameter `name`.
fn param_json(request: &Recorded, name: &str) -> Value {
    serde_json::from_str(request.param(name).unwrap_or_else(|| panic!("no {name}"))).unwrap()
}

// ---------------------------------------------------------------------------------------------
// The authorization and the ad accounts
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn an_advertiser_authorizes_the_business_app_and_the_code_becomes_a_token_that_does_not_expire()
 {
    let r = rig().await;
    let redirect: Url = "https://panel.test/oauth/callback/tiktok_ads"
        .parse()
        .unwrap();
    let url =
        r.tt.authorize_url(&ads_app(), &redirect, "state-1", Some("ignored"))
            .unwrap();
    // The app's "Advertiser authorization URL", with this flow's own state; no secret in it.
    assert_eq!(url.path(), "/business/portal/auth");
    assert_eq!(
        url.query(),
        Some(
            format!(
                "app_id={ADS_APP_ID}&state=state-1\
                 &redirect_uri=https%3A%2F%2Fpanel.test%2Foauth%2Fcallback%2Ftiktok_ads"
            )
            .as_str()
        )
    );
    assert!(!url.as_str().contains(ADS_SECRET));
    // In production the page is TikTok's API for Business portal.
    assert_eq!(
        jt_tiktok::TiktokBases::production().business.as_str(),
        "https://business-api.tiktok.com/"
    );

    r.mock.on(
        "POST",
        &path("oauth2/access_token"),
        data(json!({"access_token": ADS_TOKEN, "scope": [1, 2, 4, 6],
                    "advertiser_ids": [ADVERTISER]})),
    );
    let cred =
        r.tt.exchange(&ads_app(), &redirect, AUTH_CODE, None)
            .await
            .unwrap();
    assert_eq!(cred, ads_cred());
    let sent = r.mock.request("POST", &path("oauth2/access_token"));
    assert_eq!(
        sent.json(),
        json!({"app_id": ADS_APP_ID, "secret": ADS_SECRET, "auth_code": AUTH_CODE})
    );
    assert_eq!(sent.header("access-token"), None);
    assert!(
        sent.header("content-type")
            .is_some_and(|t| t.starts_with("application/json"))
    );

    // It has nothing to renew with and nothing to renew: no call.
    r.mock.clear();
    assert_eq!(r.tt.refresh(&cred).await.unwrap(), None);
    assert!(r.mock.recorded().is_empty());

    // A code TikTok no longer takes sends the owner back to authorize again, and neither the
    // code nor the app's secret is in what is said.
    r.mock.set(
        "POST",
        &path("oauth2/access_token"),
        refused(
            40110,
            &format!("The auth_code {AUTH_CODE} is canceled for secret {ADS_SECRET}"),
        ),
    );
    let e =
        r.tt.exchange(&ads_app(), &redirect, AUTH_CODE, None)
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "auth");
    let said = format!("{e:?} {}", reason(&e));
    assert!(
        !said.contains(AUTH_CODE) && !said.contains(ADS_SECRET),
        "{said}"
    );
}

#[tokio::test]
async fn the_authorization_offers_the_enabled_ad_accounts_it_covers() {
    let r = rig().await;
    r.mock.on(
        "GET",
        &path("oauth2/advertiser/get"),
        data(json!({"list": [
            {"advertiser_id": ADVERTISER, "advertiser_name": "Jeeta Test Reklam"},
            {"advertiser_id": "7200000000000000002", "advertiser_name": "Kapalı"},
        ]})),
    );
    let mut closed = account("STATUS_DISABLE");
    closed["advertiser_id"] = json!("7200000000000000002");
    r.mock.on(
        "GET",
        &path("advertiser/info"),
        data(json!({"list": [account("STATUS_ENABLE"), closed]})),
    );
    let assets = r.tt.list_assets(&ads_cred()).await.unwrap();
    assert_eq!(assets.len(), 1);
    assert_eq!(assets[0].kind_key, "tiktok_ads");
    assert_eq!(assets[0].external_id, ADVERTISER);
    assert_eq!(assets[0].name, "Jeeta Test Reklam");
    assert_eq!(
        assets[0].public,
        json!({"currency": "TRY", "time_zone": "Europe/Istanbul", "country": "TR"})
    );

    let listing = r.mock.request("GET", &path("oauth2/advertiser/get"));
    assert_eq!(listing.header("access-token"), Some(ADS_TOKEN));
    assert_eq!(listing.param("app_id"), Some(ADS_APP_ID));
    assert_eq!(listing.param("secret"), Some(ADS_SECRET));
    let info = r.mock.request("GET", &path("advertiser/info"));
    assert_eq!(
        param_json(&info, "advertiser_ids"),
        json!([ADVERTISER, "7200000000000000002"])
    );
    // The open API of the account that posts is not asked.
    assert!(r.mock.requests("GET", USER_INFO).is_empty());
}

#[tokio::test]
async fn the_probe_names_the_ad_account_the_token_itself_reads() {
    let r = rig().await;
    enabled(&r);
    let probe = r.tt.probe(&ads_cred(), &ads_public()).await;
    assert!(probe.ok, "{probe:?}");
    assert_eq!(
        probe.facts,
        json!({"account_id": ADVERTISER, "name": "Jeeta Test Reklam", "currency": "TRY",
               "time_zone": "Europe/Istanbul", "country": "TR"})
    );
    for (answer, expected) in [
        (
            json!({"list": [account("STATUS_LIMIT")]}),
            "the TikTok ad account is not enabled",
        ),
        (json!({"list": []}), "TikTok does not show this ad account"),
    ] {
        r.mock.set("GET", &path("advertiser/info"), data(answer));
        let probe = r.tt.probe(&ads_cred(), &ads_public()).await;
        assert!(!probe.ok);
        assert!(
            probe
                .error
                .as_ref()
                .is_some_and(|e| reason(e).contains(expected)),
            "{probe:?}"
        );
    }
    // An account's posting credential is no advertiser's.
    let probe = r.tt.probe(&cred(), &ads_public()).await;
    assert!(!probe.ok);
}

#[tokio::test]
async fn the_least_budgets_are_tiktoks_for_the_accounts_currency() {
    let r = rig().await;
    enabled(&r);
    let limits =
        r.tt.account_limits(&ads_cred(), &ads_public())
            .await
            .unwrap();
    assert_eq!(limits.currency, "TRY");
    assert_eq!(limits.minor_unit_exponent, 2);
    assert_eq!(limits.timezone, "Europe/Istanbul");
    // 20 US dollars a day and 50 for a campaign, ten times that in lira.
    assert_eq!(limits.min_daily_budget_minor, 20_000);
    assert_eq!(limits.min_total_budget_minor, 50_000);
}

// ---------------------------------------------------------------------------------------------
// Building a campaign
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_campaign_is_a_traffic_campaign_with_the_budget_as_its_lifetime_budget_switched_off() {
    let r = rig().await;
    enabled(&r);
    r.mock.on("GET", &path("campaign/get"), listed(vec![]));
    r.mock.on(
        "POST",
        &path("campaign/create"),
        data(json!({"campaign_id": "1810000000000001", "operation_status": "DISABLE"})),
    );
    let spec = campaign_spec();
    let found =
        r.tt.find_by_name(&ads_cred(), &ads_public(), AdLevel::Campaign, &spec.name)
            .await
            .unwrap();
    assert_eq!(found, None);
    let search = r.mock.request("GET", &path("campaign/get"));
    assert_eq!(search.param("advertiser_id"), Some(ADVERTISER));
    assert_eq!(
        param_json(&search, "filtering"),
        json!({"campaign_name": spec.name, "primary_status": "STATUS_NOT_DELETE"})
    );

    let id =
        r.tt.create_campaign(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(id, CAMPAIGN);
    let sent = r.mock.request("POST", &path("campaign/create"));
    assert_eq!(sent.header("access-token"), Some(ADS_TOKEN));
    assert_eq!(
        sent.json(),
        json!({
            "advertiser_id": ADVERTISER,
            "campaign_name": spec.name,
            "objective_type": "TRAFFIC",
            "budget_mode": "BUDGET_MODE_TOTAL",
            "budget": 1500,
            "operation_status": "DISABLE",
        })
    );
}

#[tokio::test]
async fn a_name_is_matched_exactly_though_tiktok_matches_loosely() {
    let r = rig().await;
    let name = format!("{NAME}:campaign");
    r.mock.on(
        "GET",
        &path("campaign/get"),
        listed(vec![
            json!({"campaign_id": "1810000000000009", "campaign_name": format!("{name}-copy")}),
            json!({"campaign_id": "1810000000000001", "campaign_name": name}),
        ]),
    );
    let found =
        r.tt.find_by_name(&ads_cred(), &ads_public(), AdLevel::Campaign, &name)
            .await
            .unwrap();
    assert_eq!(found.as_deref(), Some(CAMPAIGN));
    r.mock.set(
        "GET",
        &path("campaign/get"),
        listed(vec![
            json!({"campaign_id": "1810000000000001", "campaign_name": name}),
            json!({"campaign_id": "1810000000000002", "campaign_name": name}),
        ]),
    );
    let e =
        r.tt.find_by_name(&ads_cred(), &ads_public(), AdLevel::Campaign, &name)
            .await
            .unwrap_err();
    assert_eq!(
        reason(&e),
        "more than one object of the account carries this name"
    );
    // A TikTok ad carries its own content: there is no creative to find, and the ad step looks
    // its own ad up in its ad group.
    r.mock.clear();
    for level in [AdLevel::Creative, AdLevel::Ad] {
        let found =
            r.tt.find_by_name(&ads_cred(), &ads_public(), level, "x")
                .await
                .unwrap();
        assert_eq!(found, None);
    }
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn the_ad_group_is_for_the_countries_on_tiktok_itself_with_the_budget_once_more() {
    let r = rig().await;
    enabled(&r);
    r.mock.on(
        "GET",
        &path("tool/region"),
        data(json!({"region_list": ["TR", "AZ"], "region_info": [
            {"location_id": "298795", "name": "Turkey", "region_code": "TR", "level": "COUNTRY",
             "parent_id": "0"},
            {"location_id": "862470", "name": "Ardahan", "region_code": "TR",
             "level": "PROVINCE", "parent_id": "298795"},
            {"location_id": "587116", "name": "Azerbaijan", "region_code": "AZ",
             "level": "COUNTRY", "parent_id": "0"},
        ]})),
    );
    r.mock.on(
        "POST",
        &path("adgroup/create"),
        data(json!({"adgroup_id": "1820000000000001"})),
    );
    let spec = adset_spec(&["TR", "AZ"]);
    let id =
        r.tt.create_adset(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(id, ADGROUP);
    let lookup = r.mock.request("GET", &path("tool/region"));
    assert_eq!(
        param_json(&lookup, "placements"),
        json!(["PLACEMENT_TIKTOK"])
    );
    assert_eq!(lookup.param("objective_type"), Some("TRAFFIC"));
    assert_eq!(lookup.param("level_range"), Some("TO_COUNTRY"));
    assert_eq!(
        r.mock.request("POST", &path("adgroup/create")).json(),
        json!({
            "advertiser_id": ADVERTISER,
            "campaign_id": "1810000000000001",
            "adgroup_name": spec.name,
            "promotion_type": "WEBSITE",
            "placement_type": "PLACEMENT_TYPE_NORMAL",
            "placements": ["PLACEMENT_TIKTOK"],
            "location_ids": ["298795", "587116"],
            "age_groups": ["AGE_18_24", "AGE_25_34", "AGE_35_44", "AGE_45_54", "AGE_55_100"],
            "gender": "GENDER_UNLIMITED",
            "budget_mode": "BUDGET_MODE_TOTAL",
            "budget": 1500,
            "schedule_type": "SCHEDULE_START_END",
            // UTC, as TikTok takes a schedule.
            "schedule_start_time": "2026-11-11 22:30:05",
            "schedule_end_time": "2026-11-18 22:30:05",
            "optimization_goal": "CLICK",
            "billing_event": "CPC",
            "bid_type": "BID_TYPE_NO_BID",
            "pacing": "PACING_MODE_SMOOTH",
            "operation_status": "DISABLE",
        })
    );

    // A country TikTok does not offer this ad account is a refusal, and nothing is made.
    r.mock.clear();
    let e =
        r.tt.create_adset(&ads_cred(), &ads_public(), &adset_spec(&["TR", "KZ"]))
            .await
            .unwrap_err();
    assert_eq!(
        reason(&e),
        "TikTok offers this ad account no single location for the country KZ"
    );
    assert!(r.mock.requests("POST", &path("adgroup/create")).is_empty());
}

#[tokio::test]
async fn a_budget_below_tiktoks_least_ends_with_tiktoks_own_words() {
    let r = rig().await;
    enabled(&r);
    r.mock.on(
        "POST",
        &path("campaign/create"),
        refused(40002, "budget: The budget must be at least 500.00 TRY"),
    );
    let e =
        r.tt.create_campaign(&ads_cred(), &ads_public(), &campaign_spec())
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert_eq!(
        reason(&e),
        "HTTP 200 40002: budget: The budget must be at least 500.00 TRY"
    );
}

#[tokio::test]
async fn the_image_goes_up_with_its_digest_and_a_name_that_carries_it() {
    let r = rig().await;
    r.mock.on(
        "POST",
        &path("file/image/ad/upload"),
        data(json!({"image_id": IMAGE, "signature": "x", "format": "png"})),
    );
    let png = b"\x89PNG\r\n\x1a\n-synthetic-image-bytes";
    let image =
        r.tt.upload_image(&ads_cred(), &ads_public(), png, "jeeta-ad-0")
            .await
            .unwrap();
    assert_eq!(image, IMAGE);
    let sent = r.mock.request("POST", &path("file/image/ad/upload"));
    assert!(
        sent.header("content-type")
            .is_some_and(|t| t.starts_with("multipart/form-data; boundary="))
    );
    let body = sent.body();
    // The form's fields and the file's own part.
    for part in [
        "name=\"advertiser_id\"",
        ADVERTISER,
        "name=\"upload_type\"",
        "UPLOAD_BY_FILE",
        "name=\"image_signature\"",
        "name=\"image_file\"",
        "Content-Type: image/png",
        "-synthetic-image-bytes",
    ] {
        assert!(body.contains(part), "{part} not in the upload");
    }
    // The file's name carries the first twelve characters of the image's MD5.
    let digest_at = body.find("name=\"image_signature\"").unwrap();
    let digest: String = body[digest_at..].lines().nth(2).unwrap().trim().to_owned();
    assert_eq!(digest.len(), 32);
    assert!(
        body.contains(&format!("jeeta-ad-0-{}.png", &digest[..12])),
        "{digest}"
    );

    // Another type is refused before anything is sent.
    r.mock.clear();
    let e =
        r.tt.upload_image(&ads_cred(), &ads_public(), b"GIF89a....", "jeeta-ad-0")
            .await
            .unwrap_err();
    assert_eq!(reason(&e), "a TikTok ad image is a JPG or a PNG");
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn an_image_that_went_up_before_is_found_by_its_digest() {
    let r = rig().await;
    r.mock.on(
        "POST",
        &path("file/image/ad/upload"),
        refused(40911, "The material's name has a duplicate"),
    );
    let png = b"\x89PNG\r\n\x1a\n-synthetic-image-bytes";
    // The ad account holds no image of that digest: TikTok's refusal stands.
    r.mock.on(
        "GET",
        &path("file/image/ad/search"),
        listed(vec![json!({"image_id": "another", "signature": "0000"})]),
    );
    let e =
        r.tt.upload_image(&ads_cred(), &ads_public(), png, "jeeta-ad-0")
            .await
            .unwrap_err();
    assert!(reason(&e).contains("40911"), "{e:?}");
    // TikTok's image search has no filter by digest: the library is read as it is.
    let search = r.mock.request("GET", &path("file/image/ad/search"));
    assert_eq!(search.param("filtering"), None);
    assert_eq!(search.param("advertiser_id"), Some(ADVERTISER));
    // The digest the upload carried is the one the image is found by.
    let upload = r.mock.requests("POST", &path("file/image/ad/upload"))[0].body();
    let at = upload.find("name=\"image_signature\"").unwrap();
    let signature = upload[at..].lines().nth(2).unwrap().trim().to_owned();
    r.mock.set(
        "GET",
        &path("file/image/ad/search"),
        listed(vec![
            json!({"image_id": "another", "signature": "0000"}),
            json!({"image_id": IMAGE, "signature": signature}),
        ]),
    );
    let image =
        r.tt.upload_image(&ads_cred(), &ads_public(), png, "jeeta-ad-0")
            .await
            .unwrap();
    assert_eq!(image, IMAGE);
}

/// Scripts what the ad step reads before it makes the ad: no ad of the name yet, one linked
/// TikTok account that can be advertised with, the image, and the music TikTok offers.
fn script_ad(r: &Rig) {
    r.mock.on("GET", &path("ad/get"), listed(vec![]));
    r.mock.on(
        "GET",
        &path("identity/get"),
        data(json!({"identity_list": [
            {"identity_id": "custom-1", "identity_type": "CUSTOMIZED_USER",
             "display_name": "Eski özel kimlik"},
            {"identity_id": "tt-user-1", "identity_type": "TT_USER", "display_name": "jeeta_test",
             "can_push_video": true, "available_status": "AVAILABLE"},
            {"identity_id": "tt-user-2", "identity_type": "TT_USER", "display_name": "özel",
             "can_push_video": true, "available_status": "IS_PRIVATE_ACCOUNT"},
            // One TikTok says cannot be advertised with.
            {"identity_id": "tt-user-3", "identity_type": "TT_USER", "display_name": "ortak",
             "can_push_video": true, "available_status": "AVAILABLE", "is_gpppa": true},
        ]})),
    );
    r.mock.on(
        "GET",
        &path("file/image/ad/info"),
        data(json!({"list": [{"image_id": IMAGE, "is_carousel_usable": true,
            "image_url": "https://p16-ad-sg.tiktokcdn.test/img/synthetic?x-signature=upload-SECRET"}]})),
    );
    // The advertiser liked no music; the ad account used one piece before.
    r.mock
        .on("GET", &path("file/music/get"), data(json!({"musics": []})));
    r.mock.on(
        "GET",
        &path("file/music/get"),
        data(json!({"musics": [
            {"music_id": "7300000000000000777", "sources": ["SYSTEM"]},
            {"music_id": "7300000000000000778", "sources": ["SYSTEM"]},
        ]})),
    );
}

#[tokio::test]
async fn the_ad_is_a_one_image_carousel_under_the_linked_account_with_recommended_music() {
    let r = rig().await;
    script_ad(&r);
    r.mock.on(
        "POST",
        &path("ad/create"),
        data(json!({"ad_ids": ["1830000000000001"], "creatives": [{"ad_id": "1830000000000001"}]})),
    );
    // The creative step sends nothing.
    let inline =
        r.tt.create_creative(&ads_cred(), &ads_public(), &creative())
            .await
            .unwrap();
    assert_eq!(inline, "inline");
    assert!(r.mock.recorded().is_empty());

    let spec = ad_spec();
    let id =
        r.tt.create_ad(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(id, AD);
    // TikTok's list of ads has no filter by name: the ad group's ads are read.
    let finder = r.mock.request("GET", &path("ad/get"));
    assert_eq!(
        param_json(&finder, "filtering"),
        json!({"adgroup_ids": ["1820000000000001"], "primary_status": "STATUS_NOT_DELETE"})
    );
    // The music the advertiser liked is asked for first, then what the account used before.
    let music = r.mock.requests("GET", &path("file/music/get"));
    assert_eq!(
        music
            .iter()
            .map(|m| (m.param("music_scene"), m.param("search_type")))
            .collect::<Vec<_>>(),
        [
            (Some("CAROUSEL_ADS"), Some("SEARCH_BY_LIKED")),
            (Some("CAROUSEL_ADS"), Some("SEARCH_BY_HISTORY")),
        ]
    );
    assert_eq!(
        r.mock.request("POST", &path("ad/create")).json(),
        json!({
            "advertiser_id": ADVERTISER,
            "adgroup_id": "1820000000000001",
            "creatives": [{
                "ad_name": spec.name,
                "ad_format": "CAROUSEL_ADS",
                "ad_text": "Yeni sezon kayıtları açıldı",
                "call_to_action": "DOWNLOAD_NOW",
                "image_ids": [IMAGE],
                "music_id": "7300000000000000777",
                "identity_type": "TT_USER",
                "identity_id": "tt-user-1",
                "landing_page_url": "https://jeeta.test/kayit",
                "operation_status": "DISABLE",
            }],
        })
    );
}

#[tokio::test]
async fn an_ad_is_never_put_under_a_guessed_account_or_made_twice() {
    let r = rig().await;
    script_ad(&r);
    // Two linked accounts that could show the ad: refused, nothing made.
    r.mock.set(
        "GET",
        &path("identity/get"),
        data(json!({"identity_list": [
            {"identity_id": "tt-user-1", "identity_type": "TT_USER", "can_push_video": true},
            {"identity_id": "bc-user-1", "identity_type": "BC_AUTH_TT", "can_push_video": true,
             "identity_authorized_bc_id": "7100000000000000001"},
        ]})),
    );
    let e =
        r.tt.create_ad(&ads_cred(), &ads_public(), &ad_spec())
            .await
            .unwrap_err();
    assert_eq!(
        reason(&e),
        "the TikTok ad account has more than one linked TikTok account"
    );
    // None: refused too.
    r.mock.set(
        "GET",
        &path("identity/get"),
        data(json!({"identity_list": [
            {"identity_id": "custom-1", "identity_type": "CUSTOMIZED_USER"},
        ]})),
    );
    let e =
        r.tt.create_ad(&ads_cred(), &ads_public(), &ad_spec())
            .await
            .unwrap_err();
    assert_eq!(
        reason(&e),
        "the TikTok ad account has no linked TikTok account that can show ads"
    );
    assert!(r.mock.requests("POST", &path("ad/create")).is_empty());

    // An ad of the ad group that already carries the name is adopted.
    let spec = ad_spec();
    r.mock.set(
        "GET",
        &path("ad/get"),
        listed(vec![
            json!({"ad_id": "1830000000000001", "ad_name": spec.name}),
        ]),
    );
    let id =
        r.tt.create_ad(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(id, AD);
    assert!(r.mock.requests("POST", &path("ad/create")).is_empty());
}

#[tokio::test]
async fn an_ad_tiktok_cannot_show_is_refused_before_anything_is_sent() {
    let r = rig().await;
    type Change = Box<dyn Fn(&mut CreativeSpec)>;
    let cases: Vec<(Change, &str)> = vec![
        (Box::new(|c| c.image = None), "a TikTok ad needs its image"),
        (
            Box::new(|c| c.call_to_action = None),
            "a TikTok ad needs its call to action",
        ),
        (
            Box::new(|c| c.primary_text = "x".repeat(101)),
            "a TikTok ad's text is 1 to 100 characters",
        ),
        (
            Box::new(|c| c.primary_text = "  ".into()),
            "a TikTok ad's text is 1 to 100 characters",
        ),
        (
            Box::new(|c| {
                c.action = CreativeAction::LeadForm {
                    form_id: "1".into(),
                    url: "https://jeeta.test/gizlilik".parse().unwrap(),
                }
            }),
            "a TikTok ad here leads to a website",
        ),
    ];
    for (change, expected) in cases {
        let mut spec = ad_spec();
        change(&mut spec.creative);
        let e =
            r.tt.create_creative(&ads_cred(), &ads_public(), &spec.creative)
                .await
                .unwrap_err();
        assert_eq!(reason(&e), expected);
        let e =
            r.tt.create_ad(&ads_cred(), &ads_public(), &spec)
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
async fn each_level_is_switched_at_its_own_endpoint() {
    let r = rig().await;
    for (id, rest, field, number, status, word) in [
        (
            AD,
            "ad/status/update",
            "ad_ids",
            "1830000000000001",
            AdStatus::Active,
            "ENABLE",
        ),
        (
            ADGROUP,
            "adgroup/status/update",
            "adgroup_ids",
            "1820000000000001",
            AdStatus::Active,
            "ENABLE",
        ),
        (
            CAMPAIGN,
            "campaign/status/update",
            "campaign_ids",
            "1810000000000001",
            AdStatus::Paused,
            "DISABLE",
        ),
    ] {
        r.mock.on("POST", &path(rest), data(json!({})));
        r.tt.set_status(&ads_cred(), id, status).await.unwrap();
        assert_eq!(
            r.mock.request("POST", &path(rest)).json(),
            json!({"advertiser_id": ADVERTISER, field: [number], "operation_status": word})
        );
    }
    r.mock.clear();
    for bad in [
        "1830000000000001",
        "tt:7200000000000000001:creative:1",
        "li:512:campaign:7",
    ] {
        let e =
            r.tt.set_status(&ads_cred(), bad, AdStatus::Active)
                .await
                .unwrap_err();
        assert_eq!(
            reason(&e),
            "not a TikTok ad object of the expected kind",
            "{bad}"
        );
    }
    assert!(r.mock.recorded().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_state_is_the_campaigns_switch_and_each_ads_review_with_its_reasons() {
    let r = rig().await;
    r.mock.on(
        "GET",
        &path("campaign/get"),
        listed(vec![
            json!({"campaign_id": "1810000000000001", "operation_status": "ENABLE",
                           "secondary_status": "CAMPAIGN_STATUS_ENABLE"}),
        ]),
    );
    r.mock.on(
        "GET",
        &path("ad/get"),
        listed(vec![
            json!({"ad_id": "1830000000000001", "ad_name": "a", "operation_status": "ENABLE",
                   "secondary_status": "AD_STATUS_DELIVERY_OK"}),
            json!({"ad_id": "1830000000000002", "ad_name": "b", "operation_status": "ENABLE",
                   "secondary_status": "AD_STATUS_AUDIT"}),
            json!({"ad_id": "1830000000000003", "ad_name": "c", "operation_status": "ENABLE",
                   "secondary_status": "AD_STATUS_AUDIT_DENY"}),
            json!({"ad_id": "1830000000000004", "ad_name": "d", "operation_status": "DISABLE",
                   "secondary_status": "AD_STATUS_DISABLE"}),
        ]),
    );
    r.mock.on(
        "GET",
        &path("ad/review_info"),
        data(json!({"ad_review_map": {"1830000000000003": {"is_approved": false,
            "review_status": "UNAVAILABLE",
            "reject_info": [{"reasons": ["Misleading claim"], "suggestion": "Remove the claim."}]}}})),
    );
    let state =
        r.tt.campaign_state(&ads_cred(), &ads_public(), CAMPAIGN)
            .await
            .unwrap();
    assert_eq!(state.campaign, ProviderAdStatus::Active);
    let seen: Vec<(&str, &ProviderAdStatus, Option<&str>)> = state
        .ads
        .iter()
        .map(|ad| (ad.ad_id.as_str(), &ad.status, ad.feedback.as_deref()))
        .collect();
    assert_eq!(
        seen,
        [
            (AD, &ProviderAdStatus::Active, None),
            (
                "tt:7200000000000000001:ad:1830000000000002",
                &ProviderAdStatus::InReview,
                None
            ),
            (
                "tt:7200000000000000001:ad:1830000000000003",
                &ProviderAdStatus::Disapproved,
                Some("Misleading claim Remove the claim.")
            ),
            (
                "tt:7200000000000000001:ad:1830000000000004",
                &ProviderAdStatus::Paused,
                None
            ),
        ]
    );
    // Only the ad TikTok turned down is asked about.
    assert_eq!(
        param_json(&r.mock.request("GET", &path("ad/review_info")), "ad_ids"),
        json!(["1830000000000003"])
    );

    // An object of another ad account is refused before any call.
    r.mock.clear();
    let e =
        r.tt.campaign_state(
            &ads_cred(),
            &ads_public(),
            "tt:7200000000000000999:campaign:1",
        )
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "the object is of another TikTok ad account");
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn the_days_are_each_ads_spend_in_minor_units_and_its_clicks() {
    let r = rig().await;
    enabled(&r);
    r.mock.on(
        "GET",
        &path("report/integrated/get"),
        listed(vec![
            json!({"dimensions": {"ad_id": "1830000000000001",
                                  "stat_time_day": "2026-11-12 00:00:00"},
                   "metrics": {"spend": "123.456", "impressions": "1840", "clicks": "31"}}),
            json!({"dimensions": {"ad_id": "1830000000000001",
                                  "stat_time_day": "2026-11-13 00:00:00"},
                   "metrics": {"spend": "0", "impressions": "0", "clicks": "0"}}),
        ]),
    );
    let since = Date::from_calendar_date(2026, Month::November, 12).unwrap();
    let until = Date::from_calendar_date(2026, Month::November, 13).unwrap();
    let days =
        r.tt.ad_days(
            &ads_cred(),
            &ads_public(),
            CAMPAIGN,
            AdObjective::Traffic,
            since,
            until,
        )
        .await
        .unwrap();
    assert_eq!(days.len(), 2);
    assert_eq!(days[0].ad_id, AD);
    assert_eq!(days[0].day, since);
    assert_eq!(days[0].spend_minor, Some(12_346));
    assert_eq!(
        (days[0].impressions, days[0].clicks, days[0].results),
        (Some(1840), Some(31), Some(31))
    );
    assert_eq!(days[1].day, until);
    assert_eq!(days[1].spend_minor, Some(0));

    let report = r.mock.request("GET", &path("report/integrated/get"));
    assert_eq!(report.param("service_type"), Some("AUCTION"));
    assert_eq!(report.param("report_type"), Some("BASIC"));
    assert_eq!(report.param("data_level"), Some("AUCTION_AD"));
    assert_eq!(
        param_json(&report, "dimensions"),
        json!(["ad_id", "stat_time_day"])
    );
    assert_eq!(
        param_json(&report, "metrics"),
        json!(["spend", "impressions", "clicks"])
    );
    assert_eq!(report.param("start_date"), Some("2026-11-12"));
    assert_eq!(report.param("end_date"), Some("2026-11-13"));
    assert_eq!(
        param_json(&report, "filtering"),
        json!([{"field_name": "campaign_ids", "filter_type": "IN",
                "filter_value": "[\"1810000000000001\"]"}])
    );
}

// ---------------------------------------------------------------------------------------------
// What an ad account is not, and what an error says
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn an_ad_account_posts_nothing_and_an_accounts_credential_builds_no_campaign() {
    let r = rig().await;
    let e =
        r.tt.publish(
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
    // The credential of an account that posts reaches no ad account.
    let e =
        r.tt.account_limits(&cred(), &ads_public())
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    // The capability of an account that posts is no ad account.
    let e =
        r.tt.account_limits(&ads_cred(), &public())
            .await
            .unwrap_err();
    assert_eq!(reason(&e), "not a TikTok ad account");
    let e =
        r.tt.preview(
            &ads_cred(),
            &ads_public(),
            &creative(),
            AdPlacement::FacebookFeed,
        )
        .await
        .unwrap_err();
    assert_eq!(
        reason(&e),
        "an ad preview is not offered for a TikTok ad account"
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn tiktoks_return_code_decides_and_no_secret_reaches_an_error() {
    let r = rig().await;
    for (code, message, kind) in [
        (
            40105,
            "Access token is incorrect or has been revoked.",
            "auth",
        ),
        (40100, "Requests made too frequently", "throttle"),
        (40001, "No permission to operate advertiser", "permission"),
        (50000, "System error", "transient"),
    ] {
        r.mock
            .set("GET", &path("advertiser/info"), refused(code, message));
        let e =
            r.tt.account_limits(&ads_cred(), &ads_public())
                .await
                .unwrap_err();
        assert_eq!(e.kind(), kind, "{code}");
    }
    r.mock.set(
        "GET",
        &path("advertiser/info"),
        refused(40105, &format!("The token {ADS_TOKEN} is invalid")),
    );
    let e =
        r.tt.account_limits(&ads_cred(), &ads_public())
            .await
            .unwrap_err();
    let said = format!("{e:?} {}", reason(&e));
    assert!(!said.contains(ADS_TOKEN), "{said}");

    // A write TikTok saw twice may have made its object: the outcome is unknown, never retried.
    r.mock.set(
        "GET",
        &path("advertiser/info"),
        data(json!({"list": [account("STATUS_ENABLE")]})),
    );
    r.mock.on(
        "POST",
        &path("campaign/create"),
        refused(40050, "Duplicated requests have been sent."),
    );
    let e =
        r.tt.create_campaign(&ads_cred(), &ads_public(), &campaign_spec())
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "unknown");
    assert_eq!(r.mock.requests("POST", &path("campaign/create")).len(), 1);
}

#[tokio::test]
async fn revoking_an_advertisers_token_goes_to_the_business_api() {
    let r = rig().await;
    r.mock
        .on("POST", &path("oauth2/revoke_token"), data(json!({})));
    r.tt.revoke(&ads_cred()).await.unwrap();
    let sent = r.mock.request("POST", &path("oauth2/revoke_token"));
    assert_eq!(
        sent.json(),
        json!({"app_id": ADS_APP_ID, "secret": ADS_SECRET, "access_token": ADS_TOKEN})
    );
    assert!(r.mock.requests("POST", REVOKE).is_empty());
}

#[tokio::test]
async fn a_long_range_of_days_is_read_in_pieces_of_thirty() {
    let r = rig().await;
    enabled(&r);
    r.mock
        .on("GET", &path("report/integrated/get"), listed(vec![]));
    let since = Date::from_calendar_date(2026, Month::November, 1).unwrap();
    let until = Date::from_calendar_date(2026, Month::December, 15).unwrap();
    let days =
        r.tt.ad_days(
            &ads_cred(),
            &ads_public(),
            CAMPAIGN,
            AdObjective::Traffic,
            since,
            until,
        )
        .await
        .unwrap();
    assert!(days.is_empty());
    let ranges: Vec<(String, String)> = r
        .mock
        .requests("GET", &path("report/integrated/get"))
        .iter()
        .map(|q| {
            (
                q.param("start_date").unwrap().to_owned(),
                q.param("end_date").unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        ranges,
        [
            ("2026-11-01".to_owned(), "2026-11-30".to_owned()),
            ("2026-12-01".to_owned(), "2026-12-15".to_owned()),
        ]
    );
}

#[tokio::test]
async fn an_account_without_liked_or_used_music_gets_the_first_piece_of_a_plain_search() {
    let r = rig().await;
    script_ad(&r);
    // Neither liked nor used: the keyword search answers.
    r.mock
        .set("GET", &path("file/music/get"), data(json!({"musics": []})));
    r.mock
        .on("GET", &path("file/music/get"), data(json!({"musics": []})));
    r.mock.on(
        "GET",
        &path("file/music/get"),
        data(json!({"musics": [{"music_id": "7300000000000000999"}]})),
    );
    r.mock.on(
        "POST",
        &path("ad/create"),
        data(json!({"ad_ids": ["1830000000000001"]})),
    );
    r.tt.create_ad(&ads_cred(), &ads_public(), &ad_spec())
        .await
        .unwrap();
    let searches = r.mock.requests("GET", &path("file/music/get"));
    assert_eq!(
        searches
            .iter()
            .map(|m| m.param("search_type").unwrap())
            .collect::<Vec<_>>(),
        ["SEARCH_BY_LIKED", "SEARCH_BY_HISTORY", "SEARCH_BY_KEYWORD"]
    );
    assert_eq!(
        param_json(&searches[2], "filtering"),
        json!({"keyword": "background"})
    );
    assert_eq!(
        r.mock.request("POST", &path("ad/create")).json()["creatives"][0]["music_id"],
        "7300000000000000999"
    );

    // No music at all: the ad is refused, and nothing is made.
    r.mock.clear();
    r.mock
        .set("GET", &path("file/music/get"), data(json!({"musics": []})));
    let e =
        r.tt.create_ad(&ads_cred(), &ads_public(), &ad_spec())
            .await
            .unwrap_err();
    assert_eq!(
        reason(&e),
        "TikTok offers the ad account no music for a carousel ad"
    );
    assert!(r.mock.requests("POST", &path("ad/create")).is_empty());
}
