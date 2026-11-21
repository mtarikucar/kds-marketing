//! The client of a workspace's own shop over MCP (Model Context Protocol, streamable HTTP):
//! [`ShopClient`] and the [`Connector`] of [`Provider::Mcp`] (capability kind `shop_mcp`), over
//! the one egress client.
//!
//! The shop is one endpoint URL, reached with a bearer token ([`Credential::Bearer`]); any other
//! credential is refused (`ShopError::Auth`, an auth-kind probe failure) without a request. Every
//! step is one `POST` to the endpoint itself, under [`EgressScope::Tenant`] of the workspace (the
//! endpoint's host is a tenant host the use case registers): the crate holds no HTTP client of its
//! own. Each `POST` carries `Authorization: Bearer <token>`, `Content-Type: application/json`,
//! `Accept: application/json, text/event-stream`, `MCP-Protocol-Version: 2025-06-18`
//! ([`PROTOCOL_VERSION`]) and, once the server sent one in a response header, its
//! `Mcp-Session-Id`, so stateless and stateful servers both work.
//!
//! Both operations run the same sequence:
//!
//! 1. `initialize` (id 1, protocol version [`PROTOCOL_VERSION`], client `jeeta`). `401`/`403` is
//!    `ShopError::Auth`; a transport failure, a timeout or a `5xx` is `ShopError::Unavailable`; a
//!    `3xx` is `ShopError::Rejected` with its status. Another `4xx`, a JSON-RPC error or an
//!    answer that does not parse means a stateless server that refuses `initialize`: the
//!    sequence goes on to step 3 without a session.
//! 2. When step 1 succeeded, the `notifications/initialized` notification. Its answer (usually
//!    an empty `202`) is ignored, but for `401`/`403` (`Auth`), a `3xx` (`Rejected`) and a
//!    transport failure (`Unavailable`).
//! 3. `tools/list` or `tools/call` (id 2).
//!
//! An answer is either `application/json` (the JSON-RPC response) or `text/event-stream`: then
//! the first event whose `data` (its `data:` lines joined by `\n`) is a JSON object with the
//! request's id is the response, and every other event is ignored; reading stops there. A content
//! type with parameters (`application/json; charset=utf-8`) is read the same way.
//!
//! What step 3 fails with:
//!
//! - **`tools/list`** answers the names in `result.tools[].name`. `401`/`403` is `Auth`; another
//!   `3xx`/`4xx` is `Rejected` with the HTTP status as its code, a JSON-RPC error `Rejected` with
//!   the error's code; a transport failure, a timeout or a `5xx` is `Unavailable`; an answer over
//!   the cap, one that does not parse, or a stream that ends without the response is
//!   `Malformed`.
//! - **`tools/call`** answers the whole `result` object as the shop gave it (`content`,
//!   `structuredContent`, `isError`): a tool that reports an error (`isError: true`) is an `Ok`
//!   the caller reads. A failure before the call was sent (any failure of steps 1 and 2, a host
//!   the egress client refuses, a connection that could not be opened, no time left) is
//!   `Unavailable`, `Auth` or `Rejected` as above. Once it was sent: `401`/`403` is `Auth`, a
//!   JSON-RPC error `Rejected` with its code (the tool's own refusal), and anything else (any
//!   other status: `408`, `409`, `425`, `429`, another `3xx`/`4xx`), (a timeout, a broken connection, a `5xx`, an answer over the cap or
//!   one that does not parse, a stream that ends without the response) is `ShopError::Unknown`:
//!   the shop may have acted on it.
//!
//! A JSON-RPC error's code is kept only when it is an integer. Each answer is read up to
//! [`BODY_CAP`] bytes and never further. The whole sequence is bounded by [`TIMEOUT`]: each
//! `POST` gets the time left. Nothing is ever retried, and no redirect is followed (the egress
//! client refuses them; a `3xx` is a refusal at every step).
//!
//! The connector's probe reads `endpoint` (an `https` URL) and `workspace_id` from the
//! capability's public facts, lists the tools, and succeeds when the order tool is listed: the
//! one named in `order.tool`, or `call_api_operation` when no such name is given. Its facts are
//! `{"account_id": <endpoint, exactly as given>}`: the capability's account is its endpoint. A
//! missing or invalid endpoint or workspace is a permanent failure, an unlisted order tool a
//! permission failure, `Auth` an auth failure (the capability needs reconnecting), `Rejected` a
//! permission failure, `Unavailable` and `Unknown` transient ones, and `Malformed` a permanent
//! one. Its hosts are none of the fixed tier, and a bearer token needs no refresh.
//!
//! No log line carries a body, the token, the URL or a tool's arguments: a warning names the
//! step, the HTTP status and a JSON-RPC error code only.

use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use jt_app::ports::connectors::Connector;
use jt_app::ports::shop::{ShopCall, ShopClient, ShopError};
use jt_connector::{ConnectorError, Credential, ProbeResult, Provider};
use jt_outbound::{Egress, EgressError, EgressScope, Method, Response, Url, header};
use jt_tenancy::WorkspaceId;
use serde_json::{Value, json};

/// The MCP revision spoken, sent in `initialize` and in every request's `MCP-Protocol-Version`.
pub const PROTOCOL_VERSION: &str = "2025-06-18";
/// The most bytes read of one answer.
pub const BODY_CAP: usize = 256 * 1024;
/// How long the whole sequence of one operation may take.
pub const TIMEOUT: Duration = Duration::from_secs(15);
/// The tool the probe looks for when the capability names no order tool.
const DEFAULT_ORDER_TOOL: &str = "call_api_operation";
/// The longest session id kept.
const SESSION_ID_MAX: usize = 1024;

/// The MCP shop client. Holds no secret: a token is handed to each call.
#[derive(Clone)]
pub struct McpClient {
    egress: Arc<Egress>,
    timeout: Duration,
}

impl McpClient {
    pub fn new(egress: Arc<Egress>) -> McpClient {
        McpClient {
            egress,
            timeout: TIMEOUT,
        }
    }

    /// The same client with another bound on the whole sequence, for tests.
    #[doc(hidden)]
    pub fn with_timeout(self, timeout: Duration) -> McpClient {
        McpClient { timeout, ..self }
    }
}

impl fmt::Debug for McpClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("McpClient")
            .field("timeout", &self.timeout)
            .finish_non_exhaustive()
    }
}

/// Why one step gave no JSON-RPC result.
#[derive(Debug)]
enum StepError {
    /// `401`, `403`.
    Auth,
    /// Another status that is not `2xx`.
    Status(u16),
    /// Nothing was sent: the egress client refused the host, the connection could not be
    /// opened, the request could not be built, or no time was left.
    NotSent,
    /// The request may have been sent, but the exchange broke (a timeout, a reset).
    Transport,
    /// The answer is longer than [`BODY_CAP`].
    TooLarge,
    /// The answer is not a JSON-RPC response to the request.
    Unparsable,
    /// A JSON-RPC error, its code when it is an integer.
    Rpc(Option<String>),
}

impl StepError {
    fn warn(&self, step: &'static str) {
        match self {
            StepError::Auth => tracing::warn!(step, "the shop refused the token"),
            StepError::Status(status) => tracing::warn!(step, status, "the shop answered a status"),
            StepError::Rpc(code) => {
                tracing::warn!(step, code = code.as_deref(), "the shop answered an error")
            }
            other => tracing::warn!(step, error = other.key(), "a shop request failed"),
        }
    }

    fn key(&self) -> &'static str {
        match self {
            StepError::Auth => "auth",
            StepError::Status(_) => "status",
            StepError::NotSent => "not_sent",
            StepError::Transport => "transport",
            StepError::TooLarge => "too_large",
            StepError::Unparsable => "unparsable",
            StepError::Rpc(_) => "rpc_error",
        }
    }
}

/// One operation's exchange with the endpoint.
struct Exchange<'a> {
    egress: &'a Egress,
    ws: WorkspaceId,
    endpoint: &'a Url,
    token: &'a str,
    deadline: Instant,
    session: Option<String>,
}

impl Exchange<'_> {
    /// Sends `body`, answering the response when its status is `2xx`.
    async fn post(&mut self, body: &Value) -> Result<Response, StepError> {
        let left = self.deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(StepError::NotSent);
        }
        let mut request = self
            .egress
            .prepare(Method::POST, self.endpoint.clone())
            .bearer(self.token)
            .header(header::ACCEPT, "application/json, text/event-stream")
            .header("mcp-protocol-version", PROTOCOL_VERSION)
            .json(body)
            .timeout(left);
        if let Some(session) = &self.session {
            request = request.header("mcp-session-id", session.as_str());
        }
        let response = request
            .send(EgressScope::Tenant(self.ws))
            .await
            .map_err(|e| match e {
                EgressError::Transport(e) if !e.is_connect() => StepError::Transport,
                _ => StepError::NotSent,
            })?;
        let status = response.status().as_u16();
        match status {
            200..=299 => {}
            401 | 403 => return Err(StepError::Auth),
            _ => return Err(StepError::Status(status)),
        }
        if self.session.is_none()
            && let Some(id) = response
                .headers()
                .get("mcp-session-id")
                .and_then(|v| v.to_str().ok())
                .filter(|v| !v.is_empty() && v.len() <= SESSION_ID_MAX)
        {
            self.session = Some(id.to_owned());
        }
        Ok(response)
    }

    /// Sends request `id` of `method` and answers its JSON-RPC result.
    async fn request(
        &mut self,
        id: u64,
        method: &str,
        params: Option<Value>,
    ) -> Result<Value, StepError> {
        let mut body = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if let Some(params) = params {
            body["params"] = params;
        }
        let response = self.post(&body).await?;
        let envelope = read_answer(response, id).await?;
        if let Some(error) = envelope.get("error") {
            let code = error
                .get("code")
                .and_then(Value::as_i64)
                .map(|c| c.to_string());
            return Err(StepError::Rpc(code));
        }
        envelope.get("result").cloned().ok_or(StepError::Unparsable)
    }

    /// Steps 1 and 2: a session when the server opens one. A failure here means nothing of the
    /// operation was sent.
    async fn open(&mut self) -> Result<(), ShopError> {
        let params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "jeeta", "version": "1"},
        });
        match self.request(1, "initialize", Some(params)).await {
            Ok(_) => {}
            Err(e) => {
                e.warn("initialize");
                return match e {
                    StepError::Auth => Err(ShopError::Auth),
                    StepError::NotSent | StepError::Transport => Err(ShopError::Unavailable),
                    StepError::Status(s) if s >= 500 => Err(ShopError::Unavailable),
                    StepError::Status(s) if (300..400).contains(&s) => Err(ShopError::Rejected {
                        code: Some(s.to_string()),
                    }),
                    // A stateless server that refuses `initialize`: go on without a session.
                    StepError::Status(_)
                    | StepError::Rpc(_)
                    | StepError::Unparsable
                    | StepError::TooLarge => {
                        self.session = None;
                        Ok(())
                    }
                };
            }
        }
        let note = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        match self.post(&note).await {
            Ok(_) => Ok(()),
            Err(e) => {
                e.warn("notifications/initialized");
                match e {
                    StepError::Auth => Err(ShopError::Auth),
                    StepError::NotSent | StepError::Transport => Err(ShopError::Unavailable),
                    StepError::Status(s) if (300..400).contains(&s) => Err(ShopError::Rejected {
                        code: Some(s.to_string()),
                    }),
                    _ => Ok(()),
                }
            }
        }
    }
}

/// Whether a `Content-Type` is `text/event-stream`, parameters aside.
fn is_event_stream(response: &Response) -> bool {
    response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_some_and(|v| v.trim().eq_ignore_ascii_case("text/event-stream"))
}

/// The JSON-RPC response to request `id` in `response`, read up to [`BODY_CAP`] bytes.
async fn read_answer(mut response: Response, id: u64) -> Result<Value, StepError> {
    if response
        .content_length()
        .is_some_and(|n| n > BODY_CAP as u64)
    {
        return Err(StepError::TooLarge);
    }
    let matches = |v: &Value| v.is_object() && v.get("id") == Some(&json!(id));
    let mut read = 0usize;
    if is_event_stream(&response) {
        let mut stream = EventStream::default();
        while let Some(chunk) = response.chunk().await.map_err(|_| StepError::Transport)? {
            read += chunk.len();
            if read > BODY_CAP {
                return Err(StepError::TooLarge);
            }
            if let Some(found) = stream.feed(&chunk, &matches) {
                return Ok(found);
            }
        }
        return stream.finish(&matches).ok_or(StepError::Unparsable);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| StepError::Transport)? {
        if bytes.len() + chunk.len() > BODY_CAP {
            return Err(StepError::TooLarge);
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(matches)
        .ok_or(StepError::Unparsable)
}

/// A `text/event-stream` read as it arrives: lines are split on `\n` (a trailing `\r` dropped),
/// an empty line ends an event, `data:` lines are joined by `\n`, and every other field and
/// comment is ignored.
#[derive(Default)]
struct EventStream {
    line: Vec<u8>,
    data: Vec<String>,
}

impl EventStream {
    /// Takes `chunk`, answering the first finished event whose data is JSON that `wanted` takes.
    fn feed(&mut self, chunk: &[u8], wanted: &impl Fn(&Value) -> bool) -> Option<Value> {
        for &byte in chunk {
            if byte != b'\n' {
                self.line.push(byte);
                continue;
            }
            let line = std::mem::take(&mut self.line);
            if let Some(found) = self.take_line(&line, wanted) {
                return Some(found);
            }
        }
        None
    }

    /// The end of the stream: a last line and event without their terminators count.
    fn finish(mut self, wanted: &impl Fn(&Value) -> bool) -> Option<Value> {
        let line = std::mem::take(&mut self.line);
        if !line.is_empty()
            && let Some(found) = self.take_line(&line, wanted)
        {
            return Some(found);
        }
        self.dispatch(wanted)
    }

    fn take_line(&mut self, line: &[u8], wanted: &impl Fn(&Value) -> bool) -> Option<Value> {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            return self.dispatch(wanted);
        }
        let line = String::from_utf8_lossy(line);
        let (field, value) = match line.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (&*line, ""),
        };
        if field == "data" {
            self.data.push(value.to_owned());
        }
        None
    }

    fn dispatch(&mut self, wanted: &impl Fn(&Value) -> bool) -> Option<Value> {
        if self.data.is_empty() {
            return None;
        }
        let data = std::mem::take(&mut self.data).join("\n");
        serde_json::from_str::<Value>(&data).ok().filter(wanted)
    }
}

fn bearer(cred: &Credential) -> Option<&str> {
    match cred {
        Credential::Bearer { token } => Some(token),
        _ => None,
    }
}

impl McpClient {
    fn exchange<'a>(&'a self, ws: WorkspaceId, endpoint: &'a Url, token: &'a str) -> Exchange<'a> {
        Exchange {
            egress: &self.egress,
            ws,
            endpoint,
            token,
            deadline: Instant::now() + self.timeout,
            session: None,
        }
    }
}

#[async_trait]
impl ShopClient for McpClient {
    async fn list_tools(
        &self,
        ws: WorkspaceId,
        endpoint: &Url,
        cred: &Credential,
    ) -> Result<Vec<String>, ShopError> {
        let Some(token) = bearer(cred) else {
            return Err(ShopError::Auth);
        };
        let mut exchange = self.exchange(ws, endpoint, token);
        exchange.open().await?;
        let result = exchange.request(2, "tools/list", None).await.map_err(|e| {
            e.warn("tools/list");
            match e {
                StepError::Auth => ShopError::Auth,
                StepError::Status(s) if s >= 500 => ShopError::Unavailable,
                StepError::Status(s) => ShopError::Rejected {
                    code: Some(s.to_string()),
                },
                StepError::Rpc(code) => ShopError::Rejected { code },
                StepError::NotSent | StepError::Transport => ShopError::Unavailable,
                StepError::TooLarge | StepError::Unparsable => ShopError::Malformed,
            }
        })?;
        let Some(tools) = result.get("tools").and_then(Value::as_array) else {
            tracing::warn!(step = "tools/list", "the shop's tool list has no tools");
            return Err(ShopError::Malformed);
        };
        Ok(tools
            .iter()
            .filter_map(|t| t.get("name").and_then(Value::as_str))
            .map(str::to_owned)
            .collect())
    }

    async fn call_tool(
        &self,
        ws: WorkspaceId,
        endpoint: &Url,
        cred: &Credential,
        call: &ShopCall,
    ) -> Result<Value, ShopError> {
        let Some(token) = bearer(cred) else {
            return Err(ShopError::Auth);
        };
        let mut exchange = self.exchange(ws, endpoint, token);
        exchange.open().await?;
        let params = json!({"name": call.tool, "arguments": call.arguments});
        let result = exchange
            .request(2, "tools/call", Some(params))
            .await
            .map_err(|e| {
                e.warn("tools/call");
                match e {
                    StepError::Auth => ShopError::Auth,
                    // Once the call was sent, only the tool's own refusal (a JSON-RPC error; an
                    // `isError` result is an `Ok` the caller reads) says nothing was done: any
                    // other status (408, 409, 425, 429, another 4xx, a 3xx, a 5xx) may follow an
                    // order the shop made.
                    StepError::Rpc(code) => ShopError::Rejected { code },
                    StepError::NotSent => ShopError::Unavailable,
                    StepError::Status(_)
                    | StepError::Transport
                    | StepError::TooLarge
                    | StepError::Unparsable => ShopError::Unknown,
                }
            })?;
        if !result.is_object() {
            tracing::warn!(step = "tools/call", "the shop's result is not an object");
            return Err(ShopError::Unknown);
        }
        Ok(result)
    }
}

/// The endpoint and workspace a probe reaches, from the capability's public facts.
fn probe_target(public: &Value) -> Option<(String, Url, WorkspaceId)> {
    let raw = public.get("endpoint").and_then(Value::as_str)?;
    let url = Url::parse(raw).ok()?;
    let scheme_ok =
        url.scheme() == "https" || (jt_outbound::TEST_LOOPBACK_ENABLED && url.scheme() == "http");
    if !scheme_ok || url.host_str().is_none() {
        return None;
    }
    let ws = public
        .get("workspace_id")
        .and_then(Value::as_str)?
        .parse::<WorkspaceId>()
        .ok()?;
    Some((raw.to_owned(), url, ws))
}

fn probe_error(e: ShopError) -> ConnectorError {
    match e {
        ShopError::Auth => ConnectorError::auth("the shop refused the token"),
        ShopError::Rejected { code } => ConnectorError::permission(match code {
            Some(code) => format!("the shop refused the tool list ({code})"),
            None => "the shop refused the tool list".to_owned(),
        }),
        ShopError::Unavailable | ShopError::Unknown => {
            ConnectorError::transient("the shop could not be reached")
        }
        ShopError::Malformed => ConnectorError::permanent("the shop's answer is not an MCP answer"),
    }
}

#[async_trait]
impl Connector for McpClient {
    fn provider(&self) -> Provider {
        Provider::Mcp
    }

    fn hosts(&self) -> &'static [&'static str] {
        &[]
    }

    async fn probe(&self, cred: &Credential, public: &Value) -> ProbeResult {
        let started = Instant::now();
        let latency = || u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
        let Some((raw, endpoint, ws)) = probe_target(public) else {
            return ProbeResult::failure(
                latency(),
                ConnectorError::permanent("the shop's endpoint or workspace is missing or invalid"),
            );
        };
        let tool = public
            .get("order")
            .and_then(|o| o.get("tool"))
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_ORDER_TOOL);
        match self.list_tools(ws, &endpoint, cred).await {
            Ok(tools) if tools.iter().any(|t| t == tool) => {
                ProbeResult::success(latency(), json!({ "account_id": raw }))
            }
            Ok(_) => ProbeResult::failure(
                latency(),
                ConnectorError::permission("the shop does not list the order tool"),
            ),
            Err(e) => ProbeResult::failure(latency(), probe_error(e)),
        }
    }

    async fn refresh(&self, _cred: &Credential) -> Result<Option<Credential>, ConnectorError> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn any(_: &Value) -> bool {
        true
    }

    #[test]
    fn an_event_stream_joins_data_lines_and_skips_other_events() {
        let wanted = |v: &Value| v.get("id") == Some(&json!(2));
        let mut stream = EventStream::default();
        let text = ": comment\r\nevent: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"x\"}\r\n\r\n\
                    data: {\"jsonrpc\":\"2.0\",\ndata: \"id\":2,\"result\":{}}\n\n";
        let (a, b) = text.as_bytes().split_at(40);
        assert_eq!(stream.feed(a, &wanted), None);
        let found = stream.feed(b, &wanted).expect("the response");
        assert_eq!(found["result"], json!({}));
    }

    #[test]
    fn an_unterminated_last_event_counts() {
        let mut stream = EventStream::default();
        assert_eq!(stream.feed(b"data: {\"id\":1}", &any), None);
        assert_eq!(stream.finish(&any), Some(json!({"id": 1})));
    }

    #[test]
    fn debug_prints_no_egress() {
        let client = McpClient::new(Arc::new(Egress::new(&[])));
        assert_eq!(format!("{client:?}"), "McpClient { timeout: 15s, .. }");
    }
}
