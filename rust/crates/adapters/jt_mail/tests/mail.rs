use jt_outbound::{Egress, EgressError, EgressScope};
use jt_tenancy::WorkspaceId;
use std::{sync::Arc, time::Duration};

#[tokio::test]
async fn socket_checks_tenant_host_after_retirement() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let egress = Egress::new(&[]);
    let ws = WorkspaceId::new_v7();
    egress.allow_tenant_host(ws, "localhost");
    let socket = egress
        .connect_public(
            EgressScope::Tenant(ws),
            "localhost",
            port,
            Duration::from_secs(1),
        )
        .await
        .unwrap();
    let _accepted = listener.accept().await.unwrap();
    drop(socket);
    assert!(matches!(
        egress
            .connect_public(
                EgressScope::Tenant(WorkspaceId::new_v7()),
                "localhost",
                port,
                Duration::from_secs(1)
            )
            .await,
        Err(EgressError::HostNotAllowed { .. })
    ));
    egress.revoke_tenant_host(ws, "localhost");
    assert!(matches!(
        egress
            .connect_public(
                EgressScope::Tenant(ws),
                "localhost",
                port,
                Duration::from_secs(1)
            )
            .await,
        Err(EgressError::HostNotAllowed { .. })
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn mail_socket_refuses_a_public_name_resolving_to_private_space() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let egress = Egress::with_test_lookup(&[], |_host, port| {
        Box::pin(async move {
            Ok([
                "127.0.0.1",
                "10.0.0.1",
                "169.254.169.254",
                "::ffff:192.168.1.1",
            ]
            .iter()
            .map(|ip| std::net::SocketAddr::new(ip.parse().unwrap(), port))
            .collect())
        })
    });
    let ws = WorkspaceId::new_v7();
    egress.allow_tenant_host(ws, "mail.example.com");
    assert!(matches!(
        egress
            .connect_public(
                EgressScope::Tenant(ws),
                "mail.example.com",
                port,
                Duration::from_secs(1)
            )
            .await,
        Err(EgressError::NotPublic { .. })
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
}

mod support;
use jt_app::ports::connectors::{
    Attachment, Connector, MailSender, MailboxCursor, MailboxPoller, MailboxPosition,
};
use jt_connector::{ConnectorError, EventKind, MailTls};
use jt_mail::MailConnector;
use serde_json::json;
use support::*;

fn workspace() -> WorkspaceId {
    "11111111-1111-4111-8111-111111111111".parse().unwrap()
}

fn connector() -> MailConnector {
    let egress = Arc::new(Egress::new(&[]));
    let ws = workspace();
    egress.allow_tenant_host(ws, "localhost");
    MailConnector::new(egress)
        .with_root_certificate(CA.to_vec())
        .unwrap()
}

#[tokio::test]
async fn smtp_starttls_stable_message_id() {
    let (port, task) = smtp(SmtpMode {
        starttls: true,
        ..Default::default()
    })
    .await;
    let receipt = connector()
        .send(
            workspace(),
            &credential(port, 143, MailTls::StartTls),
            message(),
        )
        .await
        .unwrap();
    assert_eq!(receipt.provider_id, "<stable@example.com>");
    let bytes = task.await.unwrap();
    let parsed = mailparse::parse_mail(&bytes).unwrap();
    use mailparse::MailHeaderMap;
    assert_eq!(
        parsed.headers.get_first_value("Message-ID").unwrap(),
        "<stable@example.com>"
    );
}

#[tokio::test]
async fn mail_sender_preserves_thread_headers_and_ics_attachment() {
    let (port, task) = smtp(SmtpMode::default()).await;
    let mut msg = message();
    let bytes = b"BEGIN:VCALENDAR\r\nPRIVATE-ATTACHMENT\r\nEND:VCALENDAR\r\n";
    msg.attachments.push(Attachment {
        filename: "meeting.ics".into(),
        mime: "text/calendar; charset=utf-8".into(),
        bytes: bytes.to_vec(),
    });
    assert!(!format!("{msg:?}").contains("PRIVATE-ATTACHMENT"));
    connector()
        .send(workspace(), &credential(port, 993, MailTls::Implicit), msg)
        .await
        .unwrap();
    let wire = task.await.unwrap();
    let parsed = mailparse::parse_mail(&wire).unwrap();
    use mailparse::MailHeaderMap;
    assert_eq!(
        parsed.headers.get_first_value("In-Reply-To").unwrap(),
        "<parent@example.com>"
    );
    assert_eq!(
        parsed.headers.get_first_value("References").unwrap(),
        "<root@example.com> <parent@example.com>"
    );
    assert_eq!(parsed.subparts[0].get_body().unwrap(), "See you");
    assert_eq!(parsed.subparts[1].get_body_raw().unwrap(), bytes);
    assert_eq!(
        parsed.subparts[1].get_content_disposition().params["filename"],
        "meeting.ics"
    );
    assert_eq!(parsed.subparts[1].ctype.mimetype, "text/calendar");
}

#[tokio::test]
async fn smtp_accepted_answer_lost_is_unknown() {
    let (port, task) = smtp(SmtpMode {
        lost: true,
        ..Default::default()
    })
    .await;
    let err = connector()
        .send(
            workspace(),
            &credential(port, 993, MailTls::Implicit),
            message(),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ConnectorError::Unknown { .. }));
    assert!(!err.is_retriable());
    assert!(!task.await.unwrap().is_empty());
}

fn bound_id(port: u16, account: &str, mailbox: &str, validity: u32, uid: u32) -> String {
    use sha2::{Digest, Sha256};
    let hash: String = Sha256::digest(format!("localhost:{port}"))
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    format!("imap:{account}:{}:{mailbox}:{validity}:{uid}", &hash[..12])
}

#[tokio::test]
async fn imap_account_mailbox_uid_dedupe() {
    let (port, task) = imap(false, 42, BODY.to_vec(), 3).await;
    let connector = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let (events, cursor) = connector
        .poll(
            workspace(),
            &cred,
            &json!({"external_id":"account-a"}),
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0].external_id,
        bound_id(port, "account-a", "INBOX", 42, 7)
    );
    assert_eq!(
        events[1].external_id,
        bound_id(port, "account-a", "Sent", 42, 7)
    );
    assert_eq!(events[0].payload["subject"], "Hello");
    assert_eq!(events[0].payload["text"], "hello\r\n");
    assert_eq!(events[0].payload["in_reply_to"], "<parent@example.com>");
    assert!(events[0].occurred_at.is_some());
    let (again, next) = connector
        .poll(
            workspace(),
            &cred,
            &json!({"external_id":"account-a"}),
            &cursor,
        )
        .await
        .unwrap();
    assert!(again.is_empty());
    assert_eq!(next, cursor);
    let (other, _) = connector
        .poll(
            workspace(),
            &cred,
            &json!({"external_id":"account-b"}),
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert_eq!(
        other[0].external_id,
        bound_id(port, "account-b", "INBOX", 42, 7)
    );
    task.await.unwrap();
}

#[tokio::test]
async fn a_newly_connected_mailbox_starts_at_its_end_without_its_history() {
    let (port, task) = imap(false, 42, BODY.to_vec(), 2).await;
    let connector = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let public = json!({"external_id":"account"});
    let (events, cursor) = connector
        .poll(workspace(), &cred, &public, &MailboxCursor::default())
        .await
        .unwrap();
    // The message already in INBOX and Sent (UID 7) is history: recorded as the start, not read.
    assert!(events.is_empty(), "{events:?}");
    let end = MailboxPosition {
        uidvalidity: 42,
        last_uid: 7,
    };
    assert_eq!(cursor.mailboxes["INBOX"], end);
    assert_eq!(cursor.mailboxes["Sent"], end);
    assert!(!cursor.read_history);
    let (again, next) = connector
        .poll(workspace(), &cred, &public, &cursor)
        .await
        .unwrap();
    assert!(again.is_empty());
    assert_eq!(next, cursor);
    task.await.unwrap();
}

#[tokio::test]
async fn a_uidvalidity_change_does_not_reimport_history() {
    let (port, task) = imap(true, 43, BODY.to_vec(), 1).await;
    let mut cursor = MailboxCursor::default();
    cursor.mailboxes.insert(
        "INBOX".into(),
        MailboxPosition {
            uidvalidity: 42,
            last_uid: 500,
        },
    );
    let (events, next) = connector()
        .poll(
            workspace(),
            &credential(587, port, MailTls::StartTls),
            &json!({"external_id":"account"}),
            &cursor,
        )
        .await
        .unwrap();
    assert!(events.is_empty(), "{events:?}");
    assert_eq!(
        next.mailboxes["INBOX"],
        MailboxPosition {
            uidvalidity: 43,
            last_uid: 7
        }
    );
    task.await.unwrap();
}

#[tokio::test]
async fn uidvalidity_reset() {
    let (port, task) = imap(true, 43, BODY.to_vec(), 1).await;
    let mut cursor = MailboxCursor::reading_history();
    cursor.mailboxes.insert(
        "INBOX".into(),
        MailboxPosition {
            uidvalidity: 42,
            last_uid: 500,
        },
    );
    let (events, next) = connector()
        .poll(
            workspace(),
            &credential(587, port, MailTls::StartTls),
            &json!({"external_id":"account"}),
            &cursor,
        )
        .await
        .unwrap();
    assert_eq!(
        events[0].external_id,
        bound_id(port, "account", "INBOX", 43, 7)
    );
    assert_eq!(
        next.mailboxes["INBOX"],
        MailboxPosition {
            uidvalidity: 43,
            last_uid: 7
        }
    );
    task.await.unwrap();
}

#[tokio::test]
async fn sent_echo_reconciles_unknown() {
    let (port, task) = imap(false, 42, BODY.to_vec(), 1).await;
    let (events, _) = connector()
        .poll(
            workspace(),
            &credential(465, port, MailTls::Implicit),
            &json!({"external_id":"account"}),
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert_eq!(events[1].kind, EventKind::Status);
    assert_eq!(events[1].payload["status"], "sent");
    assert_eq!(events[1].payload["message_id"], "<stable@example.com>");
    task.await.unwrap();
}

#[tokio::test]
async fn probe_authenticated_username_and_authorized_sender() {
    for rejected in [false, true] {
        let (smtp_port, smtp_task) = smtp(SmtpMode {
            reject_sender: rejected,
            ..Default::default()
        })
        .await;
        let (imap_port, imap_task) = imap(false, 1, BODY.to_vec(), 1).await;
        let result = connector()
            .probe(
                &credential(smtp_port, imap_port, MailTls::Implicit),
                &json!({"kind_key":"mailbox", "workspace_id":workspace(), "external_id":"untrusted-id"}),
            )
            .await;
        assert_eq!(result.ok, !rejected);
        if !rejected {
            assert_eq!(result.facts["account_id"], "private-login");
        } else {
            assert!(matches!(
                result.error,
                Some(ConnectorError::Permission { .. })
            ));
        }
        smtp_task.await.unwrap();
        imap_task.await.unwrap();
    }
}

#[tokio::test]
async fn bounce_and_consent_payload_fixtures() {
    let fixtures: &[(&[u8], EventKind)] = &[
        (include_bytes!("fixtures/bounce.eml"), EventKind::Status),
        (
            include_bytes!("fixtures/withdrawal.eml"),
            EventKind::Consent,
        ),
    ];
    for (body, kind) in fixtures {
        let (port, task) = imap(false, 42, body.to_vec(), 1).await;
        let (events, _) = connector()
            .poll(
                workspace(),
                &credential(465, port, MailTls::Implicit),
                &json!({"external_id":"account"}),
                &MailboxCursor::reading_history(),
            )
            .await
            .unwrap();
        assert_eq!(&events[0].kind, kind);
        if *kind == EventKind::Status {
            assert_eq!(events[0].payload["status"], "failed");
            assert_eq!(events[0].payload["message_id"], "<original@example.com>");
        } else {
            assert_eq!(events[0].payload["withdrawn"], true);
        }
        assert!(!format!("{:?}", events).contains("PRIVATE-ATTACHMENT"));
        task.await.unwrap();
    }
}

#[tokio::test]
async fn tls_required() {
    let (port, task) = smtp(SmtpMode {
        starttls: true,
        no_tls: true,
        ..Default::default()
    })
    .await;
    assert!(
        connector()
            .send(
                workspace(),
                &credential(port, 143, MailTls::StartTls),
                message()
            )
            .await
            .is_err()
    );
    task.await.unwrap();
    let (port, task) = smtp(SmtpMode::default()).await;
    let egress = Arc::new(Egress::new(&[]));
    let ws = WorkspaceId::new_v7();
    egress.allow_tenant_host(ws, "localhost");
    // Untrusted issuer: no permissive TLS verifier even in a loopback build.
    assert!(
        MailConnector::new(egress)
            .send(ws, &credential(port, 993, MailTls::Implicit), message())
            .await
            .is_err()
    );
    task.await.unwrap();
}

#[tokio::test]
async fn no_password_in_errors() {
    let (port, task) = smtp(SmtpMode {
        reject_auth: true,
        ..Default::default()
    })
    .await;
    let cred = credential(port, 993, MailTls::Implicit);
    let err = connector()
        .send(workspace(), &cred, message())
        .await
        .unwrap_err();
    assert!(matches!(err, ConnectorError::Auth { .. }));
    for secret in ["mail-password", "private-login"] {
        assert!(!format!("{err} {err:?} {cred:?}").contains(secret));
    }
    task.await.unwrap();
}

#[test]
fn mail_wire_trace_is_compiled_out() {
    // The IMAP library traces raw LOGIN commands and literal MIME bodies. This assertion
    // protects against a feature change that silently enables those records again.
    assert!(log::STATIC_MAX_LEVEL <= log::LevelFilter::Debug);
}

#[tokio::test]
async fn tls_verifies_the_declared_hostname_in_both_modes() {
    for starttls in [false, true] {
        let (port, task) = smtp(SmtpMode {
            starttls,
            wrong_host: true,
            ..Default::default()
        })
        .await;
        let tls = if starttls {
            MailTls::StartTls
        } else {
            MailTls::Implicit
        };
        let err = connector()
            .send(workspace(), &credential(port, 993, tls), message())
            .await
            .unwrap_err();
        assert!(matches!(err, ConnectorError::Permanent { .. }));
        assert!(task.await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn mail_rejects_header_injection_before_connect() {
    let mut msg = message();
    msg.message_id = "<id@example.com>\r\nBcc: other@example.com".into();
    let err = connector()
        .send(workspace(), &credential(465, 993, MailTls::Implicit), msg)
        .await
        .unwrap_err();
    assert!(matches!(err, ConnectorError::Permanent { .. }));
}

#[tokio::test]
async fn poison_mail_is_rejected_without_blocking_the_next_uid() {
    let mut nested = String::new();
    for i in 0..100 {
        nested.push_str(&format!(
            "Content-Type: multipart/mixed; boundary=b{i}\r\n\r\n--b{i}\r\n"
        ));
    }
    nested.push_str("Content-Type: text/plain\r\n\r\nPRIVATE-ATTACHMENT\r\n");
    for i in (0..100).rev() {
        nested.push_str(&format!("--b{i}--\r\n"));
    }
    let messages = vec![
        (1, BODY.len() as u32, BODY.to_vec()),
        (2, 11 * 1024 * 1024, vec![]),
        (3, nested.len() as u32, nested.into_bytes()),
        (4, BODY.len() as u32, BODY.to_vec()),
    ];
    let (port, task) = imap_messages(false, 77, messages, 2).await;
    let connector = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let (events, cursor) = connector
        .poll(
            workspace(),
            &cred,
            &json!({"external_id":"account"}),
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert_eq!(events.len(), 8);
    for i in [1, 2, 5, 6] {
        assert_eq!(events[i].kind, EventKind::Unknown("mail_rejected".into()));
        assert!(!events[i].payload.to_string().contains("PRIVATE-ATTACHMENT"));
    }
    assert_eq!(cursor.mailboxes["INBOX"].last_uid, 4);
    assert_eq!(events[3].kind, EventKind::Message);
    assert_eq!(events[7].kind, EventKind::Status);
    let (again, next) = connector
        .poll(
            workspace(),
            &cred,
            &json!({"external_id":"account"}),
            &cursor,
        )
        .await
        .unwrap();
    assert!(again.is_empty());
    assert_eq!(cursor, next);
    task.await.unwrap();
}

#[tokio::test]
async fn socket_resolution_has_a_deadline() {
    let egress = Egress::with_test_lookup(&[], |_, _| Box::pin(std::future::pending()));
    let ws = WorkspaceId::new_v7();
    egress.allow_tenant_host(ws, "smtp.example.com");
    let start = std::time::Instant::now();
    assert!(matches!(
        egress
            .connect_public(
                EgressScope::Tenant(ws),
                "smtp.example.com",
                465,
                Duration::from_millis(20)
            )
            .await,
        Err(EgressError::Socket)
    ));
    assert!(start.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn smtp_invalid_final_answer_is_unknown() {
    let (port, task) = smtp(SmtpMode {
        invalid_final: true,
        ..Default::default()
    })
    .await;
    let err = connector()
        .send(
            workspace(),
            &credential(port, 993, MailTls::Implicit),
            message(),
        )
        .await
        .unwrap_err();
    assert!(matches!(err, ConnectorError::Unknown { .. }));
    assert!(!task.await.unwrap().is_empty());
}

#[tokio::test]
async fn imap_rejects_oversized_literal_before_waiting_for_body() {
    let (port, task) = malicious_imap().await;
    let connector = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let public = json!({"external_id":"account"});
    let result = tokio::time::timeout(
        Duration::from_millis(300),
        connector.poll(
            workspace(),
            &cred,
            &public,
            &MailboxCursor::reading_history(),
        ),
    )
    .await;
    task.await.unwrap();
    assert!(
        result
            .expect("reject the header without waiting for the literal body")
            .is_err()
    );
}

#[tokio::test]
async fn list_unsubscribe_advertisement_is_not_withdrawal() {
    let mut body = b"List-Unsubscribe: <mailto:unsubscribe@example.com>\r\n".to_vec();
    body.extend_from_slice(BODY);
    // Literal-looking text inside a MIME body must not be mistaken for IMAP framing.
    body.extend_from_slice(b"{33554432}\r\n");
    let (port, task) = imap(false, 42, body, 1).await;
    let (events, _) = connector()
        .poll(
            workspace(),
            &credential(465, port, MailTls::Implicit),
            &json!({"external_id":"account"}),
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert_eq!(events[0].kind, EventKind::Message);
    assert!(events[0].payload.get("withdrawn").is_none());
    assert!(
        events[0].payload["text"]
            .as_str()
            .unwrap()
            .contains("{33554432}")
    );
    task.await.unwrap();
}

#[tokio::test]
async fn discovers_sent_folders_and_keeps_inbox_when_sent_is_missing() {
    for mode in [
        ImapMode {
            sent: Some("Sent Items"),
            special_use: false,
            ..Default::default()
        },
        ImapMode {
            sent: Some("[Gmail]/Sent Mail"),
            ..Default::default()
        },
        ImapMode {
            sent: Some("Gonderilen"),
            ..Default::default()
        },
        ImapMode {
            sent: None,
            ..Default::default()
        },
        ImapMode {
            missing_sent: true,
            ..Default::default()
        },
    ] {
        let (port, task) = imap_with_mode(
            false,
            42,
            vec![(7, BODY.len() as u32, BODY.to_vec())],
            1,
            mode.clone(),
        )
        .await;
        let (events, cursor) = connector()
            .poll(
                workspace(),
                &credential(465, port, MailTls::Implicit),
                &json!({"external_id":"account"}),
                &MailboxCursor::reading_history(),
            )
            .await
            .unwrap();
        assert_eq!(events[0].kind, EventKind::Message);
        assert_eq!(cursor.mailboxes["INBOX"].last_uid, 7);
        if let Some(sent) = mode.sent.filter(|_| !mode.missing_sent) {
            assert_eq!(events.len(), 2);
            assert_eq!(events[1].kind, EventKind::Status);
            assert_eq!(events[1].payload["status"], "sent");
            assert_eq!(
                events[1].external_id,
                bound_id(port, "account", sent, 42, 7)
            );
            assert_eq!(cursor.mailboxes[sent].last_uid, 7);
        } else {
            assert_eq!(events.len(), 1);
        }
        task.await.unwrap();
    }
}

#[tokio::test]
async fn html_only_mail_has_readable_text_and_plain_alternative_wins() {
    for (mime, expected) in [
        (
            "Content-Type: text/html; charset=utf-8\r\n\r\n<p>Please call me &amp; Alex</p><script>privateScript()</script>",
            "Please call me & Alex",
        ),
        (
            "Content-Type: text/html; charset=utf-8\r\n\r\n<head><meta charset=\"utf-8\"><body><p>Please call me</p></body>",
            "Please call me",
        ),
        (
            "Content-Type: text/html; charset=utf-8\r\n\r\n<head><title>Private title</title><meta charset=\"utf-8\"><p>Please call me</p>",
            "Please call me",
        ),
        (
            "Content-Type: multipart/alternative; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nPlain wins\r\n--b\r\nContent-Type: text/html\r\n\r\n<p>HTML alternative</p>\r\n--b--\r\n",
            "Plain wins",
        ),
    ] {
        let (port, task) = imap(false, 42, mime.as_bytes().to_vec(), 1).await;
        let (events, _) = connector()
            .poll(
                workspace(),
                &credential(465, port, MailTls::Implicit),
                &json!({"external_id":"account"}),
                &MailboxCursor::reading_history(),
            )
            .await
            .unwrap();
        assert_eq!(events[0].kind, EventKind::Message);
        assert_eq!(events[0].payload["text"].as_str().unwrap().trim(), expected);
        task.await.unwrap();
    }
}

#[tokio::test]
async fn slow_fetch_batch_returns_completed_cursor_progress() {
    let messages = (1..=100)
        .map(|uid| (uid, BODY.len() as u32, BODY.to_vec()))
        .collect();
    let (port, task) = imap_with_mode(
        false,
        42,
        messages,
        2,
        ImapMode {
            sent: None,
            body_delay: Duration::from_millis(130),
            ..Default::default()
        },
    )
    .await;
    let conn = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let (first, cursor) = conn
        .poll(
            workspace(),
            &cred,
            &json!({"external_id":"account"}),
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert!(!first.is_empty());
    assert!(
        first.len() < 100,
        "long batches should return partial progress"
    );
    assert_eq!(cursor.mailboxes["INBOX"].last_uid as usize, first.len());
    let (second, cursor) = conn
        .poll(
            workspace(),
            &cred,
            &json!({"external_id":"account"}),
            &cursor,
        )
        .await
        .unwrap();
    assert_eq!(first.len() + second.len(), 100);
    assert_eq!(cursor.mailboxes["INBOX"].last_uid, 100);
    assert!(
        second
            .iter()
            .all(|event| !first.iter().any(|old| old.external_id == event.external_id))
    );
    task.await.unwrap();
}

#[tokio::test]
async fn completed_poll_does_not_wait_for_logout() {
    let (port, task) = imap_with_mode(
        false,
        42,
        vec![(7, BODY.len() as u32, BODY.to_vec())],
        1,
        ImapMode {
            stall_logout: true,
            ..Default::default()
        },
    )
    .await;
    let conn = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let public = json!({"external_id":"account"});
    let cursor = MailboxCursor::reading_history();
    let (events, cursor) = tokio::time::timeout(
        Duration::from_secs(1),
        conn.poll(workspace(), &cred, &public, &cursor),
    )
    .await
    .expect("cleanup must not delay completed polling")
    .unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(cursor.mailboxes["Sent"].last_uid, 7);
    task.await.unwrap();
}

#[tokio::test]
async fn smtp_rejects_encoded_oversize_before_opening_a_socket() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut mail = message();
    mail.attachments.push(Attachment {
        filename: "large.bin".into(),
        mime: "application/octet-stream".into(),
        bytes: vec![0; 8 * 1024 * 1024],
    });
    let result = tokio::time::timeout(
        Duration::from_secs(2),
        connector().send(
            workspace(),
            &credential(
                listener.local_addr().unwrap().port(),
                993,
                MailTls::Implicit,
            ),
            mail,
        ),
    )
    .await
    .expect("reject before connecting");
    assert!(matches!(result, Err(ConnectorError::Permanent { .. })));
    assert!(
        tokio::time::timeout(Duration::from_millis(20), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn shared_mail_adapter_uses_each_calls_workspace_and_live_revocations() {
    let egress = Arc::new(Egress::new(&[]));
    let a = WorkspaceId::new_v7();
    let b = WorkspaceId::new_v7();
    egress.allow_tenant_host(a, "localhost");
    let mail = MailConnector::new(egress.clone())
        .with_root_certificate(CA.to_vec())
        .unwrap();
    let (smtp_port, smtp_task) = smtp(SmtpMode::default()).await;
    let (imap_port, imap_task) = imap(false, 42, BODY.to_vec(), 1).await;
    let cred = credential(smtp_port, imap_port, MailTls::Implicit);
    let public = json!({"kind_key":"mailbox", "external_id":"account", "workspace_id":a});
    assert!(matches!(
        mail.send(b, &cred, message()).await,
        Err(ConnectorError::Permission { .. })
    ));
    assert!(
        matches!(
            mail.poll(b, &cred, &public, &MailboxCursor::reading_history())
                .await,
            Err(ConnectorError::Permission { .. })
        ),
        "public cannot override the explicit workspace"
    );
    let foreign = json!({"kind_key":"mailbox", "workspace_id":b});
    assert!(matches!(
        mail.probe(&cred, &foreign).await.error,
        Some(ConnectorError::Permission { .. })
    ));
    assert!(mail.send(a, &cred, message()).await.is_ok());
    assert!(
        mail.poll(a, &cred, &public, &MailboxCursor::reading_history())
            .await
            .is_ok()
    );
    smtp_task.await.unwrap();
    imap_task.await.unwrap();
    egress.revoke_tenant_host(a, "localhost");
    assert!(matches!(
        mail.send(a, &cred, message()).await,
        Err(ConnectorError::Permission { .. })
    ));
    assert!(matches!(
        mail.poll(a, &cred, &public, &MailboxCursor::reading_history())
            .await,
        Err(ConnectorError::Permission { .. })
    ));
    egress.allow_tenant_host(b, "localhost");
    let (port, task) = smtp(SmtpMode::default()).await;
    assert!(
        mail.send(
            b,
            &credential(port, imap_port, MailTls::Implicit),
            message()
        )
        .await
        .is_ok()
    );
    task.await.unwrap();
}

#[tokio::test]
async fn mail_probe_and_connection_step_require_a_valid_workspace() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let cred = credential(
        listener.local_addr().unwrap().port(),
        listener.local_addr().unwrap().port(),
        MailTls::Implicit,
    );
    for public in [
        json!({"kind_key":"mailbox"}),
        json!({"kind_key":"mailbox", "workspace_id":"invalid"}),
    ] {
        assert!(!connector().probe(&cred, &public).await.ok);
        assert!(connector().on_connected(&cred, &public).await.is_err());
    }
    assert!(
        tokio::time::timeout(Duration::from_millis(30), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn smtp_line_longer_than_limit_is_refused_without_buffering() {
    assert_oversized_smtp_is_refused(false, false).await;
}

#[tokio::test]
async fn smtp_multiline_response_longer_than_limit_is_refused() {
    assert_oversized_smtp_is_refused(true, false).await;
}

#[tokio::test]
async fn smtp_bare_lf_cannot_reset_the_read_limit() {
    assert_oversized_smtp_is_refused(false, true).await;
}

async fn assert_oversized_smtp_is_refused(multiline: bool, bare_lf: bool) {
    for (starttls, before_tls) in [(false, true), (false, false), (true, true), (true, false)] {
        let (port, task) = smtp(SmtpMode {
            starttls,
            oversized: Some((before_tls, multiline)),
            bare_lf,
            ..Default::default()
        })
        .await;
        let tls = if starttls {
            MailTls::StartTls
        } else {
            MailTls::Implicit
        };
        let result = tokio::time::timeout(
            Duration::from_millis(500),
            connector().send(workspace(), &credential(port, 993, tls), message()),
        )
        .await;
        task.await.unwrap();
        assert!(
            result
                .expect("reject before server sends a terminator")
                .is_err()
        );
    }
}

#[tokio::test]
async fn smtputf8_negotiated_for_international_addresses() {
    check_smtputf8(true).await;
}

#[tokio::test]
async fn smtputf8_missing_is_permanent_error() {
    check_smtputf8(false).await;
}

async fn check_smtputf8(advertised: bool) {
    for starttls in [false, true] {
        for variant in 0..2 {
            let (port, task) = smtp(SmtpMode {
                starttls,
                smtputf8: advertised,
                utf8_from: variant == 0,
                utf8_to: variant == 1,
                ..Default::default()
            })
            .await;
            let tls = if starttls {
                MailTls::StartTls
            } else {
                MailTls::Implicit
            };
            let mut cred = credential(port, 993, tls);
            let mut mail = message();
            match variant {
                0 => {
                    let jt_connector::Credential::Mailbox { from_address, .. } = &mut cred else {
                        unreachable!()
                    };
                    *from_address = "çağrı@example.com".into();
                }
                _ => mail.to = "çağrı@example.com".into(),
            }
            let result = connector().send(workspace(), &cred, mail).await;
            if advertised {
                result.unwrap();
            } else {
                assert!(
                    matches!(result, Err(ConnectorError::Permanent { ref reason, .. }) if reason == "smtputf8 not supported")
                );
            }
            task.await.unwrap();
        }
    }
}

#[tokio::test]
async fn smtp_encoded_unicode_headers_do_not_require_smtputf8() {
    use mailparse::MailHeaderMap;
    for starttls in [false, true] {
        let (port, task) = smtp(SmtpMode {
            starttls,
            ..Default::default()
        })
        .await;
        let tls = if starttls {
            MailTls::StartTls
        } else {
            MailTls::Implicit
        };
        let mut mail = message();
        mail.to = "Çağrı <person@example.com>".into();
        mail.subject = "Merhaba dünya".into();
        mail.message_id = "<çağrı@example.com>".into();
        mail.in_reply_to = Some("<önceki@example.com>".into());
        mail.references = vec!["<önceki@example.com>".into()];
        let receipt = connector()
            .send(workspace(), &credential(port, 993, tls), mail)
            .await
            .unwrap();
        assert_eq!(receipt.provider_id, "<çağrı@example.com>");
        let bytes = task.await.unwrap();
        let header_end = bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap();
        assert!(
            bytes[..header_end].is_ascii(),
            "encoded headers require no SMTPUTF8"
        );
        let parsed = mailparse::parse_mail(&bytes).unwrap();
        assert_eq!(
            parsed.headers.get_first_value("Subject").as_deref(),
            Some("Merhaba dünya")
        );
        assert_eq!(
            parsed.headers.get_first_value("To").as_deref(),
            Some("Çağrı <person@example.com>")
        );
    }
}

#[tokio::test]
async fn smtp_starttls_setup_preserves_transient_failures() {
    for ehlo in [false, true] {
        for (response, transient) in [
            ("421 temporarily unavailable\r\n", true),
            ("451 try later\r\n", true),
            ("", true),
            ("220 interrupted reply", true),
            ("220 bare newline\n", false),
            ("550 refused\r\n", false),
            ("invalid reply\r\n", false),
        ] {
            let (port, task) = smtp(SmtpMode {
                starttls: true,
                pre_tls_failure: Some((ehlo, response)),
                ..Default::default()
            })
            .await;
            let err = connector()
                .send(
                    workspace(),
                    &credential(port, 993, MailTls::StartTls),
                    message(),
                )
                .await
                .unwrap_err();
            if transient {
                assert!(
                    matches!(err, ConnectorError::Transient { .. }),
                    "{response:?}: {err:?}"
                );
            } else {
                assert!(
                    matches!(err, ConnectorError::Permanent { .. }),
                    "{response:?}: {err:?}"
                );
            }
            task.await.unwrap();
        }
    }
}

#[tokio::test]
async fn imap_server_change_does_not_collide_with_stored_events() {
    let messages = vec![
        (1, BODY.len() as u32, BODY.to_vec()),
        (2, 11 * 1024 * 1024, vec![]),
    ];
    let (port_a, task_a) = imap_messages(false, 42, messages.clone(), 1).await;
    let (port_b, task_b) = imap_messages(false, 42, messages, 1).await;
    let conn = connector();
    let public = json!({"external_id":"same-account"});
    let (stored, _) = conn
        .poll(
            workspace(),
            &credential(465, port_a, MailTls::Implicit),
            &public,
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    // Credential rebinding resets the cursor, but retains the external account and old events.
    let (new, _) = conn
        .poll(
            workspace(),
            &credential(465, port_b, MailTls::Implicit),
            &public,
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert_eq!(stored.len(), 4);
    assert_eq!(new.len(), 4);
    assert!(new.iter().all(|event| {
        stored
            .iter()
            .all(|old| old.external_id != event.external_id)
    }));
    assert_eq!(new[1].kind, EventKind::Unknown("mail_rejected".into()));
    task_a.await.unwrap();
    task_b.await.unwrap();
}

#[tokio::test]
async fn imap_poll_fetches_sparse_high_uids_immediately() {
    let (port, task) = imap_with_mode(
        false,
        42,
        vec![(1_000_000, BODY.len() as u32, BODY.to_vec())],
        2,
        ImapMode {
            sent: None,
            esearch: true,
            ..Default::default()
        },
    )
    .await;
    let conn = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let public = json!({"external_id":"account"});
    let (events, cursor) = conn
        .poll(
            workspace(),
            &cred,
            &public,
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].payload["text"], "hello\r\n");
    assert_eq!(cursor.mailboxes["INBOX"].last_uid, 1_000_000);
    let (again, next) = conn
        .poll(workspace(), &cred, &public, &cursor)
        .await
        .unwrap();
    assert!(again.is_empty());
    assert_eq!(next, cursor);
    task.await.unwrap();
}

#[tokio::test]
async fn imap_poll_caps_total_messages_and_resumes_existing_uids() {
    for esearch in [false, true] {
        let messages = (1..=101)
            .map(|n| (n * 10, BODY.len() as u32, BODY.to_vec()))
            .collect();
        let (port, task) = imap_with_mode(
            false,
            42,
            messages,
            3,
            ImapMode {
                esearch,
                ..Default::default()
            },
        )
        .await;
        let conn = connector();
        let cred = credential(465, port, MailTls::Implicit);
        let public = json!({"external_id":"account"});
        let (first, cursor) = conn
            .poll(
                workspace(),
                &cred,
                &public,
                &MailboxCursor::reading_history(),
            )
            .await
            .unwrap();
        assert_eq!(first.len(), 100);
        assert_eq!(cursor.mailboxes["INBOX"].last_uid, 1_000);
        let (second, cursor) = conn
            .poll(workspace(), &cred, &public, &cursor)
            .await
            .unwrap();
        assert_eq!(second.len(), 100);
        assert_eq!(cursor.mailboxes["INBOX"].last_uid, 1_010);
        assert_eq!(cursor.mailboxes["Sent"].last_uid, 990);
        let (third, cursor) = conn
            .poll(workspace(), &cred, &public, &cursor)
            .await
            .unwrap();
        assert_eq!(third.len(), 2);
        assert_eq!(cursor.mailboxes["Sent"].last_uid, 1_010);
        let ids: std::collections::HashSet<_> = first
            .iter()
            .chain(&second)
            .chain(&third)
            .map(|e| &e.external_id)
            .collect();
        assert_eq!(ids.len(), 202);
        task.await.unwrap();
    }
}

#[tokio::test]
async fn imap_large_mailbox_makes_progress_with_bounded_search_results() {
    let searches = Arc::new(std::sync::Mutex::new(Vec::new()));
    let messages = (1..=200_000)
        .map(|uid| (uid, BODY.len() as u32, BODY.to_vec()))
        .collect();
    let (port, task) = imap_with_mode(
        false,
        42,
        messages,
        3,
        ImapMode {
            sent: None,
            searches: Some(searches.clone()),
            ..Default::default()
        },
    )
    .await;
    let conn = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let public = json!({"external_id":"account"});
    let mut cursor = MailboxCursor::reading_history();
    let mut ids = std::collections::HashSet::new();
    for poll in 1..=3 {
        let (events, next) = conn
            .poll(workspace(), &cred, &public, &cursor)
            .await
            .unwrap();
        assert_eq!(events.len(), 100);
        assert_eq!(next.mailboxes["INBOX"].last_uid, poll * 100);
        for event in events {
            assert!(ids.insert(event.external_id));
        }
        cursor = next;
    }
    assert_eq!(
        *searches.lock().unwrap(),
        [
            "1:5000", "1:2500", "1:1250", "1:625", "101:5100", "101:2600", "101:1350", "101:725",
            "201:5200", "201:2700", "201:1450", "201:825"
        ]
    );
    task.await.unwrap();
}

#[tokio::test]
async fn imap_empty_scan_stops_at_uidnext_and_does_not_rescan() {
    let searches = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (port, task) = imap_with_mode(
        false,
        42,
        vec![],
        2,
        ImapMode {
            sent: None,
            uid_next: Some(12_346),
            searches: Some(searches.clone()),
            ..Default::default()
        },
    )
    .await;
    let conn = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let public = json!({"external_id":"account"});
    let (events, cursor) = conn
        .poll(
            workspace(),
            &cred,
            &public,
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert!(events.is_empty());
    assert_eq!(cursor.mailboxes["INBOX"].last_uid, 12_345);
    let (events, next) = conn
        .poll(workspace(), &cred, &public, &cursor)
        .await
        .unwrap();
    assert!(events.is_empty());
    assert_eq!(next, cursor);
    assert_eq!(*searches.lock().unwrap(), ["1:5000", "5001:12345"]);
    task.await.unwrap();
}

#[tokio::test]
async fn imap_empty_windows_never_skip_a_pending_body() {
    let messages = vec![
        (1, BODY.len() as u32, BODY.to_vec()),
        (2, BODY.len() as u32, BODY.to_vec()),
    ];
    let (port, task) = imap_with_mode(
        false,
        42,
        messages,
        1,
        ImapMode {
            sent: None,
            uid_next: Some(20_001),
            body_delay: Duration::from_millis(8100),
            ..Default::default()
        },
    )
    .await;
    let (events, cursor) = connector()
        .poll(
            workspace(),
            &credential(465, port, MailTls::Implicit),
            &json!({"external_id":"account"}),
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(
        cursor.mailboxes["INBOX"].last_uid, 1,
        "empty windows after UID 2 cannot skip its unfetched body"
    );
    task.await.unwrap();
}

#[tokio::test]
async fn imap_window_budget_never_skips_an_unscanned_uid() {
    let searches = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (port, task) = imap_with_mode(
        false,
        42,
        (1..=21)
            .map(|n| (n * 5_000, BODY.len() as u32, BODY.to_vec()))
            .collect(),
        2,
        ImapMode {
            searches: Some(searches.clone()),
            ..Default::default()
        },
    )
    .await;
    let conn = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let public = json!({"external_id":"account"});
    let (events, cursor) = conn
        .poll(
            workspace(),
            &cred,
            &public,
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert_eq!(events.len(), 20);
    assert_eq!(cursor.mailboxes["INBOX"].last_uid, 100_000);
    assert!(
        !cursor.mailboxes.contains_key("Sent"),
        "the 20-window budget is shared across folders"
    );
    assert_eq!(searches.lock().unwrap().len(), 20);
    assert_eq!(searches.lock().unwrap().last().unwrap(), "95001:100000");
    let (events, next) = conn
        .poll(workspace(), &cred, &public, &cursor)
        .await
        .unwrap();
    assert_eq!(events.len(), 20);
    assert_eq!(events[0].kind, EventKind::Message);
    assert_eq!(next.mailboxes["INBOX"].last_uid, 105_000);
    assert_eq!(next.mailboxes["Sent"].last_uid, 95_000);
    assert_eq!(searches.lock().unwrap()[20], "100001:105000");
    assert_eq!(searches.lock().unwrap().len(), 40);
    task.await.unwrap();
}

#[tokio::test]
async fn imap_empty_tail_advances_only_after_all_selected_uids_are_fetched() {
    let (port, task) = imap_with_mode(
        false,
        42,
        vec![(7, BODY.len() as u32, BODY.to_vec())],
        1,
        ImapMode {
            sent: None,
            uid_next: Some(12_346),
            ..Default::default()
        },
    )
    .await;
    let (events, cursor) = connector()
        .poll(
            workspace(),
            &credential(465, port, MailTls::Implicit),
            &json!({"external_id":"account"}),
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(cursor.mailboxes["INBOX"].last_uid, 12_345);
    task.await.unwrap();
}

#[tokio::test]
async fn imap_fallback_fetches_sparse_high_uid_within_three_polls() {
    let searches = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (port, task) = imap_with_mode(
        false,
        42,
        vec![(1_000_000, BODY.len() as u32, BODY.to_vec())],
        3,
        ImapMode {
            sent: None,
            searches: Some(searches.clone()),
            ..Default::default()
        },
    )
    .await;
    let conn = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let public = json!({"external_id":"account"});
    let mut cursor = MailboxCursor::reading_history();
    let mut received = Vec::new();
    for _ in 0..3 {
        let (events, next) = conn
            .poll(workspace(), &cred, &public, &cursor)
            .await
            .unwrap();
        received.extend(events);
        cursor = next;
    }
    assert_eq!(received.len(), 1);
    assert_eq!(cursor.mailboxes["INBOX"].last_uid, 1_000_000);
    let scans = searches.lock().unwrap().clone();
    assert_eq!(&scans[..3], ["1:5000", "5001:15000", "15001:35000"]);
    assert!(scans.len() <= 60);
    task.await.unwrap();
}

#[tokio::test]
async fn imap_grown_window_is_bisected_without_losing_dense_tail() {
    let messages = (635_001..=835_000)
        .map(|uid| (uid, BODY.len() as u32, BODY.to_vec()))
        .collect();
    let (port, task) = imap_with_mode(
        false,
        42,
        messages,
        3,
        ImapMode {
            sent: None,
            ..Default::default()
        },
    )
    .await;
    let conn = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let public = json!({"external_id":"account"});
    let mut cursor = MailboxCursor::reading_history();
    for poll in 1..=3 {
        let (events, next) = conn
            .poll(workspace(), &cred, &public, &cursor)
            .await
            .unwrap();
        assert_eq!(events.len(), 100);
        assert_eq!(next.mailboxes["INBOX"].last_uid, 635_000 + poll * 100);
        cursor = next;
    }
    task.await.unwrap();
}

#[tokio::test]
async fn imap_esearch_empty_result_is_bounded_by_uidnext() {
    let searches = Arc::new(std::sync::Mutex::new(Vec::new()));
    let (port, task) = imap_with_mode(
        false,
        42,
        vec![],
        1,
        ImapMode {
            sent: None,
            esearch: true,
            uid_next: Some(12_346),
            esearch_response: Some("* eSeArCh uId"),
            searches: Some(searches.clone()),
            ..Default::default()
        },
    )
    .await;
    let (events, cursor) = connector()
        .poll(
            workspace(),
            &credential(465, port, MailTls::Implicit),
            &json!({"external_id":"account"}),
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert!(events.is_empty());
    assert_eq!(cursor.mailboxes["INBOX"].last_uid, 12_345);
    assert_eq!(*searches.lock().unwrap(), ["MIN 1:*"]);
    task.await.unwrap();
}

#[tokio::test]
async fn imap_esearch_rejects_invalid_or_uncorrelated_results() {
    for response in [
        "* ESEARCH (TAG \"wrong-command\") UID MIN 7",
        "* ESEARCH MIN 7",
        "* ESEARCH UID MIN 0",
        "* ESEARCH UID MIN 7 MIN 8",
        "* SEARCH 7",
    ] {
        let (port, task) = imap_with_mode(
            false,
            42,
            vec![(7, BODY.len() as u32, BODY.to_vec())],
            1,
            ImapMode {
                sent: None,
                esearch: true,
                esearch_response: Some(response),
                ..Default::default()
            },
        )
        .await;
        assert!(
            connector()
                .poll(
                    workspace(),
                    &credential(465, port, MailTls::Implicit),
                    &json!({"external_id":"account"}),
                    &MailboxCursor::reading_history()
                )
                .await
                .is_err(),
            "{response}"
        );
        task.await.unwrap();
    }
}

#[tokio::test]
async fn imap_slow_discovery_still_dispatches_selected_messages() {
    let messages = (1..=21)
        .map(|n| (n * 5_000, BODY.len() as u32, BODY.to_vec()))
        .collect();
    let (port, task) = imap_with_mode(
        false,
        42,
        messages,
        2,
        ImapMode {
            sent: None,
            search_delay: Duration::from_millis(500),
            ..Default::default()
        },
    )
    .await;
    let conn = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let public = json!({"external_id":"account"});
    let mut cursor = MailboxCursor::reading_history();
    let mut previous = 0;
    for _ in 0..2 {
        let (events, next) = conn
            .poll(workspace(), &cred, &public, &cursor)
            .await
            .unwrap();
        assert!(!events.is_empty());
        let last = next.mailboxes["INBOX"].last_uid;
        assert!(last > previous);
        assert_eq!((last - previous) / 5_000, events.len() as u32);
        previous = last;
        cursor = next;
    }
    task.await.unwrap();
}

#[tokio::test]
async fn imap_search_preserves_fragmented_unsolicited_responses() {
    for esearch in [false, true] {
        for fragment in [
            ("* 2 EX", "ISTS\r\n"),
            ("", "* 1 FETCH (UID 7 BODY[] {14}\r\n* SEARCH 999\r\n)\r\n"),
            ("* 1 FETCH (UID 7 BODY[] {14}\r\n* SE", "ARCH 999\r\n)\r\n"),
        ] {
            let (port, task) = imap_with_mode(
                false,
                42,
                vec![(7, BODY.len() as u32, BODY.to_vec())],
                1,
                ImapMode {
                    sent: None,
                    esearch,
                    examine_fragment: Some(fragment),
                    ..Default::default()
                },
            )
            .await;
            let result = connector()
                .poll(
                    workspace(),
                    &credential(465, port, MailTls::Implicit),
                    &json!({"external_id":"account"}),
                    &MailboxCursor::reading_history(),
                )
                .await;
            let (events, cursor) = result.unwrap();
            assert_eq!(events.len(), 1);
            assert_eq!(cursor.mailboxes["INBOX"].last_uid, 7);
            task.await.unwrap();
        }
    }
}

#[tokio::test]
async fn imap_one_slow_search_cannot_starve_selected_uids() {
    let (port, task) = imap_with_mode(
        false,
        42,
        vec![(7, BODY.len() as u32, BODY.to_vec())],
        1,
        ImapMode {
            sent: None,
            search_delay: Duration::from_millis(8500),
            ..Default::default()
        },
    )
    .await;
    let (events, cursor) = connector()
        .poll(
            workspace(),
            &credential(465, port, MailTls::Implicit),
            &json!({"external_id":"account"}),
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(cursor.mailboxes["INBOX"].last_uid, 7);
    task.await.unwrap();
}

#[tokio::test]
async fn imap_slow_esearch_minimum_still_makes_progress() {
    let (port, task) = imap_with_mode(
        false,
        42,
        vec![(1, BODY.len() as u32, BODY.to_vec())],
        1,
        ImapMode {
            sent: None,
            esearch: true,
            search_delay: Duration::from_millis(8500),
            ..Default::default()
        },
    )
    .await;
    let (events, cursor) = connector()
        .poll(
            workspace(),
            &credential(465, port, MailTls::Implicit),
            &json!({"external_id":"account"}),
            &MailboxCursor::reading_history(),
        )
        .await
        .unwrap();
    assert_eq!(events.len(), 1);
    assert_eq!(cursor.mailboxes["INBOX"].last_uid, 1);
    task.await.unwrap();
}

#[tokio::test]
async fn imap_slow_overflow_retries_still_make_progress() {
    let messages = (1..=5_000)
        .map(|uid| (uid, BODY.len() as u32, BODY.to_vec()))
        .collect();
    let (port, task) = imap_with_mode(
        false,
        42,
        messages,
        2,
        ImapMode {
            sent: None,
            search_delay: Duration::from_millis(2800),
            ..Default::default()
        },
    )
    .await;
    let conn = connector();
    let cred = credential(465, port, MailTls::Implicit);
    let public = json!({"external_id":"account"});
    let mut cursor = MailboxCursor::reading_history();
    let mut previous = 0;
    for _ in 0..2 {
        let (events, next) = conn
            .poll(workspace(), &cred, &public, &cursor)
            .await
            .unwrap();
        assert!(!events.is_empty());
        let last = next.mailboxes["INBOX"].last_uid;
        assert!(last > previous);
        assert_eq!(last - previous, events.len() as u32);
        previous = last;
        cursor = next;
    }
    task.await.unwrap();
}
