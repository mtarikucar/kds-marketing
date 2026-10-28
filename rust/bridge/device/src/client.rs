//! The bridge's HTTP client to Jeeta: the four bridge routes of spec §5.4 under the bridge key,
//! and the signed download of a `push_file` command's file.
//!
//! - Every route call carries the key as a bearer token, in a header marked sensitive. A signed
//!   download carries no key: the address is its own authority, and it may lead off the server.
//! - The routes are not redirected: a redirect is a wrong `base_url`, reported as its status.
//! - A [`ClientError`] never shows a request's URL (`reqwest::Error::without_url`, since a
//!   download's URL is signed) nor any part of an answer's body: an error answer can echo the
//!   request. A refusal (422) is read for the name of the field it refuses, nothing else.

use std::fmt;
use std::path::Path;
use std::time::Duration;

use async_trait::async_trait;
use jt_device_protocol::{
    CommandsQuery, FailReason, FileOut, RegisterIn, RegisterOut, ResultsIn, ResultsOut,
};
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE, HeaderValue};
use reqwest::{Response, StatusCode, Url, redirect};
use serde::de::DeserializeOwned;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::config::Config;
use crate::driver::{DriverError, FileTransfer};

/// The register route, under the base URL.
pub const REGISTER_PATH: &str = "api/devices/bridge/register";
/// The command poll route.
pub const COMMANDS_PATH: &str = "api/devices/bridge/commands";
/// The results route.
pub const RESULTS_PATH: &str = "api/devices/bridge/results";
/// The file upload route.
pub const FILES_PATH: &str = "api/devices/bridge/files";

/// How long a connection may take to open.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// How long a register or a results post may take.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
/// How much longer than the wait it asked for a poll may take.
const POLL_MARGIN: Duration = Duration::from_secs(15);
/// How long an upload or a download may take.
const TRANSFER_TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// The most bytes of a refusal read to find the field it names.
const MAX_REFUSAL_BYTES: usize = 64 * 1024;

/// A call to Jeeta that did not give what it should.
#[derive(Debug)]
pub enum ClientError {
    /// No answer: connecting, TLS, a timeout, or reading the answer failed. Holds the error
    /// without its URL.
    Transport(reqwest::Error),
    /// An answer whose status is not a success. `field` is the field a refusal (422) names, when
    /// it names one that reads as a field name.
    Status { status: u16, field: Option<String> },
    /// An answer whose body is not the one the route gives.
    Body,
    /// A download address that is not an `http` or `https` URL.
    Address,
    /// Writing a downloaded file failed.
    File(std::io::Error),
}

impl ClientError {
    /// Whether the same request may succeed later: no answer at all, a server error (5xx), or a
    /// request timeout or rate limit (408, 429).
    pub fn is_transient(&self) -> bool {
        match self {
            ClientError::Transport(_) => true,
            ClientError::Status { status, .. } => {
                *status >= 500 || *status == 408 || *status == 429
            }
            _ => false,
        }
    }

    /// Whether the server refused the body itself (422, or 413 for its size): sending the same
    /// body again is refused again.
    pub fn is_refused(&self) -> bool {
        matches!(
            self,
            ClientError::Status {
                status: 413 | 422,
                ..
            }
        )
    }

    /// The field a refusal names.
    pub fn field(&self) -> Option<&str> {
        match self {
            ClientError::Status { field, .. } => field.as_deref(),
            _ => None,
        }
    }
}

impl From<reqwest::Error> for ClientError {
    fn from(error: reqwest::Error) -> ClientError {
        ClientError::Transport(error.without_url())
    }
}

impl fmt::Display for ClientError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ClientError::Transport(error) => {
                // The causes say what failed (refused, reset, TLS); none of them carries the URL.
                write!(f, "{error}")?;
                let mut cause = std::error::Error::source(error);
                while let Some(next) = cause {
                    write!(f, ": {next}")?;
                    cause = next.source();
                }
                Ok(())
            }
            ClientError::Status {
                status,
                field: Some(field),
            } => write!(f, "the server answered {status}, refusing `{field}`"),
            ClientError::Status {
                status,
                field: None,
            } => write!(f, "the server answered {status}"),
            ClientError::Body => f.write_str("the server's answer is not the body the route gives"),
            ClientError::Address => f.write_str("the download address is not an http(s) URL"),
            ClientError::File(error) => write!(f, "writing the downloaded file failed: {error}"),
        }
    }
}

impl std::error::Error for ClientError {}

/// The bridge's client for one Jeeta server and one key.
#[derive(Clone)]
pub struct JeetaClient {
    /// For the routes: no redirects.
    api: reqwest::Client,
    /// For signed downloads: redirects followed, no key.
    downloads: reqwest::Client,
    base: Url,
    authorization: HeaderValue,
}

impl JeetaClient {
    /// A client for the server and key of `config`.
    pub fn new(config: &Config) -> Result<JeetaClient, ClientError> {
        let user_agent = concat!("jeeta-device-bridge/", env!("CARGO_PKG_VERSION"));
        let api = reqwest::Client::builder()
            .user_agent(user_agent)
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(redirect::Policy::none())
            .build()?;
        let downloads = reqwest::Client::builder()
            .user_agent(user_agent)
            .connect_timeout(CONNECT_TIMEOUT)
            .redirect(redirect::Policy::limited(5))
            .build()?;
        let mut authorization = HeaderValue::from_str(&format!("Bearer {}", config.key.expose()))
            .expect("a key is printable ASCII (`Config::parse`), which a header carries as it is");
        authorization.set_sensitive(true);
        Ok(JeetaClient {
            api,
            downloads,
            base: config.base_url.clone(),
            authorization,
        })
    }

    fn route(&self, path: &str) -> Url {
        // `base` ends in `/` and `path` is relative, so this always joins under it.
        self.base
            .join(path)
            .expect("a relative route joins the base")
    }

    /// Says the bridge is alive, with the phones it sees.
    pub async fn register(&self, body: &RegisterIn) -> Result<RegisterOut, ClientError> {
        let response = self
            .api
            .post(self.route(REGISTER_PATH))
            .header(AUTHORIZATION, self.authorization.clone())
            .timeout(CALL_TIMEOUT)
            .json(body)
            .send()
            .await?;
        json(response).await
    }

    /// Polls for commands, waiting up to `query.wait_s` seconds when nothing is queued. Answers
    /// the body as JSON, for `CommandsOut::decode_lenient`.
    pub async fn commands(&self, query: &CommandsQuery) -> Result<serde_json::Value, ClientError> {
        let response = self
            .api
            .get(self.route(COMMANDS_PATH))
            .header(AUTHORIZATION, self.authorization.clone())
            .timeout(Duration::from_secs(query.wait_s.into()) + POLL_MARGIN)
            .query(query)
            .send()
            .await?;
        json(response).await
    }

    /// Posts a batch of results.
    pub async fn results(&self, body: &ResultsIn) -> Result<ResultsOut, ClientError> {
        let response = self
            .api
            .post(self.route(RESULTS_PATH))
            .header(AUTHORIZATION, self.authorization.clone())
            .timeout(CALL_TIMEOUT)
            .json(body)
            .send()
            .await?;
        json(response).await
    }

    /// Uploads `bytes` as a Jeeta file of type `content_type`.
    pub async fn upload(&self, bytes: Vec<u8>, content_type: &str) -> Result<FileOut, ClientError> {
        let response = self
            .api
            .post(self.route(FILES_PATH))
            .header(AUTHORIZATION, self.authorization.clone())
            .header(CONTENT_TYPE, content_type)
            .timeout(TRANSFER_TIMEOUT)
            .body(bytes)
            .send()
            .await?;
        json(response).await
    }

    /// Downloads the signed address `url` into the file `dest`, without the key, and answers how
    /// many bytes were written. A partly written file is removed.
    pub async fn download(&self, url: &str, dest: &Path) -> Result<u64, ClientError> {
        let url = Url::parse(url).map_err(|_| ClientError::Address)?;
        if !matches!(url.scheme(), "http" | "https") {
            return Err(ClientError::Address);
        }
        let mut response = self
            .downloads
            .get(url)
            .timeout(TRANSFER_TIMEOUT)
            .send()
            .await?;
        if !response.status().is_success() {
            return Err(ClientError::Status {
                status: response.status().as_u16(),
                field: None,
            });
        }
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(ClientError::File)?;
        let mut written = 0u64;
        let copied: Result<(), ClientError> = async {
            while let Some(chunk) = response.chunk().await? {
                file.write_all(&chunk).await.map_err(ClientError::File)?;
                written += chunk.len() as u64;
            }
            file.flush().await.map_err(ClientError::File)
        }
        .await;
        if let Err(error) = copied {
            drop(file);
            let _ = tokio::fs::remove_file(dest).await;
            return Err(error);
        }
        Ok(written)
    }

    /// The file transfer of one command, holding its signed download address if it has one.
    pub fn files(&self, download_url: Option<String>) -> CommandFiles {
        CommandFiles {
            client: self.clone(),
            download_url,
        }
    }
}

/// A success decoded as `T`; any other status as [`ClientError::Status`].
async fn json<T: DeserializeOwned>(response: Response) -> Result<T, ClientError> {
    let status = response.status();
    if !status.is_success() {
        let field = if status == StatusCode::UNPROCESSABLE_ENTITY {
            refused_field(response).await
        } else {
            None
        };
        return Err(ClientError::Status {
            status: status.as_u16(),
            field,
        });
    }
    let bytes = response.bytes().await?;
    serde_json::from_slice(&bytes).map_err(|_| ClientError::Body)
}

/// The field a refusal names in `details.field` (the server's error shape), when it reads as a
/// field name (`[a-z0-9_.]`, at most 64 characters): nothing else of the body is kept.
async fn refused_field(mut response: Response) -> Option<String> {
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_REFUSAL_BYTES {
            return None;
        }
    }
    let value: serde_json::Value = serde_json::from_slice(&body).ok()?;
    let field = value.get("details")?.get("field")?.as_str()?;
    let plain = !field.is_empty()
        && field.len() <= 64
        && field
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.');
    plain.then(|| field.to_owned())
}

/// The [`FileTransfer`] the loop hands one command.
pub struct CommandFiles {
    client: JeetaClient,
    download_url: Option<String>,
}

#[async_trait]
impl FileTransfer for CommandFiles {
    async fn upload(&self, bytes: Vec<u8>, content_type: &str) -> Result<Uuid, DriverError> {
        match self.client.upload(bytes, content_type).await {
            Ok(file) => Ok(file.file_id),
            Err(error) => Err(DriverError::new(
                FailReason::BridgeError,
                format!("uploading the file to Jeeta failed: {error}"),
            )),
        }
    }

    async fn download(&self, dest: &Path) -> Result<u64, DriverError> {
        let Some(url) = &self.download_url else {
            return Err(DriverError::new(
                FailReason::BridgeError,
                "the server sent no download address for this command",
            ));
        };
        self.client.download(url, dest).await.map_err(|error| {
            DriverError::new(
                FailReason::BridgeError,
                format!("downloading the file failed: {error}"),
            )
        })
    }
}
