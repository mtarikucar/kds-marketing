//! The bridge's HTTP client to Jeeta (`/api/voice/bridge/*`, `docs/operations/voice-bridge.md` §3):
//! the bearer key on every request, `X-Requested-With: jeeta-panel` on the posts (the API's
//! request-header check), the bodies of `jt_calls::wire`. On the host it calls the core on
//! loopback (`JEETA_BASE_URL=http://127.0.0.1:809x`). Errors never carry the address, the key or a
//! body.

use std::time::Duration;

use jt_calls::wire::{
    CommandsOut, CommandsQuery, EventsInput, EventsOut, RegisterInput, RegisterOut,
};
use serde::de::DeserializeOwned;

/// The request header the API's posts must carry.
pub const REQUESTED_WITH: &str = "jeeta-panel";
/// A register or an events post, which the core answers at once: a wedged core is noticed within
/// seconds, so the live calls hear of its loss in time (review of D, M3).
const QUICK: Duration = Duration::from_secs(3);
/// The command long-poll: its 25 s, and room for the core's answer.
const LONG_POLL: Duration = Duration::from_secs(40);

/// Why a request to Jeeta failed: its status, or a kind; never the address.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("Jeeta answered {0}")]
    Status(u16),
    #[error("Jeeta is unreachable")]
    Transport,
    #[error("Jeeta's answer is unreadable")]
    Decode,
    #[error("the HTTP client could not be built")]
    Client,
}

impl ClientError {
    /// Whether the same request may succeed later (the core is down, busy or throttling).
    pub fn retryable(&self) -> bool {
        match self {
            ClientError::Status(s) => *s == 408 || *s == 429 || *s >= 500,
            ClientError::Transport | ClientError::Decode => true,
            ClientError::Client => false,
        }
    }
}

/// Jeeta's voice bridge routes, with the bridge's key. `Debug` is not derived: it holds the key.
pub struct JeetaClient {
    http: reqwest::Client,
    base: String,
    key: String,
}

impl JeetaClient {
    /// The client of the core at `base`, with `key`. A client that cannot be built is an error,
    /// not a client without its timeouts.
    pub fn new(base: &str, key: &str) -> Result<JeetaClient, ClientError> {
        Ok(JeetaClient {
            http: reqwest::Client::builder()
                .connect_timeout(QUICK)
                .build()
                .map_err(|_| ClientError::Client)?,
            base: base.trim_end_matches('/').to_owned(),
            key: key.to_owned(),
        })
    }

    async fn send<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, ClientError> {
        let response = request
            .bearer_auth(&self.key)
            .send()
            .await
            .map_err(|_| ClientError::Transport)?;
        let status = response.status();
        if !status.is_success() {
            return Err(ClientError::Status(status.as_u16()));
        }
        response.json::<T>().await.map_err(|_| ClientError::Decode)
    }

    /// `POST /api/voice/bridge/register`: the heartbeat.
    pub async fn register(&self, body: &RegisterInput) -> Result<RegisterOut, ClientError> {
        let url = format!("{}/api/voice/bridge/register", self.base);
        self.send(
            self.http
                .post(url)
                .timeout(QUICK)
                .header("X-Requested-With", REQUESTED_WITH)
                .json(body),
        )
        .await
    }

    /// `GET /api/voice/bridge/commands`: the long-poll for the line's commands.
    pub async fn commands(&self, query: &CommandsQuery) -> Result<CommandsOut, ClientError> {
        let url = format!("{}/api/voice/bridge/commands", self.base);
        self.send(self.http.get(url).timeout(LONG_POLL).query(query))
            .await
    }

    /// `POST /api/voice/bridge/events`: what the line's calls reported.
    pub async fn events(&self, body: &EventsInput) -> Result<EventsOut, ClientError> {
        let url = format!("{}/api/voice/bridge/events", self.base);
        self.send(
            self.http
                .post(url)
                .timeout(QUICK)
                .header("X-Requested-With", REQUESTED_WITH)
                .json(body),
        )
        .await
    }
}
