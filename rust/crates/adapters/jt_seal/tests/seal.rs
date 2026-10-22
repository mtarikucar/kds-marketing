//! The secret box: what one workspace seals only that workspace opens, under the same master key;
//! any change to a sealed blob is refused without saying why; sealing is randomised and never
//! shows the plaintext.

use jt_app::error::{AppError, ErrorCode};
use jt_app::ports::SecretBox;
use jt_seal::AesSecretBox;
use jt_tenancy::WorkspaceId;

const MASTER: [u8; 32] = [7; 32];
const SECRET: &[u8] = b"jt_live_secret";
/// The format's fixed overhead: version byte, 96-bit nonce, 128-bit tag.
const OVERHEAD: usize = 1 + 12 + 16;

fn ws(n: u128) -> WorkspaceId {
    WorkspaceId(uuid::Uuid::from_u128(n))
}

/// Asserts the one refusal `open` ever gives.
fn assert_refused(r: Result<impl std::fmt::Debug, AppError>) {
    let e = r.expect_err("opening must be refused");
    assert_eq!(e.code, ErrorCode::Internal);
    assert_eq!(e.message, "sealed data cannot be opened");
    assert_eq!(e.details, serde_json::json!({}));
}

#[test]
fn round_trip_per_workspace() {
    let sb = AesSecretBox::new(MASTER);
    for (w, plaintext) in [
        (ws(1), SECRET),
        (ws(2), b"another secret".as_slice()),
        (ws(3), b""),
    ] {
        let sealed = sb.seal(w, plaintext).unwrap();
        assert_eq!(sealed.len(), OVERHEAD + plaintext.len());
        assert_eq!(sealed[0], 0x01, "format version byte");
        let opened = sb.open(w, &sealed).unwrap();
        assert_eq!(opened.as_slice(), plaintext);
    }
    // A second box over the same master key (a restart) opens what the first sealed.
    let sealed = sb.seal(ws(1), SECRET).unwrap();
    let again = AesSecretBox::new(MASTER);
    assert_eq!(again.open(ws(1), &sealed).unwrap().as_slice(), SECRET);
}

#[test]
fn another_workspace_cannot_open() {
    let sb = AesSecretBox::new(MASTER);
    let sealed = sb.seal(ws(1), SECRET).unwrap();
    assert_refused(sb.open(ws(2), &sealed));
    // Nor can the same workspace under another master key.
    assert_refused(AesSecretBox::new([8; 32]).open(ws(1), &sealed));
}

#[test]
fn tampered_byte_is_refused() {
    let sb = AesSecretBox::new(MASTER);
    let sealed = sb.seal(ws(1), SECRET).unwrap();
    // Every position: the version byte, the nonce, the ciphertext and the tag.
    for i in 0..sealed.len() {
        let mut tampered = sealed.clone();
        tampered[i] ^= 0x01;
        assert_refused(sb.open(ws(1), &tampered));
    }
    let mut longer = sealed.clone();
    longer.push(0);
    assert_refused(sb.open(ws(1), &longer));
}

#[test]
fn truncated_input_is_refused() {
    let sb = AesSecretBox::new(MASTER);
    let sealed = sb.seal(ws(1), SECRET).unwrap();
    for len in 0..sealed.len() {
        assert_refused(sb.open(ws(1), &sealed[..len]));
    }
    // An empty plaintext seals to exactly the overhead; anything shorter is refused.
    let empty = sb.seal(ws(1), b"").unwrap();
    assert_eq!(empty.len(), OVERHEAD);
    for len in 0..OVERHEAD {
        assert_refused(sb.open(ws(1), &empty[..len]));
    }
}

#[test]
fn two_seals_of_same_plaintext_differ() {
    let sb = AesSecretBox::new(MASTER);
    let a = sb.seal(ws(1), SECRET).unwrap();
    let b = sb.seal(ws(1), SECRET).unwrap();
    assert_ne!(a, b);
    assert_ne!(a[1..13], b[1..13], "a fresh nonce per seal");
    assert_eq!(sb.open(ws(1), &a).unwrap().as_slice(), SECRET);
    assert_eq!(sb.open(ws(1), &b).unwrap().as_slice(), SECRET);
}

#[test]
fn output_never_contains_plaintext() {
    let sb = AesSecretBox::new(MASTER);
    for _ in 0..32 {
        let sealed = sb.seal(ws(1), SECRET).unwrap();
        assert!(
            !sealed.windows(SECRET.len()).any(|w| w == SECRET),
            "the plaintext appears in the sealed bytes"
        );
    }
}

/// A blob sealed outside Rust (Python `cryptography`: HKDF-SHA256 with salt `jeeta-seal-v1` and
/// the workspace id as info, then AES-256-GCM with the workspace id as associated data) opens:
/// the key derivation and the format are pinned, so stored blobs survive a rebuild.
#[test]
fn opens_a_blob_sealed_by_an_independent_implementation() {
    let master: [u8; 32] = std::array::from_fn(|i| i as u8);
    let w: WorkspaceId = "0190f3a2-5c1e-7b4d-9a6f-2e8c1d0b7a35".parse().unwrap();
    let blob = hex::decode(
        "01a0a1a2a3a4a5a6a7a8a9aaab92557ba9c2fc773a330a4786c0d17d4ef40631c6b11ad0b9fc85c98d76e94d",
    )
    .unwrap();
    let sb = AesSecretBox::new(master);
    assert_eq!(sb.open(w, &blob).unwrap().as_slice(), b"jt_live_fixture");
    assert_refused(sb.open(ws(1), &blob));
}

/// HKDF keeps the pseudorandom key as an HMAC-SHA-256 state (two SHA-256 states keyed with it);
/// SHA-256 is built with its `zeroize` feature, so those states wipe themselves when the HKDF
/// value is dropped at the end of each call. Checked at compile time: without the feature,
/// `Sha256` is not `ZeroizeOnDrop` and this does not build.
#[test]
fn the_hash_state_behind_the_key_derivation_wipes_itself_on_drop() {
    fn wiped_on_drop<T: zeroize::ZeroizeOnDrop>() {}
    wiped_on_drop::<sha2::Sha256>();
}

/// The workspace sealing key, derived as the box derives it: HKDF-SHA256, salt `jeeta-seal-v1`,
/// info the workspace id's 16 bytes.
fn sealing_key(master: &[u8; 32], w: WorkspaceId) -> [u8; 32] {
    let mut key = [0u8; 32];
    hkdf::Hkdf::<sha2::Sha256>::new(Some(b"jeeta-seal-v1"), master)
        .expand(w.as_uuid().as_bytes(), &mut key)
        .unwrap();
    key
}

/// A workspace's HMAC key for a purpose is HKDF-SHA256 of the master key with its own salt
/// (`jeeta-hmac-v1`) and info `workspace id (16 bytes) || 0x00 || purpose`: stable for the same
/// inputs, different for another purpose, another workspace or another master key, and
/// independent of the sealing key.
#[test]
fn hmac_key_is_purpose_and_workspace_bound() {
    let sb = AesSecretBox::new(MASTER);
    let key = sb.hmac_key(ws(1), "oauth-state").unwrap();
    assert_eq!(sb.hmac_key(ws(1), "oauth-state").unwrap(), key);
    assert_eq!(
        AesSecretBox::new(MASTER)
            .hmac_key(ws(1), "oauth-state")
            .unwrap(),
        key,
        "a restart derives the same key"
    );
    assert_ne!(sb.hmac_key(ws(1), "netgsm-hook").unwrap(), key);
    assert_ne!(sb.hmac_key(ws(2), "oauth-state").unwrap(), key);
    assert_ne!(
        AesSecretBox::new([8; 32])
            .hmac_key(ws(1), "oauth-state")
            .unwrap(),
        key
    );
    // The separator keeps purposes apart from the workspace bytes, and the empty purpose is a
    // purpose of its own.
    assert_ne!(sb.hmac_key(ws(1), "").unwrap(), key);
    assert_ne!(sb.hmac_key(ws(1), "oauth-stat").unwrap(), key);

    // Pinned derivation.
    let mut info = ws(1).as_uuid().as_bytes().to_vec();
    info.push(0);
    info.extend_from_slice(b"oauth-state");
    let mut expected = [0u8; 32];
    hkdf::Hkdf::<sha2::Sha256>::new(Some(b"jeeta-hmac-v1"), &MASTER)
        .expand(&info, &mut expected)
        .unwrap();
    assert_eq!(key, expected);

    // Never the sealing key, whatever the purpose.
    for purpose in ["", "oauth-state", "netgsm-hook"] {
        assert_ne!(
            sb.hmac_key(ws(1), purpose).unwrap(),
            sealing_key(&MASTER, ws(1)),
            "{purpose:?}"
        );
    }
}
