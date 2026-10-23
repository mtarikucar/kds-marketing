use jt_connector::{Credential, Provider, provider_for_kind};
use serde_json::json;

#[test]
fn mailbox_credential_and_provider_contract() {
    let raw = json!({"kind":"mailbox", "smtp_host":"smtp.example.com", "smtp_port":465,
        "imap_host":"imap.example.com", "imap_port":993, "username":"private-login",
        "password":"mail-secret", "from_address":"sender@example.com", "tls":"implicit"});
    let credential: Credential = serde_json::from_value(raw.clone()).expect("mailbox credential");
    assert_eq!(serde_json::to_value(&credential).unwrap(), raw);
    let public = credential.redact_for_public();
    assert_eq!(
        public,
        json!({"kind":"mailbox", "smtp_host":"smtp.example.com", "smtp_port":465,
        "imap_host":"imap.example.com", "imap_port":993, "from_address":"sender@example.com"})
    );
    for secret in ["private-login", "mail-secret"] {
        assert!(!format!("{credential:?} {public}").contains(secret));
    }
    assert_eq!(provider_for_kind("mailbox"), Provider::parse("mail"));
    assert!(Provider::parse("mail").is_some());
}

#[test]
fn mailbox_tls_cannot_be_disabled() {
    for tls in [json!("none"), json!("plain"), json!(null)] {
        let raw = json!({"kind":"mailbox", "smtp_host":"smtp.example.com", "smtp_port":25,
            "imap_host":"imap.example.com", "imap_port":143, "username":"login",
            "password":"secret", "from_address":"sender@example.com", "tls":tls});
        assert!(serde_json::from_value::<Credential>(raw).is_err());
    }
}
