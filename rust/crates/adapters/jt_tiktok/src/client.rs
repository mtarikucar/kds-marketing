//! The TikTok client: URLs, sending through the egress client (reads tried once more when no
//! answer arrived, writes never), reading answers, the chunk upload, and mapping TikTok's errors to
//! [`ConnectorError`] (the crate docs hold the table).

use std::fmt;

use jt_connector::ConnectorError;
use jt_outbound::{EgressError, EgressScope, Method, Prepared, Response, StatusCode, header};
use serde_json::Value;
use url::Url;

use crate::{Masked, READ_ATTEMPTS, TiktokConnector};

/// The egress scope of every call.
const SCOPE: EgressScope = EgressScope::Connector("tiktok");

/// The largest answer read, in bytes; a larger one is `Permanent` (or `Unknown`, see [`Effect`]).
const MAX_BODY_BYTES: usize = 4 << 20;

/// The longest error reason kept, in characters.
const MAX_REASON_CHARS: usize = 300;

/// The media type of every JSON body, as the Content Posting API asks for it
/// (<https://developers.tiktok.com/doc/content-posting-api-reference-direct-post>).
const JSON_TYPE: &str = "application/json; charset=UTF-8";

/// Why the token endpoint's `invalid_client` is refused: the platform's TikTok client (its key or
/// secret) was not accepted, which only the platform's configuration can fix.
pub(crate) const CLIENT_REJECTED: &str = "platform client credentials rejected";

/// The form fields of a token call that are not secret (every other one is: the client secret,
/// the code, the refresh token).
const PUBLIC_FORM_FIELDS: &[&str] = &["grant_type", "client_key", "redirect_uri"];

/// `error.code`s that say the grant lacks a scope, or the creator or the app may not post that
/// way (<https://developers.tiktok.com/doc/tiktok-api-v2-error-handling>,
/// <https://developers.tiktok.com/doc/content-posting-api-reference-direct-post>):
/// `Permission`. `scope_not_authorized` comes with HTTP 401, so these are read before the 401.
const PERMISSION_CODES: &[&str] = &[
    "scope_not_authorized",
    "scope_permission_missed",
    "privacy_level_option_mismatch",
    "unaudited_client_can_only_post_to_private_accounts",
    "spam_risk_user_banned_from_posting",
];

/// `error.code`s that ask to slow down: the API's rate limit, the creator's daily post cap
/// (`creator_info` answers it with HTTP 200), the client's daily publishing users: `Throttle`.
const THROTTLE_CODES: &[&str] = &[
    "rate_limit_exceeded",
    "spam_risk_too_many_posts",
    "reached_active_user_cap",
    // The daily cap on drafts waiting for the creator in their inbox
    // (<https://developers.tiktok.com/doc/content-posting-api-reference-upload-video>).
    "spam_risk_too_many_pending_share",
];

/// `error.code`s of a token that is no longer accepted: `Auth`. TikTok's table names
/// `access_token_invalid`; the other two are the names v1 knew them by.
const AUTH_CODES: &[&str] = &[
    "access_token_invalid",
    "access_token_expired",
    "token_revoked",
];

/// `error.code`s of a failure on TikTok's side: `Transient`.
const TRANSIENT_CODES: &[&str] = &["internal_error"];

/// The token endpoint's `error`s of a failure on TikTok's side
/// (<https://developers.tiktok.com/doc/oauth-error-handling>): `Transient`.
const TOKEN_TRANSIENT_ERRORS: &[&str] = &["server_error", "temporarily_unavailable"];

/// Which kind of endpoint a call goes to: how its answer is read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Endpoint {
    /// The Open API: a success is HTTP 2xx with `error.code == "ok"`.
    Api,
    /// The token endpoint: an answer naming an `error` is a failure.
    Token,
    /// The token endpoint's revocation: as [`Endpoint::Token`], and a 2xx with an empty body (the
    /// empty struct TikTok answers a revocation with) is a success.
    Revoke,
}

/// What a call does at TikTok: whether it may be sent again, and what a lost answer means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Effect {
    /// Changes nothing (a `GET`, or a `POST` query): tried once more when no answer arrived.
    Read,
    /// A write that cannot post anything by itself (a video's init, a chunk before the last):
    /// sent once; a lost answer is `Transient`, since TikTok posts a video only once all of it
    /// is uploaded and nothing more is sent.
    Stage,
    /// A write that may post (a photo's init, a video's last chunk) or spend a grant (the token
    /// calls): sent once; a lost answer is `Unknown`.
    Commit,
}

/// How a call authenticates. `Debug` masks the token.
#[derive(Clone, Copy)]
pub(crate) enum Auth<'a> {
    /// The account's access token.
    Bearer(&'a str),
    /// None in a header: the token endpoint takes the client in its form.
    Form,
}

impl fmt::Debug for Auth<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Auth::Bearer(_) => f.debug_tuple("Bearer").field(&Masked).finish(),
            Auth::Form => f.write_str("Form"),
        }
    }
}

/// A request body. `Debug` shows its shape only: a form carries the client secret and a code or a
/// refresh token, a JSON body a post.
pub(crate) enum Body<'a> {
    /// None at all.
    Empty,
    /// None, sent as JSON (`creator_info` takes no body but a JSON content type).
    EmptyJson,
    Json(Value),
    Form(Vec<(&'static str, &'a str)>),
}

impl fmt::Debug for Body<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Body::Empty => f.write_str("Empty"),
            Body::EmptyJson => f.write_str("EmptyJson"),
            Body::Json(_) => f.debug_tuple("Json").field(&Masked).finish(),
            Body::Form(fields) => {
                let names: Vec<&str> = fields.iter().map(|(name, _)| *name).collect();
                f.debug_struct("Form")
                    .field("fields", &names)
                    .field("values", &Masked)
                    .finish()
            }
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
            Body::EmptyJson => request.header(header::CONTENT_TYPE, JSON_TYPE),
            Body::Json(json) => request
                .header(header::CONTENT_TYPE, JSON_TYPE)
                .body(json.to_string().into_bytes()),
            Body::Form(fields) => request.form(fields),
        }
    }
}

/// One chunk of a video, `PUT` to its upload URL.
pub(crate) struct Chunk<'a> {
    /// Its bytes.
    pub(crate) bytes: &'a [u8],
    /// The offset of its first byte in the video.
    pub(crate) first: u64,
    /// The video's size, in bytes.
    pub(crate) total: u64,
    /// The video's media type.
    pub(crate) mime: &'a str,
    /// [`Effect::Commit`] for the last chunk, else [`Effect::Stage`].
    pub(crate) effect: Effect,
}

/// `base` with `segments` appended to its path, each one segment (percent-encoded; an empty last
/// segment gives TikTok's trailing slash), and `query`.
pub(crate) fn join(base: &Url, segments: &[&str], query: &[(&str, &str)]) -> Url {
    let mut url = base.clone();
    url.set_query(None);
    url.set_fragment(None);
    {
        let mut path = url
            .path_segments_mut()
            .expect("a TikTok base URL has a path that segments can be pushed to");
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

/// A JSON value that is a non-empty string or an integer, as text (TikTok's open ids and publish
/// ids are strings, its video ids int64).
pub(crate) fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Value::Number(n) if n.is_i64() || n.is_u64() => Some(n.to_string()),
        _ => None,
    }
}

/// The trimmed text of a JSON string, when it has any.
pub(crate) fn words(value: &Value) -> Option<&str> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty())
}

/// `Permanent`: the answer lacks something the call needs.
pub(crate) fn missing(what: &str) -> ConnectorError {
    ConnectorError::permanent(format!("the provider's answer has no {what}"))
}

/// The provider's error code of an answer: an API answer's `error.code`, a token answer's
/// `error`.
pub(crate) fn error_code(json: &Value) -> Option<&str> {
    match &json["error"] {
        Value::String(_) => words(&json["error"]),
        Value::Object(_) => words(&json["error"]["code"]),
        _ => None,
    }
}

/// The provider's words for an error: an API answer's `error.message`, a token answer's
/// `error_description`.
fn error_message(json: &Value) -> Option<&str> {
    match &json["error"] {
        Value::Object(_) => words(&json["error"]["message"]),
        _ => words(&json["error_description"]),
    }
}

/// The values of `url` that may be secret, to take out of any reason quoting it: the URL itself,
/// its query, each query value and each long path segment (TikTok's upload URL carries its own
/// authority).
pub(crate) fn url_secrets(url: &Url) -> Vec<String> {
    let mut out = vec![url.as_str().to_owned()];
    if let Some(query) = url.query() {
        out.push(query.to_owned());
    }
    out.extend(url.query_pairs().map(|(_, v)| v.into_owned()));
    out.extend(
        url.path_segments()
            .into_iter()
            .flatten()
            .filter(|s| s.len() >= 16)
            .map(str::to_owned),
    );
    out.retain(|s| !s.is_empty());
    out
}

impl TiktokConnector {
    /// The API URL of `segments` with `query`.
    pub(crate) fn api_url(&self, segments: &[&str], query: &[(&str, &str)]) -> Url {
        join(&self.bases.api, segments, query)
    }

    /// Sends one call to `endpoint` and reads its answer: the parsed JSON of a success, else the
    /// error it maps to. A read ([`Effect::Read`]) is tried once more when no answer arrives (the
    /// connection fails, drops or times out); a write is sent once. Once any answer arrives
    /// nothing is sent again. Every secret of the call (the token, the secret form fields) is
    /// taken out of any provider text quoted in an error.
    pub(crate) async fn call(
        &self,
        method: Method,
        url: Url,
        auth: Auth<'_>,
        body: &Body<'_>,
        endpoint: Endpoint,
        effect: Effect,
    ) -> Result<Value, ConnectorError> {
        self.call_taking(method, url, auth, body, endpoint, effect, &[])
            .await
    }

    /// [`TiktokConnector::call`], also taking as an answer an HTTP 2xx whose `error.code` is one
    /// of `taken` (its JSON, for the caller to read the code from), as `creator_info` answers an
    /// account that may not post at this moment.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn call_taking(
        &self,
        method: Method,
        url: Url,
        auth: Auth<'_>,
        body: &Body<'_>,
        endpoint: Endpoint,
        effect: Effect,
        taken: &[&str],
    ) -> Result<Value, ConnectorError> {
        let attempts = if effect == Effect::Read {
            READ_ATTEMPTS.max(1)
        } else {
            1
        };
        let mut secrets = body.secrets();
        if let Auth::Bearer(token) = auth {
            secrets.push(token);
        }
        let mut attempt = 1;
        loop {
            let mut request = self
                .egress
                .prepare(method.clone(), url.clone())
                .timeout(self.attempt_timeout);
            if let Auth::Bearer(token) = auth {
                request = request.bearer(token);
            }
            request = body.apply(request);
            match request.send(SCOPE).await {
                Ok(response) => return read(response, endpoint, &secrets, effect, taken).await,
                Err(EgressError::Transport(err)) if attempt < attempts => {
                    tracing::warn!(
                        attempt,
                        timed_out = err.is_timeout(),
                        "a read from TikTok got no answer; trying again"
                    );
                    if !self.retry_delay.is_zero() {
                        tokio::time::sleep(self.retry_delay).await;
                    }
                    attempt += 1;
                }
                Err(e) => return Err(egress_error(e, effect)),
            }
        }
    }

    /// `PUT`s `chunk` to the video's upload URL `url` (never logged or quoted: it carries its own
    /// authority), with `Content-Type`, `Content-Length` and `Content-Range`, once. Every 2xx is
    /// taken (TikTok answers 206 before the last chunk, 201 after it); any other answer maps as
    /// the API's do, the URL's parts taken out of its reason.
    pub(crate) async fn put_chunk(
        &self,
        url: &Url,
        chunk: &Chunk<'_>,
    ) -> Result<(), ConnectorError> {
        let length = chunk.bytes.len() as u64;
        let last = chunk.first + length.saturating_sub(1);
        let request = self
            .egress
            .prepare(Method::PUT, url.clone())
            .timeout(self.upload_timeout)
            .header(header::CONTENT_TYPE, chunk.mime)
            .header(header::CONTENT_LENGTH, length.to_string())
            .header(
                header::CONTENT_RANGE,
                format!("bytes {}-{last}/{}", chunk.first, chunk.total),
            )
            .body(chunk.bytes.to_vec());
        let mut response = request
            .send(SCOPE)
            .await
            .map_err(|e| egress_error(e, chunk.effect))?;
        let status = response.status();
        let body = match read_body(&mut response).await {
            Ok(body) => body,
            // A 2xx answer larger than any TikTok sends: the status has already said it all.
            Err(BodyError::TooLarge) if status.is_success() => return Ok(()),
            Err(BodyError::TooLarge) => Vec::new(),
            Err(BodyError::Broken) => return Err(broken(chunk.effect)),
        };
        if status.is_success() {
            return Ok(());
        }
        let owned = url_secrets(url);
        let secrets: Vec<&str> = owned.iter().map(String::as_str).collect();
        // The upload host may answer an error with no body at all: its status says it all.
        let json = if body.is_empty() {
            Some(Value::Object(serde_json::Map::new()))
        } else {
            serde_json::from_slice::<Value>(&body).ok()
        };
        Err(classify(status, json.as_ref(), Endpoint::Api, &secrets))
    }
}

/// An egress failure as a [`ConnectorError`] (no URL in it), as `effect` makes it read.
fn egress_error(e: EgressError, effect: Effect) -> ConnectorError {
    match e {
        EgressError::Transport(err) if err.is_connect() => {
            ConnectorError::transient("the call to TikTok could not connect; nothing was sent")
        }
        EgressError::Transport(err) if effect != Effect::Read => {
            let what = if err.is_timeout() {
                "timed out"
            } else {
                "got no answer"
            };
            if effect == Effect::Commit {
                ConnectorError::unknown(format!(
                    "the call to TikTok {what} after the request may have reached it: the \
                     outcome is unknown, so it was not sent again"
                ))
            } else {
                ConnectorError::transient(format!(
                    "the call to TikTok {what}; nothing can have been posted, since TikTok posts \
                     a video only once all of it is uploaded"
                ))
            }
        }
        EgressError::Transport(err) if err.is_timeout() => {
            ConnectorError::transient("the call to TikTok timed out: no answer")
        }
        EgressError::Transport(_) => ConnectorError::transient("the call to TikTok got no answer"),
        EgressError::NotPublic { .. } => {
            ConnectorError::transient("the TikTok host resolved to no public address")
        }
        EgressError::HostNotAllowed { .. } => {
            ConnectorError::permanent("the TikTok host is not allowed for the tiktok connector")
        }
        EgressError::Socket => ConnectorError::transient("outbound socket failed"),
        EgressError::Build(_) => ConnectorError::permanent("the call to TikTok could not be built"),
    }
}

/// Why an answer's body could not be read whole.
enum BodyError {
    /// Larger than [`MAX_BODY_BYTES`].
    TooLarge,
    /// It broke off in transit.
    Broken,
}

/// The body of `response`, up to [`MAX_BODY_BYTES`]; never logged.
async fn read_body(response: &mut Response) -> Result<Vec<u8>, BodyError> {
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MAX_BODY_BYTES {
                    return Err(BodyError::TooLarge);
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => return Ok(body),
            Err(_) => return Err(BodyError::Broken),
        }
    }
}

/// The error of an answer that broke off in transit: it arrived (it may have been acted on), so
/// it is never sent again.
fn broken(effect: Effect) -> ConnectorError {
    let reason = "TikTok's answer broke off in transit: whether the request took effect is unknown";
    match effect {
        Effect::Commit => ConnectorError::unknown(reason),
        Effect::Read | Effect::Stage => ConnectorError::transient(reason),
    }
}

/// Reads `response` from `endpoint`: its JSON on success (or on a 2xx whose code is one of
/// `taken`), its mapped error otherwise (see the crate docs).
async fn read(
    mut response: Response,
    endpoint: Endpoint,
    secrets: &[&str],
    effect: Effect,
    taken: &[&str],
) -> Result<Value, ConnectorError> {
    let status = response.status();
    let body = match read_body(&mut response).await {
        Ok(body) => body,
        Err(BodyError::TooLarge) => {
            return Err(if effect == Effect::Commit && status.is_success() {
                ConnectorError::unknown("TikTok's answer to a write is too large to read")
            } else {
                ConnectorError::permanent("TikTok's answer is too large")
            });
        }
        Err(BodyError::Broken) => return Err(broken(effect)),
    };
    let json = if endpoint == Endpoint::Revoke && status.is_success() && body.is_empty() {
        Some(Value::Object(serde_json::Map::new()))
    } else {
        serde_json::from_slice::<Value>(&body).ok()
    };
    if !status.is_success() {
        return Err(classify(status, json.as_ref(), endpoint, secrets));
    }
    let Some(json) = json else {
        if effect == Effect::Commit {
            return Err(ConnectorError::unknown(
                "unreadable successful write response",
            ));
        }
        return Err(classify(status, None, endpoint, secrets));
    };
    match (endpoint, error_code(&json)) {
        (_, Some("ok")) | (Endpoint::Token | Endpoint::Revoke, None) => Ok(json),
        (_, Some(code)) if taken.contains(&code) => Ok(json),
        (_, Some(_)) => Err(classify(status, Some(&json), endpoint, secrets)),
        (Endpoint::Api, None) if effect == Effect::Commit => Err(ConnectorError::unknown(
            "TikTok's answer to a write carries no error code: whether it took effect is unknown",
        )),
        (Endpoint::Api, None) => Err(ConnectorError::permanent(format!(
            "HTTP {} without TikTok's error code",
            status.as_u16()
        ))),
    }
}

/// The error an answer with status `status` and body `json` (when it is JSON) from `endpoint`
/// maps to (the table in the crate docs; first match wins). Used for every failed answer,
/// including a 2xx whose code is not `ok`.
pub(crate) fn classify(
    status: StatusCode,
    json: Option<&Value>,
    endpoint: Endpoint,
    secrets: &[&str],
) -> ConnectorError {
    let code = json.and_then(error_code);
    let reason = || reason(status, json, secrets);
    let is = |list: &[&str]| code.is_some_and(|c| list.contains(&c));
    if matches!(endpoint, Endpoint::Token | Endpoint::Revoke) {
        if status == StatusCode::TOO_MANY_REQUESTS {
            return ConnectorError::throttle(None);
        }
        // The token endpoint refusing the platform's own client (its key or secret): no tenant
        // can fix that by reconnecting, so it is never the tenant's `Auth`.
        if code == Some("invalid_client") {
            return ConnectorError::permanent(CLIENT_REJECTED);
        }
        if code == Some("invalid_grant") || status == StatusCode::UNAUTHORIZED {
            return ConnectorError::auth(reason());
        }
        if status.is_server_error() || is(TOKEN_TRANSIENT_ERRORS) || is(TRANSIENT_CODES) {
            return ConnectorError::transient(reason());
        }
        return ConnectorError::permanent(reason());
    }
    if is(PERMISSION_CODES) {
        return ConnectorError::permission(reason());
    }
    if is(THROTTLE_CODES) || status == StatusCode::TOO_MANY_REQUESTS {
        return ConnectorError::throttle(None);
    }
    if is(AUTH_CODES) || status == StatusCode::UNAUTHORIZED {
        return ConnectorError::auth(reason());
    }
    if is(TRANSIENT_CODES) || status.is_server_error() {
        return ConnectorError::transient(reason());
    }
    ConnectorError::permanent(reason())
}

/// `"HTTP <status> <code>: <message>"` of an answer (see [`error_code`], [`error_message`]), or
/// `"HTTP <status> with an unreadable body"`; every secret in `secrets` taken out, cut to
/// [`MAX_REASON_CHARS`].
fn reason(status: StatusCode, json: Option<&Value>, secrets: &[&str]) -> String {
    let mut out = format!("HTTP {}", status.as_u16());
    let Some(json) = json else {
        out.push_str(" with an unreadable body");
        return out;
    };
    if let Some(code) = error_code(json) {
        out.push(' ');
        out.push_str(code);
    }
    if let Some(message) = error_message(json) {
        out.push_str(": ");
        out.push_str(message);
    }
    scrub(&out, secrets)
        .chars()
        .take(MAX_REASON_CHARS)
        .collect()
}

/// `text` with every secret of `secrets` (as is, and percent-encoded the way a form or a URL
/// carries it) replaced by `***`, longest first. The reason's constructor then redacts what still
/// looks like a credential.
pub(crate) fn scrub(text: &str, secrets: &[&str]) -> String {
    let mut all: Vec<String> = Vec::new();
    for secret in secrets.iter().filter(|s| !s.is_empty()) {
        all.push((*secret).to_owned());
        let encoded: String = url::form_urlencoded::byte_serialize(secret.as_bytes()).collect();
        if encoded != *secret {
            all.push(encoded);
        }
    }
    all.sort_by_key(|s| std::cmp::Reverse(s.len()));
    let mut out = text.to_owned();
    for secret in all {
        out = out.replace(&secret, "***");
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn kind(status: u16, body: Option<Value>, endpoint: Endpoint) -> &'static str {
        classify(
            StatusCode::from_u16(status).unwrap(),
            body.as_ref(),
            endpoint,
            &[],
        )
        .kind()
    }

    fn api(code: &str) -> Option<Value> {
        Some(json!({ "error": { "code": code, "message": "m", "log_id": "l" } }))
    }

    fn token(error: &str) -> Option<Value> {
        Some(json!({ "error": error, "error_description": "d", "log_id": "l" }))
    }

    #[test]
    fn errors_map_by_the_table() {
        let (a, t) = (Endpoint::Api, Endpoint::Token);
        for (status, body, endpoint, expected) in [
            // The scope codes come with 401 and are not the credential's death.
            (401, api("scope_not_authorized"), a, "permission"),
            (400, api("scope_permission_missed"), a, "permission"),
            (403, api("privacy_level_option_mismatch"), a, "permission"),
            (
                403,
                api("unaudited_client_can_only_post_to_private_accounts"),
                a,
                "permission",
            ),
            (
                403,
                api("spam_risk_user_banned_from_posting"),
                a,
                "permission",
            ),
            (429, api("rate_limit_exceeded"), a, "throttle"),
            (200, api("spam_risk_too_many_posts"), a, "throttle"),
            (403, api("spam_risk_too_many_posts"), a, "throttle"),
            (403, api("reached_active_user_cap"), a, "throttle"),
            (429, None, a, "throttle"),
            (401, api("access_token_invalid"), a, "auth"),
            (200, api("access_token_invalid"), a, "auth"),
            (401, api("access_token_expired"), a, "auth"),
            (401, api("token_revoked"), a, "auth"),
            (401, None, a, "auth"),
            (500, api("internal_error"), a, "transient"),
            (200, api("internal_error"), a, "transient"),
            (503, None, a, "transient"),
            (403, api("url_ownership_unverified"), a, "permanent"),
            (400, api("invalid_param"), a, "permanent"),
            (403, None, a, "permanent"),
            (404, None, a, "permanent"),
            (302, None, a, "permanent"),
            // The token endpoint.
            (429, token("invalid_grant"), t, "throttle"),
            (400, token("invalid_client"), t, "permanent"),
            (401, token("invalid_client"), t, "permanent"),
            (200, token("invalid_client"), t, "permanent"),
            (400, token("invalid_grant"), t, "auth"),
            (200, token("invalid_grant"), t, "auth"),
            (401, None, t, "auth"),
            (500, None, t, "transient"),
            (400, token("server_error"), t, "transient"),
            (400, token("temporarily_unavailable"), t, "transient"),
            (400, token("invalid_request"), t, "permanent"),
            (400, token("unsupported_grant_type"), t, "permanent"),
        ] {
            assert_eq!(
                kind(status, body.clone(), endpoint),
                expected,
                "{status} {body:?} {endpoint:?}"
            );
        }
    }

    #[test]
    fn reasons_quote_the_code_and_message_without_secrets() {
        let body = json!({ "error": {
            "code": "scope_not_authorized",
            "message": "token act.SECRET-1 lacks video.publish",
            "log_id": "202610270000",
        } });
        assert_eq!(
            reason(StatusCode::UNAUTHORIZED, Some(&body), &["act.SECRET-1"]),
            "HTTP 401 scope_not_authorized: token *** lacks video.publish"
        );
        let token = json!({ "error": "invalid_grant", "error_description": "code c-SECRET spent" });
        assert_eq!(
            reason(StatusCode::BAD_REQUEST, Some(&token), &["c-SECRET", ""]),
            "HTTP 400 invalid_grant: code *** spent"
        );
        assert_eq!(
            reason(StatusCode::BAD_GATEWAY, None, &[]),
            "HTTP 502 with an unreadable body"
        );
        assert_eq!(
            reason(StatusCode::NOT_FOUND, Some(&json!({})), &[]),
            "HTTP 404"
        );
        let long = json!({ "error": { "code": "invalid_param", "message": "x".repeat(1_000) } });
        assert_eq!(
            reason(StatusCode::BAD_REQUEST, Some(&long), &[])
                .chars()
                .count(),
            MAX_REASON_CHARS
        );
        // A longer secret is taken out before a shorter one inside it; a form-encoded copy too.
        assert_eq!(scrub("ab abc", &["ab", "abc"]), "*** ***");
        assert_eq!(scrub("echo a%2Fb+c", &["a/b c"]), "echo ***");
    }

    #[test]
    fn upload_urls_give_up_their_parts() {
        let url = Url::parse(
            "https://open-upload.tiktokapis.com/video/0123456789abcdef0123/?upload_id=7&upload_token=tok-SECRET",
        )
        .unwrap();
        let secrets = url_secrets(&url);
        for part in [
            url.as_str(),
            "upload_id=7&upload_token=tok-SECRET",
            "tok-SECRET",
            "0123456789abcdef0123",
        ] {
            assert!(secrets.iter().any(|s| s == part), "{part}: {secrets:?}");
        }
        assert!(!secrets.iter().any(|s| s == "video"));
    }

    #[test]
    fn joined_urls_keep_the_base_path_and_the_trailing_slash() {
        let base = Url::parse("http://127.0.0.1:9/api/").unwrap();
        let url = join(
            &base,
            &["v2", "user", "info", ""],
            &[("fields", "open_id,display_name")],
        );
        assert_eq!(
            url.as_str(),
            "http://127.0.0.1:9/api/v2/user/info/?fields=open_id%2Cdisplay_name"
        );
        let root = Url::parse("https://open.tiktokapis.com").unwrap();
        assert_eq!(
            join(&root, &["v2", "oauth", "token", ""], &[]).as_str(),
            "https://open.tiktokapis.com/v2/oauth/token/"
        );
    }

    #[test]
    fn debug_masks_tokens_secrets_and_bodies() {
        let printed = [
            format!("{:?}", Auth::Bearer("act.tok-SECRET")),
            format!(
                "{:?}",
                Body::Form(vec![
                    ("client_key", "key-1"),
                    ("client_secret", "client-SECRET"),
                    ("refresh_token", "r-SECRET"),
                ])
            ),
            format!("{:?}", Body::Json(json!({ "title": "post-SECRET" }))),
        ];
        for text in &printed {
            assert!(!text.contains("SECRET"), "{text}");
        }
        assert!(printed[1].contains("client_secret"), "{}", printed[1]);
    }

    #[test]
    fn secret_form_fields_are_the_client_secret_code_and_refresh_token() {
        let body = Body::Form(vec![
            ("client_key", "key"),
            ("client_secret", "s"),
            ("code", "c"),
            ("grant_type", "authorization_code"),
            ("redirect_uri", "https://panel.test/cb"),
            ("refresh_token", "r"),
        ]);
        assert_eq!(body.secrets(), ["s", "c", "r"]);
        assert!(Body::Empty.secrets().is_empty());
    }
}
