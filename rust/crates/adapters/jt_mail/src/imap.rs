use crate::{IO_TIMEOUT, MAX_MESSAGE_BYTES, MailConnector, MailCred, parse, socket};
use async_imap::{Client, Session};
use futures_util::TryStreamExt;
use jt_app::ports::connectors::{InboundEventDraft, MailboxCursor, MailboxPosition};
use jt_connector::{ConnectorError, MailTls};
use jt_outbound::TcpStream;
use jt_tenancy::WorkspaceId;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio_rustls::client::TlsStream;

const POLL_BYTES: usize = 20 * 1024 * 1024;
type MailSession = Session<socket::LimitedRead<TlsStream<TcpStream>>>;
fn error(_: async_imap::error::Error) -> ConnectorError {
    ConnectorError::transient("IMAP operation failed")
}

pub(crate) async fn login(
    connector: &MailConnector,
    ws: WorkspaceId,
    cred: &MailCred<'_>,
) -> Result<MailSession, ConnectorError> {
    let socket = socket::open(connector, ws, cred.imap_host, cred.imap_port).await?;
    let client = match cred.tls {
        MailTls::Implicit => {
            let stream = socket::encrypt(connector, cred.imap_host, socket).await?;
            let mut client =
                Client::new(socket::LimitedRead::new(stream, POLL_BYTES + 1024 * 1024));
            client
                .read_response()
                .await
                .map_err(|e| error(e.into()))?
                .ok_or_else(|| ConnectorError::transient("IMAP greeting missing"))?;
            client
        }
        MailTls::StartTls => {
            let mut client = Client::new(socket::LimitedRead::new(socket, 64 * 1024));
            client
                .read_response()
                .await
                .map_err(|e| error(e.into()))?
                .ok_or_else(|| ConnectorError::transient("IMAP greeting missing"))?;
            client
                .run_command_and_check_ok("STARTTLS", None)
                .await
                .map_err(|_| ConnectorError::permanent("IMAP requires STARTTLS"))?;
            let stream =
                socket::encrypt(connector, cred.imap_host, client.into_inner().into_inner())
                    .await?;
            Client::new(socket::LimitedRead::new(stream, POLL_BYTES + 1024 * 1024))
        }
    };
    client
        .login(cred.username, cred.password)
        .await
        .map_err(|(e, _)| match e {
            async_imap::error::Error::No(_) | async_imap::error::Error::Bad(_) => {
                ConnectorError::auth("IMAP authentication refused")
            }
            _ => error(e),
        })
}

pub(crate) async fn poll(
    connector: &MailConnector,
    ws: WorkspaceId,
    cred: &MailCred<'_>,
    public: &Value,
    cursor: &MailboxCursor,
) -> Result<(Vec<InboundEventDraft>, MailboxCursor), ConnectorError> {
    let account = public["external_id"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ConnectorError::permanent("mailbox external account id required"))?;
    let binding: String = Sha256::digest(format!(
        "{}:{}",
        cred.imap_host.trim().to_ascii_lowercase(),
        cred.imap_port
    ))[..6]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let mut session = bounded(login(connector, ws, cred)).await?;
    let sent = sent_mailbox(&mut session).await?;
    // Finish the current command before returning a partial batch, so only fully consumed
    // FETCH responses can advance the persisted cursor. Each command has its own hard limit.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut next = cursor.clone();
    let mut events = Vec::new();
    let mut budget = POLL_BYTES;
    let mut remaining = 100;
    for (mailbox, is_sent) in
        std::iter::once(("INBOX", false)).chain(sent.as_deref().map(|name| (name, true)))
    {
        if remaining == 0 || tokio::time::Instant::now() >= deadline {
            break;
        }
        let info = match bounded(async {
            session.examine(mailbox).await.map_err(|e| match e {
                async_imap::error::Error::No(_) if is_sent => {
                    ConnectorError::permanent("optional sent mailbox unavailable")
                }
                other => error(other),
            })
        })
        .await
        {
            Ok(info) => info,
            Err(ConnectorError::Permanent { .. }) if is_sent => continue,
            Err(error) => return Err(error),
        };
        let validity = info
            .uid_validity
            .filter(|v| *v != 0)
            .ok_or_else(|| ConnectorError::transient("IMAP UIDVALIDITY missing"))?;
        let last = cursor
            .mailboxes
            .get(mailbox)
            .filter(|p| p.uidvalidity == validity)
            .map_or(0, |p| p.last_uid);
        let mut position = MailboxPosition {
            uidvalidity: validity,
            last_uid: last,
        };
        // SEARCH finds existing UIDs immediately even when most numeric IDs were expunged.
        // IMAP ranges may be reversed when '*' is below the lower bound; filter old UIDs.
        let selected: std::collections::BTreeSet<_> = if let Some(start) = last.checked_add(1) {
            let found = bounded(async {
                session
                    .uid_search(format!("UID {start}:*"))
                    .await
                    .map_err(error)
            })
            .await?;
            let sorted: std::collections::BTreeSet<_> =
                found.into_iter().filter(|uid| *uid > last).collect();
            sorted.into_iter().take(remaining).collect()
        } else {
            std::collections::BTreeSet::new()
        };
        // The standalone MIME parser retains its legacy IDs. Every polled event, including
        // rejected mail, receives the server binding before it reaches durable deduplication.
        let bind = |mut draft: InboundEventDraft, uid| {
            draft.external_id = format!("imap:{account}:{binding}:{mailbox}:{validity}:{uid}");
            draft
        };
        if !selected.is_empty() {
            let sequence = selected
                .iter()
                .map(u32::to_string)
                .collect::<Vec<_>>()
                .join(",");
            let mut sizes = std::collections::BTreeMap::new();
            bounded(async {
                let mut stream = session
                    .uid_fetch(sequence, "(UID RFC822.SIZE)")
                    .await
                    .map_err(error)?;
                while let Some(fetch) = stream.try_next().await.map_err(error)? {
                    let uid = fetch
                        .uid
                        .ok_or_else(|| ConnectorError::transient("IMAP UID missing"))?;
                    if !selected.contains(&uid) {
                        continue;
                    }
                    let size = fetch
                        .size
                        .ok_or_else(|| ConnectorError::transient("IMAP size missing"))?;
                    sizes.insert(uid, size as usize);
                }
                Ok(())
            })
            .await?;
            for (uid, size) in sizes {
                if tokio::time::Instant::now() >= deadline {
                    break;
                }
                if size > MAX_MESSAGE_BYTES {
                    events.push(bind(
                        parse::rejected(account, mailbox, validity, uid, "message_too_large"),
                        uid,
                    ));
                    remaining -= 1;
                    position.last_uid = uid;
                    continue;
                }
                if size > budget {
                    break;
                }
                budget = budget.saturating_sub(size);
                let query = format!("(UID BODY.PEEK[]<0.{}>)", size.saturating_add(1));
                let draft = bounded(async {
                    let mut stream = session
                        .uid_fetch(uid.to_string(), query)
                        .await
                        .map_err(error)?;
                    let mut draft = None;
                    while let Some(fetch) = stream.try_next().await.map_err(error)? {
                        if fetch.uid != Some(uid) || draft.is_some() {
                            continue;
                        }
                        draft = Some(match fetch.body() {
                            Some(body) if body.len() == size => {
                                parse::event(account, mailbox, validity, uid, body, is_sent)
                                    .unwrap_or_else(|_| {
                                        parse::rejected(
                                            account,
                                            mailbox,
                                            validity,
                                            uid,
                                            "invalid_mime",
                                        )
                                    })
                            }
                            _ => parse::rejected(
                                account,
                                mailbox,
                                validity,
                                uid,
                                "invalid_body_size",
                            ),
                        });
                    }
                    Ok(draft)
                })
                .await?;
                if let Some(draft) = draft {
                    events.push(bind(draft, uid));
                }
                remaining -= 1;
                // A message expunged between metadata and body fetch has no content to ingest.
                position.last_uid = uid;
            }
        }
        next.mailboxes.insert(mailbox.to_owned(), position);
    }
    // TLS close_notify is bounded cleanup, never an IMAP LOGOUT round trip and never a reason
    // to discard the completed events/cursor if the peer stops reading.
    use tokio::io::AsyncWriteExt;
    let _ = tokio::time::timeout(
        std::time::Duration::from_millis(50),
        session.get_mut().shutdown(),
    )
    .await;
    Ok((events, next))
}

async fn bounded<T>(
    operation: impl std::future::Future<Output = Result<T, ConnectorError>>,
) -> Result<T, ConnectorError> {
    tokio::time::timeout(IO_TIMEOUT, operation)
        .await
        .map_err(|_| ConnectorError::transient("IMAP operation timed out"))?
}

async fn sent_mailbox(session: &mut MailSession) -> Result<Option<String>, ConnectorError> {
    use async_imap::types::NameAttribute;
    bounded(async {
        let mut names = session.list(Some(""), Some("*")).await.map_err(error)?;
        let mut special = None;
        let mut fallback = None;
        while let Some(name) = names.try_next().await.map_err(error)? {
            if name.attributes().contains(&NameAttribute::NoSelect)
                || name.name().eq_ignore_ascii_case("INBOX")
            {
                continue;
            }
            if name.attributes().contains(&NameAttribute::Sent) && special.is_none() {
                special = Some(name.name().to_owned());
            } else if ["Sent", "Sent Items", "Sent Messages", "[Gmail]/Sent Mail"]
                .iter()
                .any(|candidate| name.name().eq_ignore_ascii_case(candidate))
                && fallback.is_none()
            {
                fallback = Some(name.name().to_owned());
            }
        }
        Ok(special.or(fallback))
    })
    .await
}
