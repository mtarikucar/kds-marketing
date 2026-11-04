//! The LinkedIn client: URLs, sending through the egress client (reads tried once more when no
//! answer arrived, everything else never), reading answers with their headers, and mapping
//! LinkedIn's errors to [`ConnectorError`] (the crate docs hold the table).

use std::fmt;

use jt_connector::ConnectorError;
use jt_outbound::{EgressError, EgressScope, Method, Prepared, Response, StatusCode, header};
use serde_json::Value;
use time::Duration;
use url::Url;

use crate::{DEFAULT_API_VERSION, LinkedinConnector, Masked, READ_ATTEMPTS};

/// The egress scope of every call.
const SCOPE: EgressScope = EgressScope::Connector("linkedin");

/// The largest answer read, in bytes; a larger one is `Permanent` (`Unknown` after a write).
const MAX_BODY_BYTES: usize = 4 << 20;

/// The longest error reason kept, in characters.
const MAX_REASON_CHARS: usize = 300;

/// The shortest query value of an upload URL taken out of reasons (LinkedIn's upload tokens are
/// longer; shorter values are flags such as `sync=0`).
const MIN_SCRUBBED_QUERY_VALUE: usize = 8;

/// The longest wait a throttle asks for: a provider's longer (or absurd) wait is cut to it, so a
/// scheduler adding it to the clock can never overflow.
pub const MAX_RETRY_AFTER: Duration = Duration::hours(1);

/// Why a token call's `invalid_client` is refused: the platform's LinkedIn client (its id or
/// secret) was not accepted, which only the platform's configuration can fix.
pub(crate) const CLIENT_REJECTED: &str = "platform client credentials rejected";

/// The form fields of a token call that are not secret (every other one is: the code, the client
/// secret, the refresh token).
const PUBLIC_FORM_FIELDS: &[&str] = &["grant_type", "client_id", "redirect_uri"];

/// The header naming the REST API version, `YYYYMM` (the versioning page).
const VERSION_HEADER: &str = "linkedin-version";

/// The header naming the Rest.li protocol, and the version every REST call speaks.
const RESTLI_HEADER: &str = "x-restli-protocol-version";
const RESTLI_VERSION: &str = "2.0.0";

/// Which grant a token call asks for: the errors of the two read differently.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Grant {
    /// An authorization code for a first token.
    Code,
    /// A refresh token for a new token.
    Refresh,
}

/// Which kind of endpoint a call goes to: which headers it carries and how its answer is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Endpoint {
    /// The token endpoint (`www.linkedin.com/oauth/v2/accessToken`): RFC 6749 answers and errors.
    Token(Grant),
    /// OpenID userinfo (`/v2/userinfo`): unversioned, no Rest.li headers.
    OpenId,
    /// The versioned REST API (`/rest/...`): `Linkedin-Version` and `X-Restli-Protocol-Version`.
    Rest,
    /// An upload URL LinkedIn handed out: its success body is not read, and its 401 is the URL's
    /// (an expired upload URL), not the account's token.
    Upload,
}

/// How a call authenticates. `Debug` masks the token.
#[derive(Clone, Copy)]
pub(crate) enum Auth<'a> {
    /// The account's access token.
    Bearer(&'a str),
    /// None: the token endpoint (the client is in the form) and a video part upload (LinkedIn
    /// takes no token there).
    Anonymous,
}

impl fmt::Debug for Auth<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Auth::Bearer(_) => f.debug_tuple("Bearer").field(&Masked).finish(),
            Auth::Anonymous => f.write_str("Anonymous"),
        }
    }
}

/// A request body. `Debug` shows its shape only: a form carries a code, a client secret or a
/// refresh token, a JSON body a post, bytes a file.
pub(crate) enum Body<'a> {
    Empty,
    Json(Value),
    Form(Vec<(&'static str, &'a str)>),
    /// Raw bytes with their media type (an upload).
    Bytes {
        bytes: &'a [u8],
        mime: &'a str,
    },
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
            Body::Bytes { bytes, mime } => f
                .debug_struct("Bytes")
                .field("len", &bytes.len())
                .field("mime", mime)
                .finish(),
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
    fn apply(&self, request: Prepared) -> Prepared {
        match self {
            Body::Empty => request,
            Body::Json(json) => request.json(json),
            Body::Form(fields) => request.form(fields),
            Body::Bytes { bytes, mime } => request
                .header(header::CONTENT_TYPE, *mime)
                .body(bytes.to_vec()),
        }
    }
}

/// A successful answer: its headers (a post's id is in `x-restli-id`, a video part's in `ETag`)
/// and its JSON, when it has a body (an upload's body is never read).
#[derive(Debug)]
pub(crate) struct Answer {
    pub(crate) headers: header::HeaderMap,
    pub(crate) json: Option<Value>,
}

impl Answer {
    /// Its JSON; `Permanent` when it had none.
    pub(crate) fn json(&self) -> Result<&Value, ConnectorError> {
        self.json.as_ref().ok_or_else(|| missing("body"))
    }

    /// The trimmed text of header `name`, when present and readable.
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty())
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
            .expect("a LinkedIn base URL has a path that segments can be pushed to");
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

/// `base` with `segments` appended to its path as they are (each already percent-encoded with
/// [`pct`], or plain ASCII without `/`, `?` or `#`) and the query `query` as it is: Rest.li's
/// `List(...)` and encoded URNs must reach LinkedIn exactly as written, which a form serializer
/// would change (`(` becomes `%28`).
pub(crate) fn raw_url(base: &Url, segments: &[&str], query: Option<&str>) -> Url {
    let mut url = base.clone();
    url.set_query(None);
    url.set_fragment(None);
    let mut path = url.path().trim_end_matches('/').to_owned();
    for segment in segments {
        path.push('/');
        path.push_str(segment);
    }
    url.set_path(&path);
    url.set_query(query);
    url
}

/// `text` percent-encoded but for the unreserved characters (`A-Z a-z 0-9 - . _ ~`): a URN as
/// LinkedIn takes it in a path or a query (`urn:li:share:1` → `urn%3Ali%3Ashare%3A1`).
pub(crate) fn pct(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for b in text.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// A JSON value that is a non-empty string or an integer, as text.
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

/// Whether `version` is a `Linkedin-Version`: `YYYYMM` with a month of 01 to 12, optionally a
/// patch `.NN`.
fn is_version(version: &str) -> bool {
    let (main, patch) = match version.split_once('.') {
        Some((main, patch)) => (main, Some(patch)),
        None => (version, None),
    };
    let month = main.get(4..).and_then(|m| m.parse::<u8>().ok());
    main.len() == 6
        && main.bytes().all(|b| b.is_ascii_digit())
        && month.is_some_and(|m| (1..=12).contains(&m))
        && patch.is_none_or(|p| (1..=2).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_digit()))
}

impl LinkedinConnector {
    /// The `Linkedin-Version` of the REST calls, read now: the app's `api_version` when it names
    /// one, else [`DEFAULT_API_VERSION`]; `Permanent` for a configured value that is not one.
    pub(crate) fn api_version(&self) -> Result<String, ConnectorError> {
        let configured = self
            .apps
            .linkedin_app()
            .and_then(|app| app.api_version)
            .map(|v| v.trim().to_owned())
            .filter(|v| !v.is_empty());
        match configured {
            None => Ok(DEFAULT_API_VERSION.to_owned()),
            Some(v) if is_version(&v) => Ok(v),
            Some(_) => Err(ConnectorError::permanent(
                "the configured LinkedIn API version is not YYYYMM",
            )),
        }
    }

    /// The API URL of `segments` (each one segment, percent-encoded by [`join`]) with `query`.
    pub(crate) fn api_url(&self, segments: &[&str], query: &[(&str, &str)]) -> Url {
        join(&self.bases.api, segments, query)
    }

    /// The REST URL `{api}/rest/{segments}` with the raw `query` (see [`raw_url`]).
    pub(crate) fn rest_url(&self, segments: &[&str], query: Option<&str>) -> Url {
        let mut all = vec!["rest"];
        all.extend_from_slice(segments);
        raw_url(&self.bases.api, &all, query)
    }

    /// The token endpoint, `{oauth}/oauth/v2/accessToken`.
    pub(crate) fn token_url(&self) -> Url {
        join(&self.bases.oauth, &["oauth", "v2", "accessToken"], &[])
    }

    /// Sends one call to `endpoint` and reads its answer: the headers and JSON of a success, else
    /// the error it maps to. A `GET` is tried once more when no answer arrives (the connection
    /// fails, drops or times out); anything else is sent once. Once any answer arrives nothing is
    /// sent again. Every secret of the call (the token, the secret form fields, an upload URL and
    /// its query) is taken out of any provider text quoted in an error.
    pub(crate) async fn call(
        &self,
        method: Method,
        url: Url,
        auth: Auth<'_>,
        body: &Body<'_>,
        endpoint: Endpoint,
    ) -> Result<Answer, ConnectorError> {
        let read_only = method == Method::GET;
        let attempts = if read_only { READ_ATTEMPTS.max(1) } else { 1 };
        let timeout = if endpoint == Endpoint::Upload {
            self.upload_timeout
        } else {
            self.attempt_timeout
        };
        let version = match endpoint {
            Endpoint::Rest => Some(self.api_version()?),
            _ => None,
        };
        // The upload URLs carry LinkedIn's own upload tokens in their query (the values long
        // enough to be one: a short value such as `0` or `beta` would only mangle the reason).
        let url_text = url.as_str().to_owned();
        let query_values: Vec<String> = if endpoint == Endpoint::Upload {
            url.query_pairs()
                .map(|(_, v)| v.into_owned())
                .filter(|v| v.len() >= MIN_SCRUBBED_QUERY_VALUE)
                .collect()
        } else {
            Vec::new()
        };
        let mut secrets = body.secrets();
        if let Auth::Bearer(token) = auth {
            secrets.push(token);
        }
        if endpoint == Endpoint::Upload {
            secrets.push(&url_text);
            secrets.extend(query_values.iter().map(String::as_str));
        }
        let mut attempt = 1;
        loop {
            let mut request = self
                .egress
                .prepare(method.clone(), url.clone())
                .timeout(timeout);
            if let Auth::Bearer(token) = auth {
                request = request.bearer(token);
            }
            if let Some(version) = &version {
                request = request
                    .header(VERSION_HEADER, version.as_str())
                    .header(RESTLI_HEADER, RESTLI_VERSION);
            }
            request = body.apply(request);
            match request.send(SCOPE).await {
                Ok(response) => {
                    return read(response, endpoint, &secrets, read_only, version.as_deref()).await;
                }
                Err(EgressError::Transport(err)) if attempt < attempts => {
                    tracing::warn!(
                        attempt,
                        timed_out = err.is_timeout(),
                        "a read from LinkedIn got no answer; trying again"
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
/// no answer after its request may have reached LinkedIn says its outcome is unknown.
fn egress_error(e: EgressError, read_only: bool) -> ConnectorError {
    match e {
        EgressError::Transport(err) if err.is_connect() => {
            ConnectorError::transient("the call to LinkedIn could not connect; nothing was sent")
        }
        EgressError::Transport(err) if !read_only => {
            let what = if err.is_timeout() {
                "timed out"
            } else {
                "got no answer"
            };
            ConnectorError::unknown(format!(
                "the call to LinkedIn {what} after the request may have reached it: the outcome \
                 is unknown, so it was not sent again"
            ))
        }
        EgressError::Transport(err) if err.is_timeout() => {
            ConnectorError::transient("the call to LinkedIn timed out: no answer")
        }
        EgressError::Transport(_) => {
            ConnectorError::transient("the call to LinkedIn got no answer")
        }
        EgressError::NotPublic { .. } => {
            ConnectorError::transient("the LinkedIn host resolved to no public address")
        }
        EgressError::HostNotAllowed { .. } => {
            ConnectorError::permanent("the host is not allowed for the linkedin connector")
        }
        EgressError::Socket => ConnectorError::transient("outbound socket failed"),
        EgressError::Build(_) => {
            ConnectorError::permanent("the call to LinkedIn could not be built")
        }
    }
}

/// Reads `response` from `endpoint`: its headers and JSON on success, its mapped error otherwise.
/// The body is read up to [`MAX_BODY_BYTES`] and never logged.
async fn read(
    mut response: Response,
    endpoint: Endpoint,
    secrets: &[&str],
    read_only: bool,
    version: Option<&str>,
) -> Result<Answer, ConnectorError> {
    let status = response.status();
    let headers = response.headers().clone();
    let wait = retry_after(&headers);
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MAX_BODY_BYTES {
                    return Err(if !read_only && status.is_success() {
                        ConnectorError::unknown("LinkedIn's answer is too large after a write")
                    } else {
                        ConnectorError::permanent("LinkedIn's answer is too large")
                    });
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            // An answer arrived (it may have been acted on): never sent again.
            Err(_) => {
                let error = if !read_only {
                    ConnectorError::unknown
                } else {
                    ConnectorError::transient
                };
                return Err(error(
                    "LinkedIn's answer broke off in transit: whether the request took effect is \
                     unknown",
                ));
            }
        }
    }
    let json = serde_json::from_slice::<Value>(&body).ok();
    if !status.is_success() {
        return Err(classify(
            status,
            json.as_ref(),
            wait,
            endpoint,
            secrets,
            version,
        ));
    }
    if endpoint == Endpoint::Upload || body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Answer {
            headers,
            json: None,
        });
    }
    match json {
        Some(json) => Ok(Answer {
            headers,
            json: Some(json),
        }),
        None if !read_only => Err(ConnectorError::unknown(
            "unreadable successful write response",
        )),
        None => Err(ConnectorError::permanent(format!(
            "HTTP {} with an unreadable body",
            status.as_u16()
        ))),
    }
}

/// The error an answer with status `status` and body `json` (when it is JSON) from `endpoint`
/// maps to (the table in the crate docs; first match wins), with `wait` for a `Throttle` and the
/// `Linkedin-Version` sent, `version`, for a 426.
pub(crate) fn classify(
    status: StatusCode,
    json: Option<&Value>,
    wait: Option<Duration>,
    endpoint: Endpoint,
    secrets: &[&str],
    version: Option<&str>,
) -> ConnectorError {
    if status == StatusCode::TOO_MANY_REQUESTS {
        return ConnectorError::throttle(wait);
    }
    let oauth_error = json.and_then(|j| j["error"].as_str());
    // The token endpoint refusing the platform's own client (its id or secret): no tenant can
    // fix that by reconnecting, so it is never the tenant's `Auth`.
    if matches!(endpoint, Endpoint::Token(_))
        && status.is_client_error()
        && oauth_error == Some("invalid_client")
    {
        return ConnectorError::permanent(CLIENT_REJECTED);
    }
    let mut reason = reason(status, json, secrets);
    let spent = match endpoint {
        Endpoint::Token(Grant::Code) => {
            matches!(oauth_error, Some("invalid_grant" | "invalid_redirect_uri"))
        }
        Endpoint::Token(Grant::Refresh) => {
            matches!(oauth_error, Some("invalid_grant" | "invalid_request"))
        }
        _ => false,
    };
    if status == StatusCode::UNAUTHORIZED && endpoint == Endpoint::Upload {
        // An upload URL that expired (LinkedIn answers 401 to one); the token is not at fault.
        return ConnectorError::permanent(reason);
    }
    if status == StatusCode::UNAUTHORIZED || (status.is_client_error() && spent) {
        return ConnectorError::auth(reason);
    }
    if status == StatusCode::FORBIDDEN {
        return ConnectorError::permission(reason);
    }
    if status == StatusCode::UPGRADE_REQUIRED {
        if let Some(version) = version {
            let note = format!(" (Linkedin-Version {version} sent)");
            let room = MAX_REASON_CHARS.saturating_sub(note.chars().count());
            reason = reason.chars().take(room).collect::<String>() + &note;
        }
        return ConnectorError::permanent(reason);
    }
    if status.is_server_error() {
        return ConnectorError::transient(reason);
    }
    ConnectorError::permanent(reason)
}

/// `"HTTP <status> <code>: <message>"` of a LinkedIn API error (its `code`, else its
/// `serviceErrorCode`), `"HTTP <status> <error>: <error_description>"` of a token error, or
/// `"HTTP <status> with an unreadable body"`; every secret in `secrets` taken out, cut to
/// [`MAX_REASON_CHARS`].
fn reason(status: StatusCode, json: Option<&Value>, secrets: &[&str]) -> String {
    let mut out = format!("HTTP {}", status.as_u16());
    let Some(json) = json else {
        out.push_str(" with an unreadable body");
        return out;
    };
    let (head, detail) = match words(&json["error"]) {
        Some(error) => (Some(error.to_owned()), words(&json["error_description"])),
        None => (
            words(&json["code"])
                .map(str::to_owned)
                .or_else(|| json["serviceErrorCode"].as_i64().map(|c| c.to_string())),
            words(&json["message"]),
        ),
    };
    if let Some(head) = head {
        out.push(' ');
        out.push_str(&head);
    }
    if let Some(detail) = detail {
        out.push_str(": ");
        out.push_str(detail);
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

/// `text` with every secret of `secrets` replaced by `***`, longest first, as is and
/// percent-encoded (a provider may echo either form). The reason's constructor then redacts what
/// still looks like a credential.
fn scrub(text: &str, secrets: &[&str]) -> String {
    let mut forms: Vec<String> = Vec::new();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        forms.push((*secret).to_owned());
        let encoded = pct(secret);
        if encoded != *secret {
            forms.push(encoded);
        }
    }
    forms.sort_by_key(|s| std::cmp::Reverse(s.len()));
    let mut out = text.to_owned();
    for secret in forms {
        out = out.replace(&secret, "***");
    }
    out
}

/// How long LinkedIn asks to wait: `Retry-After` in seconds, when positive, at most
/// [`MAX_RETRY_AFTER`]; `None` when it names none.
pub(crate) fn retry_after(headers: &header::HeaderMap) -> Option<Duration> {
    headers
        .get(header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|s| *s > 0)
        .map(|s| Duration::seconds(s.min(MAX_RETRY_AFTER.whole_seconds())))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn kind(status: u16, body: Option<Value>, endpoint: Endpoint) -> &'static str {
        classify(
            StatusCode::from_u16(status).unwrap(),
            body.as_ref(),
            None,
            endpoint,
            &[],
            Some("202610"),
        )
        .kind()
    }

    #[test]
    fn errors_map_by_the_table() {
        let rest = Endpoint::Rest;
        let code = Endpoint::Token(Grant::Code);
        let refresh = Endpoint::Token(Grant::Refresh);
        let upload = Endpoint::Upload;
        let token_error = |e: &str| Some(json!({ "error": e, "error_description": "d" }));
        let api_error = |s: u16, c: &str| Some(json!({ "status": s, "code": c, "message": "m" }));
        for (status, body, endpoint, expected) in [
            (429, None, rest, "throttle"),
            (429, token_error("invalid_grant"), refresh, "throttle"),
            (401, api_error(401, "EMPTY_ACCESS_TOKEN"), rest, "auth"),
            (401, None, Endpoint::OpenId, "auth"),
            (401, token_error("invalid_client"), code, "permanent"),
            (400, token_error("invalid_client"), refresh, "permanent"),
            (401, token_error("invalid_request"), code, "auth"),
            (400, token_error("invalid_redirect_uri"), code, "auth"),
            (400, token_error("invalid_grant"), code, "auth"),
            (400, token_error("invalid_request"), code, "permanent"),
            (400, token_error("invalid_request"), refresh, "auth"),
            (400, token_error("invalid_grant"), refresh, "auth"),
            (400, token_error("invalid_grant"), rest, "permanent"),
            (403, api_error(403, "ACCESS_DENIED"), rest, "permission"),
            (
                426,
                api_error(426, "NONEXISTENT_VERSION"),
                rest,
                "permanent",
            ),
            (500, None, rest, "transient"),
            (
                503,
                token_error("temporarily_unavailable"),
                refresh,
                "transient",
            ),
            (
                400,
                api_error(400, "INVALID_VALUE_FOR_FIELD"),
                rest,
                "permanent",
            ),
            (404, None, rest, "permanent"),
            (302, None, rest, "permanent"),
            // An expired upload URL is the URL's, not the token's.
            (401, None, upload, "permanent"),
            (403, None, upload, "permission"),
        ] {
            assert_eq!(
                kind(status, body.clone(), endpoint),
                expected,
                "{status} {body:?} {endpoint:?}"
            );
        }
    }

    #[test]
    fn reasons_quote_linkedin_without_secrets() {
        let api = json!({
            "status": 403, "serviceErrorCode": 100, "code": "ACCESS_DENIED",
            "message": "Not enough permissions for tok-SECRET-1",
        });
        assert_eq!(
            reason(StatusCode::FORBIDDEN, Some(&api), &["tok-SECRET-1"]),
            "HTTP 403 ACCESS_DENIED: Not enough permissions for ***"
        );
        let legacy = json!({ "status": 401, "serviceErrorCode": 65601, "message": "revoked" });
        assert_eq!(
            reason(StatusCode::UNAUTHORIZED, Some(&legacy), &[]),
            "HTTP 401 65601: revoked"
        );
        let token = json!({ "error": "invalid_request", "error_description": "code c/SECRET" });
        assert_eq!(
            reason(StatusCode::BAD_REQUEST, Some(&token), &["c/SECRET"]),
            "HTTP 400 invalid_request: code ***"
        );
        // The percent-encoded form of a secret is taken out too.
        let echoed = json!({ "message": "saw c%2FSECRET" });
        assert_eq!(
            reason(StatusCode::BAD_REQUEST, Some(&echoed), &["c/SECRET"]),
            "HTTP 400: saw ***"
        );
        assert_eq!(
            reason(StatusCode::BAD_GATEWAY, None, &[]),
            "HTTP 502 with an unreadable body"
        );
        let long = json!({ "message": "x".repeat(1_000) });
        assert_eq!(
            reason(StatusCode::BAD_REQUEST, Some(&long), &[])
                .chars()
                .count(),
            MAX_REASON_CHARS
        );
        assert_eq!(scrub("ab abc", &["ab", "abc"]), "*** ***");
    }

    #[test]
    fn a_426_names_the_version_sent() {
        let body = json!({
            "status": 426, "code": "NONEXISTENT_VERSION",
            "message": "Requested version 202401 is not active",
        });
        let e = classify(
            StatusCode::UPGRADE_REQUIRED,
            Some(&body),
            None,
            Endpoint::Rest,
            &[],
            Some("202401"),
        );
        assert_eq!(
            (e.kind(), e.reason()),
            (
                "permanent",
                Some(
                    "HTTP 426 NONEXISTENT_VERSION: Requested version 202401 is not active \
                     (Linkedin-Version 202401 sent)"
                )
            )
        );
    }

    #[test]
    fn waits_come_from_retry_after_capped() {
        let headers = |value: &str| {
            let mut map = header::HeaderMap::new();
            map.insert(header::RETRY_AFTER, value.parse().unwrap());
            map
        };
        assert_eq!(retry_after(&header::HeaderMap::new()), None);
        assert_eq!(retry_after(&headers("30")), Some(Duration::seconds(30)));
        assert_eq!(retry_after(&headers("0")), None);
        assert_eq!(retry_after(&headers("soon")), None);
        assert_eq!(retry_after(&headers("99999999")), Some(MAX_RETRY_AFTER));
    }

    #[test]
    fn versions_are_yyyymm() {
        for ok in ["202610", "202401", "202305.01", "209912"] {
            assert!(is_version(ok), "{ok}");
        }
        for bad in [
            "",
            "2026",
            "20261",
            "2026100",
            "202613",
            "202600",
            "abcdef",
            "202610.",
            "202610.123",
            "202610\n",
            "v202610",
        ] {
            assert!(!is_version(bad), "{bad:?}");
        }
    }

    #[test]
    fn raw_urls_keep_restli_lists_and_encoded_urns() {
        let base = Url::parse("http://127.0.0.1:9/api/").unwrap();
        let urn = pct("urn:li:organization:5");
        let url = raw_url(
            &base,
            &["rest", "networkSizes", &urn],
            Some("edgeType=COMPANY_FOLLOWED_BY_MEMBER"),
        );
        assert_eq!(
            url.as_str(),
            "http://127.0.0.1:9/api/rest/networkSizes/urn%3Ali%3Aorganization%3A5?edgeType=COMPANY_FOLLOWED_BY_MEMBER"
        );
        let query = format!("q=x&shares=List({})", pct("urn:li:share:7"));
        let url = raw_url(&base, &["rest", "stats"], Some(&query));
        assert_eq!(
            url.as_str(),
            "http://127.0.0.1:9/api/rest/stats?q=x&shares=List(urn%3Ali%3Ashare%3A7)"
        );
        let root = Url::parse("https://api.linkedin.com").unwrap();
        assert_eq!(
            raw_url(&root, &["rest", "posts"], None).as_str(),
            "https://api.linkedin.com/rest/posts"
        );
        assert_eq!(pct("a b/c~d_e.f-g"), "a%20b%2Fc~d_e.f-g");
    }

    #[test]
    fn joined_urls_keep_the_base_path_and_encode_segments() {
        let base = Url::parse("http://127.0.0.1:9/www/").unwrap();
        assert_eq!(
            join(&base, &["oauth", "v2", "accessToken"], &[]).as_str(),
            "http://127.0.0.1:9/www/oauth/v2/accessToken"
        );
        assert_eq!(
            join(&base, &["a/b"], &[("x", "1 2")]).as_str(),
            "http://127.0.0.1:9/www/a%2Fb?x=1+2"
        );
    }

    #[test]
    fn debug_masks_tokens_secrets_and_bodies() {
        let printed = [
            format!("{:?}", Auth::Bearer("tok-SECRET")),
            format!(
                "{:?}",
                Body::Form(vec![
                    ("grant_type", "refresh_token"),
                    ("refresh_token", "r-SECRET"),
                    ("client_secret", "c-SECRET"),
                ])
            ),
            format!("{:?}", Body::Json(json!({ "commentary": "post-SECRET" }))),
            format!(
                "{:?}",
                Body::Bytes {
                    bytes: b"SECRET",
                    mime: "image/png"
                }
            ),
        ];
        for text in &printed {
            assert!(!text.contains("SECRET"), "{text}");
        }
        assert!(printed[1].contains("refresh_token"), "{}", printed[1]);
    }

    #[test]
    fn secret_form_fields_are_the_code_secret_and_refresh_token() {
        let body = Body::Form(vec![
            ("grant_type", "authorization_code"),
            ("code", "c"),
            ("redirect_uri", "https://panel.test/cb"),
            ("client_id", "id"),
            ("client_secret", "s"),
            ("refresh_token", "r"),
        ]);
        assert_eq!(body.secrets(), ["c", "s", "r"]);
        assert!(Body::Empty.secrets().is_empty());
    }
}
