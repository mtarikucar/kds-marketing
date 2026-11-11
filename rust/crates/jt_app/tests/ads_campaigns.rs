//! Reklam yönetimi (design 2026-11-10 §8): from a goal and a budget to a running ad an agent
//! watches and improves, with money that never passes its limits. The plan's Review Focus:
//! a lost answer never builds twice (1), two plans make one build (2), two campaigns cannot
//! share one remainder (3), a stop half way activates nothing (4), a proposal expires (5), one
//! ad turned down is replaced alone (6).
#[path = "support/studio.rs"]
mod support;
use jt_app::{
    ctx::Ctx,
    error::ErrorCode,
    ports::{
        UnitOfWork,
        ads::*,
        connectors::{
            AdAccountLimits, AdDay, AdLevel, AdStatus, CallToAction, CampaignProviderState,
            ProviderAd, ProviderAdStatus,
        },
        files::StoredFile,
    },
    usecases::{
        ads::{self, watch::watch_all},
        budget, jobs, modules, spending,
        work::{self, WorkKind},
    },
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{ConnectorError, Credential, Provider};
use jt_ledger::Actor;
use jt_studio::*;
use jt_tenancy::{AgentConnectionId, WorkspaceStatus};
use jt_testkit::fakes::{
    ConnectorCall, FIXED_NOW, FixedClock, ScriptedConnector, ScriptedRegistry, files::MemoryFiles,
};
use serde_json::{Value, json};
use std::sync::Arc;
use support::*;
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

fn input<T: serde::de::DeserializeOwned>(v: Value) -> T {
    serde_json::from_value(v).unwrap()
}

fn agent(w: &World) -> Ctx {
    let Actor::Human { user_id } = w.ctx.actor else {
        panic!()
    };
    let connection_id = AgentConnectionId::new_v7();
    Ctx {
        actor: Actor::Agent {
            user_id,
            connection_id,
        },
        agent_connection_id: Some(connection_id),
        ..w.ctx.clone()
    }
}

fn at(time: OffsetDateTime) -> String {
    time.format(&Rfc3339).unwrap()
}

/// What an ads test stands on: the Studio world (its strategy caps the paid lane at 100.000 a
/// month), a general ad budget of the same, an ad account, a Facebook Page and one image.
struct Ads {
    w: World,
    account: CapabilityId,
    page: CapabilityId,
    image: MaterialId,
}

async fn connection(w: &World, kind: &str, external: &str, scopes: &[&str]) -> CapabilityId {
    let mut c = Capability::new(
        CapabilityId::new_v7(),
        w.f.ws,
        NewCapability {
            kind_key: kind.into(),
            name: external.into(),
            external_id: Some(external.into()),
            connector_public: json!({"access":{"scopes":scopes}}),
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    c.status = StoredStatus::Verified;
    c.last_verified_at = Some(FIXED_NOW);
    let cred = Credential::OAuth {
        access_token: "test".into(),
        refresh_token: None,
        expires_at: None,
        scopes: scopes.iter().map(|s| (*s).to_owned()).collect(),
    };
    let sealed =
        w.d.seal
            .seal(w.f.ws, &serde_json::to_vec(&cred).unwrap())
            .unwrap();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.capabilities()
        .insert(c.clone(), Some(sealed))
        .await
        .unwrap();
    r.commit().await.unwrap();
    c.id
}

async fn image(w: &World) -> MaterialId {
    image_of(w, b"\x89PNG\r\n\x1a\n", "image/png").await
}

/// A shareable image of the library that starts with `magic` and is of type `mime`.
async fn image_of(w: &World, magic: &[u8], mime: &str) -> MaterialId {
    let mut bytes = magic.to_vec();
    bytes.extend(Uuid::now_v7().as_bytes());
    let file: StoredFile =
        w.d.files
            .put(
                w.f.ws,
                FileId::new_v7(),
                MediaUpload {
                    bytes,
                    mime: mime.into(),
                    filename: "ad".into(),
                },
            )
            .await
            .unwrap();
    let olay = jt_testkit::studio_contract::confirmed_olay(w.f.ws);
    let mut m = jt_testkit::studio_contract::eligible_material(&olay, file.id);
    m.mime = mime.into();
    let mut r = w.uow.tenant(w.f.ws).await.unwrap();
    r.studio().save_file(file).await.unwrap();
    r.studio_materials().insert_olay(olay).await.unwrap();
    r.studio_materials()
        .insert_material(m.clone())
        .await
        .unwrap();
    r.commit().await.unwrap();
    m.id
}

async fn ads_world() -> Ads {
    let mut w = world().await;
    w.d.files = Arc::new(MemoryFiles::default());
    w.uow.edit(|s| s.materials = Default::default());
    budget::create_item(
        &w.d,
        &w.ctx,
        input(
            json!({"name":"Reklam","kind":"ad_budget","unit":{"kind":"currency","value":"TRY"},
            "cap":100_000,"period":"monthly","general":true}),
        ),
    )
    .await
    .unwrap();
    let account = connection(&w, "meta_ads", "act_9", &["ads_read", "ads_management"]).await;
    let page = connection(&w, "facebook_page", "page_9", &["pages_manage_posts"]).await;
    let image = image(&w).await;
    Ads {
        w,
        account,
        page,
        image,
    }
}

impl Ads {
    async fn open(
        &self,
        key: &str,
        budget_minor: i64,
    ) -> Result<AdCampaign, jt_app::error::AppError> {
        ads::campaign_open(
            &self.w.d,
            &self.w.ctx,
            input(
                json!({"request_key":key,"goal":"Yeni sezon kayıtlarını duyur",
                "budget_minor":budget_minor,"start_at":at(FIXED_NOW)}),
            ),
        )
        .await
    }

    fn ad(&self, name: &str) -> Value {
        json!({"name":name,"material_ids":[self.image],"primary_text":"Yeni sezon başlıyor",
            "headline":"Kayıtlar açık","description":null,"call_to_action":"LEARN_MORE",
            "page":self.page,"instagram":null,
            "hypothesis_id":self.w.f.slot.chain.hypothesis_id})
    }

    fn plan(&self, ads: Vec<Value>) -> Value {
        json!({"ad_account":self.account,"result":"link_click",
            "destination":{"kind":"website","url":"https://ornek.example/kayit"},
            "special_ad_categories":[],
            "audience":{"countries":["TR"],"age_min":18,"age_max":65,"broad":true},
            "placements":"automatic","end_at":at(FIXED_NOW + Duration::days(7)),
            "ads":ads,"summary":"Kayıt sayfasına trafik","audience_summary":"Türkiye, 18-65"})
    }

    /// Claims campaign `c` as `a` and delivers `plan`.
    async fn submit(
        &self,
        a: &Ctx,
        c: &AdCampaign,
        key: &str,
        plan: Value,
    ) -> Result<AdCampaign, jt_app::error::AppError> {
        let claim = ads::campaign_claim(
            &self.w.d,
            a,
            input(json!({"campaign_id":c.id,"expected_revision":c.revision})),
        )
        .await?;
        ads::plan_submit(
            &self.w.d,
            a,
            input(json!({"campaign_id":c.id,"claim_token":claim.claim_token,
                "request_key":key,"plan":plan})),
        )
        .await
    }

    fn limits(&self) {
        self.w.ads.push_account_limits(Ok(AdAccountLimits {
            currency: "TRY".into(),
            minor_unit_exponent: 2,
            timezone: "Europe/Istanbul".into(),
            min_daily_budget_minor: 100,
            min_total_budget_minor: 0,
        }));
    }

    /// Scripts a whole build of `n` ads that finds nothing at the provider, and its activation.
    fn build(&self, n: usize) {
        let x = &self.w.ads;
        x.push_find_by_name(Ok(None));
        x.push_create_campaign(Ok("cmp-1".into()));
        x.push_find_by_name(Ok(None));
        x.push_create_adset(Ok("set-1".into()));
        for i in 0..n {
            self.one_ad(i);
        }
        for _ in 0..n + 2 {
            x.push_set_status(Ok(()));
        }
    }

    fn one_ad(&self, i: usize) {
        let x = &self.w.ads;
        x.push_upload_image(Ok(format!("hash-{i}")));
        x.push_find_by_name(Ok(None));
        x.push_create_creative(Ok(format!("cr-{i}")));
        x.push_find_by_name(Ok(None));
        x.push_create_ad(Ok(format!("ad-{i}")));
    }

    async fn get(&self, id: Uuid) -> AdCampaign {
        ads::campaign_get(&self.w.d, &self.w.ctx, input(json!({"campaign_id":id})))
            .await
            .unwrap()
            .campaign
    }

    fn state(c: &AdCampaign) -> CampaignState {
        c.state.as_ref().unwrap().state
    }

    fn calls(&self, pick: impl Fn(&ConnectorCall) -> bool) -> usize {
        self.w.ads.calls().iter().filter(|c| pick(c)).count()
    }

    fn statuses(&self) -> Vec<(String, AdStatus)> {
        self.w
            .ads
            .calls()
            .into_iter()
            .filter_map(|c| match c {
                ConnectorCall::SetAdStatus {
                    entity_id, status, ..
                } => Some((entity_id, status)),
                _ => None,
            })
            .collect()
    }

    /// A campaign opened, planned with `n` ads, built and activated.
    async fn running(&self, key: &str, budget_minor: i64, n: usize) -> AdCampaign {
        let c = self.open(key, budget_minor).await.unwrap();
        self.limits();
        self.build(n);
        let ads = (0..n).map(|i| self.ad(&format!("Reklam {i}"))).collect();
        self.submit(&agent(&self.w), &c, &format!("{key}-plan"), self.plan(ads))
            .await
            .unwrap()
    }

    /// What the provider says of the campaign on the next read.
    fn provider(&self, ads: &[(&str, ProviderAdStatus, Option<&str>)], days: Vec<AdDay>) {
        self.w.ads.push_campaign_state(Ok(CampaignProviderState {
            campaign: ProviderAdStatus::Active,
            ads: ads
                .iter()
                .map(|(id, status, feedback)| ProviderAd {
                    ad_id: (*id).into(),
                    name: (*id).into(),
                    status: status.clone(),
                    feedback: feedback.map(str::to_owned),
                })
                .collect(),
        }));
        self.w.ads.push_ad_days(Ok(days));
    }
}

fn day(ad: &str, offset: i64, spend: i64, results: Option<i64>) -> AdDay {
    AdDay {
        ad_id: ad.into(),
        day: (FIXED_NOW + Duration::days(offset)).date(),
        spend_minor: Some(spend),
        impressions: Some(spend * 10),
        clicks: None,
        results,
    }
}

#[tokio::test]
async fn a_person_opens_a_campaign_and_two_cannot_share_one_remainder() {
    let t = ads_world().await;
    let a = agent(&t.w);
    // An agent does not open one; nor is a budget of nothing a budget.
    let e = ads::campaign_open(
        &t.w.d,
        &a,
        input(json!({"request_key":"k","goal":"g","budget_minor":10,"start_at":at(FIXED_NOW)})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden, "{e:?}");
    let e = t.open("zero", 0).await.unwrap_err();
    assert_eq!(e.details["field"], "budget_minor");

    let first = t.open("first", 60_000).await.unwrap();
    assert_eq!(Ads::state(&first), CampaignState::Queued);
    assert_eq!(first.currency, "TRY");
    assert_eq!(first.title, "Yeni sezon kayıtlarını duyur");
    assert!(matches!(first.opened_by, CampaignOpenedBy::Human { .. }));
    // The same request is the same campaign.
    assert_eq!(t.open("first", 60_000).await.unwrap().id, first.id);
    // Review Focus 3: 100.000 in the general budget, 60.000 held: a second 60.000 is refused
    // with what is left, and what is left is taken.
    let e = t.open("second", 60_000).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(e.details["reason"], "above_general_budget");
    assert_eq!(e.details["left"], 40_000);
    let second = t.open("second-smaller", 40_000).await.unwrap();
    let e = t.open("third", 1).await.unwrap_err();
    assert_eq!(e.details["left"], 0);
    // The budget's own page says what the campaigns hold of the general ad budget: nothing is
    // spent yet, and none of it is free.
    let held = |b: spending::Breakdown| b.items.iter().map(|i| i.held_minor).sum::<i64>();
    let breakdown = spending::breakdown(&t.w.d, &t.w.ctx, input(json!({})))
        .await
        .unwrap();
    assert_eq!(held(breakdown), 100_000);

    // Both wait for an agent's plan; ending one frees what it held.
    let listed = ads::campaigns_list(&t.w.d, &a, input(json!({})))
        .await
        .unwrap();
    assert_eq!(
        listed
            .campaigns
            .iter()
            .map(|c| c.id)
            .collect::<Vec<_>>()
            .len(),
        2
    );
    let items = work::pending(&t.w.d, &a).await.unwrap().items;
    let plans: Vec<_> = items
        .iter()
        .filter(|i| matches!(i.kind, WorkKind::AdsCampaignPlan { .. }))
        .collect();
    assert_eq!(plans.len(), 2);
    assert!(plans[0].hint.contains("jeeta.ads.plan_submit"));
    ads::campaign_end(
        &t.w.d,
        &t.w.ctx,
        input(json!({"campaign_id":second.id,"expected_revision":second.revision})),
    )
    .await
    .unwrap();
    let breakdown = spending::breakdown(&t.w.d, &t.w.ctx, input(json!({})))
        .await
        .unwrap();
    assert_eq!(held(breakdown), 60_000, "an ended campaign holds nothing");
    t.open("after-end", 40_000).await.unwrap();
    let closed = ads::campaigns_list(&t.w.d, &a, input(json!({"scope":"closed"})))
        .await
        .unwrap();
    assert_eq!(closed.campaigns.len(), 1);
    assert_eq!(Ads::state(&closed.campaigns[0]), CampaignState::Ended);

    // Without a general ad budget nothing is opened.
    let bare = world().await;
    let e = ads::campaign_open(
        &bare.d,
        &bare.ctx,
        input(json!({"request_key":"k","goal":"g","budget_minor":10,"start_at":at(FIXED_NOW)})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "no_general_ad_budget");
}

#[tokio::test]
async fn a_proposal_spends_nothing_until_a_person_approves_it_and_runs_out() {
    let t = ads_world().await;
    let a = agent(&t.w);
    let propose = |key: &str| {
        json!({"request_key":key,"goal":"Atölye için kayıt topla","budget_minor":90_000,
            "start_at":at(FIXED_NOW),"reason":"Geçen ayın gönderileri ilgi gördü"})
    };
    // A person does not propose; an agent does, once a week.
    let e = ads::campaign_propose(&t.w.d, &t.w.ctx, input(propose("p")))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden, "{e:?}");
    let p = ads::campaign_propose(&t.w.d, &a, input(propose("p")))
        .await
        .unwrap();
    assert_eq!(Ads::state(&p), CampaignState::Proposed);
    assert_eq!(
        p.reason.as_deref(),
        Some("Geçen ayın gönderileri ilgi gördü")
    );
    let e = ads::campaign_propose(&t.w.d, &a, input(propose("p2")))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "proposal_limit");
    // It holds no money and asks no agent for a plan: a person decides first.
    t.open("meanwhile", 100_000).await.unwrap();
    assert!(
        work::pending(&t.w.d, &t.w.ctx)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::AdsCampaignProposal { campaign_id } if campaign_id == p.id))
    );
    let decide = json!({"campaign_id":p.id,"expected_revision":p.revision});
    // Approving it is a person's, and needs the money to be there.
    let e = ads::campaign_approve(&t.w.d, &a, input(decide.clone()))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden, "{e:?}");
    let e = ads::campaign_approve(&t.w.d, &t.w.ctx, input(decide.clone()))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "above_general_budget");

    // Review Focus 5: on its eighth day it is over, and cannot be approved.
    let later = Ctx {
        now: FIXED_NOW + Duration::days(7) + Duration::minutes(1),
        ..t.w.ctx.clone()
    };
    let e = ads::campaign_approve(&t.w.d, &later, input(decide.clone()))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "proposal_expired");
    assert_eq!(watch_all(&t.w.d, t.w.f.ws, later.now).await.unwrap(), 1);
    let closed = ads::campaigns_list(&t.w.d, &later, input(json!({"scope":"closed"})))
        .await
        .unwrap();
    assert_eq!(Ads::state(&closed.campaigns[0]), CampaignState::Expired);

    // A new proposal, declined with why; and one approved, which then waits for a plan.
    let agent_later = Ctx {
        now: later.now,
        ..a.clone()
    };
    let p = ads::campaign_propose(&t.w.d, &agent_later, input(propose("p3")))
        .await
        .unwrap();
    let e = ads::campaign_decline(
        &t.w.d,
        &later,
        input(json!({"campaign_id":p.id,"expected_revision":p.revision})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["field"], "reason");
    let declined = ads::campaign_decline(
        &t.w.d,
        &later,
        input(json!({"campaign_id":p.id,"expected_revision":p.revision,"reason":"Bu ay değil"})),
    )
    .await
    .unwrap();
    assert_eq!(Ads::state(&declined), CampaignState::Declined);
}

#[tokio::test]
async fn a_plan_is_checked_whole_and_the_campaign_is_built_once_paused_then_activated() {
    let t = ads_world().await;
    let a = agent(&t.w);
    let c = t.open("launch", 50_000).await.unwrap();

    // A malformed plan is the caller's mistake: it names its field and counts for nothing.
    let claim = ads::campaign_claim(
        &t.w.d,
        &a,
        input(json!({"campaign_id":c.id,"expected_revision":c.revision})),
    )
    .await
    .unwrap();
    assert_eq!(Ads::state(&claim.campaign), CampaignState::Planning);
    let submit = |key: &str, plan: Value| json!({"campaign_id":c.id,"claim_token":claim.claim_token,"request_key":key,"plan":plan});
    let mut seven = t.plan(vec![t.ad("a")]);
    seven["ads"] = json!((0..7).map(|i| t.ad(&format!("a{i}"))).collect::<Vec<_>>());
    let e = ads::plan_submit(&t.w.d, &a, input(submit("seven", seven)))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_eq!(e.details["field"], "ads");
    // A plan that breaks rules is refused with every finding, and counted.
    let mut bad = t.plan(vec![t.ad("a")]);
    bad["special_ad_categories"] = json!(["HOUSING"]);
    bad["audience"]["countries"] = json!(["TR", "DE"]);
    bad["ads"][0]["page"] = json!(t.account);
    t.limits();
    let e = ads::plan_submit(&t.w.d, &a, input(submit("bad", bad)))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(e.details["reason"], "plan_refused");
    let reasons: Vec<&str> = e.details["findings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["reason"].as_str().unwrap())
        .collect();
    assert_eq!(
        reasons,
        [
            "special_category_not_supported",
            "eu_targeting_needs_payer",
            "not_a_live_facebook_page"
        ]
    );
    assert_eq!(t.get(c.id).await.refused, 1);
    assert!(t.calls(|c| matches!(c, ConnectorCall::CreateCampaign { .. })) == 0);

    // The plan that holds: built at the provider by Jeeta, every object paused, then activated.
    t.limits();
    t.build(2);
    let built = ads::plan_submit(
        &t.w.d,
        &a,
        input(submit("good", t.plan(vec![t.ad("Bir"), t.ad("İki")]))),
    )
    .await
    .unwrap();
    assert_eq!(Ads::state(&built), CampaignState::InReview);
    assert_eq!(built.refused, 0);
    let b = built.built.as_ref().unwrap();
    assert_eq!(b.campaign_id.as_deref(), Some("cmp-1"));
    assert_eq!(b.adset_id.as_deref(), Some("set-1"));
    assert_eq!(
        b.ads
            .iter()
            .map(|x| x.ad_id.clone().unwrap())
            .collect::<Vec<_>>(),
        ["ad-0", "ad-1"]
    );
    assert!(b.activated_at.is_some());
    let calls = t.w.ads.calls();
    // The campaign carries its budget as the provider's own total, under a name of ours.
    let campaign = calls
        .iter()
        .find_map(|c| match c {
            ConnectorCall::CreateCampaign { spec, .. } => Some(spec.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(campaign.lifetime_budget_minor, 50_000);
    assert_eq!(campaign.name, format!("jeeta:{}:campaign", c.id));
    let looked: Vec<_> = calls
        .iter()
        .filter_map(|c| match c {
            ConnectorCall::FindByName { level, .. } => Some(*level),
            _ => None,
        })
        .collect();
    assert_eq!(
        looked,
        [
            AdLevel::Campaign,
            AdLevel::AdSet,
            AdLevel::Creative,
            AdLevel::Ad,
            AdLevel::Creative,
            AdLevel::Ad
        ],
        "everything is looked for by its name before it is created"
    );
    // Activated last, and only once everything exists: the ads, the ad set, the campaign.
    assert_eq!(
        t.statuses(),
        [
            ("ad-0".to_owned(), AdStatus::Active),
            ("ad-1".to_owned(), AdStatus::Active),
            ("set-1".to_owned(), AdStatus::Active),
            ("cmp-1".to_owned(), AdStatus::Active)
        ]
    );
    // Review Focus 2: the plan is the campaign's; a second one makes no second build.
    let e = ads::plan_submit(&t.w.d, &a, input(submit("again", t.plan(vec![t.ad("x")]))))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict, "{e:?}");
    assert_eq!(
        t.calls(|c| matches!(c, ConnectorCall::CreateCampaign { .. })),
        1
    );
    // The same delivery again is the same campaign.
    let again = ads::plan_submit(
        &t.w.d,
        &a,
        input(submit("good", t.plan(vec![t.ad("Bir"), t.ad("İki")]))),
    )
    .await
    .unwrap();
    assert_eq!(again.id, c.id);

    // An hour later the provider is read: both ads run; what they spent and brought is kept,
    // a number the provider does not give stays absent, and the spend is in Bütçe by campaign.
    let later = FIXED_NOW + Duration::hours(2);
    t.provider(
        &[
            ("ad-0", ProviderAdStatus::Active, None),
            ("ad-1", ProviderAdStatus::Active, None),
        ],
        vec![day("ad-0", 0, 1_200, Some(3)), day("ad-1", 0, 800, None)],
    );
    assert_eq!(watch_all(&t.w.d, t.w.f.ws, later).await.unwrap(), 1);
    let ctx = Ctx {
        now: later,
        ..t.w.ctx.clone()
    };
    let detail = ads::campaign_get(&t.w.d, &ctx, input(json!({"campaign_id":c.id})))
        .await
        .unwrap();
    assert_eq!(Ads::state(&detail.campaign), CampaignState::Live);
    assert_eq!(
        serde_json::to_value(detail.campaign.totals.as_ref().unwrap()).unwrap(),
        json!({"spent_minor":2_000,"results":3,"result_kind":"link_click",
               "impressions":20_000,"clicks":null})
    );
    assert_eq!(detail.days.len(), 2);
    assert_eq!(detail.materials.len(), 1);
    let breakdown = spending::breakdown(&t.w.d, &ctx, Default::default())
        .await
        .unwrap();
    let ads_spend = &breakdown.items[0].modules[0];
    assert_eq!(
        (ads_spend.module.as_str(), ads_spend.spent_minor),
        ("ads", 2_000)
    );
    assert_eq!(ads_spend.campaigns[0].campaign_id, c.id);
    assert_eq!(ads_spend.campaigns[0].title, "Yeni sezon kayıtlarını duyur");
    // The same reading again adds no spend; and within the hour the provider is not asked.
    assert_eq!(
        watch_all(&t.w.d, t.w.f.ws, later + Duration::minutes(5))
            .await
            .unwrap(),
        0
    );
    // A running campaign nobody looked at today is the agent's daily look.
    let agent_later = Ctx {
        now: later,
        ..a.clone()
    };
    assert!(
        work::pending(&t.w.d, &agent_later)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::AdsCampaignReview { campaign_id } if campaign_id == c.id))
    );
    // The provider's own preview of a built ad.
    t.w.ads.push_preview(Ok("<iframe></iframe>".into()));
    let preview = ads::ad_preview(
        &t.w.d,
        &a,
        input(json!({"campaign_id":c.id,"index":1,"placement":"instagram_feed"})),
    )
    .await
    .unwrap();
    assert_eq!(preview.html, "<iframe></iframe>");
    // What is built keeps its budget and its end: those are not changed afterwards.
    let now = t.get(c.id).await;
    let e = ads::campaign_update(
        &t.w.d,
        &t.w.ctx,
        input(json!({"campaign_id":c.id,"expected_revision":now.revision,"budget_minor":60_000})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "already_built");
}

/// Review Focus 1: the answer to "create campaign" is lost; the next run finds the campaign by
/// its name and goes on. The provider holds one campaign.
#[tokio::test]
async fn a_lost_answer_never_builds_twice_and_a_refusal_for_good_holds_the_campaign() {
    let t = ads_world().await;
    let c = t.open("lost", 50_000).await.unwrap();
    t.limits();
    t.w.ads.push_find_by_name(Ok(None));
    t.w.ads
        .push_create_campaign(Err(ConnectorError::unknown("connection reset")));
    let planned = t
        .submit(&agent(&t.w), &c, "lost-plan", t.plan(vec![t.ad("Bir")]))
        .await
        .unwrap();
    assert_eq!(Ads::state(&planned), CampaignState::Building);
    assert_eq!(planned.built.as_ref().unwrap().campaign_id, None);
    // The campaign is there under our name: adopted, and the build goes on to the end.
    t.w.ads.push_find_by_name(Ok(Some("cmp-1".into())));
    t.w.ads.push_find_by_name(Ok(None));
    t.w.ads.push_create_adset(Ok("set-1".into()));
    t.one_ad(0);
    for _ in 0..3 {
        t.w.ads.push_set_status(Ok(()));
    }
    watch_all(&t.w.d, t.w.f.ws, FIXED_NOW).await.unwrap();
    let built = t.get(c.id).await;
    assert_eq!(Ads::state(&built), CampaignState::InReview);
    assert_eq!(
        built.built.as_ref().unwrap().campaign_id.as_deref(),
        Some("cmp-1")
    );
    assert_eq!(
        t.calls(|c| matches!(c, ConnectorCall::CreateCampaign { .. })),
        1
    );

    // A step the provider refuses for good ends the build with what it said: the campaign waits
    // for a person, and nothing is activated.
    let t = ads_world().await;
    let c = t.open("refused", 50_000).await.unwrap();
    t.limits();
    t.w.ads.push_find_by_name(Ok(None));
    t.w.ads.push_create_campaign(Ok("cmp-1".into()));
    t.w.ads.push_find_by_name(Ok(None));
    t.w.ads
        .push_create_adset(Err(ConnectorError::permanent("the audience is too narrow")));
    let held = t
        .submit(&agent(&t.w), &c, "refused-plan", t.plan(vec![t.ad("Bir")]))
        .await
        .unwrap();
    assert_eq!(Ads::state(&held), CampaignState::Held);
    assert!(
        held.state
            .as_ref()
            .unwrap()
            .note
            .as_deref()
            .is_some_and(|n| n.starts_with("ad set: ")),
        "{:?}",
        held.state
    );
    assert!(t.statuses().is_empty());
    assert!(
        work::pending(&t.w.d, &t.w.ctx)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::AdsCampaignHeld { campaign_id } if campaign_id == c.id))
    );
}

/// Review Focus 4: a stop in Bütçe while the build is half way: nothing is activated; let go
/// on, the build continues from where it was.
#[tokio::test]
async fn a_stop_half_way_activates_nothing_and_the_build_goes_on_when_it_is_lifted() {
    let t = ads_world().await;
    let c = t.open("half", 50_000).await.unwrap();
    t.limits();
    t.w.ads.push_find_by_name(Ok(None));
    t.w.ads.push_create_campaign(Ok("cmp-1".into()));
    t.w.ads.push_find_by_name(Ok(None));
    t.w.ads.push_create_adset(Ok("set-1".into()));
    t.w.ads
        .push_upload_image(Err(ConnectorError::transient("timeout")));
    let half = t
        .submit(&agent(&t.w), &c, "half-plan", t.plan(vec![t.ad("Bir")]))
        .await
        .unwrap();
    assert_eq!(Ads::state(&half), CampaignState::Building);
    assert_eq!(
        half.built.as_ref().unwrap().adset_id.as_deref(),
        Some("set-1")
    );

    let stop = spending::breakdown(&t.w.d, &t.w.ctx, Default::default())
        .await
        .unwrap()
        .stop;
    let stopped = spending::stop(
        &t.w.d,
        &t.w.ctx,
        input(json!({"scope":{"module":"ads"},"stopped":true,"expected_revision":stop.revision})),
    )
    .await
    .unwrap();
    assert_eq!(stopped.modules, ["ads"]);
    // Stopped: the campaign is paused by the budget, the build does not go on, nothing runs.
    watch_all(&t.w.d, t.w.f.ws, FIXED_NOW).await.unwrap();
    let paused = t.get(c.id).await;
    assert_eq!(Ads::state(&paused), CampaignState::Paused);
    assert_eq!(paused.stop.as_ref().unwrap().by, StopBy::Budget);
    assert!(t.statuses().is_empty());
    assert_eq!(
        t.calls(|c| matches!(c, ConnectorCall::UploadImage { .. })),
        1
    );
    // A person does not override the budget's stop on one campaign.
    let e = ads::campaign_resume(
        &t.w.d,
        &t.w.ctx,
        input(json!({"campaign_id":c.id,"expected_revision":paused.revision})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "stopped_by_budget");

    // Let go on in Bütçe: the build continues with the image and activates.
    t.one_ad(0);
    for _ in 0..3 {
        t.w.ads.push_set_status(Ok(()));
    }
    spending::stop(
        &t.w.d,
        &t.w.ctx,
        input(
            json!({"scope":{"module":"ads"},"stopped":false,"expected_revision":stopped.revision}),
        ),
    )
    .await
    .unwrap();
    let live = t.get(c.id).await;
    assert_eq!(Ads::state(&live), CampaignState::InReview);
    assert!(live.stop.is_none());
    assert_eq!(
        t.calls(|c| matches!(c, ConnectorCall::CreateCampaign { .. })),
        1
    );
    assert_eq!(
        t.calls(|c| matches!(c, ConnectorCall::CreateAdset { .. })),
        1
    );
    assert_eq!(t.statuses().len(), 3);
}

/// Review Focus 6: the provider turns one of three ads down. The campaign is the agent's to
/// fix; the other two keep running; the fix replaces only that ad.
#[tokio::test]
async fn an_ad_the_provider_turns_down_is_replaced_alone_and_moves_are_kept_with_their_reasons() {
    let t = ads_world().await;
    let a = agent(&t.w);
    let c = t.running("three", 50_000, 3).await;
    let later = FIXED_NOW + Duration::hours(2);
    t.provider(
        &[
            ("ad-0", ProviderAdStatus::Active, None),
            (
                "ad-1",
                ProviderAdStatus::Disapproved,
                Some("The image contains too much text"),
            ),
            ("ad-2", ProviderAdStatus::Active, None),
        ],
        vec![],
    );
    watch_all(&t.w.d, t.w.f.ws, later).await.unwrap();
    let ctx = Ctx {
        now: later,
        ..t.w.ctx.clone()
    };
    let agent_later = Ctx {
        now: later,
        ..a.clone()
    };
    let rejected = ads::campaign_get(&t.w.d, &ctx, input(json!({"campaign_id":c.id})))
        .await
        .unwrap()
        .campaign;
    assert_eq!(Ads::state(&rejected), CampaignState::Rejected);
    let item = work::pending(&t.w.d, &agent_later)
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|i| matches!(i.kind, WorkKind::AdsCampaignPlan { .. }))
        .expect("the rejected campaign is the agent's work");
    assert!(
        matches!(&item.kind, WorkKind::AdsCampaignPlan { rejected: Some(why), .. }
        if why == "The image contains too much text")
    );
    let before = t.statuses().len();

    // The fix: the old ad is paused, a new creative and ad are built in its place and started.
    t.one_ad(1);
    t.w.ads.push_set_status(Ok(())); // the old ad, paused
    t.w.ads.push_set_status(Ok(())); // the new ad, started
    let fixed = ads::campaign_move(
        &t.w.d,
        &agent_later,
        input(json!({"campaign_id":c.id,"request_key":"fix-1",
            "move":{"kind":"fix_ad","ad":1,"with":t.ad("İki, yeniden"),
                    "reason":"Görseldeki yazıyı azalttım"}})),
    )
    .await
    .unwrap();
    let ads_now = &fixed.built.as_ref().unwrap().ads;
    assert_eq!(ads_now[1].generation, 1);
    assert_eq!(ads_now[1].replaced_ad_ids, ["ad-1"]);
    assert_eq!(ads_now[1].status, BuiltAdStatus::InReview);
    assert_eq!(
        (ads_now[0].ad_id.as_deref(), ads_now[2].ad_id.as_deref()),
        (Some("ad-0"), Some("ad-2"))
    );
    let after: Vec<_> = t.statuses().split_off(before);
    assert_eq!(
        after,
        [
            ("ad-1".to_owned(), AdStatus::Paused),
            ("ad-1".to_owned(), AdStatus::Active)
        ],
        "only the turned-down ad is touched (the scripted provider names the new ad ad-1 again)"
    );
    let names: Vec<String> =
        t.w.ads
            .calls()
            .into_iter()
            .filter_map(|c| match c {
                ConnectorCall::CreateAd { spec, .. } => Some(spec.name),
                _ => None,
            })
            .collect();
    assert_eq!(names.last().unwrap(), &format!("jeeta:{}:ad:1:1", c.id));
    assert_eq!(Ads::state(&fixed), CampaignState::InReview);

    // Other moves: pause and resume one ad, look and change nothing; each kept with its reason.
    t.w.ads.push_set_status(Ok(()));
    ads::campaign_move(
        &t.w.d,
        &agent_later,
        input(json!({"campaign_id":c.id,"request_key":"pause-0",
            "move":{"kind":"pause_ad","ad":0,"reason":"Tıklama getirmiyor"}})),
    )
    .await
    .unwrap();
    assert_eq!(
        t.statuses().last().unwrap(),
        &("ad-0".to_owned(), AdStatus::Paused)
    );
    let noted = ads::campaign_move(
        &t.w.d,
        &agent_later,
        input(json!({"campaign_id":c.id,"request_key":"none-1",
            "move":{"kind":"none","reason":"Yeterli veri yok"}})),
    )
    .await
    .unwrap();
    assert_eq!(
        noted
            .moves
            .iter()
            .map(|m| (m.kind, m.ad, m.outcome, m.reason.as_str()))
            .collect::<Vec<_>>(),
        [
            (
                MoveKind::FixAd,
                Some(1),
                MoveOutcome::Done,
                "Görseldeki yazıyı azalttım"
            ),
            (
                MoveKind::PauseAd,
                Some(0),
                MoveOutcome::Done,
                "Tıklama getirmiyor"
            ),
            (MoveKind::None, None, MoveOutcome::Done, "Yeterli veri yok"),
        ]
    );
    assert!(noted.built.as_ref().unwrap().ads[0].held);
    // The same move again changes nothing.
    let replay = ads::campaign_move(
        &t.w.d,
        &agent_later,
        input(json!({"campaign_id":c.id,"request_key":"none-1",
            "move":{"kind":"none","reason":"Yeterli veri yok"}})),
    )
    .await
    .unwrap();
    assert_eq!(replay.moves.len(), 3);
    // A new ad that does not hold is refused with its findings, and the refusal is kept.
    let mut wrong = t.ad("Yanlış");
    wrong["page"] = json!(t.account);
    let e = ads::campaign_move(
        &t.w.d,
        &agent_later,
        input(json!({"campaign_id":c.id,"request_key":"add-1",
            "move":{"kind":"add_ad","ad":wrong,"reason":"Bir seçenek daha"}})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "move_refused");
    let kept = ads::campaign_get(&t.w.d, &ctx, input(json!({"campaign_id":c.id})))
        .await
        .unwrap()
        .campaign;
    assert_eq!(kept.moves.last().unwrap().outcome, MoveOutcome::Refused);
    assert_eq!(kept.plan.as_ref().unwrap().ads.len(), 3);
    assert_eq!(
        e.details["findings"][0]["reason"],
        "not_a_live_facebook_page"
    );
}

#[tokio::test]
async fn a_campaign_is_stopped_let_go_on_and_ended_and_the_budget_ends_it_too() {
    let t = ads_world().await;
    let a = agent(&t.w);
    let c = t.running("run", 50_000, 1).await;
    let decide = |c: &AdCampaign, reason: Option<&str>| json!({"campaign_id":c.id,"expected_revision":c.revision,"reason":reason});
    // An agent may stop what runs, with why; the provider pauses it at once.
    let e = ads::campaign_pause(&t.w.d, &a, input(decide(&c, None)))
        .await
        .unwrap_err();
    assert_eq!(e.details["field"], "reason");
    t.w.ads.push_set_status(Ok(()));
    let paused = ads::campaign_pause(&t.w.d, &a, input(decide(&c, Some("Sonuç gelmiyor"))))
        .await
        .unwrap();
    assert_eq!(Ads::state(&paused), CampaignState::Paused);
    assert_eq!(paused.stop.as_ref().unwrap().by, StopBy::Agent);
    assert!(paused.built.as_ref().unwrap().provider_paused);
    assert_eq!(
        t.statuses().last().unwrap(),
        &("cmp-1".to_owned(), AdStatus::Paused)
    );
    // Only a person lets it go on.
    let e = ads::campaign_resume(&t.w.d, &a, input(decide(&paused, None)))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden, "{e:?}");
    t.w.ads.push_set_status(Ok(()));
    let resumed = ads::campaign_resume(&t.w.d, &t.w.ctx, input(decide(&paused, None)))
        .await
        .unwrap();
    assert!(resumed.stop.is_none());
    assert!(!resumed.built.as_ref().unwrap().provider_paused);
    assert_eq!(
        t.statuses().last().unwrap(),
        &("cmp-1".to_owned(), AdStatus::Active)
    );

    // The general ad budget's period is used up by spend elsewhere: every campaign stops, and
    // goes on by itself in the next period (B31).
    let general = budget::list_items(&t.w.d, &t.w.ctx).await.unwrap()[0]
        .item
        .id;
    budget::record_spend(&t.w.d, &t.w.ctx, general, 100_000, None)
        .await
        .unwrap();
    t.w.ads.push_set_status(Ok(()));
    // The same pass reads the campaign for the first time: nothing spent yet.
    t.provider(&[("ad-0", ProviderAdStatus::Active, None)], vec![]);
    watch_all(&t.w.d, t.w.f.ws, FIXED_NOW + Duration::minutes(1))
        .await
        .unwrap();
    let held = t.get(c.id).await;
    assert_eq!(
        held.stop.as_ref().map(|s| (s.by, s.reason.as_str())),
        Some((StopBy::Budget, "budget_exhausted"))
    );
    assert_eq!(
        t.statuses().last().unwrap(),
        &("cmp-1".to_owned(), AdStatus::Paused)
    );
    let next_month = FIXED_NOW + Duration::days(12);
    t.w.ads.push_set_status(Ok(()));
    // Its end date (seven days after its start) has passed by then: read, it ends.
    t.provider(
        &[("ad-0", ProviderAdStatus::Active, None)],
        vec![day("ad-0", 1, 4_000, Some(9))],
    );
    t.w.ads.push_set_status(Ok(()));
    watch_all(&t.w.d, t.w.f.ws, next_month).await.unwrap();
    let ctx = Ctx {
        now: next_month,
        ..t.w.ctx.clone()
    };
    let ended = ads::campaign_get(&t.w.d, &ctx, input(json!({"campaign_id":c.id})))
        .await
        .unwrap()
        .campaign;
    assert_eq!(Ads::state(&ended), CampaignState::Ended);
    assert_eq!(ended.ended.as_ref().unwrap().reason, EndReason::EndDate);
    assert_eq!(ended.totals.as_ref().unwrap().spent_minor, 4_000);
    assert_eq!(
        t.statuses().last().unwrap(),
        &("cmp-1".to_owned(), AdStatus::Paused)
    );
    // Over, it holds nothing; it cannot be stopped or changed any more.
    let e = ads::campaign_pause(&t.w.d, &ctx, input(decide(&ended, Some("x"))))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "not_running");

    // A campaign whose budget is spent ends as soon as the provider says so.
    let t = ads_world().await;
    let c = t.running("spent", 5_000, 1).await;
    t.provider(
        &[("ad-0", ProviderAdStatus::Active, None)],
        vec![day("ad-0", 0, 5_000, None)],
    );
    t.w.ads.push_set_status(Ok(()));
    watch_all(&t.w.d, t.w.f.ws, FIXED_NOW + Duration::hours(2))
        .await
        .unwrap();
    let ctx = Ctx {
        now: FIXED_NOW + Duration::hours(2),
        ..t.w.ctx.clone()
    };
    let ended = ads::campaign_get(&t.w.d, &ctx, input(json!({"campaign_id":c.id})))
        .await
        .unwrap()
        .campaign;
    assert_eq!(ended.ended.as_ref().unwrap().reason, EndReason::BudgetSpent);
    let _ = FixedClock(FIXED_NOW);
}

#[tokio::test]
async fn an_ended_campaign_is_followed_until_the_provider_is_quiet_and_its_last_spend_is_read() {
    let t = ads_world().await;
    let c = t.running("end", 50_000, 1).await;
    // A person ends it while the provider does not answer (nothing is scripted for the pause):
    // it is over here, and the provider's pause is still owed.
    let ended = ads::campaign_end(
        &t.w.d,
        &t.w.ctx,
        input(json!({"campaign_id":c.id,"expected_revision":c.revision,"reason":null})),
    )
    .await
    .unwrap();
    assert_eq!(Ads::state(&ended), CampaignState::Ended);
    assert_eq!(
        ended.state.as_ref().unwrap().note.as_deref(),
        Some("provider_still_running")
    );
    assert!(!ended.built.as_ref().unwrap().provider_paused);
    // Until the provider confirms, what is left of it stays held: the provider may still spend
    // it, so another campaign cannot take it.
    let e = t.open("second", 60_000).await.unwrap_err();
    assert_eq!(e.details["reason"], "above_general_budget", "{e:?}");
    assert_eq!(e.details["left"], 50_000);

    // The watch tries the pause again, and reads what the provider reports as spent up to the
    // end: the hours since the last read are not lost.
    t.w.ads.push_set_status(Ok(()));
    t.provider(
        &[("ad-0", ProviderAdStatus::Paused, None)],
        vec![day("ad-0", 0, 3_000, Some(2))],
    );
    watch_all(&t.w.d, t.w.f.ws, FIXED_NOW + Duration::minutes(5))
        .await
        .unwrap();
    let quiet = t.get(c.id).await;
    assert!(quiet.built.as_ref().unwrap().provider_paused);
    assert_eq!(quiet.state.as_ref().unwrap().note, None);
    assert_eq!(
        t.statuses().last().unwrap(),
        &("cmp-1".to_owned(), AdStatus::Paused)
    );
    // It keeps the end a person gave it, and its spend is in the budget.
    assert_eq!(quiet.ended.as_ref().unwrap().reason, EndReason::Person);
    assert_eq!(quiet.ended.as_ref().unwrap().at, FIXED_NOW);
    assert_eq!(quiet.totals.as_ref().unwrap().spent_minor, 3_000);
    let general = &budget::list_items(&t.w.d, &t.w.ctx).await.unwrap()[0];
    assert_eq!(general.spent_in_period, 3_000);
    // Quiet at the provider, the rest of its budget is free again.
    t.open("second", 60_000).await.unwrap();

    // What the provider reports late is still read, an hour apart, for two days.
    t.provider(
        &[("ad-0", ProviderAdStatus::Paused, None)],
        vec![day("ad-0", 0, 3_400, Some(2))],
    );
    watch_all(&t.w.d, t.w.f.ws, FIXED_NOW + Duration::hours(2))
        .await
        .unwrap();
    assert_eq!(
        t.get(c.id).await.totals.as_ref().unwrap().spent_minor,
        3_400
    );
    assert_eq!(
        budget::list_items(&t.w.d, &t.w.ctx).await.unwrap()[0].spent_in_period,
        3_400
    );
    // After that it is left alone: nothing is asked of the provider (an unscripted read fails
    // the test).
    let before = t.w.ads.calls().len();
    watch_all(&t.w.d, t.w.f.ws, FIXED_NOW + Duration::hours(49))
        .await
        .unwrap();
    assert_eq!(t.w.ads.calls().len(), before);
}

#[tokio::test]
async fn campaigns_stop_at_the_provider_while_the_ads_module_is_removed() {
    let t = ads_world().await;
    let c = t.running("module", 50_000, 1).await;
    // Removing the module pauses what Jeeta built: nobody would look at it. (The same pass
    // reads the campaign for the first time.)
    t.w.ads.push_set_status(Ok(()));
    t.provider(&[("ad-0", ProviderAdStatus::Paused, None)], vec![]);
    modules::remove(&t.w.d, &t.w.ctx, modules::ADS)
        .await
        .unwrap();
    let stored = {
        let mut r = t.w.d.uow.tenant(t.w.f.ws).await.unwrap();
        r.ads().get_campaign(c.id).await.unwrap().unwrap()
    };
    assert_eq!(
        stored.stop.as_ref().map(|s| (s.by, s.reason.as_str())),
        Some((StopBy::Budget, "module_removed"))
    );
    assert!(stored.built.as_ref().unwrap().provider_paused);
    assert_eq!(
        t.statuses().last().unwrap(),
        &("cmp-1".to_owned(), AdStatus::Paused)
    );
    // Installed again, the campaign goes on by itself.
    t.w.ads.push_set_status(Ok(()));
    modules::install(&t.w.d, &t.w.ctx, modules::ADS, Default::default())
        .await
        .unwrap();
    let back = t.get(c.id).await;
    assert!(back.stop.is_none());
    assert!(!back.built.as_ref().unwrap().provider_paused);
    assert_eq!(
        t.statuses().last().unwrap(),
        &("cmp-1".to_owned(), AdStatus::Active)
    );
}

async fn workspace_status(t: &Ads, status: WorkspaceStatus) {
    let mut r = t.w.uow.platform().await.unwrap();
    r.workspace_set_status(
        t.w.f.ws,
        status,
        "test status transition",
        &Actor::System {
            component: "test".into(),
        },
    )
    .await
    .unwrap();
    r.commit().await.unwrap();
}

#[tokio::test]
async fn campaigns_stop_at_the_provider_while_the_workspace_is_not_active() {
    let t = ads_world().await;
    let c = t.running("inactive", 50_000, 1).await;
    for inactive in [WorkspaceStatus::Suspended, WorkspaceStatus::PendingPayment] {
        // The workspace is not active: its panel is closed, nobody could stop the ads. The
        // control job, which does nothing else there, pauses what Jeeta built.
        workspace_status(&t, inactive).await;
        t.w.ads.push_set_status(Ok(()));
        if inactive == WorkspaceStatus::Suspended {
            // The first pass reads the campaign for the first time.
            t.provider(&[("ad-0", ProviderAdStatus::Paused, None)], vec![]);
        }
        let report = jobs::run_studio_control(&t.w.d).await;
        assert_eq!((report.failed, report.touched), (0, 1), "{inactive:?}");
        let stored = {
            let mut r = t.w.d.uow.tenant(t.w.f.ws).await.unwrap();
            r.ads().get_campaign(c.id).await.unwrap().unwrap()
        };
        assert_eq!(
            stored.stop.as_ref().map(|s| (s.by, s.reason.as_str())),
            Some((StopBy::Budget, "workspace_inactive")),
            "{inactive:?}"
        );
        assert!(stored.built.as_ref().unwrap().provider_paused);
        assert_eq!(
            t.statuses().last().unwrap(),
            &("cmp-1".to_owned(), AdStatus::Paused)
        );
        // Paused and recorded, a further pass changes nothing and asks the provider nothing.
        let calls = t.w.ads.calls().len();
        let again = jobs::run_studio_control(&t.w.d).await;
        assert_eq!((again.failed, again.touched, again.changed), (0, 0, 0));
        assert_eq!(t.w.ads.calls().len(), calls);

        // Active again, the campaign goes on by itself.
        workspace_status(&t, WorkspaceStatus::Active).await;
        t.w.ads.push_set_status(Ok(()));
        watch_all(&t.w.d, t.w.f.ws, FIXED_NOW).await.unwrap();
        let back = t.get(c.id).await;
        assert!(back.stop.is_none(), "{inactive:?}");
        assert!(!back.built.as_ref().unwrap().provider_paused);
        assert_eq!(
            t.statuses().last().unwrap(),
            &("cmp-1".to_owned(), AdStatus::Active)
        );
    }
}

#[tokio::test]
async fn three_refused_plans_hand_the_campaign_to_a_person() {
    let t = ads_world().await;
    let a = agent(&t.w);
    let mut c = t.open("three", 50_000).await.unwrap();
    for n in 1..=3u8 {
        let mut bad = t.plan(vec![t.ad("a")]);
        bad["audience"]["countries"] = json!(["FR"]);
        t.limits();
        let e = t
            .submit(&a, &c, &format!("bad-{n}"), bad)
            .await
            .unwrap_err();
        assert_eq!(e.details["refused"], n);
        c = t.get(c.id).await;
        // The claim stays the agent's until the third refusal, and is released for the next try.
        if n < 3 {
            let token_free = ads::campaign_claim(
                &t.w.d,
                &a,
                input(json!({"campaign_id":c.id,"expected_revision":c.revision})),
            )
            .await;
            assert!(token_free.is_err(), "the campaign is still claimed");
            let mut r = t.w.uow.tenant(t.w.f.ws).await.unwrap();
            let mut stored = r.ads().lock_campaign(c.id).await.unwrap().unwrap();
            stored.claim = None;
            stored.revision += 1;
            r.ads()
                .save_campaign(stored, Some(c.revision), None)
                .await
                .unwrap();
            r.commit().await.unwrap();
            c = t.get(c.id).await;
        }
    }
    assert_eq!(Ads::state(&c), CampaignState::Held);
    assert!(c.refusal.is_some());
    assert!(
        !work::pending(&t.w.d, &a)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::AdsCampaignPlan { .. }))
    );
    assert!(
        work::pending(&t.w.d, &t.w.ctx)
            .await
            .unwrap()
            .items
            .iter()
            .any(|i| matches!(i.kind, WorkKind::AdsCampaignHeld { .. }))
    );
}

#[tokio::test]
async fn a_plan_on_an_ad_account_that_may_only_be_read_names_the_missing_permission() {
    let t = ads_world().await;
    let a = agent(&t.w);
    let finding = |e: &jt_app::error::AppError| {
        assert_eq!(e.details["reason"], "plan_refused", "{e:?}");
        e.details["findings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["field"] == "ad_account")
            .cloned()
            .expect("the ad account is what holds the plan")
    };

    // An ad account whose grant only reads: what Meta gives when the sign-in leaves
    // `ads_management` out. The refusal says so, so that a person knows what to allow.
    let read_only = connection(&t.w, "meta_ads", "act_10", &["ads_read"]).await;
    let c = t.open("read-only", 30_000).await.unwrap();
    let mut plan = t.plan(vec![t.ad("a")]);
    plan["ad_account"] = json!(read_only);
    let e = t.submit(&a, &c, "read-only", plan).await.unwrap_err();
    assert_eq!(
        finding(&e),
        json!({"field":"ad_account","reason":"credential_scope_missing",
            "needs":["ads_management"]})
    );
    assert!(t.calls(|c| matches!(c, ConnectorCall::CreateCampaign { .. })) == 0);

    // Something that is no ad account at all is still just that.
    let c = t.open("no-account", 30_000).await.unwrap();
    let mut plan = t.plan(vec![t.ad("a")]);
    plan["ad_account"] = json!(t.page);
    let e = t.submit(&a, &c, "no-account", plan).await.unwrap_err();
    assert_eq!(
        finding(&e),
        json!({"field":"ad_account","reason":"not_a_usable_ad_account"})
    );
}

#[tokio::test]
async fn campaign_store_contract() {
    let t = ads_world().await;
    let other = jt_testkit::studio_contract::ready(&t.w.uow).await;
    jt_testkit::ads_contract::exercise(&t.w.uow, t.w.f.ws, other.ws).await;
}

// ---------------------------------------------------------------------------------------------
// Other ad platforms (design 2026-11-11): the campaign is the same, the plan is the platform's.
// ---------------------------------------------------------------------------------------------

const ADWORDS: &str = "https://www.googleapis.com/auth/adwords";

/// The ads world with a Google Ads account beside the Meta one, and Google's scripted adapter.
struct Search {
    t: Ads,
    google: Arc<ScriptedConnector>,
    account: CapabilityId,
}

async fn search_world() -> Search {
    let mut t = ads_world().await;
    let google = Arc::new(ScriptedConnector::new(Provider::Google));
    t.w.d.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_connector(t.w.ads.clone())
            .with_connector(google.clone()),
    );
    let account = connection(&t.w, "google_ads", "1234567890", &[ADWORDS]).await;
    Search { t, google, account }
}

impl Search {
    fn ad(&self, name: &str) -> Value {
        json!({"name":name,
            "headlines":["Yeni sezon kayıtları","Kayıtlar açıldı","Hemen kayıt ol"],
            "descriptions":["Yeni sezon başlıyor, yerini ayırt.","Kayıt birkaç dakika sürer."],
            "hypothesis_id":self.t.w.f.slot.chain.hypothesis_id})
    }

    fn plan(&self, ads: Vec<Value>) -> Value {
        json!({"ad_account":self.account,"result":"link_click",
            "destination":{"kind":"website","url":"https://ornek.example/kayit"},
            "audience":{"countries":["TR"]},
            "keywords":["yeni sezon kayıt","kurs kayıt"],
            "end_at":at(FIXED_NOW + Duration::days(7)),
            "ads":ads,"summary":"Kayıt arayanlara metin reklamı",
            "audience_summary":"Türkiye'de kayıt arayanlar"})
    }

    fn limits(&self, min_total: i64) {
        self.google.push_account_limits(Ok(AdAccountLimits {
            currency: "TRY".into(),
            minor_unit_exponent: 2,
            timezone: "Europe/Istanbul".into(),
            min_daily_budget_minor: 0,
            min_total_budget_minor: min_total,
        }));
    }

    fn calls(&self, pick: impl Fn(&ConnectorCall) -> bool) -> usize {
        self.google.calls().iter().filter(|c| pick(c)).count()
    }
}

/// What a malformed plan names: its field and why.
fn refused_field(e: &jt_app::error::AppError) -> (String, String) {
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    (
        e.details["field"].as_str().unwrap().to_owned(),
        e.details["reason"].as_str().unwrap().to_owned(),
    )
}

/// Review Focus 2 of plan 2026-11-11: a field the platform of the plan's ad account does not
/// take is refused naming the field, on either platform, and counts for nothing.
#[tokio::test]
async fn a_plan_carries_only_what_its_platform_takes() {
    let s = search_world().await;
    let a = agent(&s.t.w);
    let c = s.t.open("search", 50_000).await.unwrap();
    let claim = ads::campaign_claim(
        &s.t.w.d,
        &a,
        input(json!({"campaign_id":c.id,"expected_revision":c.revision})),
    )
    .await
    .unwrap();
    let submit = |key: &str, plan: Value| {
        let d = &s.t.w.d;
        let a = &a;
        let body = json!({"campaign_id":c.id,"claim_token":claim.claim_token,
            "request_key":key,"plan":plan});
        async move { ads::plan_submit(d, a, input(body)).await }
    };
    let not_taken = "field_not_for_this_platform";

    // A search ad is its headlines and descriptions: it has no image, no page, no texts of an
    // image ad and no call to action.
    for (field, value) in [
        ("primary_text", json!("Yeni sezon başlıyor")),
        ("headline", json!("Kayıtlar açık")),
        ("description", json!("Kısa açıklama")),
        ("call_to_action", json!("LEARN_MORE")),
        ("material_ids", json!([s.t.image])),
        ("page", json!(s.t.page)),
        ("instagram", json!(s.t.page)),
    ] {
        let mut plan = s.plan(vec![s.ad("a")]);
        plan["ads"][0][field] = value;
        let e = submit(&format!("g-{field}"), plan).await.unwrap_err();
        assert_eq!(
            refused_field(&e),
            (format!("ads[0].{field}"), not_taken.to_owned()),
            "{field}"
        );
    }
    // How many headlines, how long, none twice.
    let headlines = |list: Value| {
        let mut plan = s.plan(vec![s.ad("a")]);
        plan["ads"][0]["headlines"] = list;
        plan
    };
    let e = submit("g-two", headlines(json!(["Bir", "İki"])))
        .await
        .unwrap_err();
    assert_eq!(
        refused_field(&e),
        ("ads[0].headlines".into(), "3_to_15_items".into())
    );
    let e = submit(
        "g-long",
        headlines(json!(["a".repeat(31), "İki başlık", "Üç başlık"])),
    )
    .await
    .unwrap_err();
    assert_eq!(
        refused_field(&e),
        ("ads[0].headlines[0]".into(), "1_to_30_characters".into())
    );
    let e = submit("g-twice", headlines(json!(["Bir", "İki", "bir "])))
        .await
        .unwrap_err();
    assert_eq!(
        refused_field(&e),
        ("ads[0].headlines[2]".into(), "given_twice".into())
    );
    // The plan itself: its searches, and no audience or placement Google's search ads lack.
    let changed = |path: &[&str], value: Value| {
        let mut plan = s.plan(vec![s.ad("a")]);
        let mut at = &mut plan;
        for key in &path[..path.len() - 1] {
            at = &mut at[*key];
        }
        at[path[path.len() - 1]] = value;
        plan
    };
    for (path, value, field, reason) in [
        (vec!["keywords"], json!([]), "keywords", "1_to_20_items"),
        (
            vec!["keywords"],
            json!(["bir iki üç dört beş altı yedi sekiz dokuz on onbir"]),
            "keywords[0]",
            "at_most_10_words_on_one_line",
        ),
        (
            vec!["audience", "age_min"],
            json!(25),
            "audience.age_min",
            not_taken,
        ),
        (
            vec!["audience", "genders"],
            json!([2]),
            "audience.genders",
            not_taken,
        ),
        (
            vec!["audience", "cities"],
            json!(["Ankara"]),
            "audience.cities",
            not_taken,
        ),
        (
            vec!["placements"],
            json!({"platforms":["facebook"]}),
            "placements",
            not_taken,
        ),
    ] {
        let key = format!("g-{field}-{reason}");
        let e = submit(&key, changed(&path, value)).await.unwrap_err();
        assert_eq!(
            refused_field(&e),
            (field.to_owned(), reason.to_owned()),
            "{field}"
        );
    }
    let mut broad = s.plan(vec![s.ad("a")]);
    broad["audience"]["broad"] = json!(true);
    let e = submit("g-broad", broad).await.unwrap_err();
    assert_eq!(
        refused_field(&e),
        ("audience.broad".into(), not_taken.into())
    );
    let mut form = s.plan(vec![s.ad("a")]);
    form["result"] = json!("lead_form");
    form["destination"] = json!({"kind":"lead_form","page":s.t.page,"name":"Form",
        "questions":["EMAIL"],"privacy_policy_url":"https://ornek.example/gizlilik",
        "thank_you_url":"https://ornek.example/tesekkur"});
    let e = submit("g-form", form).await.unwrap_err();
    assert_eq!(refused_field(&e), ("result".into(), not_taken.into()));

    // The other way round: a Meta ad takes no search headlines and no keywords, and needs the
    // page it speaks as.
    let mut meta = s.t.plan(vec![s.t.ad("a")]);
    meta["keywords"] = json!(["kurs kayıt"]);
    let e = submit("m-keywords", meta).await.unwrap_err();
    assert_eq!(refused_field(&e), ("keywords".into(), not_taken.into()));
    let mut meta = s.t.plan(vec![s.t.ad("a")]);
    meta["ads"][0]["headlines"] = json!(["Bir", "İki", "Üç"]);
    let e = submit("m-headlines", meta).await.unwrap_err();
    assert_eq!(
        refused_field(&e),
        ("ads[0].headlines".into(), not_taken.into())
    );
    // Google knows an ad only by what it says: two ads of a plan may not say the same.
    let e = submit("g-same", s.plan(vec![s.ad("a"), s.ad("b")]))
        .await
        .unwrap_err();
    assert_eq!(
        refused_field(&e),
        ("ads[1]".into(), "same_as_another_ad".into())
    );
    let mut meta = s.t.plan(vec![s.t.ad("a")]);
    meta["ads"][0]
        .as_object_mut()
        .unwrap()
        .remove("page")
        .unwrap();
    let e = submit("m-page", meta).await.unwrap_err();
    assert_eq!(
        refused_field(&e),
        ("ads[0].page".into(), "required_on_this_platform".into())
    );

    // None of it counted, and nothing was asked of either provider.
    assert_eq!(s.t.get(c.id).await.refused, 0);
    assert!(s.google.calls().is_empty() && s.t.w.ads.calls().is_empty());
}

/// A search campaign from its plan to a running ad: what the platform's own limits refuse is a
/// finding, the build has no image step, the specs carry what a search campaign is made of, and
/// an ad that is held but still runs at the provider is paused again by the watch.
#[tokio::test]
async fn a_search_campaign_is_planned_built_without_an_image_and_watched() {
    let s = search_world().await;
    let a = agent(&s.t.w);
    let c = s.t.open("search", 50_000).await.unwrap();
    let finding = |e: &jt_app::error::AppError, field: &str| {
        assert_eq!(e.details["reason"], "plan_refused", "{e:?}");
        e.details["findings"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["field"] == field)
            .cloned()
            .unwrap_or_else(|| panic!("no finding on {field}: {e:?}"))
    };

    // One claim carries the agent through its refused plans to the one that holds.
    let claim = ads::campaign_claim(
        &s.t.w.d,
        &a,
        input(json!({"campaign_id":c.id,"expected_revision":c.revision})),
    )
    .await
    .unwrap();
    let submit = |key: &str, plan: Value| {
        let d = &s.t.w.d;
        let a = &a;
        let body = json!({"campaign_id":c.id,"claim_token":claim.claim_token,
            "request_key":key,"plan":plan});
        async move { ads::plan_submit(d, a, input(body)).await }
    };

    // Google runs a campaign with a total budget for three days at least.
    let mut short = s.plan(vec![s.ad("a")]);
    short["end_at"] = json!(at(FIXED_NOW + Duration::days(2)));
    s.limits(0);
    let e = submit("short", short).await.unwrap_err();
    assert_eq!(
        finding(&e, "end_at"),
        json!({"field":"end_at","reason":"duration_not_supported",
            "least_hours":72,"most_days":89})
    );
    // And the account's own least total is a finding too.
    s.limits(60_000);
    let e = submit("small", s.plan(vec![s.ad("a")])).await.unwrap_err();
    assert_eq!(
        finding(&e, "budget_minor"),
        json!({"field":"budget_minor","reason":"below_the_accounts_minimum","least":60_000})
    );
    assert_eq!(s.t.get(c.id).await.refused, 2);
    assert_eq!(
        s.calls(|c| matches!(c, ConnectorCall::CreateCampaign { .. })),
        0
    );

    // The plan that holds: campaign, ad group, then each ad; no image is uploaded.
    s.limits(0);
    let x = &s.google;
    x.push_find_by_name(Ok(None));
    x.push_create_campaign(Ok("g-cmp".into()));
    x.push_find_by_name(Ok(None));
    x.push_create_adset(Ok("g-grp".into()));
    for i in 0..2 {
        x.push_find_by_name(Ok(None));
        x.push_create_creative(Ok("inline".into()));
        x.push_find_by_name(Ok(None));
        x.push_create_ad(Ok(format!("g-ad-{i}")));
    }
    for _ in 0..4 {
        x.push_set_status(Ok(()));
    }
    let mut second = s.ad("İki");
    second["headlines"] = json!(["Kayıt için son hafta", "Yerini şimdi ayırt", "Kayıt ol"]);
    let built = submit("good", s.plan(vec![s.ad("Bir"), second.clone()]))
        .await
        .unwrap();
    assert_eq!(Ads::state(&built), CampaignState::InReview);
    let b = built.built.as_ref().unwrap();
    assert_eq!(b.platform, AdsPlatform::Google);
    assert_eq!(b.campaign_id.as_deref(), Some("g-cmp"));
    assert_eq!(b.adset_id.as_deref(), Some("g-grp"));
    assert!(b.ads.iter().all(|ad| ad.image_hash.is_none()));
    assert!(b.activated_at.is_some());
    assert_eq!(
        s.calls(|c| matches!(c, ConnectorCall::UploadImage { .. })),
        0
    );
    assert!(s.t.w.ads.calls().is_empty(), "nothing is asked of Meta");
    let calls = s.google.calls();
    // The campaign carries the total budget and the time it runs.
    let campaign = calls
        .iter()
        .find_map(|c| match c {
            ConnectorCall::CreateCampaign { spec, .. } => Some(spec.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(campaign.lifetime_budget_minor, 50_000);
    assert_eq!(campaign.start_at, FIXED_NOW);
    assert_eq!(campaign.end_at, FIXED_NOW + Duration::days(7));
    // The level under it carries the searches, the country and the budget once more.
    let group = calls
        .iter()
        .find_map(|c| match c {
            ConnectorCall::CreateAdset { spec, .. } => Some(spec.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(group.campaign_id, "g-cmp");
    assert_eq!(group.keywords, ["yeni sezon kayıt", "kurs kayıt"]);
    assert_eq!(group.budget_minor, 50_000);
    assert_eq!(group.audience.countries, ["TR"]);
    assert_eq!((group.audience.age_min, group.audience.age_max), (18, 65));
    // The ad carries its own content: headlines and descriptions, no page, no image, no call
    // to action; and the ad step is handed the same creative.
    let ad = calls
        .iter()
        .find_map(|c| match c {
            ConnectorCall::CreateAd { spec, .. } => Some(spec.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(ad.adset_id, "g-grp");
    assert_eq!(ad.creative_id, "inline");
    assert_eq!(ad.creative.headlines.len(), 3);
    assert_eq!(ad.creative.descriptions.len(), 2);
    assert_eq!(ad.creative.identity_id, None);
    assert_eq!(ad.creative.image, None);
    assert_eq!(ad.creative.call_to_action, None);
    assert!(ad.creative.primary_text.is_empty());
    // Activated last: the ads, the ad group, the campaign.
    let statuses: Vec<(String, AdStatus)> = calls
        .iter()
        .filter_map(|c| match c {
            ConnectorCall::SetAdStatus {
                entity_id, status, ..
            } => Some((entity_id.clone(), *status)),
            _ => None,
        })
        .collect();
    assert_eq!(
        statuses,
        [
            ("g-ad-0".to_owned(), AdStatus::Active),
            ("g-ad-1".to_owned(), AdStatus::Active),
            ("g-grp".to_owned(), AdStatus::Active),
            ("g-cmp".to_owned(), AdStatus::Active)
        ]
    );
    // What a plan must look like on each platform travels with the campaign.
    let detail = ads::campaign_get(&s.t.w.d, &s.t.w.ctx, input(json!({"campaign_id":c.id})))
        .await
        .unwrap();
    let rules = serde_json::to_value(&detail.platforms).unwrap();
    assert_eq!(rules[0]["platform"], "meta");
    assert_eq!(rules[1]["platform"], "google");
    assert_eq!(rules[1]["headlines"], json!({"min":3,"max":15,"chars":30}));
    assert_eq!(rules[1]["image"], false);
    assert_eq!(rules[1]["min_run_hours"], 72);
    assert_eq!(rules[1]["max_run_days"], 89);
    assert_eq!(rules[1]["distinct_ads"], true);
    // An ad added later may not say what an ad of the campaign already says.
    let e = ads::campaign_move(
        &s.t.w.d,
        &a,
        input(json!({"campaign_id":c.id,"request_key":"same",
            "move":{"kind":"add_ad","ad":second,"reason":"Bir tane daha"}})),
    )
    .await
    .unwrap_err();
    assert_eq!(
        refused_field(&e),
        ("move.ad".into(), "same_as_another_ad".into())
    );
    // Google shows no preview of an ad.
    let e = ads::ad_preview(
        &s.t.w.d,
        &a,
        input(json!({"campaign_id":c.id,"index":0,"placement":"facebook_feed"})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "no_preview_on_this_platform");

    // Review Focus 4: the agent holds the first ad, but its pause does not reach the provider.
    x.push_set_status(Err(ConnectorError::transient("no answer")));
    let moved = ads::campaign_move(
        &s.t.w.d,
        &a,
        input(json!({"campaign_id":c.id,"request_key":"hold",
            "move":{"kind":"pause_ad","ad":0,"reason":"İlk başlıklar zayıf"}})),
    )
    .await
    .unwrap();
    assert!(moved.built.as_ref().unwrap().ads[0].held);
    // An hour later the provider still reports it as running: the watch pauses it again.
    let later = FIXED_NOW + Duration::hours(2);
    x.push_campaign_state(Ok(CampaignProviderState {
        campaign: ProviderAdStatus::Active,
        ads: ["g-ad-0", "g-ad-1"]
            .iter()
            .map(|id| ProviderAd {
                ad_id: (*id).into(),
                name: (*id).into(),
                status: ProviderAdStatus::Active,
                feedback: None,
            })
            .collect(),
    }));
    x.push_ad_days(Ok(vec![day("g-ad-1", 0, 900, Some(4))]));
    x.push_set_status(Ok(()));
    assert_eq!(watch_all(&s.t.w.d, s.t.w.f.ws, later).await.unwrap(), 1);
    let last = s.google.calls().into_iter().next_back().unwrap();
    assert!(
        matches!(&last, ConnectorCall::SetAdStatus { entity_id, status, .. }
            if entity_id == "g-ad-0" && *status == AdStatus::Paused),
        "{last:?}"
    );
}

/// A person who fixes the end of a campaign on an ad account they chose learns at once when
/// that platform does not run a campaign so short.
#[tokio::test]
async fn an_end_the_chosen_accounts_platform_does_not_take_is_refused_at_opening() {
    let s = search_world().await;
    let open = |key: &str, account: CapabilityId, days: i64| {
        let d = &s.t.w.d;
        let ctx = &s.t.w.ctx;
        let body = json!({"request_key":key,"goal":"Kayıtları duyur","budget_minor":20_000,
            "start_at":at(FIXED_NOW),"end_at":at(FIXED_NOW + Duration::days(days)),
            "account":account});
        async move { ads::campaign_open(d, ctx, input(body)).await }
    };
    let e = open("two-days-google", s.account, 2).await.unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation, "{e:?}");
    assert_eq!(
        e.details,
        json!({"field":"end_at","reason":"duration_not_supported",
            "least_hours":72,"most_days":89})
    );
    // The same two days are fine on Meta, and three are fine on Google.
    open("two-days-meta", s.t.account, 2).await.unwrap();
    let c = open("three-days-google", s.account, 3).await.unwrap();
    // Changing the end afterwards is held against the same platform.
    let e = ads::campaign_update(
        &s.t.w.d,
        &s.t.w.ctx,
        input(json!({"campaign_id":c.id,"expected_revision":c.revision,
            "end_at":at(FIXED_NOW + Duration::days(1))})),
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "duration_not_supported", "{e:?}");
}

// ---------------------------------------------------------------------------------------------
// LinkedIn (design 2026-11-11 §3.2, B85 to B87)

/// The ads world with a LinkedIn ad account beside the Meta one, and LinkedIn's scripted adapter.
struct Sponsored {
    t: Ads,
    linkedin: Arc<ScriptedConnector>,
    account: CapabilityId,
}

async fn sponsored_world() -> Sponsored {
    let mut t = ads_world().await;
    let linkedin = Arc::new(ScriptedConnector::new(Provider::Linkedin));
    t.w.d.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_connector(t.w.ads.clone())
            .with_connector(linkedin.clone()),
    );
    let account = connection(&t.w, "linkedin_ads", "512000001", &["rw_ads", "r_ads"]).await;
    Sponsored {
        t,
        linkedin,
        account,
    }
}

impl Sponsored {
    fn ad(&self, name: &str) -> Value {
        json!({"name":name,"material_ids":[self.t.image],
            "primary_text":"Yeni sezon başlıyor","headline":"Kayıtlar açık",
            "call_to_action":"SIGN_UP",
            "hypothesis_id":self.t.w.f.slot.chain.hypothesis_id})
    }

    fn plan(&self, ads: Vec<Value>) -> Value {
        json!({"ad_account":self.account,"result":"link_click",
            "destination":{"kind":"website","url":"https://ornek.example/kayit"},
            "audience":{"countries":["TR"]},
            "end_at":at(FIXED_NOW + Duration::days(7)),
            "ads":ads,"summary":"Kayıt sayfasına trafik",
            "audience_summary":"Türkiye'deki LinkedIn üyeleri"})
    }

    fn limits(&self) {
        self.linkedin.push_account_limits(Ok(AdAccountLimits {
            currency: "TRY".into(),
            minor_unit_exponent: 2,
            timezone: "UTC".into(),
            min_daily_budget_minor: 0,
            min_total_budget_minor: 0,
        }));
    }
}

/// A LinkedIn campaign from its plan to its activation: the ad is an image, a text, a headline
/// and a button under the company page of its ad account (the plan names no page), the audience
/// is the countries alone, an image of a type LinkedIn does not take is a finding before the
/// build, and the build uploads the image and activates the creative, the campaign and the
/// campaign group, in that order.
#[tokio::test]
async fn a_linkedin_campaign_shows_an_image_as_its_accounts_page_and_is_built_and_activated() {
    let s = sponsored_world().await;
    let a = agent(&s.t.w);
    let c = s.t.open("sponsored", 50_000).await.unwrap();
    let claim = ads::campaign_claim(
        &s.t.w.d,
        &a,
        input(json!({"campaign_id":c.id,"expected_revision":c.revision})),
    )
    .await
    .unwrap();
    let submit = |key: &str, plan: Value| {
        let d = &s.t.w.d;
        let a = &a;
        let body = json!({"campaign_id":c.id,"claim_token":claim.claim_token,
            "request_key":key,"plan":plan});
        async move { ads::plan_submit(d, a, input(body)).await }
    };
    let not_taken = "field_not_for_this_platform";

    // What an ad of another platform carries is refused naming the field.
    for (field, value, reason) in [
        ("page", json!(s.t.page), not_taken),
        ("instagram", json!(s.t.page), not_taken),
        ("description", json!("Kısa açıklama"), not_taken),
        ("headlines", json!(["Bir", "İki", "Üç"]), not_taken),
        (
            "descriptions",
            json!(["Bir açıklama", "İki açıklama"]),
            not_taken,
        ),
        // LinkedIn has no button for it.
        (
            "call_to_action",
            json!("BOOK_NOW"),
            "a_listed_call_to_action",
        ),
        ("material_ids", json!([]), "one_image"),
    ] {
        let mut plan = s.plan(vec![s.ad("a")]);
        plan["ads"][0][field] = value;
        let e = submit(&format!("li-{field}"), plan).await.unwrap_err();
        assert_eq!(
            refused_field(&e),
            (format!("ads[0].{field}"), reason.to_owned()),
            "{field}"
        );
    }
    // The audience is the countries: no age range, no gender, nothing left to the platform.
    for (field, value, named) in [
        ("age_min", json!(25), "audience.age_min"),
        ("genders", json!([2]), "audience.genders"),
        ("regions", json!(["3886"]), "audience.regions"),
    ] {
        let mut plan = s.plan(vec![s.ad("a")]);
        plan["audience"][field] = value;
        let e = submit(&format!("li-audience-{field}"), plan)
            .await
            .unwrap_err();
        assert_eq!(refused_field(&e), (named.to_owned(), not_taken.to_owned()));
    }
    let mut searched = s.plan(vec![s.ad("a")]);
    searched["keywords"] = json!(["kayıt"]);
    let e = submit("li-keywords", searched).await.unwrap_err();
    assert_eq!(refused_field(&e), ("keywords".into(), not_taken.into()));
    assert_eq!(s.t.get(c.id).await.refused, 0);
    assert!(s.linkedin.calls().is_empty());

    // LinkedIn takes a JPG, a PNG or a GIF: another image is a finding of the plan, not a
    // refusal at the build after the plan was accepted.
    let webp = image_of(&s.t.w, b"RIFF\x00\x00\x00\x00WEBPVP8 ", "image/webp").await;
    let mut other = s.ad("a");
    other["material_ids"] = json!([webp]);
    s.limits();
    let e = submit("li-webp", s.plan(vec![other])).await.unwrap_err();
    assert_eq!(e.details["reason"], "plan_refused", "{e:?}");
    let found = e.details["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["reason"] == "image_type_not_taken")
        .cloned()
        .unwrap_or_else(|| panic!("{e:?}"));
    assert_eq!(
        found,
        json!({"field":"ads[0].material_ids","reason":"image_type_not_taken",
            "material_id":webp,"takes":["image/jpeg","image/png","image/gif"]})
    );
    assert_eq!(s.t.get(c.id).await.refused, 1);

    // The plan that holds.
    s.limits();
    let x = &s.linkedin;
    x.push_find_by_name(Ok(None));
    x.push_create_campaign(Ok("li:512000001:group:9".into()));
    x.push_find_by_name(Ok(None));
    x.push_create_adset(Ok("li:512000001:campaign:7".into()));
    x.push_upload_image(Ok("urn:li:image:C4E10AQtest".into()));
    x.push_find_by_name(Ok(None));
    x.push_create_creative(Ok("inline".into()));
    x.push_find_by_name(Ok(None));
    x.push_create_ad(Ok("li:512000001:creative:1".into()));
    for _ in 0..3 {
        x.push_set_status(Ok(()));
    }
    let built = submit("li-good", s.plan(vec![s.ad("Bir")])).await.unwrap();
    assert_eq!(Ads::state(&built), CampaignState::InReview);
    let b = built.built.as_ref().unwrap();
    assert_eq!(b.platform, AdsPlatform::Linkedin);
    assert_eq!(b.campaign_id.as_deref(), Some("li:512000001:group:9"));
    assert_eq!(b.adset_id.as_deref(), Some("li:512000001:campaign:7"));
    assert_eq!(
        b.ads[0].image_hash.as_deref(),
        Some("urn:li:image:C4E10AQtest")
    );
    assert!(b.activated_at.is_some());
    assert!(s.t.w.ads.calls().is_empty(), "nothing is asked of Meta");

    let calls = s.linkedin.calls();
    let level = calls
        .iter()
        .find_map(|c| match c {
            ConnectorCall::CreateAdset { spec, .. } => Some(spec.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(level.campaign_id, "li:512000001:group:9");
    assert_eq!(level.budget_minor, 50_000);
    assert_eq!(level.audience.countries, ["TR"]);
    assert!(level.audience.genders.is_empty() && !level.audience.broad);
    // The ad carries its image, its texts and its button, and names no page: it speaks as the
    // company page of the ad account, which the adapter reads at LinkedIn.
    let ad = calls
        .iter()
        .find_map(|c| match c {
            ConnectorCall::CreateAd { spec, .. } => Some(spec.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(ad.adset_id, "li:512000001:campaign:7");
    assert_eq!(ad.creative.identity_id, None);
    assert_eq!(
        ad.creative.image.as_deref(),
        Some("urn:li:image:C4E10AQtest")
    );
    assert_eq!(ad.creative.primary_text, "Yeni sezon başlıyor");
    assert_eq!(ad.creative.headline, "Kayıtlar açık");
    assert_eq!(ad.creative.call_to_action, Some(CallToAction::SignUp));
    // Activated last: the creative, the campaign, the campaign group.
    let statuses: Vec<(String, AdStatus)> = calls
        .iter()
        .filter_map(|c| match c {
            ConnectorCall::SetAdStatus {
                entity_id, status, ..
            } => Some((entity_id.clone(), *status)),
            _ => None,
        })
        .collect();
    assert_eq!(
        statuses,
        [
            ("li:512000001:creative:1".to_owned(), AdStatus::Active),
            ("li:512000001:campaign:7".to_owned(), AdStatus::Active),
            ("li:512000001:group:9".to_owned(), AdStatus::Active)
        ]
    );
    // What a LinkedIn plan must look like travels with the campaign.
    let detail = ads::campaign_get(&s.t.w.d, &s.t.w.ctx, input(json!({"campaign_id":c.id})))
        .await
        .unwrap();
    let rules = serde_json::to_value(&detail.platforms).unwrap();
    assert_eq!(rules[2]["platform"], "linkedin");
    assert_eq!(rules[2]["account_kind"], "linkedin_ads");
    assert_eq!(rules[2]["page_kind"], Value::Null);
    assert_eq!(rules[2]["image"], true);
    assert_eq!(
        rules[2]["image_types"],
        json!(["image/jpeg", "image/png", "image/gif"])
    );
    assert_eq!(rules[2]["primary_text"], 3000);
    assert_eq!(rules[2]["headline"], 200);
    assert_eq!(rules[2]["description"], Value::Null);
    assert_eq!(rules[2]["audience_age_and_gender"], false);
    assert_eq!(rules[2]["hard_budget_cap"], true);
    assert_eq!(rules[2]["preview"], false);
    assert_eq!(rules[0]["image_types"], json!([]), "Meta takes any image");
}

/// A LinkedIn ad account whose connection may only read names the permission that is missing.
#[tokio::test]
async fn a_linkedin_ad_account_that_may_only_be_read_names_the_missing_permission() {
    let mut s = sponsored_world().await;
    s.account = connection(&s.t.w, "linkedin_ads", "512000002", &["r_ads"]).await;
    let a = agent(&s.t.w);
    let c = s.t.open("read-only", 50_000).await.unwrap();
    let e =
        s.t.submit(&a, &c, "li-read-only", s.plan(vec![s.ad("a")]))
            .await
            .unwrap_err();
    let found = e.details["findings"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["field"] == "ad_account")
        .cloned()
        .unwrap_or_else(|| panic!("{e:?}"));
    assert_eq!(
        found,
        json!({"field":"ad_account","reason":"credential_scope_missing","needs":["rw_ads"]})
    );
    assert!(s.linkedin.calls().is_empty());
}

// ---------------------------------------------------------------------------------------------
// TikTok (design 2026-11-11 §3.3, B69, B88 to B90)

/// A TikTok campaign from its plan to its activation: the ad is one image, one short text
/// without emoji and a button under the TikTok account linked to its ad account (the plan names
/// no account); TikTok's least budgets are the account's own limits and a finding of the plan;
/// the build uploads the image and activates the ad, the ad group and the campaign.
#[tokio::test]
async fn a_tiktok_campaign_is_one_image_and_a_short_text_and_is_built_and_activated() {
    let mut t = ads_world().await;
    let tiktok = Arc::new(ScriptedConnector::new(Provider::Tiktok));
    t.w.d.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_connector(t.w.ads.clone())
            .with_connector(tiktok.clone()),
    );
    // A TikTok advertiser's authorization names no scope to hold a write against.
    let account = connection(
        &t.w,
        "tiktok_ads",
        "7200000000000000001",
        &["tiktok_business:2"],
    )
    .await;
    let a = agent(&t.w);
    let c = t.open("tiktok", 60_000).await.unwrap();
    let claim = ads::campaign_claim(
        &t.w.d,
        &a,
        input(json!({"campaign_id":c.id,"expected_revision":c.revision})),
    )
    .await
    .unwrap();
    let submit = |key: &str, plan: Value| {
        let d = &t.w.d;
        let a = &a;
        let body = json!({"campaign_id":c.id,"claim_token":claim.claim_token,
            "request_key":key,"plan":plan});
        async move { ads::plan_submit(d, a, input(body)).await }
    };
    let ad = |text: &str| {
        json!({"name":"Bir","material_ids":[t.image],"primary_text":text,
            "call_to_action":"SIGN_UP","hypothesis_id":t.w.f.slot.chain.hypothesis_id})
    };
    let plan = |ads: Vec<Value>| {
        json!({"ad_account":account,"result":"link_click",
            "destination":{"kind":"website","url":"https://ornek.example/kayit"},
            "audience":{"countries":["TR"]},
            "end_at":at(FIXED_NOW + Duration::days(7)),
            "ads":ads,"summary":"Kayıt sayfasına trafik",
            "audience_summary":"Türkiye'deki TikTok kullanıcıları"})
    };
    let limits = |min_daily: i64, min_total: i64| {
        tiktok.push_account_limits(Ok(AdAccountLimits {
            currency: "TRY".into(),
            minor_unit_exponent: 2,
            timezone: "Europe/Istanbul".into(),
            min_daily_budget_minor: min_daily,
            min_total_budget_minor: min_total,
        }));
    };
    let not_taken = "field_not_for_this_platform";

    // A TikTok ad has one text: no headline, no description, no page; at most 100 characters,
    // and no emoji.
    for (field, value, reason) in [
        ("headline", json!("Kayıtlar açık"), not_taken),
        ("description", json!("Kısa açıklama"), not_taken),
        ("page", json!(t.page), not_taken),
        (
            "primary_text",
            json!("x".repeat(101)),
            "1_to_100_characters",
        ),
        ("primary_text", json!("Yeni sezon başlıyor 🎉"), "no_emoji"),
        ("material_ids", json!([]), "one_image"),
    ] {
        let mut p = plan(vec![ad("Yeni sezon başlıyor")]);
        p["ads"][0][field] = value;
        let e = submit(&format!("tt-{field}-{reason}"), p)
            .await
            .unwrap_err();
        assert_eq!(
            refused_field(&e),
            (format!("ads[0].{field}"), reason.to_owned()),
            "{field}"
        );
    }
    let mut aged = plan(vec![ad("Yeni sezon başlıyor")]);
    aged["audience"]["age_min"] = json!(25);
    let e = submit("tt-age", aged).await.unwrap_err();
    assert_eq!(
        refused_field(&e),
        ("audience.age_min".into(), not_taken.into())
    );
    assert_eq!(t.get(c.id).await.refused, 0);
    assert!(tiktok.calls().is_empty());

    // TikTok's least budgets are a finding of the plan: 200 a day for seven days here.
    limits(20_000, 50_000);
    let e = submit("tt-small", plan(vec![ad("Yeni sezon başlıyor")]))
        .await
        .unwrap_err();
    assert_eq!(e.details["reason"], "plan_refused", "{e:?}");
    assert!(
        e.details["findings"]
            .as_array()
            .unwrap()
            .contains(&json!({"field":"budget_minor",
                "reason":"below_the_accounts_minimum","least":140_000})),
        "{e:?}"
    );
    // An image TikTok does not take in a carousel is a finding too.
    let gif = image_of(&t.w, b"GIF89a", "image/gif").await;
    let mut other = ad("Yeni sezon başlıyor");
    other["material_ids"] = json!([gif]);
    limits(0, 0);
    let e = submit("tt-gif", plan(vec![other])).await.unwrap_err();
    assert!(
        e.details["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["reason"] == "image_type_not_taken"
                && f["takes"] == json!(["image/jpeg", "image/png"])),
        "{e:?}"
    );

    // The plan that holds.
    limits(0, 0);
    let x = &tiktok;
    x.push_find_by_name(Ok(None));
    x.push_create_campaign(Ok("tt:72:campaign:1".into()));
    x.push_find_by_name(Ok(None));
    x.push_create_adset(Ok("tt:72:adgroup:2".into()));
    x.push_upload_image(Ok("ad-site/synthetic-image".into()));
    x.push_find_by_name(Ok(None));
    x.push_create_creative(Ok("inline".into()));
    x.push_find_by_name(Ok(None));
    x.push_create_ad(Ok("tt:72:ad:3".into()));
    for _ in 0..3 {
        x.push_set_status(Ok(()));
    }
    let built = submit("tt-good", plan(vec![ad("Yeni sezon başlıyor")]))
        .await
        .unwrap();
    assert_eq!(Ads::state(&built), CampaignState::InReview);
    let b = built.built.as_ref().unwrap();
    assert_eq!(b.platform, AdsPlatform::Tiktok);
    assert_eq!(
        b.ads[0].image_hash.as_deref(),
        Some("ad-site/synthetic-image")
    );
    assert!(b.activated_at.is_some());
    let calls = tiktok.calls();
    let made = calls
        .iter()
        .find_map(|c| match c {
            ConnectorCall::CreateAd { spec, .. } => Some(spec.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(made.creative.identity_id, None);
    assert_eq!(made.creative.primary_text, "Yeni sezon başlıyor");
    assert!(made.creative.headline.is_empty());
    assert_eq!(made.creative.call_to_action, Some(CallToAction::SignUp));
    let statuses: Vec<(String, AdStatus)> = calls
        .iter()
        .filter_map(|c| match c {
            ConnectorCall::SetAdStatus {
                entity_id, status, ..
            } => Some((entity_id.clone(), *status)),
            _ => None,
        })
        .collect();
    assert_eq!(
        statuses,
        [
            ("tt:72:ad:3".to_owned(), AdStatus::Active),
            ("tt:72:adgroup:2".to_owned(), AdStatus::Active),
            ("tt:72:campaign:1".to_owned(), AdStatus::Active)
        ]
    );
    let detail = ads::campaign_get(&t.w.d, &t.w.ctx, input(json!({"campaign_id":c.id})))
        .await
        .unwrap();
    let rules = serde_json::to_value(&detail.platforms).unwrap();
    assert_eq!(rules[3]["platform"], "tiktok");
    assert_eq!(rules[3]["primary_text"], 100);
    assert_eq!(rules[3]["headline"], Value::Null);
    assert_eq!(rules[3]["no_emoji"], true);
    assert_eq!(rules[3]["image_types"], json!(["image/jpeg", "image/png"]));
    assert_eq!(rules[2]["no_emoji"], false);
}

// ---------------------------------------------------------------------------------------------
// X (design 2026-11-11 §3.4, B67, B92 to B97)

/// An X campaign from its plan to its end: the ad is a text and a website card (one image, a
/// title and the address; no button, no description, and the plan names no account) under the
/// ads account's own X user. X does not say that a campaign's total budget is never exceeded:
/// the campaign's rules say so, a running X campaign is read every fifteen minutes and not
/// every hour, what X reports as spent is recorded whole (above the budget too), and the
/// campaign ends and is paused at X as soon as its budget is reached.
#[tokio::test]
async fn an_x_campaign_is_a_text_and_a_card_and_is_read_every_fifteen_minutes() {
    let mut t = ads_world().await;
    let x = Arc::new(ScriptedConnector::new(Provider::X));
    t.w.d.connectors = Arc::new(
        ScriptedRegistry::new()
            .with_connector(t.w.ads.clone())
            .with_connector(x.clone()),
    );
    let account = connection(
        &t.w,
        "x_ads",
        "18ce54d4x5t",
        &["tweet.read", "ads.read", "ads.write"],
    )
    .await;
    let a = agent(&t.w);
    let c = t.open("x", 60_000).await.unwrap();
    let claim = ads::campaign_claim(
        &t.w.d,
        &a,
        input(json!({"campaign_id":c.id,"expected_revision":c.revision})),
    )
    .await
    .unwrap();
    let submit = |key: &str, plan: Value| {
        let d = &t.w.d;
        let a = &a;
        let body = json!({"campaign_id":c.id,"claim_token":claim.claim_token,
            "request_key":key,"plan":plan});
        async move { ads::plan_submit(d, a, input(body)).await }
    };
    let ad = || {
        json!({"name":"Bir","material_ids":[t.image],"primary_text":"Yeni sezon başlıyor",
            "headline":"Kayıtlar açık","hypothesis_id":t.w.f.slot.chain.hypothesis_id})
    };
    let plan = |account: CapabilityId, ads: Vec<Value>| {
        json!({"ad_account":account,"result":"link_click",
            "destination":{"kind":"website","url":"https://ornek.example/kayit"},
            "audience":{"countries":["TR"]},
            "end_at":at(FIXED_NOW + Duration::days(7)),
            "ads":ads,"summary":"Kayıt sayfasına trafik",
            "audience_summary":"Türkiye'deki X kullanıcıları"})
    };
    let limits = || {
        // X names no least budget.
        x.push_account_limits(Ok(AdAccountLimits {
            currency: "TRY".into(),
            minor_unit_exponent: 2,
            timezone: "Europe/Istanbul".into(),
            min_daily_budget_minor: 0,
            min_total_budget_minor: 0,
        }));
    };
    let not_taken = "field_not_for_this_platform";

    // An X ad is a text of at most 280 characters and a card title of at most 70: no
    // description, no button, no page.
    for (field, value, reason) in [
        ("description", json!("Kısa açıklama"), not_taken),
        ("call_to_action", json!("LEARN_MORE"), not_taken),
        ("page", json!(t.page), not_taken),
        (
            "primary_text",
            json!("x".repeat(281)),
            "1_to_280_characters",
        ),
        ("headline", json!("x".repeat(71)), "1_to_70_characters"),
        ("headline", json!(""), "1_to_70_characters"),
        // The card carries the address: the post's text carries no link of its own.
        (
            "primary_text",
            json!("Kayıt için: https://ornek.example/kayit"),
            "no_link",
        ),
        ("primary_text", json!("Kayıt: www.ornek.example"), "no_link"),
        ("material_ids", json!([]), "one_image"),
    ] {
        let mut p = plan(account, vec![ad()]);
        p["ads"][0][field] = value;
        let e = submit(&format!("x-{field}-{reason}"), p).await.unwrap_err();
        assert_eq!(
            refused_field(&e),
            (format!("ads[0].{field}"), reason.to_owned()),
            "{field}"
        );
    }
    let mut aged = plan(account, vec![ad()]);
    aged["audience"]["age_min"] = json!(25);
    let e = submit("x-age", aged).await.unwrap_err();
    assert_eq!(
        refused_field(&e),
        ("audience.age_min".into(), not_taken.into())
    );
    assert_eq!(t.get(c.id).await.refused, 0);
    assert!(x.calls().is_empty());

    // An ads account whose sign-in may only read names the permission that is missing.
    let read_only = connection(&t.w, "x_ads", "18ce54d4x5u", &["tweet.read", "ads.read"]).await;
    let e = submit("x-read-only", plan(read_only, vec![ad()]))
        .await
        .unwrap_err();
    assert!(
        e.details["findings"].as_array().unwrap().contains(
            &json!({"field":"ad_account","reason":"credential_scope_missing",
                "needs":["ads.write"]})
        ),
        "{e:?}"
    );
    assert!(x.calls().is_empty());
    // An image a card does not take is a finding too.
    let gif = image_of(&t.w, b"GIF89a", "image/gif").await;
    let mut other = ad();
    other["material_ids"] = json!([gif]);
    limits();
    let e = submit("x-gif", plan(account, vec![other]))
        .await
        .unwrap_err();
    assert!(
        e.details["findings"]
            .as_array()
            .unwrap()
            .iter()
            .any(|f| f["reason"] == "image_type_not_taken"
                && f["takes"] == json!(["image/jpeg", "image/png"])),
        "{e:?}"
    );

    // The plan that holds: the campaign, the line item, the image, the card, the promoted post.
    const CAMPAIGN: &str = "xa:18ce54d4x5t:campaign:hwtbm";
    const LINE: &str = "xa:18ce54d4x5t:line:8v7jo";
    const AD: &str = "xa:18ce54d4x5t:ad:8v7jo:1822333526255120384";
    limits();
    x.push_find_by_name(Ok(None));
    x.push_create_campaign(Ok(CAMPAIGN.into()));
    x.push_find_by_name(Ok(None));
    x.push_create_adset(Ok(LINE.into()));
    x.push_upload_image(Ok("3_1880028106020515840".into()));
    x.push_find_by_name(Ok(None));
    x.push_create_creative(Ok("card://1321554298900107264".into()));
    x.push_find_by_name(Ok(None));
    x.push_create_ad(Ok(AD.into()));
    for _ in 0..3 {
        x.push_set_status(Ok(()));
    }
    let built = submit("x-good", plan(account, vec![ad()])).await.unwrap();
    assert_eq!(Ads::state(&built), CampaignState::InReview);
    let b = built.built.as_ref().unwrap();
    assert_eq!(b.platform, AdsPlatform::X);
    assert!(b.activated_at.is_some());
    let calls = x.calls();
    let made = calls
        .iter()
        .find_map(|c| match c {
            ConnectorCall::CreateAd { spec, .. } => Some(spec.clone()),
            _ => None,
        })
        .unwrap();
    assert_eq!(made.adset_id, LINE);
    assert_eq!(made.creative_id, "card://1321554298900107264");
    assert_eq!(made.creative.identity_id, None);
    assert_eq!(
        made.creative.image.as_deref(),
        Some("3_1880028106020515840")
    );
    assert_eq!(made.creative.primary_text, "Yeni sezon başlıyor");
    assert_eq!(made.creative.headline, "Kayıtlar açık");
    assert_eq!(made.creative.call_to_action, None);
    let statuses = || -> Vec<(String, AdStatus)> {
        x.calls()
            .into_iter()
            .filter_map(|c| match c {
                ConnectorCall::SetAdStatus {
                    entity_id, status, ..
                } => Some((entity_id, status)),
                _ => None,
            })
            .collect()
    };
    assert_eq!(
        statuses(),
        [
            (AD.to_owned(), AdStatus::Active),
            (LINE.to_owned(), AdStatus::Active),
            (CAMPAIGN.to_owned(), AdStatus::Active)
        ]
    );

    // X's own total is not a hard limit, and the campaign's rules say so.
    let detail = ads::campaign_get(&t.w.d, &t.w.ctx, input(json!({"campaign_id":c.id})))
        .await
        .unwrap();
    let rules = serde_json::to_value(&detail.platforms).unwrap();
    assert_eq!(rules[4]["platform"], "x");
    assert_eq!(rules[4]["account_kind"], "x_ads");
    assert_eq!(rules[4]["page_kind"], Value::Null);
    assert_eq!(rules[4]["primary_text"], 280);
    assert_eq!(rules[4]["headline"], 70);
    assert_eq!(rules[4]["description"], Value::Null);
    assert_eq!(rules[4]["calls_to_action"], json!([]));
    assert_eq!(rules[4]["image_types"], json!(["image/jpeg", "image/png"]));
    assert_eq!(rules[4]["no_link"], true);
    assert_eq!(rules[0]["no_link"], false);
    assert_eq!(rules[4]["hard_budget_cap"], false);
    assert_eq!(rules[4]["watch_minutes"], 15);
    for other in 0..4 {
        assert_eq!(rules[other]["hard_budget_cap"], true, "{other}");
        assert_eq!(rules[other]["watch_minutes"], 60, "{other}");
    }

    // The first reading: a third of the budget is spent.
    let reads = || {
        x.calls()
            .iter()
            .filter(|c| matches!(c, ConnectorCall::CampaignState { .. }))
            .count()
    };
    let says = |spent: i64| {
        x.push_campaign_state(Ok(CampaignProviderState {
            campaign: ProviderAdStatus::Active,
            ads: vec![ProviderAd {
                ad_id: AD.into(),
                name: "1822333526255120384".into(),
                status: ProviderAdStatus::Active,
                feedback: None,
            }],
        }));
        x.push_ad_days(Ok(vec![day(AD, 0, spent, Some(12))]));
    };
    says(20_000);
    watch_all(&t.w.d, t.w.f.ws, FIXED_NOW + Duration::minutes(1))
        .await
        .unwrap();
    assert_eq!(reads(), 1);
    // Nine minutes later it is not read again; fifteen minutes after the first reading it is
    // (an hour would pass on a platform whose own limit is a hard one).
    watch_all(&t.w.d, t.w.f.ws, FIXED_NOW + Duration::minutes(10))
        .await
        .unwrap();
    assert_eq!(reads(), 1);
    // By then X reports more than the budget: all of it is recorded, the campaign ends and is
    // paused at X.
    says(61_500);
    x.push_set_status(Ok(()));
    let later = FIXED_NOW + Duration::minutes(16);
    watch_all(&t.w.d, t.w.f.ws, later).await.unwrap();
    assert_eq!(reads(), 2);
    let ctx = Ctx {
        now: later,
        ..t.w.ctx.clone()
    };
    let ended = ads::campaign_get(&t.w.d, &ctx, input(json!({"campaign_id":c.id})))
        .await
        .unwrap()
        .campaign;
    assert_eq!(ended.ended.as_ref().unwrap().reason, EndReason::BudgetSpent);
    assert_eq!(ended.totals.as_ref().unwrap().spent_minor, 61_500);
    assert_eq!(ended.recorded_spend_minor, 61_500);
    assert_eq!(
        statuses().last().unwrap(),
        &(CAMPAIGN.to_owned(), AdStatus::Paused)
    );
}
