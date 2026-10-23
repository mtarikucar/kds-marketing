//! TLS over a socket obtained from the shared egress guard.
use crate::{IO_TIMEOUT, MailConnector};
use jt_connector::ConnectorError;
use jt_outbound::{EgressError, EgressScope, TcpStream};
use lettre::transport::smtp::client::{AsyncTokioStream, Certificate, TlsParameters};
use std::{
    io,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio_rustls::{
    TlsConnector,
    client::TlsStream,
    rustls::{
        ClientConfig, RootCertStore,
        pki_types::{CertificateDer, ServerName},
    },
};

pub(crate) async fn open(
    connector: &MailConnector,
    host: &str,
    port: u16,
) -> Result<TcpStream, ConnectorError> {
    connector
        .egress
        .connect_public(
            EgressScope::Tenant(connector.workspace),
            host,
            port,
            IO_TIMEOUT,
        )
        .await
        .map_err(|e| match e {
            EgressError::HostNotAllowed { .. } | EgressError::NotPublic { .. } => {
                ConnectorError::permission("mail host is not authorized or public")
            }
            _ => ConnectorError::transient("mail socket could not connect"),
        })
}
pub(crate) async fn encrypt(
    connector: &MailConnector,
    host: &str,
    stream: TcpStream,
) -> Result<TlsStream<TcpStream>, ConnectorError> {
    let mut roots = RootCertStore::empty();
    roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
    for root in &connector.roots {
        roots
            .add(CertificateDer::from(root.clone()))
            .map_err(|_| ConnectorError::permanent("invalid mail CA certificate"))?;
    }
    let config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth();
    let host = ServerName::try_from(host.to_owned())
        .map_err(|_| ConnectorError::permanent("invalid mail TLS hostname"))?;
    TlsConnector::from(Arc::new(config))
        .connect(host, stream)
        .await
        .map_err(|_| ConnectorError::permanent("mail TLS verification failed"))
}
pub(crate) fn smtp_tls(
    connector: &MailConnector,
    host: &str,
) -> Result<TlsParameters, ConnectorError> {
    let mut builder = TlsParameters::builder(host.to_owned());
    for root in &connector.roots {
        builder = builder.add_root_certificate(
            Certificate::from_der(root.clone())
                .map_err(|_| ConnectorError::permanent("invalid mail CA certificate"))?,
        );
    }
    builder
        .build_rustls()
        .map_err(|_| ConnectorError::permanent("mail TLS configuration failed"))
}

/// Adapts an already encrypted stream to the SMTP library's transport interface.
pub(crate) struct SmtpTls(pub TlsStream<TcpStream>);
impl std::fmt::Debug for SmtpTls {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SmtpTls")
    }
}
impl AsyncTokioStream for SmtpTls {
    fn peer_addr(&self) -> io::Result<std::net::SocketAddr> {
        self.0.get_ref().0.peer_addr()
    }
}
impl AsyncRead for SmtpTls {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_read(cx, buf)
    }
}
impl AsyncWrite for SmtpTls {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.0).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.0).poll_shutdown(cx)
    }
}

/// A byte ceiling beneath the IMAP parser also bounds a server that ignores partial FETCH or
/// advertises a dishonest literal length. It cannot make the protocol library buffer forever.
pub(crate) struct LimitedRead<T> {
    inner: T,
    remaining: usize,
    pending: Vec<u8>,
    needed: usize,
}
impl<T> std::fmt::Debug for LimitedRead<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LimitedRead")
    }
}
impl<T> LimitedRead<T> {
    pub(crate) fn new(inner: T, remaining: usize) -> Self {
        Self {
            inner,
            remaining,
            pending: Vec::new(),
            needed: 0,
        }
    }
    pub(crate) fn into_inner(self) -> T {
        self.inner
    }
}
impl<T> LimitedRead<T> {
    // Inspect the same grammar as the protocol library before giving it more bytes. Its
    // parser reports the exact additional allocation required by a literal. A second bounded
    // buffer costs at most one message and avoids ambiguous hand-written brace framing:
    // status text ending in {N} is ordinary text, while literal contents remain opaque.
    fn inspect(&mut self, bytes: &[u8]) -> io::Result<()> {
        const RESPONSE_LIMIT: usize = crate::MAX_MESSAGE_BYTES + 64 * 1024;
        if self.pending.len().saturating_add(bytes.len()) > RESPONSE_LIMIT {
            return Err(io::Error::other("mail response limit exceeded"));
        }
        self.pending.extend_from_slice(bytes);
        if self.pending.len() < self.needed {
            return Ok(());
        }
        loop {
            match async_imap::imap_proto::parser::parse_response(&self.pending) {
                Ok((remaining, _)) => {
                    let consumed = self.pending.len() - remaining.len();
                    self.pending.drain(..consumed);
                    self.needed = 0;
                    if self.pending.is_empty() {
                        return Ok(());
                    }
                }
                Err(nom::Err::Incomplete(nom::Needed::Size(extra))) => {
                    self.needed = self.pending.len().saturating_add(extra.get());
                    if self.needed > RESPONSE_LIMIT {
                        return Err(io::Error::other("mail literal limit exceeded"));
                    }
                    return Ok(());
                }
                Err(nom::Err::Incomplete(nom::Needed::Unknown)) => return Ok(()),
                Err(_) => return Err(io::Error::other("invalid mail response")),
            }
        }
    }
}
impl<T: AsyncRead + Unpin> AsyncRead for LimitedRead<T> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if buf.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        if self.remaining == 0 {
            return Poll::Ready(Err(io::Error::other("mail read limit exceeded")));
        }
        let mut scratch = [0u8; 8192];
        let count = buf.remaining().min(self.remaining).min(scratch.len());
        let mut incoming = ReadBuf::new(&mut scratch[..count]);
        match Pin::new(&mut self.inner).poll_read(cx, &mut incoming) {
            Poll::Ready(Ok(())) => {
                let bytes = incoming.filled();
                self.inspect(bytes)?;
                self.remaining -= bytes.len();
                buf.put_slice(bytes);
                Poll::Ready(Ok(()))
            }
            other => other,
        }
    }
}
impl<T: AsyncWrite + Unpin> AsyncWrite for LimitedRead<T> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.inner).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
