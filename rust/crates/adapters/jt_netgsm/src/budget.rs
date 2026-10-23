//! The per-account rate budget: NetGSM limits some calls per account and minute, and a call over
//! the limit is refused here, before anything is sent.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use jt_app::ports::Clock;
use jt_app::std_impls::SystemClock;
use time::{Duration, OffsetDateTime};

/// A family of calls NetGSM limits per account, and its limit.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Bucket {
    /// Delivery reports (`/sms/rest/v2/report`): 60 calls a minute.
    Report,
    /// The inbox backup (`/sms/rest/v2/inbox`): 2 calls a minute.
    Inbox,
    /// İYS (`/iys/add`, `/iys/search`): 10 calls a minute.
    Iys,
    /// The blacklist (`/sms/blacklist`): 120 calls a minute.
    Blacklist,
    /// Netsantral statistics (`/netsantral/statistics`): 2 calls a minute.
    Statistics,
}

const ALL: &[Bucket] = &[
    Bucket::Report,
    Bucket::Inbox,
    Bucket::Iys,
    Bucket::Blacklist,
    Bucket::Statistics,
];

impl Bucket {
    /// The stable key, e.g. `"report"`.
    pub fn key(&self) -> &'static str {
        match self {
            Bucket::Report => "report",
            Bucket::Inbox => "inbox",
            Bucket::Iys => "iys",
            Bucket::Blacklist => "blacklist",
            Bucket::Statistics => "statistics",
        }
    }

    /// How many calls the window allows.
    pub fn limit(&self) -> usize {
        match self {
            Bucket::Report => 60,
            Bucket::Inbox => 2,
            Bucket::Iys => 10,
            Bucket::Blacklist => 120,
            Bucket::Statistics => 2,
        }
    }

    /// The sliding window the limit holds over: a minute.
    pub fn window(&self) -> Duration {
        Duration::minutes(1)
    }

    /// Every bucket, in a stable order.
    pub fn all() -> &'static [Bucket] {
        ALL
    }
}

/// The calls taken per `(account, bucket)`: their instants, oldest first.
type Windows = HashMap<(String, Bucket), VecDeque<OffsetDateTime>>;

/// Sliding-window budgets per account (the NetGSM `usercode`) and [`Bucket`]: a call is allowed
/// when fewer than the bucket's limit were taken for the account in the trailing window (a call
/// taken exactly one window ago no longer counts). In memory, per process: the limits are safety
/// margins below NetGSM's own, not exact accounting.
///
/// Cheap to clone; clones share the windows. The clock is injected so tests move time by hand.
#[derive(Clone)]
pub struct RateBudgeter {
    clock: Arc<dyn Clock>,
    windows: Arc<Mutex<Windows>>,
}

impl fmt::Debug for RateBudgeter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RateBudgeter")
            .field("windows", &self.lock().len())
            .finish_non_exhaustive()
    }
}

impl RateBudgeter {
    /// A budgeter reading `clock`, with nothing taken.
    pub fn new(clock: Arc<dyn Clock>) -> RateBudgeter {
        RateBudgeter {
            clock,
            windows: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// A budgeter reading the system clock.
    pub fn system() -> RateBudgeter {
        RateBudgeter::new(Arc::new(SystemClock))
    }

    fn lock(&self) -> MutexGuard<'_, Windows> {
        // A panic while holding the lock leaves the windows usable: they are plain counters.
        self.windows.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Takes `n` calls of `bucket` for `account`, all or none: `Ok` when they fit in the window
    /// now, else how long until they would (nothing is taken). `n` over the bucket's limit never
    /// fits: its answer is a whole window. `n == 0` always fits.
    pub fn try_take(&self, account: &str, bucket: Bucket, n: usize) -> Result<(), Duration> {
        if n == 0 {
            return Ok(());
        }
        let (limit, window) = (bucket.limit(), bucket.window());
        if n > limit {
            return Err(window);
        }
        let now = self.clock.now();
        let mut windows = self.lock();
        let key = (account.to_owned(), bucket);
        let taken = windows.entry(key.clone()).or_default();
        taken.retain(|at| now - *at < window);
        if taken.len() + n > limit {
            // The calls that must age out for `n` more to fit; the last of them decides.
            let mut instants: Vec<OffsetDateTime> = taken.iter().copied().collect();
            instants.sort();
            let must_expire = taken.len() + n - limit;
            let wait = instants[must_expire - 1] + window - now;
            return Err(wait.max(Duration::ZERO));
        }
        taken.extend(std::iter::repeat_n(now, n));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    struct Hand(Mutex<OffsetDateTime>);

    impl Clock for Hand {
        fn now(&self) -> OffsetDateTime {
            *self.0.lock().unwrap()
        }
    }

    fn budgeter() -> (Arc<Hand>, RateBudgeter) {
        let clock = Arc::new(Hand(Mutex::new(datetime!(2026-10-23 09:00 UTC))));
        (clock.clone(), RateBudgeter::new(clock))
    }

    fn advance(clock: &Hand, by: Duration) {
        *clock.0.lock().unwrap() += by;
    }

    #[test]
    fn the_limits_are_netgsms() {
        let limits: Vec<(&str, usize)> =
            Bucket::all().iter().map(|b| (b.key(), b.limit())).collect();
        assert_eq!(
            limits,
            [
                ("report", 60),
                ("inbox", 2),
                ("iys", 10),
                ("blacklist", 120),
                ("statistics", 2),
            ]
        );
        assert!(
            Bucket::all()
                .iter()
                .all(|b| b.window() == Duration::minutes(1))
        );
    }

    #[test]
    fn a_window_frees_a_call_exactly_one_window_after_it() {
        for bucket in Bucket::all().iter().copied() {
            let (clock, budget) = budgeter();
            for _ in 0..bucket.limit() {
                assert_eq!(budget.try_take("850", bucket, 1), Ok(()), "{bucket:?}");
            }
            // Full: the next waits for the first to age out.
            assert_eq!(
                budget.try_take("850", bucket, 1),
                Err(Duration::minutes(1)),
                "{bucket:?}"
            );
            advance(&clock, Duration::seconds(59) + Duration::milliseconds(999));
            assert_eq!(
                budget.try_take("850", bucket, 1),
                Err(Duration::milliseconds(1)),
                "{bucket:?}"
            );
            advance(&clock, Duration::milliseconds(1));
            // At exactly one window, every call of the first instant has aged out.
            for _ in 0..bucket.limit() {
                assert_eq!(budget.try_take("850", bucket, 1), Ok(()), "{bucket:?}");
            }
            assert!(budget.try_take("850", bucket, 1).is_err(), "{bucket:?}");
        }
    }

    #[test]
    fn the_wait_is_until_enough_calls_age_out() {
        let (clock, budget) = budgeter();
        // Inbox: two a minute. One at 0 s, one at 30 s.
        assert_eq!(budget.try_take("850", Bucket::Inbox, 1), Ok(()));
        advance(&clock, Duration::seconds(30));
        assert_eq!(budget.try_take("850", Bucket::Inbox, 1), Ok(()));
        advance(&clock, Duration::seconds(10));
        // At 40 s: one more waits for the first (20 s), two more for the second (50 s).
        assert_eq!(
            budget.try_take("850", Bucket::Inbox, 1),
            Err(Duration::seconds(20))
        );
        assert_eq!(
            budget.try_take("850", Bucket::Inbox, 2),
            Err(Duration::seconds(50))
        );
        // More than the limit never fits.
        assert_eq!(
            budget.try_take("850", Bucket::Inbox, 3),
            Err(Duration::minutes(1))
        );
        assert_eq!(budget.try_take("850", Bucket::Inbox, 0), Ok(()));
    }

    #[test]
    fn takes_are_all_or_nothing_and_per_account_and_bucket() {
        let (_clock, budget) = budgeter();
        assert_eq!(budget.try_take("850", Bucket::Iys, 8), Ok(()));
        // Three do not fit, so none is taken: two still do.
        assert!(budget.try_take("850", Bucket::Iys, 3).is_err());
        assert_eq!(budget.try_take("850", Bucket::Iys, 2), Ok(()));
        assert!(budget.try_take("850", Bucket::Iys, 1).is_err());
        // Another account, another bucket: their own windows.
        assert_eq!(budget.try_take("851", Bucket::Iys, 10), Ok(()));
        assert_eq!(budget.try_take("850", Bucket::Report, 60), Ok(()));
        // Clones share the windows.
        assert!(budget.clone().try_take("851", Bucket::Iys, 1).is_err());
        assert!(format!("{budget:?}").contains("RateBudgeter"));
    }
}
