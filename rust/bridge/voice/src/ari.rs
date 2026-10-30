//! The Asterisk REST Interface on loopback (design addendum §2): originate, external media over
//! `chan_websocket` (Asterisk's own HTTP server, the INCOMING mode: the bridge connects in), mixing
//! bridges, hangup, and the application's events. Errors never carry a URL, a query or a body,
//! and the credentials go in a header, never in a URL.

use std::time::Duration;

use base64::Engine as _;
use reqwest::Method;
use serde_json::Value;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;

/// The bridge's Stasis application.
pub const APP: &str = "jeeta-voice";

/// What went wrong with ARI: a kind, never the request.
#[derive(Debug, thiserror::Error)]
pub enum AriError {
    #[error("ARI answered {0}")]
    Status(u16),
    #[error("ARI unreachable")]
    Transport,
    #[error("ARI's answer is unreadable")]
    Decode,
    #[error("the ARI client could not be built")]
    Client,
}

/// A WebSocket to Asterisk: the application's events, or a call's media.
pub type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// An ARI event the bridge acts on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AriEvent {
    Ringing {
        channel: String,
    },
    /// The channel entered the application: an outbound call was answered, or an inbound one rang.
    Answered {
        channel: String,
        inbound: bool,
    },
    /// A key the caller pressed (`digit` is never logged).
    Dtmf {
        channel: String,
        digit: String,
    },
    Gone {
        channel: String,
        cause: Option<u32>,
    },
    Other,
}

/// Reads one event of the application's stream. A channel that enters the application without
/// `out` or `in` (the bridge's own media channel) is no call.
pub fn parse_event(text: &str) -> AriEvent {
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return AriEvent::Other;
    };
    let channel = v["channel"]["id"].as_str().unwrap_or_default().to_owned();
    match v["type"].as_str() {
        Some("StasisStart") => match v["args"].get(0).and_then(Value::as_str) {
            Some("out") => AriEvent::Answered {
                channel,
                inbound: false,
            },
            Some("in") => AriEvent::Answered {
                channel,
                inbound: true,
            },
            _ => AriEvent::Other,
        },
        Some("ChannelStateChange") if v["channel"]["state"] == "Ringing" => {
            AriEvent::Ringing { channel }
        }
        Some("ChannelDtmfReceived") => AriEvent::Dtmf {
            channel,
            digit: v["digit"].as_str().unwrap_or_default().to_owned(),
        },
        Some("ChannelDestroyed") => AriEvent::Gone {
            channel,
            cause: v["cause"].as_u64().and_then(|c| u32::try_from(c).ok()),
        },
        _ => AriEvent::Other,
    }
}

/// How long a REST request may take.
const REQUEST_WAIT: Duration = Duration::from_secs(5);
/// How long opening a WebSocket (events, media) may take, its handshake included: an Asterisk
/// that takes the connection and never answers is unreachable after this (B5 review).
pub const CONNECT_WAIT: Duration = Duration::from_secs(2);

/// ARI at `base` (`http://127.0.0.1:8188`), as one user.
pub struct Ari {
    http: reqwest::Client,
    base: String,
    /// Where the WebSocket endpoints (events, media) are: `base` as `ws://`, unless set apart.
    ws_base: String,
    user: String,
    password: String,
}

impl Ari {
    /// ARI at `base`. A client that cannot be built is an error, not a client without its
    /// request timeout (B5 review).
    pub fn new(base: &str, user: &str, password: &str) -> Result<Ari, AriError> {
        let http = reqwest::Client::builder()
            .timeout(REQUEST_WAIT)
            .build()
            .map_err(|_| AriError::Client)?;
        let base = base.trim_end_matches('/').to_owned();
        Ok(Ari {
            http,
            ws_base: base.replacen("http", "ws", 1),
            base,
            user: user.to_owned(),
            password: password.to_owned(),
        })
    }

    async fn call(
        &self,
        method: Method,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<Value, AriError> {
        let response = self
            .http
            .request(method, format!("{}/ari{path}", self.base))
            .basic_auth(&self.user, Some(&self.password))
            .query(query)
            .send()
            .await
            .map_err(|_| AriError::Transport)?;
        let status = response.status();
        if !status.is_success() {
            return Err(AriError::Status(status.as_u16()));
        }
        let text = response.text().await.map_err(|_| AriError::Transport)?;
        if text.trim().is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|_| AriError::Decode)
    }

    /// A channel or bridge that is already gone is what a hangup or a destroy wanted.
    fn gone_is_fine(r: Result<Value, AriError>) -> Result<(), AriError> {
        match r {
            Ok(_) | Err(AriError::Status(404)) => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Dials `endpoint` (`PJSIP/05…@netgsm`) as channel `channel_id`; it enters the application when
    /// answered.
    pub async fn originate(
        &self,
        channel_id: &str,
        endpoint: &str,
        timeout_s: u32,
    ) -> Result<(), AriError> {
        let timeout = timeout_s.to_string();
        self.call(
            Method::POST,
            "/channels",
            &[
                ("endpoint", endpoint),
                ("app", APP),
                ("appArgs", "out"),
                ("channelId", channel_id),
                ("timeout", &timeout),
            ],
        )
        .await
        .map(drop)
    }

    /// A media channel `channel_id` the bridge connects to over WebSocket, in `format`.
    pub async fn external_media(&self, channel_id: &str, format: &str) -> Result<(), AriError> {
        self.call(
            Method::POST,
            "/channels/externalMedia",
            &[
                ("app", APP),
                ("channelId", channel_id),
                ("external_host", "INCOMING"),
                ("transport", "websocket"),
                ("encapsulation", "none"),
                ("connection_type", "server"),
                ("format", format),
                ("transport_data", "f(json)"),
            ],
        )
        .await
        .map(drop)
    }

    /// The value of channel variable `name` on `channel`.
    pub async fn variable(&self, channel: &str, name: &str) -> Result<String, AriError> {
        let v = self
            .call(
                Method::GET,
                &format!("/channels/{channel}/variable"),
                &[("variable", name)],
            )
            .await?;
        v.get("value")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or(AriError::Decode)
    }

    /// A mixing bridge `bridge_id` holding `channels`.
    pub async fn mix(&self, bridge_id: &str, channels: &[&str]) -> Result<(), AriError> {
        self.call(
            Method::POST,
            "/bridges",
            &[("type", "mixing"), ("bridgeId", bridge_id)],
        )
        .await?;
        let list = channels.join(",");
        self.call(
            Method::POST,
            &format!("/bridges/{bridge_id}/addChannel"),
            &[("channel", &list)],
        )
        .await
        .map(drop)
    }

    /// Hangs `channel` up; one already gone is fine.
    pub async fn hangup(&self, channel: &str) -> Result<(), AriError> {
        Self::gone_is_fine(
            self.call(
                Method::DELETE,
                &format!("/channels/{channel}"),
                &[("reason", "normal")],
            )
            .await,
        )
    }

    /// Refuses a ringing channel as busy.
    pub async fn refuse(&self, channel: &str) -> Result<(), AriError> {
        Self::gone_is_fine(
            self.call(
                Method::DELETE,
                &format!("/channels/{channel}"),
                &[("reason", "busy")],
            )
            .await,
        )
    }

    /// Destroys mixing bridge `bridge_id`; one already gone is fine.
    pub async fn destroy_bridge(&self, bridge_id: &str) -> Result<(), AriError> {
        Self::gone_is_fine(
            self.call(Method::DELETE, &format!("/bridges/{bridge_id}"), &[])
                .await,
        )
    }

    /// Sends `channel` to `endpoint` (a transfer).
    pub async fn redirect(&self, channel: &str, endpoint: &str) -> Result<(), AriError> {
        self.call(
            Method::POST,
            &format!("/channels/{channel}/redirect"),
            &[("endpoint", endpoint)],
        )
        .await
        .map(drop)
    }

    /// The channels Asterisk has now.
    pub async fn channel_ids(&self) -> Result<Vec<String>, AriError> {
        let v = self.call(Method::GET, "/channels", &[]).await?;
        Ok(v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|c| c["id"].as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default())
    }

    /// Asterisk's version line (the `check` command).
    pub async fn info(&self) -> Result<String, AriError> {
        let v = self.call(Method::GET, "/asterisk/info", &[]).await?;
        Ok(v["system"]["version"].as_str().unwrap_or("?").to_owned())
    }

    /// The same ARI with its WebSocket endpoints (events, media) at `ws_base` (`ws://host:port`).
    pub fn with_ws_base(mut self, ws_base: &str) -> Ari {
        self.ws_base = ws_base.trim_end_matches('/').to_owned();
        self
    }

    fn ws_base(&self) -> String {
        self.ws_base.clone()
    }

    async fn connect(&self, url: String) -> Result<Socket, AriError> {
        let mut request = url.into_client_request().map_err(|_| AriError::Transport)?;
        let token = base64::engine::general_purpose::STANDARD
            .encode(format!("{}:{}", self.user, self.password));
        let mut header =
            HeaderValue::from_str(&format!("Basic {token}")).map_err(|_| AriError::Transport)?;
        header.set_sensitive(true);
        request.headers_mut().insert("Authorization", header);
        match tokio::time::timeout(CONNECT_WAIT, tokio_tungstenite::connect_async(request)).await {
            Ok(Ok((socket, _))) => Ok(socket),
            Ok(Err(_)) | Err(_) => Err(AriError::Transport),
        }
    }

    /// The application's event stream.
    pub async fn events(&self) -> Result<Socket, AriError> {
        self.connect(format!(
            "{}/ari/events?app={APP}&subscribeAll=false",
            self.ws_base()
        ))
        .await
    }

    /// The media of an external media channel, by its `MEDIA_WEBSOCKET_CONNECTION_ID`.
    pub async fn media(&self, connection_id: &str) -> Result<Socket, AriError> {
        self.connect(format!("{}/media/{connection_id}", self.ws_base()))
            .await
    }
}
