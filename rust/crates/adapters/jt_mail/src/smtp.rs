use crate::{IO_TIMEOUT, MAX_MESSAGE_BYTES, MailConnector, MailCred, socket};
use jt_app::ports::connectors::{MailMessage, SendReceipt};
use jt_connector::{ConnectorError, MailTls};
use jt_tenancy::WorkspaceId;
use lettre::{
    Message,
    message::{Attachment, MultiPart, SinglePart, header::ContentType},
    transport::smtp::{
        Error,
        authentication::{Credentials, Mechanism},
        client::{AsyncSmtpConnection, AsyncTokioStream},
        commands::{Data, Mail, Rcpt},
        extension::ClientId,
    },
};

fn error(err: Error) -> ConnectorError {
    if err.is_permanent() {
        ConnectorError::permanent("SMTP request refused")
    } else if err.is_transient() {
        ConnectorError::transient("SMTP temporarily refused request")
    } else {
        ConnectorError::transient("SMTP transport failed")
    }
}
pub(crate) async fn authenticated(
    connector: &MailConnector,
    ws: WorkspaceId,
    cred: &MailCred<'_>,
) -> Result<AsyncSmtpConnection, ConnectorError> {
    let socket = socket::open(connector, ws, cred.smtp_host, cred.smtp_port).await?;
    let transport: Box<dyn AsyncTokioStream> = match cred.tls {
        MailTls::Implicit => Box::new(socket::SmtpTls(
            socket::encrypt(connector, cred.smtp_host, socket).await?,
        )),
        MailTls::StartTls => Box::new(socket),
    };
    let hello = ClientId::Domain("localhost".into());
    let mut smtp = AsyncSmtpConnection::connect_with_transport(transport, &hello)
        .await
        .map_err(error)?;
    if cred.tls == MailTls::StartTls {
        smtp.starttls(socket::smtp_tls(connector, cred.smtp_host)?, &hello)
            .await
            .map_err(|_| ConnectorError::permanent("SMTP requires verified STARTTLS"))?;
    }
    smtp.auth(
        &[Mechanism::Plain, Mechanism::Login],
        &Credentials::new(cred.username.into(), cred.password.into()),
    )
    .await
    .map_err(|e| {
        if e.is_permanent() || e.is_client() {
            ConnectorError::auth("SMTP authentication refused")
        } else {
            error(e)
        }
    })?;
    Ok(smtp)
}
pub(crate) async fn sender(
    smtp: &mut AsyncSmtpConnection,
    cred: &MailCred<'_>,
) -> Result<(), ConnectorError> {
    let address = cred
        .from_address
        .parse()
        .map_err(|_| ConnectorError::permanent("invalid mail sender"))?;
    smtp.command(Mail::new(Some(address), vec![]))
        .await
        .map_err(|e| {
            if e.is_permanent() {
                ConnectorError::permission("SMTP sender not authorized")
            } else {
                error(e)
            }
        })?;
    Ok(())
}
fn valid_id(id: &str) -> bool {
    id.starts_with('<')
        && id.ends_with('>')
        && id.contains('@')
        && !id.chars().any(char::is_whitespace)
        && !id[1..id.len() - 1].contains(['<', '>'])
}
fn wire(cred: &MailCred<'_>, mail: &MailMessage) -> Result<Vec<u8>, ConnectorError> {
    let invalid = || ConnectorError::permanent("invalid mail message");
    let headers = [&mail.to, &mail.subject, &mail.message_id];
    if headers.iter().any(|s| s.contains(['\r', '\n']))
        || !valid_id(&mail.message_id)
        || mail.in_reply_to.as_ref().is_some_and(|v| !valid_id(v))
        || mail.references.iter().any(|v| !valid_id(v))
    {
        return Err(invalid());
    }
    let size = mail
        .attachments
        .iter()
        .try_fold(mail.text.len(), |n, a| n.checked_add(a.bytes.len()))
        .ok_or_else(invalid)?;
    if size > MAX_MESSAGE_BYTES {
        return Err(ConnectorError::permanent("mail exceeds size limit"));
    }
    let mut builder = Message::builder()
        .from(cred.from_address.parse().map_err(|_| invalid())?)
        .to(mail.to.parse().map_err(|_| invalid())?)
        .subject(mail.subject.clone())
        .message_id(Some(mail.message_id.clone()));
    if let Some(parent) = &mail.in_reply_to {
        builder = builder.in_reply_to(parent.clone());
    }
    if !mail.references.is_empty() {
        builder = builder.references(mail.references.join(" "));
    }
    let text = SinglePart::plain(mail.text.clone());
    let message = if mail.attachments.is_empty() {
        builder.singlepart(text)
    } else {
        let mut parts = MultiPart::mixed().singlepart(text);
        for a in &mail.attachments {
            if a.filename.contains(['\r', '\n']) || a.mime.contains(['\r', '\n']) {
                return Err(invalid());
            }
            let mime = ContentType::parse(&a.mime).map_err(|_| invalid())?;
            parts =
                parts.singlepart(Attachment::new(a.filename.clone()).body(a.bytes.clone(), mime));
        }
        builder.multipart(parts)
    }
    .map_err(|_| invalid())?;
    let bytes = message.formatted();
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(ConnectorError::permanent("encoded mail exceeds size limit"));
    }
    Ok(bytes)
}
pub(crate) async fn send(
    connector: &MailConnector,
    ws: WorkspaceId,
    cred: &MailCred<'_>,
    message: MailMessage,
) -> Result<SendReceipt, ConnectorError> {
    let bytes = wire(cred, &message)?;
    let recipient = message
        .to
        .parse::<lettre::message::Mailbox>()
        .map_err(|_| ConnectorError::permanent("invalid mail recipient"))?
        .email;
    let mut post_data = false;
    let result = tokio::time::timeout(IO_TIMEOUT, async {
        let mut smtp = authenticated(connector, ws, cred).await?;
        sender(&mut smtp, cred).await?;
        smtp.command(Rcpt::new(recipient, vec![]))
            .await
            .map_err(error)?;
        smtp.command(Data).await.map_err(error)?;
        post_data = true;
        let response = smtp.message(&bytes).await.map_err(|e| {
            if e.status().is_some() {
                error(e)
            } else {
                ConnectorError::unknown("SMTP answer lost after DATA")
            }
        })?;
        if !response.has_code(250) {
            return Err(ConnectorError::unknown("unexpected SMTP answer after DATA"));
        }
        // The final 250 is conclusive; QUIT is cleanup and must never change the receipt.
        Ok(SendReceipt {
            provider_id: message.message_id,
            cost_minor: None,
        })
    })
    .await;
    result.unwrap_or_else(|_| {
        Err(if post_data {
            ConnectorError::unknown("SMTP timed out after DATA")
        } else {
            ConnectorError::transient("SMTP timed out before DATA")
        })
    })
}
