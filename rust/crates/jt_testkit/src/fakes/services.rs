//! The service fakes: a fixed clock, sequential ids, scripted tokens, a plain-text "hasher", a
//! plain-text "secret box", a fixed channel catalog, and [`deps`], which wires them all into a
//! `Deps`.

use std::collections::{BTreeSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use jt_app::error::AppError;
use jt_app::ports::{
    ChannelCatalog, Clock, IdGen, PasswordHasher, SecretBox, TokenGen, UnitOfWork,
};
use jt_app::usecases::Deps;
use jt_app::usecases::strategy::NoopArchivedHook;
use jt_tenancy::WorkspaceId;
use time::OffsetDateTime;
use uuid::Uuid;
use zeroize::Zeroizing;

use super::state::lock;

/// A clock that always reads the same instant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FixedClock(pub OffsetDateTime);

impl Clock for FixedClock {
    fn now(&self) -> OffsetDateTime {
        self.0
    }
}

/// Deterministic ids: `Uuid::from_u128(1)`, `Uuid::from_u128(2)`, … in call order.
#[derive(Debug, Default)]
pub struct SeqIdGen {
    issued: AtomicU64,
}

impl SeqIdGen {
    pub fn new() -> Self {
        Self::default()
    }
}

impl IdGen for SeqIdGen {
    fn uuid(&self) -> Uuid {
        let n = self.issued.fetch_add(1, Ordering::SeqCst) + 1;
        Uuid::from_u128(u128::from(n))
    }
}

/// Hands out scripted tokens in order, whatever byte length is asked for.
#[derive(Debug)]
pub struct FixedTokenGen {
    tokens: Mutex<VecDeque<String>>,
}

impl FixedTokenGen {
    pub fn new<I, S>(tokens: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        FixedTokenGen {
            tokens: Mutex::new(tokens.into_iter().map(Into::into).collect()),
        }
    }
}

impl TokenGen for FixedTokenGen {
    /// The next scripted token. Panics when none is left: the test scripted too few.
    fn token(&self, _bytes: usize) -> String {
        lock(&self.tokens).pop_front().unwrap_or_else(|| {
            panic!("FixedTokenGen is exhausted: the test scripted fewer tokens than were requested")
        })
    }
}

/// The hash `PlainHasher` writes is the password behind this prefix.
pub const PLAIN_PREFIX: &str = "plain:";

/// A "hasher" that stores `plain:<password>`, so tests can read and seed hashes directly.
#[derive(Clone, Copy, Debug, Default)]
pub struct PlainHasher;

#[async_trait]
impl PasswordHasher for PlainHasher {
    async fn hash(&self, pw: &str) -> Result<String, AppError> {
        Ok(format!("{PLAIN_PREFIX}{pw}"))
    }

    async fn verify(&self, pw: &str, hash: &str) -> Result<bool, AppError> {
        hash.strip_prefix(PLAIN_PREFIX)
            .map(|stored| stored == pw)
            .ok_or_else(|| AppError::internal("not a plain: hash"))
    }
}

/// A "secret box" that seals in the clear, as `plain:<workspace id>:<plaintext>`, so tests can
/// read what was sealed. `open` keeps the port's contract: bytes sealed for another workspace,
/// or not sealed by this fake at all, are `INTERNAL` "sealed data cannot be opened".
#[derive(Clone, Copy, Debug, Default)]
pub struct PlainSecretBox;

impl PlainSecretBox {
    /// What `seal` writes ahead of the plaintext for `ws`.
    fn prefix(ws: WorkspaceId) -> Vec<u8> {
        format!("{PLAIN_PREFIX}{ws}:").into_bytes()
    }
}

impl SecretBox for PlainSecretBox {
    fn seal(&self, ws: WorkspaceId, plaintext: &[u8]) -> Result<Vec<u8>, AppError> {
        let mut sealed = PlainSecretBox::prefix(ws);
        sealed.extend_from_slice(plaintext);
        Ok(sealed)
    }

    fn open(&self, ws: WorkspaceId, sealed: &[u8]) -> Result<Zeroizing<Vec<u8>>, AppError> {
        sealed
            .strip_prefix(PlainSecretBox::prefix(ws).as_slice())
            .map(|plaintext| Zeroizing::new(plaintext.to_vec()))
            .ok_or_else(|| AppError::internal("sealed data cannot be opened"))
    }
}

/// A channel catalog that answers the same kinds for every workspace.
#[derive(Clone, Debug, Default)]
pub struct FixedChannelCatalog(pub BTreeSet<String>);

#[async_trait]
impl ChannelCatalog for FixedChannelCatalog {
    async fn kinds_in_use(&self, _ws: WorkspaceId) -> Result<BTreeSet<String>, AppError> {
        Ok(self.0.clone())
    }
}

/// The instant the clock of [`deps`] reads.
pub const FIXED_NOW: OffsetDateTime = time::macros::datetime!(2026-10-22 09:00 UTC);

/// How many tokens the token generator of [`deps`] is scripted with.
pub const DEPS_TOKENS: usize = 256;

/// The use-case dependencies over `uow`, with every other port a fake: a [`FixedClock`] at
/// [`FIXED_NOW`], a [`SeqIdGen`], a [`FixedTokenGen`] scripted with [`DEPS_TOKENS`] distinct
/// tokens (`token-001`, `token-002`, …), [`PlainHasher`], [`PlainSecretBox`], a
/// [`FixedChannelCatalog`] with no kinds and a [`NoopArchivedHook`]. A test that needs particular
/// tokens, channels or another time builds `Deps` itself or replaces the field.
pub fn deps(uow: Arc<dyn UnitOfWork>) -> Deps {
    Deps {
        uow,
        clock: Arc::new(FixedClock(FIXED_NOW)),
        ids: Arc::new(SeqIdGen::new()),
        tokens: Arc::new(FixedTokenGen::new(
            (1..=DEPS_TOKENS).map(|i| format!("token-{i:03}")),
        )),
        hasher: Arc::new(PlainHasher),
        seal: Arc::new(PlainSecretBox),
        channels: Arc::new(FixedChannelCatalog::default()),
        archived_hook: Arc::new(NoopArchivedHook),
    }
}
