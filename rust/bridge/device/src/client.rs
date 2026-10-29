//! The bridge's HTTP client to Jeeta: the four bridge routes of spec §5.4 under the bridge key,
//! and the signed download of a `push_file` command's file.
//!
//! - Every route call carries the key as a bearer token, in a header marked sensitive. A signed
//!   download carries no key: the address is its own authority, and it may lead off the server.
//! - Every `POST` also carries [`REQUESTED_WITH_HEADER`]`: `[`REQUESTED_WITH_VALUE`]: the API
//!   refuses a mutating request without it (403, before the key is even read), against
//!   cross-site request forgery.
//! - The routes are not redirected: a redirect is a wrong `base_url`, reported as its status. A
//!   download follows up to 5 redirects, never from `https` to plain `http`, and plain `http` at
//!   all only to this computer.
//! - A [`ClientError`] never shows a request's URL (`reqwest::Error::without_url`, since a
//!   download's URL is signed) nor any part of an answer's body: an error answer can echo the
//!   request. A refusal (422) is read for the name of the field it refuses, and an answer that
//!   does not decode is reported by the field the decoder names, nothing else.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use jt_device_protocol::{
    CommandsQuery, FailReason, FileOut, RegisterIn, RegisterOut, ResultsIn, ResultsOut,
};
use reqwest::header::{AUTHORIZATION, CONTENT_LENGTH, CONTENT_TYPE, HeaderValue};
use reqwest::{Response, StatusCode, Url, redirect};
use serde::de::DeserializeOwned;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::config::{Config, is_loopback};
use crate::driver::{ContentType, DriverError, FileTransfer};

/// The register route, under the base URL.
pub const REGISTER_PATH: &str = "api/devices/bridge/register";
/// The command poll route.
pub const COMMANDS_PATH: &str = "api/devices/bridge/commands";
/// The results route.
pub const RESULTS_PATH: &str = "api/devices/bridge/results";
/// The file upload route.
pub const FILES_PATH: &str = "api/devices/bridge/files";
/// The header every mutating request to the API carries (`jt_panel_http::csrf`).
pub const REQUESTED_WITH_HEADER: &str = "x-requested-with";
/// Its only accepted value.
pub const REQUESTED_WITH_VALUE: &str = "jeeta-panel";
/// The most bytes a download may bring: 256 MiB, above the largest file Jeeta stores (studio's
/// 200 MB video limit). Checked against the announced length and against what arrives.
pub const MAX_DOWNLOAD_BYTES: u64 = 256 * 1024 * 1024;

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
/// The most redirects a download follows.
const MAX_REDIRECTS: usize = 5;

/// A call to Jeeta that did not give what it should.
#[derive(Debug)]
pub enum ClientError {
    /// No answer: connecting, TLS, a timeout, or reading the answer failed. Holds the error
    /// without its URL.
    Transport(reqwest::Error),
    /// An answer whose status is not a success. `field` is the field a refusal (422) names, when
    /// it names one that reads as a field name.
    Status { status: u16, field: Option<String> },
    /// An answer whose body is not the one the route gives. `field` is the field the decoder
    /// names (an unknown or a missing one), when it names one.
    Body { field: Option<String> },
    /// A download address that is not `https` (or plain `http` to this computer).
    Address,
    /// A download larger than [`MAX_DOWNLOAD_BYTES`].
    TooLarge,
    /// Reading the file to upload, or writing the downloaded file, failed.
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

    /// The field a refusal, or an answer that does not decode, names.
    pub fn field(&self) -> Option<&str> {
        match self {
            ClientError::Status { field, .. } | ClientError::Body { field } => field.as_deref(),
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
            ClientError::Body { field: Some(field) } => write!(
                f,
                "the server's answer is not the body the route gives (field `{field}`)"
            ),
            ClientError::Body { field: None } => {
                f.write_str("the server's answer is not the body the route gives")
            }
            ClientError::Address => {
                f.write_str("the download address is not https (plain http only to this computer)")
            }
            ClientError::TooLarge => write!(
                f,
                "the download is larger than the {MAX_DOWNLOAD_BYTES} bytes the bridge takes"
            ),
            ClientError::File(error) => write!(f, "reading or writing the file failed: {error}"),
        }
    }
}

impl std::error::Error for ClientError {}

/// Whether a download may go to `url`: `https`, or plain `http` to this computer.
fn download_address(url: &Url) -> bool {
    match url.scheme() {
        "https" => true,
        "http" => is_loopback(url),
        _ => false,
    }
}

/// Whether a download may be redirected from `from` to `to`: to an address a download may go
/// to, and never from `https` down to plain `http`.
fn redirect_allowed(from: &Url, to: &Url) -> bool {
    download_address(to) && !(from.scheme() == "https" && to.scheme() == "http")
}

/// The bridge's client for one Jeeta server and one key.
#[derive(Clone)]
pub struct JeetaClient {
    /// For the routes: no redirects.
    api: reqwest::Client,
    /// For signed downloads: a few redirects, as [`redirect_allowed`] allows; no key.
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
            .redirect(redirect::Policy::custom(|attempt| {
                let from = attempt.previous().last().cloned();
                if attempt.previous().len() > MAX_REDIRECTS {
                    attempt.error("too many redirects")
                } else if from.is_some_and(|from| !redirect_allowed(&from, attempt.url())) {
                    attempt.error("a redirect to an address a download may not go to")
                } else {
                    attempt.follow()
                }
            }))
            .build()?;
        let mut authorization = HeaderValue::from_str(&format!("Bearer {}", config.key().expose()))
            .expect("a key is printable ASCII (`Config::parse`), which a header carries as it is");
        authorization.set_sensitive(true);
        Ok(JeetaClient {
            api,
            downloads,
            base: config.base_url().clone(),
            authorization,
        })
    }

    fn route(&self, path: &str) -> Url {
        // `base` ends in `/` and `path` is relative, so this always joins under it.
        self.base
            .join(path)
            .expect("a relative route joins the base")
    }

    /// A `POST` to the route `path`, with the key and the request header every mutating call
    /// carries.
    fn post(&self, path: &str) -> reqwest::RequestBuilder {
        self.api
            .post(self.route(path))
            .header(AUTHORIZATION, self.authorization.clone())
            .header(REQUESTED_WITH_HEADER, REQUESTED_WITH_VALUE)
    }

    /// Says the bridge is alive, with the phones it sees.
    pub async fn register(&self, body: &RegisterIn) -> Result<RegisterOut, ClientError> {
        let response = self
            .post(REGISTER_PATH)
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
            .post(RESULTS_PATH)
            .timeout(CALL_TIMEOUT)
            .json(body)
            .send()
            .await?;
        json(response).await
    }

    /// Uploads `bytes` as a Jeeta file of type `content_type`.
    pub async fn upload(
        &self,
        bytes: Vec<u8>,
        content_type: ContentType,
    ) -> Result<FileOut, ClientError> {
        let response = self
            .post(FILES_PATH)
            .header(CONTENT_TYPE, content_type.mime())
            .timeout(TRANSFER_TIMEOUT)
            .body(bytes)
            .send()
            .await?;
        json(response).await
    }

    /// Uploads the file at `path` as a Jeeta file of type `content_type`, streaming it.
    pub async fn upload_file(
        &self,
        path: &Path,
        content_type: ContentType,
    ) -> Result<FileOut, ClientError> {
        let file = tokio::fs::File::open(path)
            .await
            .map_err(ClientError::File)?;
        let length = file.metadata().await.map_err(ClientError::File)?.len();
        let response = self
            .post(FILES_PATH)
            .header(CONTENT_TYPE, content_type.mime())
            .header(CONTENT_LENGTH, length)
            .timeout(TRANSFER_TIMEOUT)
            .body(reqwest::Body::from(file))
            .send()
            .await?;
        json(response).await
    }

    /// Downloads the signed address `url` into the file `dest`, without the key, and answers how
    /// many bytes were written: at most [`MAX_DOWNLOAD_BYTES`].
    pub async fn download(&self, url: &str, dest: &Path) -> Result<u64, ClientError> {
        self.download_at_most(url, dest, MAX_DOWNLOAD_BYTES).await
    }

    /// [`JeetaClient::download`] with a cap of `cap` bytes. The file is removed when the download
    /// fails, and when its future is dropped part way.
    async fn download_at_most(&self, url: &str, dest: &Path, cap: u64) -> Result<u64, ClientError> {
        let url = Url::parse(url).map_err(|_| ClientError::Address)?;
        if !download_address(&url) {
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
        if response.content_length().is_some_and(|length| length > cap) {
            return Err(ClientError::TooLarge);
        }
        // Declared before the file, so the file is closed first when both are dropped.
        let mut partial = PartialFile {
            path: dest.to_owned(),
            done: false,
        };
        let mut file = tokio::fs::File::create(dest)
            .await
            .map_err(ClientError::File)?;
        let mut written = 0u64;
        while let Some(chunk) = response.chunk().await? {
            written += chunk.len() as u64;
            if written > cap {
                return Err(ClientError::TooLarge);
            }
            file.write_all(&chunk).await.map_err(ClientError::File)?;
        }
        file.flush().await.map_err(ClientError::File)?;
        partial.done = true;
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

/// A file being downloaded: removed when dropped before it is done (the download failed, or its
/// future was dropped part way).
struct PartialFile {
    path: PathBuf,
    done: bool,
}

impl Drop for PartialFile {
    fn drop(&mut self) {
        if !self.done {
            let _ = std::fs::remove_file(&self.path);
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
    serde_json::from_slice(&bytes).map_err(|error| ClientError::Body {
        field: decoded_field(&error.to_string()),
    })
}

/// `field` when it reads as a field name (`[a-z0-9_.]`, at most 64 characters).
fn plain_field(field: &str) -> Option<String> {
    let plain = !field.is_empty()
        && field.len() <= 64
        && field
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'.');
    plain.then(|| field.to_owned())
}

/// The field a decoding error names, for an unknown or a missing field: the decoder's message
/// can quote a value of the answer, so nothing else of it is kept.
fn decoded_field(message: &str) -> Option<String> {
    ["unknown field `", "missing field `"]
        .iter()
        .find_map(|lead| message.split_once(lead))
        .and_then(|(_, rest)| rest.split_once('`'))
        .and_then(|(field, _)| plain_field(field))
}

/// The field a refusal names in `details.field` (the server's error shape), when it reads as a
/// field name: nothing else of the body is kept.
async fn refused_field(mut response: Response) -> Option<String> {
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_REFUSAL_BYTES {
            return None;
        }
    }
    let value: serde_json::Value = serde_json::from_slice(&body).ok()?;
    plain_field(value.get("details")?.get("field")?.as_str()?)
}

/// The [`FileTransfer`] the loop hands one command.
pub struct CommandFiles {
    client: JeetaClient,
    download_url: Option<String>,
}

fn upload_failed(error: ClientError) -> DriverError {
    DriverError::new(
        FailReason::BridgeError,
        format!("uploading the file to Jeeta failed: {error}"),
    )
}

#[async_trait]
impl FileTransfer for CommandFiles {
    async fn upload(&self, bytes: Vec<u8>, content_type: ContentType) -> Result<Uuid, DriverError> {
        self.client
            .upload(bytes, content_type)
            .await
            .map(|file| file.file_id)
            .map_err(upload_failed)
    }

    async fn upload_file(
        &self,
        path: &Path,
        content_type: ContentType,
    ) -> Result<Uuid, DriverError> {
        self.client
            .upload_file(path, content_type)
            .await
            .map(|file| file.file_id)
            .map_err(upload_failed)
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

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use tokio::io::AsyncReadExt;
    use tokio::net::TcpListener;

    use super::*;

    fn client() -> JeetaClient {
        let config = Config::parse(
            "base_url = \"http://127.0.0.1:9\"\nkey = \"jk_unit\"\n",
            |_| None,
        )
        .unwrap();
        JeetaClient::new(&config).unwrap()
    }

    fn url(text: &str) -> Url {
        Url::parse(text).unwrap()
    }

    #[test]
    fn a_download_goes_to_https_or_to_this_computer() {
        assert!(download_address(&url("https://files.example/x?sig=1")));
        assert!(download_address(&url("http://127.0.0.1:8/x")));
        assert!(download_address(&url("http://localhost/x")));
        assert!(!download_address(&url("http://files.example/x")));
        assert!(!download_address(&url("ftp://files.example/x")));
        // Redirects: never from https down to http, even to this computer.
        let https = url("https://files.example/a");
        assert!(redirect_allowed(&https, &url("https://cdn.example/b")));
        assert!(!redirect_allowed(&https, &url("http://cdn.example/b")));
        assert!(!redirect_allowed(&https, &url("http://127.0.0.1/b")));
        assert!(redirect_allowed(
            &url("http://127.0.0.1/a"),
            &url("http://127.0.0.1/b")
        ));
        assert!(!redirect_allowed(
            &url("http://127.0.0.1/a"),
            &url("http://cdn.example/b")
        ));
    }

    #[tokio::test]
    async fn a_plain_http_download_elsewhere_is_refused_before_any_request() {
        let dest = std::env::temp_dir().join(format!("jdb-unit-{}", Uuid::now_v7()));
        let refused = client()
            .download("http://files.example/x?sig=SECRET", &dest)
            .await;
        assert!(matches!(refused, Err(ClientError::Address)), "{refused:?}");
        assert!(!dest.exists());
    }

    #[test]
    fn a_decoding_error_is_kept_by_its_field_only() {
        let unknown = serde_json::from_str::<RegisterOut>(
            r#"{"phones":[],"heartbeat_s":15,"max_wait_s":25,"protocol":1,"shiny":"VALUE-X"}"#,
        )
        .unwrap_err();
        assert_eq!(
            decoded_field(&unknown.to_string()).as_deref(),
            Some("shiny")
        );
        let missing = serde_json::from_str::<RegisterOut>(r#"{"phones":[]}"#).unwrap_err();
        assert_eq!(
            decoded_field(&missing.to_string()).as_deref(),
            Some("heartbeat_s")
        );
        let wrong = serde_json::from_str::<RegisterOut>(
            r#"{"phones":"VALUE-Y","heartbeat_s":15,"max_wait_s":25,"protocol":1}"#,
        )
        .unwrap_err();
        assert_eq!(decoded_field(&wrong.to_string()), None);
    }

    /// A server that answers every connection with `head`, then `body`, then holds the
    /// connection open (`hold`) or closes it.
    async fn raw_server(head: &'static str, body: Vec<u8>, hold: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let body = body.clone();
                tokio::spawn(async move {
                    let mut request = [0u8; 4096];
                    let _ = socket.read(&mut request).await;
                    let _ = socket.write_all(head.as_bytes()).await;
                    let _ = socket.write_all(&body).await;
                    if hold {
                        std::future::pending::<()>().await;
                    }
                });
            }
        });
        format!("http://{addr}/file")
    }

    #[tokio::test]
    async fn a_download_over_the_cap_is_refused_and_leaves_no_file() {
        // Announced too long.
        let announced = raw_server(
            "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n",
            vec![b'a'; 100],
            false,
        )
        .await;
        let dest = std::env::temp_dir().join(format!("jdb-unit-{}", Uuid::now_v7()));
        let refused = client().download_at_most(&announced, &dest, 10).await;
        assert!(matches!(refused, Err(ClientError::TooLarge)), "{refused:?}");
        assert!(!dest.exists());
        // Not announced, and too long as it arrives.
        let unannounced = raw_server(
            "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n",
            vec![b'a'; 100],
            false,
        )
        .await;
        let refused = client().download_at_most(&unannounced, &dest, 10).await;
        assert!(matches!(refused, Err(ClientError::TooLarge)), "{refused:?}");
        assert!(!dest.exists());
        // Within the cap: written whole.
        let written = client().download_at_most(&unannounced, &dest, 100).await;
        assert_eq!(written.unwrap(), 100);
        assert_eq!(std::fs::read(&dest).unwrap(), vec![b'a'; 100]);
        std::fs::remove_file(&dest).unwrap();
    }

    #[tokio::test]
    async fn a_download_cancelled_part_way_leaves_no_file() {
        // Ten bytes of a thousand, then nothing more.
        let stalled = raw_server(
            "HTTP/1.1 200 OK\r\nContent-Length: 1000\r\n\r\n",
            vec![b'a'; 10],
            true,
        )
        .await;
        let dest = std::env::temp_dir().join(format!("jdb-unit-{}", Uuid::now_v7()));
        let client = client();
        let task = {
            let dest = dest.clone();
            tokio::spawn(async move { client.download(&stalled, &dest).await })
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while std::fs::metadata(&dest).map_or(true, |m| m.len() < 10) {
            assert!(Instant::now() < deadline, "the download never started");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        task.abort();
        let _ = task.await;
        assert!(!dest.exists());
    }
}
