//! Authorized raw sockets share the HTTP client's tenant registry and DNS filter.
use std::time::Duration;
use tokio::time::{Instant, timeout_at};

use crate::{Egress, EgressError, EgressScope, HostError, TcpStream, Url};

impl Egress {
    /// Open a socket only after checking this scope's live host registration and filtering
    /// resolution. The entire operation is bounded by `timeout` (at most ten seconds), and
    /// each connection uses a returned address, never a hostname or a second lookup.
    /// Retirement/rebinding is checked again after resolution, before each connection.
    pub async fn connect_public(
        &self,
        scope: EgressScope,
        host: &str,
        port: u16,
        timeout: Duration,
    ) -> Result<TcpStream, EgressError> {
        let refused = || EgressError::HostNotAllowed {
            host: host.to_owned(),
        };
        let parsed = url::Host::parse(host).map_err(|_| refused())?;
        let mut url = Url::parse("https://example.com").expect("constant URL");
        url.set_host(Some(&parsed.to_string()))
            .map_err(|_| refused())?;
        url.set_port(Some(port)).map_err(|_| refused())?;
        if !self.permits(scope, &url) {
            return Err(refused());
        }
        let host = parsed.to_string();
        let deadline = Instant::now() + timeout.min(Duration::from_secs(10));
        timeout_at(deadline, async {
            let addresses = self
                .resolver
                .addresses(&host, port)
                .await
                .map_err(|e| match e {
                    HostError::Unresolvable(_) => EgressError::Socket,
                    _ => EgressError::NotPublic { host: host.clone() },
                })?;
            for (index, address) in addresses.iter().enumerate() {
                if !self.permits(scope, &url) {
                    return Err(refused());
                }
                // Share the remaining budget so a blackholed address cannot consume
                // the whole deadline before an alternate address gets a turn.
                let now = Instant::now();
                let remaining = deadline.saturating_duration_since(now);
                let left = u32::try_from(addresses.len() - index).unwrap_or(u32::MAX);
                let budget = (remaining / left).max(Duration::from_secs(1));
                let attempt_deadline = deadline.min(now + budget);
                if let Ok(Ok(stream)) =
                    timeout_at(attempt_deadline, TcpStream::connect(address)).await
                {
                    // A retirement racing the TCP handshake must not release a usable socket.
                    if !self.permits(scope, &url) {
                        return Err(refused());
                    }
                    return Ok(stream);
                }
            }
            Err(EgressError::Socket)
        })
        .await
        .map_err(|_| EgressError::Socket)?
    }
}
