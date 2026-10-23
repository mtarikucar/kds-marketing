//! The NetGSM client: URLs, sending through the egress client (reads retried only when no answer
//! arrived, actions never), reading answers, and mapping NetGSM's status codes and HTTP statuses
//! to [`ConnectorError`] (the crate docs hold the table).

use std::fmt;

use jt_connector::ConnectorError;
use jt_outbound::{EgressError, EgressScope, Method, Response, StatusCode, header};
use serde_json::Value;
use time::Duration;
use url::Url;

use crate::{Masked, NetgsmConnector, json};

/// The egress scope of every call.
const SCOPE: EgressScope = EgressScope::Connector("netgsm");

/// The largest answer read, in bytes; a larger one is `Permanent`.
const MAX_BODY_BYTES: usize = 4 << 20;

/// The longest wait a throttle asks for: a provider's longer (or absurd) wait is cut to it.
pub(crate) const MAX_RETRY_AFTER: Duration = Duration::hours(1);

/// The longest piece of provider text quoted in a reason, in characters.
const MAX_QUOTED_CHARS: usize = 120;

/// What code 30 (and an HTTP 401) says: where to look.
pub(crate) const AUTH_HINT: &str = "NetGSM refused the credentials: check the credentials or IP \
     allowlist (the API user and its password, that API access is on for it, and that this \
     server's address is on the account's allowed IP list)";

/// Whether a call may be sent again when no answer arrived (the crate docs, "Retries").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Retry {
    /// An idempotent read (a report, the inbox, the balance, the sender names, an İYS lookup,
    /// the queue statistics, the call records): sent again as the retry policy says, but only
    /// when no answer arrived.
    Reads,
    /// An action (an SMS, a call, a hangup, a consent record): sent once, whatever happens. When
    /// no answer arrives after the request may have reached NetGSM, the error says the outcome
    /// is unknown.
    Never,
}

/// How a call authenticates. `Debug` masks the password.
#[derive(Clone, Copy)]
pub(crate) enum Auth<'a> {
    /// HTTP basic authentication as `user:password` (the SMS API, the balance, İYS).
    Basic { user: &'a str, password: &'a str },
    /// None in the request's headers: the credentials travel in the query string (Netsantral)
    /// or in the body (the call records).
    InRequest,
}

impl fmt::Debug for Auth<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Auth::Basic { user, .. } => f
                .debug_struct("Basic")
                .field("user", user)
                .field("password", &Masked)
                .finish(),
            Auth::InRequest => f.write_str("InRequest"),
        }
    }
}

/// A request body. `Debug` shows its kind only: İYS and the call records carry a password in it,
/// an SMS its text.
pub(crate) enum Body {
    Empty,
    Json(Value),
}

impl fmt::Debug for Body {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Body::Empty => f.write_str("Empty"),
            Body::Json(_) => f.debug_tuple("Json").field(&Masked).finish(),
        }
    }
}

/// An answer that arrived: its status, the wait it asks for, its text (trimmed) and that text
/// read as JSON when it is an object or an array. Never logged: it may quote the request.
pub(crate) struct Answer {
    pub(crate) status: StatusCode,
    pub(crate) retry_after: Option<Duration>,
    pub(crate) text: String,
    pub(crate) json: Option<Value>,
}

impl fmt::Debug for Answer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Answer")
            .field("status", &self.status)
            .field("bytes", &self.text.len())
            .finish_non_exhaustive()
    }
}

impl Answer {
    /// NetGSM's status code: `"code"` of a JSON object (a string or a number), or, on a 2xx
    /// answer, the whole text when it is a bare code of two or three digits (a bare `502` of a
    /// proxy's error page is no NetGSM code).
    pub(crate) fn code(&self) -> Option<String> {
        if let Some(Value::Object(object)) = &self.json {
            return object
                .get("code")
                .and_then(json::text)
                .filter(|c| is_code(c));
        }
        let text = self.text.as_str();
        (self.status.is_success() && (2..=3).contains(&text.len()) && is_code(text))
            .then(|| text.to_owned())
    }
}

/// Whether `text` reads as a NetGSM status code: one to four ASCII digits.
fn is_code(text: &str) -> bool {
    (1..=4).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_digit())
}

/// Whether NetGSM's status code `code` is success (`00`, or `0`).
pub(crate) fn is_success(code: &str) -> bool {
    code.bytes().all(|b| b == b'0')
}

/// The error NetGSM's status code `code` maps to (the crate docs' table), with `retry_after` for
/// a throttle.
pub(crate) fn code_error(code: &str, retry_after: Option<Duration>) -> ConnectorError {
    match code {
        "20" => ConnectorError::permanent(
            "NetGSM code 20: the message was refused (empty, too long, or with characters the \
             encoding does not carry)",
        ),
        "30" => ConnectorError::auth(format!("NetGSM code 30: {AUTH_HINT}")),
        "40" => ConnectorError::permission(
            "NetGSM code 40: the sender name (msgheader) is not defined on the account or not \
             approved",
        ),
        "50" => ConnectorError::permanent(
            "NetGSM code 50: İYS refused the recipient (no consent to commercial messages, or a \
             refusal on record)",
        ),
        "51" => ConnectorError::permission(
            "NetGSM code 51: the brand or sender name is not registered in İYS for commercial \
             messages",
        ),
        "60" => ConnectorError::permission(
            "NetGSM code 60: the account has no package or authority for this operation",
        ),
        "70" => ConnectorError::permanent("NetGSM code 70: missing or invalid parameters"),
        "80" => ConnectorError::throttle(retry_after),
        "85" => ConnectorError::permanent(
            "NetGSM code 85: the same text went to the same recipient too recently (duplicate \
             limit)",
        ),
        "100" => ConnectorError::transient("NetGSM code 100: a system error at NetGSM"),
        other => ConnectorError::permanent(format!("NetGSM answered code {other}")),
    }
}

/// The error of an answer without a status code, by its HTTP status, when the status says
/// enough: 429, 5xx, 401 and 403. `None` for a status that leaves the body to decide.
pub(crate) fn status_error(answer: &Answer) -> Option<ConnectorError> {
    let status = answer.status;
    if status == StatusCode::TOO_MANY_REQUESTS {
        Some(ConnectorError::throttle(answer.retry_after))
    } else if status.is_server_error() {
        Some(ConnectorError::transient(format!(
            "NetGSM answered HTTP {}",
            status.as_u16()
        )))
    } else if status == StatusCode::UNAUTHORIZED {
        Some(ConnectorError::auth(AUTH_HINT))
    } else if status == StatusCode::FORBIDDEN {
        Some(ConnectorError::permission("NetGSM answered HTTP 403"))
    } else {
        None
    }
}

/// `Permanent`: an answer that cannot be read as what `what` returns.
pub(crate) fn unreadable(answer: &Answer, what: &str) -> ConnectorError {
    ConnectorError::permanent(format!(
        "NetGSM's answer to {what} could not be read (HTTP {})",
        answer.status.as_u16()
    ))
}

/// The JSON of a successful answer of the SMS API, the balance or İYS, else its error: a status
/// code decides first (success, or the table), then an HTTP status that says enough
/// ([`status_error`]). Without a code, a 2xx JSON answer is a success only when `code_optional`
/// (the balance answers its rows bare); anything else is `Permanent` ([`unreadable`]).
pub(crate) fn outcome(
    answer: Answer,
    what: &str,
    code_optional: bool,
) -> Result<Value, ConnectorError> {
    match answer.code() {
        Some(code) if is_success(&code) => Ok(answer.json.unwrap_or(Value::Null)),
        Some(code) => Err(code_error(&code, answer.retry_after)),
        None => {
            if let Some(e) = status_error(&answer) {
                return Err(e);
            }
            match answer.json {
                Some(json) if code_optional && answer.status.is_success() => Ok(json),
                _ => Err(unreadable(&answer, what)),
            }
        }
    }
}

/// The forms a password may be echoed in: as is, form-encoded (`+` for a space) and
/// percent-encoded (`%20`), with upper- and lowercase hex digits; longest first, each once.
fn echoed_forms(secret: &str) -> Vec<String> {
    let form: String = url::form_urlencoded::byte_serialize(secret.as_bytes()).collect();
    let percent = form.replace('+', "%20");
    let mut forms = vec![secret.to_owned()];
    for encoded in [form, percent] {
        let lower = lower_hex_escapes(&encoded);
        forms.push(encoded);
        forms.push(lower);
    }
    forms.retain(|f| !f.is_empty());
    forms.sort_by_key(|f| std::cmp::Reverse(f.len()));
    forms.dedup();
    forms
}

/// `text` with the two hex digits after each `%` in lowercase.
fn lower_hex_escapes(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut after_percent = 0;
    for c in text.chars() {
        if after_percent > 0 {
            out.push(c.to_ascii_lowercase());
            after_percent -= 1;
        } else {
            if c == '%' {
                after_percent = 2;
            }
            out.push(c);
        }
    }
    out
}

/// Provider text fit for a reason: the password `secret` taken out wherever it appears, as is or
/// form- or percent-encoded, runs of seven digits or more (phone numbers) masked, cut to
/// [`MAX_QUOTED_CHARS`]. The reason's constructor then redacts what still looks like a
/// credential.
pub(crate) fn quoted(text: &str, secret: &str) -> String {
    let mut scrubbed = text.to_owned();
    for form in echoed_forms(secret) {
        scrubbed = scrubbed.replace(&form, "***");
    }
    let mut out = String::with_capacity(scrubbed.len());
    let mut digits = String::new();
    let flush = |digits: &mut String, out: &mut String| {
        if digits.len() >= 7 {
            out.push_str("***");
        } else {
            out.push_str(digits);
        }
        digits.clear();
    };
    for c in scrubbed.chars() {
        if c.is_ascii_digit() {
            digits.push(c);
        } else {
            flush(&mut digits, &mut out);
            out.push(c);
        }
    }
    flush(&mut digits, &mut out);
    out.chars().take(MAX_QUOTED_CHARS).collect()
}

/// `base` with `segments` appended to its path, each one segment (percent-encoded), and `query`.
pub(crate) fn join(base: &Url, segments: &[&str], query: &[(&str, &str)]) -> Url {
    let mut url = base.clone();
    url.set_query(None);
    url.set_fragment(None);
    {
        let mut path = url
            .path_segments_mut()
            .expect("a NetGSM base URL has a path that segments can be pushed to");
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

impl NetgsmConnector {
    /// The API URL of `segments` with `query`.
    pub(crate) fn api_url(&self, segments: &[&str], query: &[(&str, &str)]) -> Url {
        join(&self.bases.api, segments, query)
    }

    /// The Netsantral URL of `segments` with `query`.
    pub(crate) fn pbx_url(&self, segments: &[&str], query: &[(&str, &str)]) -> Url {
        join(&self.bases.pbx, segments, query)
    }

    /// Sends one call and returns the answer that arrived, whatever its status. A read
    /// ([`Retry::Reads`]) is tried again as the retry policy says when no answer arrives (the
    /// connection fails, drops or times out); an action ([`Retry::Never`]) is sent once. Once any
    /// answer arrives nothing is sent again, so a message NetGSM accepted is never sent twice.
    pub(crate) async fn call(
        &self,
        method: Method,
        url: Url,
        auth: Auth<'_>,
        body: &Body,
        retry: Retry,
    ) -> Result<Answer, ConnectorError> {
        let attempts = match retry {
            Retry::Reads => self.retry.attempts.max(1),
            Retry::Never => 1,
        };
        let mut delay = self.retry.base_delay;
        let mut attempt = 1;
        loop {
            let mut request = self
                .egress
                .prepare(method.clone(), url.clone())
                .timeout(self.attempt_timeout);
            if let Auth::Basic { user, password } = auth {
                request = request.basic_auth(user, Some(password));
            }
            if let Body::Json(json) = body {
                request = request.json(json);
            }
            match request.send(SCOPE).await {
                Ok(response) => return read(response).await,
                Err(EgressError::Transport(err)) if attempt < attempts => {
                    tracing::warn!(
                        attempt,
                        timed_out = err.is_timeout(),
                        "a call to NetGSM got no answer; trying again"
                    );
                    if !delay.is_zero() {
                        tokio::time::sleep(delay).await;
                    }
                    delay = delay.saturating_mul(2);
                    attempt += 1;
                }
                Err(e) => return Err(egress_error(e, retry)),
            }
        }
    }
}

/// An egress failure of a call of class `retry` as a [`ConnectorError`] (no URL in it). An
/// action that got no answer after its request may have reached NetGSM says its outcome is
/// unknown.
fn egress_error(e: EgressError, retry: Retry) -> ConnectorError {
    match e {
        EgressError::Transport(err) if err.is_connect() => {
            ConnectorError::transient("the call to NetGSM could not connect; nothing was sent")
        }
        EgressError::Transport(err) if retry == Retry::Never => {
            let what = if err.is_timeout() {
                "timed out"
            } else {
                "got no answer"
            };
            ConnectorError::transient(format!(
                "the call to NetGSM {what} after the request may have reached it: the outcome \
                 is unknown, so it was not sent again"
            ))
        }
        EgressError::Transport(err) if err.is_timeout() => {
            ConnectorError::transient("the call to NetGSM timed out")
        }
        EgressError::Transport(_) => ConnectorError::transient("the call to NetGSM got no answer"),
        EgressError::NotPublic { .. } => {
            ConnectorError::transient("the NetGSM host resolved to no public address")
        }
        EgressError::HostNotAllowed { .. } => {
            ConnectorError::permanent("the NetGSM host is not allowed for the netgsm connector")
        }
        EgressError::Build(_) => ConnectorError::permanent("the call to NetGSM could not be built"),
    }
}

/// Reads `response` (up to [`MAX_BODY_BYTES`]) into an [`Answer`]. The body is never logged.
async fn read(mut response: Response) -> Result<Answer, ConnectorError> {
    let status = response.status();
    let retry_after = retry_after(response.headers());
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MAX_BODY_BYTES {
                    return Err(ConnectorError::permanent("NetGSM's answer is too large"));
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            // An answer arrived (it may have been acted on): never sent again.
            Err(_) => {
                return Err(ConnectorError::transient(
                    "NetGSM's answer broke off in transit: whether the request took effect is \
                     unknown",
                ));
            }
        }
    }
    let text = String::from_utf8_lossy(&body).trim().to_owned();
    let json = json::read(&text).filter(|v| v.is_object() || v.is_array());
    Ok(Answer {
        status,
        retry_after,
        text,
        json,
    })
}

/// `Retry-After` in seconds, at most [`MAX_RETRY_AFTER`]; `None` when absent or not a positive
/// number.
fn retry_after(headers: &header::HeaderMap) -> Option<Duration> {
    let seconds = headers
        .get(header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|s| *s > 0)?;
    Some(Duration::seconds(
        seconds.min(MAX_RETRY_AFTER.whole_seconds()),
    ))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn answer(status: u16, text: &str) -> Answer {
        Answer {
            status: StatusCode::from_u16(status).unwrap(),
            retry_after: None,
            text: text.to_owned(),
            json: json::read(text).filter(|v| v.is_object() || v.is_array()),
        }
    }

    #[test]
    fn codes_come_from_the_json_or_the_bare_text() {
        assert_eq!(answer(200, r#"{"code":"00"}"#).code(), Some("00".into()));
        assert_eq!(answer(200, r#"{"code":30}"#).code(), Some("30".into()));
        assert_eq!(answer(200, "30").code(), Some("30".into()));
        assert_eq!(answer(200, "100").code(), Some("100".into()));
        // A bare number is a NetGSM code only on a 2xx answer; a JSON code on any.
        assert_eq!(answer(502, "502").code(), None);
        assert_eq!(answer(500, r#"{"code":"30"}"#).code(), Some("30".into()));
        for none in [
            r#"{"code":"x"}"#,
            r#"{"jobid":"1"}"#,
            "3",
            "1000",
            "ok",
            "",
            "[1]",
        ] {
            assert_eq!(answer(200, none).code(), None, "{none}");
        }
        assert!(is_success("00") && is_success("0"));
        assert!(!is_success("30"));
    }

    #[test]
    fn the_code_table_is_netgsms() {
        let kinds: Vec<(&str, &str)> = [
            "20", "30", "40", "50", "51", "60", "70", "80", "85", "100", "7",
        ]
        .iter()
        .map(|c| (*c, code_error(c, None).kind()))
        .collect();
        assert_eq!(
            kinds,
            [
                ("20", "permanent"),
                ("30", "auth"),
                ("40", "permission"),
                ("50", "permanent"),
                ("51", "permission"),
                ("60", "permission"),
                ("70", "permanent"),
                ("80", "throttle"),
                ("85", "permanent"),
                ("100", "transient"),
                ("7", "permanent"),
            ]
        );
        assert_eq!(
            code_error("80", Some(Duration::seconds(5))),
            ConnectorError::throttle(Some(Duration::seconds(5)))
        );
        let auth = code_error("30", None);
        assert!(
            auth.reason()
                .unwrap()
                .contains("credentials or IP allowlist"),
            "{auth}"
        );
    }

    #[test]
    fn outcomes_read_codes_then_statuses() {
        assert_eq!(
            outcome(answer(200, r#"{"code":"00","jobid":"1"}"#), "t", false),
            Ok(json!({ "code": "00", "jobid": "1" }))
        );
        assert_eq!(outcome(answer(200, "00"), "t", false), Ok(Value::Null));
        // The code wins over the status.
        assert_eq!(
            outcome(answer(500, r#"{"code":"30"}"#), "t", false)
                .unwrap_err()
                .kind(),
            "auth"
        );
        assert_eq!(outcome(answer(200, "[1,2]"), "t", true), Ok(json!([1, 2])));
        for (status, text, expected) in [
            (200, "[1,2]", "permanent"),
            (200, "<html/>", "permanent"),
            (502, "<html/>", "transient"),
            (429, "", "throttle"),
            (401, "", "auth"),
            (403, "", "permission"),
            (404, "{}", "permanent"),
        ] {
            assert_eq!(
                outcome(answer(status, text), "t", false)
                    .unwrap_err()
                    .kind(),
                expected,
                "{status} {text}"
            );
        }
    }

    #[test]
    fn quoted_text_loses_the_password_and_phone_numbers() {
        let text = quoted(
            "hata password=Gizli-77 Gizli-77 numara 905000000001 kod 30",
            "Gizli-77",
        );
        assert_eq!(text, "hata password=*** *** numara *** kod 30");
        // Echoed encoded, too: form-encoded, percent-encoded, lowercase hex.
        let secret = "Pa&ss w+rd";
        let text = quoted(
            "a Pa%26ss+w%2Brd b Pa%26ss%20w%2Brd c Pa%26ss%20w%2brd d Pa&ss w+rd e",
            secret,
        );
        assert_eq!(text, "a *** b *** c *** d *** e");
        assert_eq!(
            quoted(&"x".repeat(500), "").chars().count(),
            MAX_QUOTED_CHARS
        );
    }

    #[test]
    fn urls_keep_the_base_path_and_encode_segments() {
        let base = Url::parse("http://127.0.0.1:9/pbx/").unwrap();
        let url = join(&base, &["850/1", "originate"], &[("password", "a&b c")]);
        assert_eq!(
            url.as_str(),
            "http://127.0.0.1:9/pbx/850%2F1/originate?password=a%26b+c"
        );
    }

    #[test]
    fn waits_come_from_retry_after_capped_at_an_hour() {
        let mut headers = header::HeaderMap::new();
        assert_eq!(retry_after(&headers), None);
        headers.insert(header::RETRY_AFTER, "30".parse().unwrap());
        assert_eq!(retry_after(&headers), Some(Duration::seconds(30)));
        headers.insert(header::RETRY_AFTER, "99999999".parse().unwrap());
        assert_eq!(retry_after(&headers), Some(MAX_RETRY_AFTER));
        headers.insert(header::RETRY_AFTER, "-1".parse().unwrap());
        assert_eq!(retry_after(&headers), None);
    }

    #[test]
    fn debug_masks_passwords_and_bodies() {
        let printed = [
            format!(
                "{:?}",
                Auth::Basic {
                    user: "850",
                    password: "pw-SECRET"
                }
            ),
            format!("{:?}", Body::Json(json!({ "password": "pw-SECRET" }))),
            format!("{:?}", answer(200, r#"{"echo":"pw-SECRET"}"#)),
        ];
        for text in &printed {
            assert!(!text.contains("SECRET"), "{text}");
        }
        assert!(printed[0].contains("850"));
    }
}
