//! An Instagram account's own posts (`InsightsReader::own_posts`, `own_post_image`) against the
//! in-process Graph mock: the fields and the insights expansion asked for, paging, a grant
//! without the insights permission, a dead login, a kind that lists nothing, and a post's image
//! read from the CDN without a token.

mod support;

use jt_app::ports::connectors::{InsightsReader, OwnPostKind, OwnPostsQuery, Unavailable};
use jt_app::ports::connectors::{Media, OwnershipCheck, PostImage};
use jt_connector::{ConnectorError, Credential};
use jt_meta::INSTAGRAM_SCOPES;
use serde_json::{Value, json};
use support::*;
use time::{Duration, OffsetDateTime};

const PAGE: &str = "1234567890";
const PAGE_TOKEN: &str = "EAAB-page-1234567890";
const IG: &str = "17841400000000001";
const IG_LOGIN_TOKEN: &str = "IGAA-long-test";
const MEDIA: &str = "/fb/v19.0/17841400000000001/media";

fn page_cred() -> Credential {
    Credential::PageToken {
        page_id: PAGE.into(),
        token: PAGE_TOKEN.into(),
    }
}

fn ig_login_cred() -> Credential {
    Credential::OAuth {
        access_token: IG_LOGIN_TOKEN.into(),
        refresh_token: None,
        expires_at: Some(OffsetDateTime::now_utc() + Duration::days(50)),
        scopes: INSTAGRAM_SCOPES.iter().map(|s| (*s).to_owned()).collect(),
    }
}

fn public(kind: &str) -> Value {
    json!({ "provider": "meta", "kind_key": kind, "external_id": IG })
}

fn query(limit: u32, cursor: Option<&str>, insights: bool) -> OwnPostsQuery {
    OwnPostsQuery {
        limit,
        cursor: cursor.map(str::to_owned),
        insights,
    }
}

fn graph_error(code: i64, message: &str) -> Reply {
    status(
        400,
        json!({ "error": { "message": message, "type": "OAuthException", "code": code } }),
    )
}

fn insights(reach: i64, saved: i64, shares: i64, views: Option<i64>) -> Value {
    let mut data = vec![
        json!({"name": "reach", "period": "lifetime", "values": [{"value": reach}]}),
        json!({"name": "saved", "period": "lifetime", "values": [{"value": saved}]}),
        json!({"name": "shares", "period": "lifetime", "values": [{"value": shares}]}),
    ];
    if let Some(views) = views {
        data.push(json!({"name": "views", "period": "lifetime", "values": [{"value": views}]}));
    }
    json!({ "data": data })
}

/// A first page of two (an image and a reel, each with insights) and a last page of one
/// carousel.
fn script_pages(mock: &Mock) {
    let next = format!("{}/v19.0/{IG}/media?after=QVFIUmFh", mock.base("/fb"));
    mock.on(
        "GET",
        MEDIA,
        ok(json!({
            "data": [
                {"id": "18000000000000002", "caption": "Yeni ürünümüz hazır.", "media_type": "IMAGE",
                 "media_product_type": "FEED", "permalink": "https://www.instagram.com/p/AAA2/",
                 "timestamp": "2026-11-20T10:00:00+0000", "like_count": 42, "comments_count": 3,
                 "insights": insights(900, 12, 4, Some(1500))},
                {"id": "18000000000000001", "caption": "Atölyeden bir gün.", "media_type": "VIDEO",
                 "media_product_type": "REELS", "permalink": "https://www.instagram.com/reel/AAA1/",
                 "timestamp": "2026-11-18T08:30:00+0000", "like_count": 120, "comments_count": 9,
                 "insights": insights(4000, 50, 30, Some(9000))},
                {"id": "not a graph id", "media_type": "IMAGE"}
            ],
            "paging": {"cursors": {"before": "QVFIUmJi", "after": "QVFIUmFh"}, "next": next}
        })),
    );
    mock.on(
        "GET",
        MEDIA,
        ok(json!({
            "data": [
                {"id": "17900000000000009", "media_type": "CAROUSEL_ALBUM",
                 "media_product_type": "FEED", "permalink": "https://www.instagram.com/p/AAA0/",
                 "timestamp": "2025-01-02T12:00:00+0000", "like_count": 7, "comments_count": 0,
                 "children": {"data": [{"id": "1"}, {"id": "2"}, {"id": "3"}]},
                 "insights": insights(300, 1, 0, None)}
            ],
            "paging": {"cursors": {"before": "QVFIUmNj", "after": "QVFIUmRk"}}
        })),
    );
}

#[tokio::test]
async fn own_posts_page_through_the_media_list_with_their_counters() {
    let r = rig().await;
    script_pages(&r.mock);
    let first = r
        .meta
        .own_posts(&page_cred(), &public("instagram"), &query(2, None, true))
        .await
        .unwrap()
        .expect("Instagram lists its posts");
    let call = r.mock.request("GET", MEDIA);
    assert_graph_auth(&call, PAGE_TOKEN);
    assert_eq!(call.param("limit"), Some("2"));
    assert_eq!(call.param("after"), None);
    let fields = call.param("fields").unwrap();
    assert!(fields.starts_with("id,caption,media_type,media_product_type,permalink,timestamp"));
    assert!(
        fields.ends_with(",insights.metric(reach,saved,shares,views)"),
        "{fields}"
    );

    // A post without a Graph id is left out; the others keep Graph's order (newest first).
    assert_eq!(first.posts.len(), 2);
    let image = &first.posts[0];
    assert_eq!(image.id, "18000000000000002");
    assert_eq!(image.kind, OwnPostKind::Image);
    assert_eq!(image.caption.as_deref(), Some("Yeni ürünümüz hazır."));
    assert_eq!(
        image.permalink.as_ref().map(|u| u.as_str()),
        Some("https://www.instagram.com/p/AAA2/")
    );
    assert_eq!(
        image.published_at.map(|t| t.unix_timestamp()),
        Some(1_795_168_800)
    );
    let numbers: Vec<(&str, i64)> = image
        .metrics
        .iter()
        .map(|(k, v)| (k.as_str(), *v))
        .collect();
    assert_eq!(
        numbers,
        [
            ("comments", 3),
            ("likes", 42),
            ("reach", 900),
            ("saves", 12),
            ("shares", 4),
            ("views", 1500)
        ]
    );
    assert_eq!(first.posts[1].kind, OwnPostKind::Reel);
    assert_eq!(first.next_cursor.as_deref(), Some("QVFIUmFh"));
    assert!(first.unavailable.is_empty(), "{:?}", first.unavailable);

    // The next page, from the cursor; the last one has none. Views no post of it has are named.
    r.mock.clear();
    let last = r
        .meta
        .own_posts(
            &page_cred(),
            &public("instagram"),
            &query(2, Some("QVFIUmFh"), true),
        )
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        r.mock.request("GET", MEDIA).param("after"),
        Some("QVFIUmFh")
    );
    assert_eq!(last.posts.len(), 1);
    assert_eq!(last.posts[0].kind, OwnPostKind::Carousel);
    assert_eq!(last.posts[0].items, Some(3));
    assert_eq!(last.posts[0].caption, None);
    assert_eq!(last.next_cursor, None);
    assert_eq!(
        last.unavailable.into_iter().collect::<Vec<_>>(),
        [("views".to_owned(), Unavailable::NotGiven)]
    );

    // At most 50 a page; a cursor that is not Graph's never reaches the query.
    r.mock.clear();
    r.meta
        .own_posts(&page_cred(), &public("instagram"), &query(500, None, true))
        .await
        .unwrap();
    assert_eq!(r.mock.requests("GET", MEDIA)[0].param("limit"), Some("50"));
    r.mock.clear();
    let bad = r
        .meta
        .own_posts(
            &page_cred(),
            &public("instagram"),
            &query(10, Some("a&b=c"), true),
        )
        .await
        .unwrap_err();
    assert!(matches!(bad, ConnectorError::Permanent { .. }), "{bad:?}");
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn an_instagram_login_token_lists_on_the_instagram_graph() {
    let r = rig().await;
    let path = format!("/ig/{IG}/media");
    r.mock.on("GET", &path, ok(json!({ "data": [] })));
    let page = r
        .meta
        .own_posts(
            &ig_login_cred(),
            &public("instagram"),
            &query(30, None, true),
        )
        .await
        .unwrap()
        .unwrap();
    let call = r.mock.request("GET", &path);
    assert_eq!(call.bearer(), Some(IG_LOGIN_TOKEN));
    assert_eq!(call.param("appsecret_proof"), None);
    assert!(page.posts.is_empty());
    assert_eq!(page.next_cursor, None);
    // No post: nothing is said to be missing.
    assert!(page.unavailable.is_empty());
}

#[tokio::test]
async fn without_the_insights_permission_the_counters_that_need_it_are_named_not_zeroed() {
    let r = rig().await;
    let post = json!({"id": "18000000000000002", "media_type": "IMAGE",
        "permalink": "https://www.instagram.com/p/AAA2/", "like_count": 5, "comments_count": 1});
    // Meta refuses the insights expansion (a grant without the permission): read again without.
    r.mock.on(
        "GET",
        MEDIA,
        graph_error(
            10,
            "(#10) Application does not have permission for this action",
        ),
    );
    r.mock
        .on("GET", MEDIA, ok(json!({ "data": [post.clone()] })));
    let page = r
        .meta
        .own_posts(&page_cred(), &public("instagram"), &query(30, None, true))
        .await
        .unwrap()
        .unwrap();
    let calls = r.mock.requests("GET", MEDIA);
    assert_eq!(calls.len(), 2);
    assert!(calls[0].param("fields").unwrap().contains("insights"));
    assert!(!calls[1].param("fields").unwrap().contains("insights"));
    assert_eq!(page.posts[0].metrics.get("likes"), Some(&5));
    assert_eq!(page.posts[0].metrics.get("reach"), None);
    let missing: Vec<(String, Unavailable)> = page.unavailable.into_iter().collect();
    assert_eq!(
        missing,
        ["reach", "saves", "shares", "views"]
            .map(|m| (m.to_owned(), Unavailable::PermissionNotGranted))
    );

    // A grant the use case already knows lacks it: one call, no insights asked for.
    r.mock.clear();
    r.mock.set("GET", MEDIA, ok(json!({ "data": [post] })));
    let page = r
        .meta
        .own_posts(&page_cred(), &public("instagram"), &query(30, None, false))
        .await
        .unwrap()
        .unwrap();
    let call = r.mock.request("GET", MEDIA);
    assert!(!call.param("fields").unwrap().contains("insights"));
    assert_eq!(
        page.unavailable.get("reach"),
        Some(&Unavailable::PermissionNotGranted)
    );
}

#[tokio::test]
async fn a_dead_login_a_throttle_and_another_kind() {
    let r = rig().await;
    // An expired or revoked token is Auth, not retried without insights.
    r.mock.set(
        "GET",
        MEDIA,
        graph_error(190, "Error validating access token"),
    );
    let e = r
        .meta
        .own_posts(&page_cred(), &public("instagram"), &query(30, None, true))
        .await
        .unwrap_err();
    assert!(matches!(e, ConnectorError::Auth { .. }), "{e:?}");
    assert_eq!(r.mock.requests("GET", MEDIA).len(), 1);
    assert!(!format!("{e}").contains(PAGE_TOKEN));

    r.mock.clear();
    r.mock.set(
        "GET",
        MEDIA,
        graph_error(4, "Application request limit reached"),
    );
    let e = r
        .meta
        .own_posts(&page_cred(), &public("instagram"), &query(30, None, true))
        .await
        .unwrap_err();
    assert!(matches!(e, ConnectorError::Throttle { .. }), "{e:?}");

    // A Facebook Page lists nothing here, and nothing is asked.
    r.mock.clear();
    for kind in ["facebook_page", "whatsapp_cloud"] {
        let page = r
            .meta
            .own_posts(&page_cred(), &public(kind), &query(30, None, true))
            .await
            .unwrap();
        assert_eq!(page, None, "{kind}");
        let image = r
            .meta
            .own_post_image(&page_cred(), &public(kind), "18000000000000002", 0, 1 << 20)
            .await
            .unwrap();
        assert_eq!(image, None, "{kind}");
    }
    assert!(r.mock.recorded().is_empty());
}

/// A GIF's first bytes (ASCII, so the mock's text body carries them as they are).
const GIF: &str = "GIF89a-test-image";

#[tokio::test]
async fn a_posts_image_is_read_from_the_cdn_without_a_token() {
    let r = rig().await;
    let node = "/fb/v19.0/17900000000000009";
    let cdn = |name: &str| format!("{}/{name}", r.mock.base("/cdn"));
    r.mock.on(
        "GET",
        node,
        ok(json!({
            "media_type": "CAROUSEL_ALBUM",
            "owner": {"id": IG},
            "children": {"data": [
                {"media_type": "IMAGE", "media_url": cdn("one.jpg")},
                {"media_type": "VIDEO", "media_url": cdn("two.mp4"), "thumbnail_url": cdn("two.jpg")}
            ]}
        })),
    );
    r.mock.on(
        "GET",
        "/cdn/two.jpg",
        Reply {
            status: 200,
            headers: vec![("content-type".into(), "image/jpeg".into())],
            body: GIF.to_owned(),
        },
    );
    let image = r
        .meta
        .own_post_image(
            &page_cred(),
            &public("instagram"),
            "17900000000000009",
            1,
            1 << 20,
        )
        .await
        .unwrap()
        .map(media)
        .expect("an Instagram post has an image");
    let found = r.mock.request("GET", node);
    assert_graph_auth(&found, PAGE_TOKEN);
    assert_eq!(
        found.param("fields"),
        Some(
            "media_type,media_url,thumbnail_url,owner{id},username,\
             children{media_type,media_url,thumbnail_url}"
        )
    );
    // A video's cover; the type is what the bytes are, not what the header says.
    let fetched = r.mock.request("GET", "/cdn/two.jpg");
    assert_eq!(fetched.bearer(), None);
    assert_eq!(fetched.header("authorization"), None);
    assert_eq!(image.mime, "image/gif");
    assert_eq!(image.data, GIF.as_bytes());

    // An item past the carousel's end, an index on a single post, a body that is not an image,
    // one over the size allowed.
    for (index, what) in [(2, "past the end")] {
        let e = r
            .meta
            .own_post_image(
                &page_cred(),
                &public("instagram"),
                "17900000000000009",
                index,
                1 << 20,
            )
            .await
            .unwrap_err();
        assert!(
            matches!(e, ConnectorError::Permanent { .. }),
            "{what}: {e:?}"
        );
    }
    r.mock.set(
        "GET",
        node,
        ok(json!({"media_type": "IMAGE", "media_url": cdn("one.jpg"), "owner": {"id": IG}})),
    );
    let e = r
        .meta
        .own_post_image(
            &page_cred(),
            &public("instagram"),
            "17900000000000009",
            1,
            1 << 20,
        )
        .await
        .unwrap_err();
    assert!(matches!(e, ConnectorError::Permanent { .. }), "{e:?}");
    r.mock
        .on("GET", "/cdn/one.jpg", raw(200, "<html>not an image</html>"));
    let e = r
        .meta
        .own_post_image(
            &page_cred(),
            &public("instagram"),
            "17900000000000009",
            0,
            1 << 20,
        )
        .await
        .unwrap_err();
    assert!(matches!(e, ConnectorError::Permanent { .. }), "{e:?}");
    let e = r
        .meta
        .own_post_image(
            &page_cred(),
            &public("instagram"),
            "17900000000000009",
            0,
            4,
        )
        .await
        .unwrap_err();
    assert!(matches!(e, ConnectorError::Permanent { .. }), "{e:?}");
}

/// An image a single post names at `media_url`, owned by `owner`.
fn single(owner: &str, media_url: &str) -> Reply {
    ok(json!({"media_type": "IMAGE", "media_url": media_url, "owner": {"id": owner}}))
}

const NODE: &str = "/fb/v19.0/18000000000000002";

/// The image of a post found to be the account's (panics on a refusal of ownership).
fn media(found: PostImage) -> Media {
    match found {
        PostImage::Image(media) => media,
        PostImage::NotTheAccounts(check) => panic!("taken as another account's: {check:?}"),
    }
}

async fn image_of(r: &Rig, max_bytes: usize) -> Result<Option<PostImage>, ConnectorError> {
    r.meta
        .own_post_image(
            &page_cred(),
            &public("instagram"),
            "18000000000000002",
            0,
            max_bytes,
        )
        .await
}

#[tokio::test]
async fn addresses_off_the_cdn_are_refused() {
    let r = rig().await;
    // An address off Meta's hosts, plain http to the CDN, another port: never reached.
    for url in [
        "https://images.example/1.jpg",
        "http://scontent.cdninstagram.com/1.jpg",
        "https://scontent.cdninstagram.com:8443/1.jpg",
    ] {
        r.mock.set("GET", NODE, single(IG, url));
        let e = image_of(&r, 1 << 20).await.unwrap_err();
        assert!(
            matches!(e, ConnectorError::Permanent { .. }),
            "{url}: {e:?}"
        );
    }
}

#[tokio::test]
async fn a_cdn_redirect_is_refused_not_followed() {
    let r = rig().await;
    let moved = format!("{}/moved", r.mock.base("/cdn"));
    r.mock.set(
        "GET",
        NODE,
        single(IG, &format!("{}/gif", r.mock.base("/cdn"))),
    );
    r.mock.on(
        "GET",
        "/cdn/gif",
        raw(302, "").with_header("location", &moved),
    );
    r.mock.on("GET", "/cdn/moved", raw(200, GIF));
    let e = image_of(&r, 1 << 20).await.unwrap_err();
    assert!(matches!(e, ConnectorError::Permanent { .. }), "{e:?}");
    assert!(r.mock.requests("GET", "/cdn/moved").is_empty());
}

/// A server that answers every request with a chunked body (no `Content-Length`) of `size` bytes
/// starting as a GIF does.
async fn chunked_server(size: usize) -> std::net::SocketAddr {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut request = Vec::new();
                let mut buf = [0; 1024];
                while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => request.extend_from_slice(&buf[..n]),
                    }
                }
                let mut out = b"HTTP/1.1 200 OK\r\ncontent-type: image/gif\r\n\
                    transfer-encoding: chunked\r\nconnection: close\r\n\r\n"
                    .to_vec();
                let mut body = b"GIF89a".to_vec();
                body.resize(size, b'x');
                for chunk in body.chunks(1000) {
                    out.extend_from_slice(format!("{:x}\r\n", chunk.len()).as_bytes());
                    out.extend_from_slice(chunk);
                    out.extend_from_slice(b"\r\n");
                }
                out.extend_from_slice(b"0\r\n\r\n");
                let _ = socket.write_all(&out).await;
            });
        }
    });
    addr
}

#[tokio::test]
async fn the_size_cap_holds_without_a_content_length() {
    let mock = Mock::start().await;
    let cdn = chunked_server(10_000).await;
    let egress = std::sync::Arc::new(
        jt_outbound::Egress::new(jt_outbound::FIXED_HOSTS)
            .with_test_hosts([("meta", mock.host()), ("meta", cdn.to_string())]),
    );
    let meta = jt_meta::MetaConnector::new(
        egress,
        bases(&mock),
        std::sync::Arc::new(TestApps::default()),
    );
    mock.set("GET", NODE, single(IG, &format!("http://{cdn}/gif")));
    let (cred, account) = (page_cred(), public("instagram"));
    let read = |max: usize| meta.own_post_image(&cred, &account, "18000000000000002", 0, max);
    // Over the cap: refused while it is read, never whole in memory.
    let e = read(4_096).await.unwrap_err();
    assert!(matches!(e, ConnectorError::Permanent { .. }), "{e:?}");
    // Within it: read whole.
    let image = media(read(1 << 20).await.unwrap().unwrap());
    assert_eq!(image.data.len(), 10_000);
    assert_eq!(image.mime, "image/gif");
}

#[tokio::test]
async fn a_cursor_graph_refuses_is_not_tried_again_without_insights() {
    let r = rig().await;
    r.mock.set(
        "GET",
        MEDIA,
        graph_error(100, "(#100) The after cursor is invalid"),
    );
    let e = r
        .meta
        .own_posts(
            &page_cred(),
            &public("instagram"),
            &query(30, Some("QVFIUmFh"), true),
        )
        .await
        .unwrap_err();
    assert!(matches!(e, ConnectorError::Permanent { .. }), "{e:?}");
    assert_eq!(r.mock.requests("GET", MEDIA).len(), 1);
    // A metric Meta does not give is: read again without views, then it answers.
    r.mock.clear();
    r.mock.set(
        "GET",
        MEDIA,
        graph_error(100, "(#100) The metric views is not supported"),
    );
    r.mock.on("GET", MEDIA, ok(json!({"data": []})));
    r.meta
        .own_posts(&page_cred(), &public("instagram"), &query(30, None, true))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r.mock.requests("GET", MEDIA).len(), 2);
}

/// The ids of one Instagram Login account: the professional `user_id` the connection stores, and
/// the app-scoped `id` Graph may name a post's owner with.
const APP_SCOPED: &str = "9000000000000001";
const IG_NODE: &str = "/ig/18000000000000002";
const OTHER: &str = "17841400000000999";

fn ig_public() -> Value {
    json!({ "provider": "meta", "kind_key": "instagram", "external_id": IG,
            "username": "test_atolye", "login": "instagram" })
}

/// A single image post as Graph names it: `owner` (an id, or none) and `username` (or none).
fn post(r: &Rig, owner: Option<&str>, username: Option<&str>) -> Reply {
    let mut answer =
        json!({"media_type": "IMAGE", "media_url": format!("{}/gif", r.mock.base("/cdn"))});
    if let Some(owner) = owner {
        answer["owner"] = json!({ "id": owner });
    }
    if let Some(username) = username {
        answer["username"] = json!(username);
    }
    ok(answer)
}

#[tokio::test]
async fn a_post_is_the_accounts_by_any_of_its_ids_or_its_username() {
    let r = rig().await;
    r.mock.on("GET", "/cdn/gif", raw(200, GIF));
    let me = ok(json!({"id": APP_SCOPED, "user_id": IG, "username": "Test_Atolye"}));
    r.mock.set("GET", "/ig/me", me);
    let (cred, account) = (ig_login_cred(), ig_public());
    let read = || {
        r.meta
            .own_post_image(&cred, &account, "18000000000000002", 0, 1 << 20)
    };

    // The owner id is the id the connection stored: taken at once, no identity read.
    r.mock.set("GET", IG_NODE, post(&r, Some(IG), None));
    media(read().await.unwrap().unwrap());
    assert!(r.mock.requests("GET", "/ig/me").is_empty());

    // The owner id is the account's other id (the app-scoped one): the live identity, read with
    // the same token, has it.
    r.mock.clear();
    r.mock.set("GET", IG_NODE, post(&r, Some(APP_SCOPED), None));
    media(read().await.unwrap().unwrap());
    let identity = r.mock.request("GET", "/ig/me");
    assert_eq!(identity.param("fields"), Some("id,user_id,username"));
    assert_eq!(identity.bearer(), Some(IG_LOGIN_TOKEN));

    // No owner id, the post's username is the account's (case aside).
    r.mock
        .set("GET", IG_NODE, post(&r, None, Some("TEST_ATOLYE")));
    media(read().await.unwrap().unwrap());

    // No owner id and another username: refused, and its image never read.
    r.mock.clear();
    r.mock
        .set("GET", IG_NODE, post(&r, None, Some("someone_else")));
    let refused = read().await.unwrap().unwrap();
    assert_eq!(
        refused,
        PostImage::NotTheAccounts(OwnershipCheck {
            owner_id_present: false,
            username_present: true,
            account_ids: 2,
            account_username_present: true,
            identity_read: true,
        })
    );
    assert!(r.mock.requests("GET", "/cdn/gif").is_empty());

    // Another account's owner id and username: refused.
    r.mock
        .set("GET", IG_NODE, post(&r, Some(OTHER), Some("someone_else")));
    let PostImage::NotTheAccounts(check) = read().await.unwrap().unwrap() else {
        panic!("another account's post was taken");
    };
    assert!(check.owner_id_present && check.username_present);
    assert!(r.mock.requests("GET", "/cdn/gif").is_empty());
}

#[tokio::test]
async fn a_page_linked_account_reads_its_identity_through_the_page() {
    let r = rig().await;
    r.mock.on("GET", "/cdn/gif", raw(200, GIF));
    let account = format!("/fb/v19.0/{IG}");
    // The connection stored no username; the account's own node gives it.
    r.mock.set("GET", NODE, post(&r, None, Some("test_atolye")));
    r.mock.set(
        "GET",
        &account,
        ok(json!({"id": IG, "username": "test_atolye"})),
    );
    media(image_of(&r, 1 << 20).await.unwrap().unwrap());
    let read = r.mock.request("GET", &account);
    assert_graph_auth(&read, PAGE_TOKEN);
    assert_eq!(read.param("fields"), Some("id,username"));

    // A post of another account: refused. An identity read Meta refuses leaves what the
    // connection stored, which does not match either.
    r.mock.set("GET", NODE, post(&r, Some(OTHER), None));
    r.mock.set(
        "GET",
        &account,
        status(
            400,
            json!({"error": {"message": "(#100) no", "type": "OAuthException", "code": 100}}),
        ),
    );
    let PostImage::NotTheAccounts(check) = image_of(&r, 1 << 20).await.unwrap().unwrap() else {
        panic!("another account's post was taken");
    };
    assert_eq!(
        check,
        OwnershipCheck {
            owner_id_present: true,
            username_present: false,
            account_ids: 1,
            account_username_present: false,
            identity_read: false,
        }
    );
    assert!(r.mock.requests("GET", "/cdn/gif").is_empty());
}
