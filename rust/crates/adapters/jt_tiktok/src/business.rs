//! The TikTok API for Business client (`business-api.tiktok.com/open_api/v1.3`): the calls an ad
//! account is reached with. It is another API than the Open API the posts go through
//! (`crate::client`): its own host, the token in an `Access-Token` header, and an answer that
//! says whether it worked in its own `code`, whatever the HTTP status.
//!
//! Every answer is `{"code": 0, "message": "OK", "data": {...}, "request_id": "..."}`; TikTok's
//! return codes "take precedence over HTTP status codes"
//! (<https://business-api.tiktok.com/portal/docs?id=1737172488964097>, read 2026-11-11): an HTTP
//! 200 with another code is a failure. The crate docs hold the table of what each code maps to.

use jt_connector::ConnectorError;
use jt_outbound::multipart::{Form, Part};
use jt_outbound::{EgressError, EgressScope, Method, Response, StatusCode, header};
use serde_json::Value;
use url::Url;

use crate::client::{Effect, join, scrub};
use crate::{READ_ATTEMPTS, TiktokConnector};

/// The egress scope every call is sent under.
const SCOPE: EgressScope = EgressScope::Connector("tiktok");

/// The largest answer body read, in bytes.
const MAX_BODY_BYTES: usize = 4 << 20;

/// The longest provider text quoted in an error's reason, in characters.
const MAX_REASON_CHARS: usize = 300;

/// The version of the API for Business every call names in its path.
pub(crate) const API_VERSION: &str = "v1.3";

/// Why a call fails when TikTok refuses the platform's own TikTok for Business app (its id or
/// its secret, or the app is blocked): no reconnection can fix it.
pub(crate) const APP_REJECTED: &str = "platform TikTok for Business app rejected";

/// The codes that say the app or the ad account sent too many requests.
const THROTTLE_CODES: &[i64] = &[40016, 40100, 40132, 40133];

/// The codes that say the access token is no longer one (expired, empty, invalid), or that the
/// authorization code of an exchange is spent or cancelled: the owner must authorize again.
const AUTH_CODES: &[i64] = &[40102, 40104, 40105, 40110];

/// The codes that say the token may not do this for this ad account (no permission, a feature
/// the account is not allowlisted for, a token that is not this advertiser's, a developer and an
/// advertiser of different companies).
const PERMISSION_CODES: &[i64] = &[40001, 40106, 40118, 40119];

/// The codes that say the platform's app itself is refused (blocked or unknown, its developer
/// profile not approved, a permission the app was not given).
const APP_CODES: &[i64] = &[40113, 40124, 40125];

/// The codes TikTok says a retry may resolve (its own system errors, maintenance, a write
/// conflict).
const TRANSIENT_CODES: &[i64] = &[40202, 50000, 50002, 51305, 60001];

/// The code of a request TikTok saw twice within ten seconds (its `request_id` idempotency): the
/// first one may have made the object.
const DUPLICATE_CODE: i64 = 40050;

/// The code of a call that worked only in part.
const PARTIAL_CODE: i64 = 20001;

/// What a call carries. `Debug` shows its shape only.
pub(crate) enum Payload<'a> {
    /// Nothing but the URL's query (a `GET`).
    None,
    /// A JSON body (a `POST`).
    Json(Value),
    /// A multipart upload: text fields and one file.
    File {
        fields: Vec<(&'static str, String)>,
        /// The name of the file's part.
        part: &'static str,
        bytes: &'a [u8],
        file_name: String,
        mime: &'static str,
    },
}

impl std::fmt::Debug for Payload<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Payload::None => f.write_str("None"),
            Payload::Json(_) => f.write_str("Json(***)"),
            Payload::File { bytes, mime, .. } => f
                .debug_struct("File")
                .field("len", &bytes.len())
                .field("mime", mime)
                .finish(),
        }
    }
}

/// The code of an answer, when it carries one.
fn code_of(json: &Value) -> Option<i64> {
    json["code"].as_i64()
}

/// `"HTTP <status> <code>: <message>"` of an answer, or `"HTTP <status> with an unreadable
/// body"`; every secret in `secrets` taken out, cut to [`MAX_REASON_CHARS`].
fn reason(status: StatusCode, json: Option<&Value>, secrets: &[&str]) -> String {
    let mut out = format!("HTTP {}", status.as_u16());
    let Some(json) = json else {
        out.push_str(" with an unreadable body");
        return out;
    };
    if let Some(code) = code_of(json) {
        out.push_str(&format!(" {code}"));
    }
    if let Some(message) = json["message"]
        .as_str()
        .map(str::trim)
        .filter(|m| !m.is_empty())
    {
        out.push_str(": ");
        out.push_str(message);
    }
    scrub(&out, secrets)
        .chars()
        .take(MAX_REASON_CHARS)
        .collect()
}

/// The error an answer that is not a success maps to (the table in the crate docs; first match
/// wins). `effect` says what a duplicate or a partial success means for the call.
pub(crate) fn classify(
    status: StatusCode,
    json: Option<&Value>,
    effect: Effect,
    secrets: &[&str],
) -> ConnectorError {
    let code = json.and_then(code_of);
    let reason = || reason(status, json, secrets);
    let is = |list: &[i64]| code.is_some_and(|c| list.contains(&c));
    if is(THROTTLE_CODES) || status == StatusCode::TOO_MANY_REQUESTS {
        return ConnectorError::throttle(None);
    }
    if is(APP_CODES) {
        // TikTok's own words stay: one of these codes also names a field the app may not use.
        return ConnectorError::permanent(format!("{APP_REJECTED}: {}", reason()));
    }
    if is(AUTH_CODES) || status == StatusCode::UNAUTHORIZED {
        return ConnectorError::auth(reason());
    }
    if is(PERMISSION_CODES) || status == StatusCode::FORBIDDEN {
        return ConnectorError::permission(reason());
    }
    if is(TRANSIENT_CODES) || status.is_server_error() {
        return ConnectorError::transient(reason());
    }
    if effect == Effect::Commit && (code == Some(DUPLICATE_CODE) || code == Some(PARTIAL_CODE)) {
        return ConnectorError::unknown(reason());
    }
    ConnectorError::permanent(reason())
}

/// An egress failure as a [`ConnectorError`] (no URL in it).
fn egress_error(e: EgressError, effect: Effect) -> ConnectorError {
    match e {
        EgressError::Transport(err) if err.is_connect() => {
            ConnectorError::transient("the call to TikTok could not connect; nothing was sent")
        }
        EgressError::Transport(err) if effect == Effect::Commit => {
            let what = if err.is_timeout() {
                "timed out"
            } else {
                "got no answer"
            };
            ConnectorError::unknown(format!(
                "the call to TikTok {what} after the request may have reached it: the outcome \
                 is unknown, so it was not sent again"
            ))
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

/// Reads `response`: the `data` of a success (`code` 0), else the error it maps to.
async fn read(
    mut response: Response,
    effect: Effect,
    secrets: &[&str],
) -> Result<Value, ConnectorError> {
    let status = response.status();
    let lost = |what: &str| {
        if effect == Effect::Commit {
            ConnectorError::unknown(format!(
                "TikTok's answer {what}: whether the request took effect is unknown"
            ))
        } else {
            ConnectorError::transient(format!("TikTok's answer {what}"))
        }
    };
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MAX_BODY_BYTES {
                    return Err(if effect == Effect::Commit && status.is_success() {
                        ConnectorError::unknown("TikTok's answer to a write is too large to read")
                    } else {
                        ConnectorError::permanent("TikTok's answer is too large")
                    });
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            Err(_) => return Err(lost("broke off in transit")),
        }
    }
    let json = serde_json::from_slice::<Value>(&body).ok();
    match (status.is_success(), json) {
        (true, Some(mut json)) if code_of(&json) == Some(0) => Ok(json["data"].take()),
        (true, None) if effect == Effect::Commit => Err(ConnectorError::unknown(
            "unreadable successful write response",
        )),
        (true, Some(json)) if code_of(&json).is_none() && effect == Effect::Commit => {
            Err(ConnectorError::unknown(
                "TikTok's answer to a write carries no code: whether it took effect is unknown",
            ))
        }
        (_, json) => Err(classify(status, json.as_ref(), effect, secrets)),
    }
}

impl TiktokConnector {
    /// The API for Business URL `{business}/open_api/v1.3/{segments}/` with `query`.
    pub(crate) fn business_url(&self, segments: &[&str], query: &[(&str, &str)]) -> Url {
        let mut all = vec!["open_api", API_VERSION];
        all.extend_from_slice(segments);
        // TikTok's paths end in a slash.
        all.push("");
        join(&self.bases.business, &all, query)
    }

    /// Sends one call to the API for Business and reads its answer: the `data` of a success,
    /// else the error it maps to. A read ([`Effect::Read`]) is tried once more when no answer
    /// arrives; anything else is sent once, and once any answer arrives nothing is sent again.
    /// `token` goes in the `Access-Token` header; it and every value of `secrets` (the app's
    /// secret, an authorization code) are taken out of any provider text quoted in an error.
    pub(crate) async fn business(
        &self,
        method: Method,
        url: Url,
        token: Option<&str>,
        payload: &Payload<'_>,
        effect: Effect,
        secrets: &[&str],
    ) -> Result<Value, ConnectorError> {
        let attempts = if effect == Effect::Read {
            READ_ATTEMPTS.max(1)
        } else {
            1
        };
        let mut hidden: Vec<&str> = secrets.to_vec();
        hidden.extend(token);
        let mut attempt = 1;
        loop {
            let timeout = match payload {
                Payload::File { .. } => self.upload_timeout,
                _ => self.attempt_timeout,
            };
            let mut request = self
                .egress
                .prepare(method.clone(), url.clone())
                .timeout(timeout);
            if let Some(token) = token {
                request = request.header("Access-Token", token);
            }
            request = match payload {
                Payload::None => request,
                Payload::Json(json) => request
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(json.to_string().into_bytes()),
                Payload::File {
                    fields,
                    part,
                    bytes,
                    file_name,
                    mime,
                } => {
                    let file = Part::bytes(bytes.to_vec())
                        .file_name(file_name.clone())
                        .mime_str(mime)
                        .map_err(|_| {
                            ConnectorError::permanent("the upload's media type is not one")
                        })?;
                    let mut form = Form::new();
                    for (name, value) in fields {
                        form = form.text(*name, value.clone());
                    }
                    request.multipart(form.part(*part, file))
                }
            };
            match request.send(SCOPE).await {
                Ok(response) => return read(response, effect, &hidden).await,
                Err(EgressError::Transport(err)) if attempt < attempts => {
                    tracing::warn!(
                        attempt,
                        timed_out = err.is_timeout(),
                        "a read from TikTok's API for Business got no answer; trying again"
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
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn kind(status: u16, code: i64, effect: Effect) -> &'static str {
        classify(
            StatusCode::from_u16(status).unwrap(),
            Some(&json!({"code": code, "message": "m", "request_id": "r"})),
            effect,
            &[],
        )
        .kind()
    }

    #[test]
    fn a_return_code_says_what_failed_whatever_the_http_status() {
        for (code, expected) in [
            (40100, "throttle"),
            (40133, "throttle"),
            (40105, "auth"),
            (40102, "auth"),
            (40110, "auth"),
            (40001, "permission"),
            (40118, "permission"),
            (40106, "permission"),
            (40113, "permanent"),
            (40125, "permanent"),
            (50000, "transient"),
            (60001, "transient"),
            (40202, "transient"),
            (40002, "permanent"),
            (40007, "permanent"),
        ] {
            assert_eq!(kind(200, code, Effect::Read), expected, "{code}");
            assert_eq!(kind(200, code, Effect::Commit), expected, "{code}");
        }
        // A request TikTok saw twice, or one that worked in part, may have made its object.
        assert_eq!(kind(200, 40050, Effect::Commit), "unknown");
        assert_eq!(kind(200, 20001, Effect::Commit), "unknown");
        assert_eq!(kind(200, 40050, Effect::Read), "permanent");
        // The platform's app being refused is never the tenant's to fix, and says so.
        assert_eq!(
            classify(
                StatusCode::OK,
                Some(&json!({"code": 40113, "message": "The app is blocked"})),
                Effect::Read,
                &[]
            )
            .reason(),
            Some("platform TikTok for Business app rejected: HTTP 200 40113: The app is blocked")
        );
    }

    #[test]
    fn the_http_status_decides_when_the_answer_has_no_code() {
        let none = |status: u16| {
            classify(
                StatusCode::from_u16(status).unwrap(),
                None,
                Effect::Read,
                &[],
            )
            .kind()
        };
        assert_eq!(none(429), "throttle");
        assert_eq!(none(401), "auth");
        assert_eq!(none(403), "permission");
        assert_eq!(none(502), "transient");
        assert_eq!(none(404), "permanent");
    }

    #[test]
    fn a_reason_names_the_code_and_tiktoks_words_without_a_secret() {
        let e = classify(
            StatusCode::OK,
            Some(&json!({"code": 40002,
                "message": "budget: must be at least 500 for token tt-SECRET-token"})),
            Effect::Commit,
            &["tt-SECRET-token"],
        );
        assert_eq!(
            e.reason(),
            Some("HTTP 200 40002: budget: must be at least 500 for token ***")
        );
    }
}
