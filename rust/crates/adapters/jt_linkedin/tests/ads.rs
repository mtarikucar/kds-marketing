//! Ad campaigns in a LinkedIn ad account, against the in-process mock: the ad accounts a sign-in
//! offers, the probe, the campaign group, the campaign, the image, the ad made with its post, the
//! switches, and reading the state and the daily numbers back. Every value is synthetic; nothing
//! here has been run against LinkedIn.

mod support;

use jt_app::ports::connectors::{
    AdAudience, AdBudgetWriter, AdCampaignWriter, AdLevel, AdObjective, AdPlacement, AdPlacements,
    AdSetGoal, AdSetSpec, AdSpec, AdStatus, CallToAction, CampaignSpec, Connector, CreativeAction,
    CreativeSpec, OAuthProvider, ProviderAdStatus, PublishRequest, Publisher,
};
use jt_connector::{ConnectorError, Credential};
use jt_linkedin::{AD_SCOPES, MEMBER_SCOPES};
use serde_json::{Value, json};
use support::*;
use time::{Date, Duration, Month, OffsetDateTime};

const ACCOUNT: &str = "512000001";
const GROUP: &str = "li:512000001:group:900001";
const CAMPAIGN: &str = "li:512000001:campaign:700001";
const CREATIVE: &str = "li:512000001:creative:120001";

const ACCOUNT_USERS: &str = "/api/rest/adAccountUsers";
const AD_ACCOUNT: &str = "/api/rest/adAccounts/512000001";
const GROUPS: &str = "/api/rest/adAccounts/512000001/adCampaignGroups";
const GROUP_ONE: &str = "/api/rest/adAccounts/512000001/adCampaignGroups/900001";
const CAMPAIGNS: &str = "/api/rest/adAccounts/512000001/adCampaigns";
const CAMPAIGN_ONE: &str = "/api/rest/adAccounts/512000001/adCampaigns/700001";
const CREATIVES: &str = "/api/rest/adAccounts/512000001/creatives";
const CREATIVE_ONE: &str =
    "/api/rest/adAccounts/512000001/creatives/urn%3Ali%3AsponsoredCreative%3A120001";
const TARGETING: &str = "/api/rest/adTargetingEntities";
const ANALYTICS: &str = "/api/rest/adAnalytics";

const NAME: &str = "jeeta:01a1c9ad-2710-76fc-bfee-95daa5f786da";

/// A credential of a flow that asked for the ad scopes.
fn ads_cred() -> Credential {
    Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: None,
        expires_at: Some(OffsetDateTime::now_utc() + Duration::days(60)),
        scopes: MEMBER_SCOPES
            .iter()
            .chain(AD_SCOPES)
            .map(|s| (*s).to_owned())
            .collect(),
    }
}

/// The public fields the use cases hand the adapter for the ad account capability.
fn ads_public() -> Value {
    json!({"provider": "linkedin", "kind_key": "linkedin_ads", "external_id": ACCOUNT,
           "name": "Jeeta Test Reklam"})
}

/// The ad account as LinkedIn describes it.
fn account(status: &str, reference: &str) -> Value {
    json!({"id": 512000001, "name": "Jeeta Test Reklam", "currency": "USD", "status": status,
           "type": "BUSINESS", "reference": reference, "test": false,
           "servingStatuses": ["RUNNABLE"]})
}

fn usable_account() -> Value {
    account("ACTIVE", "urn:li:organization:90000001")
}

fn starts() -> OffsetDateTime {
    OffsetDateTime::now_utc() + Duration::days(2)
}

fn ends() -> OffsetDateTime {
    OffsetDateTime::now_utc() + Duration::days(9)
}

fn campaign_spec(start_at: OffsetDateTime, end_at: OffsetDateTime) -> CampaignSpec {
    CampaignSpec {
        name: format!("{NAME}:campaign"),
        objective: AdObjective::Traffic,
        lifetime_budget_minor: 50_000,
        start_at,
        end_at,
    }
}

fn adset_spec(start_at: OffsetDateTime, end_at: OffsetDateTime, countries: &[&str]) -> AdSetSpec {
    AdSetSpec {
        name: format!("{NAME}:adset"),
        campaign_id: GROUP.into(),
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
        start_at,
        end_at,
        budget_minor: 50_000,
        keywords: vec![],
    }
}

fn creative() -> CreativeSpec {
    CreativeSpec {
        name: format!("{NAME}:creative:0:0"),
        identity_id: None,
        instagram_user_id: None,
        image: Some(IMAGE_1.into()),
        primary_text: " Yeni sezon kayıtları açıldı (erken kayıt). ".into(),
        headline: " Kayıt ol ".into(),
        description: None,
        headlines: vec![],
        descriptions: vec![],
        call_to_action: Some(CallToAction::SignUp),
        action: CreativeAction::Link {
            url: "https://jeeta.test/kayit".parse().unwrap(),
        },
    }
}

fn ad_spec() -> AdSpec {
    AdSpec {
        name: format!("{NAME}:ad:0:0"),
        adset_id: CAMPAIGN.into(),
        creative_id: "inline".into(),
        creative: creative(),
    }
}

fn elements(rows: Vec<Value>) -> Value {
    json!({ "elements": rows, "metadata": {} })
}

/// LinkedIn's typeahead answer for a country and a region that carries its name.
fn turkiye() -> Value {
    json!({"elements": [
        {"urn": "urn:li:geo:102105699", "name": "Türkiye",
         "facetUrn": "urn:li:adTargetingFacet:locations"},
        {"urn": "urn:li:geo:106693272", "name": "Istanbul, Türkiye",
         "facetUrn": "urn:li:adTargetingFacet:locations"},
    ]})
}

fn reason(e: &ConnectorError) -> String {
    e.reason().unwrap_or_default().to_owned()
}

// ---------------------------------------------------------------------------------------------
// The ad accounts of a sign-in
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_sign_in_with_the_ad_scope_offers_the_ad_accounts_it_manages_campaigns_in() {
    let r = rig().await;
    r.mock.on("GET", USERINFO, r.mock.answer("userinfo"));
    r.mock.on(
        "GET",
        ACCOUNT_USERS,
        ok(json!({"elements": [
            {"account": "urn:li:sponsoredAccount:512000001", "role": "CAMPAIGN_MANAGER",
             "user": "urn:li:person:a1B2c3D4e5"},
            // Read only: campaigns cannot be built there.
            {"account": "urn:li:sponsoredAccount:512000002", "role": "VIEWER"},
            // Not active.
            {"account": "urn:li:sponsoredAccount:512000003", "role": "ACCOUNT_MANAGER"},
            // Advertises for a member, not for a company page.
            {"account": "urn:li:sponsoredAccount:512000004", "role": "ACCOUNT_BILLING_ADMIN"},
            // Its facts cannot be read.
            {"account": "urn:li:sponsoredAccount:512000005", "role": "ACCOUNT_MANAGER"},
        ]})),
    );
    r.mock.on("GET", AD_ACCOUNT, ok(usable_account()));
    r.mock.on(
        "GET",
        "/api/rest/adAccounts/512000003",
        ok(
            json!({"id": 512000003, "name": "Taslak", "currency": "USD", "status": "DRAFT",
                  "reference": "urn:li:organization:90000001"}),
        ),
    );
    r.mock.on(
        "GET",
        "/api/rest/adAccounts/512000004",
        ok(
            json!({"id": 512000004, "name": "Kişisel", "currency": "USD", "status": "ACTIVE",
                  "reference": "urn:li:person:a1B2c3D4e5"}),
        ),
    );
    r.mock.on(
        "GET",
        "/api/rest/adAccounts/512000005",
        r.mock.answer_with(403, "error_403"),
    );

    let assets = r.li.list_assets(&ads_cred()).await.unwrap();
    let kinds: Vec<&str> = assets.iter().map(|a| a.kind_key.as_str()).collect();
    assert_eq!(kinds, ["linkedin_member", "linkedin_ads"]);
    let ad_account = &assets[1];
    assert_eq!(ad_account.external_id, ACCOUNT);
    assert_eq!(ad_account.name, "Jeeta Test Reklam");
    assert_eq!(
        ad_account.public,
        json!({"currency": "USD", "organization_id": "90000001", "test_account": false})
    );

    let listing = r.mock.request("GET", ACCOUNT_USERS);
    assert_eq!(listing.raw_query, "q=authenticatedUser");
    assert_eq!(listing.bearer(), Some(ACCESS_TOKEN));
    listing.assert_rest_headers(jt_linkedin::DEFAULT_API_VERSION);
    // The account the member only views is never read.
    assert!(
        r.mock
            .requests("GET", "/api/rest/adAccounts/512000002")
            .is_empty()
    );

    // Without the ad scope the ad accounts are not asked for at all.
    r.mock.clear();
    let assets = r.li.list_assets(&member_cred()).await.unwrap();
    assert_eq!(assets.len(), 1);
    assert!(r.mock.requests("GET", ACCOUNT_USERS).is_empty());
}

#[tokio::test]
async fn the_ad_accounts_are_read_to_the_total_the_answer_names() {
    let r = rig().await;
    r.mock.on("GET", USERINFO, r.mock.answer("userinfo"));
    r.mock.on(
        "GET",
        ACCOUNT_USERS,
        ok(json!({"elements": [
            {"account": "urn:li:sponsoredAccount:512000009", "role": "VIEWER"},
        ], "paging": {"count": 1, "start": 0, "total": 2, "links": []}})),
    );
    r.mock.on(
        "GET",
        ACCOUNT_USERS,
        ok(json!({"elements": [
            {"account": "urn:li:sponsoredAccount:512000001", "role": "ACCOUNT_MANAGER"},
        ], "paging": {"count": 1, "start": 1, "total": 2, "links": []}})),
    );
    r.mock.on("GET", AD_ACCOUNT, ok(usable_account()));
    let assets = r.li.list_assets(&ads_cred()).await.unwrap();
    assert_eq!(assets.len(), 2);
    assert_eq!(assets[1].external_id, ACCOUNT);
    let pages = r.mock.requests("GET", ACCOUNT_USERS);
    assert_eq!(
        pages
            .iter()
            .map(|p| p.raw_query.as_str())
            .collect::<Vec<_>>(),
        ["q=authenticatedUser", "q=authenticatedUser&start=1"]
    );
}

#[tokio::test]
async fn the_probe_names_the_ad_account_the_token_itself_reads() {
    let r = rig().await;
    r.mock.on("GET", AD_ACCOUNT, ok(usable_account()));
    let probe = r.li.probe(&ads_cred(), &ads_public()).await;
    assert!(probe.ok, "{probe:?}");
    assert_eq!(
        probe.facts,
        json!({"account_id": ACCOUNT, "name": "Jeeta Test Reklam", "currency": "USD",
               "organization_id": "90000001", "test_account": false})
    );

    // An account that is not active, one that advertises for no company page, and an answer
    // for another account are each a failed probe.
    for (answer, expected) in [
        (
            account("CANCELED", "urn:li:organization:90000001"),
            "the LinkedIn ad account is not active",
        ),
        (
            account("ACTIVE", "urn:li:person:a1B2c3D4e5"),
            "the LinkedIn ad account advertises for no company page",
        ),
        (
            json!({"id": 999, "currency": "USD", "status": "ACTIVE"}),
            "LinkedIn answered for another ad account",
        ),
    ] {
        r.mock.set("GET", AD_ACCOUNT, ok(answer));
        let probe = r.li.probe(&ads_cred(), &ads_public()).await;
        assert!(!probe.ok);
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
async fn the_account_says_its_currency_and_that_linkedin_counts_days_in_utc() {
    let r = rig().await;
    r.mock.on("GET", AD_ACCOUNT, ok(usable_account()));
    let limits =
        r.li.account_limits(&ads_cred(), &ads_public())
            .await
            .unwrap();
    assert_eq!(limits.currency, "USD");
    assert_eq!(limits.minor_unit_exponent, 2);
    assert_eq!(limits.timezone, "UTC");
    // LinkedIn names its least budget only when it refuses one.
    assert_eq!(
        (limits.min_daily_budget_minor, limits.min_total_budget_minor),
        (0, 0)
    );
}

#[tokio::test]
async fn the_campaign_group_holds_the_whole_budget_and_the_run() {
    let r = rig().await;
    r.mock.on("GET", AD_ACCOUNT, ok(usable_account()));
    r.mock.on("GET", GROUPS, ok(elements(vec![])));
    r.mock.on(
        "POST",
        GROUPS,
        created("urn:li:sponsoredCampaignGroup:900001"),
    );
    let (start, end) = (starts(), ends());
    let spec = campaign_spec(start, end);

    // Nothing carries the name yet.
    let found =
        r.li.find_by_name(&ads_cred(), &ads_public(), AdLevel::Campaign, &spec.name)
            .await
            .unwrap();
    assert_eq!(found, None);
    let search = r.mock.request("GET", GROUPS);
    assert_eq!(search.header("x-restli-method"), None);
    assert_eq!(
        search.raw_query,
        "q=search&search=(name:(values:List(jeeta%3A01a1c9ad-2710-76fc-bfee-95daa5f786da%3Acampaign)),\
         status:(values:List(ACTIVE,DRAFT,PAUSED)))"
    );

    let id =
        r.li.create_campaign(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(id, GROUP);
    let sent = r.mock.request("POST", GROUPS);
    sent.assert_rest_headers(jt_linkedin::DEFAULT_API_VERSION);
    assert_eq!(sent.header("x-restli-method"), None);
    assert_eq!(
        sent.json(),
        json!({
            "account": "urn:li:sponsoredAccount:512000001",
            "name": spec.name,
            "runSchedule": {"start": start.unix_timestamp() * 1000,
                            "end": end.unix_timestamp() * 1000},
            "status": "ACTIVE",
            "totalBudget": {"amount": "500.00", "currencyCode": "USD"},
        })
    );
}

#[tokio::test]
async fn a_start_that_is_now_is_put_a_few_minutes_ahead() {
    let r = rig().await;
    r.mock.on("GET", AD_ACCOUNT, ok(usable_account()));
    r.mock.on(
        "POST",
        GROUPS,
        created("urn:li:sponsoredCampaignGroup:900001"),
    );
    let now = OffsetDateTime::now_utc();
    r.li.create_campaign(&ads_cred(), &ads_public(), &campaign_spec(now, ends()))
        .await
        .unwrap();
    let start = r.mock.request("POST", GROUPS).json()["runSchedule"]["start"]
        .as_i64()
        .unwrap();
    let ahead = start - now.unix_timestamp() * 1000;
    assert!((4 * 60_000..=6 * 60_000).contains(&ahead), "{ahead}");

    // A run that would end before it starts is refused before anything is sent.
    r.mock.clear();
    let e =
        r.li.create_campaign(
            &ads_cred(),
            &ads_public(),
            &campaign_spec(now, now + Duration::minutes(2)),
        )
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "the campaign ends before it starts");
    assert!(r.mock.requests("POST", GROUPS).is_empty());
}

#[tokio::test]
async fn the_campaign_is_made_paused_for_the_countries_with_the_budget_as_its_lifetime_budget() {
    let r = rig().await;
    r.mock.on("GET", AD_ACCOUNT, ok(usable_account()));
    r.mock.on("GET", TARGETING, ok(turkiye()));
    r.mock.on(
        "POST",
        CAMPAIGNS,
        created("urn:li:sponsoredCampaign:700001"),
    );
    let (start, end) = (starts(), ends());
    let spec = adset_spec(start, end, &["TR"]);
    let id =
        r.li.create_adset(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(id, CAMPAIGN);

    let lookup = r.mock.request("GET", TARGETING);
    assert_eq!(
        lookup.raw_query,
        "q=typeahead&queryVersion=QUERY_USES_URNS&facet=urn%3Ali%3AadTargetingFacet%3Alocations\
         &query=T%C3%BCrkiye&locale=(language:en,country:US)"
    );
    assert_eq!(
        r.mock.request("POST", CAMPAIGNS).json(),
        json!({
            "account": "urn:li:sponsoredAccount:512000001",
            "campaignGroup": "urn:li:sponsoredCampaignGroup:900001",
            "name": spec.name,
            "type": "SPONSORED_UPDATES",
            "format": "STANDARD_UPDATE",
            "objectiveType": "WEBSITE_VISIT",
            "optimizationTargetType": "MAX_CLICK",
            "costType": "CPM",
            "unitCost": {"amount": "0", "currencyCode": "USD"},
            "locale": {"country": "TR", "language": "tr"},
            "offsiteDeliveryEnabled": false,
            "audienceExpansionEnabled": false,
            "creativeSelection": "OPTIMIZED",
            "associatedEntity": "urn:li:organization:90000001",
            "politicalIntent": "NOT_POLITICAL",
            "pacingStrategy": "LIFETIME",
            "totalBudget": {"amount": "500.00", "currencyCode": "USD"},
            "runSchedule": {"start": start.unix_timestamp() * 1000,
                            "end": end.unix_timestamp() * 1000},
            "targetingCriteria": {"include": {"and": [
                {"or": {"urn:li:adTargetingFacet:interfaceLocales": ["urn:li:locale:tr_TR"]}},
                {"or": {"urn:li:adTargetingFacet:locations": ["urn:li:geo:102105699"]}}
            ]}},
            "status": "PAUSED",
        })
    );
}

#[tokio::test]
async fn a_country_linkedin_names_no_single_location_for_is_refused_and_nothing_is_made() {
    let r = rig().await;
    r.mock.on("GET", AD_ACCOUNT, ok(usable_account()));
    let (start, end) = (starts(), ends());
    for (answer, countries, expected) in [
        // Two locations carry the country's own name.
        (
            json!({"elements": [
                {"urn": "urn:li:geo:1", "name": "Türkiye"},
                {"urn": "urn:li:geo:2", "name": "Türkiye"},
            ]}),
            vec!["TR"],
            "LinkedIn names no single location for the country TR",
        ),
        // Only places inside the country.
        (
            json!({"elements": [{"urn": "urn:li:geo:106693272", "name": "Istanbul, Türkiye"}]}),
            vec!["TR"],
            "LinkedIn names no single location for the country TR",
        ),
        // Not a location entity.
        (
            json!({"elements": [{"urn": "urn:li:country:tr", "name": "Türkiye"}]}),
            vec!["TR"],
            "LinkedIn names no single location for the country TR",
        ),
        // A code LinkedIn's country table does not list: nothing is asked.
        (
            json!({"elements": []}),
            vec!["ZZ"],
            "LinkedIn lists no country with the code ZZ",
        ),
    ] {
        r.mock.set("GET", TARGETING, ok(answer));
        let e =
            r.li.create_adset(
                &ads_cred(),
                &ads_public(),
                &adset_spec(start, end, &countries),
            )
            .await
            .unwrap_err();
        assert_eq!(e.kind(), "permanent");
        assert_eq!(reason(&e), expected);
    }
    assert!(r.mock.requests("POST", CAMPAIGNS).is_empty());
}

#[tokio::test]
async fn a_budget_linkedin_finds_too_small_ends_with_linkedins_own_words() {
    let r = rig().await;
    r.mock.on("GET", AD_ACCOUNT, ok(usable_account()));
    r.mock.on("GET", TARGETING, ok(turkiye()));
    r.mock.on(
        "POST",
        CAMPAIGNS,
        status(
            400,
            json!({"status": 400, "code": "INVALID_VALUE_FOR_FIELD",
                   "message": "totalBudget/amount value 31.0 cannot be lower than 100.00"}),
        ),
    );
    let e =
        r.li.create_adset(
            &ads_cred(),
            &ads_public(),
            &adset_spec(starts(), ends(), &["TR"]),
        )
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert!(
        reason(&e).contains("totalBudget/amount value 31.0 cannot be lower than 100.00"),
        "{e:?}"
    );
}

#[tokio::test]
async fn the_image_goes_up_as_the_company_page_of_the_ad_account() {
    let r = rig().await;
    r.mock.on("GET", AD_ACCOUNT, ok(usable_account()));
    r.mock.on("POST", IMAGES, r.mock.answer("image_init"));
    r.mock.on("PUT", IMAGE_UPLOAD_1, raw(201, ""));
    let png = b"\x89PNG\r\n\x1a\n-synthetic-image-bytes";
    let image =
        r.li.upload_image(&ads_cred(), &ads_public(), png, "jeeta-ad-0")
            .await
            .unwrap();
    assert_eq!(image, IMAGE_1);
    assert_eq!(
        r.mock.request("POST", IMAGES).json(),
        json!({"initializeUploadRequest": {"owner": "urn:li:organization:90000001"}})
    );
    let put = r.mock.request("PUT", IMAGE_UPLOAD_1);
    assert_eq!(put.header("content-type"), Some("image/png"));
    assert_eq!(put.bytes, png);

    // A type LinkedIn does not take is refused before anything is sent.
    r.mock.clear();
    let e =
        r.li.upload_image(
            &ads_cred(),
            &ads_public(),
            b"RIFF....WEBPVP8 ",
            "jeeta-ad-0",
        )
        .await
        .unwrap_err();
    assert_eq!(reason(&e), "a LinkedIn ad image is a JPG, a PNG or a GIF");
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn the_creative_step_sends_nothing_and_the_ad_is_made_with_its_post_as_a_draft() {
    let r = rig().await;
    r.mock.on("GET", AD_ACCOUNT, ok(usable_account()));
    r.mock.on("GET", CREATIVES, ok(elements(vec![])));
    r.mock.on(
        "POST",
        CREATIVES,
        created("urn:li:sponsoredCreative:120001"),
    );

    let inline =
        r.li.create_creative(&ads_cred(), &ads_public(), &creative())
            .await
            .unwrap();
    assert_eq!(inline, "inline");
    assert!(r.mock.recorded().is_empty());
    // The creative and the ad have no object to be found by before the ad step.
    for level in [AdLevel::Creative, AdLevel::Ad] {
        let found =
            r.li.find_by_name(&ads_cred(), &ads_public(), level, "anything")
                .await
                .unwrap();
        assert_eq!(found, None);
    }
    assert!(r.mock.recorded().is_empty());

    let spec = ad_spec();
    let id =
        r.li.create_ad(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(id, CREATIVE);
    let finder = r.mock.request("GET", CREATIVES);
    assert_eq!(
        finder.raw_query,
        "q=criteria&campaigns=List(urn%3Ali%3AsponsoredCampaign%3A700001)&sortOrder=ASCENDING"
    );
    // LinkedIn asks for the finder's Rest.li method by name.
    assert_eq!(finder.header("x-restli-method"), Some("FINDER"));
    let sent = r.mock.request("POST", CREATIVES);
    assert_eq!(sent.raw_query, "action=createInline");
    assert_eq!(
        sent.json(),
        json!({"creative": {
            "inlineContent": {"post": {
                "adContext": {"dscAdAccount": "urn:li:sponsoredAccount:512000001",
                              "dscStatus": "ACTIVE"},
                "author": "urn:li:organization:90000001",
                // LinkedIn's little text: the brackets are escaped, the text shows as written.
                "commentary": "Yeni sezon kayıtları açıldı \\(erken kayıt\\).",
                "visibility": "PUBLIC",
                "distribution": {"feedDistribution": "NONE",
                                 "thirdPartyDistributionChannels": []},
                "content": {"media": {"title": "Kayıt ol", "id": IMAGE_1}},
                "contentLandingPage": "https://jeeta.test/kayit",
                "contentCallToActionLabel": "SIGN_UP",
                "lifecycleState": "PUBLISHED",
                "isReshareDisabledByAuthor": true,
            }},
            "campaign": "urn:li:sponsoredCampaign:700001",
            "intendedStatus": "DRAFT",
            "name": spec.name,
        }})
    );
}

#[tokio::test]
async fn an_ad_whose_answer_was_lost_is_found_by_its_name_and_not_made_twice() {
    let r = rig().await;
    r.mock.on("GET", AD_ACCOUNT, ok(usable_account()));
    let spec = ad_spec();
    r.mock.on(
        "GET",
        CREATIVES,
        ok(elements(vec![
            json!({"id": "urn:li:sponsoredCreative:120000", "name": "another ad",
                   "intendedStatus": "DRAFT"}),
            json!({"id": "urn:li:sponsoredCreative:120001", "name": spec.name,
                   "intendedStatus": "DRAFT"}),
        ])),
    );
    let id =
        r.li.create_ad(&ads_cred(), &ads_public(), &spec)
            .await
            .unwrap();
    assert_eq!(id, CREATIVE);
    assert!(r.mock.requests("POST", CREATIVES).is_empty());
}

#[tokio::test]
async fn an_ad_linkedin_cannot_show_is_refused_before_anything_is_sent() {
    let r = rig().await;
    type Change = Box<dyn Fn(&mut CreativeSpec)>;
    let cases: Vec<(Change, &str)> = vec![
        (
            Box::new(|c| c.image = None),
            "a LinkedIn ad needs its image",
        ),
        (
            Box::new(|c| c.image = Some("hash-from-elsewhere".into())),
            "a LinkedIn ad needs its image",
        ),
        (
            Box::new(|c| c.call_to_action = Some(CallToAction::BookNow)),
            "LinkedIn has no button for this call to action",
        ),
        (
            Box::new(|c| c.call_to_action = None),
            "LinkedIn has no button for this call to action",
        ),
        (
            Box::new(|c| c.headline = "  ".into()),
            "a LinkedIn ad needs its text and its headline",
        ),
        (
            Box::new(|c| {
                c.action = CreativeAction::LeadForm {
                    form_id: "1".into(),
                    url: "https://jeeta.test/gizlilik".parse().unwrap(),
                }
            }),
            "a LinkedIn ad here leads to a website",
        ),
    ];
    for (change, expected) in cases {
        let mut spec = ad_spec();
        change(&mut spec.creative);
        let e =
            r.li.create_creative(&ads_cred(), &ads_public(), &spec.creative)
                .await
                .unwrap_err();
        assert_eq!(reason(&e), expected);
        let e =
            r.li.create_ad(&ads_cred(), &ads_public(), &spec)
                .await
                .unwrap_err();
        assert_eq!(reason(&e), expected);
    }
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn an_object_is_found_by_its_name_and_two_of_one_name_are_refused() {
    let r = rig().await;
    let name = format!("{NAME}:adset");
    r.mock.on(
        "GET",
        CAMPAIGNS,
        ok(elements(vec![
            json!({"id": 700009, "name": "another"}),
            json!({"id": 700001, "name": name}),
        ])),
    );
    let found =
        r.li.find_by_name(&ads_cred(), &ads_public(), AdLevel::AdSet, &name)
            .await
            .unwrap();
    assert_eq!(found.as_deref(), Some(CAMPAIGN));

    r.mock.set(
        "GET",
        CAMPAIGNS,
        ok(elements(vec![
            json!({"id": 700001, "name": name}),
            json!({"id": 700002, "name": name}),
        ])),
    );
    let e =
        r.li.find_by_name(&ads_cred(), &ads_public(), AdLevel::AdSet, &name)
            .await
            .unwrap_err();
    assert_eq!(
        reason(&e),
        "more than one object of the account carries this name"
    );
}

#[tokio::test]
async fn a_search_is_read_page_by_page() {
    let r = rig().await;
    let name = format!("{NAME}:campaign");
    r.mock.on(
        "GET",
        GROUPS,
        ok(json!({"elements": [{"id": 900009, "name": "another"}],
                  "metadata": {"nextPageToken": "DgGerr1iVQreCJVjZDOW_grcp63nueBDipsS4DJpvJo"}})),
    );
    r.mock.on(
        "GET",
        GROUPS,
        ok(elements(vec![json!({"id": 900001, "name": name})])),
    );
    let found =
        r.li.find_by_name(&ads_cred(), &ads_public(), AdLevel::Campaign, &name)
            .await
            .unwrap();
    assert_eq!(found.as_deref(), Some(GROUP));
    let pages = r.mock.requests("GET", GROUPS);
    assert_eq!(pages.len(), 2);
    assert!(
        pages[1]
            .raw_query
            .ends_with("&pageToken=DgGerr1iVQreCJVjZDOW_grcp63nueBDipsS4DJpvJo"),
        "{}",
        pages[1].raw_query
    );
}

// ---------------------------------------------------------------------------------------------
// Switching on and off
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn each_level_is_switched_with_a_partial_update_of_its_own_field() {
    let r = rig().await;
    for path in [GROUP_ONE, CAMPAIGN_ONE, CREATIVE_ONE] {
        r.mock.on("POST", path, raw(204, ""));
    }
    for (id, path, status, body) in [
        (
            CREATIVE,
            CREATIVE_ONE,
            AdStatus::Active,
            json!({"patch": {"$set": {"intendedStatus": "ACTIVE"}}}),
        ),
        (
            CAMPAIGN,
            CAMPAIGN_ONE,
            AdStatus::Active,
            json!({"patch": {"$set": {"status": "ACTIVE"}}}),
        ),
        (
            GROUP,
            GROUP_ONE,
            AdStatus::Paused,
            json!({"patch": {"$set": {"status": "PAUSED"}}}),
        ),
    ] {
        r.mock.clear();
        r.li.set_status(&ads_cred(), id, status).await.unwrap();
        let sent = r.mock.request("POST", path);
        assert_eq!(sent.header("x-restli-method"), Some("PARTIAL_UPDATE"));
        sent.assert_rest_headers(jt_linkedin::DEFAULT_API_VERSION);
        assert_eq!(sent.json(), body);
    }

    // An id that is not one of this adapter's changes nothing.
    r.mock.clear();
    for bad in [
        "urn:li:sponsoredCampaign:700001",
        "li:512000001:adset:1",
        "li:512000001/../x:campaign:1",
        "23850000000000001",
    ] {
        let e =
            r.li.set_status(&ads_cred(), bad, AdStatus::Active)
                .await
                .unwrap_err();
        assert_eq!(
            reason(&e),
            "not a LinkedIn ad object of the expected kind",
            "{bad}"
        );
    }
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn a_creative_in_review_cannot_be_paused_and_linkedin_says_so() {
    let r = rig().await;
    r.mock.on(
        "POST",
        CREATIVE_ONE,
        status(
            400,
            json!({"status": 400, "code": "ILLEGAL_STATE",
                   "message": "Cannot pause a creative that is in review"}),
        ),
    );
    let e =
        r.li.set_status(&ads_cred(), CREATIVE, AdStatus::Paused)
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert!(reason(&e).contains("in review"), "{e:?}");
}

#[tokio::test]
async fn an_object_of_another_ad_account_is_refused_before_any_call() {
    let r = rig().await;
    let other_group = "li:999:group:900001";
    let mut adset = adset_spec(starts(), ends(), &["TR"]);
    adset.campaign_id = other_group.into();
    let e =
        r.li.create_adset(&ads_cred(), &ads_public(), &adset)
            .await
            .unwrap_err();
    assert_eq!(reason(&e), "the object is of another LinkedIn ad account");
    let e =
        r.li.campaign_state(&ads_cred(), &ads_public(), other_group)
            .await
            .unwrap_err();
    assert_eq!(reason(&e), "the object is of another LinkedIn ad account");
    // A campaign where a group is expected.
    let e =
        r.li.campaign_state(&ads_cred(), &ads_public(), CAMPAIGN)
            .await
            .unwrap_err();
    assert_eq!(reason(&e), "not a LinkedIn ad object of the expected kind");
    assert!(r.mock.recorded().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Reading back
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_state_is_the_groups_switch_and_each_creatives_review() {
    let r = rig().await;
    r.mock.on(
        "GET",
        GROUP_ONE,
        ok(json!({"id": 900001, "status": "ACTIVE"})),
    );
    r.mock.on(
        "GET",
        CAMPAIGNS,
        ok(elements(vec![json!({"id": 700001, "status": "ACTIVE"})])),
    );
    r.mock.on(
        "GET",
        CREATIVES,
        ok(elements(vec![
            json!({"id": "urn:li:sponsoredCreative:120001", "name": "a",
                   "intendedStatus": "ACTIVE", "review": {"status": "APPROVED"}}),
            json!({"id": "urn:li:sponsoredCreative:120002", "name": "b",
                   "intendedStatus": "ACTIVE", "review": {"status": "PENDING"}}),
            json!({"id": "urn:li:sponsoredCreative:120003", "name": "c",
                   "intendedStatus": "ACTIVE",
                   "review": {"status": "REJECTED", "rejectionReasons": [
                       "MISLEADING_CLAIM", {"rejectionReason": "IMAGE_QUALITY"}]}}),
            json!({"id": "urn:li:sponsoredCreative:120004", "name": "d",
                   "intendedStatus": "DRAFT"}),
        ])),
    );
    let state =
        r.li.campaign_state(&ads_cred(), &ads_public(), GROUP)
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
            (CREATIVE, &ProviderAdStatus::Active, None),
            (
                "li:512000001:creative:120002",
                &ProviderAdStatus::InReview,
                None
            ),
            (
                "li:512000001:creative:120003",
                &ProviderAdStatus::Disapproved,
                Some("MISLEADING_CLAIM, IMAGE_QUALITY")
            ),
            (
                "li:512000001:creative:120004",
                &ProviderAdStatus::Paused,
                None
            ),
        ]
    );
    assert_eq!(
        r.mock.request("GET", CAMPAIGNS).raw_query,
        "q=search&search=(campaignGroup:(values:List(urn%3Ali%3AsponsoredCampaignGroup%3A900001)),\
         status:(values:List(ACTIVE,DRAFT,PAUSED)))"
    );
}

#[tokio::test]
async fn the_days_are_each_creatives_cost_in_minor_units_and_its_visits() {
    let r = rig().await;
    r.mock.on("GET", AD_ACCOUNT, ok(usable_account()));
    r.mock.on(
        "GET",
        CAMPAIGNS,
        ok(elements(vec![json!({"id": 700001, "status": "ACTIVE"})])),
    );
    r.mock.on(
        "GET",
        ANALYTICS,
        ok(json!({"elements": [
            {"dateRange": {"start": {"year": 2026, "month": 11, "day": 12},
                           "end": {"year": 2026, "month": 11, "day": 12}},
             "pivotValues": ["urn:li:sponsoredCreative:120001"],
             "impressions": 1840, "clicks": 31, "landingPageClicks": 22,
             "costInLocalCurrency": "12.3456"},
            {"dateRange": {"start": {"year": 2026, "month": 11, "day": 13},
                           "end": {"year": 2026, "month": 11, "day": 13}},
             "pivotValues": ["urn:li:sponsoredCreative:120001"],
             "impressions": 90, "clicks": 0},
        ], "paging": {"count": 10, "start": 0, "links": []}})),
    );
    let since = Date::from_calendar_date(2026, Month::November, 12).unwrap();
    let until = Date::from_calendar_date(2026, Month::November, 13).unwrap();
    let days =
        r.li.ad_days(
            &ads_cred(),
            &ads_public(),
            GROUP,
            AdObjective::Traffic,
            since,
            until,
        )
        .await
        .unwrap();
    assert_eq!(days.len(), 2);
    assert_eq!(days[0].ad_id, CREATIVE);
    assert_eq!(days[0].day, since);
    assert_eq!(days[0].spend_minor, Some(1235));
    assert_eq!(
        (days[0].impressions, days[0].clicks, days[0].results),
        (Some(1840), Some(31), Some(22))
    );
    // A day LinkedIn gives no cost and no visits for carries none: never a zero in their place.
    assert_eq!(days[1].day, until);
    assert_eq!((days[1].spend_minor, days[1].results), (None, None));
    assert_eq!(days[1].clicks, Some(0));

    assert_eq!(
        r.mock.request("GET", ANALYTICS).raw_query,
        "q=analytics&pivot=CREATIVE&timeGranularity=DAILY\
         &dateRange=(start:(year:2026,month:11,day:12),end:(year:2026,month:11,day:13))\
         &campaigns=List(urn%3Ali%3AsponsoredCampaign%3A700001)\
         &fields=dateRange,pivotValues,impressions,clicks,landingPageClicks,costInLocalCurrency"
    );

    // A group without a campaign yet has no days, and the analytics are not asked.
    r.mock.clear();
    r.mock.set("GET", CAMPAIGNS, ok(elements(vec![])));
    let days =
        r.li.ad_days(
            &ads_cred(),
            &ads_public(),
            GROUP,
            AdObjective::Traffic,
            since,
            until,
        )
        .await
        .unwrap();
    assert!(days.is_empty());
    assert!(r.mock.requests("GET", ANALYTICS).is_empty());
}

// ---------------------------------------------------------------------------------------------
// What an ad account is not
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn an_ad_account_posts_nothing_and_another_kind_builds_no_campaign() {
    let r = rig().await;
    // Publishing with the ad account's capability is refused before any call.
    let e =
        r.li.publish(
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
    // A page is no ad account.
    let e =
        r.li.account_limits(&ads_cred(), &page_public())
            .await
            .unwrap_err();
    assert_eq!(reason(&e), "not a LinkedIn ad account");
    let mut malformed = ads_public();
    malformed["external_id"] = json!("512/../1");
    let e =
        r.li.account_limits(&ads_cred(), &malformed)
            .await
            .unwrap_err();
    assert_eq!(reason(&e), "the LinkedIn ad account id is missing");
    // What LinkedIn's ads do not offer here.
    let e =
        r.li.preview(
            &ads_cred(),
            &ads_public(),
            &creative(),
            AdPlacement::FacebookFeed,
        )
        .await
        .unwrap_err();
    assert_eq!(
        reason(&e),
        "an ad preview is not offered for a LinkedIn ad account"
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn no_secret_reaches_an_ad_error() {
    let r = rig().await;
    r.mock.on(
        "GET",
        AD_ACCOUNT,
        status(
            401,
            json!({"status": 401, "code": "REVOKED_ACCESS_TOKEN",
                   "message": format!("The token {ACCESS_TOKEN} used in the request has been revoked")}),
        ),
    );
    let e =
        r.li.account_limits(&ads_cred(), &ads_public())
            .await
            .unwrap_err();
    assert_eq!(e.kind(), "auth");
    assert_no_secret(&format!("{e:?} {}", reason(&e)));
}
