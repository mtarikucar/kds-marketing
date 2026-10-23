use jt_app::ports::connectors::MailMessage;
use jt_connector::{Credential, MailTls};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio_rustls::{
    TlsAcceptor,
    rustls::{
        ServerConfig,
        pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    },
};

pub const CA: &[u8] = include_bytes!("../fixtures/ca.der");
pub const BODY: &[u8] = b"From: Person <person@example.com>\r\nTo: sender@example.com\r\nSubject: Hello\r\nMessage-ID: <stable@example.com>\r\nIn-Reply-To: <parent@example.com>\r\nDate: Fri, 23 Oct 2026 12:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nhello\r\n";
pub fn acceptor() -> TlsAcceptor {
    acceptor_for(false)
}
fn acceptor_for(wrong_host: bool) -> TlsAcceptor {
    let der: &[u8] = if wrong_host {
        include_bytes!("../fixtures/wrong-host.der")
    } else {
        include_bytes!("../fixtures/server.der")
    };
    let config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(der.to_vec())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                include_bytes!("../fixtures/server-key.der").to_vec(),
            )),
        )
        .unwrap();
    TlsAcceptor::from(Arc::new(config))
}
pub trait Io: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> Io for T {}
pub type Stream = BufReader<Box<dyn Io>>;
async fn line(stream: &mut Stream) -> String {
    let mut line = String::new();
    stream.read_line(&mut line).await.unwrap();
    line
}
async fn reply(stream: &mut Stream, text: &str) {
    stream.get_mut().write_all(text.as_bytes()).await.unwrap();
    stream.get_mut().flush().await.unwrap();
}
#[derive(Clone, Copy, Default)]
pub struct SmtpMode {
    pub starttls: bool,
    pub no_tls: bool,
    pub lost: bool,
    pub invalid_final: bool,
    pub reject_sender: bool,
    pub reject_auth: bool,
    pub wrong_host: bool,
    pub smtputf8: bool,
    pub utf8_from: bool,
    pub utf8_to: bool,
    pub pre_tls_failure: Option<(bool, &'static str)>, // (EHLO rather than greeting, reply)
    pub bare_lf: bool,
    pub oversized: Option<(bool, bool)>, // (before TLS, multiline)
}
pub async fn smtp(mode: SmtpMode) -> (u16, tokio::task::JoinHandle<Vec<u8>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        socket.set_nodelay(true).unwrap();
        let mut stream: Stream = if mode.starttls {
            BufReader::new(Box::new(socket))
        } else {
            let Ok(tls) = acceptor_for(mode.wrong_host).accept(socket).await else {
                return vec![];
            };
            BufReader::new(Box::new(tls))
        };
        if let Some((false, response)) = mode.pre_tls_failure {
            reply(&mut stream, response).await;
            return vec![];
        }
        if let Some((true, multiline)) = mode.oversized {
            oversized_smtp(&mut stream, multiline, mode.bare_lf).await;
            return vec![];
        }
        reply(&mut stream, "220 localhost ESMTP\r\n").await;
        assert!(line(&mut stream).await.starts_with("EHLO "));
        if mode.starttls {
            if let Some((true, response)) = mode.pre_tls_failure {
                reply(&mut stream, response).await;
                return vec![];
            }
            if mode.no_tls {
                reply(&mut stream, "250-localhost\r\n250 AUTH PLAIN\r\n").await;
                let next = line(&mut stream).await;
                assert!(!next.starts_with("AUTH"), "credentials sent without TLS");
                return vec![];
            }
            reply(&mut stream, "250-localhost\r\n250 STARTTLS\r\n").await;
            assert_eq!(line(&mut stream).await, "STARTTLS\r\n");
            reply(&mut stream, "220 upgrade\r\n").await;
            let Ok(tls) = acceptor_for(mode.wrong_host)
                .accept(stream.into_inner())
                .await
            else {
                return vec![];
            };
            stream = BufReader::new(Box::new(tls));
            assert!(line(&mut stream).await.starts_with("EHLO "));
        }
        if let Some((_, multiline)) = mode.oversized {
            oversized_smtp(&mut stream, multiline, mode.bare_lf).await;
            return vec![];
        }
        let capabilities = if mode.smtputf8 {
            "250-localhost\r\n250-SMTPUTF8\r\n250 AUTH PLAIN LOGIN\r\n"
        } else {
            "250-localhost\r\n250 AUTH PLAIN LOGIN\r\n"
        };
        reply(&mut stream, capabilities).await;
        assert!(line(&mut stream).await.starts_with("AUTH PLAIN "));
        if mode.reject_auth {
            reply(
                &mut stream,
                "535 mail-password and private-login refused\r\n",
            )
            .await;
            return vec![];
        }
        reply(&mut stream, "235 authenticated\r\n").await;
        let needs_utf8 = mode.utf8_from || mode.utf8_to;
        if needs_utf8 && !mode.smtputf8 {
            let mut command = String::new();
            let read = stream.read_line(&mut command).await;
            assert!(
                matches!(read, Ok(0))
                    || matches!(read, Err(ref e) if e.kind() == std::io::ErrorKind::UnexpectedEof)
            );
            assert!(command.is_empty(), "must refuse before MAIL: {command}");
            return vec![];
        }
        let command = line(&mut stream).await;
        let from = if mode.utf8_from {
            "çağrı@example.com"
        } else {
            "sender@example.com"
        };
        let option = if needs_utf8 { " SMTPUTF8" } else { "" };
        assert_eq!(command, format!("MAIL FROM:<{from}>{option}\r\n"));
        if mode.reject_sender {
            reply(&mut stream, "550 mail-password sender refused\r\n").await;
            return vec![];
        }
        reply(&mut stream, "250 sender accepted\r\n").await;
        let next = line(&mut stream).await;
        if next == "QUIT\r\n" {
            reply(&mut stream, "221 bye\r\n").await;
            return vec![];
        }
        let to = if mode.utf8_to {
            "çağrı@example.com"
        } else {
            "person@example.com"
        };
        assert_eq!(next, format!("RCPT TO:<{to}>\r\n"));
        reply(&mut stream, "250 recipient accepted\r\n").await;
        assert_eq!(line(&mut stream).await, "DATA\r\n");
        reply(&mut stream, "354 send message\r\n").await;
        let mut message = Vec::new();
        loop {
            let next = line(&mut stream).await;
            if next == ".\r\n" {
                break;
            }
            assert!(!next.is_empty());
            message.extend_from_slice(next.as_bytes());
        }
        if !mode.lost {
            reply(
                &mut stream,
                if mode.invalid_final {
                    "354 invalid final answer\r\n"
                } else {
                    "250 queued\r\n"
                },
            )
            .await;
            // QUIT failure after the final 250 must not change the accepted send result.
        }
        message
    });
    (port, task)
}

// Send only the bytes needed to cross the bound, then keep the connection open.
// A reader that waits for a newline/complete response will stall instead of rejecting.
async fn oversized_smtp(stream: &mut Stream, multiline: bool, bare_lf: bool) {
    let bytes = if bare_lf {
        "250 x\n".repeat(700)
    } else if multiline {
        (format!("250-{}\r\n", "x".repeat(3000))).repeat(22)
    } else {
        format!("250 {}", "x".repeat(4096))
    };
    let _ = stream.get_mut().write_all(bytes.as_bytes()).await;
    let _ = stream.get_mut().flush().await;
    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
}

pub async fn imap(
    starttls: bool,
    validity: u32,
    body: Vec<u8>,
    sessions: usize,
) -> (u16, tokio::task::JoinHandle<()>) {
    imap_messages(
        starttls,
        validity,
        vec![(7, body.len() as u32, body)],
        sessions,
    )
    .await
}
pub async fn imap_messages(
    starttls: bool,
    validity: u32,
    messages: Vec<(u32, u32, Vec<u8>)>,
    sessions: usize,
) -> (u16, tokio::task::JoinHandle<()>) {
    imap_with_mode(starttls, validity, messages, sessions, ImapMode::default()).await
}
#[derive(Clone)]
pub struct ImapMode {
    pub sent: Option<&'static str>,
    pub special_use: bool,
    pub missing_sent: bool,
    pub body_delay: std::time::Duration,
    pub stall_logout: bool,
}
impl Default for ImapMode {
    fn default() -> Self {
        Self {
            sent: Some("Sent"),
            special_use: true,
            missing_sent: false,
            body_delay: std::time::Duration::ZERO,
            stall_logout: false,
        }
    }
}
pub async fn imap_with_mode(
    starttls: bool,
    validity: u32,
    messages: Vec<(u32, u32, Vec<u8>)>,
    sessions: usize,
    mode: ImapMode,
) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        for _ in 0..sessions {
            let (socket, _) = listener.accept().await.unwrap();
            socket.set_nodelay(true).unwrap();
            let mut stream: Stream = if starttls {
                BufReader::new(Box::new(socket))
            } else {
                BufReader::new(Box::new(acceptor().accept(socket).await.unwrap()))
            };
            reply(&mut stream, "* OK test IMAP ready\r\n").await;
            if starttls {
                let command = line(&mut stream).await;
                let tag = command.split_whitespace().next().unwrap();
                assert!(command.contains("STARTTLS"));
                reply(&mut stream, &format!("{tag} OK upgrade\r\n")).await;
                stream = BufReader::new(Box::new(
                    acceptor().accept(stream.into_inner()).await.unwrap(),
                ));
            }
            let mut authenticated = false;
            loop {
                let command = line(&mut stream).await;
                if command.is_empty() {
                    break;
                }
                let tag = command.split_whitespace().next().unwrap().to_owned();
                if command.contains(" LOGIN ") {
                    assert!(command.contains("mail-password"));
                    authenticated = true;
                    reply(&mut stream, &format!("{tag} OK authenticated\r\n")).await;
                } else if command.contains(" LIST ") {
                    reply(&mut stream, "* LIST () \"/\" \"INBOX\"\r\n").await;
                    if let Some(sent) = mode.sent {
                        let flag = if mode.special_use { "\\Sent" } else { "" };
                        reply(
                            &mut stream,
                            &format!("* LIST ({flag}) \"/\" \"{sent}\"\r\n"),
                        )
                        .await;
                    }
                    reply(&mut stream, &format!("{tag} OK listed\r\n")).await;
                } else if command.contains(" EXAMINE ") {
                    assert!(authenticated);
                    if !command.contains("INBOX")
                        && (mode.missing_sent
                            || mode.sent.is_none_or(|sent| !command.contains(sent)))
                    {
                        reply(&mut stream, &format!("{tag} NO mailbox not found\r\n")).await;
                        continue;
                    }
                    let next = messages.iter().map(|(uid, _, _)| *uid).max().unwrap_or(0) + 1;
                    reply(&mut stream, &format!("* 1 EXISTS\r\n* OK [UIDVALIDITY {validity}] validity\r\n* OK [UIDNEXT {next}] next\r\n{tag} OK [READ-ONLY] selected\r\n")).await;
                } else if command.contains(" UID SEARCH ") {
                    assert!(command.contains(" UID SEARCH UID "));
                    let start: u32 = command
                        .split_whitespace()
                        .nth(4)
                        .unwrap()
                        .split(':')
                        .next()
                        .unwrap()
                        .parse()
                        .unwrap();
                    let highest = messages.iter().map(|(uid, _, _)| *uid).max().unwrap_or(0);
                    // Match IMAP's reversed range semantics, including the old highest UID.
                    let found = messages
                        .iter()
                        .rev()
                        .filter(|(uid, _, _)| *uid >= start.min(highest))
                        .map(|(uid, _, _)| uid.to_string())
                        .collect::<Vec<_>>()
                        .join(" ");
                    reply(
                        &mut stream,
                        &format!("* SEARCH {found}\r\n{tag} OK searched\r\n"),
                    )
                    .await;
                } else if command.contains(" UID FETCH ") {
                    let range = command.split_whitespace().nth(3).unwrap();
                    let is_body = command.contains("BODY.PEEK");
                    for (uid, size, body) in &messages {
                        let selected = range.split(',').any(|part| {
                            if let Some((start, end)) = part.split_once(':') {
                                (start.parse::<u32>().unwrap()..=end.parse::<u32>().unwrap())
                                    .contains(uid)
                            } else {
                                part.parse::<u32>().unwrap() == *uid
                            }
                        });
                        if !selected {
                            continue;
                        }
                        if is_body {
                            tokio::time::sleep(mode.body_delay).await;
                            assert!(
                                *size <= 10 * 1024 * 1024,
                                "oversized body must not be downloaded"
                            );
                            assert!(
                                command.contains("BODY.PEEK[]<0."),
                                "body retrieval must be bounded"
                            );
                            reply(
                                &mut stream,
                                &format!(
                                    "* 1 FETCH (UID {uid} RFC822.SIZE {size} BODY[] {{{}}}\r\n",
                                    body.len()
                                ),
                            )
                            .await;
                            stream.get_mut().write_all(body).await.unwrap();
                            reply(&mut stream, ")\r\n").await;
                        } else {
                            reply(
                                &mut stream,
                                &format!("* 1 FETCH (UID {uid} RFC822.SIZE {size})\r\n"),
                            )
                            .await;
                        }
                    }
                    reply(&mut stream, &format!("{tag} OK fetched\r\n")).await;
                } else if command.contains(" LOGOUT") {
                    if mode.stall_logout {
                        // Wait for the client to abandon cleanup; never hold the test open.
                        assert!(line(&mut stream).await.is_empty());
                        break;
                    }
                    reply(&mut stream, &format!("* BYE logout\r\n{tag} OK done\r\n")).await;
                    break;
                } else {
                    panic!("unexpected IMAP test command: {command}");
                }
            }
        }
    });
    (port, task)
}
pub fn credential(smtp_port: u16, imap_port: u16, tls: MailTls) -> Credential {
    Credential::Mailbox {
        smtp_host: "localhost".into(),
        smtp_port,
        imap_host: "localhost".into(),
        imap_port,
        username: "private-login".into(),
        password: "mail-password".into(),
        from_address: "sender@example.com".into(),
        tls,
    }
}
pub fn message() -> MailMessage {
    MailMessage {
        to: "person@example.com".into(),
        subject: "Meeting".into(),
        text: "See you".into(),
        message_id: "<stable@example.com>".into(),
        in_reply_to: Some("<parent@example.com>".into()),
        references: vec!["<root@example.com>".into(), "<parent@example.com>".into()],
        attachments: vec![],
    }
}

/// Advertises a literal larger than the permitted body without transmitting its contents.
pub async fn malicious_imap() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        socket.set_nodelay(true).unwrap();
        let mut stream: Stream = BufReader::new(Box::new(acceptor().accept(socket).await.unwrap()));
        reply(&mut stream, "* OK ready\r\n").await;
        loop {
            let command = line(&mut stream).await;
            let tag = command.split_whitespace().next().unwrap();
            if command.contains(" LOGIN ") {
                reply(&mut stream, &format!("{tag} OK authenticated\r\n")).await;
            } else if command.contains(" LIST ") {
                reply(&mut stream, &format!("{tag} OK listed\r\n")).await;
            } else if command.contains(" EXAMINE ") {
                reply(&mut stream, &format!("* 1 EXISTS\r\n* OK [UIDVALIDITY 1] validity\r\n* OK [UIDNEXT 2] next\r\n{tag} OK selected\r\n")).await;
            } else if command.contains(" UID SEARCH ") {
                reply(&mut stream, &format!("* SEARCH 1\r\n{tag} OK searched\r\n")).await;
            } else if command.contains("BODY.PEEK") {
                reply(&mut stream, "* OK ordinary status text {100}\r\n").await;
                reply(&mut stream, "* 1 FETCH (UID 1 BODY[] {33554432").await;
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
                reply(&mut stream, "}\r\n").await;
                // The client must reject the literal header immediately, before waiting for its body.
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                return;
            } else {
                reply(
                    &mut stream,
                    &format!("* 1 FETCH (UID 1 RFC822.SIZE 1)\r\n{tag} OK fetched\r\n"),
                )
                .await;
            }
        }
    });
    (port, task)
}
