//! Studio timestamps as they are written and read: always written as RFC 3339 text (a calendar
//! date as `YYYY-MM-DD`), read as that text or as the `time` crate's compact tuple encoding, which
//! is what Studio rows and ledger payloads stored before this module carry: an instant as
//! `[year, ordinal, hour, minute, second, nanosecond, offset_hours, offset_minutes,
//! offset_seconds]` and a date as `[year, ordinal]`. So stored rows keep decoding while every new
//! write, MCP output and panel answer carries text.
//!
//! Use it with `#[serde(with = "crate::time_compat")]` on an `OffsetDateTime`, and the
//! submodules for an `Option<OffsetDateTime>` ([`option`]), an `Option<Date>` ([`date_option`]),
//! a `(start, end)` window ([`window`]), an optional window ([`window_option`]) and a map of
//! windows ([`window_map`]).

use std::fmt;

use serde::de::{self, Deserializer, SeqAccess, Visitor};
use serde::ser::{SerializeTuple, Serializer};
use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::macros::format_description;
use time::{Date, OffsetDateTime, Time, UtcOffset};

/// Writes `at` as RFC 3339 text.
pub fn serialize<S: Serializer>(at: &OffsetDateTime, serializer: S) -> Result<S::Ok, S::Error> {
    time::serde::rfc3339::serialize(at, serializer)
}

/// Reads RFC 3339 text or the legacy 9-tuple.
pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<OffsetDateTime, D::Error> {
    Ok(Instant::deserialize(deserializer)?.0)
}

/// An instant read either way (see the module docs), written as RFC 3339 text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Instant(OffsetDateTime);

impl Serialize for Instant {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serialize(&self.0, serializer)
    }
}

impl<'de> Deserialize<'de> for Instant {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(InstantVisitor)
    }
}

struct InstantVisitor;

/// `value` narrowed to `T`, or the error naming `what`.
fn narrow<T: TryFrom<i64>, E: de::Error>(value: i64, what: &str) -> Result<T, E> {
    T::try_from(value).map_err(|_| E::custom(format!("time tuple {what} out of range")))
}

impl<'de> Visitor<'de> for InstantVisitor {
    type Value = Instant;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("an RFC 3339 timestamp or a 9-element time tuple")
    }

    fn visit_str<E: de::Error>(self, text: &str) -> Result<Instant, E> {
        OffsetDateTime::parse(text, &Rfc3339)
            .map(Instant)
            .map_err(|e| E::custom(format!("not an RFC 3339 timestamp: {e}")))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Instant, A::Error> {
        let mut fields = [0_i64; 9];
        const NAMES: [&str; 9] = [
            "year",
            "day of year",
            "hour",
            "minute",
            "second",
            "nanosecond",
            "offset hours",
            "offset minutes",
            "offset seconds",
        ];
        for (field, name) in fields.iter_mut().zip(NAMES) {
            *field = seq
                .next_element::<i64>()?
                .ok_or_else(|| de::Error::custom(format!("time tuple without its {name}")))?;
        }
        if seq.next_element::<de::IgnoredAny>()?.is_some() {
            return Err(de::Error::custom("time tuple longer than 9 elements"));
        }
        let [year, ordinal, hour, minute, second, nanosecond, oh, om, os] = fields;
        let range = |e: time::error::ComponentRange| de::Error::custom(e.to_string());
        let date = Date::from_ordinal_date(narrow(year, "year")?, narrow(ordinal, "day of year")?)
            .map_err(range)?;
        let time = Time::from_hms_nano(
            narrow(hour, "hour")?,
            narrow(minute, "minute")?,
            narrow(second, "second")?,
            narrow(nanosecond, "nanosecond")?,
        )
        .map_err(range)?;
        let offset = UtcOffset::from_hms(
            narrow(oh, "offset hours")?,
            narrow(om, "offset minutes")?,
            narrow(os, "offset seconds")?,
        )
        .map_err(range)?;
        Ok(Instant(date.with_time(time).assume_offset(offset)))
    }
}

/// `Option<OffsetDateTime>`: `null`, RFC 3339 text or the legacy tuple; written as `null` or text.
pub mod option {
    use super::*;

    pub fn serialize<S: Serializer>(
        at: &Option<OffsetDateTime>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        at.map(Instant).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<OffsetDateTime>, D::Error> {
        Ok(Option::<Instant>::deserialize(deserializer)?.map(|i| i.0))
    }
}

/// A calendar date read either way: `YYYY-MM-DD` or the legacy `[year, ordinal]`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Day(Date);

impl Serialize for Day {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let text = self
            .0
            .format(format_description!("[year]-[month]-[day]"))
            .map_err(serde::ser::Error::custom)?;
        serializer.serialize_str(&text)
    }
}

impl<'de> Deserialize<'de> for Day {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(DayVisitor)
    }
}

struct DayVisitor;

impl<'de> Visitor<'de> for DayVisitor {
    type Value = Day;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a YYYY-MM-DD date or a [year, ordinal] tuple")
    }

    fn visit_str<E: de::Error>(self, text: &str) -> Result<Day, E> {
        Date::parse(text, format_description!("[year]-[month]-[day]"))
            .map(Day)
            .map_err(|e| E::custom(format!("not a YYYY-MM-DD date: {e}")))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Day, A::Error> {
        let year: i32 = seq
            .next_element()?
            .ok_or_else(|| de::Error::custom("date tuple without its year"))?;
        let ordinal: u16 = seq
            .next_element()?
            .ok_or_else(|| de::Error::custom("date tuple without its day of year"))?;
        if seq.next_element::<de::IgnoredAny>()?.is_some() {
            return Err(de::Error::custom("date tuple longer than 2 elements"));
        }
        Date::from_ordinal_date(year, ordinal)
            .map(Day)
            .map_err(|e| de::Error::custom(e.to_string()))
    }
}

/// `Option<Date>`: `null`, `YYYY-MM-DD` or the legacy `[year, ordinal]`; written as `null` or text.
pub mod date_option {
    use super::*;

    pub fn serialize<S: Serializer>(day: &Option<Date>, serializer: S) -> Result<S::Ok, S::Error> {
        day.map(Day).serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Date>, D::Error> {
        Ok(Option::<Day>::deserialize(deserializer)?.map(|d| d.0))
    }
}

/// A `(start, end)` window: a two-element array of instants, each read either way.
pub mod window {
    use super::*;

    pub fn serialize<S: Serializer>(
        (start, end): &(OffsetDateTime, OffsetDateTime),
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        let mut pair = serializer.serialize_tuple(2)?;
        pair.serialize_element(&Instant(*start))?;
        pair.serialize_element(&Instant(*end))?;
        pair.end()
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<(OffsetDateTime, OffsetDateTime), D::Error> {
        let (start, end) = <(Instant, Instant)>::deserialize(deserializer)?;
        Ok((start.0, end.0))
    }
}

/// An optional [`window`].
pub mod window_option {
    use super::*;

    pub fn serialize<S: Serializer>(
        value: &Option<(OffsetDateTime, OffsetDateTime)>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        value
            .map(|(start, end)| (Instant(start), Instant(end)))
            .serialize(serializer)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<(OffsetDateTime, OffsetDateTime)>, D::Error> {
        Ok(Option::<(Instant, Instant)>::deserialize(deserializer)?.map(|(s, e)| (s.0, e.0)))
    }
}

/// A map of [`window`]s by key.
pub mod window_map {
    use std::collections::BTreeMap;

    use super::*;

    pub fn serialize<S: Serializer, K: Serialize + Ord>(
        value: &BTreeMap<K, (OffsetDateTime, OffsetDateTime)>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        serializer.collect_map(
            value
                .iter()
                .map(|(k, (start, end))| (k, (Instant(*start), Instant(*end)))),
        )
    }

    pub fn deserialize<'de, D: Deserializer<'de>, K: Deserialize<'de> + Ord>(
        deserializer: D,
    ) -> Result<BTreeMap<K, (OffsetDateTime, OffsetDateTime)>, D::Error> {
        Ok(
            BTreeMap::<K, (Instant, Instant)>::deserialize(deserializer)?
                .into_iter()
                .map(|(k, (s, e))| (k, (s.0, e.0)))
                .collect(),
        )
    }
}
