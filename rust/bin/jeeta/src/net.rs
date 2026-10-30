//! The server's listener ([`TimedListener`]): every accepted connection gives up a write that has
//! waited [`WRITE_TIMEOUT`] for its client to take anything ([`TimedWrites`]), so a client that
//! stopped reading never holds its socket, and what the server queued to it, for ever. The file
//! route cuts its own responses off sooner (`jt_files::READ_IDLE`), which lets their turns go, but
//! only closing the connection lets the socket go.
//!
//! The timer runs only while a write waits: a connection idle between requests, a long-poll
//! waiting for something to answer (the bridges' polls, up to 25 seconds; `calls.listen`), or an
//! event stream with nothing to send arms nothing. A write that the kernel takes, even in part,
//! starts the clock again.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::{TcpListener, TcpStream};
use tokio::time::Sleep;

/// How long a write may wait for its client to take anything before the connection is closed.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(60);

/// A listener whose connections are [`TimedWrites`].
pub struct TimedListener {
    inner: TcpListener,
    timeout: Duration,
}

impl TimedListener {
    /// `inner`'s connections, each giving up a write after `timeout`.
    pub fn new(inner: TcpListener, timeout: Duration) -> Self {
        TimedListener { inner, timeout }
    }
}

impl axum::serve::Listener for TimedListener {
    type Io = TimedWrites<TcpStream>;
    type Addr = SocketAddr;

    async fn accept(&mut self) -> (Self::Io, Self::Addr) {
        // `TcpListener`'s own accept logs and retries what fails.
        let (io, addr) = axum::serve::Listener::accept(&mut self.inner).await;
        (TimedWrites::new(io, self.timeout), addr)
    }

    fn local_addr(&self) -> io::Result<Self::Addr> {
        self.inner.local_addr()
    }
}

/// A connection whose write, flush or shutdown fails with `TimedOut` once it has waited `timeout`
/// for the other side; reads are as they are.
pub struct TimedWrites<S> {
    inner: S,
    timeout: Duration,
    /// Set while a write waits: when it began waiting, plus the timeout.
    waiting: Option<Pin<Box<Sleep>>>,
}

impl<S> TimedWrites<S> {
    pub fn new(inner: S, timeout: Duration) -> Self {
        TimedWrites {
            inner,
            timeout,
            waiting: None,
        }
    }

    /// What a write that did not complete answers: `Pending` while it is within its time (the
    /// timer, armed at its first wait, wakes the task when the time is up), `TimedOut` after.
    fn wait<T>(&mut self, cx: &mut Context<'_>) -> Poll<io::Result<T>> {
        let timeout = self.timeout;
        let waiting = self
            .waiting
            .get_or_insert_with(|| Box::pin(tokio::time::sleep(timeout)));
        match waiting.as_mut().poll(cx) {
            Poll::Ready(()) => {
                self.waiting = None;
                Poll::Ready(Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "the client took nothing for the write timeout",
                )))
            }
            Poll::Pending => Poll::Pending,
        }
    }

    /// What a write that completed answers: the timer is let go.
    fn done<T>(&mut self, result: io::Result<T>) -> Poll<io::Result<T>> {
        self.waiting = None;
        Poll::Ready(result)
    }
}

impl<S: AsyncRead + Unpin> AsyncRead for TimedWrites<S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for TimedWrites<S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let this = &mut *self;
        match Pin::new(&mut this.inner).poll_write(cx, buf) {
            Poll::Ready(result) => this.done(result),
            Poll::Pending => this.wait(cx),
        }
    }

    fn poll_write_vectored(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        let this = &mut *self;
        match Pin::new(&mut this.inner).poll_write_vectored(cx, bufs) {
            Poll::Ready(result) => this.done(result),
            Poll::Pending => this.wait(cx),
        }
    }

    fn is_write_vectored(&self) -> bool {
        self.inner.is_write_vectored()
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = &mut *self;
        match Pin::new(&mut this.inner).poll_flush(cx) {
            Poll::Ready(result) => this.done(result),
            Poll::Pending => this.wait(cx),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        let this = &mut *self;
        match Pin::new(&mut this.inner).poll_shutdown(cx) {
            Poll::Ready(result) => this.done(result),
            Poll::Pending => this.wait(cx),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    const SHORT: Duration = Duration::from_millis(200);

    #[tokio::test]
    async fn a_write_the_client_never_takes_times_out() {
        let (server, _client) = tokio::io::duplex(64);
        let mut timed = TimedWrites::new(server, SHORT);
        let started = Instant::now();
        let err = timed.write_all(&[7; 1024]).await.unwrap_err();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut);
        let took = started.elapsed();
        assert!(took >= SHORT && took < SHORT * 5, "{took:?}");
    }

    #[tokio::test]
    async fn a_client_that_reads_slowly_but_surely_is_served_whole() {
        let (server, mut client) = tokio::io::duplex(64);
        let mut timed = TimedWrites::new(server, SHORT);
        let reader = tokio::spawn(async move {
            let mut got = Vec::new();
            let mut buf = [0u8; 64];
            loop {
                tokio::time::sleep(Duration::from_millis(50)).await;
                match client.read(&mut buf).await.unwrap() {
                    0 => return got,
                    n => got.extend_from_slice(&buf[..n]),
                }
            }
        });
        // Each wait is shorter than the timeout, though the whole write takes far longer.
        timed.write_all(&[7; 1024]).await.unwrap();
        timed.shutdown().await.unwrap();
        drop(timed);
        assert_eq!(reader.await.unwrap(), vec![7; 1024]);
    }

    #[tokio::test]
    async fn a_connection_that_writes_nothing_never_times_out() {
        // A long-poll waiting for something to answer, or an idle event stream: no write waits, so
        // nothing is timed, however long it lasts.
        let (server, mut client) = tokio::io::duplex(64);
        let mut timed = TimedWrites::new(server, SHORT);
        tokio::time::sleep(SHORT * 3).await;
        timed.write_all(b"answer").await.unwrap();
        let mut buf = [0u8; 6];
        client.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"answer");
        // Reads are not timed either.
        let read = tokio::time::timeout(SHORT * 2, timed.read(&mut buf)).await;
        assert!(
            read.is_err(),
            "still waiting for the client: no error of its own"
        );
    }

    /// A server on this computer with `app`, behind a [`TimedListener`] of [`SHORT`]; its address.
    async fn serve(app: axum::Router) -> (SocketAddr, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(TimedListener::new(listener, SHORT), app)
                .await
                .unwrap()
        });
        (addr, server)
    }

    #[tokio::test]
    async fn a_long_poll_through_the_listener_is_answered() {
        // The answer comes long after the write timeout: nothing was written meanwhile.
        let app = axum::Router::new().route(
            "/poll",
            axum::routing::get(|| async {
                tokio::time::sleep(SHORT * 4).await;
                "answered"
            }),
        );
        let (addr, server) = serve(app).await;
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(
                b"GET /poll HTTP/1.1
host: x
connection: close

",
            )
            .await
            .unwrap();
        let mut got = String::new();
        client.read_to_string(&mut got).await.unwrap();
        assert!(got.starts_with("HTTP/1.1 200"), "{got}");
        assert!(got.ends_with("answered"), "{got}");
        server.abort();
    }

    #[tokio::test]
    async fn a_client_that_stops_reading_loses_its_connection() {
        // 64 MiB, far more than the sockets' buffers hold, never held in memory.
        const CHUNKS: usize = 1024;
        let app = axum::Router::new().route(
            "/big",
            axum::routing::get(|| async {
                use futures_util::StreamExt;
                let chunk = axum::body::Bytes::from_static(&[0; 65_536]);
                let stream = futures_util::stream::repeat(chunk)
                    .take(CHUNKS)
                    .map(Ok::<_, std::io::Error>);
                axum::body::Body::from_stream(stream)
            }),
        );
        let (addr, server) = serve(app).await;
        let mut client = TcpStream::connect(addr).await.unwrap();
        client
            .write_all(
                b"GET /big HTTP/1.1
host: x
connection: close

",
            )
            .await
            .unwrap();
        // Takes nothing for well past the timeout, then reads what is left.
        tokio::time::sleep(SHORT * 5).await;
        let mut got = 0usize;
        let mut buf = vec![0u8; 65_536];
        loop {
            match client.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => got += n,
            }
        }
        assert!(
            got < CHUNKS * 65_536,
            "the connection was closed short: {got}"
        );
        server.abort();
    }

    #[test]
    fn the_write_timeout_is_a_minute() {
        assert_eq!(WRITE_TIMEOUT, Duration::from_secs(60));
    }
}
