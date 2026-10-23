//! The Graph client: URLs, `appsecret_proof`, sending through the egress client, reading answers,
//! following paging links, and mapping Graph errors to [`ConnectorError`] (the crate docs hold the
//! table).
//!
//! **Secrets in provider text.** A Graph error's reason quotes the provider's message, and a
//! provider may repeat what it was sent in it, in any wording: not only as `key=value`, which the
//! generic redaction ([`jt_connector::redact_reason`]) recognises, but in free text too ("the token
//! EAAB… is invalid"), possibly URL- or form-encoded. So every call knows its own secrets (the
//! token in use, the app secret, and the secret fields of a token exchange's query or form: the
//! code, the client secret, the token to exchange, the PKCE verifier) and takes each out of the
//! provider's text, as every span that decodes to it ([`strip_secrets`]: as is, percent-encoded
//! with any bytes escaped in any hex case, `+` for a space, encoded again up to three rounds
//! deep), **before** the
//! reason is cut to its length (a secret straddling the cut would otherwise leave its first
//! characters behind); the generic redaction then runs on what remains, when the error is built.

use std::fmt;

use hmac::{Hmac, KeyInit, Mac};
use jt_app::ports::connectors::MetaApp;
use jt_connector::{ConnectorError, Credential};
use jt_outbound::{EgressError, EgressScope, Method, Response, StatusCode, header};
use serde_json::Value;
use sha2::Sha256;
use time::Duration;
use url::Url;

use crate::{Masked, MetaConnector};

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

/// The query and form fields of a call that are not secret; every other field of a call without
/// a token ([`Auth::None`]: the token exchanges, whose credentials travel in the query or the
/// form) is taken for a secret ([`call_secrets`]).
const PUBLIC_PARAMS: &[&str] = &["client_id", "redirect_uri", "grant_type"];

/// What a secret taken out of provider text is replaced with.
const SECRET_MASK: &str = "***";

/// How many rounds of URL or form decoding a secret's spelling in provider text is undone
/// ([`strip_secrets`]): a value quoted, quoted again inside another URL, and once more.
const MAX_ENCODINGS: usize = 3;

/// The longest wait a throttle asks for: a provider's longer (or absurd) wait is cut to it, so
/// a scheduler adding it to the clock can never overflow.
pub(crate) const MAX_RETRY_AFTER: Duration = Duration::hours(1);

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

/// How a call authenticates. `Debug` masks the token and the secret.
#[derive(Clone, Copy)]
pub(crate) enum Auth<'a> {
    /// No token (an OAuth code or token exchange, which carries the app's own credentials).
    None,
    /// A token on `graph.facebook.com`: `Bearer`, and `appsecret_proof` under `secret`.
    Graph { token: &'a str, secret: &'a str },
    /// A token on `graph.instagram.com`: `Bearer` only.
    Bearer(&'a str),
}

impl fmt::Debug for Auth<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Auth::None => f.write_str("None"),
            Auth::Graph { .. } => f
                .debug_struct("Graph")
                .field("token", &Masked)
                .field("secret", &Masked)
                .finish(),
            Auth::Bearer(_) => f.debug_tuple("Bearer").field(&Masked).finish(),
        }
    }
}

/// A request body. `Debug` shows its shape only: a form may carry a client secret or a code, a
/// JSON body a message.
pub(crate) enum Body {
    Empty,
    Json(Value),
    Form(Vec<(String, String)>),
}

impl fmt::Debug for Body {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Body::Empty => f.write_str("Empty"),
            Body::Json(_) => f.debug_tuple("Json").field(&Masked).finish(),
            Body::Form(fields) => {
                let names: Vec<&str> = fields.iter().map(|(name, _)| name.as_str()).collect();
                f.debug_struct("Form")
                    .field("fields", &names)
                    .field("values", &Masked)
                    .finish()
            }
        }
    }
}

/// The Meta app's secret and Graph version, as one call needs them. `Debug` masks the secret.
pub(crate) struct GraphApp {
    pub(crate) secret: String,
    pub(crate) version: String,
}

impl fmt::Debug for GraphApp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GraphApp")
            .field("secret", &Masked)
            .field("version", &self.version)
            .finish()
    }
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
        let secrets = call_secrets(auth, &url, &body);
        let read_only = method == Method::GET;
        let mut request = self.egress.prepare(method, url);
        if let Some(token) = token {
            request = request.bearer(token);
        }
        request = match body {
            Body::Empty => request,
            Body::Json(json) => request.json(&json),
            Body::Form(form) => request.form(&form),
        };
        let response = request
            .send(SCOPE)
            .await
            .map_err(|e| egress_error(e, read_only))?;
        read(response, &secrets, read_only).await
    }
}

/// The secrets of one call, to be taken out of any provider text its error quotes: the token and
/// the app secret of `auth`; for a call without a token, every query field of `url` but
/// [`PUBLIC_PARAMS`] (the code, the client secret, the token to exchange); and every form field
/// of `body` but those. Empty values are left out.
fn call_secrets(auth: Auth<'_>, url: &Url, body: &Body) -> Vec<String> {
    let mut secrets: Vec<String> = match auth {
        Auth::None => url
            .query_pairs()
            .filter(|(name, _)| !PUBLIC_PARAMS.contains(&name.as_ref()))
            .map(|(_, value)| value.into_owned())
            .collect(),
        Auth::Graph { token, secret } => vec![token.to_owned(), secret.to_owned()],
        Auth::Bearer(token) => vec![token.to_owned()],
    };
    if let Body::Form(fields) = body {
        secrets.extend(
            fields
                .iter()
                .filter(|(name, _)| !PUBLIC_PARAMS.contains(&name.as_str()))
                .map(|(_, value)| value.clone()),
        );
    }
    secrets.retain(|s| !s.is_empty());
    secrets
}

/// `text` with every spelling of a secret of `secrets` replaced by [`SECRET_MASK`], the text
/// around it kept: every span that decodes to the secret byte for byte in up to
/// [`MAX_ENCODINGS`] rounds of decoding ([`spelled_at`]), so the secret as is, percent-encoded
/// with any set of bytes escaped (RFC 3986 keeping `-._~`, every byte but letters and digits, or
/// any mix), escapes in upper-, lower- or mixed-case hex, a space written `+` (form encoding),
/// and any of these applied again over the result (a value quoted in a URL that is itself quoted:
/// `%252F` for `/`, `%2B` for a space form-encoded twice). The longest secrets go first, so a
/// secret inside another goes with it.
///
/// No other form is looked for because none is sent: the adapter puts a secret on the wire only
/// as is (the `Authorization` header) or URL- or form-encoded (a query or a form); the
/// `appsecret_proof` is an HMAC, not a form of the app secret.
pub(crate) fn strip_secrets(text: &str, secrets: &[String]) -> String {
    let mut secrets: Vec<&[u8]> = secrets
        .iter()
        .filter(|s| !s.is_empty())
        .map(|s| s.as_bytes())
        .collect();
    // Longest first; equal ones side by side, so each goes once.
    secrets.sort_unstable_by(|a, b| b.len().cmp(&a.len()).then_with(|| a.cmp(b)));
    secrets.dedup();
    let mut out = text.to_owned();
    for secret in secrets {
        out = strip_secret(&out, secret);
    }
    out
}

/// `text` with every span that spells `secret` ([`spelled_at`]) replaced by [`SECRET_MASK`],
/// left to right, each span as long as it can be.
fn strip_secret(text: &str, secret: &[u8]) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut kept = 0;
    let mut at = 0;
    while at < bytes.len() {
        match spelled_at(bytes, at, secret) {
            // Spans start and end next to ASCII or at a whole character; checked all the same.
            Some(end) if text.is_char_boundary(at) && text.is_char_boundary(end) => {
                out.push_str(&text[kept..at]);
                out.push_str(SECRET_MASK);
                kept = end;
                at = end;
            }
            _ => at += 1,
        }
    }
    out.push_str(&text[kept..]);
    out
}

/// The end of the longest span of `text` from `start` that decodes to `secret` in up to
/// [`MAX_ENCODINGS`] rounds ([`decoded_at`]), if one does. The spellings of every byte are
/// followed side by side (a set of ends, not a backtracking search).
fn spelled_at(text: &[u8], start: usize, secret: &[u8]) -> Option<usize> {
    let first = *secret.first()?;
    let lead = *text.get(start)?;
    // A spelling starts with its byte as is, with `%` (an escape) or with `+` (a space): skip
    // every other position without allocating.
    if lead != first && lead != b'%' && !(lead == b'+' && first == b' ') {
        return None;
    }
    let mut ends = vec![start];
    let mut next = Vec::new();
    let mut units = Vec::new();
    for &want in secret {
        next.clear();
        for &at in &ends {
            units.clear();
            decoded_at(text, at, MAX_ENCODINGS, &mut units);
            next.extend(
                units
                    .iter()
                    .filter(|(byte, _)| *byte == want)
                    .map(|(_, end)| *end),
            );
        }
        if next.is_empty() {
            return None;
        }
        next.sort_unstable();
        next.dedup();
        std::mem::swap(&mut ends, &mut next);
    }
    ends.last().copied()
}

/// Adds to `out` every byte the text at `at` may stand for once decoded up to `rounds` times,
/// each with the end of its spelling. One round of decoding reads, over what the round before
/// left, `%` and two hex digits (in any case) as the byte they write and `+` as a space, and
/// leaves every other character as it is; a round may also leave a `%` or a `+` as it is (a
/// literal one). So `%2B` is `+` after one round and a space after two, and `%252F` is `%2F`
/// after one round and `/` after two.
fn decoded_at(text: &[u8], at: usize, rounds: usize, out: &mut Vec<(u8, usize)>) {
    if rounds == 0 {
        if let Some(&byte) = text.get(at) {
            out.push((byte, at + 1));
        }
        return;
    }
    let mut before = Vec::new();
    decoded_at(text, at, rounds - 1, &mut before);
    for &(byte, end) in &before {
        out.push((byte, end));
        if byte == b'+' {
            out.push((b' ', end));
        }
        if byte == b'%' {
            let mut highs = Vec::new();
            decoded_at(text, end, rounds - 1, &mut highs);
            for &(high, middle) in &highs {
                let Some(high) = hex_value(high) else {
                    continue;
                };
                let mut lows = Vec::new();
                decoded_at(text, middle, rounds - 1, &mut lows);
                for &(low, last) in &lows {
                    if let Some(low) = hex_value(low) {
                        out.push((high * 16 + low, last));
                    }
                }
            }
        }
    }
    out.sort_unstable();
    out.dedup();
}

/// The value of the hex digit `byte` (any case), if it is one.
fn hex_value(byte: u8) -> Option<u8> {
    char::from(byte)
        .to_digit(16)
        .and_then(|d| u8::try_from(d).ok())
}

/// An egress failure as a [`ConnectorError`] (no URL in it).
fn egress_error(e: EgressError, read_only: bool) -> ConnectorError {
    match e {
        EgressError::Transport(err) if err.is_connect() => {
            ConnectorError::transient("the call to Meta could not connect; nothing was sent")
        }
        EgressError::Transport(_) if !read_only => {
            ConnectorError::unknown("the request may have reached Meta: the outcome is unknown")
        }
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

/// Reads `response`: its JSON on success, its mapped error otherwise, without any of the call's
/// `secrets` in its reason. The body is read up to [`MAX_BODY_BYTES`] and never logged.
async fn read(
    mut response: Response,
    secrets: &[String],
    read_only: bool,
) -> Result<Value, ConnectorError> {
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
                let error = if read_only {
                    ConnectorError::transient
                } else {
                    ConnectorError::unknown
                };
                return Err(error("the answer from Meta broke off in transit"));
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
        Err(classify(status, &json, wait, secrets))
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

    /// `"HTTP <status> <type> (#<code>/<subcode>): <message>"`, every secret of `secrets` taken
    /// out ([`strip_secrets`]), then cut to [`MAX_REASON_CHARS`].
    fn reason(&self, status: StatusCode, secrets: &[String]) -> String {
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
        strip_secrets(&out, secrets)
            .chars()
            .take(MAX_REASON_CHARS)
            .collect()
    }
}

/// The error a Graph answer with status `status` and body `json` maps to (the table in the crate
/// docs; first match wins), with `wait` for a `Throttle`; its reason holds none of the call's
/// `secrets`.
pub(crate) fn classify(
    status: StatusCode,
    json: &Value,
    wait: Option<Duration>,
    secrets: &[String],
) -> ConnectorError {
    let e = GraphError::of(json);
    let code = e.code;
    let reason = e.reason(status, secrets);
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
/// and `X-Ad-Account-Usage`'s `reset_time_duration`, in seconds), at most [`MAX_RETRY_AFTER`].
/// `None` when none names one.
pub(crate) fn retry_after(headers: &header::HeaderMap) -> Option<Duration> {
    let cap = MAX_RETRY_AFTER.whole_seconds();
    let value = |name: &str| headers.get(name).and_then(|v| v.to_str().ok());
    if let Some(seconds) = value("retry-after").and_then(|v| v.trim().parse::<i64>().ok())
        && seconds > 0
    {
        return Some(Duration::seconds(seconds.min(cap)));
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
    (longest > 0).then(|| Duration::seconds(longest.min(cap)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn kind(status: u16, body: Value) -> &'static str {
        classify(StatusCode::from_u16(status).unwrap(), &body, None, &[]).kind()
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
        let e = classify(StatusCode::BAD_REQUEST, &body, None, &[]);
        let reason = e.reason().unwrap();
        assert!(
            reason.starts_with("HTTP 400 OAuthException (#190/463): "),
            "{reason}"
        );
        assert!(!reason.contains("EAAB-secret"), "{reason}");
    }

    #[test]
    fn secrets_go_as_is_and_encoded_before_the_cut() {
        let secrets = vec!["tok/en+1".to_owned(), "s3cret".to_owned(), String::new()];
        assert_eq!(
            strip_secrets(
                "a tok/en+1 b tok%2Fen%2B1 c tok%2fen%2b1 d s3cret e",
                &secrets
            ),
            "a *** b *** c *** d *** e"
        );
        // An empty secret replaces nothing.
        assert_eq!(strip_secrets("plain words", &secrets), "plain words");
        // A secret where the reason is cut goes whole, before the cut.
        let message = format!("{}tok/en+1 tail", "x".repeat(280));
        let body = json!({ "error": { "message": message, "type": "T", "code": 1 } });
        let e = classify(StatusCode::BAD_REQUEST, &body, None, &secrets);
        let reason = e.reason().unwrap();
        assert!(!reason.contains("tok/"), "{reason}");
        assert!(reason.chars().count() <= MAX_REASON_CHARS);
    }

    /// The error a 400 Graph answer quoting `message` maps to, for a call with `secrets`.
    fn quoting(message: &str, secrets: &[String]) -> ConnectorError {
        let body = json!({ "error": {
            "message": message, "type": "OAuthException", "code": 190,
        }});
        classify(StatusCode::BAD_REQUEST, &body, None, secrets)
    }

    /// Asserts that neither the `Display` nor the `Debug` of `e` holds any of `spellings`.
    fn assert_hidden(e: &ConnectorError, spellings: &[&str]) {
        let shown = format!("{e}");
        let debug = format!("{e:?}");
        for spelling in spellings {
            assert!(
                !shown.contains(spelling),
                "Display leaks {spelling}: {shown}"
            );
            assert!(!debug.contains(spelling), "Debug leaks {spelling}: {debug}");
        }
    }

    /// The synthetic secret of the encoding tests: every byte RFC 3986 keeps (`.`, `~`) or encodes
    /// (`/`, `+`, `=`) beside letters.
    const ECHOED: &str = "EAAB.echo~tok/en+key==";

    #[test]
    fn a_secret_quoted_as_is_is_masked_and_the_prose_kept() {
        let e = quoting(
            "The token EAAB.echo~tok/en+key== is invalid",
            &[ECHOED.to_owned()],
        );
        assert_eq!(
            e.reason(),
            Some("HTTP 400 OAuthException (#190): The token *** is invalid")
        );
        assert_hidden(&e, &[ECHOED, "echo~tok"]);
    }

    #[test]
    fn a_secret_quoted_rfc3986_encoded_is_masked() {
        // RFC 3986 keeps `-._~` unreserved: `.` and `~` stay, the rest is escaped.
        let quoted = "EAAB.echo~tok%2Fen%2Bkey%3D%3D";
        let e = quoting(
            &format!("The token {quoted} is invalid"),
            &[ECHOED.to_owned()],
        );
        assert_eq!(
            e.reason(),
            Some("HTTP 400 OAuthException (#190): The token *** is invalid")
        );
        assert_hidden(&e, &[ECHOED, quoted, "echo~tok", "en%2Bkey"]);
    }

    #[test]
    fn a_secret_quoted_with_lowercase_escapes_is_masked() {
        for quoted in [
            "EAAB.echo~tok%2fen%2bkey%3d%3d",
            "EAAB%2eecho%7etok%2fen%2bkey%3d%3d",
        ] {
            let e = quoting(
                &format!("The token {quoted} is invalid"),
                &[ECHOED.to_owned()],
            );
            assert_eq!(
                e.reason(),
                Some("HTTP 400 OAuthException (#190): The token *** is invalid"),
                "{quoted}"
            );
            assert_hidden(&e, &[ECHOED, quoted, "echo", "en%2bkey"]);
        }
    }

    #[test]
    fn a_secret_quoted_with_mixed_case_escapes_is_masked() {
        // Mixed across escapes, and inside one escape (`ï` is `C3 AF`).
        let secrets = [ECHOED.to_owned(), "na\u{ef}ve-s3cret".to_owned()];
        for quoted in [
            "EAAB%2Eecho%7etok%2Fen%2bkey%3D%3d",
            "EAAB.echo~tok%2fen%2Bkey=%3D",
            "na%c3%AFve-s3cret",
            "na%C3%aFve%2Ds3cret",
            "na%C3%Afve-s3cret",
        ] {
            let e = quoting(&format!("The token {quoted} is invalid"), &secrets);
            assert_eq!(
                e.reason(),
                Some("HTTP 400 OAuthException (#190): The token *** is invalid"),
                "{quoted}"
            );
            assert_hidden(&e, &[ECHOED, quoted, "echo", "s3cret"]);
        }
    }

    #[test]
    fn a_secret_quoted_form_encoded_with_plus_for_space_is_masked() {
        // `application/x-www-form-urlencoded`: a space is `+`, a `+` is `%2B`.
        let secret = "EAAB echo~tok/en+key==";
        for quoted in [
            "EAAB+echo%7Etok%2Fen%2Bkey%3D%3D",
            "EAAB+echo~tok%2Fen%2Bkey%3D%3D",
            "EAAB%20echo~tok%2fen%2bkey%3d%3d",
            "EAAB echo~tok/en+key==",
        ] {
            let e = quoting(
                &format!("The token {quoted} is invalid"),
                &[secret.to_owned()],
            );
            assert_eq!(
                e.reason(),
                Some("HTTP 400 OAuthException (#190): The token *** is invalid"),
                "{quoted}"
            );
            assert_hidden(&e, &[secret, quoted, "echo", "en%2"]);
        }
        // A `+` of the text may stand for a space of the secret, never the other way round: a
        // space of the text is not the secret's `+`.
        assert_eq!(strip_secrets("tok en", &["tok+en".to_owned()]), "tok en");
    }

    #[test]
    fn a_secret_quoted_twice_encoded_is_masked() {
        // A URL quoted inside another URL: `%` itself escaped as `%25`.
        let quoted = "EAAB.echo~tok%252Fen%252Bkey%253D%253d";
        let e = quoting(
            &format!("The token {quoted} is invalid"),
            &[ECHOED.to_owned()],
        );
        assert_eq!(
            e.reason(),
            Some("HTTP 400 OAuthException (#190): The token *** is invalid")
        );
        assert_hidden(&e, &[ECHOED, quoted, "echo"]);
    }

    #[test]
    fn a_secret_form_encoded_two_and_three_times_is_masked() {
        // `quote_plus(quote_plus(secret))`: the space is `+` after one round, `%2B` after two.
        let secret = "EAAB echo~tok/en+key==";
        for quoted in [
            "EAAB%2Becho~tok%252Fen%252Bkey%253D%253D",
            "EAAB%2becho~tok%252fen%252bkey%253d%253d",
            // A third round over that.
            "EAAB%252Becho~tok%25252Fen%25252Bkey%25253D%25253D",
            // Rounds mixed byte by byte.
            "EAAB%2Becho%7Etok/en%2Bkey%253D=",
        ] {
            let e = quoting(
                &format!("The token {quoted} is invalid"),
                &[secret.to_owned()],
            );
            assert_eq!(
                e.reason(),
                Some("HTTP 400 OAuthException (#190): The token *** is invalid"),
                "{quoted}"
            );
            assert_hidden(&e, &[secret, quoted, "echo", "EAAB%2B"]);
            // And where the reason is cut (see the test below for the arithmetic).
            let e = quoting(
                &format!("{}{quoted} tail", "x".repeat(260)),
                &[secret.to_owned()],
            );
            let reason = e.reason().unwrap();
            assert!(reason.ends_with("x*** tail"), "{quoted}: {reason}");
            assert_hidden(&e, &[secret, quoted, "EAAB", "echo"]);
        }
        // One byte off, in any round, and nothing is masked.
        for near in [
            // The last `=` is `>` (`%3E`).
            "EAAB%2Becho~tok%252Fen%252Bkey%253D%253E",
            // The space is `,` (`%2C`).
            "EAAB%2Cecho~tok%252Fen%252Bkey%253D%253D",
            // The `/` is `.` (`%2E`), two rounds deep.
            "EAAB%2Becho~tok%252Een%252Bkey%253D%253D",
        ] {
            let text = format!("The token {near} is invalid");
            assert_eq!(strip_secrets(&text, &[secret.to_owned()]), text, "{near}");
        }
    }

    #[test]
    fn a_secret_across_the_cut_goes_whole_however_encoded() {
        // "HTTP 400 OAuthException (#190): " is 32 characters: with 260 more, the secret starts at
        // 292 and runs past the 300-character cut, so a cut before stripping would keep its head.
        for quoted in [
            ECHOED,
            "EAAB.echo~tok%2Fen%2Bkey%3D%3D",
            "EAAB.echo~tok%2fen%2bkey%3d%3d",
            "EAAB%2Eecho%7etok%2Fen%2bkey%3D%3d",
        ] {
            let message = format!("{}{quoted} tail", "x".repeat(260));
            let e = quoting(&message, &[ECHOED.to_owned()]);
            let reason = e.reason().unwrap();
            assert!(reason.chars().count() <= MAX_REASON_CHARS, "{reason}");
            assert!(reason.ends_with("x*** tail"), "{quoted}: {reason}");
            assert_hidden(&e, &[ECHOED, quoted, "EAAB", "echo"]);
        }
    }

    #[test]
    fn only_spans_decoding_to_the_whole_secret_are_masked() {
        let secrets = [ECHOED.to_owned()];
        for text in [
            // A head of the secret, then something else.
            "EAAB.echo~tok%2Fother",
            // Escapes that do not decode to the secret's bytes.
            "EAAB.echo~tok%2Een%2Bkey%3D%3D",
            // A broken escape.
            "EAAB.echo~tok%2Gen+key==",
            // Unrelated escapes.
            "see https://example.test/a%2Fb?c=d%3De",
        ] {
            assert_eq!(strip_secrets(text, &secrets), text);
        }
        // Several secrets and several spellings in one text, the rest left as it was.
        assert_eq!(
            strip_secrets(
                "a EAAB.echo~tok/en+key== b EAAB.echo~tok%2Fen%2Bkey%3D%3D c s3c%2Fret d s3c/re",
                &[ECHOED.to_owned(), "s3c/ret".to_owned()]
            ),
            "a *** b *** c *** d s3c/re"
        );
    }

    #[test]
    fn a_call_knows_its_secrets() {
        let url = Url::parse(
            "https://graph.test/oauth/access_token?client_id=app&redirect_uri=r&code=c0de\
             &client_secret=s3c&fb_exchange_token=t0k&grant_type=g",
        )
        .unwrap();
        let mut found = call_secrets(Auth::None, &url, &Body::Empty);
        found.sort();
        assert_eq!(found, ["c0de", "s3c", "t0k"]);
        let form = Body::Form(vec![
            ("client_id".into(), "app".into()),
            ("client_secret".into(), "ig-s3c".into()),
            ("code".into(), "ig-c0de".into()),
        ]);
        let token_endpoint = Url::parse("https://api.instagram.test/oauth/access_token").unwrap();
        let mut found = call_secrets(Auth::None, &token_endpoint, &form);
        found.sort();
        assert_eq!(found, ["ig-c0de", "ig-s3c"]);
        // With a token, the query holds no secret (the token goes in the header).
        let plain = Url::parse("https://graph.test/me?fields=id").unwrap();
        assert_eq!(
            call_secrets(
                Auth::Graph {
                    token: "EAAB",
                    secret: "app-s3c"
                },
                &plain,
                &Body::Empty
            ),
            ["EAAB", "app-s3c"]
        );
        assert_eq!(
            call_secrets(Auth::Bearer("IGAA"), &plain, &Body::Empty),
            ["IGAA"]
        );
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

    #[test]
    fn waits_are_capped_at_an_hour() {
        let mut headers = header::HeaderMap::new();
        headers.insert("retry-after", "99999999999".parse().unwrap());
        assert_eq!(retry_after(&headers), Some(MAX_RETRY_AFTER));
        let mut headers = header::HeaderMap::new();
        headers.insert(
            "x-business-use-case-usage",
            format!(
                r#"{{"1":[{{"estimated_time_to_regain_access":{}}}]}}"#,
                i64::MAX
            )
            .parse()
            .unwrap(),
        );
        assert_eq!(retry_after(&headers), Some(MAX_RETRY_AFTER));
        assert_eq!(MAX_RETRY_AFTER, Duration::hours(1));
    }

    #[test]
    fn debug_masks_tokens_secrets_and_bodies() {
        let app = GraphApp {
            secret: "app-SECRET".into(),
            version: "v19.0".into(),
        };
        let printed = [
            format!("{:?}", app.auth("EAAB-token-SECRET")),
            format!("{:?}", Auth::Bearer("IGAA-token-SECRET")),
            format!("{:?}", Auth::None),
            format!("{app:?}"),
            format!(
                "{:?}",
                Body::Form(vec![
                    ("client_secret".into(), "client-SECRET".into()),
                    ("code".into(), "code-SECRET".into()),
                ])
            ),
            format!(
                "{:?}",
                Body::Json(serde_json::json!({ "text": "message-SECRET" }))
            ),
        ];
        for text in &printed {
            assert!(!text.contains("SECRET"), "{text}");
        }
        assert!(printed[3].contains("v19.0"), "{}", printed[3]);
        assert!(printed[4].contains("client_secret"), "{}", printed[4]);
    }
}
