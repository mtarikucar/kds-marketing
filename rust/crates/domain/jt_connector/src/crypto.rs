//! The byte-level helpers behind the OAuth state and the webhook math: HMAC-SHA256, lowercase hex
//! and constant-time comparison.

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// HMAC-SHA256 of `msg` under `key` (any key length).
pub(crate) fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(msg);
    mac.finalize().into_bytes().into()
}

/// Whether `a` and `b` are equal, in time that depends only on their lengths (which are not
/// secret: every compared value has a fixed, public length).
pub(crate) fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    bool::from(a.ct_eq(b))
}

const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

/// Lowercase hex of `bytes`.
pub(crate) fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(char::from(HEX_DIGITS[usize::from(b >> 4)]));
        out.push(char::from(HEX_DIGITS[usize::from(b & 0x0f)]));
    }
    out
}

/// The `N` bytes written as exactly `2 * N` lowercase hex digits in `s`; `None` for any other
/// text (uppercase digits included: every hex value here is written lowercase).
pub(crate) fn from_hex<const N: usize>(s: &str) -> Option<[u8; N]> {
    fn digit(c: u8) -> Option<u8> {
        match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            _ => None,
        }
    }
    let s = s.as_bytes();
    if s.len() != 2 * N {
        return None;
    }
    let mut out = [0u8; N];
    for (byte, pair) in out.iter_mut().zip(s.chunks_exact(2)) {
        *byte = (digit(pair[0])? << 4) | digit(pair[1])?;
    }
    Some(out)
}

/// Serde for a 16-byte nonce as 32 lowercase hex digits.
pub(crate) mod hex16 {
    use serde::{Deserialize, Deserializer, Serializer, de::Error as _};

    pub(crate) fn serialize<S: Serializer>(bytes: &[u8; 16], s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&super::to_hex(bytes))
    }

    pub(crate) fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<[u8; 16], D::Error> {
        let text = String::deserialize(d)?;
        super::from_hex::<16>(&text)
            .ok_or_else(|| D::Error::custom("expected 32 lowercase hex digits"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips_and_is_strict() {
        let bytes: [u8; 4] = [0x00, 0x7f, 0xa5, 0xff];
        assert_eq!(to_hex(&bytes), "007fa5ff");
        assert_eq!(from_hex::<4>("007fa5ff"), Some(bytes));
        assert_eq!(from_hex::<4>("007FA5FF"), None);
        assert_eq!(from_hex::<4>("007fa5f"), None);
        assert_eq!(from_hex::<4>("007fa5fff"), None);
        assert_eq!(from_hex::<4>("007fa5fg"), None);
        assert_eq!(from_hex::<4>("+07fa5ff"), None);
        assert_eq!(from_hex::<0>(""), Some([]));
    }

    #[test]
    fn ct_eq_compares_whole_values() {
        assert!(ct_eq(b"abc", b"abc"));
        assert!(!ct_eq(b"abc", b"abd"));
        assert!(!ct_eq(b"abc", b"ab"));
        assert!(ct_eq(b"", b""));
    }
}
