//! The caption truth check (spec 2026-11-03 §7): what a piece's texts claim (a date, a place, an
//! event, a client) against the structured data of its subject's olay and its materials' olays.
//! Deterministic, from structured data only.
//!
//! Text is compared in a Turkish-folded form ([`turkish_fold`]) as whole words: a token matches
//! when its words appear in a text, in order and adjacent, so "Kadıköy'de" names "Kadıköy" but
//! "modası" does not name "Moda". The tokens of an olay are its whole title, each part of its
//! place and client organization (parts are separated by `,` `;` `/` `|` `:` brackets, dashes
//! and a spaced hyphen, so "Moda Sahnesi, Kadıköy, İstanbul" is three tokens), and each word of
//! its client person's current name. A token shorter than [`MIN_TOKEN_CHARS`] characters never
//! matches.
//!
//! These are caption findings, which a human may release (spec D19); the hard findings are the
//! eligibility refusals (`Refusal`), never releasable. A release stores a digest of
//! [`canonical_findings`]: the application hashes that text (this crate holds no hash function).
use crate::{Calendar, Material, MaterialId, Olay, OlayId, SharePermission, Subject};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use time::{Date, Month};
use uuid::Uuid;

/// A token shorter than this, in characters, never matches.
pub const MIN_TOKEN_CHARS: usize = 4;

/// The first line of [`canonical_findings`]: a change of the form changes every digest.
pub const CANONICAL_FINDINGS_HEADER: &str = "jt_studio.caption_findings.v1";

/// What a caption claims that its subject's or its materials' olay data does not back.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptionCode {
    /// The title, place or client organization of a confirmed olay other than the subject's.
    NamesOtherOlay,
    /// Under the generic subject: a used material's olay title, place or client (spec D8).
    NamesMaterialContext,
    /// Under an olay subject: a date outside that olay's days.
    DateOutsideOlay,
    /// Under the generic subject: a date that is one of a used material's olay days.
    DateInGeneric,
    /// Under an archive subject: the olay's season year does not appear.
    ArchiveYearMissing,
    /// A `product_only` material's olay client (organization or person) is named.
    ClientNamedProductOnly,
}

impl CaptionCode {
    pub fn code(self) -> &'static str {
        match self {
            Self::NamesOtherOlay => "names_other_olay",
            Self::NamesMaterialContext => "names_material_context",
            Self::DateOutsideOlay => "date_outside_olay",
            Self::DateInGeneric => "date_in_generic",
            Self::ArchiveYearMissing => "archive_year_missing",
            Self::ClientNamedProductOnly => "client_named_product_only",
        }
    }
}

/// One caption finding: its code, the olay and the material it concerns where there is one, and
/// what matched in folded form (the token, the date as written, or the year that is missing).
#[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
pub struct CaptionFinding {
    pub code: CaptionCode,
    #[serde(default)]
    pub olay_id: Option<OlayId>,
    #[serde(default)]
    pub material_id: Option<MaterialId>,
    pub matched: String,
}

/// `text` in the form the truth check compares: Turkish lowercase (`I` → `ı`, `İ` → `i`), then
/// `ç ğ ı ö ş ü` → `c g i o s u` (and the optional circumflex `â î û` → `a i u`), the combining
/// marks of decomposed input dropped, whitespace runs collapsed to one space and trimmed.
pub fn turkish_fold(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut space = false;
    for c in text.chars() {
        if c.is_whitespace() {
            space = !out.is_empty();
            continue;
        }
        let folded = match c {
            // Combining circumflex, breve, dot above, diaeresis and cedilla.
            '\u{302}' | '\u{306}' | '\u{307}' | '\u{308}' | '\u{327}' => continue,
            'I' | 'ı' | 'İ' | 'î' | 'Î' => 'i',
            'Ç' | 'ç' => 'c',
            'Ğ' | 'ğ' => 'g',
            'Ö' | 'ö' => 'o',
            'Ş' | 'ş' => 's',
            'Ü' | 'ü' | 'û' | 'Û' => 'u',
            'â' | 'Â' => 'a',
            c => {
                if space {
                    out.push(' ');
                    space = false;
                }
                out.extend(c.to_lowercase());
                continue;
            }
        };
        if space {
            out.push(' ');
            space = false;
        }
        out.push(folded);
    }
    out
}

/// The words of folded text: its runs of letters and digits.
fn words(folded: &str) -> Vec<String> {
    folded
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

/// A token: words that match only together, adjacent and in order.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Token {
    words: Vec<String>,
}

impl Token {
    /// The token of `words`, unless it is shorter than [`MIN_TOKEN_CHARS`].
    fn new(words: Vec<String>) -> Option<Token> {
        let token = Token { words };
        (token.text().chars().count() >= MIN_TOKEN_CHARS).then_some(token)
    }

    fn text(&self) -> String {
        self.words.join(" ")
    }

    /// Whether this token's words appear adjacent and in order in `words`.
    fn within(&self, words: &[String]) -> bool {
        !self.words.is_empty() && words.windows(self.words.len()).any(|w| w == self.words)
    }
}

/// What separates the parts of a place or an organization.
const PART_SEPARATORS: &[char] = &[',', ';', '/', '|', ':', '(', ')', '[', ']', '–', '—'];

/// The tokens of a place or an organization: each part between separators, whole.
fn part_tokens(label: &str) -> Vec<Token> {
    turkish_fold(label)
        .replace(" - ", ",")
        .split(PART_SEPARATORS)
        .filter_map(|part| Token::new(words(part)))
        .collect()
}

/// The tokens of a title: the whole title.
fn title_tokens(title: &str) -> Vec<Token> {
    Token::new(words(&turkish_fold(title)))
        .into_iter()
        .collect()
}

/// The tokens of a person's name: each word.
fn name_tokens(name: &str) -> Vec<Token> {
    words(&turkish_fold(name))
        .into_iter()
        .filter_map(|w| Token::new(vec![w]))
        .collect()
}

/// An olay's title, place and client organization tokens.
fn label_tokens(o: &Olay) -> Vec<Token> {
    let mut tokens = title_tokens(&o.title);
    if let Some(place) = &o.place {
        tokens.extend(part_tokens(place));
    }
    tokens.extend(organization_tokens(o));
    tokens
}

fn organization_tokens(o: &Olay) -> Vec<Token> {
    o.client
        .as_ref()
        .and_then(|c| c.organization.as_deref())
        .map(part_tokens)
        .unwrap_or_default()
}

/// The word tokens of an olay's client person's current name, when it is known.
fn person_tokens(o: &Olay, client_names: &[(Uuid, String)]) -> Vec<Token> {
    o.client
        .as_ref()
        .and_then(|c| c.person_id)
        .and_then(|p| client_names.iter().find(|(id, _)| *id == p))
        .map(|(_, name)| name_tokens(name))
        .unwrap_or_default()
}

/// A date a text states, as written.
#[derive(Clone, Debug, PartialEq, Eq)]
struct StatedDate {
    day: u8,
    month: Month,
    year: Option<i32>,
    text: String,
}

impl StatedDate {
    /// Whether it is one of the days `from ..= to`; without a year, in any year they cover.
    fn within(&self, from: Date, to: Date) -> bool {
        let years = match self.year {
            Some(y) => y..=y,
            None => from.year()..=to.year(),
        };
        years
            .filter_map(|y| Date::from_calendar_date(y, self.month, self.day).ok())
            .any(|d| (from..=to).contains(&d))
    }
}

/// The Turkish month names, folded.
const MONTH_NAMES: [(&str, Month); 12] = [
    ("ocak", Month::January),
    ("subat", Month::February),
    ("mart", Month::March),
    ("nisan", Month::April),
    ("mayis", Month::May),
    ("haziran", Month::June),
    ("temmuz", Month::July),
    ("agustos", Month::August),
    ("eylul", Month::September),
    ("ekim", Month::October),
    ("kasim", Month::November),
    ("aralik", Month::December),
];

/// The characters that join the parts of a number (`16.11.2026`, `1/2`, `3,5`, `10:30`).
fn joins_numbers(c: char) -> bool {
    matches!(c, '.' | '/' | ',' | ':')
}

/// Whether a number may start at byte `i` of `s`: not inside a word or another number.
fn starts_clean(s: &str, i: usize) -> bool {
    let mut before = s[..i].chars().rev();
    match before.next() {
        None => true,
        Some(c) if c.is_alphanumeric() => false,
        Some(c) if joins_numbers(c) => !before.next().is_some_and(|c| c.is_ascii_digit()),
        Some(_) => true,
    }
}

/// Whether a date may end at byte `i` of `s`: not inside a word or a longer number.
fn ends_clean(s: &str, i: usize) -> bool {
    let mut after = s[i..].chars();
    match after.next() {
        None => true,
        Some(c) if c.is_alphanumeric() => false,
        Some(c) if joins_numbers(c) => !after.next().is_some_and(|c| c.is_ascii_digit()),
        Some(_) => true,
    }
}

/// The end of the run of ASCII digits starting at byte `i`.
fn digits_end(b: &[u8], i: usize) -> usize {
    i + b[i..].iter().take_while(|c| c.is_ascii_digit()).count()
}

/// A day of a month, checked against a leap year when no year is given.
fn date_of(day: u8, month: u8, year: Option<i32>) -> Option<(u8, Month, Option<i32>)> {
    let month = Month::try_from(month).ok()?;
    Date::from_calendar_date(year.unwrap_or(2024), month, day).ok()?;
    Some((day, month, year))
}

/// The date written as digits from byte `start` (its day ends at `day_end`): `16.11`,
/// `16.11.2026` or `16/11/2026`, and the byte it ends at.
fn numeric_date(s: &str, start: usize, day_end: usize) -> Option<(StatedDate, usize)> {
    let b = s.as_bytes();
    let sep = *b.get(day_end)?;
    if !matches!(sep, b'.' | b'/') || !b.get(day_end + 1).is_some_and(u8::is_ascii_digit) {
        return None;
    }
    let month_end = digits_end(b, day_end + 1);
    if month_end - day_end - 1 > 2 {
        return None;
    }
    let day: u8 = s[start..day_end].parse().ok()?;
    let month: u8 = s[day_end + 1..month_end].parse().ok()?;
    let (year, end) =
        if b.get(month_end) == Some(&sep) && b.get(month_end + 1).is_some_and(u8::is_ascii_digit) {
            let year_end = digits_end(b, month_end + 1);
            if year_end - month_end - 1 != 4 || !ends_clean(s, year_end) {
                return None;
            }
            (Some(s[month_end + 1..year_end].parse().ok()?), year_end)
        } else if sep == b'.' && ends_clean(s, month_end) {
            (None, month_end)
        } else {
            return None;
        };
    let (day, month, year) = date_of(day, month, year)?;
    Some((
        StatedDate {
            day,
            month,
            year,
            text: s[start..end].to_owned(),
        },
        end,
    ))
}

/// The date written with a month name from byte `start` (its day ends at `day_end`):
/// `16 kasim` or `16 kasim 2026`, and the byte it ends at.
fn named_date(s: &str, start: usize, day_end: usize) -> Option<(StatedDate, usize)> {
    let rest = s[day_end..].strip_prefix(' ')?;
    let (name, month) = MONTH_NAMES
        .iter()
        .find(|(name, _)| rest.starts_with(name) && ends_clean(rest, name.len()))?;
    let month_end = day_end + 1 + name.len();
    let b = s.as_bytes();
    // A year follows when four digits stand after one space; anything else is not its year.
    let year_end = (b.get(month_end) == Some(&b' ')
        && b.get(month_end + 1).is_some_and(u8::is_ascii_digit))
    .then(|| digits_end(b, month_end + 1))
    .filter(|year_end| year_end - month_end - 1 == 4 && ends_clean(s, *year_end));
    let year: Option<i32> = match year_end {
        Some(year_end) => Some(s[month_end + 1..year_end].parse().ok()?),
        None => None,
    };
    let day: u8 = s[start..day_end].parse().ok()?;
    let (day, month, year) = date_of(day, u8::from(*month), year)?;
    let end = year_end.unwrap_or(month_end);
    Some((
        StatedDate {
            day,
            month,
            year,
            text: s[start..end].to_owned(),
        },
        end,
    ))
}

/// Every date folded text `s` states, in order.
fn stated_dates(s: &str) -> Vec<StatedDate> {
    let b = s.as_bytes();
    let mut dates = Vec::new();
    let mut i = 0;
    while i < b.len() {
        // A byte that is an ASCII digit is a whole character, so `i` is a char boundary.
        if !b[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        let day_end = digits_end(b, i);
        i = day_end;
        if day_end - start > 2 || !starts_clean(s, start) {
            continue;
        }
        if let Some((date, end)) =
            numeric_date(s, start, day_end).or_else(|| named_date(s, start, day_end))
        {
            dates.push(date);
            i = end;
        }
    }
    dates
}

/// One text source, folded, with its words and its dates.
struct Source {
    words: Vec<String>,
    dates: Vec<StatedDate>,
}

impl Source {
    fn new(text: &str) -> Source {
        let folded = turkish_fold(text);
        Source {
            words: words(&folded),
            dates: stated_dates(&folded),
        }
    }
}

/// What the check reads: the folded sources and the olays.
struct Check<'a> {
    sources: Vec<Source>,
    olays: &'a [Olay],
    found: BTreeSet<CaptionFinding>,
}

impl<'a> Check<'a> {
    fn olay(&self, id: OlayId) -> Option<&'a Olay> {
        self.olays.iter().find(|o| o.id == id)
    }

    fn named(&self, token: &Token) -> bool {
        self.sources.iter().any(|s| token.within(&s.words))
    }

    fn dates(&self) -> impl Iterator<Item = &StatedDate> {
        self.sources.iter().flat_map(|s| &s.dates)
    }

    fn add(
        &mut self,
        code: CaptionCode,
        olay: &Olay,
        material: Option<&Material>,
        matched: String,
    ) {
        self.found.insert(CaptionFinding {
            code,
            olay_id: Some(olay.id),
            material_id: material.map(|m| m.id),
            matched,
        });
    }

    /// Records `code` for every token of `tokens` the texts name.
    fn names(
        &mut self,
        code: CaptionCode,
        olay: &Olay,
        material: Option<&Material>,
        tokens: &[Token],
    ) {
        for t in tokens {
            if self.named(t) {
                self.add(code, olay, material, t.text());
            }
        }
    }
}

/// The caption findings of a piece about `subject` (spec §7). `texts` are its text sources (the
/// piece's text, each adaptation's, an approved TikTok posting-screen title), each checked on
/// its own; `used` the materials it shows; `olays` the workspace's olays (at least the subject's,
/// the used materials' and every confirmed one); `client_names` the current name of each olay
/// client person, read from the inbox at check time (an erased person has none); `calendar` the
/// effective calendar, for an archive's season year. The findings are sorted and unique.
pub fn check_caption(
    texts: &[&str],
    subject: &Subject,
    used: &[&Material],
    olays: &[Olay],
    client_names: &[(Uuid, String)],
    calendar: &Calendar,
) -> Vec<CaptionFinding> {
    let mut cx = Check {
        sources: texts.iter().map(|t| Source::new(t)).collect(),
        olays,
        found: BTreeSet::new(),
    };
    let subject_olay = subject.olay_id().and_then(|id| cx.olay(id));
    let generic = *subject == Subject::Generic;
    // Under the generic subject a used material's olay is its context (below), not another olay.
    let context: BTreeSet<OlayId> = if generic {
        used.iter().filter_map(|m| m.olay_id()).collect()
    } else {
        BTreeSet::new()
    };

    // names_other_olay: unless the token is the subject olay's too (two workshops in one city).
    let own: Vec<Vec<String>> = subject_olay
        .map(label_tokens)
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.words)
        .collect();
    for o in olays
        .iter()
        .filter(|o| o.is_confirmed() && subject.olay_id() != Some(o.id) && !context.contains(&o.id))
    {
        let tokens: Vec<Token> = label_tokens(o)
            .into_iter()
            .filter(|t| !own.iter().any(|words| t.within(words)))
            .collect();
        cx.names(CaptionCode::NamesOtherOlay, o, None, &tokens);
    }

    match (subject, subject_olay) {
        (Subject::Olay { .. }, Some(o)) => {
            let outside: Vec<String> = cx
                .dates()
                .filter(|d| !d.within(o.starts_on, o.ends_on))
                .map(|d| d.text.clone())
                .collect();
            for text in outside {
                cx.add(CaptionCode::DateOutsideOlay, o, None, text);
            }
        }
        (Subject::Archive { .. }, Some(o)) => {
            let year = o
                .occasion
                .as_deref()
                .and_then(|key| calendar.season_year(key, o.starts_on))
                .unwrap_or_else(|| o.starts_on.year())
                .to_string();
            if !cx.sources.iter().any(|s| s.words.contains(&year)) {
                cx.add(CaptionCode::ArchiveYearMissing, o, None, year);
            }
        }
        _ => {}
    }

    for m in used {
        let Some(o) = m.olay_id().and_then(|id| cx.olay(id)) else {
            continue;
        };
        if generic {
            let mut tokens = label_tokens(o);
            tokens.extend(person_tokens(o, client_names));
            cx.names(CaptionCode::NamesMaterialContext, o, Some(m), &tokens);
            let inside: Vec<String> = cx
                .dates()
                .filter(|d| d.within(o.starts_on, o.ends_on))
                .map(|d| d.text.clone())
                .collect();
            for text in inside {
                cx.add(CaptionCode::DateInGeneric, o, Some(m), text);
            }
        }
        if m.share
            .as_ref()
            .is_some_and(|s| s.permission == SharePermission::ProductOnly)
        {
            let mut tokens = organization_tokens(o);
            tokens.extend(person_tokens(o, client_names));
            cx.names(CaptionCode::ClientNamedProductOnly, o, Some(m), &tokens);
        }
    }
    cx.found.into_iter().collect()
}

/// `findings` as one canonical text, whatever their order and repetition: the header line, then
/// one line per unique finding in sorted order, `code|olay id|material id|matched` (`-` for no
/// id; `\`, `|` and control characters in `matched` escaped). Equal sets give equal text and
/// different sets different text; the application stores a hash of it with a release.
pub fn canonical_findings(findings: &[CaptionFinding]) -> String {
    let unique: BTreeSet<&CaptionFinding> = findings.iter().collect();
    let mut out = String::from(CANONICAL_FINDINGS_HEADER);
    out.push('\n');
    let id = |id: Option<Uuid>| id.map_or_else(|| "-".to_owned(), |id| id.to_string());
    for f in unique {
        out.push_str(f.code.code());
        out.push('|');
        out.push_str(&id(f.olay_id.map(|o| o.0)));
        out.push('|');
        out.push_str(&id(f.material_id.map(|m| m.0)));
        out.push('|');
        for c in f.matched.chars() {
            match c {
                '\\' => out.push_str("\\\\"),
                '|' => out.push_str("\\|"),
                c if c.is_control() => out.push_str(&format!("\\u{{{:x}}}", u32::from(c))),
                c => out.push(c),
            }
        }
        out.push('\n');
    }
    out
}
