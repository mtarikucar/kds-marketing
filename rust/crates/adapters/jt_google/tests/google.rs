//! The Google adapter against the in-process mock: hosts, OAuth, the access token of a call,
//! accounts, the probe, a search campaign built step by step, statuses, the state and the daily
//! numbers, the error table and retries.

mod support;

use std::time::Duration as StdDuration;

use jt_app::ports::connectors::{
    AdAccountLimits, AdAudience, AdBudgetWriter, AdCampaignWriter, AdLevel, AdObjective,
    AdPlacements, AdSetGoal, AdSetSpec, AdSpec, AdStatus, CampaignSpec, Connector, CreativeAction,
    CreativeSpec, OAuthApp, OAuthProvider, ProviderAdStatus, XApp,
};
use jt_connector::{ConnectorError, Credential, Provider};
use jt_google::{ADS_SCOPE, GOOGLE_HOSTS, INLINE, MAX_PAGES, READ_ATTEMPTS};
use jt_outbound::FIXED_HOSTS;
use serde_json::{Value, json};
use support::*;
use time::macros::{date, datetime};
use url::Url;

fn redirect() -> Url {
    Url::parse("https://panel.test/oauth/callback/google").unwrap()
}

fn app() -> OAuthApp {
    OAuthApp::Google(TestApps::default().google.unwrap())
}

fn kind_of<T: std::fmt::Debug>(r: Result<T, ConnectorError>) -> &'static str {
    r.expect_err("an error").kind()
}

fn reason_of<T: std::fmt::Debug>(r: Result<T, ConnectorError>) -> String {
    r.expect_err("an error")
        .reason()
        .unwrap_or_default()
        .to_owned()
}

fn campaign_spec() -> CampaignSpec {
    CampaignSpec {
        name: "jeeta:01a1c9ad-2710-76fc-bfee-95daa5f786da:campaign".into(),
        objective: AdObjective::Traffic,
        lifetime_budget_minor: 50_000,
        // 22:30 UTC is already the 12th in Istanbul.
        start_at: datetime!(2026-11-11 22:30 UTC),
        end_at: datetime!(2026-11-18 22:30 UTC),
    }
}

fn adset_spec() -> AdSetSpec {
    AdSetSpec {
        name: "jeeta:01a1c9ad-2710-76fc-bfee-95daa5f786da:adset".into(),
        campaign_id: CAMPAIGN.into(),
        goal: AdSetGoal::LinkClicks,
        audience: AdAudience {
            countries: vec!["TR".into(), "AZ".into()],
            regions: vec![],
            cities: vec![],
            age_min: 18,
            age_max: 65,
            genders: vec![],
            interests: vec![],
            broad: false,
        },
        placements: AdPlacements::Automatic,
        start_at: datetime!(2026-11-11 22:30 UTC),
        end_at: datetime!(2026-11-18 22:30 UTC),
        budget_minor: 50_000,
        keywords: vec!["yeni sezon kayıt".into(), " kurs kayıt ".into()],
    }
}

fn creative() -> CreativeSpec {
    CreativeSpec {
        name: "jeeta:01a1c9ad-2710-76fc-bfee-95daa5f786da:creative:0:0".into(),
        identity_id: None,
        instagram_user_id: None,
        image: None,
        primary_text: String::new(),
        headline: String::new(),
        description: None,
        headlines: vec![
            "Yeni sezon kayıtları".into(),
            "Kayıtlar açıldı".into(),
            "Hemen kayıt ol".into(),
        ],
        descriptions: vec![
            "Yeni sezon başlıyor, yerini ayırt.".into(),
            "Kayıt birkaç dakika sürer.".into(),
        ],
        call_to_action: None,
        action: CreativeAction::Link {
            url: Url::parse("https://ornek.example/kayit").unwrap(),
        },
    }
}

fn ad_spec() -> AdSpec {
    AdSpec {
        name: "jeeta:01a1c9ad-2710-76fc-bfee-95daa5f786da:ad:0:0".into(),
        adset_id: AD_GROUP.into(),
        creative_id: INLINE.into(),
        creative: creative(),
    }
}

/// The mutate answer naming what each operation made, by its result key.
fn mutated(results: &[(&str, &str)]) -> Value {
    json!({"mutateOperationResponses": results.iter()
        .map(|(key, name)| json!({*key: {"resourceName": name}}))
        .collect::<Vec<_>>()})
}

fn rows(results: Vec<Value>) -> Value {
    json!({ "results": results })
}

// ---------------------------------------------------------------------------------------------
// The adapter and its sign-in
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_adapter_is_googles_and_reaches_only_its_fixed_hosts() {
    let r = rig().await;
    assert_eq!(r.google.provider(), Provider::Google);
    assert_eq!(Provider::Google.kinds(), ["google_ads"]);
    let fixed: Vec<&str> = FIXED_HOSTS
        .iter()
        .filter(|h| h.connector == "google")
        .map(|h| h.host)
        .collect();
    assert_eq!(r.google.hosts(), GOOGLE_HOSTS);
    assert_eq!(fixed, GOOGLE_HOSTS);
    assert_no_secret(&format!("{:?}", r.google));
}

#[tokio::test]
async fn the_sign_in_asks_for_google_ads_offline_and_exchanges_the_code() {
    let r = rig().await;
    let url = r
        .google
        .authorize_url(&app(), &redirect(), "state-1", Some("challenge"))
        .unwrap();
    assert_eq!(url.host_str(), Some("accounts.google.com"));
    assert_eq!(url.path(), "/o/oauth2/v2/auth");
    let pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let expected = [
        ("client_id", CLIENT_ID),
        ("redirect_uri", redirect().as_str()),
        ("response_type", "code"),
        ("scope", ADS_SCOPE),
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("include_granted_scopes", "true"),
        ("state", "state-1"),
    ]
    .map(|(k, v)| (k.to_owned(), v.to_owned()));
    assert_eq!(pairs, expected, "no PKCE challenge, no secret");
    assert_no_secret(url.as_str());
    // Another provider's app does not sign in to Google.
    let x = OAuthApp::X(XApp {
        client_id: "x".into(),
        client_secret: "y".into(),
        ad_scopes: false,
    });
    assert_eq!(
        kind_of(r.google.authorize_url(&x, &redirect(), "s", None)),
        "permanent"
    );

    r.mock.on(
        "POST",
        TOKEN,
        ok(
            json!({"access_token":MINTED_TOKEN,"expires_in":3599,"refresh_token":REFRESH_TOKEN,
            "scope":ADS_SCOPE,"token_type":"Bearer"}),
        ),
    );
    let credential = r
        .google
        .exchange(&app(), &redirect(), CODE, Some("verifier"))
        .await
        .unwrap();
    let Credential::OAuth {
        access_token,
        refresh_token,
        expires_at,
        scopes,
    } = &credential
    else {
        panic!("{credential:?}")
    };
    assert_eq!(access_token, MINTED_TOKEN);
    assert_eq!(refresh_token.as_deref(), Some(REFRESH_TOKEN));
    // The connection lives as long as its refresh token: it names no end, and so it never
    // reads as expired between two rounds of the refresh job.
    assert_eq!(*expires_at, None);
    assert_eq!(scopes, &[ADS_SCOPE.to_owned()]);
    let sent = r.mock.request("POST", TOKEN);
    assert_eq!(
        sent.form(),
        [
            ("grant_type", "authorization_code"),
            ("code", CODE),
            ("redirect_uri", redirect().as_str()),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
        ]
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
    );
    assert_eq!(sent.bearer(), None);
}

#[tokio::test]
async fn an_exchange_without_a_refresh_token_or_without_google_ads_is_refused() {
    let r = rig().await;
    // Without a refresh token the connection could not outlive its first hour.
    r.mock.on(
        "POST",
        TOKEN,
        ok(json!({"access_token":MINTED_TOKEN,"expires_in":3599,"scope":ADS_SCOPE})),
    );
    let e = r.google.exchange(&app(), &redirect(), CODE, None).await;
    assert_eq!(reason_of(e), "Google's token answer has no refresh token");
    // The user unticked Google Ads on the consent screen.
    let r = rig().await;
    r.mock.on(
        "POST",
        TOKEN,
        ok(
            json!({"access_token":MINTED_TOKEN,"expires_in":3599,"refresh_token":REFRESH_TOKEN,
            "scope":"openid"}),
        ),
    );
    assert_eq!(
        kind_of(r.google.exchange(&app(), &redirect(), CODE, None).await),
        "permission"
    );
    // A spent code is the owner's to redo; the platform's own client refused is not.
    let r = rig().await;
    r.mock.on(
        "POST",
        TOKEN,
        status(
            400,
            json!({"error":"invalid_grant","error_description":"Bad Request"}),
        ),
    );
    assert_eq!(
        kind_of(r.google.exchange(&app(), &redirect(), CODE, None).await),
        "auth"
    );
    let r = rig().await;
    r.mock.on(
        "POST",
        TOKEN,
        status(
            401,
            json!({"error":"invalid_client","error_description":"The OAuth client was not found."}),
        ),
    );
    let e = r
        .google
        .exchange(&app(), &redirect(), CODE, None)
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert_eq!(e.reason(), Some("platform client credentials rejected"));
    assert_no_secret(&format!("{e:?}"));
}

#[tokio::test]
async fn a_refresh_keeps_the_refresh_token_and_a_revoke_ends_the_grant() {
    let r = rig().await;
    r.mock.on(
        "POST",
        TOKEN,
        ok(
            json!({"access_token":MINTED_TOKEN,"expires_in":3599,"scope":ADS_SCOPE,
            "token_type":"Bearer"}),
        ),
    );
    let renewed = r.google.refresh(&stale_cred()).await.unwrap().unwrap();
    let Credential::OAuth {
        access_token,
        refresh_token,
        scopes,
        ..
    } = &renewed
    else {
        panic!("{renewed:?}")
    };
    assert_eq!(access_token, MINTED_TOKEN);
    assert_eq!(refresh_token.as_deref(), Some(REFRESH_TOKEN));
    assert_eq!(scopes, &[ADS_SCOPE.to_owned()]);
    assert_eq!(
        r.mock.request("POST", TOKEN).form(),
        [
            ("grant_type", "refresh_token"),
            ("refresh_token", REFRESH_TOKEN),
            ("client_id", CLIENT_ID),
            ("client_secret", CLIENT_SECRET),
        ]
        .map(|(k, v)| (k.to_owned(), v.to_owned()))
    );
    // Nothing to renew with: `None`, and nothing is sent.
    let bare = Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: None,
        expires_at: None,
        scopes: vec![],
    };
    r.mock.clear();
    assert_eq!(r.google.refresh(&bare).await.unwrap(), None);
    assert!(r.mock.lines().is_empty());
    // A refresh token Google no longer takes: the owner must reconnect.
    let r = rig().await;
    r.mock.on(
        "POST",
        TOKEN,
        status(400, json!({"error":"invalid_grant","error_description":"Token has been expired or revoked."})),
    );
    assert_eq!(kind_of(r.google.refresh(&stale_cred()).await), "auth");

    // Disconnecting revokes the refresh token at Google.
    let r = rig().await;
    r.mock.on("POST", REVOKE, raw(200, ""));
    r.google.revoke(&cred()).await.unwrap();
    assert_eq!(
        r.mock.request("POST", REVOKE).form(),
        [("token".to_owned(), REFRESH_TOKEN.to_owned())]
    );
}

#[tokio::test]
async fn a_call_gets_its_own_access_token_when_the_stored_one_ended() {
    let r = rig().await;
    r.mock
        .on_search("FROM customer", ok(customer(CUSTOMER, "ENABLED", false)));
    // The stored token is good: it is used, and the token endpoint is not asked.
    r.google.account_limits(&cred(), &public()).await.unwrap();
    assert_eq!(r.mock.requests("POST", TOKEN).len(), 0);
    assert_eq!(r.mock.request("POST", SEARCH).bearer(), Some(ACCESS_TOKEN));
    // The stored token ended: one token call, and the token it brought serves the next calls.
    r.mock.clear();
    r.mock.on(
        "POST",
        TOKEN,
        ok(json!({"access_token":MINTED_TOKEN,"expires_in":3599,"scope":ADS_SCOPE})),
    );
    for _ in 0..3 {
        r.google
            .account_limits(&stale_cred(), &public())
            .await
            .unwrap();
    }
    assert_eq!(r.mock.requests("POST", TOKEN).len(), 1);
    let searches = r.mock.requests("POST", SEARCH);
    assert_eq!(searches.len(), 3);
    assert!(searches.iter().all(|s| s.bearer() == Some(MINTED_TOKEN)));
    // No refresh token and an ended access token: the owner must reconnect; nothing is sent.
    let dead = Credential::OAuth {
        access_token: ACCESS_TOKEN.into(),
        refresh_token: None,
        expires_at: None,
        scopes: vec![ADS_SCOPE.into()],
    };
    r.mock.clear();
    let e = r.google.account_limits(&dead, &public()).await;
    assert_eq!(kind_of(e), "auth");
    assert!(r.mock.lines().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Accounts and the probe
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_sign_ins_enabled_ad_accounts_are_offered() {
    let r = rig().await;
    r.mock.on(
        "GET",
        LIST,
        ok(
            json!({"resourceNames":["customers/1234567890","customers/2000000002",
            "customers/2000000003","customers/2000000004","not-a-customer"]}),
        ),
    );
    r.mock
        .on_search("FROM customer", ok(customer(CUSTOMER, "ENABLED", false)));
    // A manager account, a cancelled account, and one whose sign-up is not finished.
    r.mock.on_search_of(
        "2000000002",
        "FROM customer",
        ok(customer("2000000002", "ENABLED", true)),
    );
    r.mock.on_search_of(
        "2000000003",
        "FROM customer",
        ok(customer("2000000003", "CANCELED", false)),
    );
    r.mock.on_search_of(
        "2000000004",
        "FROM customer",
        status(
            403,
            failure("authorizationError", "CUSTOMER_NOT_ENABLED", "Not enabled."),
        ),
    );
    let signed_in = cred();
    let assets = r.google.list_assets(&signed_in).await.unwrap();
    assert_eq!(assets.len(), 1);
    let asset = assets[0].public_facts();
    assert_eq!(asset.kind_key, "google_ads");
    assert_eq!(asset.external_id, CUSTOMER);
    assert_eq!(asset.name, "Hesap 1234567890");
    assert_eq!(
        asset.public,
        json!({"currency":"TRY","time_zone":"Europe/Istanbul","test_account":false})
    );
    assert_eq!(assets[0].credential, signed_in);
    assert_eq!(r.mock.request("GET", LIST).bearer(), Some(ACCESS_TOKEN));
    // No developer token and no manager header are sent.
    let sent = r.mock.request("POST", SEARCH);
    assert_eq!(sent.header("developer-token"), None);
    assert_eq!(sent.header("login-customer-id"), None);

    // The platform's project may not call production accounts: that is not this account's
    // trouble, and the listing says so instead of offering nothing.
    let r = rig().await;
    r.mock.on(
        "GET",
        LIST,
        ok(json!({"resourceNames":["customers/1234567890"]})),
    );
    r.mock.on_search(
        "FROM customer",
        status(
            403,
            failure(
                "authorizationError",
                "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
                "Test access.",
            ),
        ),
    );
    let e = r.google.list_assets(&cred()).await.unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert_eq!(
        e.reason(),
        Some("the platform's Google Cloud project may not call this account")
    );
}

#[tokio::test]
async fn the_probe_names_the_account_the_token_reaches() {
    let r = rig().await;
    r.mock
        .on_search("FROM customer", ok(customer(CUSTOMER, "ENABLED", false)));
    let probe = r.google.probe(&cred(), &public()).await;
    assert!(probe.ok, "{probe:?}");
    assert_eq!(
        probe.facts,
        json!({"account_id":CUSTOMER,"name":"Hesap 1234567890","currency":"TRY",
            "time_zone":"Europe/Istanbul","test_account":false})
    );
    // An account that cannot run ads fails its probe.
    let r = rig().await;
    r.mock
        .on_search("FROM customer", ok(customer(CUSTOMER, "SUSPENDED", false)));
    let probe = r.google.probe(&cred(), &public()).await;
    assert_eq!(probe.error.unwrap().kind(), "permission");
    // Google answering for another account is never taken for this one.
    let r = rig().await;
    r.mock.on_search(
        "FROM customer",
        ok(customer("2000000002", "ENABLED", false)),
    );
    let probe = r.google.probe(&cred(), &public()).await;
    assert_eq!(probe.error.unwrap().kind(), "permanent");
    // Another kind, or no usable id: refused before a call.
    for public in [
        json!({"kind_key":"meta_ads","external_id":CUSTOMER}),
        json!({"kind_key":"google_ads","external_id":"12 OR 1=1"}),
        json!({"external_id":CUSTOMER}),
    ] {
        r.mock.clear();
        let probe = r.google.probe(&cred(), &public).await;
        assert_eq!(probe.error.unwrap().kind(), "permanent");
        assert!(r.mock.lines().is_empty());
    }
}

#[tokio::test]
async fn account_limits_are_the_accounts_currency_and_zone() {
    let r = rig().await;
    r.mock
        .on_search("FROM customer", ok(customer(CUSTOMER, "ENABLED", false)));
    assert_eq!(
        r.google.account_limits(&cred(), &public()).await.unwrap(),
        AdAccountLimits {
            currency: "TRY".into(),
            minor_unit_exponent: 2,
            timezone: "Europe/Istanbul".into(),
            min_daily_budget_minor: 0,
            min_total_budget_minor: 0,
        }
    );
}

// ---------------------------------------------------------------------------------------------
// Building a search campaign
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn an_object_is_looked_for_by_its_name_before_it_is_made() {
    let r = rig().await;
    let name = "jeeta:01a1c9ad-2710-76fc-bfee-95daa5f786da:campaign";
    r.mock.on_search("FROM campaign", ok(rows(vec![])));
    let find = |level: AdLevel, name: &'static str| {
        let google = &r.google;
        async move { google.find_by_name(&cred(), &public(), level, name).await }
    };
    assert_eq!(find(AdLevel::Campaign, name).await.unwrap(), None);
    assert_eq!(
        r.mock.request("POST", SEARCH).query(),
        format!(
            "SELECT campaign.resource_name FROM campaign WHERE campaign.name = '{name}' AND \
             campaign.status != 'REMOVED'"
        )
    );
    // One is adopted; two are nobody's to choose between.
    let r = rig().await;
    r.mock.on_search(
        "FROM campaign",
        ok(rows(vec![json!({"campaign":{"resourceName":CAMPAIGN}})])),
    );
    let found = r
        .google
        .find_by_name(&cred(), &public(), AdLevel::Campaign, name)
        .await
        .unwrap();
    assert_eq!(found.as_deref(), Some(CAMPAIGN));
    let r = rig().await;
    r.mock.on_search(
        "FROM campaign",
        ok(rows(vec![
            json!({"campaign":{"resourceName":CAMPAIGN}}),
            json!({"campaign":{"resourceName":"customers/1234567890/campaigns/112"}}),
        ])),
    );
    let twice = r
        .google
        .find_by_name(&cred(), &public(), AdLevel::Campaign, name)
        .await;
    assert_eq!(kind_of(twice), "permanent");
    // The ad group the same way.
    let r = rig().await;
    r.mock.on_search(
        "FROM ad_group WHERE ad_group.name",
        ok(rows(vec![json!({"adGroup":{"resourceName":AD_GROUP}})])),
    );
    let found = r
        .google
        .find_by_name(&cred(), &public(), AdLevel::AdSet, "jeeta:x:adset")
        .await
        .unwrap();
    assert_eq!(found.as_deref(), Some(AD_GROUP));
    // A creative does not exist at Google and an ad has no name: nothing is asked. A name that
    // is not one of ours is never written into a query.
    r.mock.clear();
    for level in [AdLevel::Creative, AdLevel::Ad] {
        let none = r
            .google
            .find_by_name(&cred(), &public(), level, "jeeta:x:ad:0:0")
            .await
            .unwrap();
        assert_eq!(none, None);
    }
    let odd = r
        .google
        .find_by_name(
            &cred(),
            &public(),
            AdLevel::Campaign,
            "x' OR campaign.id > 0",
        )
        .await;
    assert_eq!(kind_of(odd), "permanent");
    assert!(r.mock.lines().is_empty());
}

#[tokio::test]
async fn the_campaign_and_its_total_budget_are_made_together_and_paused() {
    let r = rig().await;
    r.mock
        .on_search("FROM customer", ok(customer(CUSTOMER, "ENABLED", false)));
    r.mock.on(
        "POST",
        MUTATE,
        ok(mutated(&[
            (
                "campaignBudgetResult",
                "customers/1234567890/campaignBudgets/77",
            ),
            ("campaignResult", CAMPAIGN),
        ])),
    );
    let made = r
        .google
        .create_campaign(&cred(), &public(), &campaign_spec())
        .await
        .unwrap();
    assert_eq!(made, CAMPAIGN);
    let sent = r.mock.request("POST", MUTATE);
    assert_eq!(sent.bearer(), Some(ACCESS_TOKEN));
    assert_eq!(
        sent.json(),
        json!({"mutateOperations":[
            {"campaignBudgetOperation":{"create":{
                "resourceName":"customers/1234567890/campaignBudgets/-1",
                "period":"CUSTOM_PERIOD",
                // 500,00 TRY.
                "totalAmountMicros":"500000000",
                "explicitlyShared":false,
                "deliveryMethod":"STANDARD"}}},
            {"campaignOperation":{"create":{
                "name":"jeeta:01a1c9ad-2710-76fc-bfee-95daa5f786da:campaign",
                "status":"PAUSED",
                "advertisingChannelType":"SEARCH",
                "campaignBudget":"customers/1234567890/campaignBudgets/-1",
                "targetSpend":{},
                "networkSettings":{"targetGoogleSearch":true,"targetSearchNetwork":false,
                    "targetContentNetwork":false,"targetPartnerSearchNetwork":false},
                "geoTargetTypeSetting":{"positiveGeoTargetType":"PRESENCE"},
                // The account's own days: Istanbul is three hours ahead of UTC.
                "startDateTime":"2026-11-12 00:00:00",
                "endDateTime":"2026-11-19 23:59:59",
                "containsEuPoliticalAdvertising":"DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING"}}}
        ]})
    );
    // A mutate is sent once, whatever comes of it.
    assert_eq!(r.mock.requests("POST", MUTATE).len(), 1);

    // What Google refuses is said in Google's words; a campaign for leads is not built at all.
    let r = rig().await;
    r.mock
        .on_search("FROM customer", ok(customer(CUSTOMER, "ENABLED", false)));
    r.mock.on(
        "POST",
        MUTATE,
        status(
            400,
            failure(
                "campaignError",
                "DURATION_TOO_LONG_FOR_TOTAL_BUDGET",
                "The campaign runs too long for a total budget.",
            ),
        ),
    );
    let e = r
        .google
        .create_campaign(&cred(), &public(), &campaign_spec())
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert_eq!(
        e.reason(),
        Some(
            "HTTP 400 campaignError.DURATION_TOO_LONG_FOR_TOTAL_BUDGET: The campaign runs too \
             long for a total budget."
        )
    );
    r.mock.clear();
    let mut leads = campaign_spec();
    leads.objective = AdObjective::Leads;
    assert_eq!(
        kind_of(r.google.create_campaign(&cred(), &public(), &leads).await),
        "permanent"
    );
    assert!(r.mock.lines().is_empty());

    // An accepted mutate that does not say what it made is never taken for a refusal.
    let r = rig().await;
    r.mock
        .on_search("FROM customer", ok(customer(CUSTOMER, "ENABLED", false)));
    r.mock
        .on("POST", MUTATE, ok(json!({"mutateOperationResponses":[]})));
    let lost = r
        .google
        .create_campaign(&cred(), &public(), &campaign_spec())
        .await;
    assert_eq!(kind_of(lost), "unknown");
}

#[tokio::test]
async fn the_ad_group_comes_with_its_countries_and_its_searches() {
    let r = rig().await;
    r.mock.on_search(
        "FROM geo_target_constant",
        ok(rows(vec![
            json!({"geoTargetConstant":{"resourceName":"geoTargetConstants/2031","countryCode":"AZ"}}),
            json!({"geoTargetConstant":{"resourceName":"geoTargetConstants/2792","countryCode":"TR"}}),
        ])),
    );
    r.mock.on(
        "POST",
        MUTATE,
        ok(mutated(&[
            ("adGroupResult", AD_GROUP),
            (
                "campaignCriterionResult",
                "customers/1234567890/campaignCriteria/111~2792",
            ),
        ])),
    );
    let made = r
        .google
        .create_adset(&cred(), &public(), &adset_spec())
        .await
        .unwrap();
    assert_eq!(made, AD_GROUP);
    assert_eq!(
        r.mock.request("POST", SEARCH).query(),
        "SELECT geo_target_constant.resource_name, geo_target_constant.country_code FROM \
         geo_target_constant WHERE geo_target_constant.target_type = 'Country' AND \
         geo_target_constant.status = 'ENABLED' AND geo_target_constant.country_code IN \
         ('TR', 'AZ')"
    );
    let group = "customers/1234567890/adGroups/-1";
    assert_eq!(
        r.mock.request("POST", MUTATE).json(),
        json!({"mutateOperations":[
            {"adGroupOperation":{"create":{"resourceName":group,
                "name":"jeeta:01a1c9ad-2710-76fc-bfee-95daa5f786da:adset",
                "campaign":CAMPAIGN,"status":"PAUSED","type":"SEARCH_STANDARD"}}},
            // The countries, in the plan's order, on the campaign.
            {"campaignCriterionOperation":{"create":{"campaign":CAMPAIGN,
                "location":{"geoTargetConstant":"geoTargetConstants/2792"}}}},
            {"campaignCriterionOperation":{"create":{"campaign":CAMPAIGN,
                "location":{"geoTargetConstant":"geoTargetConstants/2031"}}}},
            // The searches, as phrases.
            {"adGroupCriterionOperation":{"create":{"adGroup":group,"status":"ENABLED",
                "keyword":{"text":"yeni sezon kayıt","matchType":"PHRASE"}}}},
            {"adGroupCriterionOperation":{"create":{"adGroup":group,"status":"ENABLED",
                "keyword":{"text":"kurs kayıt","matchType":"PHRASE"}}}}
        ]})
    );

    // A country Google names no target for: nothing is created.
    let r = rig().await;
    r.mock.on_search(
        "FROM geo_target_constant",
        ok(rows(vec![
            json!({"geoTargetConstant":{"resourceName":"geoTargetConstants/2792","countryCode":"TR"}}),
        ])),
    );
    let e = r
        .google
        .create_adset(&cred(), &public(), &adset_spec())
        .await;
    assert_eq!(
        reason_of(e),
        "Google names no single target for the country AZ"
    );
    assert!(r.mock.requests("POST", MUTATE).is_empty());

    // A campaign of another account, no searches, a lead goal: refused before any call.
    r.mock.clear();
    let mut foreign = adset_spec();
    foreign.campaign_id = "customers/999/campaigns/111".into();
    let mut silent = adset_spec();
    silent.keywords.clear();
    let mut leads = adset_spec();
    leads.goal = AdSetGoal::Leads {
        page_id: "1".into(),
    };
    for spec in [foreign, silent, leads] {
        assert_eq!(
            kind_of(r.google.create_adset(&cred(), &public(), &spec).await),
            "permanent"
        );
    }
    assert!(r.mock.lines().is_empty());
}

#[tokio::test]
async fn a_search_ad_carries_its_own_texts_and_is_never_made_twice() {
    let r = rig().await;
    // The creative step sends nothing.
    assert_eq!(
        r.google
            .create_creative(&cred(), &public(), &creative())
            .await
            .unwrap(),
        INLINE
    );
    let mut short = creative();
    short.headlines.truncate(2);
    assert_eq!(
        kind_of(r.google.create_creative(&cred(), &public(), &short).await),
        "permanent"
    );
    let mut pictured = creative();
    pictured.image = Some("hash".into());
    assert_eq!(
        kind_of(
            r.google
                .create_creative(&cred(), &public(), &pictured)
                .await
        ),
        "permanent"
    );
    assert!(r.mock.lines().is_empty());

    // The ad group holds another ad: this one is made, paused, with its texts and address.
    r.mock.on_search(
        "FROM ad_group_ad",
        ok(rows(vec![json!({"adGroupAd":{
            "resourceName":"customers/1234567890/adGroupAds/222~300",
            "ad":{"finalUrls":["https://ornek.example/baska"],
                "responsiveSearchAd":{"headlines":[{"text":"Başka"}],"descriptions":[]}}}})])),
    );
    r.mock
        .on("POST", MUTATE, ok(mutated(&[("adGroupAdResult", AD)])));
    let made = r
        .google
        .create_ad(&cred(), &public(), &ad_spec())
        .await
        .unwrap();
    assert_eq!(made, AD);
    assert_eq!(
        r.mock.request("POST", SEARCH).query(),
        format!(
            "SELECT ad_group_ad.resource_name, ad_group_ad.ad.final_urls, \
             ad_group_ad.ad.responsive_search_ad.headlines, \
             ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad WHERE \
             ad_group.resource_name = '{AD_GROUP}' AND ad_group_ad.status != 'REMOVED'"
        )
    );
    assert_eq!(
        r.mock.request("POST", MUTATE).json(),
        json!({"mutateOperations":[{"adGroupAdOperation":{"create":{
            "adGroup":AD_GROUP,"status":"PAUSED",
            "ad":{"finalUrls":["https://ornek.example/kayit"],
                "responsiveSearchAd":{
                    "headlines":[{"text":"Yeni sezon kayıtları"},{"text":"Kayıtlar açıldı"},
                        {"text":"Hemen kayıt ol"}],
                    "descriptions":[{"text":"Yeni sezon başlıyor, yerini ayırt."},
                        {"text":"Kayıt birkaç dakika sürer."}]}}}}}]})
    );

    // The answer to that was lost: the next run finds the ad that says exactly this and adopts
    // it. No second ad is made.
    let r = rig().await;
    r.mock.on_search(
        "FROM ad_group_ad",
        ok(rows(vec![json!({"adGroupAd":{"resourceName":AD,
            "ad":{"finalUrls":["https://ornek.example/kayit"],
                "responsiveSearchAd":{
                    "headlines":[{"text":"Yeni sezon kayıtları"},{"text":"Kayıtlar açıldı"},
                        {"text":"Hemen kayıt ol"}],
                    "descriptions":[{"text":"Yeni sezon başlıyor, yerini ayırt."},
                        {"text":"Kayıt birkaç dakika sürer."}]}}}})])),
    );
    let adopted = r
        .google
        .create_ad(&cred(), &public(), &ad_spec())
        .await
        .unwrap();
    assert_eq!(adopted, AD);
    assert!(r.mock.requests("POST", MUTATE).is_empty());
}

#[tokio::test]
async fn each_object_is_switched_by_its_own_operation() {
    let r = rig().await;
    r.mock.on("POST", MUTATE, ok(mutated(&[])));
    for (id, operation, status, word) in [
        (AD, "adGroupAdOperation", AdStatus::Active, "ENABLED"),
        (AD_GROUP, "adGroupOperation", AdStatus::Active, "ENABLED"),
        (CAMPAIGN, "campaignOperation", AdStatus::Paused, "PAUSED"),
    ] {
        r.mock.clear();
        r.google.set_status(&cred(), id, status).await.unwrap();
        assert_eq!(
            r.mock.request("POST", MUTATE).json(),
            json!({"mutateOperations":[{operation:{
                "update":{"resourceName":id,"status":word},"updateMask":"status"}}]})
        );
    }
    // An id of any other shape changes nothing and reaches nobody.
    r.mock.clear();
    for id in [
        "111",
        "customers/1234567890/campaignBudgets/77",
        "customers/1234567890/campaigns/111/x",
    ] {
        assert_eq!(
            kind_of(r.google.set_status(&cred(), id, AdStatus::Paused).await),
            "permanent"
        );
    }
    assert!(r.mock.lines().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Reading a built campaign back
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_state_is_the_campaigns_switch_and_googles_review_of_each_ad() {
    let r = rig().await;
    r.mock.on_search(
        "SELECT campaign.resource_name, campaign.status",
        ok(rows(vec![
            json!({"campaign":{"resourceName":CAMPAIGN,"status":"ENABLED"}}),
        ])),
    );
    let other = "customers/1234567890/adGroupAds/222~334";
    r.mock.on_search(
        "policy_summary",
        ok(rows(vec![
            json!({"adGroupAd":{"resourceName":AD,"status":"ENABLED","policySummary":{
                "approvalStatus":"APPROVED","reviewStatus":"REVIEWED"}}}),
            json!({"adGroupAd":{"resourceName":other,"status":"ENABLED","policySummary":{
                "approvalStatus":"DISAPPROVED","reviewStatus":"REVIEWED",
                "policyTopicEntries":[{"topic":"TRADEMARKS_IN_AD_TEXT","type":"PROHIBITED"}]}}}),
        ])),
    );
    let state = r
        .google
        .campaign_state(&cred(), &public(), CAMPAIGN)
        .await
        .unwrap();
    assert_eq!(state.campaign, ProviderAdStatus::Active);
    assert_eq!(state.ads.len(), 2);
    assert_eq!(state.ads[0].ad_id, AD);
    assert_eq!(state.ads[0].status, ProviderAdStatus::Active);
    assert_eq!(state.ads[0].feedback, None);
    assert_eq!(state.ads[1].ad_id, other);
    assert_eq!(state.ads[1].status, ProviderAdStatus::Disapproved);
    assert_eq!(
        state.ads[1].feedback.as_deref(),
        Some("TRADEMARKS_IN_AD_TEXT (PROHIBITED)")
    );
    // A campaign of another account is refused before anything is read.
    r.mock.clear();
    let foreign = r
        .google
        .campaign_state(&cred(), &public(), "customers/999/campaigns/111")
        .await;
    assert_eq!(kind_of(foreign), "permanent");
    assert!(r.mock.lines().is_empty());
}

#[tokio::test]
async fn daily_numbers_are_googles_days_in_the_currencys_minor_units() {
    let r = rig().await;
    r.mock.on_search(
        "segments.date",
        ok(rows(vec![
            json!({"customer":{"currencyCode":"TRY"},"adGroupAd":{"resourceName":AD},
                "segments":{"date":"2026-11-12"},
                "metrics":{"impressions":"1200","clicks":"34","costMicros":"12345678"}}),
            // A day with nothing counted yet: absent, never zero.
            json!({"customer":{"currencyCode":"TRY"},"adGroupAd":{"resourceName":AD},
                "segments":{"date":"2026-11-13"},"metrics":{}}),
        ])),
    );
    let days = r
        .google
        .ad_days(
            &cred(),
            &public(),
            CAMPAIGN,
            AdObjective::Traffic,
            date!(2026 - 11 - 12),
            date!(2026 - 11 - 13),
        )
        .await
        .unwrap();
    assert_eq!(days.len(), 2);
    assert_eq!(days[0].ad_id, AD);
    assert_eq!(days[0].day, date!(2026 - 11 - 12));
    // 12,345678 TRY is 1 235 kuruş to the nearest.
    assert_eq!(days[0].spend_minor, Some(1_235));
    assert_eq!(days[0].impressions, Some(1_200));
    assert_eq!(days[0].clicks, Some(34));
    assert_eq!(days[0].results, Some(34), "a visit is a click on the ad");
    assert_eq!(
        (
            days[1].spend_minor,
            days[1].impressions,
            days[1].clicks,
            days[1].results
        ),
        (None, None, None, None)
    );
    // One day more on each side: the account's day is not UTC's.
    assert_eq!(
        r.mock.request("POST", SEARCH).query(),
        format!(
            "SELECT customer.currency_code, ad_group_ad.resource_name, segments.date, \
             metrics.impressions, metrics.clicks, metrics.cost_micros FROM ad_group_ad WHERE \
             campaign.resource_name = '{CAMPAIGN}' AND segments.date BETWEEN '2026-11-11' AND \
             '2026-11-14'"
        )
    );
    // A number that is not one is refused, not read as nothing.
    let r = rig().await;
    r.mock.on_search(
        "segments.date",
        ok(rows(vec![json!({"customer":{"currencyCode":"TRY"},
            "adGroupAd":{"resourceName":AD},"segments":{"date":"2026-11-12"},
            "metrics":{"clicks":"many"}})])),
    );
    let odd = r
        .google
        .ad_days(
            &cred(),
            &public(),
            CAMPAIGN,
            AdObjective::Traffic,
            date!(2026 - 11 - 12),
            date!(2026 - 11 - 12),
        )
        .await;
    assert_eq!(kind_of(odd), "permanent");
}

// ---------------------------------------------------------------------------------------------
// Pages, waits and retries
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_search_follows_its_pages_and_stops_at_a_bound() {
    let r = rig().await;
    r.mock.on_search(
        "FROM campaign",
        ok(json!({"results":[{"campaign":{"resourceName":CAMPAIGN}}],"nextPageToken":"p2"})),
    );
    r.mock.on_search(
        "FROM campaign",
        ok(json!({"results":[{"campaign":{"resourceName":"customers/1234567890/campaigns/112"}}]})),
    );
    // Two campaigns of one name, over two pages: both are seen.
    let twice = r
        .google
        .find_by_name(&cred(), &public(), AdLevel::Campaign, "jeeta:x:campaign")
        .await;
    assert_eq!(kind_of(twice), "permanent");
    let sent = r.mock.requests("POST", SEARCH);
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0].json().get("pageToken"), None);
    assert_eq!(sent[1].json()["pageToken"], "p2");
    // An answer that never ends is not read forever, nor cut short as if it were whole.
    let r = rig().await;
    r.mock.on_search(
        "FROM campaign",
        ok(json!({"results":[],"nextPageToken":"again"})),
    );
    let endless = r
        .google
        .find_by_name(&cred(), &public(), AdLevel::Campaign, "jeeta:x:campaign")
        .await;
    assert_eq!(
        reason_of(endless),
        "Google's answer has more pages than are read"
    );
    assert_eq!(r.mock.requests("POST", SEARCH).len(), MAX_PAGES);
}

#[tokio::test]
async fn a_read_is_tried_once_more_and_a_write_never() {
    let slow = StdDuration::from_millis(400);
    let r = rig_with(TestApps::default(), StdDuration::from_millis(100)).await;
    r.mock.on_search(
        "FROM customer",
        ok(customer(CUSTOMER, "ENABLED", false)).delayed(slow),
    );
    let e = r.google.account_limits(&cred(), &public()).await;
    assert_eq!(kind_of(e), "transient");
    assert_eq!(
        r.mock.requests("POST", SEARCH).len(),
        READ_ATTEMPTS as usize
    );
    // A mutate that got no answer may have taken effect: it is not sent again, and it says so.
    let r = rig_with(TestApps::default(), StdDuration::from_millis(100)).await;
    r.mock.on("POST", MUTATE, ok(mutated(&[])).delayed(slow));
    let e = r
        .google
        .set_status(&cred(), CAMPAIGN, AdStatus::Paused)
        .await;
    assert_eq!(kind_of(e), "unknown");
    assert_eq!(r.mock.requests("POST", MUTATE).len(), 1);
}

#[tokio::test]
async fn googles_refusals_map_by_the_table_and_carry_no_secret() {
    for (reply, expected) in [
        (
            status(429, json!({})).with_header("retry-after", "30"),
            "throttle",
        ),
        (
            status(
                429,
                failure("quotaError", "RESOURCE_EXHAUSTED", "Too many requests."),
            ),
            "throttle",
        ),
        (
            status(
                401,
                json!({"error":{"code":401,"message":"Invalid credentials.","status":"UNAUTHENTICATED"}}),
            ),
            "auth",
        ),
        (
            status(
                403,
                failure(
                    "authorizationError",
                    "USER_PERMISSION_DENIED",
                    "The user has no access.",
                ),
            ),
            "permission",
        ),
        (
            status(
                500,
                failure("internalError", "INTERNAL_ERROR", "Something broke."),
            ),
            "transient",
        ),
        (raw(502, "<html>bad gateway</html>"), "transient"),
        (raw(200, "<html>not json</html>"), "permanent"),
        (
            status(
                400,
                failure("queryError", "UNRECOGNIZED_FIELD", "Unrecognized field."),
            ),
            "permanent",
        ),
    ] {
        let r = rig().await;
        r.mock.on_search("FROM customer", reply.clone());
        let e = r
            .google
            .account_limits(&cred(), &public())
            .await
            .unwrap_err();
        assert_eq!(e.kind(), expected, "{reply:?}");
        assert_no_secret(&format!("{e:?}"));
    }
    // A provider that echoes the token does not get it carried into the error.
    let r = rig().await;
    r.mock.on_search(
        "FROM customer",
        status(
            400,
            failure(
                "requestError",
                "UNKNOWN",
                &format!("Bad token {ACCESS_TOKEN} in request."),
            ),
        ),
    );
    let e = r
        .google
        .account_limits(&cred(), &public())
        .await
        .unwrap_err();
    assert_no_secret(&format!("{e:?}"));
    assert!(e.reason().unwrap().contains("requestError.UNKNOWN"));
}
