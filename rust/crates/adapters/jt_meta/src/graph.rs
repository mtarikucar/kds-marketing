//! The Graph client: URLs, `appsecret_proof`, sending through the egress client, reading answers,
//! following paging links, and mapping Graph errors to [`ConnectorError`] (the crate docs hold the
//! table).

use hmac::{Hmac, KeyInit, Mac};
use jt_app::ports::connectors::MetaApp;
use jt_connector::{ConnectorError, Credential};
use jt_outbound::{EgressError, EgressScope, Method, Response, StatusCode, header};
use serde_json::Value;
use sha2::Sha256;
use time::Duration;
use url::Url;

use crate::MetaConnector;

/// The Graph API version used when the Meta app names none.
pub const DEFAULT_GRAPH_VERSION: &str = "v19.0";

/// The egress scope of every call.
const SCOPE: EgressScope = EgressScope::Connector("meta");

/// The largest answer read, in bytes; a larger one is `Permanent`.
const MAX_BODY_BYTES: usize = 4 << 20;

/// How many pages a paged read follows at most; more is `Permanent` (nothing is cut silently).
pub(crate) const MAX_PAGES: usize = 100;

/// The longest error reason kept, in characters.
const MAX_REASON_CHARS: usize = 300;

/// Graph codes that ask to slow down.
const THROTTLE_CODES: &[i64] = &[4, 17, 32, 613, 130_429, 131_048, 131_056];
/// Graph codes of a missing permission (beside the 200–299 range).
const PERMISSION_CODES: &[i64] = &[3, 10, 803];
/// Graph codes of a token no longer accepted.
const AUTH_CODES: &[i64] = &[190, 102, 104, 2500];
/// Graph subcodes of a token no longer accepted (expired, changed password, unconfirmed user,
/// logged out, revoked).
const AUTH_SUBCODES: &[i64] = &[458, 459, 460, 463, 464, 467];
/// Graph codes of a temporary failure.
const TRANSIENT_CODES: &[i64] = &[1, 2];

/// How a call authenticates.
#[derive(Clone, Copy)]
pub(crate) enum Auth<'a> {
    /// No token (an OAuth code or token exchange, which carries the app's own credentials).
    None,
    /// A token on `graph.facebook.com`: `Bearer`, and `appsecret_proof` under `secret`.
    Graph { token: &'a str, secret: &'a str },
    /// A token on `graph.instagram.com`: `Bearer` only.
    Bearer(&'a str),
}

/// A request body.
pub(crate) enum Body {
    Empty,
    Json(Value),
    Form(Vec<(String, String)>),
}

/// The Meta app's secret and Graph version, as one call needs them.
pub(crate) struct GraphApp {
    pub(crate) secret: String,
    pub(crate) version: String,
}

impl GraphApp {
    /// `app`'s secret and its Graph version (checked), or the default version.
    pub(crate) fn of(app: &MetaApp) -> Result<GraphApp, ConnectorError> {
        Ok(GraphApp {
            secret: app.app_secret.clone(),
            version: graph_version(app)?,
        })
    }

    /// Authentication with `token` on `graph.facebook.com`.
    pub(crate) fn auth<'a>(&'a self, token: &'a str) -> Auth<'a> {
        Auth::Graph {
            token,
            secret: &self.secret,
        }
    }
}

/// `app`'s Graph version (`v` and digits with one dot, e.g. `v19.0`), or
/// [`DEFAULT_GRAPH_VERSION`] when it names none; `Permanent` for anything else.
pub(crate) fn graph_version(app: &MetaApp) -> Result<String, ConnectorError> {
    let Some(version) = app.graph_version.as_deref().map(str::trim) else {
        return Ok(DEFAULT_GRAPH_VERSION.to_owned());
    };
    if version.is_empty() {
        return Ok(DEFAULT_GRAPH_VERSION.to_owned());
    }
    let valid = version.strip_prefix('v').is_some_and(|rest| {
        let mut parts = rest.split('.');
        let numeric = |p: Option<&str>| {
            p.is_some_and(|p| {
                !p.is_empty() && p.len() <= 3 && p.bytes().all(|b| b.is_ascii_digit())
            })
        };
        numeric(parts.next()) && numeric(parts.next()) && parts.next().is_none()
    });
    if valid {
        Ok(version.to_owned())
    } else {
        Err(ConnectorError::permanent(
            "the configured Graph API version is not of the form v19.0",
        ))
    }
}

/// `appsecret_proof`: lowercase hex HMAC-SHA256 of `token` under `secret`.
pub(crate) fn appsecret_proof(secret: &str, token: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes a key of any length");
    mac.update(token.as_bytes());
    let digest = mac.finalize().into_bytes();
    let mut out = String::with_capacity(64);
    for byte in digest.iter() {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// `id` when it can be a Graph node id in a path: 1 to 128 ASCII letters, digits, `_` or `-`;
/// else `Permanent` (so an id never changes the path it is put in).
pub(crate) fn node(id: &str) -> Result<&str, ConnectorError> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    if ok {
        Ok(id)
    } else {
        Err(ConnectorError::permanent("not a valid Graph id"))
    }
}

/// `base` with `segments` appended to its path, each one segment (percent-encoded), and `query`.
pub(crate) fn join(base: &Url, segments: &[&str], query: &[(&str, &str)]) -> Url {
    let mut url = base.clone();
    url.set_query(None);
    url.set_fragment(None);
    {
        let mut path = url
            .path_segments_mut()
            .expect("a Meta base URL has a path that segments can be pushed to");
        path.pop_if_empty();
        for segment in segments {
            path.push(segment);
        }
    }
    if !query.is_empty() {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in query {
            pairs.append_pair(name, value);
        }
    }
    url
}

/// `url` without the query parameters `names`.
fn without_params(url: &Url, names: &[&str]) -> Url {
    let kept: Vec<(String, String)> = url
        .query_pairs()
        .filter(|(k, _)| !names.contains(&k.as_ref()))
        .map(|(k, v)| (k.into_owned(), v.into_owned()))
        .collect();
    let mut out = url.clone();
    out.set_query(None);
    if !kept.is_empty() {
        out.query_pairs_mut().extend_pairs(kept);
    }
    out
}

/// A JSON value that is a string or an integer, as text (Graph ids come as either).
pub(crate) fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) if n.is_i64() || n.is_u64() => Some(n.to_string()),
        _ => None,
    }
}

/// A JSON value that is an integer, or a string of one, as `i64`.
pub(crate) fn integer(value: &Value) -> Option<i64> {
    match value {
        Value::Number(n) => n.as_i64(),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    }
}

/// `Permanent`: the answer lacks something the call needs.
pub(crate) fn missing(what: &str) -> ConnectorError {
    ConnectorError::permanent(format!("the provider's answer has no {what}"))
}

/// `Permanent`: the credential is not of a kind this call takes.
pub(crate) fn wrong_credential(cred: &Credential, what: &str) -> ConnectorError {
    ConnectorError::permanent(format!(
        "a {} credential cannot {what} on Meta",
        cred.kind()
    ))
}

impl MetaConnector {
    /// The Meta app, read now; `Permanent` when the platform has none.
    pub(crate) fn meta_app(&self) -> Result<MetaApp, ConnectorError> {
        self.apps
            .meta_app()
            .ok_or_else(|| ConnectorError::permanent("the Meta app is not configured"))
    }

    /// The Meta app's secret and Graph version, read now.
    pub(crate) fn graph_app(&self) -> Result<GraphApp, ConnectorError> {
        GraphApp::of(&self.meta_app()?)
    }

    /// `graph.facebook.com/<version>/<segments>?<query>`.
    pub(crate) fn graph_url(
        &self,
        version: &str,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Url {
        let mut all = Vec::with_capacity(segments.len() + 1);
        all.push(version);
        all.extend_from_slice(segments);
        join(&self.bases.graph, &all, query)
    }

    /// `graph.instagram.com/<segments>?<query>` (unversioned).
    pub(crate) fn instagram_url(&self, segments: &[&str], query: &[(&str, &str)]) -> Url {
        join(&self.bases.instagram_graph, segments, query)
    }

    /// GET `segments` on the Graph API with `token`, and its answer.
    pub(crate) async fn graph_get(
        &self,
        app: &GraphApp,
        token: &str,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<Value, ConnectorError> {
        let url = self.graph_url(&app.version, segments, query);
        self.call(Method::GET, url, app.auth(token), Body::Empty)
            .await
    }

    /// POST a JSON `body` to `segments` on the Graph API with `token`, and its answer.
    pub(crate) async fn graph_post(
        &self,
        app: &GraphApp,
        token: &str,
        segments: &[&str],
        query: &[(&str, &str)],
        body: Value,
    ) -> Result<Value, ConnectorError> {
        let url = self.graph_url(&app.version, segments, query);
        self.call(Method::POST, url, app.auth(token), Body::Json(body))
            .await
    }

    /// Every item of a paged Graph read starting at `segments`: the `data` arrays of each page,
    /// following `paging.next` (with the proof again, the token in the header) for up to
    /// [`MAX_PAGES`] pages.
    pub(crate) async fn graph_pages(
        &self,
        app: &GraphApp,
        token: &str,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<Vec<Value>, ConnectorError> {
        let first = self.graph_url(&app.version, segments, query);
        self.pages(first, app.auth(token)).await
    }

    /// Every item of a paged read starting at `first`, as [`MetaConnector::graph_pages`] does. A
    /// paging link to another origin than `first`'s is `Permanent` and not followed.
    pub(crate) async fn pages(
        &self,
        first: Url,
        auth: Auth<'_>,
    ) -> Result<Vec<Value>, ConnectorError> {
        let origin = first.origin();
        let mut url = first;
        let mut items = Vec::new();
        for _ in 0..MAX_PAGES {
            let page = self.call(Method::GET, url, auth, Body::Empty).await?;
            if let Some(data) = page["data"].as_array() {
                items.extend(data.iter().cloned());
            }
            let Some(next) = page["paging"]["next"].as_str() else {
                return Ok(items);
            };
            let next = Url::parse(next)
                .map_err(|_| ConnectorError::permanent("the paging link is not a URL"))?;
            if next.origin() != origin {
                return Err(ConnectorError::permanent(
                    "the paging link leads away from the API",
                ));
            }
            url = next;
        }
        Err(ConnectorError::permanent(format!(
            "the answer runs over more than {MAX_PAGES} pages"
        )))
    }

    /// GET `segments` on the Instagram Graph API with an Instagram Login `token`.
    pub(crate) async fn instagram_get(
        &self,
        token: &str,
        segments: &[&str],
        query: &[(&str, &str)],
    ) -> Result<Value, ConnectorError> {
        let url = self.instagram_url(segments, query);
        self.call(Method::GET, url, Auth::Bearer(token), Body::Empty)
            .await
    }

    /// POST a JSON `body` to `segments` on the Instagram Graph API with an Instagram Login
    /// `token`.
    pub(crate) async fn instagram_post(
        &self,
        token: &str,
        segments: &[&str],
        body: Value,
    ) -> Result<Value, ConnectorError> {
        let url = self.instagram_url(segments, &[]);
        self.call(Method::POST, url, Auth::Bearer(token), Body::Json(body))
            .await
    }

    /// Sends one call and reads its answer: the parsed JSON of a success, else the error it maps
    /// to. With a token, the token goes in the `Authorization` header and any `access_token` in
    /// `url` is taken out; on the Graph API `appsecret_proof` is set too (replacing one already
    /// there). Without one ([`Auth::None`]), `url` is sent as built: the token exchanges take
    /// their credentials in the query string.
    pub(crate) async fn call(
        &self,
        method: Method,
        url: Url,
        auth: Auth<'_>,
        body: Body,
    ) -> Result<Value, ConnectorError> {
        let (url, token) = match auth {
            Auth::None => (url, None),
            Auth::Graph { token, secret } => {
                let mut url = without_params(&url, &["access_token", "appsecret_proof"]);
                url.query_pairs_mut()
                    .append_pair("appsecret_proof", &appsecret_proof(secret, token));
                (url, Some(token))
            }
            Auth::Bearer(token) => (without_params(&url, &["access_token"]), Some(token)),
        };
        let mut request = self.egress.prepare(method, url);
        if let Some(token) = token {
            request = request.bearer(token);
        }
        request = match body {
            Body::Empty => request,
            Body::Json(json) => request.json(&json),
            Body::Form(form) => request.form(&form),
        };
        let response = request.send(SCOPE).await.map_err(egress_error)?;
        read(response).await
    }
}

/// An egress failure as a [`ConnectorError`] (no URL in it).
fn egress_error(e: EgressError) -> ConnectorError {
    match e {
        EgressError::Transport(err) if err.is_timeout() => {
            ConnectorError::transient("the call to Meta timed out")
        }
        EgressError::Transport(_) => {
            ConnectorError::transient("the call to Meta failed in transit")
        }
        EgressError::NotPublic { .. } => {
            ConnectorError::transient("the Meta host resolved to no public address")
        }
        EgressError::HostNotAllowed { .. } => {
            ConnectorError::permanent("the Meta host is not allowed for the meta connector")
        }
        EgressError::Build(_) => ConnectorError::permanent("the call to Meta could not be built"),
    }
}

/// Reads `response`: its JSON on success, its mapped error otherwise. The body is read up to
/// [`MAX_BODY_BYTES`] and never logged.
async fn read(mut response: Response) -> Result<Value, ConnectorError> {
    let status = response.status();
    let wait = retry_after(response.headers());
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MAX_BODY_BYTES {
                    return Err(ConnectorError::permanent("the answer is too large"));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => {
                return Err(ConnectorError::transient(
                    "the answer from Meta broke off in transit",
                ));
            }
        }
    }
    let Ok(json) = serde_json::from_slice::<Value>(&body) else {
        return Err(unreadable(status, wait));
    };
    let has_error = json.get("error").is_some_and(Value::is_object)
        || json.get("error_type").is_some_and(Value::is_string);
    if status.is_success() && !has_error {
        Ok(json)
    } else {
        Err(classify(status, &json, wait))
    }
}

/// The error of an answer whose body is not JSON: `Throttle` for HTTP 429, `Transient` for 5xx,
/// else `Permanent`.
fn unreadable(status: StatusCode, wait: Option<Duration>) -> ConnectorError {
    if status == StatusCode::TOO_MANY_REQUESTS {
        ConnectorError::throttle(wait)
    } else if status.is_server_error() {
        ConnectorError::transient(format!("HTTP {} with an unreadable body", status.as_u16()))
    } else {
        ConnectorError::permanent(format!("HTTP {} with an unreadable body", status.as_u16()))
    }
}

/// The parts of a Graph error: Graph's `{"error": {message, type, code, error_subcode,
/// is_transient}}`, or Instagram Login's `{error_type, code, error_message}` (whose `code` is the
/// HTTP status, so it is not a Graph code).
struct GraphError<'a> {
    code: Option<i64>,
    subcode: Option<i64>,
    kind: Option<&'a str>,
    message: Option<&'a str>,
    transient: bool,
}

impl<'a> GraphError<'a> {
    fn of(json: &'a Value) -> GraphError<'a> {
        let error = &json["error"];
        if error.is_object() {
            GraphError {
                code: integer(&error["code"]),
                subcode: integer(&error["error_subcode"]),
                kind: error["type"].as_str(),
                message: error["message"].as_str(),
                transient: error["is_transient"].as_bool() == Some(true),
            }
        } else {
            GraphError {
                code: None,
                subcode: None,
                kind: json["error_type"].as_str(),
                message: json["error_message"]
                    .as_str()
                    .or_else(|| json["error"].as_str()),
                transient: false,
            }
        }
    }

    /// `"<type> (#<code>/<subcode>): <message>"`, cut to [`MAX_REASON_CHARS`].
    fn reason(&self, status: StatusCode) -> String {
        let mut out = format!("HTTP {}", status.as_u16());
        if let Some(kind) = self.kind {
            out.push_str(&format!(" {kind}"));
        }
        match (self.code, self.subcode) {
            (Some(code), Some(sub)) => out.push_str(&format!(" (#{code}/{sub})")),
            (Some(code), None) => out.push_str(&format!(" (#{code})")),
            (None, Some(sub)) => out.push_str(&format!(" (subcode {sub})")),
            (None, None) => {}
        }
        if let Some(message) = self.message {
            out.push_str(": ");
            out.push_str(message);
        }
        out.chars().take(MAX_REASON_CHARS).collect()
    }
}

/// The error a Graph answer with status `status` and body `json` maps to (the table in the crate
/// docs; first match wins), with `wait` for a `Throttle`.
pub(crate) fn classify(status: StatusCode, json: &Value, wait: Option<Duration>) -> ConnectorError {
    let e = GraphError::of(json);
    let code = e.code;
    let reason = e.reason(status);
    let has = |codes: &[i64]| code.is_some_and(|c| codes.contains(&c));
    if status == StatusCode::TOO_MANY_REQUESTS
        || has(THROTTLE_CODES)
        || code.is_some_and(|c| (80_000..=80_099).contains(&c))
    {
        return ConnectorError::throttle(wait);
    }
    if has(PERMISSION_CODES) || code.is_some_and(|c| (200..=299).contains(&c)) {
        return ConnectorError::permission(reason);
    }
    let oauth_without_code = e.kind == Some("OAuthException") && code.is_none();
    if status == StatusCode::UNAUTHORIZED
        || has(AUTH_CODES)
        || e.subcode.is_some_and(|s| AUTH_SUBCODES.contains(&s))
        || oauth_without_code
    {
        return ConnectorError::auth(reason);
    }
    if status.is_server_error() || e.transient || has(TRANSIENT_CODES) {
        return ConnectorError::transient(reason);
    }
    ConnectorError::permanent(reason)
}

/// How long the provider asks to wait: `Retry-After` in seconds, else the longest wait the usage
/// headers name (`X-Business-Use-Case-Usage`'s `estimated_time_to_regain_access`, in minutes,
/// and `X-Ad-Account-Usage`'s `reset_time_duration`, in seconds). `None` when none names one.
pub(crate) fn retry_after(headers: &header::HeaderMap) -> Option<Duration> {
    let value = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    if let Some(seconds) = value("retry-after").and_then(|v| v.trim().parse::<i64>().ok())
        && seconds > 0
    {
        return Some(Duration::seconds(seconds));
    }
    let mut longest: i64 = 0;
    if let Some(usage) =
        value("x-business-use-case-usage").and_then(|v| serde_json::from_str::<Value>(v).ok())
        && let Some(businesses) = usage.as_object()
    {
        for entries in businesses.values() {
            for entry in entries.as_array().into_iter().flatten() {
                if let Some(minutes) = integer(&entry["estimated_time_to_regain_access"]) {
                    longest = longest.max(minutes.saturating_mul(60));
                }
            }
        }
    }
    if let Some(usage) =
        value("x-ad-account-usage").and_then(|v| serde_json::from_str::<Value>(v).ok())
        && let Some(seconds) = integer(&usage["reset_time_duration"])
    {
        longest = longest.max(seconds);
    }
    (longest > 0).then(|| Duration::seconds(longest))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn kind(status: u16, body: Value) -> &'static str {
        classify(StatusCode::from_u16(status).unwrap(), &body, None).kind()
    }

    fn graph(code: i64, subcode: Option<i64>, kind: &str) -> Value {
        json!({ "error": {
            "message": "m", "type": kind, "code": code, "error_subcode": subcode,
        }})
    }

    #[test]
    fn graph_errors_map_by_the_table() {
        for (status, body, expected) in [
            (400, graph(190, None, "OAuthException"), "auth"),
            (400, graph(190, Some(463), "OAuthException"), "auth"),
            (400, graph(100, Some(467), "GraphMethodException"), "auth"),
            (400, graph(102, None, "OAuthException"), "auth"),
            (
                400,
                json!({ "error": { "type": "OAuthException", "message": "m" } }),
                "auth",
            ),
            (401, json!({}), "auth"),
            (403, graph(200, None, "OAuthException"), "permission"),
            (403, graph(10, None, "OAuthException"), "permission"),
            (403, graph(3, None, "OAuthException"), "permission"),
            (403, graph(803, None, "OAuthException"), "permission"),
            (403, graph(294, None, "OAuthException"), "permission"),
            (400, graph(4, None, "OAuthException"), "throttle"),
            (
                400,
                graph(17, Some(2_446_079), "OAuthException"),
                "throttle",
            ),
            (400, graph(32, None, "OAuthException"), "throttle"),
            (400, graph(613, None, "OAuthException"), "throttle"),
            (400, graph(80_001, None, "OAuthException"), "throttle"),
            (400, graph(130_429, None, "OAuthException"), "throttle"),
            (429, json!({}), "throttle"),
            (500, graph(1, None, "OAuthException"), "transient"),
            (503, json!({}), "transient"),
            (400, graph(2, None, "OAuthException"), "transient"),
            (
                400,
                json!({ "error": { "code": 9007, "is_transient": true, "message": "m" } }),
                "transient",
            ),
            (400, graph(100, None, "OAuthException"), "permanent"),
            (
                400,
                graph(100, Some(33), "GraphMethodException"),
                "permanent",
            ),
            (400, graph(368, None, "OAuthException"), "permanent"),
            (
                400,
                json!({ "error_type": "OAuthException", "code": 400, "error_message": "bad code" }),
                "auth",
            ),
            (404, json!({}), "permanent"),
        ] {
            assert_eq!(kind(status, body.clone()), expected, "{status} {body}");
        }
    }

    #[test]
    fn reasons_name_the_graph_error_and_are_redacted() {
        let body = json!({ "error": {
            "message": "Invalid OAuth access token: access_token=EAAB-secret",
            "type": "OAuthException", "code": 190, "error_subcode": 463,
        }});
        let e = classify(StatusCode::BAD_REQUEST, &body, None);
        let reason = e.reason().unwrap();
        assert!(
            reason.starts_with("HTTP 400 OAuthException (#190/463): "),
            "{reason}"
        );
        assert!(!reason.contains("EAAB-secret"), "{reason}");
    }

    #[test]
    fn proof_is_the_hmac_of_the_token_under_the_secret() {
        // RFC 4231-style check against a known HMAC-SHA256 value.
        assert_eq!(
            appsecret_proof("key", "The quick brown fox jumps over the lazy dog"),
            "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8"
        );
    }

    #[test]
    fn graph_versions_are_checked() {
        let app = |v: Option<&str>| MetaApp {
            app_id: "1".into(),
            app_secret: "s".into(),
            verify_token: "v".into(),
            login_config_id: None,
            whatsapp_config_id: None,
            graph_version: v.map(str::to_owned),
        };
        assert_eq!(graph_version(&app(None)).unwrap(), "v19.0");
        assert_eq!(graph_version(&app(Some(" "))).unwrap(), "v19.0");
        assert_eq!(graph_version(&app(Some("v21.0"))).unwrap(), "v21.0");
        for bad in ["21.0", "v21", "v21.0/x", "v../", "vx.y"] {
            assert!(graph_version(&app(Some(bad))).is_err(), "{bad}");
        }
    }

    #[test]
    fn node_ids_cannot_change_a_path() {
        assert_eq!(node("act_123").unwrap(), "act_123");
        assert_eq!(node("17841400000000000").unwrap(), "17841400000000000");
        for bad in ["", "..", "a/b", "a?b", "a b", "a#b", "%2e"] {
            assert!(node(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn joined_urls_keep_the_base_path_and_encode_segments() {
        let base = Url::parse("http://127.0.0.1:9/fb/").unwrap();
        let url = join(&base, &["v19.0", "me"], &[("fields", "id,name")]);
        assert_eq!(
            url.as_str(),
            "http://127.0.0.1:9/fb/v19.0/me?fields=id%2Cname"
        );
    }

    #[test]
    fn waits_come_from_the_headers() {
        let mut headers = header::HeaderMap::new();
        assert_eq!(retry_after(&headers), None);
        headers.insert(
            "x-business-use-case-usage",
            r#"{"123":[{"type":"pages","estimated_time_to_regain_access":5},{"estimated_time_to_regain_access":2}]}"#
                .parse()
                .unwrap(),
        );
        assert_eq!(retry_after(&headers), Some(Duration::minutes(5)));
        headers.insert(
            "x-ad-account-usage",
            r#"{"reset_time_duration":900}"#.parse().unwrap(),
        );
        assert_eq!(retry_after(&headers), Some(Duration::seconds(900)));
        headers.insert("retry-after", "30".parse().unwrap());
        assert_eq!(retry_after(&headers), Some(Duration::seconds(30)));
    }
}
