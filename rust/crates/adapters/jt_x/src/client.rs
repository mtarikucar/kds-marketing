//! The X client: URLs, sending through the egress client (reads tried once more when no answer
//! arrived, everything else never), reading answers, and mapping X's errors to
//! [`ConnectorError`] (the crate docs hold the table).

use std::fmt;

use jt_connector::ConnectorError;
use jt_outbound::multipart::{Form, Part};
use jt_outbound::{EgressError, EgressScope, Method, Prepared, Response, StatusCode, header};
use serde_json::Value;
use time::{Duration, OffsetDateTime};
use url::Url;

use crate::{Masked, READ_ATTEMPTS, XConnector};

/// The egress scope of every call.
const SCOPE: EgressScope = EgressScope::Connector("x");

/// The largest answer read, in bytes; a larger one is `Permanent`.
const MAX_BODY_BYTES: usize = 4 << 20;

/// The longest error reason kept, in characters.
const MAX_REASON_CHARS: usize = 300;

/// The longest wait a throttle asks for: a provider's longer (or absurd) wait is cut to it, so a
/// scheduler adding it to the clock can never overflow.
pub const MAX_RETRY_AFTER: Duration = Duration::hours(1);

/// Why the token endpoint's `401 invalid_client` is refused: the platform's X client (its id or
/// secret) was not accepted, which only the platform's configuration can fix.
pub(crate) const CLIENT_REJECTED: &str = "platform client credentials rejected";

/// The headers naming when a limit resets (epoch seconds): the 15-minute window of an endpoint,
/// and the 24-hour caps of the app and of the user (posts).
const RESET_HEADERS: &[&str] = &[
    "x-rate-limit-reset",
    "x-app-limit-24hour-reset",
    "x-user-limit-24hour-reset",
];

/// The form fields of a token call that are not secret (every other one is: the code, the
/// verifier, the refresh token).
const PUBLIC_FORM_FIELDS: &[&str] = &["grant_type", "client_id", "redirect_uri"];

/// Which grant a token call asks for: the errors of the two read differently.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Grant {
    /// An authorization code (with its PKCE verifier) for a first token.
    Code,
    /// A refresh token for a new token.
    Refresh,
}

/// Which kind of endpoint a call goes to: how its answer is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Endpoint {
    /// The API (and the media upload): a success that carries `errors` and no `data` is a
    /// failure.
    Api,
    /// The token endpoint (RFC 6749 answers and errors).
    Token(Grant),
}

/// How a call authenticates. `Debug` masks the token and the secret.
#[derive(Clone, Copy)]
pub(crate) enum Auth<'a> {
    /// The account's access token.
    Bearer(&'a str),
    /// The platform's X client, for the token endpoint.
    Basic { client_id: &'a str, secret: &'a str },
}

impl fmt::Debug for Auth<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Auth::Bearer(_) => f.debug_tuple("Bearer").field(&Masked).finish(),
            Auth::Basic { client_id, .. } => f
                .debug_struct("Basic")
                .field("client_id", client_id)
                .field("secret", &Masked)
                .finish(),
        }
    }
}

impl<'a> Auth<'a> {
    /// The secret it carries.
    fn secret(&self) -> &'a str {
        match self {
            Auth::Bearer(token) => token,
            Auth::Basic { secret, .. } => secret,
        }
    }
}

/// A file uploaded as the `media` part of a multipart body, with `media_category`.
pub(crate) struct Upload<'a> {
    pub(crate) bytes: &'a [u8],
    pub(crate) mime: &'a str,
    pub(crate) filename: String,
    pub(crate) category: &'static str,
}

/// A request body. `Debug` shows its shape only: a form carries a code, a verifier or a refresh
/// token, a JSON body a post.
pub(crate) enum Body<'a> {
    Empty,
    Json(Value),
    Form(Vec<(&'static str, &'a str)>),
    Upload(Upload<'a>),
}

impl fmt::Debug for Body<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Body::Empty => f.write_str("Empty"),
            Body::Json(_) => f.debug_tuple("Json").field(&Masked).finish(),
            Body::Form(fields) => {
                let names: Vec<&str> = fields.iter().map(|(name, _)| *name).collect();
                f.debug_struct("Form")
                    .field("fields", &names)
                    .field("values", &Masked)
                    .finish()
            }
            Body::Upload(upload) => f
                .debug_struct("Upload")
                .field("bytes", &upload.bytes.len())
                .field("mime", &upload.mime)
                .field("category", &upload.category)
                .finish_non_exhaustive(),
        }
    }
}

impl<'a> Body<'a> {
    /// The secret values it carries: the form fields other than [`PUBLIC_FORM_FIELDS`].
    fn secrets(&self) -> Vec<&'a str> {
        match self {
            Body::Form(fields) => fields
                .iter()
                .filter(|(name, _)| !PUBLIC_FORM_FIELDS.contains(name))
                .map(|(_, value)| *value)
                .collect(),
            _ => Vec::new(),
        }
    }

    /// `request` with this body.
    fn apply(&self, request: Prepared) -> Result<Prepared, ConnectorError> {
        Ok(match self {
            Body::Empty => request,
            Body::Json(json) => request.json(json),
            Body::Form(fields) => request.form(fields),
            Body::Upload(upload) => {
                let media = Part::bytes(upload.bytes.to_vec())
                    .file_name(upload.filename.clone())
                    .mime_str(upload.mime)
                    .map_err(|_| ConnectorError::permanent("the media type cannot be sent"))?;
                let form = Form::new()
                    .part("media", media)
                    .text("media_category", upload.category);
                request.multipart(form)
            }
        })
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
            .expect("an X base URL has a path that segments can be pushed to");
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

/// A JSON value that is a non-empty string or an integer, as text (X's ids are strings; an
/// integer is taken too).
pub(crate) fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Value::Number(n) if n.is_i64() || n.is_u64() => Some(n.to_string()),
        _ => None,
    }
}

/// `Permanent`: the answer lacks something the call needs.
pub(crate) fn missing(what: &str) -> ConnectorError {
    ConnectorError::permanent(format!("the provider's answer has no {what}"))
}

impl XConnector {
    /// The API URL of `segments` with `query`.
    pub(crate) fn api_url(&self, segments: &[&str], query: &[(&str, &str)]) -> Url {
        join(&self.bases.api, segments, query)
    }

    /// The media upload URL of `segments`.
    pub(crate) fn upload_url(&self, segments: &[&str]) -> Url {
        join(&self.bases.upload, segments, &[])
    }

    /// Sends one call to `endpoint` and reads its answer: the parsed JSON of a success, else the
    /// error it maps to. A `GET` is tried once more when no answer arrives (the connection fails,
    /// drops or times out); anything else is sent once. Once any answer arrives nothing is sent
    /// again. Every secret of the call (the token or client secret, the secret form fields) is
    /// taken out of any provider text quoted in an error.
    pub(crate) async fn call(
        &self,
        method: Method,
        url: Url,
        auth: Auth<'_>,
        body: &Body<'_>,
        endpoint: Endpoint,
    ) -> Result<Value, ConnectorError> {
        let read_only = method == Method::GET;
        let attempts = if read_only { READ_ATTEMPTS.max(1) } else { 1 };
        let timeout = match body {
            Body::Upload(_) => self.upload_timeout,
            _ => self.attempt_timeout,
        };
        let mut secrets = body.secrets();
        secrets.push(auth.secret());
        let mut attempt = 1;
        loop {
            let mut request = self
                .egress
                .prepare(method.clone(), url.clone())
                .timeout(timeout);
            request = match auth {
                Auth::Bearer(token) => request.bearer(token),
                Auth::Basic { client_id, secret } => request.basic_auth(client_id, Some(secret)),
            };
            request = body.apply(request)?;
            match request.send(SCOPE).await {
                Ok(response) => return read(response, endpoint, &secrets).await,
                Err(EgressError::Transport(err)) if attempt < attempts => {
                    tracing::warn!(
                        attempt,
                        timed_out = err.is_timeout(),
                        "a read from X got no answer; trying again"
                    );
                    if !self.retry_delay.is_zero() {
                        tokio::time::sleep(self.retry_delay).await;
                    }
                    attempt += 1;
                }
                Err(e) => return Err(egress_error(e, read_only)),
            }
        }
    }
}

/// An egress failure as a [`ConnectorError`] (no URL in it). A call that is not a read and got
/// no answer after its request may have reached X says its outcome is unknown.
fn egress_error(e: EgressError, read_only: bool) -> ConnectorError {
    match e {
        EgressError::Transport(err) if err.is_connect() => {
            ConnectorError::transient("the call to X could not connect; nothing was sent")
        }
        EgressError::Transport(err) if !read_only => {
            let what = if err.is_timeout() {
                "timed out"
            } else {
                "got no answer"
            };
            ConnectorError::transient(format!(
                "the call to X {what} after the request may have reached it: the outcome is \
                 unknown, so it was not sent again"
            ))
        }
        EgressError::Transport(err) if err.is_timeout() => {
            ConnectorError::transient("the call to X timed out: no answer")
        }
        EgressError::Transport(_) => ConnectorError::transient("the call to X got no answer"),
        EgressError::NotPublic { .. } => {
            ConnectorError::transient("the X host resolved to no public address")
        }
        EgressError::HostNotAllowed { .. } => {
            ConnectorError::permanent("the X host is not allowed for the x connector")
        }
        EgressError::Build(_) => ConnectorError::permanent("the call to X could not be built"),
    }
}

/// Reads `response` from `endpoint`: its JSON on success, its mapped error otherwise. The body is
/// read up to [`MAX_BODY_BYTES`] and never logged.
async fn read(
    mut response: Response,
    endpoint: Endpoint,
    secrets: &[&str],
) -> Result<Value, ConnectorError> {
    let status = response.status();
    let wait = retry_after(response.headers(), OffsetDateTime::now_utc());
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MAX_BODY_BYTES {
                    return Err(ConnectorError::permanent("X's answer is too large"));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            // An answer arrived (it may have been acted on): never sent again.
            Err(_) => {
                return Err(ConnectorError::transient(
                    "X's answer broke off in transit: whether the request took effect is unknown",
                ));
            }
        }
    }
    let json = serde_json::from_slice::<Value>(&body).ok();
    if status.is_success() {
        let Some(json) = json else {
            return Err(classify(status, None, wait, endpoint, secrets));
        };
        let failed = endpoint == Endpoint::Api
            && json.get("data").is_none_or(Value::is_null)
            && json["errors"].as_array().is_some_and(|e| !e.is_empty());
        if failed {
            return Err(ConnectorError::permanent(reason(
                status,
                Some(&json),
                secrets,
            )));
        }
        Ok(json)
    } else {
        Err(classify(status, json.as_ref(), wait, endpoint, secrets))
    }
}

/// The error an answer with status `status` and body `json` (when it is JSON) from `endpoint`
/// maps to (the table in the crate docs; first match wins), with `wait` for a `Throttle`.
pub(crate) fn classify(
    status: StatusCode,
    json: Option<&Value>,
    wait: Option<Duration>,
    endpoint: Endpoint,
    secrets: &[&str],
) -> ConnectorError {
    if status == StatusCode::TOO_MANY_REQUESTS {
        return ConnectorError::throttle(wait);
    }
    let oauth_error = json.and_then(|j| j["error"].as_str());
    // The token endpoint refusing the platform's own client (its id or secret): no tenant can
    // fix that by reconnecting, so it is never the tenant's `Auth`.
    if matches!(endpoint, Endpoint::Token(_))
        && status == StatusCode::UNAUTHORIZED
        && oauth_error == Some("invalid_client")
    {
        return ConnectorError::permanent(CLIENT_REJECTED);
    }
    let reason = reason(status, json, secrets);
    let spent = match endpoint {
        Endpoint::Token(Grant::Code) => oauth_error == Some("invalid_grant"),
        Endpoint::Token(Grant::Refresh) => {
            matches!(oauth_error, Some("invalid_grant" | "invalid_request"))
        }
        Endpoint::Api => false,
    };
    if status == StatusCode::UNAUTHORIZED || (status.is_client_error() && spent) {
        return ConnectorError::auth(reason);
    }
    if status == StatusCode::FORBIDDEN {
        return ConnectorError::permission(reason);
    }
    if status.is_server_error() {
        return ConnectorError::transient(reason);
    }
    ConnectorError::permanent(reason)
}

/// `"HTTP <status> <title>: <detail> (<first error's message>)"` of an X problem, `"HTTP <status>
/// <error>: <error_description>"` of a token error, or `"HTTP <status> with an unreadable body"`;
/// every secret in `secrets` taken out, cut to [`MAX_REASON_CHARS`].
fn reason(status: StatusCode, json: Option<&Value>, secrets: &[&str]) -> String {
    let mut out = format!("HTTP {}", status.as_u16());
    let Some(json) = json else {
        out.push_str(" with an unreadable body");
        return out;
    };
    let first = &json["errors"][0];
    let (head, detail, extra) = match words(&json["error"]) {
        Some(error) => (Some(error), words(&json["error_description"]), None),
        None => (
            words(&json["title"]).or_else(|| words(&first["title"])),
            words(&json["detail"]).or_else(|| words(&first["detail"])),
            words(&first["message"]),
        ),
    };
    if let Some(head) = head {
        out.push(' ');
        out.push_str(head);
    }
    if let Some(detail) = detail {
        out.push_str(": ");
        out.push_str(detail);
    }
    if let Some(extra) = extra.filter(|e| Some(*e) != detail) {
        out.push_str(" (");
        out.push_str(extra);
        out.push(')');
    }
    scrub(&out, secrets)
        .chars()
        .take(MAX_REASON_CHARS)
        .collect()
}

/// The trimmed text of a JSON string, when it has any.
fn words(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}

/// `text` with every secret of `secrets` (as is: X's tokens, codes, verifiers and client secrets
/// are base64url, which no encoding changes) replaced by `***`, longest first. The reason's
/// constructor then redacts what still looks like a credential.
fn scrub(text: &str, secrets: &[&str]) -> String {
    let mut secrets: Vec<&str> = secrets.iter().copied().filter(|s| !s.is_empty()).collect();
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    let mut out = text.to_owned();
    for secret in secrets {
        out = out.replace(secret, "***");
    }
    out
}

/// How long X asks to wait, as of `now`: the largest wait ahead among the resets of
/// [`RESET_HEADERS`] (each the epoch second its limit resets, minus now); else `Retry-After` in
/// seconds, when positive; at most [`MAX_RETRY_AFTER`]. `None` when none names a wait.
pub(crate) fn retry_after(headers: &header::HeaderMap, now: OffsetDateTime) -> Option<Duration> {
    let cap = MAX_RETRY_AFTER.whole_seconds();
    let number = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<i64>().ok())
    };
    let reset = RESET_HEADERS
        .iter()
        .filter_map(|name| number(name))
        .map(|reset| reset.saturating_sub(now.unix_timestamp()))
        .filter(|wait| *wait > 0)
        .max();
    reset
        .or_else(|| number("retry-after").filter(|s| *s > 0))
        .map(|s| Duration::seconds(s.min(cap)))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use time::macros::datetime;

    use super::*;

    const NOW: OffsetDateTime = datetime!(2026-10-23 12:00:00 UTC);

    fn kind(status: u16, body: Option<Value>, endpoint: Endpoint) -> &'static str {
        classify(
            StatusCode::from_u16(status).unwrap(),
            body.as_ref(),
            None,
            endpoint,
            &[],
        )
        .kind()
    }

    #[test]
    fn errors_map_by_the_table() {
        let api = Endpoint::Api;
        let code = Endpoint::Token(Grant::Code);
        let refresh = Endpoint::Token(Grant::Refresh);
        let token_error = |e: &str| Some(json!({ "error": e, "error_description": "d" }));
        for (status, body, endpoint, expected) in [
            (429, None, api, "throttle"),
            (429, token_error("invalid_grant"), refresh, "throttle"),
            (401, None, api, "auth"),
            // The platform's client refused: never the tenant's `Auth`.
            (401, token_error("invalid_client"), code, "permanent"),
            (401, token_error("invalid_client"), refresh, "permanent"),
            (401, token_error("invalid_client"), api, "auth"),
            (401, token_error("unauthorized_client"), refresh, "auth"),
            (401, None, refresh, "auth"),
            (400, token_error("invalid_client"), code, "permanent"),
            (400, token_error("invalid_grant"), code, "auth"),
            (400, token_error("invalid_grant"), refresh, "auth"),
            (400, token_error("invalid_request"), refresh, "auth"),
            (400, token_error("invalid_request"), code, "permanent"),
            (400, token_error("invalid_grant"), api, "permanent"),
            (
                400,
                token_error("unsupported_grant_type"),
                refresh,
                "permanent",
            ),
            (403, None, api, "permission"),
            (403, token_error("invalid_grant"), refresh, "auth"),
            (500, None, api, "transient"),
            (
                503,
                token_error("temporarily_unavailable"),
                refresh,
                "transient",
            ),
            (
                400,
                Some(json!({ "title": "Invalid Request" })),
                api,
                "permanent",
            ),
            (404, None, api, "permanent"),
            (302, None, api, "permanent"),
        ] {
            assert_eq!(
                kind(status, body.clone(), endpoint),
                expected,
                "{status} {body:?} {endpoint:?}"
            );
        }
    }

    #[test]
    fn reasons_quote_the_provider_without_secrets() {
        let problem = json!({
            "title": "Invalid Request",
            "detail": "One or more parameters to your request was invalid.",
            "errors": [ { "message": "token tok-SECRET-1 is bad" } ],
        });
        let text = reason(StatusCode::BAD_REQUEST, Some(&problem), &["tok-SECRET-1"]);
        assert_eq!(
            text,
            "HTTP 400 Invalid Request: One or more parameters to your request was invalid. \
             (token *** is bad)"
        );
        let token = json!({ "error": "invalid_request", "error_description": "code c-SECRET" });
        assert_eq!(
            reason(StatusCode::BAD_REQUEST, Some(&token), &["c-SECRET", ""]),
            "HTTP 400 invalid_request: code ***"
        );
        // Only `errors`, as a 200 for a deleted post has them.
        let only = json!({ "errors": [ { "title": "Not Found Error", "detail": "gone" } ] });
        assert_eq!(
            reason(StatusCode::OK, Some(&only), &[]),
            "HTTP 200 Not Found Error: gone"
        );
        assert_eq!(
            reason(StatusCode::BAD_GATEWAY, None, &[]),
            "HTTP 502 with an unreadable body"
        );
        let long = json!({ "detail": "x".repeat(1_000) });
        assert_eq!(
            reason(StatusCode::BAD_REQUEST, Some(&long), &[])
                .chars()
                .count(),
            MAX_REASON_CHARS
        );
        // A longer secret is taken out before a shorter one inside it.
        assert_eq!(scrub("ab abc", &["ab", "abc"]), "*** ***");
    }

    #[test]
    fn waits_come_from_the_reset_then_retry_after_capped() {
        let headers = |pairs: &[(&'static str, String)]| {
            let mut map = header::HeaderMap::new();
            for (name, value) in pairs {
                map.insert(*name, value.parse().unwrap());
            }
            map
        };
        let now = NOW.unix_timestamp();
        assert_eq!(retry_after(&headers(&[]), NOW), None);
        assert_eq!(
            retry_after(
                &headers(&[("x-rate-limit-reset", (now + 90).to_string())]),
                NOW
            ),
            Some(Duration::seconds(90))
        );
        assert_eq!(
            retry_after(
                &headers(&[
                    ("x-rate-limit-reset", (now + 90).to_string()),
                    ("retry-after", "5".into()),
                ]),
                NOW
            ),
            Some(Duration::seconds(90))
        );
        assert_eq!(
            retry_after(
                &headers(&[
                    ("x-rate-limit-reset", (now - 1).to_string()),
                    ("retry-after", "5".into()),
                ]),
                NOW
            ),
            Some(Duration::seconds(5))
        );
        for absurd in [i64::MAX.to_string(), (now + 86_400).to_string()] {
            assert_eq!(
                retry_after(&headers(&[("x-rate-limit-reset", absurd)]), NOW),
                Some(MAX_RETRY_AFTER)
            );
        }
        assert_eq!(
            retry_after(
                &headers(&[("x-rate-limit-reset", i64::MIN.to_string())]),
                NOW
            ),
            None
        );
        assert_eq!(
            retry_after(&headers(&[("retry-after", "0".into())]), NOW),
            None
        );
        // The 24-hour caps' resets count the same way: the largest wait ahead, capped.
        assert_eq!(
            retry_after(
                &headers(&[
                    ("x-rate-limit-reset", (now + 60).to_string()),
                    ("x-app-limit-24hour-reset", (now + 300).to_string()),
                    ("x-user-limit-24hour-reset", (now + 120).to_string()),
                    ("retry-after", "5".into()),
                ]),
                NOW
            ),
            Some(Duration::seconds(300))
        );
        assert_eq!(
            retry_after(
                &headers(&[("x-user-limit-24hour-reset", (now + 86_000).to_string())]),
                NOW
            ),
            Some(MAX_RETRY_AFTER)
        );
        assert_eq!(
            retry_after(
                &headers(&[
                    ("x-user-limit-24hour-reset", (now - 10).to_string()),
                    ("x-app-limit-24hour-reset", "later".into()),
                    ("retry-after", "9".into()),
                ]),
                NOW
            ),
            Some(Duration::seconds(9))
        );
    }

    #[test]
    fn a_refused_platform_client_names_the_platform() {
        let e = classify(
            StatusCode::UNAUTHORIZED,
            Some(&json!({ "error": "invalid_client", "error_description": "bad s-SECRET" })),
            None,
            Endpoint::Token(Grant::Refresh),
            &["s-SECRET"],
        );
        assert_eq!(
            (e.kind(), e.reason()),
            ("permanent", Some("platform client credentials rejected"))
        );
    }

    #[test]
    fn joined_urls_keep_the_base_path_and_encode_segments() {
        let base = Url::parse("http://127.0.0.1:9/api/").unwrap();
        let url = join(
            &base,
            &["2", "tweets", "1/2"],
            &[("tweet.fields", "public_metrics")],
        );
        assert_eq!(
            url.as_str(),
            "http://127.0.0.1:9/api/2/tweets/1%2F2?tweet.fields=public_metrics"
        );
    }

    #[test]
    fn debug_masks_tokens_secrets_and_bodies() {
        let printed = [
            format!("{:?}", Auth::Bearer("tok-SECRET")),
            format!(
                "{:?}",
                Auth::Basic {
                    client_id: "client-1",
                    secret: "client-SECRET"
                }
            ),
            format!(
                "{:?}",
                Body::Form(vec![
                    ("grant_type", "refresh_token"),
                    ("refresh_token", "r-SECRET")
                ])
            ),
            format!("{:?}", Body::Json(json!({ "text": "post-SECRET" }))),
            format!(
                "{:?}",
                Body::Upload(Upload {
                    bytes: b"SECRET",
                    mime: "image/png",
                    filename: "a.png".into(),
                    category: "tweet_image",
                })
            ),
        ];
        for text in &printed {
            assert!(!text.contains("SECRET"), "{text}");
        }
        assert!(printed[1].contains("client-1"), "{}", printed[1]);
        assert!(printed[2].contains("refresh_token"), "{}", printed[2]);
    }

    #[test]
    fn secret_form_fields_are_the_code_verifier_and_refresh_token() {
        let body = Body::Form(vec![
            ("grant_type", "authorization_code"),
            ("code", "c"),
            ("redirect_uri", "https://panel.test/cb"),
            ("client_id", "id"),
            ("code_verifier", "v"),
            ("refresh_token", "r"),
        ]);
        assert_eq!(body.secrets(), ["c", "v", "r"]);
        assert!(Body::Empty.secrets().is_empty());
    }
}
