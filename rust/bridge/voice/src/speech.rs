//! The two local speech services (design addendum §6): where they listen (a unix socket in
//! production, TCP loopback in tests) and their messages. `Heard`'s `Debug` never prints a word.

use std::path::PathBuf;
use std::pin::Pin;
use std::str::FromStr;

use jt_calls::EndpointBy;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_tungstenite::WebSocketStream;

/// Where a speech service listens: `unix:/path` or `tcp:host:port`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Endpoint {
    Unix(PathBuf),
    Tcp(String),
}

impl FromStr for Endpoint {
    type Err = ();
    fn from_str(s: &str) -> Result<Endpoint, ()> {
        if let Some(path) = s.strip_prefix("unix:") {
            return Ok(Endpoint::Unix(path.into()));
        }
        if let Some(addr) = s.strip_prefix("tcp:") {
            return Ok(Endpoint::Tcp(addr.to_owned()));
        }
        Err(())
    }
}

/// A byte stream a WebSocket runs over: a unix or a TCP socket.
pub trait Stream: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Stream for T {}

/// A WebSocket to a speech service.
pub type Socket = WebSocketStream<Pin<Box<dyn Stream>>>;

#[derive(Debug, thiserror::Error)]
pub enum SpeechError {
    #[error("the speech service is unreachable")]
    Unreachable,
    #[error("unix sockets are not available on this system")]
    Unsupported,
    #[error("the speak service did not say hello")]
    NoHello,
    #[error("the speech service's socket is held by another user")]
    WrongPeer,
}

/// The users the speech services run as (B3 uid 1501, B2 uid 1502). A unix socket whose peer is
/// another user is refused: a service that took the other's socket name is never talked to (the
/// B3 review, I4; listen also sits in a directory of its own that speak cannot write).
pub const LISTEN_UID: u32 = 1501;
pub const SPEAK_UID: u32 = 1502;

/// A WebSocket to the service at `endpoint`; on a unix socket its peer must run as `owner`.
pub async fn connect(endpoint: &Endpoint, owner: u32) -> Result<Socket, SpeechError> {
    let stream: Pin<Box<dyn Stream>> = match endpoint {
        Endpoint::Tcp(addr) => {
            let _ = owner; // loopback TCP is for tests only; it carries no peer credential
            Box::pin(
                tokio::net::TcpStream::connect(addr)
                    .await
                    .map_err(|_| SpeechError::Unreachable)?,
            )
        }
        #[cfg(unix)]
        Endpoint::Unix(path) => {
            let s = tokio::net::UnixStream::connect(path)
                .await
                .map_err(|_| SpeechError::Unreachable)?;
            if s.peer_cred().map(|c| c.uid()).ok() != Some(owner) {
                return Err(SpeechError::WrongPeer);
            }
            Box::pin(s)
        }
        #[cfg(not(unix))]
        Endpoint::Unix(_) => return Err(SpeechError::Unsupported),
    };
    tokio_tungstenite::client_async("ws://localhost/", stream)
        .await
        .map(|(s, _)| s)
        .map_err(|_| SpeechError::Unreachable)
}

/// How long the speak service may take to send its `hello`.
const HELLO_WAIT: std::time::Duration = std::time::Duration::from_secs(2);

/// A WebSocket to the speak service and the voice id of its `hello`.
pub async fn connect_speaker(endpoint: &Endpoint) -> Result<(Socket, String), SpeechError> {
    use futures_util::StreamExt;
    use tokio_tungstenite::tungstenite::Message;

    let mut socket = connect(endpoint, SPEAK_UID).await?;
    match tokio::time::timeout(HELLO_WAIT, socket.next()).await {
        Ok(Some(Ok(Message::Text(t)))) => match serde_json::from_str::<Spoken>(&t) {
            Ok(Spoken::Hello { voice_id }) => Ok((socket, voice_id)),
            _ => Err(SpeechError::NoHello),
        },
        _ => Err(SpeechError::NoHello),
    }
}

/// What the listener heard. Positions (`audio_ms`, `speech_end_ms`, `endpoint_ms`) are audio
/// time since the call's `start`, which [`crate::trace::AudioClock`] maps to the bridge's clock.
#[derive(Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Heard {
    SpeechStart {
        audio_ms: u64,
    },
    SpeechEnd {
        audio_ms: u64,
    },
    Resume {
        audio_ms: u64,
    },
    Partial {
        text: String,
    },
    Final {
        text: String,
        #[serde(default)]
        confidence: Option<f32>,
        speech_end_ms: u64,
        endpoint_ms: u64,
        endpoint_by: EndpointBy,
        stt_ms: u32,
    },
    Unheard {
        audio_ms: u64,
    },
}

impl std::fmt::Debug for Heard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Heard::SpeechStart { audio_ms } => write!(f, "SpeechStart({audio_ms})"),
            Heard::SpeechEnd { audio_ms } => write!(f, "SpeechEnd({audio_ms})"),
            Heard::Resume { audio_ms } => write!(f, "Resume({audio_ms})"),
            Heard::Partial { .. } => write!(f, "Partial"),
            Heard::Final {
                endpoint_ms,
                endpoint_by,
                ..
            } => {
                write!(f, "Final(endpoint_ms: {endpoint_ms}, by: {endpoint_by:?})")
            }
            Heard::Unheard { audio_ms } => write!(f, "Unheard({audio_ms})"),
        }
    }
}

/// To the listener.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToListener {
    Start {
        sample_rate: u32,
        hotwords: Vec<String>,
    },
    Playback {
        active: bool,
    },
}

/// To the speaker.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ToSpeaker {
    Synth { id: String, text: String },
    Cancel { id: String },
}

/// From the speaker (besides the binary PCM16 chunks). Every frame of a synthesis comes before its
/// terminal message (`done`, `cancelled` or `error`), and a synthesis starts only after the previous
/// one's: after a cancel the client drops frames until that id's terminal message, whichever it is
/// (a cancel can lose the race to `done`).
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Spoken {
    /// The first message on every connection: the voice id keys the phrase cache.
    Hello {
        voice_id: String,
    },
    Done {
        id: String,
        synth_ms: u32,
        audio_ms: u32,
    },
    Cancelled {
        id: String,
    },
    Error {
        #[serde(default)]
        id: Option<String>,
        reason: String,
    },
}
