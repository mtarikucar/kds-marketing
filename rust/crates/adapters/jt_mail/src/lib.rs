//! SMTP and IMAP over the tenant's live egress registry. TLS and hostname verification are
//! mandatory. Credentials and protocol replies never enter diagnostics; attachment bytes are
//! transport-only. No retries: the caller owns recovery and persists Message-ID before sending.
mod imap;
mod parse;
mod probe;
mod smtp;
mod socket;

use async_trait::async_trait;
use jt_app::ports::connectors::{
    Connector, InboundEventDraft, MailMessage, MailSender, MailboxCursor, MailboxPoller,
    SendReceipt,
};
use jt_connector::{ConnectorError, Credential, MailTls, ProbeResult, Provider};
use jt_outbound::Egress;
use jt_tenancy::WorkspaceId;
use serde_json::Value;
use std::{sync::Arc, time::Duration};

const IO_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_MESSAGE_BYTES: usize = 10 * 1024 * 1024;

/// One workspace's mail adapter. Construct with the same `Egress` used by the host registry;
/// clones share its revocations. A registry that serves multiple workspaces must bind this
/// adapter to the request's workspace, never reuse another tenant's instance.
#[derive(Clone)]
pub struct MailConnector {
    egress: Arc<Egress>,
    workspace: WorkspaceId,
    roots: Vec<Vec<u8>>,
}
impl std::fmt::Debug for MailConnector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MailConnector")
            .field("workspace", &self.workspace)
            .finish_non_exhaustive()
    }
}
impl MailConnector {
    pub fn new(egress: Arc<Egress>, workspace: WorkspaceId) -> Self {
        Self {
            egress,
            workspace,
            roots: Vec::new(),
        }
    }
    /// Trust an additional DER CA certificate (for private PKI or local TLS fixtures).
    /// The certificate chain and declared server hostname are still verified.
    pub fn with_root_certificate(mut self, der: Vec<u8>) -> Result<Self, ConnectorError> {
        let mut roots = tokio_rustls::rustls::RootCertStore::empty();
        roots
            .add(tokio_rustls::rustls::pki_types::CertificateDer::from(
                der.clone(),
            ))
            .map_err(|_| ConnectorError::permanent("invalid mail CA certificate"))?;
        self.roots.push(der);
        Ok(self)
    }
}

struct MailCred<'a> {
    smtp_host: &'a str,
    smtp_port: u16,
    imap_host: &'a str,
    imap_port: u16,
    username: &'a str,
    password: &'a str,
    from_address: &'a str,
    tls: MailTls,
}
impl<'a> MailCred<'a> {
    fn of(credential: &'a Credential) -> Result<Self, ConnectorError> {
        let Credential::Mailbox {
            smtp_host,
            smtp_port,
            imap_host,
            imap_port,
            username,
            password,
            from_address,
            tls,
        } = credential
        else {
            return Err(ConnectorError::permanent("mailbox credential required"));
        };
        let expected = match tls {
            MailTls::Implicit => (465, 993),
            MailTls::StartTls => (587, 143),
        };
        for (host, port, expected) in [
            (smtp_host, *smtp_port, expected.0),
            (imap_host, *imap_port, expected.1),
        ] {
            let test_host = jt_outbound::TEST_LOOPBACK_ENABLED && host == "localhost";
            if port == 0 || (port != expected && !test_host) {
                return Err(ConnectorError::permanent(
                    "mail port does not match mandatory TLS mode",
                ));
            }
        }
        if username.is_empty()
            || password.is_empty()
            || from_address.parse::<lettre::Address>().is_err()
        {
            return Err(ConnectorError::permanent("invalid mailbox credential"));
        }
        Ok(Self {
            smtp_host,
            smtp_port: *smtp_port,
            imap_host,
            imap_port: *imap_port,
            username,
            password,
            from_address,
            tls: *tls,
        })
    }
}

#[async_trait]
impl Connector for MailConnector {
    fn provider(&self) -> Provider {
        Provider::Mail
    }
    fn hosts(&self) -> &'static [&'static str] {
        &[]
    }
    async fn probe(&self, cred: &Credential, public: &Value) -> ProbeResult {
        probe::probe(self, cred, public).await
    }
    async fn refresh(&self, _cred: &Credential) -> Result<Option<Credential>, ConnectorError> {
        Ok(None)
    }
}
#[async_trait]
impl MailSender for MailConnector {
    async fn send(
        &self,
        cred: &Credential,
        message: MailMessage,
    ) -> Result<SendReceipt, ConnectorError> {
        smtp::send(self, &MailCred::of(cred)?, message).await
    }
}
#[async_trait]
impl MailboxPoller for MailConnector {
    async fn poll(
        &self,
        cred: &Credential,
        public: &Value,
        cursor: &MailboxCursor,
    ) -> Result<(Vec<InboundEventDraft>, MailboxCursor), ConnectorError> {
        let cred = MailCred::of(cred)?;
        imap::poll(self, &cred, public, cursor).await
    }
}
