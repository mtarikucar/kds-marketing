//! The public links through the gate (plan L5-T2; spec 2026-10-30-leads-pool-outreach-design.md
//! §3.14, D20, D63), over the in-memory fakes and `jt_app`'s outreach world: the confirmation
//! page never unsubscribes; a one-click `POST` (RFC 8058) or the page's form unsubscribes without
//! cookies, once; a link that does not hold is the same `404` page with nothing written; a
//! suspended workspace still unsubscribes, an erased recipient learns nothing; a click is a
//! `302` to the email's link, automated when it is a `HEAD`, lacks a `User-Agent` or comes
//! within 60 seconds of the send; nothing about the client is stored. Every value is invented.

#[path = "../../../jt_app/tests/support/outreach.rs"]
mod outreach_support;
#[path = "../../../jt_app/tests/support/mod.rs"]
mod support;

use std::sync::Arc;

use axum::Router;
use axum::body::{Body, to_bytes};
use axum::http::{Method, Request, StatusCode, header};
use axum::response::Response;
use jt_app::ports::UnitOfWork;
use jt_app::ports::connectors::MailMessage;
use jt_app::usecases::outreach::{self, links};
use jt_inbox::{Channel, ConsentKind, PersonId, SuppressionReason};
use jt_outreach::{CampaignId, EnrollmentStatus, MacPurpose, StopReason};
use jt_tenancy::WorkspaceStatus;
use jt_testkit::fakes::{FIXED_NOW, FixedClock};
use jt_webhook::links::{PAGE_POLICY, UNSUBSCRIBE_BODY_LIMIT};
use jt_webhook::{WebhookState, router};
use outreach_support::*;
use serde_json::json;
use support::*;
use time::{Duration, OffsetDateTime};
use tower::ServiceExt;

/// The gate over `w`'s ports, its clock at `now`.
fn gate(w: &World, now: OffsetDateTime) -> Router {
    let mut deps = w.deps.clone();
    deps.clock = Arc::new(FixedClock(now));
    router(WebhookState {
        deps: Arc::new(deps),
    })
}

/// `url` (a public link) as the path a request names.
fn path(url: &str) -> String {
    url.strip_prefix("https://panel.test")
        .unwrap_or_else(|| panic!("{url}"))
        .to_owned()
}

async fn call(app: &Router, req: Request<Body>) -> (StatusCode, header::HeaderMap, String) {
    let resp: Response = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, headers, String::from_utf8(bytes.to_vec()).unwrap())
}

fn get(path: &str) -> Request<Body> {
    Request::get(path)
        .header(header::USER_AGENT, "Mozilla/5.0 (test)")
        .body(Body::empty())
        .unwrap()
}

/// RFC 8058's one-click `POST`, as a mail client sends it (no cookie, no token).
fn one_click(path: &str) -> Request<Body> {
    Request::post(path)
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .body(Body::from("List-Unsubscribe=One-Click"))
        .unwrap()
}

/// A running two-step campaign (the second five days later) reaching `people`, its first step
/// sent to each from `FIXED_NOW` on, from a template whose body is `body`.
async fn sent(o: &Outreach, people: &[PersonId], body: &str, click_tracking: bool) -> CampaignId {
    let w = &o.w;
    let t = template(w, &w.owner_ctx, "Merhaba", body).await;
    let mut d = definition_steps(&[(t, 0), (t, 5)], json!({ "explicit": people }));
    d.click_tracking = click_tracking;
    let c = running(o, d).await;
    // One a minute (the campaign's pacing at 60 an hour).
    for m in 0..people.len() {
        o.mail.push_mail(accepted("s"));
        dispatch(w, FIXED_NOW + Duration::minutes(m as i64)).await;
    }
    assert_eq!(sent_mail(&o.mail).len(), people.len());
    c.campaign.id
}

/// The one-click address of `mail`.
fn unsubscribe_path(mail: &MailMessage) -> String {
    path(&mail.list_unsubscribe.as_ref().unwrap().https)
}

/// The click links of `text`, as paths.
fn click_paths(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter(|w| w.starts_with("https://panel.test/c/"))
        .map(path)
        .collect()
}

fn enrollment(w: &World, c: CampaignId) -> jt_app::ports::outreach::EnrollmentRow {
    enrollments(w, c).pop().unwrap()
}

fn suppressed(w: &World, person: PersonId) -> bool {
    w.uow.snapshot().inbox.suppressions.iter().any(|(_, s)| {
        s.person_id == person
            && s.channel == Channel::Email
            && s.reason == SuppressionReason::Unsubscribe
    })
}

fn withdrawals(w: &World, person: PersonId) -> usize {
    w.uow
        .snapshot()
        .inbox
        .consents
        .iter()
        .filter(|(_, c)| c.person_id == person && c.kind == ConsentKind::Withdrawn)
        .count()
}

/// Everything a link could write: the inbox's and outreach's tables and the ledger.
fn state(w: &World) -> String {
    let s = w.uow.snapshot();
    format!("{:?} {:?} {:?}", s.inbox, s.outreach, s.ledger)
}

/// Asserts a page's headers: HTML, never stored, no referrer, the page's strict policy.
fn assert_page_headers(headers: &header::HeaderMap) {
    assert_eq!(headers[header::CONTENT_TYPE], "text/html; charset=utf-8");
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
    assert_eq!(headers[header::CONTENT_SECURITY_POLICY], PAGE_POLICY);
    assert!(headers.get(header::SET_COOKIE).is_none());
}

#[tokio::test]
async fn get_shows_page_and_never_unsubscribes() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = sent(&o, &[ada], "Tanışmak isteriz.", false).await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let before = state(w);
    let app = gate(w, FIXED_NOW);
    let (status, headers, body) = call(&app, get(&unsubscribe_path(&mail))).await;
    assert_eq!(status, StatusCode::OK);
    assert_page_headers(&headers);
    assert!(body.contains("<html lang=\"tr\">"), "{body}");
    assert!(body.contains("<form method=\"post\">"), "{body}");
    assert!(body.contains("<input type=\"hidden\" name=\"List-Unsubscribe\" value=\"One-Click\">"));
    assert!(body.contains("Acme Yazılım A.Ş. e-postalarını"), "{body}");
    assert!(!body.contains("ada@example.invalid") && !body.contains("Ada"));
    // A HEAD (a scanner's prefetch) is the same page.
    let head = Request::head(unsubscribe_path(&mail))
        .body(Body::empty())
        .unwrap();
    assert_eq!(call(&app, head).await.0, StatusCode::OK);
    assert_eq!(state(w), before, "nothing written");
    assert_eq!(enrollment(w, c).status, EnrollmentStatus::Active);
}

#[tokio::test]
async fn post_one_click_unsubscribes_without_cookies() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = sent(&o, &[ada], "Tanışmak isteriz.", false).await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let (status, headers, body) =
        call(&gate(w, FIXED_NOW), one_click(&unsubscribe_path(&mail))).await;
    assert_eq!(status, StatusCode::OK);
    assert_page_headers(&headers);
    assert!(body.contains("Abonelikten çıktınız"), "{body}");
    assert!(suppressed(w, ada));
    assert_eq!(withdrawals(w, ada), 1);
    assert_eq!(enrollment(w, c).stop, Some(StopReason::Unsubscribed));
    assert_eq!(sends(w)[0].unsubscribed_at, Some(FIXED_NOW));
}

#[tokio::test]
async fn post_from_page_form_unsubscribes() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = sent(&o, &[ada], "Tanışmak isteriz.", false).await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let app = gate(w, FIXED_NOW);
    let at = unsubscribe_path(&mail);
    let (_, _, page) = call(&app, get(&at)).await;
    // The form names no action: the browser posts its one field to the page's own address.
    assert!(!page.contains("action="));
    let field = "name=\"List-Unsubscribe\" value=\"One-Click\"";
    assert!(page.contains(field));
    let form = Request::post(at.as_str())
        .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded")
        .header(header::ORIGIN, "https://panel.test")
        .body(Body::from("List-Unsubscribe=One-Click"))
        .unwrap();
    let (status, _, body) = call(&app, form).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("Abonelikten çıktınız"));
    assert!(suppressed(w, ada));
    assert_eq!(enrollment(w, c).stop, Some(StopReason::Unsubscribed));
}

#[tokio::test]
async fn repeat_post_is_idempotent() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    sent(&o, &[ada], "Tanışmak isteriz.", false).await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let app = gate(w, FIXED_NOW);
    assert_eq!(
        call(&app, one_click(&unsubscribe_path(&mail))).await.0,
        StatusCode::OK
    );
    let once = state(w);
    let later = gate(w, FIXED_NOW + Duration::hours(1));
    let (status, _, body) = call(&later, one_click(&unsubscribe_path(&mail))).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("Abonelikten çıktınız"));
    assert_eq!(state(w), once, "a repeat writes nothing");
    assert_eq!(w.entries("outreach.unsubscribed").len(), 1);
    assert_eq!(withdrawals(w, ada), 1);
}

#[tokio::test]
async fn bad_mac_is_404_and_writes_nothing() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    sent(
        &o,
        &[ada],
        "Kataloğumuz: https://acme.example.invalid/katalog",
        true,
    )
    .await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let good = unsubscribe_path(&mail);
    let (prefix, mac) = good.rsplit_once('/').unwrap();
    let token = prefix.rsplit('/').next().unwrap().to_owned();
    let mut changed = mac.to_owned();
    changed.replace_range(..1, if mac.starts_with('A') { "B" } else { "A" });
    let click_mac = links::mac(
        &w.deps,
        w.ws,
        MacPurpose::Click,
        token.parse().unwrap(),
        None,
    )
    .unwrap();
    let (other, _) = w.other_workspace().await;
    let before = state(w);
    let app = gate(w, FIXED_NOW);
    for bad in [
        format!("{prefix}/{changed}"),
        format!("{prefix}/{click_mac}"),
        format!("{prefix}/{}", &mac[..mac.len() - 1]),
        good.replace(&token, &format!("urn:uuid:{token}")),
        good.replace(&token, &token.replace('-', "")),
        good.replace(&w.ws.to_string(), &other.to_string()),
        good.replace(&w.ws.to_string(), "not-a-workspace"),
        good.replace(&token, "%FF"),
    ] {
        let (status, headers, body) = call(&app, get(&bad)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{bad}");
        assert!(body.contains("This link is not valid."), "{bad}: {body}");
        assert!(
            headers
                .get(header::CONTENT_TYPE)
                .is_none_or(|v| v == "text/html; charset=utf-8")
        );
        let (status, _, _) = call(&app, one_click(&bad)).await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{bad}");
    }
    // A click link with another link's index, or an unsubscribe MAC, is the same 404.
    let click = click_paths(&mail.text).pop().unwrap();
    let (cprefix, cmac) = click.rsplit_once('/').unwrap();
    let (base, _) = cprefix.rsplit_once('/').unwrap();
    for bad in [format!("{base}/1/{cmac}"), format!("{cprefix}/{mac}")] {
        assert_eq!(
            call(&app, get(&bad)).await.0,
            StatusCode::NOT_FOUND,
            "{bad}"
        );
    }
    // A path the routes do not match is no answer of theirs, and writes nothing either.
    for bad in [format!("{prefix}/"), format!("{good}/extra")] {
        assert_eq!(
            call(&app, get(&bad)).await.0,
            StatusCode::NOT_FOUND,
            "{bad}"
        );
        assert_eq!(
            call(&app, one_click(&bad)).await.0,
            StatusCode::NOT_FOUND,
            "{bad}"
        );
    }
    assert_eq!(state(w), before, "nothing written");
    assert!(!suppressed(w, ada));
}

#[tokio::test]
async fn unknown_send_is_404() {
    let o = outreach_world().await;
    let w = &o.w;
    let token = uuid::Uuid::from_u128(4242);
    let mac = links::mac(&w.deps, w.ws, MacPurpose::Unsubscribe, token, None).unwrap();
    let click_mac = links::mac(&w.deps, w.ws, MacPurpose::Click, token, Some(0)).unwrap();
    let app = gate(w, FIXED_NOW);
    let before = state(w);
    let unsubscribe = format!("/u/{}/{token}/{mac}", w.ws);
    assert_eq!(call(&app, get(&unsubscribe)).await.0, StatusCode::NOT_FOUND);
    assert_eq!(
        call(&app, one_click(&unsubscribe)).await.0,
        StatusCode::NOT_FOUND
    );
    let click = format!("/c/{}/{token}/0/{click_mac}", w.ws);
    assert_eq!(call(&app, get(&click)).await.0, StatusCode::NOT_FOUND);
    assert_eq!(state(w), before);
}

#[tokio::test]
async fn suspended_workspace_still_unsubscribes() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let c = sent(&o, &[ada], "Tanışmak isteriz.", false).await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let mut p = w.uow.platform().await.unwrap();
    p.workspace_set_status(
        w.ws,
        WorkspaceStatus::Suspended,
        "test status transition",
        &jt_ledger::Actor::System {
            component: "test".into(),
        },
    )
    .await
    .unwrap();
    p.commit().await.unwrap();
    let app = gate(w, FIXED_NOW);
    assert_eq!(
        call(&app, get(&unsubscribe_path(&mail))).await.0,
        StatusCode::OK
    );
    assert_eq!(
        call(&app, one_click(&unsubscribe_path(&mail))).await.0,
        StatusCode::OK
    );
    assert!(suppressed(w, ada));
    assert_eq!(withdrawals(w, ada), 1);
    assert_eq!(enrollment(w, c).stop, Some(StopReason::Unsubscribed));
}

#[tokio::test]
async fn erased_person_answers_200_and_reveals_nothing() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    let bora = consented_bora(w).await;
    sent(&o, &[ada, bora], "Tanışmak isteriz.", false).await;
    let mails = sent_mail(&o.mail);
    let (to_ada, to_bora) = if mails[0].to == "ada@example.invalid" {
        (&mails[0], &mails[1])
    } else {
        (&mails[1], &mails[0])
    };
    jt_app::usecases::inbox::erasure::erase(
        &w.deps,
        &w.owner_ctx,
        ada,
        serde_json::from_value(json!({"confirm": true})).unwrap(),
    )
    .await
    .unwrap();
    let before = state(w);
    let app = gate(w, FIXED_NOW);
    let (status, _, erased_page) = call(&app, get(&unsubscribe_path(to_ada))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _, erased_done) = call(&app, one_click(&unsubscribe_path(to_ada))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(state(w), before, "nothing to do");
    // The same pages as anyone else's: nothing says the person is gone.
    let (_, _, page) = call(&app, get(&unsubscribe_path(to_bora))).await;
    let (_, _, done) = call(&app, one_click(&unsubscribe_path(to_bora))).await;
    assert_eq!((erased_page, erased_done), (page, done));
    assert!(suppressed(w, bora));
}

/// Bora, consented, at `bora@example.invalid`.
async fn consented_bora(w: &World) -> PersonId {
    let p = person(w, "Bora", "bora@example.invalid").await;
    consent_email(w, p).await;
    p
}

#[tokio::test]
async fn click_redirects_to_snapshot_link() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    sent(
        &o,
        &[ada],
        "Kataloğumuz: https://acme.example.invalid/katalog?ref=ekim",
        true,
    )
    .await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let click = click_paths(&mail.text).pop().expect("a rewritten link");
    let at = FIXED_NOW + Duration::minutes(3);
    let (status, headers, body) = call(&gate(w, at), get(&click)).await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(
        headers[header::LOCATION],
        "https://acme.example.invalid/katalog?ref=ekim"
    );
    assert_eq!(headers[header::CACHE_CONTROL], "no-store");
    assert_eq!(headers[header::REFERRER_POLICY], "no-referrer");
    assert!(body.is_empty());
    let send = sends(w).pop().unwrap();
    assert_eq!(
        (send.clicks, send.automated_clicks, send.first_clicked_at),
        (1, 0, Some(at))
    );
}

#[tokio::test]
async fn click_unknown_link_is_404() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    sent(
        &o,
        &[ada],
        "Kataloğumuz: https://acme.example.invalid/katalog",
        true,
    )
    .await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let token = mail.message_id[1..].split('@').next().unwrap().to_owned();
    let app = gate(w, FIXED_NOW + Duration::minutes(3));
    // Link 3 of a one-link email, its MAC holding; and an index written with a leading zero.
    let mac3 = links::mac(
        &w.deps,
        w.ws,
        MacPurpose::Click,
        token.parse().unwrap(),
        Some(3),
    )
    .unwrap();
    let mac0 = links::mac(
        &w.deps,
        w.ws,
        MacPurpose::Click,
        token.parse().unwrap(),
        Some(0),
    )
    .unwrap();
    for bad in [
        format!("/c/{}/{token}/3/{mac3}", w.ws),
        format!("/c/{}/{token}/00/{mac0}", w.ws),
        format!("/c/{}/{token}/+0/{mac0}", w.ws),
        format!("/c/{}/{token}/x/{mac0}", w.ws),
    ] {
        assert_eq!(
            call(&app, get(&bad)).await.0,
            StatusCode::NOT_FOUND,
            "{bad}"
        );
    }
    let send = sends(w).pop().unwrap();
    assert_eq!(send.clicks + send.automated_clicks, 0);
}

#[tokio::test]
async fn click_within_60s_is_automated() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    sent(
        &o,
        &[ada],
        "Kataloğumuz: https://acme.example.invalid/katalog",
        true,
    )
    .await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let click = click_paths(&mail.text).pop().unwrap();
    // A link scanner opening it as the email arrives: redirected, counted as automated.
    let (status, _, _) = call(&gate(w, FIXED_NOW + Duration::seconds(30)), get(&click)).await;
    assert_eq!(status, StatusCode::FOUND);
    // A request without a User-Agent, later: automated too.
    let bare = Request::get(click.as_str()).body(Body::empty()).unwrap();
    let (status, _, _) = call(&gate(w, FIXED_NOW + Duration::minutes(10)), bare).await;
    assert_eq!(status, StatusCode::FOUND);
    let send = sends(w).pop().unwrap();
    assert_eq!(
        (send.clicks, send.automated_clicks, send.first_clicked_at),
        (0, 2, None)
    );
    // At 60 seconds it is a person's.
    call(&gate(w, FIXED_NOW + Duration::seconds(60)), get(&click)).await;
    assert_eq!(sends(w).pop().unwrap().clicks, 1);
}

#[tokio::test]
async fn head_is_automated() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    sent(
        &o,
        &[ada],
        "Kataloğumuz: https://acme.example.invalid/katalog",
        true,
    )
    .await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let click = click_paths(&mail.text).pop().unwrap();
    let head = Request::builder()
        .method(Method::HEAD)
        .uri(click.as_str())
        .header(header::USER_AGENT, "Mozilla/5.0 (test)")
        .body(Body::empty())
        .unwrap();
    let (status, headers, _) = call(&gate(w, FIXED_NOW + Duration::hours(1)), head).await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(
        headers[header::LOCATION],
        "https://acme.example.invalid/katalog"
    );
    let send = sends(w).pop().unwrap();
    assert_eq!((send.clicks, send.automated_clicks), (0, 1));
}

#[tokio::test]
async fn a_suspended_workspace_still_redirects_and_records_nothing() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    sent(
        &o,
        &[ada],
        "Kataloğumuz: https://acme.example.invalid/katalog",
        true,
    )
    .await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let click = click_paths(&mail.text).pop().unwrap();
    let mut p = w.uow.platform().await.unwrap();
    p.workspace_set_status(
        w.ws,
        WorkspaceStatus::Suspended,
        "test status transition",
        &jt_ledger::Actor::System {
            component: "test".into(),
        },
    )
    .await
    .unwrap();
    p.commit().await.unwrap();
    let before = state(w);
    let (status, headers, _) = call(&gate(w, FIXED_NOW + Duration::hours(1)), get(&click)).await;
    assert_eq!(status, StatusCode::FOUND);
    assert_eq!(
        headers[header::LOCATION],
        "https://acme.example.invalid/katalog"
    );
    assert_eq!(state(w), before);
}

#[tokio::test]
async fn no_client_data_stored() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    sent(
        &o,
        &[ada],
        "Kataloğumuz: https://acme.example.invalid/katalog",
        true,
    )
    .await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let click = click_paths(&mail.text).pop().unwrap();
    let app = gate(w, FIXED_NOW + Duration::hours(1));
    let marked = |req: axum::http::request::Builder| {
        req.header(header::USER_AGENT, "Zq7UniqueAgent/9.1")
            .header("x-forwarded-for", "203.0.113.77")
            .header("x-real-ip", "203.0.113.78")
            .header(header::COOKIE, "jeeta_session=zq7cookie")
            .header(header::REFERER, "https://zq7referer.example.invalid/")
    };
    let (status, _, _) = call(
        &app,
        marked(Request::get(click.as_str()))
            .body(Body::empty())
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::FOUND);
    let (status, _, _) = call(
        &app,
        marked(Request::post(unsubscribe_path(&mail)))
            .body(Body::from("List-Unsubscribe=One-Click"))
            .unwrap(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(suppressed(w, ada));
    let everything = format!("{:?}", w.uow.snapshot());
    for mark in [
        "Zq7UniqueAgent",
        "203.0.113.77",
        "203.0.113.78",
        "zq7cookie",
        "zq7referer",
    ] {
        assert!(!everything.contains(mark), "{mark} was stored");
    }
}

#[tokio::test]
async fn an_unsubscribe_body_over_1_kib_is_413_and_writes_nothing() {
    let o = outreach_world().await;
    let w = &o.w;
    let ada = consented(w).await;
    sent(&o, &[ada], "Tanışmak isteriz.", false).await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let before = state(w);
    let big = Request::post(unsubscribe_path(&mail))
        .body(Body::from("x".repeat(UNSUBSCRIBE_BODY_LIMIT + 1)))
        .unwrap();
    let (status, _, _) = call(&gate(w, FIXED_NOW), big).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(state(w), before);
    // Any body within the limit is taken (a mail client may encode it otherwise).
    let other = Request::post(unsubscribe_path(&mail))
        .body(Body::from("x".repeat(UNSUBSCRIBE_BODY_LIMIT)))
        .unwrap();
    assert_eq!(call(&gate(w, FIXED_NOW), other).await.0, StatusCode::OK);
    assert!(suppressed(w, ada));
}

#[tokio::test]
async fn the_pages_escape_the_sender_company_and_follow_the_footer_language() {
    let o = outreach_world().await;
    let w = &o.w;
    {
        let mut r = w.uow.tenant(w.ws).await.unwrap();
        r.workspace_policy()
            .patch_leads(
                json!({"outreach": {"sender_company": "Acme <b>&\"Ortak'</b>"}}),
                w.owner_ctx.now,
            )
            .await
            .unwrap();
        r.commit().await.unwrap();
    }
    let ada = consented(w).await;
    let t = outreach::templates_save(
        &w.deps,
        &w.owner_ctx,
        jt_app::usecases::outreach::TemplateSaveInput {
            template_id: None,
            expected_revision: None,
            name: "Intro".into(),
            language: jt_outreach::Lang::En,
            subject: "Hello".into(),
            body: "We would like to meet.".into(),
            request_key: None,
        },
    )
    .await
    .unwrap()
    .template
    .id;
    running(&o, definition(t, json!({ "explicit": [ada] }))).await;
    o.mail.push_mail(accepted("s"));
    dispatch(w, FIXED_NOW).await;
    let mail = sent_mail(&o.mail).pop().unwrap();
    let app = gate(w, FIXED_NOW);
    let (_, _, page) = call(&app, get(&unsubscribe_path(&mail))).await;
    assert!(page.contains("<html lang=\"en\">"), "{page}");
    assert!(
        page.contains("emails from Acme &lt;b&gt;&amp;&quot;Ortak&#39;&lt;/b&gt;,"),
        "{page}"
    );
    assert!(!page.contains("<b>"));
    let (_, _, done) = call(&app, one_click(&unsubscribe_path(&mail))).await;
    assert!(done.contains("You are unsubscribed"), "{done}");
    assert!(!done.contains("<b>"));
}
