//! The NetGSM adapter (spec §4.2 rule 1, §6.1, §6.4): SMS over REST v2, delivery reports and the
//! inbox backup, the balance and sender-name probes, Netsantral (the cloud PBX), İYS consent
//! records, and NetGSM's callback bodies.
//!
//! [`NetgsmConnector`] implements the connector ports of `jt_app` ([`Connector`],
//! [`SmsSender`], [`DeliveryReports`], [`Telephony`], [`ConsentSync`]) and a few calls no port
//! names yet ([`NetgsmConnector::balance`], [`NetgsmConnector::msgheaders`],
//! [`NetgsmConnector::iys_search`], [`NetgsmConnector::call_records`]); [`webhook`] parses
//! NetGSM's callback bodies, purely.
//!
//! **Transport.** The adapter holds no HTTP client: every call is built with
//! [`jt_outbound::Egress::prepare`] and sent under `EgressScope::Connector("netgsm")`, so it can
//! reach only the `netgsm` hosts of the fixed tier ([`NETGSM_HOSTS`]). Where it sends them is
//! [`NetgsmBases`], the real hosts by default ([`NetgsmBases::production`]): the API over https,
//! and Netsantral's click-to-call endpoint over plain http on port 9111, the one provider
//! exception the egress client allows (NetGSM serves it no other way). Tests point both at an
//! in-process mock.
//!
//! **Credentials.** The SMS API, İYS and the balance take HTTP basic authentication
//! (`usercode:password`); İYS also carries `{username, password, brandCode}` in its body, and
//! the call records (`/netsantral/report`) take `usercode` and `password` in theirs. Netsantral
//! takes `username` and `password` in the query string, so no URL, request or response is ever
//! logged or quoted: every failure is a [`ConnectorError`] built through its redacting
//! constructors, worded here, and any text quoted from the provider has the credential's password
//! taken out and long digit runs (phone numbers) masked first. `Debug` of every value holding a
//! secret prints it as `***`.
//!
//! **Errors.** NetGSM answers a status code (`"code"` in a JSON body, or a bare code as the whole
//! body); `00` is success. The mapping, first match wins:
//!
//! | Answer | Error |
//! |---|---|
//! | code `80` (rate limit); HTTP 429 without a code; a call over the [`RateBudgeter`]'s budget (refused before any call) | `Throttle`, `retry_after` from `Retry-After` or the budget |
//! | code `30` (the credentials, or the server's IP address not on the account's allowlist); HTTP 401 without a code; Netsantral's "Kullanici dogrulanamadi" | `Auth`, its reason naming the credentials or IP allowlist |
//! | code `40` (sender name not defined or not approved), `51` (brand not registered in İYS), `60` (no package or authority); HTTP 403 without a code | `Permission` |
//! | code `100` (system error); HTTP 5xx without a code; no answer at all (connect failure, timeout), an answer broken off, a host resolving to no public address | `Transient` |
//! | code `20` (message refused), `50` (İYS refused the recipient), `70` (bad parameters), `85` (duplicate limit), any other code; HTTP 200 with a body that cannot be read; any other HTTP status; an answer over 4 MiB; a host the `netgsm` tier does not hold | `Permanent` |
//!
//! **Retries.** Only idempotent reads are tried again (delivery reports, the inbox, the balance,
//! the sender names, İYS lookups, the queue statistics, the call records), up to
//! [`RetryPolicy::attempts`] times in all, and only when no answer arrived (the connection
//! failed, dropped or timed out). Actions are sent once, whatever happens: an SMS, a call
//! (`originate`, `linkup`), a hangup, a consent record. An action that gets no answer after its
//! request may have reached NetGSM fails `Transient` with a reason saying its outcome is unknown
//! (a second send could bill a second SMS or ring a customer twice). Nothing is ever sent again
//! once any answer arrived, readable or not.
//!
//! **Rate budget.** NetGSM limits calls per account and minute; the [`RateBudgeter`] keeps a
//! sliding window per account (`usercode`) and [`Bucket`] (delivery reports 60, the inbox 2,
//! İYS 10, the blacklist 120, statistics 2 per minute) and refuses a call over it with `Throttle`
//! before anything is sent.
//!
//! **Kinds.** The probe chooses its call by `public["kind_key"]` (`sms_line` or `netgsm_pbx`, as
//! the use cases hand it from the capability); without a NetGSM kind it fails `Permanent`
//! ("kind_key missing") and calls nothing.
//!
//! **Time.** NetGSM reads and writes dates as `ddMMyyyyHHmm` in Turkish local time, which is UTC+3
//! all year ([`fmt_tr`], [`parse_tr`]).
//!
//! [`Connector`]: jt_app::ports::connectors::Connector
//! [`SmsSender`]: jt_app::ports::connectors::SmsSender
//! [`DeliveryReports`]: jt_app::ports::connectors::DeliveryReports
//! [`Telephony`]: jt_app::ports::connectors::Telephony
//! [`ConsentSync`]: jt_app::ports::connectors::ConsentSync
//! [`ConnectorError`]: jt_connector::ConnectorError

mod budget;
mod client;
mod credential;
mod iys;
mod json;
mod ports;
mod probe;
mod santral;
mod sms;
mod tr_time;
pub mod webhook;

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use jt_outbound::Egress;
use url::Url;

pub use budget::{Bucket, RateBudgeter};
pub use iys::IysStatus;
pub use sms::{Balance, Package};
pub use tr_time::{TR_OFFSET, fmt_tr, parse_tr};

/// The hosts the adapter reaches, exactly the `netgsm` entries of `jt_outbound::FIXED_HOSTS`: the
/// API (SMS, balance, İYS, call records), WhatsApp and the voice files (not used in M1b; listed
/// so a capability names every host its connector may reach) and Netsantral's click-to-call
/// endpoint, with its port.
pub const NETGSM_HOSTS: &[&str] = &[
    "api.netgsm.com.tr",
    "whatsappapi.netgsm.com.tr",
    "sesdosya.netgsm.com.tr",
    "crmsntrl.netgsm.com.tr:9111",
];

/// How many times a call is tried in all, by default, when no answer arrives.
pub const DEFAULT_ATTEMPTS: u32 = 3;

/// The pause before the first retry, by default; it doubles before each next one.
pub const DEFAULT_RETRY_DELAY: Duration = Duration::from_millis(300);

/// How long one attempt may take, connect to end of answer, by default.
pub const ATTEMPT_TIMEOUT: Duration = Duration::from_secs(20);

/// Where the adapter sends its calls: the real hosts by default ([`NetgsmBases::production`]).
/// Each is a base URL (scheme, host, port and an optional path prefix) the adapter appends its
/// paths to.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NetgsmBases {
    /// The API, `https://api.netgsm.com.tr`.
    pub api: Url,
    /// Netsantral's click-to-call endpoint, `http://crmsntrl.netgsm.com.tr:9111` (plain http:
    /// the provider serves it no other way).
    pub pbx: Url,
}

impl NetgsmBases {
    /// The real hosts.
    pub fn production() -> NetgsmBases {
        let url = |text: &str| Url::parse(text).expect("a valid NetGSM base URL");
        NetgsmBases {
            api: url("https://api.netgsm.com.tr"),
            pbx: url("http://crmsntrl.netgsm.com.tr:9111"),
        }
    }
}

/// When a read that got no answer is tried again (actions never are): up to `attempts` tries in
/// all, the first retry after `base_delay`, each next one after twice the pause before.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    pub attempts: u32,
    pub base_delay: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        RetryPolicy {
            attempts: DEFAULT_ATTEMPTS,
            base_delay: DEFAULT_RETRY_DELAY,
        }
    }
}

/// The NetGSM adapter. Cheap to share behind an `Arc`; it holds the egress client, the bases,
/// the rate budgeter (the system clock's, [`RateBudgeter::system`], by default), the retry
/// policy of reads ([`RetryPolicy::default`]) and the time one attempt may take
/// ([`ATTEMPT_TIMEOUT`]). It holds no credential: each call is given one.
pub struct NetgsmConnector {
    egress: Arc<Egress>,
    bases: NetgsmBases,
    budget: RateBudgeter,
    retry: RetryPolicy,
    attempt_timeout: Duration,
}

impl fmt::Debug for NetgsmConnector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("NetgsmConnector")
            .field("bases", &self.bases)
            .field("retry", &self.retry)
            .field("attempt_timeout", &self.attempt_timeout)
            .finish_non_exhaustive()
    }
}

impl NetgsmConnector {
    /// The adapter over `egress`, sending to `bases`.
    pub fn new(egress: Arc<Egress>, bases: NetgsmBases) -> NetgsmConnector {
        NetgsmConnector {
            egress,
            bases,
            budget: RateBudgeter::system(),
            retry: RetryPolicy::default(),
            attempt_timeout: ATTEMPT_TIMEOUT,
        }
    }

    /// The adapter counting its calls in `budget` (shared with every clone of it; tests give it
    /// a clock of their own).
    pub fn with_budgeter(mut self, budget: RateBudgeter) -> NetgsmConnector {
        self.budget = budget;
        self
    }

    /// The adapter retrying reads that got no answer as `retry` says (tests retry without
    /// pausing).
    pub fn with_retry(mut self, retry: RetryPolicy) -> NetgsmConnector {
        self.retry = retry;
        self
    }

    /// The adapter giving each attempt `timeout`, connect to end of answer, instead of
    /// [`ATTEMPT_TIMEOUT`] (tests time out in milliseconds).
    pub fn with_attempt_timeout(mut self, timeout: Duration) -> NetgsmConnector {
        self.attempt_timeout = timeout;
        self
    }

    /// Where the adapter sends its calls.
    pub fn bases(&self) -> &NetgsmBases {
        &self.bases
    }
}

/// Stands in for a secret in `Debug` output.
pub(crate) struct Masked;

impl fmt::Debug for Masked {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}
