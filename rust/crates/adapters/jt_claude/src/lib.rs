//! The inbox's automatic replies' model: [`ReplyModel`] over the Claude API's Messages endpoint,
//! through the one egress client.
//!
//! `POST {base}/v1/messages` with `x-api-key`, `anthropic-version: 2023-06-01` and a JSON body
//! ([`request_body`]): the model, `max_tokens`, `output_config.effort = "low"` (the model thinks
//! adaptively by default; a short customer answer needs little), the system prompt as two text
//! blocks (the fixed instructions, then the workspace's part with a cache breakpoint: the tools
//! and the system render first, so the whole stable prefix is cached), the three tools (`reply`,
//! `quote`, `hand_over`, each `strict` with `additionalProperties: false` and every property
//! required), [`tool_choice`], and the conversation as alternating `user` / `assistant` turns
//! ending with the customer's, its last block carrying the second breakpoint. An image a customer
//! sent is an `image` block with its bytes in base64 (`source.type: base64`), in the customer's
//! turn; it is never logged. No sampling
//! parameter (`temperature`, `top_p`, `top_k`), no thinking budget and no assistant prefill is
//! ever sent.
//!
//! The answer's content blocks are read by their `type` (a `thinking` block may come first): the
//! first `tool_use` naming one of the three tools is the answer. `stop_reason` `refusal` and
//! `max_tokens` are reported as such; an answer with no usable tool call is
//! [`ModelStop::NoTool`]. The four usage counts are read by name (anything else in `usage` is
//! ignored) and priced at the model's rates ([`Prices`]): an unknown model has no prices, and
//! [`ClaudeModel::new`] refuses it, so the feature stays off until its prices are added here.
//!
//! Statuses: `429` is [`ModelError::RateLimited`] with its `retry-after` seconds; `5xx` (`529`
//! overloaded included) and a network failure [`ModelError::Unavailable`]; every other status
//! [`ModelError::Rejected`]. Each request is bounded by [`REQUEST_TIMEOUT`]. A log line names
//! the status and the response's `request-id`, never the key, a body or a customer's text.

pub mod draft;

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use jt_app::ports::reply_model::{
    HAND_OVER_REASONS, JudgeAnswer, JudgeRequest, ModelAnswer, ModelError, ModelRequest, ModelStop,
    ModelTool, Part, ReplyModel, Speaker, Usage,
};
use jt_outbound::{Egress, EgressError, EgressScope, Method, Url, header};
use serde::Deserialize;
use serde_json::{Value, json};
use zeroize::Zeroizing;

/// The scope every request is sent under: the `anthropic` entry of the fixed tier.
pub const SCOPE: EgressScope = EgressScope::Connector("anthropic");
/// The `anthropic-version` sent.
pub const ANTHROPIC_VERSION: &str = "2023-06-01";
/// How long one request may take, connect to end of body.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
/// The model the automatic replies use unless the platform names another.
pub const DEFAULT_MODEL: &str = "claude-haiku-5-5";
/// How hard the model thinks.
pub const EFFORT: &str = "low";

/// How the model must answer: through exactly one tool. Forced tool use is accepted by Claude
/// Haiku 5.5 (it is refused by some other current models; were it refused, `{"type": "auto"}`
/// here, with the system prompt's instruction to always use one tool, is the fallback, and an
/// answer without a tool call is handed over either way).
pub fn tool_choice() -> Value {
    json!({ "type": "any", "disable_parallel_tool_use": true })
}

/// What a model's tokens cost, in billionths of a US dollar per token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Prices {
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
}

impl Prices {
    /// The prices of `model` for prompts up to 100K tokens, when this adapter knows them.
    pub fn of(model: &str) -> Option<Prices> {
        match model {
            // $0.10 input and $0.50 output per million tokens; a cache write is 1.25x the input,
            // a cache read 0.1x.
            "claude-haiku-5-5" => Some(Prices {
                input: 100,
                output: 500,
                cache_write: 125,
                cache_read: 10,
            }),
            _ => None,
        }
    }

    /// What `usage` costs, in millionths of a US dollar, rounded up.
    pub fn cost_micro_usd(&self, usage: &Usage) -> i64 {
        let nano = u128::from(usage.input_tokens) * u128::from(self.input)
            + u128::from(usage.output_tokens) * u128::from(self.output)
            + u128::from(usage.cache_write_tokens) * u128::from(self.cache_write)
            + u128::from(usage.cache_read_tokens) * u128::from(self.cache_read);
        i64::try_from(nano.div_ceil(1000)).unwrap_or(i64::MAX)
    }
}

/// The platform's Claude API key. `Debug` masks it; it is wiped from memory when dropped.
#[derive(Clone)]
pub struct ApiKey(Zeroizing<String>);

impl ApiKey {
    pub fn new(key: String) -> ApiKey {
        ApiKey(Zeroizing::new(key))
    }

    fn expose(&self) -> &str {
        self.0.as_str()
    }
}

impl PartialEq for ApiKey {
    fn eq(&self, other: &ApiKey) -> bool {
        self.expose() == other.expose()
    }
}

impl Eq for ApiKey {}

impl fmt::Debug for ApiKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("ApiKey(***)")
    }
}

/// Where the API is: production's `https://api.anthropic.com/`, a mock in tests.
#[derive(Clone, Debug)]
pub struct ClaudeBases {
    pub anthropic: Url,
}

impl ClaudeBases {
    pub fn production() -> ClaudeBases {
        ClaudeBases {
            anthropic: Url::parse("https://api.anthropic.com/").expect("a valid base"),
        }
    }
}

/// The production model.
pub struct ClaudeModel {
    egress: Arc<Egress>,
    bases: ClaudeBases,
    key: ApiKey,
    model: String,
    prices: Prices,
}

impl fmt::Debug for ClaudeModel {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ClaudeModel")
            .field("model", &self.model)
            .field("key", &self.key)
            .finish()
    }
}

impl ClaudeModel {
    /// The model `model` with `key`; none for a model whose prices this adapter does not know.
    pub fn new(
        egress: Arc<Egress>,
        bases: ClaudeBases,
        key: ApiKey,
        model: &str,
    ) -> Option<ClaudeModel> {
        Some(ClaudeModel {
            prices: Prices::of(model)?,
            egress,
            bases,
            key,
            model: model.to_owned(),
        })
    }
}

/// The tools the model answers through.
pub fn tools() -> Value {
    json!([
        {
            "name": "reply",
            "description": "Send the customer a message. Never state a price or an amount of money here: prices go only through `quote`.",
            "strict": true,
            "input_schema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["text"],
                "properties": {
                    "text": { "type": "string", "description": "The message, in the customer's language, at most 1000 characters." }
                }
            }
        },
        {
            "name": "quote",
            "description": "Give the customer a price for a standard request, within the business's price range. The message must state exactly this amount and no other.",
            "strict": true,
            "input_schema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["amount", "basis", "text"],
                "properties": {
                    "amount": { "type": "integer", "description": "The price in whole units of the business's currency." },
                    "basis": { "type": "string", "description": "Why this amount, by the standard card's rules (for the business, not the customer)." },
                    "text": { "type": "string", "description": "The message to the customer stating the amount, at most 1000 characters." }
                }
            }
        },
        {
            "name": "hand_over",
            "description": "Pass the conversation to a person at the business: anything outside the standard work, not covered by the cards, a complaint, a payment problem, a bulk or corporate order, or a request for a person.",
            "strict": true,
            "input_schema": {
                "type": "object",
                "additionalProperties": false,
                "required": ["reason", "summary", "text"],
                "properties": {
                    "reason": { "type": "string", "enum": HAND_OVER_REASONS },
                    "summary": { "type": "string", "description": "What the customer wants and what is known so far, for the person (short)." },
                    "text": { "type": "string", "description": "A short line telling the customer someone will continue, in their language; empty for none." }
                }
            }
        }
    ])
}

/// The request body for `request` to `model` (see the crate docs).
pub fn request_body(model: &str, request: &ModelRequest) -> Value {
    let mut messages: Vec<Value> = request
        .history
        .iter()
        .map(|turn| {
            let role = match turn.speaker {
                Speaker::Customer => "user",
                Speaker::Business => "assistant",
            };
            let content: Vec<Value> = turn
                .parts
                .iter()
                .map(|p| match p {
                    Part::Text { text } => json!({ "type": "text", "text": text }),
                    Part::Image { image } => json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image.kind.mime(),
                            "data": STANDARD.encode(&image.data),
                        }
                    }),
                })
                .collect();
            json!({ "role": role, "content": content })
        })
        .collect();
    if let Some(last) = messages
        .last_mut()
        .and_then(|m| m["content"].as_array_mut())
        .and_then(|c| c.last_mut())
    {
        last["cache_control"] = json!({ "type": "ephemeral" });
    }
    json!({
        "model": model,
        "max_tokens": request.max_tokens,
        "output_config": { "effort": EFFORT },
        "system": [
            { "type": "text", "text": request.system_fixed },
            {
                "type": "text",
                "text": request.system_workspace,
                "cache_control": { "type": "ephemeral" }
            }
        ],
        "tools": tools(),
        "tool_choice": tool_choice(),
        "messages": messages,
    })
}

/// The four usage counts, read by name.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
struct UsageIn {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
}

/// A `200` answer: its content blocks (read by type), why it stopped and what it used.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct MessageResponse {
    #[serde(default)]
    content: Vec<Value>,
    #[serde(default)]
    stop_reason: Option<String>,
    #[serde(default)]
    usage: Option<UsageIn>,
}

#[derive(Deserialize)]
struct ReplyIn {
    text: String,
}

#[derive(Deserialize)]
struct QuoteIn {
    amount: i64,
    #[serde(default)]
    basis: String,
    text: String,
}

#[derive(Deserialize)]
struct HandOverIn {
    reason: String,
    #[serde(default)]
    summary: String,
    #[serde(default)]
    text: Option<String>,
}

/// The tool call `block` makes, when it is a usable one.
fn tool_of(block: &Value) -> Option<ModelTool> {
    if block["type"] != "tool_use" {
        return None;
    }
    let input = block["input"].clone();
    match block["name"].as_str()? {
        "reply" => serde_json::from_value::<ReplyIn>(input)
            .ok()
            .map(|r| ModelTool::Reply { text: r.text }),
        "quote" => serde_json::from_value::<QuoteIn>(input)
            .ok()
            .map(|q| ModelTool::Quote {
                amount: q.amount,
                basis: q.basis,
                text: q.text,
            }),
        "hand_over" => {
            serde_json::from_value::<HandOverIn>(input)
                .ok()
                .map(|h| ModelTool::HandOver {
                    reason: h.reason,
                    summary: h.summary,
                    text: h.text.filter(|t| !t.trim().is_empty()),
                })
        }
        _ => None,
    }
}

/// `response` as the use case reads it, priced at `prices`.
pub fn answer_of(response: &MessageResponse, prices: &Prices) -> ModelAnswer {
    let usage = usage_of(response, prices);
    let tool = response.content.iter().find_map(tool_of);
    let stop = match (response.stop_reason.as_deref(), &tool) {
        (Some("refusal"), _) => ModelStop::Refusal,
        (Some("max_tokens"), _) => ModelStop::MaxTokens,
        (_, Some(_)) => ModelStop::ToolUse,
        (_, None) => ModelStop::NoTool,
    };
    ModelAnswer {
        tool: tool.filter(|_| stop == ModelStop::ToolUse),
        stop,
        usage,
    }
}

/// The usage of `response`, priced at `prices`.
fn usage_of(response: &MessageResponse, prices: &Prices) -> Usage {
    let u = response.usage.unwrap_or_default();
    let mut usage = Usage {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_write_tokens: u.cache_creation_input_tokens,
        cache_read_tokens: u.cache_read_input_tokens,
        cost_micro_usd: 0,
    };
    usage.cost_micro_usd = prices.cost_micro_usd(&usage);
    usage
}

/// The error a non-`2xx` status means.
pub fn error_of_status(status: u16, retry_after: Option<&str>) -> ModelError {
    match status {
        429 => ModelError::RateLimited {
            retry_after: retry_after
                .and_then(|v| v.trim().parse::<i64>().ok())
                .filter(|s| *s >= 0)
                .map(time::Duration::seconds),
        },
        500..=599 => ModelError::Unavailable {
            status: Some(status),
        },
        _ => ModelError::Rejected {
            status: Some(status),
        },
    }
}

#[async_trait]
impl ReplyModel for ClaudeModel {
    fn model(&self) -> &str {
        &self.model
    }

    async fn answer(&self, request: &ModelRequest) -> Result<ModelAnswer, ModelError> {
        let body = self.post(&request_body(&self.model, request)).await?;
        Ok(answer_of(&body, &self.prices))
    }

    async fn judge(&self, request: &JudgeRequest) -> Result<JudgeAnswer, ModelError> {
        let body = self.post(&judge_body(&self.model, request)).await?;
        Ok(verdict_of(&body, &self.prices))
    }
}

impl ClaudeModel {
    /// Sends `body` to the Messages endpoint and reads a `2xx` answer (see the crate docs).
    async fn post(&self, body: &Value) -> Result<MessageResponse, ModelError> {
        let url = self
            .bases
            .anthropic
            .join("v1/messages")
            .map_err(|_| ModelError::Rejected { status: None })?;
        let sent = self
            .egress
            .prepare(Method::POST, url)
            .header("x-api-key", self.key.expose())
            .header("anthropic-version", ANTHROPIC_VERSION)
            .json(body)
            .timeout(REQUEST_TIMEOUT)
            .send(SCOPE)
            .await;
        let response = match sent {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!(error = %e, "the model could not be reached");
                return Err(match e {
                    EgressError::HostNotAllowed { .. } | EgressError::NotPublic { .. } => {
                        ModelError::Rejected { status: None }
                    }
                    _ => ModelError::Unavailable { status: None },
                });
            }
        };
        let status = response.status().as_u16();
        let request_id = response
            .headers()
            .get("request-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        if !(200..300).contains(&status) {
            let retry_after = response
                .headers()
                .get(header::RETRY_AFTER)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            tracing::warn!(status, request_id = %request_id, "the model refused a request");
            return Err(error_of_status(status, retry_after.as_deref()));
        }
        response.json::<MessageResponse>().await.map_err(|_| {
            tracing::warn!(status, request_id = %request_id, "the model's answer did not parse");
            ModelError::Unavailable {
                status: Some(status),
            }
        })
    }
}

/// The check's one tool: `verdict {allowed}`, strict.
pub fn verdict_tool() -> Value {
    json!([{
        "name": "verdict",
        "description": "Whether the message may be sent as it is.",
        "strict": true,
        "input_schema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["allowed"],
            "properties": { "allowed": { "type": "boolean" } }
        }
    }])
}

/// The request body of a check (see [`JudgeRequest`]): the instructions, the cards with a cache
/// breakpoint and the server's facts as the system text, the one strict tool, forced, and the
/// judged text alone as the one user turn.
pub fn judge_body(model: &str, request: &JudgeRequest) -> Value {
    json!({
        "model": model,
        "max_tokens": request.max_tokens,
        "output_config": { "effort": EFFORT },
        "system": [
            { "type": "text", "text": request.system },
            {
                "type": "text",
                "text": request.cards,
                "cache_control": { "type": "ephemeral" }
            },
            { "type": "text", "text": request.facts }
        ],
        "tools": verdict_tool(),
        "tool_choice": tool_choice(),
        "messages": [
            { "role": "user", "content": [ { "type": "text", "text": request.text } ] }
        ],
    })
}

/// A check's answer: `allowed` only from a `verdict` tool call with a boolean, and only when the
/// answer neither was refused nor ran out of tokens.
pub fn verdict_of(response: &MessageResponse, prices: &Prices) -> JudgeAnswer {
    let usage = usage_of(response, prices);
    let stopped = matches!(
        response.stop_reason.as_deref(),
        Some("refusal" | "max_tokens")
    );
    let allowed = response
        .content
        .iter()
        .find(|b| b["type"] == "tool_use" && b["name"] == "verdict")
        .and_then(|b| b["input"]["allowed"].as_bool())
        .filter(|_| !stopped);
    JudgeAnswer { allowed, usage }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn haiku_is_priced_and_an_unknown_model_is_not() {
        let p = Prices::of(DEFAULT_MODEL).unwrap();
        let usage = Usage {
            input_tokens: 1_000_000,
            output_tokens: 1_000_000,
            cache_write_tokens: 1_000_000,
            cache_read_tokens: 1_000_000,
            cost_micro_usd: 0,
        };
        // $0.10 + $0.50 + $0.125 + $0.01
        assert_eq!(p.cost_micro_usd(&usage), 735_000);
        let one = Usage {
            input_tokens: 1,
            ..Usage::default()
        };
        assert_eq!(p.cost_micro_usd(&one), 1, "rounded up");
        assert_eq!(Prices::of("claude-unknown-1"), None);
    }

    #[test]
    fn statuses_map_to_errors() {
        assert_eq!(
            error_of_status(429, Some("7")),
            ModelError::RateLimited {
                retry_after: Some(time::Duration::seconds(7))
            }
        );
        assert_eq!(
            error_of_status(529, None),
            ModelError::Unavailable { status: Some(529) }
        );
        assert_eq!(
            error_of_status(400, None),
            ModelError::Rejected { status: Some(400) }
        );
    }

    #[test]
    fn the_key_is_masked() {
        assert_eq!(
            format!("{:?}", ApiKey::new("sk-ant-secret".into())),
            "ApiKey(***)"
        );
    }
}
