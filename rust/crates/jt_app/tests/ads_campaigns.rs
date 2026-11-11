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
            AdAccountLimits, AdDay, AdLevel, AdStatus, CampaignProviderState, ProviderAd,
            ProviderAdStatus,
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
use jt_connector::{ConnectorError, Credential};
use jt_ledger::Actor;
use jt_studio::*;
use jt_tenancy::{AgentConnectionId, WorkspaceStatus};
use jt_testkit::fakes::{ConnectorCall, FIXED_NOW, FixedClock, files::MemoryFiles};
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
    let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
    bytes.extend(Uuid::now_v7().as_bytes());
    let file: StoredFile =
        w.d.files
            .put(
                w.f.ws,
                FileId::new_v7(),
                MediaUpload {
                    bytes,
                    mime: "image/png".into(),
                    filename: "ad.png".into(),
                },
            )
            .await
            .unwrap();
    let olay = jt_testkit::studio_contract::confirmed_olay(w.f.ws);
    let m = jt_testkit::studio_contract::eligible_material(&olay, file.id);
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
async fn campaign_store_contract() {
    let t = ads_world().await;
    let other = jt_testkit::studio_contract::ready(&t.w.uow).await;
    jt_testkit::ads_contract::exercise(&t.w.uow, t.w.f.ws, other.ws).await;
}
