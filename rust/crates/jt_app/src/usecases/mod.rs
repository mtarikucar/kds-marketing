//! Use cases: the application's operations. Each is a function over [`Deps`] (plus a `Ctx` once
//! it is scoped to a workspace) that adapters call from the panel or the MCP gate.

pub mod auth;
pub mod workspace;

use std::fmt::Write as _;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::ports::{Clock, IdGen, PasswordHasher, TokenGen, UnitOfWork};

/// The ports a use case may call, built once by the binary (or a test) and shared by every
/// adapter.
#[derive(Clone)]
pub struct Deps {
    pub uow: Arc<dyn UnitOfWork>,
    pub clock: Arc<dyn Clock>,
    pub ids: Arc<dyn IdGen>,
    pub tokens: Arc<dyn TokenGen>,
    pub hasher: Arc<dyn PasswordHasher>,
}

/// The stored form of a secret token (a session, invite or API-key token): the lowercase hex
/// SHA-256 of its text. A fast hash suffices because the tokens are long random values, and a
/// deterministic one is needed so the token can be looked up by it.
pub fn hash_token(token: &str) -> String {
    let digest = Sha256::digest(token.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        // Writing into a `String` cannot fail.
        let _ = write!(hex, "{byte:02x}");
    }
    hex
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_token_is_hex_sha256() {
        assert_eq!(
            hash_token("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(hash_token("").len(), 64);
    }
}
