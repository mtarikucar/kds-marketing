//! A scripted shop (`jt_app::ports::shop::ShopClient`): answers each tool call from a script, in
//! order, and records what it was asked (the arguments included, so a test can check what reached
//! the shop and that nothing else kept it). Never reaches the network.

use std::collections::VecDeque;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use jt_app::ports::connectors::Url;
use jt_app::ports::shop::{ShopCall, ShopClient, ShopError};
use jt_connector::Credential;
use jt_tenancy::WorkspaceId;
use serde_json::{Value, json};

/// What a [`ScriptedShop`] answers one call with.
pub type ShopResult = Result<Value, ShopError>;

type ShopHook = Box<dyn FnOnce() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send>;

/// One call a [`ScriptedShop`] received.
#[derive(Clone, Debug, PartialEq)]
pub struct ShopCallMade {
    pub workspace_id: WorkspaceId,
    pub endpoint: String,
    /// The bearer token it was called with.
    pub token: Option<String>,
    pub tool: String,
    pub arguments: Value,
}

/// The scripted shop.
pub struct ScriptedShop {
    tools: Mutex<Vec<String>>,
    answers: Mutex<VecDeque<ShopResult>>,
    calls: Mutex<Vec<ShopCallMade>>,
    hooks: Mutex<VecDeque<ShopHook>>,
}

impl ScriptedShop {
    /// A shop listing `call_api_operation`, with nothing scripted (a call past the script is
    /// `Unavailable`).
    pub fn new() -> Arc<Self> {
        Arc::new(ScriptedShop {
            tools: Mutex::new(vec!["call_api_operation".into()]),
            answers: Mutex::new(VecDeque::new()),
            calls: Mutex::new(Vec::new()),
            hooks: Mutex::new(VecDeque::new()),
        })
    }

    /// Queues `answer` for the next call.
    pub fn answer(&self, answer: ShopResult) {
        lock(&self.answers).push_back(answer);
    }

    /// Queues the tool result of a created order: `data` as JSON in `content[0].text`, beside
    /// `ok: true` (the shape an invented shop answers with).
    pub fn created(&self, data: Value) {
        let text = json!({ "ok": true, "status": 200, "data": data }).to_string();
        self.answer(Ok(json!({ "content": [{ "type": "text", "text": text }] })));
    }

    /// Queues `hook` to run during the next call, before it answers (what happens while the shop
    /// is asked).
    pub fn during_next<F, Fut>(&self, hook: F)
    where
        F: FnOnce() -> Fut + Send + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        lock(&self.hooks).push_back(Box::new(move || Box::pin(hook())));
    }

    /// The tool calls so far, oldest first.
    pub fn calls(&self) -> Vec<ShopCallMade> {
        lock(&self.calls).clone()
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[async_trait]
impl ShopClient for ScriptedShop {
    async fn list_tools(
        &self,
        _ws: WorkspaceId,
        _endpoint: &Url,
        _cred: &Credential,
    ) -> Result<Vec<String>, ShopError> {
        Ok(lock(&self.tools).clone())
    }

    async fn call_tool(
        &self,
        ws: WorkspaceId,
        endpoint: &Url,
        cred: &Credential,
        call: &ShopCall,
    ) -> Result<Value, ShopError> {
        lock(&self.calls).push(ShopCallMade {
            workspace_id: ws,
            endpoint: endpoint.to_string(),
            token: match cred {
                Credential::Bearer { token } => Some(token.clone()),
                _ => None,
            },
            tool: call.tool.clone(),
            arguments: call.arguments.clone(),
        });
        let hook = lock(&self.hooks).pop_front();
        if let Some(hook) = hook {
            hook().await;
        }
        let next = lock(&self.answers).pop_front();
        next.unwrap_or(Err(ShopError::Unavailable))
    }
}
