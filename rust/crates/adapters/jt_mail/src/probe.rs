use crate::{IO_TIMEOUT, MailConnector, MailCred, imap, smtp};
use jt_connector::{ConnectorError, Credential, ProbeResult};
use serde_json::{Value, json};
use std::time::Instant;

pub(crate) async fn probe(
    connector: &MailConnector,
    cred: &Credential,
    public: &Value,
) -> ProbeResult {
    let started = Instant::now();
    let result = tokio::time::timeout(IO_TIMEOUT, async {
        if public["kind_key"] != "mailbox" {
            return Err(ConnectorError::permanent("mailbox kind_key required"));
        }
        let ws = crate::workspace_from_public(public)?;
        let cred = MailCred::of(cred)?;
        let mut session = imap::login(connector, ws, &cred).await?;
        let _ = session.logout().await;
        let mut smtp = smtp::authenticated(connector, ws, &cred).await?;
        smtp::sender(&mut smtp, &cred).await?;
        let _ = smtp.quit().await;
        Ok(json!({"account_id":cred.username, "sender_authorized":true}))
    })
    .await
    .unwrap_or_else(|_| Err(ConnectorError::transient("mail probe timed out")));
    let latency = u32::try_from(started.elapsed().as_millis()).unwrap_or(u32::MAX);
    match result {
        Ok(facts) => ProbeResult::success(latency, facts),
        Err(e) => ProbeResult::failure(latency, e),
    }
}
