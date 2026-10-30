use std::collections::BTreeSet;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use jt_capability::{CapabilityKind, KINDS, Reach, StoredStatus, validate_connector_public};
use jt_connector::*;
use jt_tenancy::WorkspaceId;
use serde_json::{Value, json};
use sha2::Sha256;
use time::macros::datetime;
use time::{Duration, OffsetDateTime};

/// A Thursday afternoon.
const NOW: OffsetDateTime = datetime!(2026-10-22 15:30:00 UTC);

/// The key the OAuth state tests sign with.
const STATE_KEY: [u8; 32] = [7; 32];

fn ws() -> WorkspaceId {
    "0192f0c4-1a2b-7c3d-8e4f-123456789abc"
        .parse()
        .expect("a valid uuid")
}

/// HMAC-SHA256 computed here, independently of the crate's own helper.
fn hmac_hex(key: &[u8], msg: &[u8]) -> String {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("any key length");
    mac.update(msg);
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

// ---------------------------------------------------------------------------------------------
// Providers and kinds
// ---------------------------------------------------------------------------------------------

/// The kinds each provider serves (controller decision 1).
const EXPECTED_PROVIDERS: &[(&str, Provider)] = &[
    ("instagram", Provider::Meta),
    ("facebook_page", Provider::Meta),
    ("whatsapp_cloud", Provider::Meta),
    ("instagram_dm", Provider::Meta),
    ("messenger", Provider::Meta),
    ("meta_ads", Provider::Meta),
    ("review_facebook", Provider::Meta),
    ("sms_line", Provider::Netgsm),
    ("netgsm_pbx", Provider::Netgsm),
    ("x", Provider::X),
    ("mailbox", Provider::Mail),
    ("tiktok", Provider::Tiktok),
    ("linkedin_member", Provider::Linkedin),
    ("linkedin_page", Provider::Linkedin),
    ("trendyol", Provider::Trendyol),
    ("hepsiburada", Provider::Hepsiburada),
];

#[test]
fn provider_for_every_connector_kind() {
    for (kind, provider) in EXPECTED_PROVIDERS {
        assert_eq!(provider_for_kind(kind), Some(*provider), "{kind}");
        let k = CapabilityKind::parse(kind).expect("a provider kind is on the closed list");
        assert_eq!(k.default_reach(), Reach::Connector, "{kind}");
        assert!(provider.kinds().contains(kind), "{provider:?} lists {kind}");
    }

    // Every other kind of the closed list has no provider, and neither has a key off the list.
    for k in KINDS {
        if !EXPECTED_PROVIDERS.iter().any(|(e, _)| *e == k.key) {
            assert_eq!(provider_for_kind(k.key), None, "{}", k.key);
        }
    }
    for off_list in [
        "",
        "Instagram",
        "INSTAGRAM",
        " instagram",
        "instagram ",
        "telegram",
        "meta",
        "netgsm",
        "twitter",
    ] {
        assert_eq!(provider_for_kind(off_list), None, "{off_list:?}");
    }

    // The providers' lists hold exactly these kinds, each under one provider only.
    let listed: Vec<&str> = Provider::all()
        .iter()
        .flat_map(|p| p.kinds().iter().copied())
        .collect();
    let distinct: BTreeSet<&str> = listed.iter().copied().collect();
    assert_eq!(listed.len(), distinct.len(), "a kind under two providers");
    let expected: BTreeSet<&str> = EXPECTED_PROVIDERS.iter().map(|(k, _)| *k).collect();
    assert_eq!(distinct, expected);

    // Keys: stable, round trip through `parse` and serde, case-sensitive.
    let keys: Vec<&str> = Provider::all().iter().map(Provider::key).collect();
    assert_eq!(
        keys,
        [
            "meta",
            "netgsm",
            "x",
            "mail",
            "tiktok",
            "linkedin",
            "trendyol",
            "hepsiburada"
        ]
    );
    for p in Provider::all() {
        assert_eq!(Provider::parse(p.key()), Some(*p));
        assert_eq!(serde_json::to_value(p).unwrap(), json!(p.key()));
        assert_eq!(
            serde_json::from_value::<Provider>(json!(p.key())).unwrap(),
            *p
        );
    }
    assert_eq!(Provider::parse("Meta"), None);
    assert_eq!(Provider::parse(""), None);
}

#[test]
fn unsupported_connector_kinds_are_listed_explicitly() {
    let unsupported: BTreeSet<&str> = UNSUPPORTED_CONNECTOR_KINDS.iter().copied().collect();
    assert_eq!(
        unsupported.len(),
        UNSUPPORTED_CONNECTOR_KINDS.len(),
        "the unsupported list has a duplicate"
    );

    // A connector kind is either served by a provider or listed as unsupported, never both and
    // never neither: a new connector kind on the closed list fails here until it is placed.
    for k in KINDS
        .iter()
        .filter(|k| k.default_reach() == Reach::Connector)
    {
        let served = provider_for_kind(k.key).is_some();
        let listed = unsupported.contains(k.key);
        assert!(
            served != listed,
            "{}: served by a provider = {served}, listed unsupported = {listed}",
            k.key
        );
    }

    // Every listed kind is a connector kind of the closed list.
    for key in UNSUPPORTED_CONNECTOR_KINDS {
        let k = CapabilityKind::parse(key).expect("an unsupported kind is on the closed list");
        assert_eq!(k.default_reach(), Reach::Connector, "{key}");
    }

    let pinned: BTreeSet<&str> = [
        "pinterest",
        "youtube",
        "google_business",
        "webchat",
        "discord",
        "reddit",
        "review_google",
        "tiktok_ads",
        "linkedin_ads",
        "google_ads",
        "google_calendar",
        "outlook_calendar",
    ]
    .into_iter()
    .collect();
    assert_eq!(unsupported, pinned);
}

// ---------------------------------------------------------------------------------------------
// OAuth state and PKCE
// ---------------------------------------------------------------------------------------------

fn x_state() -> OAuthState {
    OAuthState {
        workspace_id: ws(),
        provider: Provider::X,
        kind_key: "x".to_owned(),
        issued_at: NOW,
        nonce: [0xA5; 16],
    }
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_base64url(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[test]
fn state_round_trip_and_expiry_and_tamper() {
    assert_eq!(STATE_TTL, Duration::minutes(10));

    let state = x_state();
    let token = state.sign(&STATE_KEY);

    // Shape: base64url(JSON payload) "." 64 lowercase hex digits of HMAC-SHA256 over the payload.
    let (payload_b64, sig) = token.split_once('.').expect("payload.signature");
    assert!(is_base64url(payload_b64), "{payload_b64}");
    assert_eq!(sig.len(), 64);
    assert!(is_lower_hex(sig), "{sig}");
    let payload = URL_SAFE_NO_PAD
        .decode(payload_b64)
        .expect("base64url, no padding");
    let parsed: Value = serde_json::from_slice(&payload).expect("the payload is JSON");
    assert_eq!(parsed["workspace_id"], json!(ws().to_string()));
    assert_eq!(parsed["provider"], json!("x"));
    assert_eq!(parsed["kind_key"], json!("x"));
    // Exactly these fields: no PKCE verifier rides the redirect beside the code.
    let fields: BTreeSet<&str> = parsed
        .as_object()
        .expect("an object")
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        fields,
        BTreeSet::from(["workspace_id", "provider", "kind_key", "issued_at", "nonce"])
    );
    assert_eq!(
        sig,
        hmac_hex(&STATE_KEY, &payload),
        "MAC over the payload bytes"
    );

    // Deterministic, and it round trips, also with a sub-second time.
    assert_eq!(state.sign(&STATE_KEY), token);
    assert_eq!(
        OAuthState::verify(&token, &STATE_KEY, NOW),
        Ok(state.clone())
    );
    let precise = OAuthState {
        issued_at: NOW + Duration::nanoseconds(123_456_789),
        kind_key: "instagram".to_owned(),
        provider: Provider::Meta,
        ..x_state()
    };
    assert_eq!(
        OAuthState::verify(&precise.sign(&STATE_KEY), &STATE_KEY, precise.issued_at),
        Ok(precise.clone())
    );

    // Expiry: valid through exactly ten minutes, refused a second later and long after.
    assert_eq!(
        OAuthState::verify(&token, &STATE_KEY, NOW + STATE_TTL),
        Ok(state.clone())
    );
    for late in [
        NOW + STATE_TTL + Duration::seconds(1),
        NOW + Duration::hours(1),
        NOW + Duration::days(400),
    ] {
        assert_eq!(
            OAuthState::verify(&token, &STATE_KEY, late),
            Err(OAuthError::Expired),
            "{late}"
        );
    }
    // A state from the future: tolerated within the clock skew, refused beyond it.
    assert_eq!(
        OAuthState::verify(&token, &STATE_KEY, NOW - STATE_CLOCK_SKEW),
        Ok(state.clone())
    );
    assert_eq!(
        OAuthState::verify(
            &token,
            &STATE_KEY,
            NOW - STATE_CLOCK_SKEW - Duration::seconds(1)
        ),
        Err(OAuthError::Expired)
    );

    // Tampering. Another workspace's payload under this signature (cross-workspace completion).
    let foreign = OAuthState {
        workspace_id: WorkspaceId::new_v7(),
        ..state.clone()
    };
    let foreign_token = foreign.sign(&STATE_KEY);
    let (foreign_payload, foreign_sig) = foreign_token.split_once('.').unwrap();
    assert_ne!(foreign_sig, sig);
    assert_eq!(
        OAuthState::verify(&format!("{foreign_payload}.{sig}"), &STATE_KEY, NOW),
        Err(OAuthError::BadSignature)
    );
    // A later issue time under the old signature (stretching the TTL).
    let later = OAuthState {
        issued_at: NOW + Duration::hours(1),
        ..state.clone()
    };
    let later_payload = later.sign(&STATE_KEY);
    let (later_payload, _) = later_payload.split_once('.').unwrap();
    assert_eq!(
        OAuthState::verify(
            &format!("{later_payload}.{sig}"),
            &STATE_KEY,
            NOW + Duration::hours(1)
        ),
        Err(OAuthError::BadSignature)
    );
    // One signature digit changed, each position in turn.
    for i in 0..sig.len() {
        let mut flipped = sig.as_bytes().to_vec();
        flipped[i] = if flipped[i] == b'0' { b'1' } else { b'0' };
        let flipped = String::from_utf8(flipped).unwrap();
        assert_eq!(
            OAuthState::verify(&format!("{payload_b64}.{flipped}"), &STATE_KEY, NOW),
            Err(OAuthError::BadSignature),
            "digit {i}"
        );
    }
    // Another key.
    assert_eq!(
        OAuthState::verify(&token, &[8; 32], NOW),
        Err(OAuthError::BadSignature)
    );
    // A valid MAC over something that is not a state is malformed, not trusted.
    let not_json = b"not json";
    let not_json_token = format!(
        "{}.{}",
        URL_SAFE_NO_PAD.encode(not_json),
        hmac_hex(&STATE_KEY, not_json)
    );
    assert_eq!(
        OAuthState::verify(&not_json_token, &STATE_KEY, NOW),
        Err(OAuthError::Malformed)
    );

    // Malformed shapes never reach the MAC.
    let upper = sig.to_ascii_uppercase();
    for bad in [
        String::new(),
        "abc".to_owned(),
        ".".to_owned(),
        format!("{payload_b64}."),
        format!(".{sig}"),
        format!("{payload_b64}.{}", &sig[..63]),
        format!("{payload_b64}.{sig}0"),
        format!("{payload_b64}.{upper}"),
        format!("{payload_b64}.{sig}.{sig}"),
        format!("{payload_b64}={}.{sig}", ""),
        format!("!!!!.{sig}"),
        format!("{payload_b64}.{}g", &sig[..63]),
    ] {
        assert_eq!(
            OAuthState::verify(&bad, &STATE_KEY, NOW),
            Err(OAuthError::Malformed),
            "{bad:?}"
        );
    }
}

/// RFC 7636 Appendix B: the octets, the verifier they encode to, and its S256 challenge.
const RFC7636_OCTETS: [u8; 32] = [
    116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77,
    105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
];
const RFC7636_VERIFIER: &str = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC7636_CHALLENGE: &str = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

#[test]
fn pkce_challenge_is_s256_base64url() {
    // Known answer (RFC 7636 Appendix B).
    assert_eq!(URL_SAFE_NO_PAD.encode(RFC7636_OCTETS), RFC7636_VERIFIER);
    assert_eq!(pkce_challenge_s256(RFC7636_VERIFIER), RFC7636_CHALLENGE);

    // The pair from 48 random bytes (reference values computed outside this crate).
    let random: [u8; 48] = std::array::from_fn(|i| u8::try_from(i).unwrap());
    let (verifier, challenge) = pkce_pair(random);
    assert_eq!(
        verifier,
        "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4v"
    );
    assert_eq!(challenge, "kLfxiTSrox_ke7yPyjvQYBZ97Vxt2KfwU9deyoPONcI");
    assert_eq!(challenge, pkce_challenge_s256(&verifier));

    // RFC 7636 §4.1: 43 to 128 unreserved characters; the challenge is unpadded base64url.
    for random in [[0u8; 48], [0xFF; 48], random] {
        let (verifier, challenge) = pkce_pair(random);
        assert_eq!(verifier.len(), 64);
        assert!((43..=128).contains(&verifier.len()));
        assert!(is_base64url(&verifier), "{verifier}");
        assert_eq!(challenge.len(), 43);
        assert!(is_base64url(&challenge), "{challenge}");
    }
    assert_ne!(pkce_pair([0; 48]), pkce_pair([1; 48]));
}

// ---------------------------------------------------------------------------------------------
// Webhook math
// ---------------------------------------------------------------------------------------------

#[test]
fn meta_signature_constant_time_examples() {
    // RFC 4231 test case 2 as a Meta header.
    assert!(meta_signature_ok(
        b"Jefe",
        b"what do ya want for nothing?",
        "sha256=5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
    ));

    // A webhook body (reference value computed outside this crate).
    let secret = b"meta-app-secret-for-tests";
    let body = br#"{"object":"page","entry":[{"id":"1234567890","time":1761146400}]}"#;
    let hex = "0572fbcd324f4aba4d7f8da7aa3bde3f55d401e73f4be4294e7c06996d267f29";
    let good = format!("sha256={hex}");
    assert!(meta_signature_ok(secret, body, &good));
    assert_eq!(hex, hmac_hex(secret, body));

    // Another secret, or a body changed by one byte or one trailing newline.
    assert!(!meta_signature_ok(b"meta-app-secret-for-test", body, &good));
    let mut changed = body.to_vec();
    changed[12] = b'P';
    assert!(!meta_signature_ok(secret, &changed, &good));
    let mut with_newline = body.to_vec();
    with_newline.push(b'\n');
    assert!(!meta_signature_ok(secret, &with_newline, &good));

    // Malformed headers are refused, never panicked on.
    let upper = hex.to_ascii_uppercase();
    for bad in [
        String::new(),
        "sha256=".to_owned(),
        hex.to_owned(),
        format!("SHA256={hex}"),
        format!("sha1={hex}"),
        format!("sha256:{hex}"),
        format!("sha256= {hex}"),
        format!(" sha256={hex}"),
        format!("sha256={hex} "),
        format!("sha256={upper}"),
        format!("sha256={}", &hex[..63]),
        format!("sha256={hex}0"),
        format!("sha256={}z", &hex[..63]),
        format!("sha256={hex},sha256={hex}"),
    ] {
        assert!(!meta_signature_ok(secret, body, &bad), "{bad:?}");
    }
    // One digit changed, each position in turn.
    for i in 0..hex.len() {
        let mut flipped = hex.as_bytes().to_vec();
        flipped[i] = if flipped[i] == b'0' { b'1' } else { b'0' };
        let flipped = format!("sha256={}", String::from_utf8(flipped).unwrap());
        assert!(!meta_signature_ok(secret, body, &flipped), "digit {i}");
    }

    // An unset (empty) app secret verifies nothing, even a signature made with the empty key.
    let empty_key_sig = format!("sha256={}", hmac_hex(b"", body));
    assert!(!meta_signature_ok(b"", body, &empty_key_sig));
}

/// Meta's webhook verification echoes the challenge only for the platform's verify token: an
/// exact, constant-time match; an unset (empty) token matches nothing.
#[test]
fn meta_verify_token_matches_exactly() {
    assert!(meta_verify_token_ok("verify-me", "verify-me"));
    for wrong in ["", "verify-m", "verify-me ", "VERIFY-ME", "verify-me2"] {
        assert!(!meta_verify_token_ok("verify-me", wrong), "{wrong:?}");
    }
    assert!(!meta_verify_token_ok("", ""));
}

#[test]
fn netgsm_token_matches_reference_vector() {
    // Reference values computed outside this crate (python hmac and openssl dgst agree).
    let key: [u8; 32] = std::array::from_fn(|i| u8::try_from(i).unwrap());
    let mo = netgsm_hook_token(&key, ws(), NetgsmPurpose::Mo.key());
    assert_eq!(
        mo,
        "713251065b1571ae646f1feea6e61a9157517dbe67c9ec6a08f1020e416ea975"
    );
    assert_eq!(
        netgsm_hook_token(&key, ws(), NetgsmPurpose::Events.key()),
        "70b44c5836b3dc8ce6047c2c83fc78d34be76ca1ccc6dbc97ae7c977d994c018"
    );
    assert_eq!(
        mo,
        hmac_hex(&key, b"netgsm-hook:0192f0c4-1a2b-7c3d-8e4f-123456789abc:mo")
    );

    // Separated by purpose, by workspace and by key.
    let tokens: BTreeSet<String> = NetgsmPurpose::all()
        .iter()
        .map(|p| netgsm_hook_token(&key, ws(), p.key()))
        .chain([
            netgsm_hook_token(&key, WorkspaceId::new_v7(), "mo"),
            netgsm_hook_token(&[0; 32], ws(), "mo"),
        ])
        .collect();
    assert_eq!(tokens.len(), NetgsmPurpose::all().len() + 2);
    for t in &tokens {
        assert_eq!(t.len(), 64);
        assert!(is_lower_hex(t), "{t}");
    }

    // Purpose keys: pinned, and they round trip.
    let keys: Vec<&str> = NetgsmPurpose::all().iter().map(|p| p.key()).collect();
    assert_eq!(
        keys,
        ["mo", "events", "iys", "voice-report", "autocall-report"]
    );
    for p in NetgsmPurpose::all() {
        assert_eq!(NetgsmPurpose::parse(p.key()), Some(*p));
    }
    for unknown in [
        "",
        "MO",
        "dlr",
        "voice_report",
        "autocall_report",
        "Voice-Report",
        "voice-report/",
    ] {
        assert_eq!(NetgsmPurpose::parse(unknown), None, "{unknown:?}");
    }

    // The comparison: exact, constant-time, and an empty expectation matches nothing.
    assert!(netgsm_token_ok(&mo, &mo));
    let events = netgsm_hook_token(&key, ws(), NetgsmPurpose::Events.key());
    assert!(!netgsm_token_ok(&mo, &events), "another purpose's token");
    assert!(!netgsm_token_ok(&mo, &mo.to_ascii_uppercase()));
    assert!(!netgsm_token_ok(&mo, &mo[..63]));
    assert!(!netgsm_token_ok(&mo, &format!("{mo}0")));
    assert!(!netgsm_token_ok(&mo, ""));
    assert!(!netgsm_token_ok("", ""));
    for i in 0..mo.len() {
        let mut flipped = mo.as_bytes().to_vec();
        flipped[i] = if flipped[i] == b'0' { b'1' } else { b'0' };
        assert!(
            !netgsm_token_ok(&mo, &String::from_utf8(flipped).unwrap()),
            "digit {i}"
        );
    }
}

// ---------------------------------------------------------------------------------------------
// Probe health
// ---------------------------------------------------------------------------------------------

#[test]
fn status_after_probe_table() {
    use StoredStatus::*;

    let ok = ProbeResult::success(120, json!({ "page_name": "Kahve Durağı" }));
    assert!(ok.ok);
    assert_eq!(ok.error, None);
    assert_eq!(ok.latency_ms, 120);
    let failure = |e: ConnectorError| {
        let r = ProbeResult::failure(900, e.clone());
        assert!(!r.ok);
        assert_eq!(r.error, Some(e));
        assert_eq!(r.facts, json!({}));
        r
    };
    let auth = failure(ConnectorError::auth("token expired"));
    let permission = failure(ConnectorError::permission("pages_show_list missing"));
    let permanent = failure(ConnectorError::permanent("page deleted"));
    let throttle = failure(ConnectorError::throttle(Some(Duration::seconds(30))));
    let transient = failure(ConnectorError::transient("connection reset"));
    // An adapter that failed without saying why: counted as a hard failure.
    let unexplained = ProbeResult {
        ok: false,
        latency_ms: 5,
        error: None,
        facts: json!({}),
    };

    // (result, what a live capability becomes; `None` = it keeps its status)
    let table: [(&ProbeResult, Option<StoredStatus>); 7] = [
        (&ok, Some(Verified)),
        (&auth, Some(Unreachable)),
        (&permission, Some(Unreachable)),
        (&permanent, Some(Unreachable)),
        (&unexplained, Some(Unreachable)),
        (&throttle, None),
        (&transient, None),
    ];
    for prev in [Declared, Verified, Unreachable, Retired] {
        for (result, next) in &table {
            let expected = match (prev, next) {
                (Retired, _) => Retired,
                (_, Some(next)) => *next,
                (prev, None) => prev,
            };
            assert_eq!(
                status_after_probe(prev, result),
                expected,
                "{prev:?} after {result:?}"
            );
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------------------------

/// One credential of every variant, with its secret values and the public facts it must show.
fn every_credential() -> Vec<(Credential, Vec<&'static str>, Vec<&'static str>)> {
    vec![
        (
            Credential::OAuth {
                access_token: "EAAB-access-SECRET".to_owned(),
                refresh_token: Some("refresh-SECRET".to_owned()),
                expires_at: Some(datetime!(2026-12-21 15:30:00 UTC)),
                scopes: vec!["pages_show_list".to_owned(), "instagram_basic".to_owned()],
            },
            vec!["EAAB-access-SECRET", "refresh-SECRET"],
            vec!["pages_show_list", "instagram_basic", "2026-12-21T15:30:00Z"],
        ),
        (
            Credential::PageToken {
                page_id: "1029384756".to_owned(),
                token: "page-token-SECRET".to_owned(),
            },
            vec!["page-token-SECRET"],
            vec!["1029384756"],
        ),
        (
            Credential::WhatsAppCloud {
                phone_number_id: "109876543210".to_owned(),
                token: "wa-token-SECRET".to_owned(),
                waba_id: Some("2233445566".to_owned()),
                expires_at: Some(datetime!(2026-12-22 10:00:00 UTC)),
            },
            vec!["wa-token-SECRET"],
            vec!["109876543210", "2233445566", "2026-12-22T10:00:00Z"],
        ),
        (
            Credential::NetgsmSms {
                usercode: "8503001122".to_owned(),
                password: "sms-pass-SECRET".to_owned(),
                msgheader: "KAHVECI".to_owned(),
            },
            vec!["sms-pass-SECRET"],
            vec!["8503001122", "KAHVECI"],
        ),
        (
            Credential::NetgsmPbx {
                username: "8503001133".to_owned(),
                password: "pbx-pass-SECRET".to_owned(),
                trunk: Some("trunk-7".to_owned()),
                pbxnum: Some("8503001100".to_owned()),
            },
            vec!["pbx-pass-SECRET"],
            vec!["8503001133", "trunk-7", "8503001100"],
        ),
        (
            Credential::NetgsmIys {
                usercode: "8503001144".to_owned(),
                password: "iys-pass-SECRET".to_owned(),
                brand_code: "654321".to_owned(),
            },
            vec!["iys-pass-SECRET"],
            vec!["8503001144", "654321"],
        ),
        (
            Credential::TrendyolSeller {
                seller_id: "123456".to_owned(),
                api_key: "ty-key-SECRET".to_owned(),
                api_secret: "ty-secret-SECRET".to_owned(),
            },
            vec!["ty-key-SECRET", "ty-secret-SECRET"],
            vec!["123456"],
        ),
        (
            Credential::HepsiburadaMerchant {
                merchant_id: "a1b2c3d4-0000-4000-8000-000000000001".to_owned(),
                service_key: "hb-service-key-SECRET".to_owned(),
            },
            vec!["hb-service-key-SECRET"],
            vec!["a1b2c3d4-0000-4000-8000-000000000001"],
        ),
    ]
}

#[test]
fn credential_debug_is_masked() {
    let creds = every_credential();
    let kinds: BTreeSet<&str> = creds.iter().map(|(c, _, _)| c.kind()).collect();
    assert_eq!(
        kinds,
        BTreeSet::from([
            "oauth",
            "page_token",
            "whatsapp_cloud",
            "netgsm_sms",
            "netgsm_pbx",
            "netgsm_iys",
            "trendyol_seller",
            "hepsiburada_merchant"
        ]),
        "one credential of each variant"
    );

    for (cred, secrets, public) in &creds {
        for debug in [format!("{cred:?}"), format!("{cred:#?}")] {
            for secret in secrets {
                assert!(!debug.contains(secret), "{secret} in {debug}");
            }
            assert!(debug.contains("***"), "{debug}");
            for fact in public.iter().filter(|f| !f.contains(':')) {
                assert!(debug.contains(fact), "{fact} missing from {debug}");
            }
        }
    }

    // A missing optional secret shows as absent, a present one as masked.
    let bare = Credential::OAuth {
        access_token: "t-SECRET".to_owned(),
        refresh_token: None,
        expires_at: None,
        scopes: vec![],
    };
    let debug = format!("{bare:?}");
    assert!(debug.contains("refresh_token: None"), "{debug}");
    assert!(!debug.contains("t-SECRET"), "{debug}");
}

#[test]
fn credential_public_facts_never_contain_secrets() {
    for (cred, secrets, public) in every_credential() {
        let facts = cred.redact_for_public();
        let text = facts.to_string();
        for secret in &secrets {
            assert!(!text.contains(secret), "{secret} in {text}");
        }
        for fact in &public {
            assert!(text.contains(fact), "{fact} missing from {text}");
        }
        assert_eq!(facts["kind"], json!(cred.kind()), "{text}");
        assert_eq!(
            validate_connector_public(&facts),
            vec![],
            "the facts are fit for connector_public: {text}"
        );

        // The sealing form, by contrast, carries everything and round trips.
        let sealed = serde_json::to_value(&cred).unwrap();
        assert_eq!(sealed["kind"], json!(cred.kind()));
        let sealed_text = sealed.to_string();
        for secret in &secrets {
            assert!(sealed_text.contains(secret), "{secret} not sealed");
        }
        assert_eq!(serde_json::from_value::<Credential>(sealed).unwrap(), cred);
    }

    // Pinned shapes.
    let creds = every_credential();
    assert_eq!(
        creds[0].0.redact_for_public(),
        json!({
            "kind": "oauth",
            "expires_at": "2026-12-21T15:30:00Z",
            "scopes": ["pages_show_list", "instagram_basic"],
        })
    );
    assert_eq!(
        creds[2].0.redact_for_public(),
        json!({
            "kind": "whatsapp_cloud",
            "phone_number_id": "109876543210",
            "waba_id": "2233445566",
            "expires_at": "2026-12-22T10:00:00Z",
        })
    );
    assert_eq!(
        creds[4].0.redact_for_public(),
        json!({
            "kind": "netgsm_pbx",
            "username": "8503001133",
            "trunk": "trunk-7",
            "pbxnum": "8503001100",
        })
    );
    let no_expiry = Credential::OAuth {
        access_token: "t".to_owned(),
        refresh_token: None,
        expires_at: None,
        scopes: vec![],
    };
    assert_eq!(
        no_expiry.redact_for_public(),
        json!({ "kind": "oauth", "expires_at": null, "scopes": [] })
    );
}

/// A marketplace seller's own API credentials (spec 2026-10-30-inbox-comments-marketplace-design.md
/// §5.3): sealed whole, shown by the seller or merchant id only.
#[test]
fn marketplace_credentials_mask_and_redact() {
    let trendyol = Credential::TrendyolSeller {
        seller_id: "123456".to_owned(),
        api_key: "ty-key-SECRET".to_owned(),
        api_secret: "ty-secret-SECRET".to_owned(),
    };
    // The seller's service key for Jeeta as its integrator (task H0).
    let hepsiburada = Credential::HepsiburadaMerchant {
        merchant_id: "m-42".to_owned(),
        service_key: "hb-service-key-SECRET".to_owned(),
    };
    assert_eq!(trendyol.kind(), "trendyol_seller");
    assert_eq!(hepsiburada.kind(), "hepsiburada_merchant");
    assert_eq!(
        format!("{trendyol:?}"),
        "TrendyolSeller { seller_id: \"123456\", api_key: ***, api_secret: *** }"
    );
    assert_eq!(
        format!("{hepsiburada:?}"),
        "HepsiburadaMerchant { merchant_id: \"m-42\", service_key: *** }"
    );
    assert_eq!(
        trendyol.redact_for_public(),
        json!({ "kind": "trendyol_seller", "seller_id": "123456" })
    );
    assert_eq!(
        hepsiburada.redact_for_public(),
        json!({ "kind": "hepsiburada_merchant", "merchant_id": "m-42" })
    );
    // Sealed, tagged by kind, and read back; a blob missing a secret does not read.
    assert_eq!(
        serde_json::to_value(&trendyol).unwrap(),
        json!({
            "kind": "trendyol_seller", "seller_id": "123456",
            "api_key": "ty-key-SECRET", "api_secret": "ty-secret-SECRET"
        })
    );
    assert_eq!(
        serde_json::to_value(&hepsiburada).unwrap(),
        json!({
            "kind": "hepsiburada_merchant", "merchant_id": "m-42",
            "service_key": "hb-service-key-SECRET"
        })
    );
    for cred in [&trendyol, &hepsiburada] {
        let sealed = serde_json::to_value(cred).unwrap();
        assert_eq!(&serde_json::from_value::<Credential>(sealed).unwrap(), cred);
        assert!(!cred.expires_soon(NOW, Duration::days(10_000)));
    }
    let read = |v: Value| serde_json::from_value::<Credential>(v);
    assert!(read(json!({ "kind": "trendyol_seller", "seller_id": "1", "api_key": "k" })).is_err());
    assert!(read(json!({ "kind": "hepsiburada_merchant", "merchant_id": "1" })).is_err());
    assert_eq!(
        read(json!({
            "kind": "trendyol_seller", "seller_id": "1", "api_key": "k", "api_secret": "s",
            "later_field": true
        }))
        .unwrap(),
        Credential::TrendyolSeller {
            seller_id: "1".to_owned(),
            api_key: "k".to_owned(),
            api_secret: "s".to_owned(),
        }
    );
}

#[test]
fn credential_expiry_and_tolerant_sealed_read() {
    let within = Duration::days(7);
    let oauth = |expires_at| Credential::OAuth {
        access_token: "t".to_owned(),
        refresh_token: None,
        expires_at,
        scopes: vec![],
    };
    assert!(oauth(Some(NOW + Duration::days(3))).expires_soon(NOW, within));
    assert!(
        oauth(Some(NOW + within)).expires_soon(NOW, within),
        "boundary"
    );
    assert!(
        oauth(Some(NOW - Duration::hours(1))).expires_soon(NOW, within),
        "expired"
    );
    assert!(!oauth(Some(NOW + within + Duration::seconds(1))).expires_soon(NOW, within));
    assert!(!oauth(None).expires_soon(NOW, within), "no known expiry");
    // A WhatsApp Cloud token from a Facebook Login user expires like the user's token; a system
    // user's token (no expiry) never does.
    let whatsapp = |expires_at| Credential::WhatsAppCloud {
        phone_number_id: "1".to_owned(),
        token: "t".to_owned(),
        waba_id: None,
        expires_at,
    };
    assert!(whatsapp(Some(NOW + Duration::days(3))).expires_soon(NOW, within));
    assert!(!whatsapp(Some(NOW + Duration::days(30))).expires_soon(NOW, within));
    assert!(!whatsapp(None).expires_soon(NOW, Duration::days(10_000)));
    assert_eq!(
        whatsapp(None).redact_for_public(),
        json!({ "kind": "whatsapp_cloud", "phone_number_id": "1" })
    );
    for (cred, _, _) in every_credential()
        .into_iter()
        .filter(|(c, _, _)| !matches!(c.kind(), "oauth" | "whatsapp_cloud"))
    {
        assert!(!cred.expires_soon(NOW, Duration::days(10_000)), "{cred:?}");
    }

    // Sealed blobs from an older or newer binary still read: optional fields default, unknown
    // fields are ignored; a missing secret or an unknown kind does not read.
    let read = |v: Value| serde_json::from_value::<Credential>(v);
    assert_eq!(
        read(json!({ "kind": "oauth", "access_token": "t", "later_field": 1 })).unwrap(),
        oauth(None)
    );
    assert_eq!(
        read(json!({ "kind": "whatsapp_cloud", "phone_number_id": "1", "token": "t" })).unwrap(),
        Credential::WhatsAppCloud {
            phone_number_id: "1".to_owned(),
            token: "t".to_owned(),
            waba_id: None,
            expires_at: None,
        }
    );
    assert_eq!(
        read(json!({ "kind": "netgsm_pbx", "username": "u", "password": "p" })).unwrap(),
        Credential::NetgsmPbx {
            username: "u".to_owned(),
            password: "p".to_owned(),
            trunk: None,
            pbxnum: None,
        }
    );
    assert!(read(json!({ "kind": "oauth" })).is_err());
    assert!(read(json!({ "kind": "page_token", "page_id": "1" })).is_err());
    assert!(read(json!({ "kind": "telegram", "token": "t" })).is_err());
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

#[test]
fn error_reason_is_redacted() {
    // A Graph error body echoing a token: the token goes, the explanation stays.
    let graph = r#"{"error":{"message":"Invalid OAuth access token","type":"OAuthException","code":190},"access_token":"EAAB-SECRET-1"}"#;
    let e = ConnectorError::auth(graph);
    let reason = e.reason().unwrap();
    assert!(!reason.contains("SECRET-1"), "{reason}");
    assert!(reason.contains(r#""access_token":"***""#), "{reason}");
    for kept in ["Invalid OAuth access token", "OAuthException", "190"] {
        assert!(reason.contains(kept), "{kept} missing from {reason}");
    }
    assert!(!e.to_string().contains("SECRET-1"));

    // Every constructor with a reason redacts.
    let leaky = r#"{"client_secret": "SECRET-2"}"#;
    for e in [
        ConnectorError::auth(leaky),
        ConnectorError::permission(leaky),
        ConnectorError::transient(leaky),
        ConnectorError::permanent(leaky),
    ] {
        let reason = e.reason().expect("a reason");
        assert_eq!(reason, r#"{"client_secret": "***"}"#);
        assert!(!format!("{e} {e:?}").contains("SECRET-2"));
    }

    // (input, expected)
    let cases: &[(&str, &str)] = &[
        // Keys by exact name or by fragment, in any case; spacing kept.
        (
            r#"{"Password" :  "hunter2-SECRET-3", "name": "Kahve"}"#,
            r#"{"Password" :  "***", "name": "Kahve"}"#,
        ),
        (
            r#"{"x-api-key":"SECRET-4","apiKey":"SECRET-5","authCode":"SECRET-6"}"#,
            r#"{"x-api-key":"***","apiKey":"***","authCode":"***"}"#,
        ),
        // An escaped quote inside the value does not end it.
        (
            r#"{"password":"ab\"cd-SECRET-7","ok":true}"#,
            r#"{"password":"***","ok":true}"#,
        ),
        // Scalars are masked, null and booleans say nothing.
        (
            r#"{"pin_password": 123456, "refresh_token": null, "has_token": true}"#,
            r#"{"pin_password": ***, "refresh_token": null, "has_token": true}"#,
        ),
        // JSON escaped inside a JSON string (a body quoted in an error message).
        (
            r#"{"error":"upstream said {\"access_token\":\"SECRET-8\",\"id\":\"9\"}"}"#,
            r#"{"error":"upstream said {\"access_token\":\"***\",\"id\":\"9\"}"}"#,
        ),
        // A body cut mid-value is masked to the end.
        (
            r#"{"id":"1","access_token":"EAAB-SECRET-9"#,
            r#"{"id":"1","access_token":"***"#,
        ),
        // Query strings and form bodies.
        (
            "GET http://crmsntrl.netgsm.com.tr:9111/8503001122/linkup?username=8503001122&password=SECRET-10&customer_num=905551112233 failed",
            "GET http://crmsntrl.netgsm.com.tr:9111/8503001122/linkup?username=8503001122&password=***&customer_num=905551112233 failed",
        ),
        (
            "client_id=abc&client_secret=SECRET-11&code=xyz&refresh_token=SECRET-12",
            "client_id=abc&client_secret=***&code=***&refresh_token=***",
        ),
        // Nothing secret: unchanged, byte for byte.
        (
            r#"{"page_id":"1029384756","name":"Kahve Durağı","kind_of":"page"}"#,
            r#"{"page_id":"1029384756","name":"Kahve Durağı","kind_of":"page"}"#,
        ),
        (
            "Error validating access token: Session has expired on Tuesday",
            "Error validating access token: Session has expired on Tuesday",
        ),
        (
            "(#10) Requires pages_read_engagement",
            "(#10) Requires pages_read_engagement",
        ),
        ("", ""),
    ];
    for (input, expected) in cases {
        assert_eq!(redact_reason(input), *expected, "{input}");
        // Redacting twice changes nothing more.
        assert_eq!(redact_reason(expected), *expected, "{expected}");
    }

    // Built only through the constructors (the reason-carrying variants are non-exhaustive), and
    // still matched from outside the crate.
    match ConnectorError::permanent(r#"{"password":"S"}"#) {
        ConnectorError::Permanent { reason, .. } => assert_eq!(reason, r#"{"password":"***"}"#),
        other => panic!("{other:?}"),
    }

    // Kinds and retry.
    let all = [
        (ConnectorError::auth("a"), "auth", false),
        (ConnectorError::permission("p"), "permission", false),
        (ConnectorError::throttle(None), "throttle", true),
        (ConnectorError::transient("t"), "transient", true),
        (ConnectorError::permanent("x"), "permanent", false),
    ];
    for (e, kind, retriable) in &all {
        assert_eq!(e.kind(), *kind);
        assert_eq!(e.is_retriable(), *retriable, "{kind}");
    }
    assert_eq!(ConnectorError::throttle(None).reason(), None);
    let throttled = ConnectorError::throttle(Some(Duration::seconds(90)));
    assert_eq!(
        throttled,
        ConnectorError::Throttle {
            retry_after: Some(Duration::seconds(90))
        }
    );
    assert!(throttled.to_string().contains("90"), "{throttled}");
    assert_eq!(
        ConnectorError::throttle(Some(Duration::seconds(-5))),
        ConnectorError::Throttle {
            retry_after: Some(Duration::ZERO)
        },
        "a negative wait is no wait"
    );
}

#[test]
fn bearer_and_basic_are_masked_in_reasons() {
    let cases: &[(&str, &str)] = &[
        (
            "401 for Authorization: Bearer AAAAAAAAAAAAAAAAAAAAAMLheAAAAAAA0%2BuSeid-SECRET",
            "401 for Authorization: Bearer ***",
        ),
        (
            "sent bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_SECRET then failed",
            "sent bearer *** then failed",
        ),
        ("Basic dXNlcjpwYXNzLVNFQ1JFVA==", "Basic ***"),
        ("BEARER abc-SECRET", "BEARER ***"),
        (
            "BASIC\tdXNlcjpwYXNzLVNFQ1JFVA== (rejected)",
            "BASIC\t*** (rejected)",
        ),
        (
            r#"headers {"Authorization": "Basic dXNlcjpwYXNz-SECRET"}"#,
            r#"headers {"Authorization": "***"}"#,
        ),
        (
            "two: Bearer one-SECRET, Bearer two-SECRET.",
            "two: Bearer ***, Bearer ***",
        ),
        // Not a scheme: a scope name, a bare word, an already masked value.
        (
            "Requires instagram_basic permission",
            "Requires instagram_basic permission",
        ),
        ("token type Bearer", "token type Bearer"),
        ("Bearer ***", "Bearer ***"),
        ("Bearer", "Bearer"),
    ];
    for (input, expected) in cases {
        assert_eq!(redact_reason(input), *expected, "{input}");
    }
    let e = ConnectorError::transient("retry with Bearer abc.def-SECRET");
    assert_eq!(e.reason(), Some("retry with Bearer ***"));
}

#[test]
fn containers_oauth_names_and_bare_pairs_are_masked() {
    // (input, expected)
    let cases: &[(&str, &str)] = &[
        // (a) An array or object under a secret-looking key goes whole.
        (
            r#"{"tokens":["EAAB-S1","EAAB-S2"],"id":"7"}"#,
            r#"{"tokens":***,"id":"7"}"#,
        ),
        (
            r#"{"access_token": {"value":"S3","exp":1}, "page_id":"9"}"#,
            r#"{"access_token": ***, "page_id":"9"}"#,
        ),
        (
            r#"{"secret":["a]b}","c",{"d":[1]}],"ok":1}"#,
            r#"{"secret":***,"ok":1}"#,
        ),
        (
            r#"{"error":"{\"tokens\":[\"S4\"],\"id\":1}"}"#,
            r#"{"error":"{\"tokens\":***,\"id\":1}"}"#,
        ),
        (
            r#"{"credentials":{"password":"S5""#,
            r#"{"credentials":***"#,
        ),
        // Junk clinging to a masked container goes with it (so a second pass changes nothing).
        (r#"{"token":["x"]junk, "id":1}"#, r#"{"token":***, "id":1}"#),
        // A container under a key that is not secret is looked into, not masked.
        (
            r#"{"data":[{"id":"1","access_token":"S6"}]}"#,
            r#"{"data":[{"id":"1","access_token":"***"}]}"#,
        ),
        // (b) OAuth names: the authorization code, the PKCE verifier, client and app secrets.
        (
            "grant_type=authorization_code&code=AUTHCODE-S7&redirect_uri=https%3A%2F%2Fx&code_verifier=VERIFIER-S8&client_id=abc",
            "grant_type=authorization_code&code=***&redirect_uri=https%3A%2F%2Fx&code_verifier=***&client_id=abc",
        ),
        (
            r#"{"code":"AQBx-S9","codeVerifier":"S10","app_secret":"S11","client_secret":"S12","refresh_token":"S13","access_token":"S14"}"#,
            r#"{"code":"***","codeVerifier":"***","app_secret":"***","client_secret":"***","refresh_token":"***","access_token":"***"}"#,
        ),
        (
            "app_secret=S15&client_secret=S16&access_token=S17&refresh_token=S18",
            "app_secret=***&client_secret=***&access_token=***&refresh_token=***",
        ),
        // A short numeric `code` is a provider's status or error code, not an OAuth code: kept.
        (
            r#"{"error":{"message":"Session expired","code":190,"error_subcode":463}}"#,
            r#"{"error":{"message":"Session expired","code":190,"error_subcode":463}}"#,
        ),
        (
            r#"{"code":"30","description":"invalid credentials"}"#,
            r#"{"code":"30","description":"invalid credentials"}"#,
        ),
        ("code=00&jobid=123", "code=00&jobid=123"),
        // (c) Rust `Debug` style `key: "value"`, and `key="value"` / `key='value'`.
        (
            r#"SmsBody { usercode: "8503001122", password: "S19", msgheader: "KAHVECI" }"#,
            r#"SmsBody { usercode: "8503001122", password: "***", msgheader: "KAHVECI" }"#,
        ),
        (
            r#"Token { access_token: "S20", refresh_token: Some("S21"), scopes: ["a"] }"#,
            r#"Token { access_token: "***", refresh_token: Some("***"), scopes: ["a"] }"#,
        ),
        (
            r#"password="S22" user="u" oauth_token='S23' name='Kahve'"#,
            r#"password="***" user="u" oauth_token='***' name='Kahve'"#,
        ),
        (r#"password = "S24";"#, r#"password = "***";"#),
        (
            r#"{'access_token': 'S25', 'id': '3'}"#,
            r#"{'access_token': '***', 'id': '3'}"#,
        ),
        (r#"password="ab\"c-S26" next"#, r#"password="***" next"#),
        (r#"api_key='S27"#, r#"api_key='***"#),
        (
            r#"{"msg":"sent password=\"S28\" to the API"}"#,
            r#"{"msg":"sent password=\"***\" to the API"}"#,
        ),
        // Nothing secret in these shapes: unchanged.
        (
            r#"Page { page_id: "1029384756", name: "Kahve" }"#,
            r#"Page { page_id: "1029384756", name: "Kahve" }"#,
        ),
        ("token: expired, retry", "token: expired, retry"),
    ];
    for (input, expected) in cases {
        let once = redact_reason(input);
        assert_eq!(once, *expected, "{input}");
        assert_eq!(redact_reason(&once), once, "idempotent: {input}");
    }
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

#[test]
fn event_kinds_round_trip_and_unknown_is_kept() {
    let known = [
        (EventKind::Message, "message"),
        (EventKind::MessageEcho, "message_echo"),
        (EventKind::Status, "status"),
        (EventKind::LeadGen, "lead_gen"),
        (EventKind::CallEvent, "call_event"),
        (EventKind::Consent, "consent"),
        (EventKind::Comment, "comment"),
        (EventKind::Question, "question"),
    ];
    for (kind, key) in &known {
        assert_eq!(kind.key(), *key);
        assert_eq!(EventKind::parse(key), *kind);
        assert_eq!(serde_json::to_value(kind).unwrap(), json!(key));
        assert_eq!(
            serde_json::from_value::<EventKind>(json!(key)).unwrap(),
            *kind
        );
    }
    for other in [
        "message_reaction",
        "Message",
        "",
        "whatsapp.template_status",
    ] {
        let kind = EventKind::parse(other);
        assert_eq!(kind, EventKind::Unknown(other.to_owned()));
        assert_eq!(kind.key(), other, "the original string is kept");
        assert_eq!(serde_json::to_value(&kind).unwrap(), json!(other));
        assert_eq!(
            serde_json::from_value::<EventKind>(json!(other)).unwrap(),
            kind
        );
    }
}

/// A comment and a marketplace question are events of their own (spec §6.3), not messages.
#[test]
fn comment_and_question_event_kinds_round_trip() {
    for (kind, key) in [
        (EventKind::Comment, "comment"),
        (EventKind::Question, "question"),
    ] {
        assert_eq!(kind.key(), key);
        assert_eq!(EventKind::parse(key), kind);
        assert_ne!(kind, EventKind::Message);
        let event: InboundEvent = serde_json::from_value(json!({
            "id": InboundEventId::new_v7(), "workspace_id": ws(), "provider": "trendyol",
            "external_id": "q:1:open:", "kind": key
        }))
        .unwrap();
        assert_eq!(event.kind, kind);
        assert_eq!(event.provider, Provider::Trendyol);
        assert_eq!(serde_json::to_value(&event).unwrap()["kind"], json!(key));
    }
    assert_eq!(
        EventKind::parse("comments"),
        EventKind::Unknown("comments".to_owned())
    );
}

// ---------------------------------------------------------------------------------------------
// Comment grants
// ---------------------------------------------------------------------------------------------

/// The scopes Facebook Login asks for today (`jt_meta::FACEBOOK_SCOPES` at this change): no
/// comment permission among them.
const FACEBOOK_SCOPES_TODAY: &[&str] = &[
    "pages_show_list",
    "pages_manage_posts",
    "pages_read_engagement",
    "business_management",
    "pages_messaging",
    "pages_manage_metadata",
    "instagram_basic",
    "instagram_manage_messages",
    "instagram_content_publish",
    "whatsapp_business_management",
    "whatsapp_business_messaging",
    "ads_read",
    "read_insights",
    "instagram_manage_insights",
    "leads_retrieval",
    "ads_management",
];

/// The scopes Instagram Login asks for today (`jt_meta::INSTAGRAM_SCOPES` at this change).
const INSTAGRAM_SCOPES_TODAY: &[&str] = &[
    "instagram_business_basic",
    "instagram_business_content_publish",
];

#[test]
fn comment_grant_matrix() {
    let none = CommentGrant::default();
    let all = CommentGrant {
        read: true,
        reply: true,
        hide: true,
        delete_others: true,
        private_reply: true,
    };
    assert!(!none.enabled());
    assert!(all.enabled());
    for (read, reply, enabled) in [
        (true, false, false),
        (false, true, false),
        (true, true, true),
    ] {
        let grant = CommentGrant {
            read,
            reply,
            ..CommentGrant::default()
        };
        assert_eq!(grant.enabled(), enabled);
    }
    assert_eq!(
        FACEBOOK_COMMENT_SCOPES,
        [
            "instagram_manage_comments",
            "pages_manage_engagement",
            "pages_read_user_content"
        ]
    );
    assert_eq!(
        INSTAGRAM_COMMENT_SCOPES,
        [
            "instagram_business_manage_comments",
            "instagram_business_manage_messages"
        ]
    );
    let with = |base: &[&'static str], more: &[&'static str]| -> Vec<&'static str> {
        base.iter().chain(more).copied().collect()
    };

    // Today's grants light nothing up, on any kind.
    for kind in [
        "facebook_page",
        "instagram",
        "messenger",
        "instagram_dm",
        "trendyol",
        "x",
    ] {
        assert_eq!(comment_grant(kind, FACEBOOK_SCOPES_TODAY), none, "{kind}");
        assert_eq!(comment_grant(kind, INSTAGRAM_SCOPES_TODAY), none, "{kind}");
        assert_eq!(comment_grant(kind, &[]), none, "{kind}");
    }
    // Today's Facebook Login plus the comment scopes it would ask for: everything.
    let facebook_login = with(FACEBOOK_SCOPES_TODAY, FACEBOOK_COMMENT_SCOPES);
    assert_eq!(comment_grant("facebook_page", &facebook_login), all);
    assert_eq!(comment_grant("instagram", &facebook_login), all);
    // Instagram Login plus its comment scopes: everything on Instagram.
    let instagram_login = with(INSTAGRAM_SCOPES_TODAY, INSTAGRAM_COMMENT_SCOPES);
    assert_eq!(comment_grant("instagram", &instagram_login), all);
    assert_eq!(comment_grant("facebook_page", &instagram_login), none);

    // A Page token: read, reply and hide need both engagement scopes; deleting others' comments
    // needs pages_read_user_content, a private reply pages_messaging.
    let engagement = ["pages_read_engagement", "pages_manage_engagement"];
    let page_only = CommentGrant {
        read: true,
        reply: true,
        hide: true,
        delete_others: false,
        private_reply: false,
    };
    assert_eq!(comment_grant("facebook_page", &engagement), page_only);
    assert_eq!(
        comment_grant(
            "facebook_page",
            &with(&engagement, &["pages_read_user_content"])
        ),
        CommentGrant {
            delete_others: true,
            ..page_only
        }
    );
    assert_eq!(
        comment_grant("facebook_page", &with(&engagement, &["pages_messaging"])),
        CommentGrant {
            private_reply: true,
            ..page_only
        }
    );
    for half in [
        &["pages_read_engagement"][..],
        &[
            "pages_manage_engagement",
            "pages_read_user_content",
            "pages_messaging",
        ][..],
    ] {
        assert_eq!(comment_grant("facebook_page", half), none, "{half:?}");
    }

    // Instagram through Facebook Login: instagram_manage_comments; a private reply also
    // instagram_manage_messages.
    let ig_only = CommentGrant {
        read: true,
        reply: true,
        hide: true,
        delete_others: true,
        private_reply: false,
    };
    assert_eq!(
        comment_grant(
            "instagram",
            &["instagram_basic", "instagram_manage_comments"]
        ),
        ig_only
    );
    assert_eq!(
        comment_grant(
            "instagram",
            &["instagram_manage_comments", "instagram_manage_messages"]
        ),
        all
    );
    // Instagram Login: instagram_business_manage_comments; a private reply also
    // instagram_business_manage_messages.
    assert_eq!(
        comment_grant("instagram", &["instagram_business_manage_comments"]),
        ig_only
    );
    assert_eq!(
        comment_grant(
            "instagram",
            &[
                "instagram_business_manage_comments",
                "instagram_business_manage_messages"
            ]
        ),
        all
    );
    // One login's messages scope does not give the other login's private reply.
    for mixed in [
        &[
            "instagram_business_manage_comments",
            "instagram_manage_messages",
        ][..],
        &[
            "instagram_manage_comments",
            "instagram_business_manage_messages",
        ][..],
    ] {
        assert_eq!(comment_grant("instagram", mixed), ig_only, "{mixed:?}");
    }
    // Messages alone read no comment.
    assert_eq!(
        comment_grant("instagram", &["instagram_business_manage_messages"]),
        none
    );

    // Marketplaces and every other kind: not a comment kind at all.
    for kind in ["trendyol", "hepsiburada", "mailbox", "x", ""] {
        assert_eq!(comment_grant(kind, &facebook_login), none, "{kind}");
        assert_eq!(comment_grant(kind, &instagram_login), none, "{kind}");
    }
}

#[test]
fn inbound_events_dedupe_by_provider_and_read_tolerantly() {
    assert_eq!(
        dedupe_key(Provider::Meta, "wamid.HBgLOTA1NTUxMTEyMjMzFQIAERgS"),
        "meta:wamid.HBgLOTA1NTUxMTEyMjMzFQIAERgS"
    );
    assert_eq!(
        dedupe_key(Provider::Netgsm, "1234567890123456789012345:answer"),
        "netgsm:1234567890123456789012345:answer"
    );
    assert_ne!(
        dedupe_key(Provider::Meta, "1"),
        dedupe_key(Provider::X, "1")
    );

    let event = InboundEvent {
        id: InboundEventId::new_v7(),
        workspace_id: ws(),
        provider: Provider::Netgsm,
        capability_id: None,
        external_id: "netgsm-mo:42".to_owned(),
        kind: EventKind::Message,
        payload: json!({ "mesaj": "Merhaba", "ceptel": "905551112233" }),
        received_at: NOW,
        processed_at: Some(NOW + Duration::seconds(2)),
    };
    let stored = serde_json::to_value(&event).unwrap();
    assert_eq!(stored["provider"], json!("netgsm"));
    assert_eq!(stored["kind"], json!("message"));
    assert_eq!(
        serde_json::from_value::<InboundEvent>(stored).unwrap(),
        event
    );

    // A minimal row: everything but the identity reads as its default.
    let minimal = json!({
        "id": event.id,
        "workspace_id": ws(),
        "provider": "meta",
        "external_id": "m_1",
        "a_later_field": [1, 2],
    });
    let read: InboundEvent = serde_json::from_value(minimal).unwrap();
    assert_eq!(read.capability_id, None);
    assert_eq!(read.kind, EventKind::Unknown(String::new()));
    assert_eq!(read.payload, Value::Null);
    assert_eq!(read.received_at, OffsetDateTime::UNIX_EPOCH);
    assert_eq!(read.processed_at, None);
    for missing in ["id", "workspace_id", "provider", "external_id"] {
        let mut v = serde_json::to_value(&event).unwrap();
        v.as_object_mut().unwrap().remove(missing);
        assert!(
            serde_json::from_value::<InboundEvent>(v).is_err(),
            "{missing} is identity"
        );
    }
}

#[test]
fn redaction_survives_odd_text() {
    // Every string of up to four pieces over an alphabet of delimiters, keys and multibyte
    // characters: never a panic, and a second pass changes nothing more.
    const PIECES: &[&str] = &[
        "\"", "\\", "'", ":", "=", "&", " ", "token", "code", "Bearer ", "ğ", "x1", "{", "[",
    ];
    let mut checked = 0;
    let mut stack: Vec<(String, usize)> = vec![(String::new(), 0)];
    while let Some((text, depth)) = stack.pop() {
        let once = redact_reason(&text);
        assert_eq!(redact_reason(&once), once, "{text:?}");
        checked += 1;
        if depth < 4 {
            for p in PIECES {
                stack.push((format!("{text}{p}"), depth + 1));
            }
        }
    }
    let n = PIECES.len();
    assert_eq!(checked, 1 + n + n * n + n * n * n + n * n * n * n);
}
