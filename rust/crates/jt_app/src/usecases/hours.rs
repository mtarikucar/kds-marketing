//! Local days in a workspace's time zone (spec 2026-10-30-leads-pool-outreach-design.md §3.7):
//! the pool's daily caps count the prospects created in the workspace's day, never the server's.
//! (L3 of that plan moves the calls fence's working-hours arithmetic here too.)

use chrono::TimeZone;
use time::OffsetDateTime;

use crate::error::AppError;

/// The time zone a workspace's day falls back to while its leads policy names none it can read.
pub const DEFAULT_TZ: &str = "Europe/Istanbul";

/// Whether `name` is an IANA time zone this build knows.
pub fn known_time_zone(name: &str) -> bool {
    name.parse::<chrono_tz::Tz>().is_ok()
}

/// The local day holding `now` in time zone `tz` (else [`DEFAULT_TZ`]), as the instants
/// `[start, end)`: from that day's local midnight to the next day's, so a day with a clock
/// change is 23 or 25 hours long.
pub fn local_day(
    tz: &str,
    now: OffsetDateTime,
) -> Result<(OffsetDateTime, OffsetDateTime), AppError> {
    let zone: chrono_tz::Tz = tz.parse().unwrap_or(chrono_tz::Europe::Istanbul);
    let utc = chrono::DateTime::from_timestamp(now.unix_timestamp(), 0)
        .ok_or_else(|| AppError::internal("the time is out of range"))?;
    let date = utc.with_timezone(&zone).date_naive();
    let midnight = |d: chrono::NaiveDate| -> Result<OffsetDateTime, AppError> {
        let local = d
            .and_hms_opt(0, 0, 0)
            .ok_or_else(|| AppError::internal("no local midnight"))?;
        // A midnight a clock change skips starts the day at its first instant.
        let start = zone
            .from_local_datetime(&local)
            .earliest()
            .or_else(|| {
                zone.from_local_datetime(&(local + chrono::Duration::hours(1)))
                    .earliest()
            })
            .ok_or_else(|| AppError::internal("no local midnight"))?;
        OffsetDateTime::from_unix_timestamp(start.timestamp())
            .map_err(|_| AppError::internal("the time is out of range"))
    };
    let next = date
        .succ_opt()
        .ok_or_else(|| AppError::internal("the time is out of range"))?;
    Ok((midnight(date)?, midnight(next)?))
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    #[test]
    fn a_day_in_istanbul_and_in_new_york() {
        let now = datetime!(2026-10-30 23:30 UTC);
        // 02:30 on the 31st in Istanbul (UTC+3).
        assert_eq!(
            local_day("Europe/Istanbul", now).unwrap(),
            (
                datetime!(2026-10-30 21:00 UTC),
                datetime!(2026-10-31 21:00 UTC)
            )
        );
        // 19:30 on the 30th in New York (UTC-4 until 1 November).
        assert_eq!(
            local_day("America/New_York", now).unwrap(),
            (
                datetime!(2026-10-30 04:00 UTC),
                datetime!(2026-10-31 04:00 UTC)
            )
        );
        // The day the clocks go back is 25 hours long.
        assert_eq!(
            local_day("America/New_York", datetime!(2026-11-01 12:00 UTC)).unwrap(),
            (
                datetime!(2026-11-01 04:00 UTC),
                datetime!(2026-11-02 05:00 UTC)
            )
        );
        assert_eq!(
            local_day("Not/AZone", now).unwrap(),
            local_day(DEFAULT_TZ, now).unwrap()
        );
        assert!(known_time_zone("America/New_York"));
        assert!(!known_time_zone("Not/AZone"));
    }
}
