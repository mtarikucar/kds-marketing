//! The production implementations of the service ports: the system clock, UUIDv7 ids, random
//! tokens and Argon2id password hashing. Tests use the deterministic fakes of `jt_testkit`.

use argon2::Argon2;
use argon2::password_hash::{Error as Argon2Error, PasswordHasher as _, PasswordVerifier as _};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use time::OffsetDateTime;
use uuid::Uuid;

use crate::error::AppError;
use crate::ports::{Clock, IdGen, PasswordHasher, TokenGen};

/// The operating system's clock, in UTC.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        OffsetDateTime::now_utc()
    }
}

/// Time-ordered UUIDv7 identifiers.
#[derive(Clone, Copy, Debug, Default)]
pub struct UuidV7Gen;

impl IdGen for UuidV7Gen {
    fn uuid(&self) -> Uuid {
        Uuid::now_v7()
    }
}

/// Tokens from the thread-local cryptographically secure generator of `rand` (seeded by the
/// operating system), encoded base64url without padding.
#[derive(Clone, Copy, Debug, Default)]
pub struct RandTokenGen;

impl TokenGen for RandTokenGen {
    fn token(&self, bytes: usize) -> String {
        let mut buf = vec![0u8; bytes];
        rand::fill(&mut buf[..]);
        URL_SAFE_NO_PAD.encode(&buf)
    }
}

/// Argon2id with the crate's default parameters (19 MiB, 2 passes, 1 lane) and a random salt per
/// hash, stored as a PHC string (`$argon2id$v=19$...`).
///
/// `hash` and `verify` are synchronous, as the port is, and CPU-bound: tens of milliseconds
/// each. Adapters on an async runtime (the panel's HTTP server, the MCP gate) must keep them off
/// the reactor threads, by running the calls under `tokio::task::spawn_blocking`, or by giving
/// the use cases a decorator of this hasher that wraps each call in
/// `tokio::task::block_in_place`. `jt_app` itself stays free of any runtime.
#[derive(Clone, Debug, Default)]
pub struct Argon2Hasher {
    argon2: Argon2<'static>,
}

impl PasswordHasher for Argon2Hasher {
    fn hash(&self, pw: &str) -> Result<String, AppError> {
        self.argon2
            .hash_password(pw.as_bytes())
            .map(|hash| hash.to_string())
            .map_err(|e| AppError::internal(format!("password hashing failed: {e}")))
    }

    /// `Ok(false)` on a wrong password; `INTERNAL` for a hash that is not a usable Argon2 PHC
    /// string. The parameters are read from the hash, so older hashes keep verifying.
    fn verify(&self, pw: &str, hash: &str) -> Result<bool, AppError> {
        match self.argon2.verify_password(pw.as_bytes(), hash) {
            Ok(()) => Ok(true),
            Err(Argon2Error::PasswordInvalid) => Ok(false),
            Err(e) => Err(AppError::internal(format!(
                "stored password hash is unusable: {e}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use time::Duration;

    use super::*;
    use crate::error::ErrorCode;

    #[test]
    fn argon2_hashes_verify_and_differ_per_salt() {
        let hasher = Argon2Hasher::default();
        let first = hasher.hash("correct horse battery").unwrap();
        let second = hasher.hash("correct horse battery").unwrap();
        assert!(first.starts_with("$argon2id$v=19$"), "{first}");
        assert_ne!(first, second, "every hash has its own salt");
        assert!(hasher.verify("correct horse battery", &first).unwrap());
        assert!(!hasher.verify("wrong horse battery", &first).unwrap());
        for unusable in ["", "plain:correct horse battery", "$argon2id$v=19$broken"] {
            let err = hasher
                .verify("correct horse battery", unusable)
                .unwrap_err();
            assert_eq!(err.code, ErrorCode::Internal, "{unusable:?}");
        }
    }

    #[test]
    fn tokens_are_unpadded_base64url_of_the_requested_length() {
        let tokens = RandTokenGen;
        let token = tokens.token(32);
        assert_eq!(token.len(), 43);
        assert!(
            token
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'),
            "{token}"
        );
        assert_eq!(URL_SAFE_NO_PAD.decode(&token).unwrap().len(), 32);
        assert_eq!(tokens.token(3).len(), 4);
        assert_ne!(tokens.token(32), token);
    }

    #[test]
    fn ids_are_version_7_and_ordered() {
        let first = UuidV7Gen.uuid();
        let second = UuidV7Gen.uuid();
        assert_eq!(first.get_version_num(), 7);
        assert!(first < second);
    }

    #[test]
    fn the_system_clock_reads_utc_now() {
        let now = SystemClock.now();
        assert_eq!(now.offset(), time::UtcOffset::UTC);
        assert!((OffsetDateTime::now_utc() - now).abs() < Duration::seconds(5));
    }
}
