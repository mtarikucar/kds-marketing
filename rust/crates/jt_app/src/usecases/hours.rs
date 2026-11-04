//! Local days and working hours (spec 2026-10-30-leads-pool-outreach-design.md §3.7, §3.9): the
//! pool's daily caps count the prospects created in the workspace's day, never the server's; the
//! calls fence and lead distribution read a working-hours window (`jt_capability::Hours`) in its
//! own time zone, and an assignment's SLA counts only the minutes inside its owner's window.

use chrono::{Datelike, TimeZone, Timelike};
use jt_capability::Hours;
use time::{Duration, OffsetDateTime};

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

/// The local calendar date of `at` in time zone `tz` (else [`DEFAULT_TZ`]).
pub fn local_date(tz: &str, at: OffsetDateTime) -> Result<time::Date, AppError> {
    let zone: chrono_tz::Tz = tz.parse().unwrap_or(chrono_tz::Europe::Istanbul);
    let utc = chrono::DateTime::from_timestamp(at.unix_timestamp(), 0)
        .ok_or_else(|| AppError::internal("the time is out of range"))?;
    let d = utc.with_timezone(&zone).date_naive();
    let month = u8::try_from(d.month())
        .ok()
        .and_then(|m| time::Month::try_from(m).ok())
        .ok_or_else(|| AppError::internal("the time is out of range"))?;
    time::Date::from_calendar_date(
        d.year(),
        month,
        u8::try_from(d.day()).map_err(|_| AppError::internal("the time is out of range"))?,
    )
    .map_err(|_| AppError::internal("the time is out of range"))
}

/// Whether `now` falls inside the window `h` (its days, from its opening hour up to its closing
/// hour) in the window's time zone. A zone this build does not know is `CONFLICT`.
pub fn within(h: &Hours, now: OffsetDateTime) -> Result<bool, AppError> {
    let tz: chrono_tz::Tz =
        h.tz.parse()
            .map_err(|_| AppError::conflict("invalid work hours time zone"))?;
    let utc = chrono::DateTime::from_timestamp(now.unix_timestamp(), now.nanosecond())
        .ok_or_else(|| AppError::conflict("invalid work hours time"))?;
    let local = utc.with_timezone(&tz);
    Ok(h.days
        .contains(&(local.weekday().number_from_monday() as u8))
        && local.hour() >= u32::from(h.from)
        && local.hour() < u32::from(h.to))
}

/// The instant `minutes` working minutes after `start`: the minutes inside `hours`' window count,
/// the rest do not (an evening, a weekend, a clock change). Without hours, a window with no day,
/// an empty window or a zone this build does not know, every minute counts.
pub fn add_working_minutes(
    hours: Option<&Hours>,
    start: OffsetDateTime,
    minutes: u32,
) -> OffsetDateTime {
    let wall = start + Duration::minutes(i64::from(minutes));
    let Some(h) = hours.filter(|h| !h.days.is_empty() && h.from < h.to && h.to <= 24) else {
        return wall;
    };
    let Ok(tz) = h.tz.parse::<chrono_tz::Tz>() else {
        return wall;
    };
    let mut t = start;
    let mut left = i64::from(minutes) * 60;
    // Each turn moves to a window's opening or end; two years of days bounds it.
    for _ in 0..(2 * 2 * 366) {
        let Some(utc) = chrono::DateTime::from_timestamp(t.unix_timestamp(), 0) else {
            return wall;
        };
        let date = utc.with_timezone(&tz).date_naive();
        let (Some(open), Some(close)) = (
            local_hour(tz, date, h.from),
            if h.to == 24 {
                date.succ_opt().and_then(|d| local_hour(tz, d, 0))
            } else {
                local_hour(tz, date, h.to)
            },
        ) else {
            return wall;
        };
        let working = h
            .days
            .contains(&(date.weekday().number_from_monday() as u8));
        if working && t >= open && t < close {
            let available = (close - t).whole_seconds();
            if left <= available {
                return t + Duration::seconds(left);
            }
            left -= available;
            t = close;
        } else if working && t < open {
            t = open;
        } else {
            let Some(next) = date.succ_opt().and_then(|d| local_hour(tz, d, 0)) else {
                return wall;
            };
            t = next.max(t + Duration::seconds(1));
        }
    }
    wall
}

/// The instant of `hour`:00 on local `date` in `tz`; an hour a clock change skips is its first
/// instant after.
fn local_hour(tz: chrono_tz::Tz, date: chrono::NaiveDate, hour: u8) -> Option<OffsetDateTime> {
    let local = date.and_hms_opt(u32::from(hour), 0, 0)?;
    let at = tz.from_local_datetime(&local).earliest().or_else(|| {
        tz.from_local_datetime(&(local + chrono::Duration::hours(1)))
            .earliest()
    })?;
    OffsetDateTime::from_unix_timestamp(at.timestamp()).ok()
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

    fn weekdays(tz: &str) -> Hours {
        Hours {
            tz: tz.into(),
            from: 9,
            to: 18,
            days: vec![1, 2, 3, 4, 5],
        }
    }

    #[test]
    fn working_minutes_skip_evenings_and_weekends() {
        let h = weekdays("Europe/Istanbul");
        // Friday 2026-10-30 17:30 Istanbul (14:30 UTC): 30 minutes Friday, 30 on Monday.
        let start = datetime!(2026-10-30 14:30 UTC);
        assert_eq!(
            add_working_minutes(Some(&h), start, 60),
            datetime!(2026-11-02 06:30 UTC)
        );
        // Inside the window, the minutes are wall-clock minutes.
        assert_eq!(
            add_working_minutes(Some(&h), datetime!(2026-10-29 07:00 UTC), 45),
            datetime!(2026-10-29 07:45 UTC)
        );
        // Before the opening, counting starts at the opening.
        assert_eq!(
            add_working_minutes(Some(&h), datetime!(2026-10-29 03:00 UTC), 15),
            datetime!(2026-10-29 06:15 UTC)
        );
        // No hours: every minute counts.
        assert_eq!(
            add_working_minutes(None, start, 60),
            datetime!(2026-10-30 15:30 UTC)
        );
    }

    #[test]
    fn working_minutes_follow_a_third_zone_across_its_clock_change() {
        // New York goes back an hour on Sunday 2026-11-01. Friday 17:00 EDT (21:00 UTC) plus
        // two working hours ends Monday 10:00 EST (15:00 UTC).
        let h = weekdays("America/New_York");
        assert_eq!(
            add_working_minutes(Some(&h), datetime!(2026-10-30 21:00 UTC), 120),
            datetime!(2026-11-02 15:00 UTC)
        );
        assert!(within(&h, datetime!(2026-11-02 14:30 UTC)).unwrap());
        assert!(!within(&h, datetime!(2026-11-02 13:30 UTC)).unwrap());
    }
}
