use super::*;
use jt_app::{ports::UnitOfWork, usecases::inbox::people};
use jt_capability::{Capability, CapabilityId, NewCapability, StoredStatus};
use jt_connector::{Credential, Provider};
use jt_inbox::*;
use jt_testkit::fakes::{ScriptedConnector, ScriptedRegistry};
pub async fn setup_channel(kind: &str) -> (World, ConversationId, Arc<ScriptedConnector>) {
    let mut w = world().await;
    jt_testkit::flows::activate_workspace(&w.deps, w.ws).await;
    w.approve_strategy().await;
    let connector = Arc::new(ScriptedConnector::new(match kind {
        "mailbox" => Provider::Mail,
        "sms_line" => Provider::Netgsm,
        _ => Provider::Meta,
    }));
    w.deps.connectors = Arc::new(ScriptedRegistry::new().with_connector(connector.clone()));
    let p = people::create(&w.deps,&w.owner_ctx,serde_json::from_value(json!({"display_name":"Ada","identities":[{"channel":if kind == "mailbox" { "email" } else { "phone" },"value":if kind == "mailbox" { "ada@example.com" } else { "05321234567" }}],"source":"form"})).unwrap()).await.unwrap().person;
    let now = w.owner_ctx.now;
    let mut cap = Capability::new(
        CapabilityId::new_v7(),
        w.ws,
        NewCapability {
            kind_key: kind.into(),
            name: "Support".into(),
            ..Default::default()
        },
        now,
    )
    .unwrap();
    cap.status = StoredStatus::Verified;
    cap.last_verified_at = Some(now);
    let cred = Credential::WhatsAppCloud {
        phone_number_id: "line".into(),
        token: "private-token".into(),
        waba_id: None,
        expires_at: None,
    };
    let cred = match kind {
        "mailbox" => Credential::Mailbox {
            smtp_host: "smtp.example.com".into(),
            smtp_port: 465,
            imap_host: "imap.example.com".into(),
            imap_port: 993,
            username: "support@example.com".into(),
            password: "private-mail".into(),
            from_address: "support@example.com".into(),
            tls: jt_connector::MailTls::Implicit,
        },
        "sms_line" => Credential::NetgsmSms {
            usercode: "user".into(),
            password: "private-sms".into(),
            msgheader: "Support".into(),
        },
        _ => cred,
    };
    let sealed = w
        .deps
        .seal
        .seal(w.ws, &serde_json::to_vec(&cred).unwrap())
        .unwrap();
    let id = ConversationId::new_v7();
    let c = Conversation {
        id,
        workspace_id: w.ws,
        person_id: p.id,
        capability_id: cap.id,
        kind_key: cap.kind_key.clone(),
        state: ConvState::Ours,
        executor: Executor::Agent,
        executor_generation: 0,
        last_inbound_at: Some(now),
        last_outbound_at: None,
        created_at: now,
        updated_at: now,
    };
    let mut r = w.uow.tenant(w.ws).await.unwrap();
    r.capabilities().insert(cap, Some(sealed)).await.unwrap();
    r.conversations().upsert_on_inbound(c).await.unwrap();
    r.commit().await.unwrap();
    (w, id, connector)
}
