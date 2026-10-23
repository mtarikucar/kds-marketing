//! Authorized raw sockets share the HTTP client's tenant registry and DNS filter.
use std::time::Duration;

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
        tokio::time::timeout(timeout.min(Duration::from_secs(10)), async {
            let addresses = self
                .resolver
                .addresses(&host, port)
                .await
                .map_err(|e| match e {
                    HostError::Unresolvable(_) => EgressError::Socket,
                    _ => EgressError::NotPublic { host: host.clone() },
                })?;
            for address in addresses {
                if !self.permits(scope, &url) {
                    return Err(refused());
                }
                if let Ok(stream) = TcpStream::connect(address).await {
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
