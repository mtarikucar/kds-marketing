//! The production implementations of the service ports: the system clock, UUIDv7 ids, random
//! tokens, Argon2id password hashing and the bridges' in-process signals ([`LocalBridgeSignals`]),
//! plus the stand-ins for a process without provider apps or adapters ([`NoPlatformApps`],
//! [`EmptyConnectorRegistry`]). Tests use the deterministic fakes of `jt_testkit`.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use argon2::Argon2;
use argon2::password_hash::{Error as Argon2Error, PasswordHasher as _, PasswordVerifier as _};
use async_trait::async_trait;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use time::OffsetDateTime;
use tokio::sync::{Semaphore, watch};
use uuid::Uuid;

use jt_connector::Provider;

use crate::error::AppError;
use crate::ports::bridges::{BridgeSignals, BridgeWatch, SignalKey};
use crate::ports::connectors::{
    AdBudgetWriter, Connector, ConnectorRegistry, ConsentSync, DeliveryReports, InsightsReader,
    InstagramApp, LeadGenFetcher, MailSender, MailboxPoller, MessagingSender, MetaApp,
    OAuthProvider, PlatformAppConfig, Publisher, SmsSender, Telephony, Url, XApp,
};
use crate::ports::{Clock, IdGen, PasswordHasher, TokenGen};

/// The operating system's clock, in UTC, truncated to whole microseconds: the precision
/// Postgres stores, so an instant the application holds equals the one it reads back.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> OffsetDateTime {
        let now = OffsetDateTime::now_utc();
        // Truncating keeps the value below one second, so the replacement cannot fail.
        now.replace_nanosecond(now.nanosecond() / 1_000 * 1_000)
            .unwrap_or(now)
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
///
/// At most [`max_parallel`](Self::max_parallel) jobs run at once (the machine's available
/// parallelism, between 1 and 8), so memory stays below `max_parallel × 19 MiB` however many
/// logins arrive; further callers wait, asynchronously, for a permit. Clones share the permits.
#[derive(Clone, Debug)]
pub struct Argon2Hasher {
    argon2: Argon2<'static>,
    permits: Arc<Semaphore>,
    max_parallel: usize,
}

/// The most Argon2 jobs any one hasher runs at once.
const MAX_PARALLEL_CAP: usize = 8;

impl Default for Argon2Hasher {
    fn default() -> Self {
        let max_parallel = std::thread::available_parallelism()
            .map_or(1, |n| n.get())
            .clamp(1, MAX_PARALLEL_CAP);
        Argon2Hasher {
            argon2: Argon2::default(),
            permits: Arc::new(Semaphore::new(max_parallel)),
            max_parallel,
        }
    }
}

impl Argon2Hasher {
    /// How many hashes or verifications may run at once.
    pub fn max_parallel(&self) -> usize {
        self.max_parallel
    }

    /// Runs `work` with this hasher's Argon2 instance on a blocking thread, once a permit is free.
    /// The permit moves into the blocking job and is released only when the job ends, so a caller
    /// that gives up waiting cannot let more than `max_parallel` jobs run.
    async fn offload<T, F>(&self, work: F) -> Result<T, AppError>
    where
        T: Send + 'static,
        F: FnOnce(&Argon2<'static>) -> Result<T, AppError> + Send + 'static,
    {
        let permit = Arc::clone(&self.permits)
            .acquire_owned()
            .await
            .map_err(|e| AppError::internal(format!("password hashing is unavailable: {e}")))?;
        let argon2 = self.argon2.clone();
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            work(&argon2)
        })
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

/// [`BridgeSignals`] within this process: one `tokio::sync::watch` channel per key being
/// watched, its value counting the signals. A watch subscribes before its poll reads, so it sees
/// any signal sent after that; a channel nobody watches any more is dropped at the next signal.
/// Process-local like `OpsSignals`: with several server instances a signal reaches only this
/// one's polls, and the others find what was committed at their next read.
#[derive(Debug, Default)]
pub struct LocalBridgeSignals {
    channels: Mutex<HashMap<SignalKey, watch::Sender<u64>>>,
}

impl BridgeSignals for LocalBridgeSignals {
    fn watch(&self, key: SignalKey) -> BridgeWatch {
        let mut rx = {
            let mut channels = self.channels.lock().unwrap_or_else(|e| e.into_inner());
            channels
                .entry(key)
                .or_insert_with(|| watch::channel(0).0)
                .subscribe()
        };
        Box::pin(async move {
            // The sender lives while this receiver does (it is dropped only once nobody
            // watches), so this ends only with a signal.
            let _ = rx.changed().await;
        })
    }

    fn notify(&self, key: SignalKey) {
        let mut channels = self.channels.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(tx) = channels.get(&key) {
            if tx.receiver_count() == 0 {
                channels.remove(&key);
            } else {
                tx.send_modify(|n| *n = n.wrapping_add(1));
            }
        }
    }
}

/// No provider app configured and no public address: every app is `None`, so no kind can be
/// connected by OAuth, and no webhook URL can be shown. (The binary reads the real configuration
/// from the environment; this stands for "nothing configured" where no configuration is read.)
#[derive(Clone, Copy, Debug, Default)]
pub struct NoPlatformApps;

impl PlatformAppConfig for NoPlatformApps {
    fn meta_app(&self) -> Option<MetaApp> {
        None
    }

    fn instagram_app(&self) -> Option<InstagramApp> {
        None
    }

    fn x_app(&self) -> Option<XApp> {
        None
    }

    fn public_base_url(&self) -> Option<Url> {
        None
    }
}

/// No provider adapter: every getter answers `None`.
#[derive(Clone, Copy, Debug, Default)]
pub struct EmptyConnectorRegistry;

impl ConnectorRegistry for EmptyConnectorRegistry {
    fn connector(&self, _provider: Provider) -> Option<Arc<dyn Connector>> {
        None
    }

    fn oauth(&self, _provider: Provider) -> Option<Arc<dyn OAuthProvider>> {
        None
    }

    fn mail_sender(&self, _provider: Provider) -> Option<Arc<dyn MailSender>> {
        None
    }

    fn mailbox_poller(&self, _provider: Provider) -> Option<Arc<dyn MailboxPoller>> {
        None
    }

    fn sms(&self, _provider: Provider) -> Option<Arc<dyn SmsSender>> {
        None
    }

    fn publisher(&self, _provider: Provider) -> Option<Arc<dyn Publisher>> {
        None
    }

    fn insights(&self, _provider: Provider) -> Option<Arc<dyn InsightsReader>> {
        None
    }

    fn messaging(&self, _provider: Provider) -> Option<Arc<dyn MessagingSender>> {
        None
    }

    fn ads(&self, _provider: Provider) -> Option<Arc<dyn AdBudgetWriter>> {
        None
    }

    fn leadgen(&self, _provider: Provider) -> Option<Arc<dyn LeadGenFetcher>> {
        None
    }

    fn telephony(&self, _provider: Provider) -> Option<Arc<dyn Telephony>> {
        None
    }

    fn consent(&self, _provider: Provider) -> Option<Arc<dyn ConsentSync>> {
        None
    }

    fn delivery_reports(&self, _provider: Provider) -> Option<Arc<dyn DeliveryReports>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use jt_tenancy::WorkspaceId;
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

    #[tokio::test]
    async fn argon2_jobs_never_exceed_the_permits() {
        let hasher = Argon2Hasher::default();
        let permits = hasher.max_parallel();
        assert!((1..=8).contains(&permits), "{permits} permits");

        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let mut jobs = tokio::task::JoinSet::new();
        for _ in 0..3 * permits {
            let (hasher, running, peak) = (hasher.clone(), running.clone(), peak.clone());
            jobs.spawn(async move {
                hasher
                    .offload(move |_| {
                        let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                        peak.fetch_max(now, Ordering::SeqCst);
                        std::thread::sleep(std::time::Duration::from_millis(20));
                        running.fetch_sub(1, Ordering::SeqCst);
                        Ok(())
                    })
                    .await
            });
        }
        while let Some(job) = jobs.join_next().await {
            job.unwrap().unwrap();
        }
        let peak = peak.load(Ordering::SeqCst);
        assert!(
            (1..=permits).contains(&peak),
            "{peak} argon2 jobs ran at once with {permits} permits"
        );
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
    fn the_system_clock_has_microsecond_precision() {
        // Postgres keeps microseconds; a clock with nanoseconds would hand out instants that
        // differ from what is stored and read back.
        for _ in 0..100 {
            let now = SystemClock.now();
            assert_eq!(
                now.nanosecond() % 1_000,
                0,
                "{now} has sub-microsecond digits"
            );
        }
    }

    #[test]
    fn no_platform_apps_has_no_app_and_no_address() {
        let apps = NoPlatformApps;
        assert_eq!(apps.meta_app(), None);
        assert_eq!(apps.instagram_app(), None);
        assert_eq!(apps.x_app(), None);
        assert_eq!(apps.public_base_url(), None);
    }

    #[test]
    fn the_empty_registry_has_nothing_for_any_provider() {
        let registry = EmptyConnectorRegistry;
        for provider in Provider::all().iter().copied() {
            assert!(registry.connector(provider).is_none());
            assert!(registry.oauth(provider).is_none());
            assert!(registry.sms(provider).is_none());
            assert!(registry.publisher(provider).is_none());
            assert!(registry.insights(provider).is_none());
            assert!(registry.messaging(provider).is_none());
            assert!(registry.ads(provider).is_none());
            assert!(registry.leadgen(provider).is_none());
            assert!(registry.telephony(provider).is_none());
            assert!(registry.consent(provider).is_none());
            assert!(registry.delivery_reports(provider).is_none());
        }
    }

    #[tokio::test]
    async fn bridge_signals_wake_the_watches_begun_before_them_only_on_their_key() {
        use std::time::Duration as StdDuration;
        let signals = LocalBridgeSignals::default();
        let key = |workspace_id, topic| SignalKey {
            workspace_id,
            topic,
        };
        let (ws, other) = (WorkspaceId::new_v7(), WorkspaceId::new_v7());
        let calls = key(ws, "calls");
        // A signal sent after the watch began, before it is awaited, is not lost.
        let watch = signals.watch(calls);
        signals.notify(calls);
        tokio::time::timeout(StdDuration::from_secs(1), watch)
            .await
            .expect("woken");
        // Another workspace's signal, or another topic's in the same workspace, wakes nothing
        // here; a signal sent before the watch began does not count.
        signals.notify(calls);
        let watch = signals.watch(calls);
        signals.notify(key(other, "calls"));
        signals.notify(key(ws, "other"));
        assert!(
            tokio::time::timeout(StdDuration::from_millis(50), watch)
                .await
                .is_err()
        );
        // Several watches wake together; once none is left the key's channel is dropped.
        let (a, b) = (signals.watch(calls), signals.watch(calls));
        signals.notify(calls);
        tokio::time::timeout(StdDuration::from_secs(1), async {
            a.await;
            b.await;
        })
        .await
        .expect("both woken");
        signals.notify(calls);
        assert!(signals.channels.lock().unwrap().is_empty());
    }

    #[test]
    fn the_system_clock_reads_utc_now() {
        let now = SystemClock.now();
        assert_eq!(now.offset(), time::UtcOffset::UTC);
        assert!((OffsetDateTime::now_utc() - now).abs() < Duration::seconds(5));
    }
}
