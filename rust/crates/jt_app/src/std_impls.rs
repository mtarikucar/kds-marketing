//! The production implementations of the service ports: the system clock, UUIDv7 ids, random
//! tokens and Argon2id password hashing. Tests use the deterministic fakes of `jt_testkit`.

use argon2::Argon2;
use argon2::password_hash::{Error as Argon2Error, PasswordHasher as _, PasswordVerifier as _};
use async_trait::async_trait;
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
/// Each hash or verification is CPU-bound (tens of milliseconds), so it offloads the work itself:
/// it runs on Tokio's blocking thread pool (`tokio::task::spawn_blocking`) and never on the
/// reactor threads. It must therefore be called from within a Tokio runtime.
#[derive(Clone, Debug, Default)]
pub struct Argon2Hasher {
    argon2: Argon2<'static>,
}

impl Argon2Hasher {
    /// Runs `work` with this hasher's Argon2 instance on a blocking thread.
    async fn offload<T, F>(&self, work: F) -> Result<T, AppError>
    where
        T: Send + 'static,
        F: FnOnce(&Argon2<'static>) -> Result<T, AppError> + Send + 'static,
    {
        let argon2 = self.argon2.clone();
        tokio::task::spawn_blocking(move || work(&argon2))
            .await
            .map_err(|e| AppError::internal(format!("password hashing task failed: {e}")))?
    }
}

#[async_trait]
impl PasswordHasher for Argon2Hasher {
    async fn hash(&self, pw: &str) -> Result<String, AppError> {
        let pw = pw.to_owned();
        self.offload(move |argon2| {
            argon2
                .hash_password(pw.as_bytes())
                .map(|hash| hash.to_string())
                .map_err(|e| AppError::internal(format!("password hashing failed: {e}")))
        })
        .await
    }

    /// `Ok(false)` on a wrong password; `INTERNAL` for a hash that is not a usable Argon2 PHC
    /// string. The parameters are read from the hash, so older hashes keep verifying.
    async fn verify(&self, pw: &str, hash: &str) -> Result<bool, AppError> {
        let (pw, hash) = (pw.to_owned(), hash.to_owned());
        self.offload(
            move |argon2| match argon2.verify_password(pw.as_bytes(), hash.as_str()) {
                Ok(()) => Ok(true),
                Err(Argon2Error::PasswordInvalid) => Ok(false),
                Err(e) => Err(AppError::internal(format!(
                    "stored password hash is unusable: {e}"
                ))),
            },
        )
        .await
    }
}

#[cfg(test)]
mod tests {
    use time::Duration;

    use super::*;
    use crate::error::ErrorCode;

    #[tokio::test]
    async fn argon2_hashes_verify_and_differ_per_salt() {
        let hasher = Argon2Hasher::default();
        let first = hasher.hash("correct horse battery").await.unwrap();
        let second = hasher.hash("correct horse battery").await.unwrap();
        assert!(first.starts_with("$argon2id$v=19$"), "{first}");
        assert_ne!(first, second, "every hash has its own salt");
        assert!(
            hasher
                .verify("correct horse battery", &first)
                .await
                .unwrap()
        );
        assert!(!hasher.verify("wrong horse battery", &first).await.unwrap());
        for unusable in ["", "plain:correct horse battery", "$argon2id$v=19$broken"] {
            let err = hasher
                .verify("correct horse battery", unusable)
                .await
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
