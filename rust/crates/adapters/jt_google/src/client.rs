//! The Google client: URLs, sending through the egress client (reads tried once more when no
//! answer arrived, everything else never), reading answers, and mapping Google's errors to
//! [`ConnectorError`] (the crate docs hold the table).

use std::fmt;

use jt_connector::ConnectorError;
use jt_outbound::{EgressError, EgressScope, Method, Prepared, Response, StatusCode, header};
use serde_json::Value;
use time::Duration;
use url::Url;

use crate::{API_VERSION, GoogleConnector, Masked, READ_ATTEMPTS};

/// The egress scope of every call.
const SCOPE: EgressScope = EgressScope::Connector("google");

/// The largest answer read, in bytes; a larger one is `Permanent` (`Unknown` after a write).
const MAX_BODY_BYTES: usize = 4 << 20;

/// The longest error reason kept, in characters.
const MAX_REASON_CHARS: usize = 300;

/// The longest wait a throttle asks for: a provider's longer (or absurd) wait is cut to it, so a
/// scheduler adding it to the clock can never overflow.
pub const MAX_RETRY_AFTER: Duration = Duration::hours(1);

/// Why a token call's `invalid_client` is refused: the platform's Google client (its id or
/// secret) was not accepted, which only the platform's configuration can fix.
pub(crate) const CLIENT_REJECTED: &str = "platform client credentials rejected";

/// Why a call the platform's own Google Cloud project may not make is refused: its access level
/// does not cover this account (Test access on a production account, a disabled project), which
/// no reconnection fixes.
pub(crate) const PROJECT_REJECTED: &str =
    "the platform's Google Cloud project may not call this account";

/// The `authorizationError` values that are the platform project's, not the tenant's.
const PROJECT_ERRORS: &[&str] = &[
    "DEVELOPER_TOKEN_NOT_ON_ALLOWLIST",
    "DEVELOPER_TOKEN_PROHIBITED",
    "DEVELOPER_TOKEN_NOT_APPROVED",
    "PROJECT_DISABLED",
    // "The developer must sign the terms of service."
    "MISSING_TOS",
];

/// The `authenticationError` values that are the platform project's too: the organization
/// behind it is not recognized or not approved.
const PROJECT_AUTHENTICATION_ERRORS: &[&str] = &[
    "ORGANIZATION_NOT_RECOGNIZED",
    "ORGANIZATION_NOT_APPROVED",
    "ORGANIZATION_NOT_ASSOCIATED_WITH_DEVELOPER_TOKEN",
    "DEVELOPER_TOKEN_INVALID",
];

/// The `authenticationError` values that are about one account and the user who signed in, not
/// about the token: signing in again as the same user changes nothing, so they are a missing
/// permission, not a dead credential.
const ACCOUNT_AUTHENTICATION_ERRORS: &[&str] = &[
    "CUSTOMER_NOT_FOUND",
    "CLIENT_CUSTOMER_ID_INVALID",
    "NOT_ADS_USER",
    "TWO_STEP_VERIFICATION_NOT_ENROLLED",
    "ADVANCED_PROTECTION_NOT_ENROLLED",
];

/// The prefix of the `authorizationError` values about the Cloud project's access level
/// (`CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION` and whatever joins it).
const CLOUD_PROJECT_PREFIX: &str = "CLOUD_PROJECT_";

/// The form fields of a token call that are not secret (every other one is: the code, the client
/// secret, the refresh token, a token being revoked).
const PUBLIC_FORM_FIELDS: &[&str] = &["grant_type", "client_id", "redirect_uri"];

/// Which grant a token call asks for: the errors of the two read differently.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Grant {
    /// An authorization code for a first token.
    Code,
    /// A refresh token for a new access token.
    Refresh,
}

/// Which kind of endpoint a call goes to: how its answer and its errors are read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Endpoint {
    /// The token endpoint (`oauth2.googleapis.com/token`): RFC 6749 answers and errors.
    Token(Grant),
    /// The revoke endpoint: its success body is not read.
    Revoke,
    /// A read of the Google Ads API (`googleAds:search`, the account list).
    Read,
    /// A write of the Google Ads API (`googleAds:mutate`).
    Write,
}

impl Endpoint {
    /// Whether a call to it may be sent again when no answer arrived.
    fn read_only(self) -> bool {
        self == Endpoint::Read
    }
}

/// How a call authenticates. `Debug` masks the token.
#[derive(Clone, Copy)]
pub(crate) enum Auth<'a> {
    /// The account's access token.
    Bearer(&'a str),
    /// None: the token and revoke endpoints (the client and the token are in the form).
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
/// refresh token, a JSON body an ad's texts.
pub(crate) enum Body<'a> {
    Empty,
    Json(Value),
    Form(Vec<(&'static str, &'a str)>),
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
        }
    }
}

/// `base` with `segments` appended to its path, each one segment (percent-encoded).
pub(crate) fn join(base: &Url, segments: &[&str]) -> Url {
    let mut url = base.clone();
    url.set_query(None);
    url.set_fragment(None);
    {
        let mut path = url
            .path_segments_mut()
            .expect("a Google base URL has a path that segments can be pushed to");
        path.pop_if_empty();
        for segment in segments {
            path.push(segment);
        }
    }
    url
}

/// A JSON value that is a non-empty string or an integer, as text.
pub(crate) fn text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Value::Number(n) if n.is_i64() || n.is_u64() => Some(n.to_string()),
        _ => None,
    }
}

/// A JSON value that is a whole number, written as a number or (Google's way for 64-bit
/// numbers) as a string of digits.
pub(crate) fn int(value: &Value) -> Option<i64> {
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

impl GoogleConnector {
    /// The API URL `{api}/v26/{segments}`; the last segment may carry Google's custom verb
    /// (`googleAds:search`), which is part of the path as written.
    pub(crate) fn api_url(&self, segments: &[&str]) -> Url {
        let mut all = vec![API_VERSION];
        all.extend_from_slice(segments);
        let mut url = join(&self.bases.api, &all);
        // A custom verb's colon is a legal path character; the segment encoder escapes it, and
        // Google's routes are written with it as is.
        let path = url.path().replace("%3A", ":");
        url.set_path(&path);
        url
    }

    /// The token endpoint, `{oauth}/token`.
    pub(crate) fn token_url(&self) -> Url {
        join(&self.bases.oauth, &["token"])
    }

    /// The revoke endpoint, `{oauth}/revoke`.
    pub(crate) fn revoke_url(&self) -> Url {
        join(&self.bases.oauth, &["revoke"])
    }

    /// Sends one call to `endpoint` and reads its answer: the JSON of a success (`Null` for an
    /// empty one), else the error it maps to. A read is tried once more when no answer arrives
    /// (the connection fails, drops or times out); anything else is sent once. Once any answer
    /// arrives nothing is sent again. Every secret of the call (the token, the secret form
    /// fields) is taken out of any provider text quoted in an error.
    pub(crate) async fn call(
        &self,
        method: Method,
        url: Url,
        auth: Auth<'_>,
        body: &Body<'_>,
        endpoint: Endpoint,
    ) -> Result<Value, ConnectorError> {
        let read_only = endpoint.read_only();
        let attempts = if read_only { READ_ATTEMPTS.max(1) } else { 1 };
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
                Ok(response) => return read(response, endpoint, &secrets).await,
                Err(EgressError::Transport(err)) if attempt < attempts => {
                    tracing::warn!(
                        attempt,
                        timed_out = err.is_timeout(),
                        "a read from Google got no answer; trying again"
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
/// no answer after its request may have reached Google says its outcome is unknown.
fn egress_error(e: EgressError, read_only: bool) -> ConnectorError {
    match e {
        EgressError::Transport(err) if err.is_connect() => {
            ConnectorError::transient("the call to Google could not connect; nothing was sent")
        }
        EgressError::Transport(err) if !read_only => {
            let what = if err.is_timeout() {
                "timed out"
            } else {
                "got no answer"
            };
            ConnectorError::unknown(format!(
                "the call to Google {what} after the request may have reached it: the outcome is \
                 unknown, so it was not sent again"
            ))
        }
        EgressError::Transport(err) if err.is_timeout() => {
            ConnectorError::transient("the call to Google timed out: no answer")
        }
        EgressError::Transport(_) => ConnectorError::transient("the call to Google got no answer"),
        EgressError::NotPublic { .. } => {
            ConnectorError::transient("the Google host resolved to no public address")
        }
        EgressError::HostNotAllowed { .. } => {
            ConnectorError::permanent("the host is not allowed for the google connector")
        }
        EgressError::Socket => ConnectorError::transient("outbound socket failed"),
        EgressError::Build(_) => ConnectorError::permanent("the call to Google could not be built"),
    }
}

/// Reads `response` from `endpoint`: its JSON on success, its mapped error otherwise. The body
/// is read up to [`MAX_BODY_BYTES`] and never logged.
async fn read(
    mut response: Response,
    endpoint: Endpoint,
    secrets: &[&str],
) -> Result<Value, ConnectorError> {
    let read_only = endpoint.read_only();
    let status = response.status();
    let wait = retry_after(response.headers());
    let mut body = Vec::new();
    loop {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                if body.len() + chunk.len() > MAX_BODY_BYTES {
                    return Err(if !read_only && status.is_success() {
                        ConnectorError::unknown("Google's answer is too large after a write")
                    } else {
                        ConnectorError::permanent("Google's answer is too large")
                    });
                }
                body.extend_from_slice(&chunk);
            }
            Ok(None) => break,
            // An answer arrived (it may have been acted on): never sent again.
            Err(_) => {
                let error = if read_only {
                    ConnectorError::transient
                } else {
                    ConnectorError::unknown
                };
                return Err(error(
                    "Google's answer broke off in transit: whether the request took effect is \
                     unknown",
                ));
            }
        }
    }
    let json = serde_json::from_slice::<Value>(&body).ok();
    if !status.is_success() {
        return Err(classify(status, json.as_ref(), wait, endpoint, secrets));
    }
    if endpoint == Endpoint::Revoke || body.iter().all(u8::is_ascii_whitespace) {
        return Ok(Value::Null);
    }
    match json {
        Some(json) => Ok(json),
        None if !read_only => Err(ConnectorError::unknown(
            "unreadable successful write response",
        )),
        None => Err(ConnectorError::permanent(format!(
            "HTTP {} with an unreadable body",
            status.as_u16()
        ))),
    }
}

/// The first error of a Google Ads failure.
struct AdsError {
    /// Its code, as the one key of its `errorCode` and that key's value (`campaignError`,
    /// `DURATION_TOO_LONG_FOR_TOTAL_BUDGET`).
    group: String,
    value: String,
    message: Option<String>,
    /// What its details add for a person: the policy topics of a finding, the least budget of
    /// a budget Google finds too small.
    notes: Vec<String>,
    /// How long a quota error asks to wait (`quotaErrorDetails.retryDelay`).
    retry: Option<Duration>,
}

/// `micros` of a currency as a plain amount with two decimals (`12.50`).
fn amount(micros: i64) -> String {
    format!(
        "{}.{:02}",
        micros / 1_000_000,
        (micros % 1_000_000).abs() / 10_000
    )
}

/// A `google.protobuf.Duration` in JSON (`"30s"`, `"1.5s"`), rounded up to whole seconds, when
/// positive; at most [`MAX_RETRY_AFTER`].
fn delay(value: &Value) -> Option<Duration> {
    let seconds = value
        .as_str()?
        .trim()
        .strip_suffix('s')?
        .parse::<f64>()
        .ok()?;
    (seconds.is_finite() && seconds > 0.0)
        .then(|| Duration::seconds((seconds.ceil() as i64).min(MAX_RETRY_AFTER.whole_seconds())))
}

/// The first error of a Google Ads failure in `json`.
fn first_error(json: &Value) -> Option<AdsError> {
    let details = json["error"]["details"].as_array()?;
    let error = details
        .iter()
        .filter_map(|detail| detail["errors"].as_array())
        .flatten()
        .next()?;
    let (group, value) = error["errorCode"]
        .as_object()
        .and_then(|code| code.iter().next())
        .and_then(|(group, value)| Some((group.clone(), value.as_str()?.to_owned())))?;
    let mut notes = Vec::new();
    let topics: Vec<&str> = error["details"]["policyFindingDetails"]["policyTopicEntries"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|entry| words(&entry["topic"]))
        .collect();
    if !topics.is_empty() {
        notes.push(format!("topics: {}", topics.join(", ")));
    }
    // A budget under Google's minimum says what the minimum is: that is what a person changes.
    let least = &error["details"]["budgetPerDayMinimumErrorDetails"];
    if let Some(micros) =
        crate::client::int(&least["minimumBudgetTotalAmountMicros"]).filter(|m| *m > 0)
    {
        let currency = words(&least["currencyCode"]).unwrap_or_default();
        notes.push(
            format!("least total budget: {} {currency}", amount(micros))
                .trim()
                .to_owned(),
        );
    }
    Some(AdsError {
        group,
        value,
        message: words(&error["message"]).map(str::to_owned),
        notes,
        retry: delay(&error["details"]["quotaErrorDetails"]["retryDelay"]),
    })
}

/// The error an answer with status `status` and body `json` (when it is JSON) from `endpoint`
/// maps to (the table in the crate docs; first match wins), with `wait` (the `Retry-After`
/// header) for a `Throttle`.
pub(crate) fn classify(
    status: StatusCode,
    json: Option<&Value>,
    wait: Option<Duration>,
    endpoint: Endpoint,
    secrets: &[&str],
) -> ConnectorError {
    let ads = json.and_then(first_error);
    let code = ads.as_ref().map(|e| (e.group.as_str(), e.value.as_str()));
    let oauth_error = json.and_then(|j| j["error"].as_str());
    let token_call = matches!(endpoint, Endpoint::Token(_) | Endpoint::Revoke);
    // The token endpoint refusing the platform's own client (its id or secret): no tenant can
    // fix that by reconnecting, so it is never the tenant's `Auth`.
    if token_call && status.is_client_error() && oauth_error == Some("invalid_client") {
        return ConnectorError::permanent(CLIENT_REJECTED);
    }
    // What is the platform project's own, whatever the status it comes with.
    let project = match code {
        Some(("quotaError", value)) => value == "ACCESS_PROHIBITED",
        Some(("authorizationError", value)) => {
            PROJECT_ERRORS.contains(&value) || value.starts_with(CLOUD_PROJECT_PREFIX)
        }
        Some(("authenticationError", value)) => PROJECT_AUTHENTICATION_ERRORS.contains(&value),
        _ => false,
    };
    if project {
        return ConnectorError::permanent(PROJECT_REJECTED);
    }
    if status == StatusCode::TOO_MANY_REQUESTS || matches!(code, Some(("quotaError", _))) {
        return ConnectorError::throttle(wait.or(ads.as_ref().and_then(|e| e.retry)));
    }
    let reason = reason(status, json, ads.as_ref(), secrets);
    if let Some(("authenticationError", value)) = code
        && ACCOUNT_AUTHENTICATION_ERRORS.contains(&value)
    {
        return ConnectorError::permission(reason);
    }
    let spent = token_call && oauth_error == Some("invalid_grant");
    if status == StatusCode::UNAUTHORIZED
        || matches!(code, Some(("authenticationError", _)))
        || (status.is_client_error() && spent)
    {
        return ConnectorError::auth(reason);
    }
    if status == StatusCode::FORBIDDEN || matches!(code, Some(("authorizationError", _))) {
        return ConnectorError::permission(reason);
    }
    if status.is_server_error() || matches!(code, Some(("internalError", _))) {
        return ConnectorError::transient(reason);
    }
    ConnectorError::permanent(reason)
}

/// `"HTTP <status> <group>.<VALUE>: <message> (<notes>)"` of a Google Ads error (its notes: the
/// topics of a policy finding, the least budget of one found too small), `"HTTP <status>
/// <error>: <error_description>"` of a token error, `"HTTP <status> <STATUS>: <message>"` of any
/// other Google API error, or `"HTTP <status> with an unreadable body"`; every secret in
/// `secrets` taken out, cut to [`MAX_REASON_CHARS`].
fn reason(
    status: StatusCode,
    json: Option<&Value>,
    ads: Option<&AdsError>,
    secrets: &[&str],
) -> String {
    let mut out = format!("HTTP {}", status.as_u16());
    let Some(json) = json else {
        out.push_str(" with an unreadable body");
        return out;
    };
    let (head, detail, notes): (Option<String>, Option<String>, &[String]) = match ads {
        Some(e) => (
            Some(format!("{}.{}", e.group, e.value)),
            e.message.clone(),
            &e.notes,
        ),
        None => match words(&json["error"]) {
            Some(error) => (
                Some(error.to_owned()),
                words(&json["error_description"]).map(str::to_owned),
                &[],
            ),
            None => (
                words(&json["error"]["status"]).map(str::to_owned),
                words(&json["error"]["message"]).map(str::to_owned),
                &[],
            ),
        },
    };
    if let Some(head) = head {
        out.push(' ');
        out.push_str(&head);
    }
    if let Some(detail) = detail {
        out.push_str(": ");
        out.push_str(&detail);
    }
    if !notes.is_empty() {
        out.push_str(" (");
        out.push_str(&notes.join("; "));
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

/// `text` with every secret of `secrets` replaced by `***`, longest first. The reason's
/// constructor then redacts what still looks like a credential.
fn scrub(text: &str, secrets: &[&str]) -> String {
    let mut forms: Vec<&str> = secrets.iter().copied().filter(|s| !s.is_empty()).collect();
    forms.sort_by_key(|s| std::cmp::Reverse(s.len()));
    let mut out = text.to_owned();
    for secret in forms {
        out = out.replace(secret, "***");
    }
    out
}

/// How long Google asks to wait: `Retry-After` in seconds, when positive, at most
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

    fn failure(group: &str, value: &str) -> Value {
        json!({"error":{"code":400,"message":"Request contains an invalid argument.",
            "status":"INVALID_ARGUMENT","details":[{
                "@type":"type.googleapis.com/google.ads.googleads.v26.errors.GoogleAdsFailure",
                "errors":[{"errorCode":{group:value},"message":"What went wrong."}],
                "requestId":"req-1"}]}})
    }

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
        let read = Endpoint::Read;
        let write = Endpoint::Write;
        let code = Endpoint::Token(Grant::Code);
        let refresh = Endpoint::Token(Grant::Refresh);
        let token_error = |e: &str| Some(json!({ "error": e, "error_description": "d" }));
        for (status, body, endpoint, expected) in [
            (429, None, read, "throttle"),
            (
                400,
                Some(failure("quotaError", "RESOURCE_EXHAUSTED")),
                write,
                "throttle",
            ),
            (
                403,
                Some(failure("quotaError", "ACCESS_PROHIBITED")),
                read,
                "permanent",
            ),
            // The platform's own trouble stays the platform's whatever the status it comes with.
            (
                429,
                Some(failure("quotaError", "ACCESS_PROHIBITED")),
                read,
                "permanent",
            ),
            (
                403,
                Some(failure("authorizationError", "MISSING_TOS")),
                read,
                "permanent",
            ),
            (
                401,
                Some(failure("authenticationError", "ORGANIZATION_NOT_APPROVED")),
                read,
                "permanent",
            ),
            // About one account and the user who signed in: signing in again changes nothing.
            (
                401,
                Some(failure("authenticationError", "CUSTOMER_NOT_FOUND")),
                read,
                "permission",
            ),
            (
                400,
                Some(failure(
                    "authenticationError",
                    "TWO_STEP_VERIFICATION_NOT_ENROLLED",
                )),
                read,
                "permission",
            ),
            (401, token_error("invalid_client"), code, "permanent"),
            (400, token_error("invalid_client"), refresh, "permanent"),
            (400, token_error("invalid_grant"), code, "auth"),
            (400, token_error("invalid_grant"), refresh, "auth"),
            (400, token_error("invalid_request"), refresh, "permanent"),
            (401, None, read, "auth"),
            (
                400,
                Some(failure("authenticationError", "OAUTH_TOKEN_REVOKED")),
                read,
                "auth",
            ),
            (
                403,
                Some(failure(
                    "authorizationError",
                    "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
                )),
                read,
                "permanent",
            ),
            (
                403,
                Some(failure("authorizationError", "PROJECT_DISABLED")),
                write,
                "permanent",
            ),
            (
                403,
                Some(failure("authorizationError", "USER_PERMISSION_DENIED")),
                read,
                "permission",
            ),
            (
                400,
                Some(failure("authorizationError", "CUSTOMER_NOT_ENABLED")),
                read,
                "permission",
            ),
            (403, None, write, "permission"),
            (500, None, read, "transient"),
            (503, None, write, "transient"),
            (
                400,
                Some(failure("internalError", "TRANSIENT_ERROR")),
                write,
                "transient",
            ),
            (
                400,
                Some(failure("campaignBudgetError", "MONEY_AMOUNT_TOO_LARGE")),
                write,
                "permanent",
            ),
            (404, None, read, "permanent"),
        ] {
            assert_eq!(
                kind(status, body.clone(), endpoint),
                expected,
                "{status} {body:?}"
            );
        }
    }

    #[test]
    fn reasons_name_googles_words_and_never_a_secret() {
        let e = classify(
            StatusCode::BAD_REQUEST,
            Some(&failure(
                "campaignError",
                "DURATION_TOO_LONG_FOR_TOTAL_BUDGET",
            )),
            None,
            Endpoint::Write,
            &[],
        );
        assert_eq!(
            e.reason(),
            Some("HTTP 400 campaignError.DURATION_TOO_LONG_FOR_TOTAL_BUDGET: What went wrong.")
        );
        // A policy finding names its topics: that is what a person has to change.
        let mut policy = failure("policyFindingError", "POLICY_FINDING");
        policy["error"]["details"][0]["errors"][0]["details"] = json!({"policyFindingDetails":
            {"policyTopicEntries":[{"topic":"TRADEMARKS_IN_AD_TEXT"},{"topic":"PUNCTUATION"}]}});
        let e = classify(
            StatusCode::BAD_REQUEST,
            Some(&policy),
            None,
            Endpoint::Write,
            &[],
        );
        assert!(
            e.reason()
                .unwrap()
                .ends_with("(topics: TRADEMARKS_IN_AD_TEXT, PUNCTUATION)"),
            "{e:?}"
        );
        // A budget Google finds too small says what the least is.
        let mut small = failure("campaignBudgetError", "BUDGET_BELOW_PER_DAY_MINIMUM");
        small["error"]["details"][0]["errors"][0]["details"] = json!({
            "budgetPerDayMinimumErrorDetails":
                {"currencyCode":"TRY","minimumBudgetTotalAmountMicros":"1250000000"}});
        let e = classify(
            StatusCode::BAD_REQUEST,
            Some(&small),
            None,
            Endpoint::Write,
            &[],
        );
        assert!(
            e.reason()
                .unwrap()
                .ends_with("(least total budget: 1250.00 TRY)"),
            "{e:?}"
        );
        // A token error that echoes a secret of the call does not carry it out.
        let echo = json!({"error":"invalid_grant","error_description":"Bad code: code-SECRET-1"});
        let e = classify(
            StatusCode::BAD_REQUEST,
            Some(&echo),
            None,
            Endpoint::Token(Grant::Code),
            &["code-SECRET-1"],
        );
        assert!(!format!("{e:?}").contains("code-SECRET-1"), "{e:?}");
        // Any other Google API error says its status word.
        let plain = json!({"error":{"code":404,"message":"Not found.","status":"NOT_FOUND"}});
        let e = classify(
            StatusCode::NOT_FOUND,
            Some(&plain),
            None,
            Endpoint::Read,
            &[],
        );
        assert_eq!(e.reason(), Some("HTTP 404 NOT_FOUND: Not found."));
    }

    #[test]
    fn a_quota_error_waits_as_long_as_google_asks() {
        let mut quota = failure("quotaError", "RESOURCE_TEMPORARILY_EXHAUSTED");
        quota["error"]["details"][0]["errors"][0]["details"] =
            json!({"quotaErrorDetails":{"retryDelay":"30.2s"}});
        let wait = |header: Option<Duration>| match classify(
            StatusCode::TOO_MANY_REQUESTS,
            Some(&quota),
            header,
            Endpoint::Read,
            &[],
        ) {
            ConnectorError::Throttle { retry_after, .. } => retry_after,
            other => panic!("{other:?}"),
        };
        // The answer's own wait, rounded up; the header's when the answer carries one.
        assert_eq!(wait(None), Some(Duration::seconds(31)));
        assert_eq!(wait(Some(Duration::seconds(5))), Some(Duration::seconds(5)));
        assert_eq!(delay(&json!("0s")), None);
        assert_eq!(delay(&json!("soon")), None);
        assert_eq!(delay(&json!("999999s")), Some(MAX_RETRY_AFTER));
        assert_eq!(amount(12_345_678), "12.34");
    }

    #[test]
    fn numbers_are_read_as_numbers_or_as_digit_strings() {
        assert_eq!(int(&json!(12)), Some(12));
        assert_eq!(int(&json!("1200000")), Some(1_200_000));
        assert_eq!(int(&json!("12.5")), None);
        assert_eq!(int(&json!(null)), None);
    }
}
