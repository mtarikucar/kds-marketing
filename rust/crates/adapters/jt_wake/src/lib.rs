//! The agent-wake adapter: [`AgentWaker`] over the one egress client.
//!
//! - **A Claude Code routine.** `POST {base}/v1/claude_code/routines/{routine_id}/fire` with
//!   `Authorization: Bearer <token>`, `anthropic-version: 2023-06-01` and a JSON body
//!   `{"text": …}` (at most 65,536 characters; Jeeta's is a few neutral sentences). The endpoint
//!   answers `200` with the session it created as soon as it exists (it does not wait for the
//!   run), `429` (`rate_limit_error`, with `Retry-After`) over its hourly limits, and the
//!   standard error envelope otherwise. It is experimental (docs:
//!   <https://platform.claude.com/docs/en/api/claude-code/routines-fire>): its request and
//!   response shapes live here only, in [`FireRequest`] and [`FireResponse`], with fixtures in
//!   `tests/fixtures`. Sent under the `anthropic` connector scope, whose one fixed host is
//!   `api.anthropic.com`.
//! - **A webhook.** `POST <url>` with the [`WebhookWake`] body (workspace, agent, reason codes,
//!   time: no content, no personal data) and the secret as a bearer token when one is set. Sent
//!   under [`EgressScope::PublicWebhook`]: `https` to a public host only, every address the name
//!   resolves to checked by the DNS guard, no redirect followed.
//!
//! Each request is bounded by [`WAKE_TIMEOUT`]. What either target answered is mapped to a
//! [`WakeAnswer`] by its status alone; a response's body is read only for a routine's `2xx`. No
//! log line names the token, the secret, the URL or a body.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use jt_app::ports::wake::{AgentWaker, WakeAnswer, WebhookWake};
use jt_outbound::{Egress, EgressError, EgressScope, Method, Response, Url, header};
use serde::{Deserialize, Serialize};

/// The scope a routine is fired under: the `anthropic` entry of the fixed tier.
pub const ROUTINE_SCOPE: EgressScope = EgressScope::Connector("anthropic");
/// The `anthropic-version` sent (the endpoint takes every version from this one on).
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
/// How long one wake may take, connect to end of body.
pub const WAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest `text` the endpoint takes, in characters.
pub const TEXT_MAX: usize = 65_536;

/// The body of a routine's fire.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FireRequest<'a> {
    pub text: &'a str,
}

/// A routine's `200` answer. Unknown fields are ignored; a missing one is `None`.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct FireResponse {
    #[serde(rename = "type", default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub claude_code_session_id: Option<String>,
    #[serde(default)]
    pub claude_code_session_url: Option<String>,
}

/// Where a routine is fired: production's `https://api.anthropic.com/`, a mock in tests.
#[derive(Clone, Debug)]
pub struct WakeBases {
    pub anthropic: Url,
}

impl WakeBases {
    pub fn production() -> WakeBases {
        WakeBases {
            anthropic: Url::parse("https://api.anthropic.com/").expect("a valid base"),
        }
    }
}

/// The production waker.
#[derive(Clone, Debug)]
pub struct EgressWaker {
    egress: Arc<Egress>,
    bases: WakeBases,
}

impl EgressWaker {
    pub fn new(egress: Arc<Egress>, bases: WakeBases) -> EgressWaker {
        EgressWaker { egress, bases }
    }
}

/// The answer a status means, before a routine's body is read: `None` for a `2xx`.
pub fn answer_of_status(status: u16, retry_after: Option<&str>) -> Option<WakeAnswer> {
    Some(match status {
        200..=299 => return None,
        429 => WakeAnswer::RateLimited {
            retry_after: retry_after
                .and_then(|v| v.trim().parse::<i64>().ok())
                .filter(|s| *s >= 0)
                .map(time::Duration::seconds),
        },
        401 | 403 | 404 => WakeAnswer::Refused {
            status: Some(status),
        },
        500..=599 => WakeAnswer::Unavailable {
            status: Some(status),
        },
        _ => WakeAnswer::Rejected { status },
    })
}

/// What a send that produced no response means: a refused host is the address's fault (a
/// person must set it again), anything else the network's.
fn answer_of_error(err: &EgressError) -> WakeAnswer {
    match err {
        EgressError::HostNotAllowed { .. } | EgressError::NotPublic { .. } => {
            WakeAnswer::Refused { status: None }
        }
        _ => WakeAnswer::Unavailable { status: None },
    }
}

fn retry_after(response: &Response) -> Option<String> {
    response
        .headers()
        .get(header::RETRY_AFTER)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

#[async_trait]
impl AgentWaker for EgressWaker {
    async fn fire_routine(&self, routine_id: &str, token: &str, text: &str) -> WakeAnswer {
        let Ok(url) = self
            .bases
            .anthropic
            .join(&format!("v1/claude_code/routines/{routine_id}/fire"))
        else {
            return WakeAnswer::Rejected { status: 0 };
        };
        let text: String = text.chars().take(TEXT_MAX).collect();
        let sent = self
            .egress
            .prepare(Method::POST, url)
            .bearer(token)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(&FireRequest { text: &text })
            .timeout(WAKE_TIMEOUT)
            .send(ROUTINE_SCOPE)
            .await;
        let response = match sent {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "a routine could not be fired");
                return answer_of_error(&e);
            }
        };
        let status = response.status().as_u16();
        if let Some(answer) = answer_of_status(status, retry_after(&response).as_deref()) {
            return answer;
        }
        let body: FireResponse = response.json().await.unwrap_or_default();
        WakeAnswer::Fired {
            status,
            session_id: body.claude_code_session_id,
            session_url: body.claude_code_session_url,
        }
    }

    async fn post_webhook(
        &self,
        url: &str,
        secret: Option<&str>,
        body: &WebhookWake,
    ) -> WakeAnswer {
        let Ok(url) = Url::parse(url) else {
            return WakeAnswer::Refused { status: None };
        };
        let mut request = self
            .egress
            .prepare(Method::POST, url)
            .json(body)
            .timeout(WAKE_TIMEOUT);
        if let Some(secret) = secret {
            request = request.bearer(secret);
        }
        match request.send(EgressScope::PublicWebhook).await {
            Ok(response) => {
                let status = response.status().as_u16();
                answer_of_status(status, retry_after(&response).as_deref()).unwrap_or(
                    WakeAnswer::Fired {
                        status,
                        session_id: None,
                        session_url: None,
                    },
                )
            }
            Err(e) => {
                tracing::warn!(error = %e, "an agent's webhook could not be reached");
                answer_of_error(&e)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statuses_map_to_answers() {
        assert_eq!(answer_of_status(200, None), None);
        assert_eq!(
            answer_of_status(429, Some("120")),
            Some(WakeAnswer::RateLimited {
                retry_after: Some(time::Duration::seconds(120))
            })
        );
        assert_eq!(
            answer_of_status(429, Some("Wed, 21 Oct 2026 07:28:00 GMT")),
            Some(WakeAnswer::RateLimited { retry_after: None })
        );
        for s in [401, 403, 404] {
            assert_eq!(
                answer_of_status(s, None),
                Some(WakeAnswer::Refused { status: Some(s) })
            );
        }
        assert_eq!(
            answer_of_status(503, None),
            Some(WakeAnswer::Unavailable { status: Some(503) })
        );
        assert_eq!(
            answer_of_status(400, None),
            Some(WakeAnswer::Rejected { status: 400 })
        );
    }

    #[test]
    fn the_fixtures_parse() {
        let ok: FireResponse =
            serde_json::from_str(include_str!("../tests/fixtures/routine_fire_200.json")).unwrap();
        assert_eq!(ok.kind.as_deref(), Some("routine_fire"));
        assert_eq!(
            ok.claude_code_session_url.as_deref(),
            Some("https://claude.ai/code/session_01HJKLMNOPQRSTUVWXYZ")
        );
        let body = serde_json::to_value(FireRequest { text: "x" }).unwrap();
        assert_eq!(body, serde_json::json!({ "text": "x" }));
    }
}
