//! A connected account's own posts (`social.own_posts`, `social.own_post_image`): the
//! permission and the connector check of every read, the counters a grant without insights
//! cannot read, the connector's error mapping, a kind that lists nothing, and the image handed
//! over in memory. The provider is a scripted connector (the Meta adapter's own calls are tested
//! against the Graph mock in `jt_meta/tests/own_posts.rs`).
#[path = "support/studio.rs"]
mod support;

use std::collections::{BTreeMap, BTreeSet};

use base64::Engine as _;
use jt_app::ctx::Ctx;
use jt_app::error::ErrorCode;
use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::{
    Media, OwnPost, OwnPostKind, OwnPostsPage, OwnPostsQuery, Unavailable, Url,
};
use jt_app::usecases::social::own_posts::{
    MAX_OWN_POST_IMAGE_BYTES, OwnPostImageInput, OwnPostsInput, own_post_image, own_posts,
};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{ConnectorError, Credential};
use jt_ledger::Actor;
use jt_tenancy::{AgentConnectionId, Permission, UserId};
use jt_testkit::fakes::FIXED_NOW;
use serde_json::{Value, json};

/// The Instagram account's id.
const IG: &str = "17841400000000001";

/// Adds a verified Instagram account whose grant holds `scopes` and whose public fields carry
/// `extra`; its id.
async fn instagram(w: &support::World, scopes: &[&str], extra: Value) -> CapabilityId {
    let mut public = json!({"access": {"scopes": scopes, "expires_at": null}});
    if let (Some(p), Some(e)) = (public.as_object_mut(), extra.as_object()) {
        for (k, v) in e {
            p.insert(k.clone(), v.clone());
        }
    }
    let mut c = Capability::new(
        CapabilityId::new_v7(),
        w.f.ws,
        NewCapability {
            kind_key: "instagram".into(),
            name: "Instagram".into(),
            external_id: Some(IG.into()),
            connector_public: public,
            ..Default::default()
        },
        FIXED_NOW,
    )
    .unwrap();
    c.status = StoredStatus::Verified;
    c.last_verified_at = Some(FIXED_NOW);
    let cred = Credential::PageToken {
        page_id: "1234567890".into(),
        token: "page-token".into(),
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

/// An agent of the workspace holding `permissions`.
fn agent(w: &support::World, permissions: &[Permission]) -> Ctx {
    Ctx {
        workspace_id: w.f.ws,
        actor: Actor::Agent {
            connection_id: AgentConnectionId::new_v7(),
            user_id: UserId::new_v7(),
        },
        permissions: permissions.iter().copied().collect::<BTreeSet<_>>(),
        role_key: Some("owner".into()),
        now: FIXED_NOW,
        agent_connection_id: Some(AgentConnectionId::new_v7()),
    }
}

fn input(capability_id: CapabilityId, limit: Option<u32>, cursor: Option<&str>) -> OwnPostsInput {
    serde_json::from_value(json!({
        "capability_id": capability_id, "limit": limit, "cursor": cursor,
    }))
    .unwrap()
}

fn page() -> OwnPostsPage {
    OwnPostsPage {
        posts: vec![OwnPost {
            id: "18000000000000002".into(),
            permalink: Some(Url::parse("https://www.instagram.com/p/AAA2/").unwrap()),
            kind: OwnPostKind::Image,
            caption: Some("Yeni ürünümüz hazır.".into()),
            published_at: Some(FIXED_NOW),
            items: None,
            metrics: BTreeMap::from([("likes".into(), 42), ("comments".into(), 0)]),
        }],
        next_cursor: Some("QVFIUmFh".into()),
        unavailable: BTreeMap::from([("reach".into(), Unavailable::PermissionNotGranted)]),
    }
}

#[tokio::test]
async fn a_content_agent_reads_a_page_of_the_accounts_own_posts() {
    let w = support::world().await;
    let id = instagram(
        &w,
        &["instagram_basic", "instagram_manage_insights"],
        json!({}),
    )
    .await;
    w.ads.push_own_posts(Ok(Some(page())));
    let out = own_posts(
        &w.d,
        &agent(&w, &[Permission::ContentWork]),
        input(id, None, None),
    )
    .await
    .unwrap();
    // The default page, the insights asked for (the grant holds the read scope).
    assert_eq!(
        w.ads.own_posts_calls(),
        [OwnPostsQuery {
            limit: 30,
            cursor: None,
            insights: true
        }]
    );
    assert_eq!(out.kind, "instagram");
    assert_eq!(out.next_cursor.as_deref(), Some("QVFIUmFh"));
    let wire = serde_json::to_value(&out).unwrap();
    let post = &wire["posts"][0];
    assert_eq!(post["post_id"], "18000000000000002");
    assert_eq!(post["kind"], "image");
    assert_eq!(post["permalink"], "https://www.instagram.com/p/AAA2/");
    // A zero the platform gave stays zero; a number it did not give is null, and named.
    assert_eq!(post["numbers"]["likes"], 42);
    assert_eq!(post["numbers"]["comments"], 0);
    assert_eq!(post["numbers"]["reach"], Value::Null);
    assert_eq!(
        wire["unavailable"],
        json!({"reach": "permission_not_granted"})
    );

    // A social agent too, with the next page's cursor and its own limit.
    w.ads.push_own_posts(Ok(Some(OwnPostsPage::default())));
    own_posts(
        &w.d,
        &agent(&w, &[Permission::SocialWork]),
        input(id, Some(50), Some("QVFIUmFh")),
    )
    .await
    .unwrap();
    assert_eq!(
        w.ads.own_posts_calls()[1],
        OwnPostsQuery {
            limit: 50,
            cursor: Some("QVFIUmFh".into()),
            insights: true
        }
    );
}

#[tokio::test]
async fn every_read_passes_the_permission_and_the_connector_check() {
    let w = support::world().await;
    let id = instagram(
        &w,
        &["instagram_basic", "instagram_manage_insights"],
        json!({}),
    )
    .await;
    let content = agent(&w, &[Permission::ContentWork]);

    // Neither a content nor a social permission: refused before anything is read.
    let e = own_posts(
        &w.d,
        &agent(&w, &[Permission::InboxWork]),
        input(id, None, None),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);
    let e = own_post_image(
        &w.d,
        &agent(&w, &[Permission::AdsWork]),
        OwnPostImageInput {
            capability_id: id,
            post_id: "18000000000000002".into(),
            index: 0,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Forbidden);

    // Limits and an unknown account.
    for limit in [0, 51] {
        let e = own_posts(&w.d, &content, input(id, Some(limit), None))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Validation, "{limit}");
    }
    let e = own_posts(&w.d, &content, input(CapabilityId::new_v7(), None, None))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);

    // A connection that needs reconnecting, and one whose access expired.
    for (extra, reason) in [
        (
            json!({"reconnect_required": true}),
            "capability_unavailable",
        ),
        (
            json!({"access": {"scopes": ["instagram_manage_insights"], "expires_at": "2020-01-01T00:00:00Z"}}),
            "access_expired",
        ),
    ] {
        let dead = instagram(&w, &["instagram_basic"], extra).await;
        let e = own_posts(&w.d, &content, input(dead, None, None))
            .await
            .unwrap_err();
        assert_eq!(e.code, ErrorCode::Conflict, "{reason}");
        assert_eq!(e.details["reason"], reason);
    }
    assert!(
        w.ads.own_posts_calls().is_empty(),
        "nothing reached the provider"
    );

    // A grant without the insights scope still lists, without asking for the counters.
    let basic = instagram(&w, &["instagram_basic"], json!({})).await;
    w.ads.push_own_posts(Ok(Some(OwnPostsPage::default())));
    own_posts(&w.d, &content, input(basic, None, None))
        .await
        .unwrap();
    assert!(!w.ads.own_posts_calls()[0].insights);
}

#[tokio::test]
async fn a_providers_refusal_is_the_connectors_error_mapping() {
    let w = support::world().await;
    let id = instagram(
        &w,
        &["instagram_basic", "instagram_manage_insights"],
        json!({}),
    )
    .await;
    let content = agent(&w, &[Permission::ContentWork]);
    // An expired token: the platform no longer accepts the login.
    w.ads.push_own_posts(Err(ConnectorError::auth(
        "(#190) Error validating access token",
    )));
    let e = own_posts(&w.d, &content, input(id, None, None))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::Validation);
    assert_eq!(e.details["provider"], "meta");
    assert_eq!(e.details["provider_error"], "auth");
    // A throttle: the platform is busy, try later.
    w.ads.push_own_posts(Err(ConnectorError::throttle(Some(
        time::Duration::seconds(60),
    ))));
    let e = own_posts(&w.d, &content, input(id, None, None))
        .await
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::UpstreamUnavailable);
    assert_eq!(e.details["retry_after_s"], 60);
}

#[tokio::test]
async fn a_kind_that_lists_nothing_is_refused() {
    let w = support::world().await;
    // The fixture's X account: its connector lists no own posts (the port's default).
    let x = w.f.slot.capability_id;
    let e = own_posts(
        &w.d,
        &agent(&w, &[Permission::SocialWork]),
        input(x, None, None),
    )
    .await
    .unwrap_err();
    assert_eq!(e.code, ErrorCode::Conflict);
    assert_eq!(e.details["reason"], "own_posts_not_supported");
    // An Instagram connector that gives no image for the post.
    let id = instagram(
        &w,
        &["instagram_basic", "instagram_manage_insights"],
        json!({}),
    )
    .await;
    let e = own_post_image(
        &w.d,
        &agent(&w, &[Permission::SocialWork]),
        OwnPostImageInput {
            capability_id: id,
            post_id: "18000000000000002".into(),
            index: 0,
        },
    )
    .await
    .unwrap_err();
    assert_eq!(e.details["reason"], "own_post_image_not_supported");
}

#[tokio::test]
async fn a_posts_image_is_handed_over_in_memory() {
    let w = support::world().await;
    let id = instagram(
        &w,
        &["instagram_basic", "instagram_manage_insights"],
        json!({}),
    )
    .await;
    let content = agent(&w, &[Permission::ContentWork]);
    let bytes = b"\x89PNG\r\n\x1a\nimage".to_vec();
    w.ads.push_own_post_image(Ok(Some(Media {
        mime: "image/png".into(),
        data: bytes.clone(),
    })));
    let image = own_post_image(
        &w.d,
        &content,
        OwnPostImageInput {
            capability_id: id,
            post_id: "17900000000000009".into(),
            index: 2,
        },
    )
    .await
    .unwrap();
    assert_eq!(
        w.ads.own_post_image_calls(),
        [("17900000000000009".to_owned(), 2, MAX_OWN_POST_IMAGE_BYTES)]
    );
    assert_eq!(image.mime_type, "image/png");
    assert_eq!(image.bytes, bytes.len());
    assert_eq!(
        base64::engine::general_purpose::STANDARD
            .decode(&image.data)
            .unwrap(),
        bytes
    );
    // Its Debug never prints the image.
    assert!(!format!("{image:?}").contains(&image.data));

    // A post id that is not one, an index past a carousel's last item.
    for (post_id, index) in [("../me", 0), ("", 0), ("17900000000000009", 20)] {
        let e = own_post_image(
            &w.d,
            &content,
            OwnPostImageInput {
                capability_id: id,
                post_id: post_id.into(),
                index,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(e.code, ErrorCode::Validation, "{post_id} {index}");
    }
}
