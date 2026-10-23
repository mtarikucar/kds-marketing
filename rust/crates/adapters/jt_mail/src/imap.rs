use crate::search_read::SearchRead;
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
const UID_WINDOW: u32 = 5_000;
const POLL_WINDOWS: usize = 20;
type MailSession = Session<socket::LimitedRead<SearchRead<TlsStream<TcpStream>>>>;
fn error(_: async_imap::error::Error) -> ConnectorError {
    ConnectorError::transient("IMAP operation failed")
}

pub(crate) async fn login(
    connector: &MailConnector,
    ws: WorkspaceId,
    cred: &MailCred<'_>,
) -> Result<MailSession, ConnectorError> {
    let socket = socket::open(connector, ws, cred.imap_host, cred.imap_port).await?;
    // IMAP writes command tags and arguments separately. Disable Nagle so discovery and
    // bounded body fetches do not each wait for a delayed ACK.
    socket
        .set_nodelay(true)
        .map_err(|_| ConnectorError::transient("IMAP socket configuration failed"))?;
    let client = match cred.tls {
        MailTls::Implicit => {
            let stream = socket::encrypt(connector, cred.imap_host, socket).await?;
            let mut client = Client::new(socket::LimitedRead::new(
                SearchRead::new(stream, POLL_BYTES + 1024 * 1024),
                POLL_BYTES + 1024 * 1024,
            ));
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
            Client::new(socket::LimitedRead::new(
                SearchRead::new(stream, POLL_BYTES + 1024 * 1024),
                POLL_BYTES + 1024 * 1024,
            ))
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
    let esearch = bounded(async {
        session
            .capabilities()
            .await
            .map(|caps| caps.iter().any(|cap| matches!(cap, async_imap::types::Capability::Atom(name) if name.eq_ignore_ascii_case("ESEARCH"))))
            .map_err(error)
    })
    .await?;
    let sent = sent_mailbox(&mut session).await?;
    // Finish the current command before returning a partial batch, so only fully consumed
    // FETCH responses can advance the persisted cursor. Each command has its own hard limit.
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(8);
    let mut next = cursor.clone();
    let mut events = Vec::new();
    let mut budget = POLL_BYTES;
    let mut remaining = 100;
    let mut windows_left = POLL_WINDOWS;
    for (mailbox, is_sent) in
        std::iter::once(("INBOX", false)).chain(sent.as_deref().map(|name| (name, true)))
    {
        if remaining == 0 || windows_left == 0 || tokio::time::Instant::now() >= deadline {
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
        let upper = info
            .uid_next
            .filter(|n| *n != 0)
            .ok_or_else(|| ConnectorError::transient("IMAP UIDNEXT missing"))?
            - 1;
        let mut selected = std::collections::BTreeSet::new();
        let mut scanned = last;
        let mut last_empty_end = last;
        if esearch && scanned < upper {
            let (_, minimum) = search(
                &mut session,
                &format!("RETURN (MIN) UID {}:*", scanned + 1),
                true,
            )
            .await?;
            match minimum
                .first()
                .copied()
                .filter(|uid| *uid > scanned && *uid <= upper)
            {
                Some(uid) => {
                    // MIN itself is an existing UID; retain it even if the lookup consumed
                    // the poll budget and no window search can start this time.
                    selected.insert(uid);
                    scanned = uid - 1;
                    last_empty_end = scanned;
                    position.last_uid = scanned;
                }
                None => {
                    scanned = upper;
                    last_empty_end = upper;
                    position.last_uid = upper;
                }
            }
        }
        let mut width = UID_WINDOW;
        // Empty windows grow; overflowing responses are drained with bounded storage and
        // retried on the lower half. Only a fully scanned, accepted range advances `scanned`.
        while scanned < upper && windows_left > 0 && selected.len() < remaining {
            // Leave time to ingest selected messages rather than rediscovering them forever.
            let discovery_deadline = if selected.is_empty() {
                deadline
            } else {
                deadline - std::time::Duration::from_secs(2)
            };
            if tokio::time::Instant::now() >= discovery_deadline {
                break;
            }
            let start = scanned + 1;
            let mut end = start.saturating_add(width - 1).min(upper);
            let found = loop {
                // Do not discard narrowing progress solely because a slow overflowing
                // response consumed the soft deadline. Finish a bounded bisection when
                // nothing can be fetched yet; the shared search-count limit still applies.
                if windows_left == 0
                    || (!selected.is_empty() && tokio::time::Instant::now() >= discovery_deadline)
                {
                    break None;
                }
                windows_left -= 1;
                let (overflow, found) =
                    search(&mut session, &format!("UID {start}:{end}"), false).await?;
                if !overflow {
                    break Some(found);
                }
                if end == start {
                    return Err(ConnectorError::transient("IMAP SEARCH range overflow"));
                }
                end = start + (end - start) / 2;
            };
            let Some(found) = found else {
                break;
            };
            scanned = end;
            let sorted: std::collections::BTreeSet<_> = found
                .into_iter()
                .filter(|uid| (start..=end).contains(uid))
                .collect();
            if sorted.is_empty() {
                last_empty_end = end;
                if selected.is_empty() {
                    position.last_uid = end;
                }
                width = (end - start + 1).saturating_mul(2);
            } else {
                let additional: Vec<_> = sorted
                    .difference(&selected)
                    .take(remaining - selected.len())
                    .copied()
                    .collect();
                selected.extend(additional);
                width = UID_WINDOW;
            }
        }
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
            let mut processed = false;
            for (uid, size) in sizes {
                // A single slow SEARCH can overrun the discovery reserve. Allow one bounded
                // fetch to make progress; subsequent messages still honor the poll deadline.
                if tokio::time::Instant::now() >= deadline && (processed || !events.is_empty()) {
                    break;
                }
                processed = true;
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
        if selected.last().is_none_or(|uid| *uid <= position.last_uid) {
            position.last_uid = position.last_uid.max(last_empty_end);
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

/// Drain each tagged command completely before using any returned UID or overflow signal.
async fn search(
    session: &mut MailSession,
    query: &str,
    esearch: bool,
) -> Result<(bool, std::collections::BTreeSet<u32>), ConnectorError> {
    use async_imap::imap_proto::{MailboxDatum, Response, Status};
    bounded(async {
        let tag = session
            .run_command(format!("UID SEARCH {query}"))
            .await
            .map_err(error)?;
        session.get_mut().begin_search(tag.0.clone(), esearch);
        let mut found = std::collections::BTreeSet::new();
        loop {
            let response = session
                .read_response()
                .await
                .map_err(|e| error(e.into()))?
                .ok_or_else(|| ConnectorError::transient("IMAP SEARCH response missing"))?;
            match response.parsed() {
                Response::MailboxData(MailboxDatum::Search(uids)) => found.extend(uids),
                Response::Done {
                    tag: actual,
                    status,
                    ..
                } => {
                    if *actual != tag || *status != Status::Ok {
                        return Err(ConnectorError::transient("IMAP SEARCH refused"));
                    }
                    let overflow = session
                        .get_mut()
                        .inner_mut()
                        .finish()
                        .map_err(|e| error(e.into()))?;
                    return Ok((overflow, found));
                }
                Response::Data {
                    status: Status::Bye,
                    ..
                } => return Err(ConnectorError::transient("IMAP SEARCH disconnected")),
                _ => {}
            }
        }
    })
    .await
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
