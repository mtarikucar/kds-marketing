//! The scripted campaign port must preserve FIFO answers and every call argument.
use jt_app::ports::connectors::*;
use jt_connector::{ConnectorError, Credential, Provider};
use jt_testkit::fakes::{ConnectorCall, ScriptedConnector, ScriptedRegistry};
use serde_json::json;
use std::sync::Arc;
use time::macros::{date, datetime};

#[tokio::test]
async fn every_campaign_operation_records_arguments_and_consumes_its_own_queue() {
    let fake = Arc::new(ScriptedConnector::new(Provider::Meta));
    let registry = ScriptedRegistry::new().with_connector(fake.clone());
    let writer = registry.ad_campaigns(Provider::Meta).unwrap();
    let credential = Credential::OAuth {
        access_token: "synthetic-token".into(),
        refresh_token: None,
        expires_at: None,
        scopes: vec![],
    };
    let public = json!({"external_id":"account1"});
    let campaign = CampaignSpec {
        name: "campaign".into(),
        objective: AdObjective::Leads,
        lifetime_budget_minor: 10000,
    };
    let adset = AdSetSpec {
        name: "set".into(),
        campaign_id: "c1".into(),
        goal: AdSetGoal::Leads {
            page_id: "page1".into(),
        },
        audience: AdAudience {
            countries: vec!["TR".into()],
            regions: vec![],
            cities: vec![],
            age_min: 18,
            age_max: 65,
            genders: vec![],
            interests: vec![],
            broad: true,
        },
        placements: AdPlacements::Automatic,
        start_at: datetime!(2026-11-11 0:00 UTC),
        end_at: datetime!(2026-11-12 0:00 UTC),
    };
    let form = LeadFormSpec {
        name: "form".into(),
        questions: vec![LeadQuestion::Email],
        privacy_policy_url: Url::parse("https://example.test/privacy").unwrap(),
        thank_you_url: Url::parse("https://example.test/thanks").unwrap(),
        locale: "tr_TR".into(),
    };
    let creative = CreativeSpec {
        name: "creative".into(),
        page_id: "page1".into(),
        instagram_user_id: None,
        image_hash: "hash1".into(),
        primary_text: "synthetic".into(),
        headline: "headline".into(),
        description: None,
        call_to_action: CallToAction::SignUp,
        action: CreativeAction::LeadForm {
            form_id: "form1".into(),
            url: Url::parse("https://example.test/").unwrap(),
        },
    };
    let ad = AdSpec {
        name: "ad".into(),
        adset_id: "s1".into(),
        creative_id: "creative1".into(),
    };
    let limits = AdAccountLimits {
        currency: "TRY".into(),
        minor_unit_exponent: 2,
        timezone: "Europe/Istanbul".into(),
        min_daily_budget_minor: 100,
    };
    let state = CampaignProviderState {
        campaign: ProviderAdStatus::Paused,
        ads: vec![],
    };
    let days = vec![AdDay {
        ad_id: "a1".into(),
        day: date!(2026 - 11 - 11),
        spend_minor: None,
        impressions: Some(0),
        clicks: None,
        results: None,
    }];
    fake.push_account_limits(Ok(limits.clone()));
    fake.push_account_limits(Err(ConnectorError::permanent("limits refusal")));
    fake.push_find_by_name(Ok(Some("c1".into())));
    fake.push_find_by_name(Ok(None));
    fake.push_create_campaign(Ok("c1".into()));
    fake.push_create_campaign(Err(ConnectorError::permanent("campaign refusal")));
    fake.push_create_adset(Ok("s1".into()));
    fake.push_upload_image(Ok("hash1".into()));
    fake.push_create_lead_form(Ok("form1".into()));
    fake.push_create_creative(Ok("creative1".into()));
    fake.push_create_ad(Ok("a1".into()));
    fake.push_campaign_state(Ok(state.clone()));
    fake.push_ad_days(Ok(days.clone()));
    fake.push_preview(Ok("<iframe/>".into()));
    assert_eq!(
        writer.account_limits(&credential, &public).await.unwrap(),
        limits
    );
    assert_eq!(
        writer
            .find_by_name(&credential, &public, AdLevel::Campaign, "campaign")
            .await
            .unwrap(),
        Some("c1".into())
    );
    assert_eq!(
        writer
            .create_campaign(&credential, &public, &campaign)
            .await
            .unwrap(),
        "c1"
    );
    assert_eq!(
        writer
            .create_adset(&credential, &public, &adset)
            .await
            .unwrap(),
        "s1"
    );
    assert_eq!(
        writer
            .upload_image(&credential, &public, &[1, 2, 3], "test.png")
            .await
            .unwrap(),
        "hash1"
    );
    assert_eq!(
        writer
            .create_lead_form(&credential, &public, &form)
            .await
            .unwrap(),
        "form1"
    );
    assert_eq!(
        writer
            .create_creative(&credential, &public, &creative)
            .await
            .unwrap(),
        "creative1"
    );
    assert_eq!(
        writer.create_ad(&credential, &public, &ad).await.unwrap(),
        "a1"
    );
    assert_eq!(
        writer
            .campaign_state(&credential, &public, "c1")
            .await
            .unwrap(),
        state
    );
    assert_eq!(
        writer
            .ad_days(
                &credential,
                &public,
                "c1",
                AdObjective::Traffic,
                date!(2026 - 11 - 11),
                date!(2026 - 11 - 12)
            )
            .await
            .unwrap(),
        days
    );
    assert_eq!(
        writer
            .preview(&credential, &public, &creative, AdPlacement::InstagramStory)
            .await
            .unwrap(),
        "<iframe/>"
    );
    assert_eq!(
        fake.calls(),
        vec![
            ConnectorCall::AccountLimits {
                credential: credential.clone(),
                public: public.clone()
            },
            ConnectorCall::FindByName {
                credential: credential.clone(),
                public: public.clone(),
                level: AdLevel::Campaign,
                name: "campaign".into()
            },
            ConnectorCall::CreateCampaign {
                credential: credential.clone(),
                public: public.clone(),
                spec: campaign.clone()
            },
            ConnectorCall::CreateAdset {
                credential: credential.clone(),
                public: public.clone(),
                spec: adset
            },
            ConnectorCall::UploadImage {
                credential: credential.clone(),
                public: public.clone(),
                bytes: vec![1, 2, 3],
                name: "test.png".into()
            },
            ConnectorCall::CreateLeadForm {
                credential: credential.clone(),
                public: public.clone(),
                spec: form
            },
            ConnectorCall::CreateCreative {
                credential: credential.clone(),
                public: public.clone(),
                spec: creative.clone()
            },
            ConnectorCall::CreateAd {
                credential: credential.clone(),
                public: public.clone(),
                spec: ad
            },
            ConnectorCall::CampaignState {
                credential: credential.clone(),
                public: public.clone(),
                campaign_id: "c1".into()
            },
            ConnectorCall::AdDays {
                credential: credential.clone(),
                public: public.clone(),
                campaign_id: "c1".into(),
                objective: AdObjective::Traffic,
                since: date!(2026 - 11 - 11),
                until: date!(2026 - 11 - 12)
            },
            ConnectorCall::Preview {
                credential: credential.clone(),
                public: public.clone(),
                creative,
                placement: AdPlacement::InstagramStory
            },
        ]
    );
    assert_eq!(
        writer
            .account_limits(&credential, &public)
            .await
            .unwrap_err()
            .reason(),
        Some("limits refusal")
    );
    assert_eq!(
        writer
            .find_by_name(&credential, &public, AdLevel::Ad, "absent")
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        writer
            .create_campaign(&credential, &public, &campaign)
            .await
            .unwrap_err()
            .reason(),
        Some("campaign refusal")
    );
}

#[test]
fn campaign_registry_is_meta_only_and_absent_without_an_adapter() {
    let mut registry = ScriptedRegistry::new();
    for provider in Provider::all() {
        assert!(registry.ad_campaigns(*provider).is_none());
        registry = registry.with_connector(Arc::new(ScriptedConnector::new(*provider)));
    }
    for provider in Provider::all() {
        assert_eq!(
            registry.ad_campaigns(*provider).is_some(),
            *provider == Provider::Meta
        );
    }
}

#[tokio::test]
#[should_panic(expected = "no create_campaign scripted")]
async fn missing_campaign_script_fails_loudly() {
    ScriptedConnector::new(Provider::Meta)
        .create_campaign(
            &Credential::OAuth {
                access_token: "synthetic".into(),
                refresh_token: None,
                expires_at: None,
                scopes: vec![],
            },
            &json!({}),
            &CampaignSpec {
                name: "test".into(),
                objective: AdObjective::Traffic,
                lifetime_budget_minor: 1,
            },
        )
        .await
        .unwrap();
}
