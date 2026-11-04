//! The time calendar: special days and seasons with their windows, per workspace and year
//! (spec 2026-11-03 §4.4, D12). Defaults are computed here; a workspace stores only its edits and
//! the dates its owner enters. No guessed date is ever produced: the lunar holidays, mezuniyet and
//! kulüp sezon başı have no window until the owner enters one.
use crate::{StudioError, olay::label_ok, olay::valid_key};
use serde::{Deserialize, Serialize};
use time::{Date, Duration, Month, Weekday};

/// The longest lead the calendar takes, in days.
pub const MAX_LEAD_DAYS: u16 = 90;
/// The longest window, in days.
pub const MAX_WINDOW_DAYS: i64 = 120;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OccasionKind {
    Season,
    SpecialDay,
}

/// One occasion in one year. `window_start ..= window_end` are the Istanbul days its content is
/// in season; both `None`: no dates yet (inactive).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CalendarEntry {
    pub key: String,
    pub year: i32,
    pub name: String,
    pub kind: OccasionKind,
    #[serde(default, with = "crate::time_compat::date_option")]
    pub window_start: Option<Date>,
    #[serde(default, with = "crate::time_compat::date_option")]
    pub window_end: Option<Date>,
    /// How many days before the window Studio prepares (çekim listesi); `None`: the workspace's
    /// policy (`crate::MaterialPolicy::lead_days`).
    pub lead_days: Option<u16>,
    pub enabled: bool,
}

impl CalendarEntry {
    pub fn validate(&self) -> Result<(), StudioError> {
        let invalid = |f| Err(StudioError::InvalidMaterial(f));
        if !valid_key(&self.key) {
            return invalid("key");
        }
        if !(2000..=2100).contains(&self.year) {
            return invalid("year");
        }
        if !label_ok(&self.name, 120, true) {
            return invalid("name");
        }
        match (self.window_start, self.window_end) {
            (None, None) => {}
            (Some(s), Some(e))
                if s <= e
                    && (e - s).whole_days() < MAX_WINDOW_DAYS
                    && (s.year() == self.year || e.year() == self.year) => {}
            _ => return invalid("window"),
        }
        if self.lead_days.is_some_and(|d| d > MAX_LEAD_DAYS) {
            return invalid("lead_days");
        }
        Ok(())
    }

    /// The window, when the entry is enabled and dated.
    pub fn window(&self) -> Option<(Date, Date)> {
        if !self.enabled {
            return None;
        }
        self.window_start.zip(self.window_end)
    }
}

fn day(year: i32, month: Month, d: u8) -> Date {
    Date::from_calendar_date(year, month, d).expect("calendar default")
}

/// The `n`th (1-based) Sunday of `month` in `year`.
fn nth_sunday(year: i32, month: Month, n: u8) -> Date {
    let first = day(year, month, 1);
    let offset = (7 + Weekday::Sunday.number_days_from_monday()
        - first.weekday().number_days_from_monday())
        % 7;
    first + Duration::days(i64::from(offset) + 7 * i64::from(n - 1))
}

fn entry(
    key: &str,
    year: i32,
    name: &str,
    kind: OccasionKind,
    w: Option<(Date, Date)>,
) -> CalendarEntry {
    CalendarEntry {
        key: key.into(),
        year,
        name: name.into(),
        kind,
        window_start: w.map(|w| w.0),
        window_end: w.map(|w| w.1),
        lead_days: None,
        enabled: true,
    }
}

/// The Turkish defaults for `year` (spec §4.4).
pub fn turkish_defaults(year: i32) -> Vec<CalendarEntry> {
    use OccasionKind::{Season, SpecialDay};
    let two_weeks_to = |d: Date| Some((d - Duration::days(14), d));
    vec![
        entry(
            "yilbasi",
            year,
            "Yılbaşı",
            Season,
            Some((
                day(year, Month::December, 1),
                day(year, Month::December, 31),
            )),
        ),
        entry(
            "sevgililer_gunu",
            year,
            "Sevgililer Günü",
            SpecialDay,
            Some((
                day(year, Month::February, 1),
                day(year, Month::February, 14),
            )),
        ),
        entry(
            "nisan_23",
            year,
            "23 Nisan Ulusal Egemenlik ve Çocuk Bayramı",
            SpecialDay,
            Some((day(year, Month::April, 9), day(year, Month::April, 23))),
        ),
        entry(
            "anneler_gunu",
            year,
            "Anneler Günü",
            SpecialDay,
            two_weeks_to(nth_sunday(year, Month::May, 2)),
        ),
        entry(
            "babalar_gunu",
            year,
            "Babalar Günü",
            SpecialDay,
            two_weeks_to(nth_sunday(year, Month::June, 3)),
        ),
        entry(
            "cadilar_bayrami",
            year,
            "Cadılar Bayramı",
            Season,
            Some((day(year, Month::October, 17), day(year, Month::October, 31))),
        ),
        entry(
            "ogretmenler_gunu",
            year,
            "Öğretmenler Günü",
            SpecialDay,
            Some((
                day(year, Month::November, 10),
                day(year, Month::November, 24),
            )),
        ),
        entry("ramazan_bayrami", year, "Ramazan Bayramı", SpecialDay, None),
        entry("kurban_bayrami", year, "Kurban Bayramı", SpecialDay, None),
        entry("mezuniyet", year, "Mezuniyet", Season, None),
        entry("kulup_sezon_basi", year, "Kulüp sezon başı", Season, None),
    ]
}

/// The effective calendar over some years: the defaults overlaid by a workspace's rows.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Calendar {
    pub entries: Vec<CalendarEntry>,
}

impl Calendar {
    /// The defaults of every year in `years`, each replaced by the workspace's row of the same
    /// key and year, plus the workspace's own keys and years.
    pub fn effective(years: std::ops::RangeInclusive<i32>, rows: &[CalendarEntry]) -> Calendar {
        let mut entries: Vec<CalendarEntry> = years.flat_map(turkish_defaults).collect();
        for row in rows {
            match entries
                .iter_mut()
                .find(|e| e.key == row.key && e.year == row.year)
            {
                Some(e) => *e = row.clone(),
                None => entries.push(row.clone()),
            }
        }
        entries.sort_by(|a, b| (a.year, &a.key).cmp(&(b.year, &b.key)));
        Calendar { entries }
    }

    /// The dated, enabled windows of `key`, as `(year, start, end)`, earliest first.
    pub fn windows<'a>(&'a self, key: &'a str) -> impl Iterator<Item = (i32, Date, Date)> + 'a {
        let mut w: Vec<_> = self
            .entries
            .iter()
            .filter(|e| e.key == key)
            .filter_map(|e| e.window().map(|(s, end)| (e.year, s, end)))
            .collect();
        w.sort_by_key(|(_, s, _)| *s);
        w.into_iter()
    }

    /// The years whose window of `key` contains `day`.
    pub fn years_containing(&self, key: &str, day: Date) -> Vec<i32> {
        self.windows(key)
            .filter(|(_, s, e)| (*s..=*e).contains(&day))
            .map(|(y, _, _)| y)
            .collect()
    }

    /// The season year of an olay of occasion `key` starting on `starts_on` (spec §4.1): the year
    /// of the first window of `key` that ends on or after it.
    pub fn season_year(&self, key: &str, starts_on: Date) -> Option<i32> {
        self.windows(key)
            .find(|(_, _, e)| *e >= starts_on)
            .map(|(y, _, _)| y)
    }

    pub fn entry(&self, key: &str, year: i32) -> Option<&CalendarEntry> {
        self.entries.iter().find(|e| e.key == key && e.year == year)
    }
}
