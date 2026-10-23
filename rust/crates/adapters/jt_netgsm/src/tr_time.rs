//! Turkish local time, as NetGSM reads and writes it: `ddMMyyyyHHmm`, at UTC+3. Türkiye has kept
//! UTC+3 all year since 2016 (no daylight saving), so the offset is fixed.

use time::macros::{format_description, offset};
use time::{Date, Month, OffsetDateTime, PrimitiveDateTime, Time, UtcOffset};

/// Turkish local time's offset from UTC.
pub const TR_OFFSET: UtcOffset = offset!(+3);

/// `at` as NetGSM's `ddMMyyyyHHmm` in Turkish local time (seconds dropped): the form of every
/// date NetGSM takes (`startdate`, `stopdate`).
pub fn fmt_tr(at: OffsetDateTime) -> String {
    let format = format_description!("[day][month][year][hour][minute]");
    at.to_offset(TR_OFFSET)
        .format(&format)
        .expect("a calendar date always formats")
}

/// `at` as İYS's `yyyy-MM-dd HH:mm:ss` in Turkish local time.
pub(crate) fn fmt_iys(at: OffsetDateTime) -> String {
    let format = format_description!("[year]-[month]-[day] [hour]:[minute]:[second]");
    at.to_offset(TR_OFFSET)
        .format(&format)
        .expect("a calendar date always formats")
}

/// The instant a NetGSM date names, read as Turkish local time; `None` when it is not one. The
/// inverse of [`fmt_tr`], and tolerant of the other forms NetGSM's answers and callbacks use:
///
/// - `ddMMyyyyHHmm` and `ddMMyyyyHHmmss`, digits only;
/// - `dd.MM.yyyy HH:mm[:ss]` (any separators: `.`, `-`, `/`, ` `, `:`), day first;
/// - `yyyy-MM-dd HH:mm[:ss]` (any separators, also `T`), year first.
///
/// A date without a time is not read (an event's time is never guessed).
pub fn parse_tr(text: &str) -> Option<OffsetDateTime> {
    let text = text.trim();
    if text.is_empty() || text.len() > 32 {
        return None;
    }
    let parts: Vec<&str> = if text.bytes().all(|b| b.is_ascii_digit()) {
        match text.len() {
            12 | 14 => split_at_widths(text, &[2, 2, 4, 2, 2, 2]),
            _ => return None,
        }
    } else {
        text.split(|c: char| !c.is_ascii_digit())
            .filter(|p| !p.is_empty())
            .collect()
    };
    let numbers: Vec<u32> = parts
        .iter()
        .map(|p| p.parse::<u32>().ok())
        .collect::<Option<_>>()?;
    let (day, month, year, rest) = match (parts.first().map(|p| p.len()), numbers.as_slice()) {
        (Some(4), [year, month, day, rest @ ..]) => (*day, *month, *year, rest),
        (Some(1 | 2), [day, month, year, rest @ ..]) if parts[2].len() == 4 => {
            (*day, *month, *year, rest)
        }
        _ => return None,
    };
    let (hour, minute, second) = match rest {
        [hour, minute] => (*hour, *minute, 0),
        [hour, minute, second] => (*hour, *minute, *second),
        _ => return None,
    };
    let month = Month::try_from(u8::try_from(month).ok()?).ok()?;
    let date =
        Date::from_calendar_date(i32::try_from(year).ok()?, month, u8::try_from(day).ok()?).ok()?;
    let time = Time::from_hms(
        u8::try_from(hour).ok()?,
        u8::try_from(minute).ok()?,
        u8::try_from(second).ok()?,
    )
    .ok()?;
    Some(PrimitiveDateTime::new(date, time).assume_offset(TR_OFFSET))
}

/// `text` (ASCII) cut into consecutive pieces of `widths`, as far as it reaches.
fn split_at_widths<'a>(text: &'a str, widths: &[usize]) -> Vec<&'a str> {
    let mut out = Vec::with_capacity(widths.len());
    let mut at = 0;
    for width in widths {
        if at + width > text.len() {
            break;
        }
        out.push(&text[at..at + width]);
        at += width;
    }
    out
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    #[test]
    fn dates_are_written_in_turkish_time_across_utc_midnight() {
        // 22:30 UTC on the 22nd is already 01:30 on the 23rd in Türkiye.
        assert_eq!(fmt_tr(datetime!(2026-10-22 22:30 UTC)), "231020260130");
        assert_eq!(fmt_tr(datetime!(2026-10-22 20:59:59 UTC)), "221020262359");
        assert_eq!(fmt_tr(datetime!(2026-10-22 21:00 UTC)), "231020260000");
        // An instant given at another offset is the same instant.
        assert_eq!(fmt_tr(datetime!(2026-10-23 01:30 +3)), "231020260130");
        // A year boundary.
        assert_eq!(fmt_tr(datetime!(2026-12-31 21:15 UTC)), "010120270015");
        assert_eq!(
            fmt_iys(datetime!(2026-10-22 22:30:05 UTC)),
            "2026-10-23 01:30:05"
        );
    }

    #[test]
    fn dates_read_back_as_the_instant_they_name() {
        for at in [
            datetime!(2026-10-22 22:30 UTC),
            datetime!(2026-10-22 21:00 UTC),
            datetime!(2026-10-22 20:59 UTC),
            datetime!(2026-12-31 21:15 UTC),
            datetime!(2027-02-28 23:45 UTC),
        ] {
            assert_eq!(parse_tr(&fmt_tr(at)), Some(at), "{at}");
        }
        assert_eq!(
            parse_tr("231020260130"),
            Some(datetime!(2026-10-22 22:30 UTC))
        );
        assert_eq!(
            parse_tr("23102026013015"),
            Some(datetime!(2026-10-22 22:30:15 UTC))
        );
        assert_eq!(
            parse_tr("23.10.2026 01:30:15"),
            Some(datetime!(2026-10-22 22:30:15 UTC))
        );
        assert_eq!(
            parse_tr("2026-10-23 01:30"),
            Some(datetime!(2026-10-22 22:30 UTC))
        );
        assert_eq!(
            parse_tr("2026-10-23T01:30:00"),
            Some(datetime!(2026-10-22 22:30 UTC))
        );
        assert_eq!(
            parse_tr(" 1/2/2027 3:04 "),
            Some(datetime!(2027-02-01 00:04 UTC))
        );
    }

    #[test]
    fn what_is_not_a_date_reads_as_none() {
        for text in [
            "",
            "   ",
            "2310202601",
            "2310202601301",
            "231320260130",
            "320120260130",
            "290220270130",
            "231020262460",
            "23.10.2026",
            "2026-10-23",
            "dün",
            "23.10.26 01:30",
            "99999999999999999999999.10.2026 01:30",
            "23.10.2026 01:30:15:99",
        ] {
            assert_eq!(parse_tr(text), None, "{text:?}");
        }
    }
}
