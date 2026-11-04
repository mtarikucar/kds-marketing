//! The public links every commercial email carries (spec 2026-10-30-leads-pool-outreach-design.md
//! §3.14, D62, D63): the one-click unsubscribe and the click redirect, for the email's recipient,
//! who has no session. The MAC in the path is the only proof; the use cases
//! (`jt_app::usecases::outreach::links`) check it in constant time before anything is read.
//!
//! | Route | Answers |
//! |---|---|
//! | `GET /u/{workspace_id}/{token}/{mac}` | `200`, a small page (the email's footer language) whose one button POSTs to the same address; never unsubscribes |
//! | `POST /u/{workspace_id}/{token}/{mac}` | RFC 8058 one-click (`List-Unsubscribe=One-Click`) or the page's form: unsubscribes (idempotent, whatever the workspace's status) and answers `200` with a small page; a body over [`UNSUBSCRIBE_BODY_LIMIT`] is `413` |
//! | `GET`/`HEAD /c/{workspace_id}/{token}/{link}/{mac}` | `302` to the email's link `link`; a `HEAD`, a request without `User-Agent` and a click within 60 seconds of the send count as automated |
//!
//! A path that does not decode, a token or link index that is not canonical, a MAC that does not
//! hold, and a token of no email are all the same `404` page, with nothing written; an erased
//! recipient's unsubscribe is a `200` that writes nothing and says nothing about them. No cookie,
//! session or CSRF token is read (RFC 8058), and nothing about the client (address, agent string)
//! is stored or logged: the `User-Agent` is only seen to be present. A database failure is `503`.
//!
//! Every page is HTML with every inserted text escaped, `Cache-Control: no-store`,
//! `Referrer-Policy: no-referrer` and `Content-Security-Policy: default-src 'none'; style-src
//! 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'` (the server's security headers
//! keep a policy that forbids framing).

use axum::body::Body;
use axum::extract::rejection::PathRejection;
use axum::extract::{Path, State};
use axum::http::header::{
    CACHE_CONTROL, CONTENT_SECURITY_POLICY, CONTENT_TYPE, LOCATION, REFERRER_POLICY, USER_AGENT,
    X_CONTENT_TYPE_OPTIONS,
};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use jt_app::error::AppError;
use jt_app::usecases::outreach::links::{self, ClickFrom, Lang, LinkPage};
use jt_tenancy::WorkspaceId;

use crate::{WebhookState, raw};

/// The unsubscribe route's template.
pub(crate) const UNSUBSCRIBE_ROUTE: &str = "/u/{workspace_id}/{token}/{mac}";
/// The click redirect's template.
pub(crate) const CLICK_ROUTE: &str = "/c/{workspace_id}/{token}/{link}/{mac}";

/// The largest unsubscribe body read (RFC 8058's is 26 bytes); a larger one is `413`.
pub const UNSUBSCRIBE_BODY_LIMIT: usize = 1024;

/// The pages' content security policy: no script, no fetch, no frame; inline style; the form
/// posts to this origin only.
pub const PAGE_POLICY: &str =
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";

/// `text` with the five HTML-significant characters escaped.
pub fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// Sets the headers every answer of these routes carries.
fn private(headers: &mut HeaderMap) {
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(REFERRER_POLICY, HeaderValue::from_static("no-referrer"));
    headers.insert(X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
}

/// An HTML page: `status`, `lang`'s `<html lang>`, a title and the (already escaped) body.
fn page(status: StatusCode, lang: &str, title: &str, body: &str) -> Response {
    let html = format!(
        "<!doctype html>\n<html lang=\"{lang}\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <meta name=\"robots\" content=\"noindex\"><title>{title}</title>\
         <style>body{{font-family:system-ui,sans-serif;max-width:32rem;margin:3rem auto;\
         padding:0 1rem;line-height:1.5;color:#1b2430}}button{{font:inherit;padding:.6rem 1.2rem;\
         border:0;border-radius:.4rem;background:#1f4fd1;color:#fff;cursor:pointer}}</style>\
         </head><body><h1>{title}</h1>{body}</body></html>\n",
        title = escape(title),
    );
    let mut resp = (status, html).into_response();
    let headers = resp.headers_mut();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("text/html; charset=utf-8"),
    );
    headers.insert(
        CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(PAGE_POLICY),
    );
    private(headers);
    resp
}

/// The one answer to every link that does not hold (both languages: nothing says which).
fn not_found() -> Response {
    page(
        StatusCode::NOT_FOUND,
        "tr",
        "Bağlantı geçerli değil / Link not valid",
        "<p>Bu bağlantı geçerli değil.</p><p lang=\"en\">This link is not valid.</p>",
    )
}

/// A failure of the database: `503`, the request may be repeated; the log names only the code.
fn unavailable(route: &'static str, e: &AppError) -> Response {
    tracing::error!(
        route,
        code = e.code.as_str(),
        "a public link could not be served"
    );
    page(
        StatusCode::SERVICE_UNAVAILABLE,
        "tr",
        "Şu an yapılamadı / Not possible right now",
        "<p>Şu an yapılamadı; lütfen biraz sonra yeniden deneyin.</p>\
         <p lang=\"en\">This could not be done right now; please try again shortly.</p>",
    )
}

fn lang_key(lang: Lang) -> &'static str {
    match lang {
        Lang::Tr => "tr",
        Lang::En => "en",
    }
}

/// The confirmation page: one button that posts the one-click body to this same address.
fn confirm_page(p: &LinkPage) -> Response {
    let (title, text, button) = match (p.lang, &p.sender_company) {
        (Lang::Tr, Some(company)) => (
            "Abonelikten çık",
            format!(
                "{} e-postalarını artık almak istemiyorsanız aşağıdaki düğmeye basın.",
                escape(company)
            ),
            "Abonelikten çık",
        ),
        (Lang::Tr, None) => (
            "Abonelikten çık",
            "Bu e-postaları artık almak istemiyorsanız aşağıdaki düğmeye basın.".to_owned(),
            "Abonelikten çık",
        ),
        (Lang::En, Some(company)) => (
            "Unsubscribe",
            format!(
                "To stop receiving emails from {}, press the button below.",
                escape(company)
            ),
            "Unsubscribe",
        ),
        (Lang::En, None) => (
            "Unsubscribe",
            "To stop receiving these emails, press the button below.".to_owned(),
            "Unsubscribe",
        ),
    };
    let body = format!(
        "<p>{text}</p><form method=\"post\">\
         <input type=\"hidden\" name=\"List-Unsubscribe\" value=\"One-Click\">\
         <button type=\"submit\">{button}</button></form>",
        button = escape(button),
    );
    page(StatusCode::OK, lang_key(p.lang), title, &body)
}

/// The page after an unsubscribe.
fn done_page(p: &LinkPage) -> Response {
    let (title, text) = match (p.lang, &p.sender_company) {
        (Lang::Tr, Some(company)) => (
            "Abonelikten çıktınız",
            format!(
                "{} size bu adrese artık bu e-postaları göndermeyecek.",
                escape(company)
            ),
        ),
        (Lang::Tr, None) => (
            "Abonelikten çıktınız",
            "Bu adrese artık bu e-postalar gönderilmeyecek.".to_owned(),
        ),
        (Lang::En, Some(company)) => (
            "You are unsubscribed",
            format!(
                "{} will send no more of these emails to this address.",
                escape(company)
            ),
        ),
        (Lang::En, None) => (
            "You are unsubscribed",
            "No more of these emails will be sent to this address.".to_owned(),
        ),
    };
    page(
        StatusCode::OK,
        lang_key(p.lang),
        title,
        &format!("<p>{text}</p>"),
    )
}

/// `GET /u/…`: the confirmation page; never unsubscribes.
pub(crate) async fn unsubscribe_page(
    State(state): State<WebhookState>,
    path: Result<Path<(String, String, String)>, PathRejection>,
) -> Response {
    let Ok(Path((ws, token, mac))) = path else {
        return not_found();
    };
    let Ok(ws) = ws.parse::<WorkspaceId>() else {
        return not_found();
    };
    match links::unsubscribe_page(state.deps.as_ref(), ws, &token, &mac).await {
        Ok(Some(p)) => confirm_page(&p),
        Ok(None) => not_found(),
        Err(e) => unavailable("unsubscribe_page", &e),
    }
}

/// `POST /u/…`: the one-click unsubscribe (or the page's form). Any body within the limit is
/// taken: RFC 8058's `List-Unsubscribe=One-Click`, the form's (the same), or one a mail client
/// encodes otherwise; no cookie or token is asked for.
pub(crate) async fn unsubscribe(
    State(state): State<WebhookState>,
    path: Result<Path<(String, String, String)>, PathRejection>,
    body: Body,
) -> Response {
    let Ok(Path((ws, token, mac))) = path else {
        return not_found();
    };
    let Ok(ws) = ws.parse::<WorkspaceId>() else {
        return not_found();
    };
    if let Err(e) = raw::read(body, UNSUBSCRIBE_BODY_LIMIT).await {
        let mut resp = e.status().into_response();
        private(resp.headers_mut());
        return resp;
    }
    match links::unsubscribe(state.deps.as_ref(), ws, &token, &mac).await {
        Ok(Some(p)) => done_page(&p),
        Ok(None) => not_found(),
        Err(e) => unavailable("unsubscribe", &e),
    }
}

/// `GET`/`HEAD /c/…`: the click redirect.
pub(crate) async fn click(
    State(state): State<WebhookState>,
    method: Method,
    headers: HeaderMap,
    path: Result<Path<(String, String, String, String)>, PathRejection>,
) -> Response {
    let Ok(Path((ws, token, link, mac))) = path else {
        return not_found();
    };
    let Ok(ws) = ws.parse::<WorkspaceId>() else {
        return not_found();
    };
    let from = ClickFrom {
        head: method == Method::HEAD,
        user_agent: headers
            .get(USER_AGENT)
            .is_some_and(|v| !v.as_bytes().is_empty()),
    };
    match links::click(state.deps.as_ref(), ws, &token, &link, &mac, from).await {
        Ok(Some(to)) => {
            let Ok(location) = HeaderValue::from_str(&to) else {
                return not_found();
            };
            let mut resp = StatusCode::FOUND.into_response();
            let headers = resp.headers_mut();
            headers.insert(LOCATION, location);
            private(headers);
            resp
        }
        Ok(None) => not_found(),
        Err(e) => unavailable("click", &e),
    }
}
