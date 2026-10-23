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
        client::AsyncSmtpConnection,
        commands::{Data, Mail, Rcpt},
        extension::{ClientId, Extension, MailParameter, ServerInfo},
        response::Response,
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
    let stream = socket::open(connector, ws, cred.smtp_host, cred.smtp_port).await?;
    let (stream, greeting) = if cred.tls == MailTls::StartTls {
        starttls(stream).await?
    } else {
        (stream, Vec::new())
    };
    let transport = socket::SmtpRead::new(socket::SmtpTls {
        stream: socket::encrypt(connector, cred.smtp_host, stream).await?,
        greeting: std::io::Cursor::new(greeting),
    });
    let hello = ClientId::Domain("localhost".into());
    let mut smtp = AsyncSmtpConnection::connect_with_transport(Box::new(transport), &hello)
        .await
        .map_err(error)?;
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
// Negotiate STARTTLS ourselves so the read limiter stays ABOVE TLS in both modes.
// No credentials or envelope commands are sent before verified encryption.
async fn starttls(
    stream: jt_outbound::TcpStream,
) -> Result<(jt_outbound::TcpStream, Vec<u8>), ConnectorError> {
    use tokio::io::{AsyncWriteExt, BufReader};
    let refused = || ConnectorError::permanent("SMTP requires verified STARTTLS");
    let mut stream = BufReader::new(socket::SmtpRead::new(stream));
    let (greeting, response) = pre_tls_response(&mut stream).await?;
    if !response.has_code(220) {
        return Err(refused());
    }
    stream
        .write_all(b"EHLO localhost\r\n")
        .await
        .map_err(|_| ConnectorError::transient("SMTP transport failed"))?;
    let (_, response) = pre_tls_response(&mut stream).await?;
    let info = ServerInfo::from_response(&response).map_err(|_| refused())?;
    if !response.has_code(250) || !info.supports_feature(Extension::StartTls) {
        return Err(refused());
    }
    stream
        .write_all(b"STARTTLS\r\n")
        .await
        .map_err(|_| ConnectorError::transient("SMTP transport failed"))?;
    let (_, response) = pre_tls_response(&mut stream).await?;
    if !response.has_code(220) || !stream.buffer().is_empty() {
        return Err(refused());
    }
    Ok((stream.into_inner().into_inner(), greeting.into_bytes()))
}
async fn pre_tls_response(
    stream: &mut tokio::io::BufReader<socket::SmtpRead<jt_outbound::TcpStream>>,
) -> Result<(String, Response), ConnectorError> {
    use tokio::io::AsyncBufReadExt;
    let invalid = || ConnectorError::permanent("invalid SMTP STARTTLS response");
    let mut response = String::new();
    loop {
        let start = response.len();
        if stream.read_line(&mut response).await.map_err(|err| {
            if err.kind() == std::io::ErrorKind::InvalidData {
                invalid()
            } else {
                ConnectorError::transient("SMTP transport failed")
            }
        })? == 0
        {
            return Err(ConnectorError::transient("SMTP connection closed"));
        }
        let line = &response.as_bytes()[start..];
        if !line.ends_with(b"\n") {
            return Err(ConnectorError::transient(
                "SMTP connection closed during response",
            ));
        }
        if line.len() < 5 || !line[..3].iter().all(u8::is_ascii_digit) || !line.ends_with(b"\r\n") {
            return Err(invalid());
        }
        match line[3] {
            b'-' => {}
            b' ' => {
                let parsed: Response = response.parse().map_err(|_| invalid())?;
                match u16::from(parsed.code()) / 100 {
                    4 => {
                        return Err(ConnectorError::transient(
                            "SMTP temporarily refused request",
                        ));
                    }
                    5 => return Err(ConnectorError::permanent("SMTP request refused")),
                    _ => {}
                }
                return Ok((response, parsed));
            }
            _ => return Err(invalid()),
        }
    }
}
pub(crate) async fn sender(
    smtp: &mut AsyncSmtpConnection,
    cred: &MailCred<'_>,
) -> Result<(), ConnectorError> {
    sender_with_utf8(smtp, cred, !cred.from_address.is_ascii()).await
}
async fn sender_with_utf8(
    smtp: &mut AsyncSmtpConnection,
    cred: &MailCred<'_>,
    needs_utf8: bool,
) -> Result<(), ConnectorError> {
    let mut options = vec![];
    if needs_utf8 {
        if !smtp.server_info().supports_feature(Extension::SmtpUtfEight) {
            return Err(ConnectorError::permanent("smtputf8 not supported"));
        }
        options.push(MailParameter::SmtpUtfEight);
    }
    let address = cred
        .from_address
        .parse()
        .map_err(|_| ConnectorError::permanent("invalid mail sender"))?;
    smtp.command(Mail::new(Some(address), options))
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
        let header_end = bytes
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .unwrap_or(bytes.len());
        // RFC 2047 encoded words are ASCII on the wire and do not need SMTPUTF8.
        let needs_utf8 = !cred.from_address.is_ascii()
            || !recipient.to_string().is_ascii()
            || !bytes[..header_end].is_ascii();
        sender_with_utf8(&mut smtp, cred, needs_utf8).await?;
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
