//! The first-message drafts' model: [`DraftModel`] for [`ClaudeModel`], over the same Messages
//! endpoint, key, prices and error mapping as the automatic replies.
//!
//! The body ([`draft_body`]): the model, `max_tokens`, `output_config.effort = "low"`, the system
//! prompt as two text blocks (the fixed instructions, then the workspace's part with a cache
//! breakpoint), the one strict tool `draft {subject, body}`, forced, and the prospect's facts as
//! the one user turn. No sampling parameter, thinking budget or prefill. The draft is read only
//! from a `draft` tool call, and none on a refusal or a cut answer. A short message's subject is
//! dropped. Nothing of a request or an answer is logged: `post` logs the status and the
//! request id only.

use async_trait::async_trait;
use jt_app::ports::draft_model::{Draft, DraftAnswer, DraftModel, DraftRequest, DraftShape};
use jt_app::ports::reply_model::ModelError;
use serde_json::{Value, json};

use crate::{ClaudeModel, EFFORT, MessageResponse, Prices, tool_choice, usage_of};

/// The draft's one tool.
pub fn draft_tool() -> Value {
    json!([{
        "name": "draft",
        "description": "The draft of the first message, for a person to read, change and send.",
        "strict": true,
        "input_schema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["subject", "body"],
            "properties": {
                "subject": { "type": "string", "description": "The email's subject; empty for a short message." },
                "body": { "type": "string", "description": "The message itself, without any footer or unsubscribe line." }
            }
        }
    }])
}

/// The request body of a draft (see the module docs).
pub fn draft_body(model: &str, request: &DraftRequest) -> Value {
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
        "tools": draft_tool(),
        "tool_choice": tool_choice(),
        "messages": [
            { "role": "user", "content": [ { "type": "text", "text": request.prospect } ] }
        ],
    })
}

/// A draft's answer: the `draft` tool call's text, unless the answer was refused or cut.
pub fn draft_of(response: &MessageResponse, prices: &Prices, shape: DraftShape) -> DraftAnswer {
    let usage = usage_of(response, prices);
    let stopped = matches!(
        response.stop_reason.as_deref(),
        Some("refusal" | "max_tokens")
    );
    let draft = response
        .content
        .iter()
        .find(|b| b["type"] == "tool_use" && b["name"] == "draft")
        .and_then(|b| {
            let body = b["input"]["body"].as_str()?.trim().to_owned();
            let subject = b["input"]["subject"]
                .as_str()
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty() && shape == DraftShape::Email);
            (!body.is_empty()).then_some(Draft { subject, body })
        })
        .filter(|_| !stopped);
    DraftAnswer { draft, usage }
}

#[async_trait]
impl DraftModel for ClaudeModel {
    fn model(&self) -> &str {
        &self.model
    }

    async fn draft(&self, request: &DraftRequest) -> Result<DraftAnswer, ModelError> {
        let body = self.post(&draft_body(&self.model, request)).await?;
        Ok(draft_of(&body, &self.prices, request.shape))
    }
}
