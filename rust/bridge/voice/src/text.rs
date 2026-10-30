//! Sentences of a text to speak, with their character offsets (so a cut can say how much was
//! heard), and the caller's acknowledgement words. Synthesis and the phrase cache work sentence by
//! sentence; a number, a clock time, an ordinal or an abbreviation is never split, and a piece of
//! fewer than three words is never a sentence of its own. The speak service cuts by the same rules
//! (`split_sentences` of `speech/speak/jeeta_speak.py`), and both tests hold one table
//! (`speech/speak/tests/speak_sentence_cases.py`), so a sentence sent alone is one stream there.

use std::fmt;

/// A text in `Debug` as its length only (`<36 chars>`): what the bridge's types that carry a
/// sentence print instead of it (lib.rs, Logging).
pub struct Redacted<'a>(pub &'a str);

impl fmt::Debug for Redacted<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "<{} chars>", self.0.chars().count())
    }
}

/// A sentence: characters `[start, end)` of the original text, and its text. `Debug` prints the
/// offsets and the text's length.
#[derive(Clone, PartialEq, Eq)]
pub struct Sentence {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

impl fmt::Debug for Sentence {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Sentence")
            .field("start", &self.start)
            .field("end", &self.end)
            .field("text", &Redacted(&self.text))
            .finish()
    }
}

/// Words a period after which ends no sentence (the speak service keeps the same list:
/// `speech/speak/jeeta_speak.py`, `ABBREVIATIONS`). "bul", "tel", "sok" and "no" are words too
/// (find, wire, put in, no): a sentence that ends in one is not cut there, kept for that parity.
pub const ABBREVIATIONS: [&str; 18] = [
    "dr", "sn", "av", "prof", "doç", "yrd", "no", "tel", "vb", "vs", "ltd", "şti", "cad", "sok",
    "mah", "apt", "bul", "st",
];
/// Words that follow an ordinal in capitals in addresses and sports ("4. Levent", "3. Kat",
/// "1. Lig", "2. Dünya"): a period after a number in digits before one of them ends no sentence.
/// The speak service keeps the same list (`ORDINAL_NOUNS`); before any other capitalised word the
/// period ends the sentence, right for "Kapı numarası 12. Ondan sonra…", wrong for "Sultan 4.
/// Murat" (both cases of the shared table).
pub const ORDINAL_NOUNS: [&str; 9] = [
    "kat", "blok", "etap", "levent", "bölge", "lig", "dünya", "cadde", "sokak",
];
/// A sentence longer than this is cut at its next comma.
const MAX_SENTENCE_CHARS: usize = 220;
/// A piece of fewer words joins the next one, the last one the one before it (the speak
/// service's `MIN_SENTENCE_WORDS`): "Evet. Tamam. Yarın görüşürüz." stays whole.
const MIN_SENTENCE_WORDS: usize = 3;
const BACKCHANNEL: [&str; 19] = [
    "hı", "hıhı", "ıhı", "hı-hı", "evet", "tamam", "aynen", "he", "hee", "anladım", "peki",
    "tabii", "tabi", "olur", "ha", "hm", "hmm", "ok", "okey",
];

/// `text` in lower case by Turkish rules (`I` → `ı`, `İ` → `i`).
fn lower_tr(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            'I' => 'ı',
            'İ' => 'i',
            _ => c.to_lowercase().next().unwrap_or(c),
        })
        .collect()
}

/// Whether the word right before the period at `dot` (within the sentence from `start`) is one
/// of [`ABBREVIATIONS`].
fn ends_abbreviation(chars: &[char], start: usize, dot: usize) -> bool {
    let word: String = chars[start..dot]
        .iter()
        .rev()
        .take_while(|c| c.is_alphabetic())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    !word.is_empty() && ABBREVIATIONS.contains(&lower_tr(&word).as_str())
}

/// Whether the period at `dot` (within the sentence from `start`) follows a number written in
/// digits alone and comes before a word in lower case, or one of [`ORDINAL_NOUNS`]: an ordinal
/// ("3. katta", "4. Levent'te"), not an end.
fn ends_ordinal(chars: &[char], start: usize, dot: usize) -> bool {
    let token: Vec<char> = chars[start..dot]
        .iter()
        .rev()
        .take_while(|c| !c.is_whitespace())
        .copied()
        .collect();
    let number = !token.is_empty() && token.iter().all(char::is_ascii_digit);
    let next: String = chars[dot + 1..]
        .iter()
        .skip_while(|c| c.is_whitespace())
        .take_while(|c| c.is_alphabetic())
        .collect();
    let lower = next.chars().next().is_some_and(char::is_lowercase);
    number && (lower || ORDINAL_NOUNS.contains(&lower_tr(&next).as_str()))
}

/// Characters `[start, end)` as a sentence, without their surrounding spaces, if any are left.
fn trimmed(chars: &[char], mut start: usize, mut end: usize) -> Option<Sentence> {
    while start < end && chars[start].is_whitespace() {
        start += 1;
    }
    while end > start && chars[end - 1].is_whitespace() {
        end -= 1;
    }
    (start < end).then(|| Sentence {
        start,
        end,
        text: chars[start..end].iter().collect(),
    })
}

fn words(sentence: &Sentence) -> usize {
    sentence.text.split_whitespace().count()
}

/// `text` cut after `.`, `!`, `?` and `…` followed by a space or the end, except after an
/// abbreviation or an ordinal; a sentence past 220 characters is also cut after its next comma.
/// A piece of fewer than three words then joins the next one (the last, the one before it).
pub fn sentences(text: &str) -> Vec<Sentence> {
    let chars: Vec<char> = text.chars().collect();
    let mut pieces = Vec::new();
    let mut start = 0;
    for i in 0..chars.len() {
        let at_break = i + 1 >= chars.len() || chars[i + 1].is_whitespace();
        let mark = matches!(chars[i], '.' | '!' | '?' | '…');
        let kept = chars[i] == '.'
            && (ends_abbreviation(&chars, start, i) || ends_ordinal(&chars, start, i));
        let long_comma = chars[i] == ',' && at_break && i + 1 - start >= MAX_SENTENCE_CHARS;
        if (mark && at_break && !kept) || long_comma {
            pieces.extend(trimmed(&chars, start, i + 1));
            start = i + 1;
        }
    }
    pieces.extend(trimmed(&chars, start, chars.len()));
    let mut out: Vec<Sentence> = Vec::new();
    let mut pending: Option<Sentence> = None;
    for piece in pieces {
        let joined = match pending.take() {
            Some(first) => trimmed(&chars, first.start, piece.end).unwrap_or(piece),
            None => piece,
        };
        if words(&joined) >= MIN_SENTENCE_WORDS {
            out.push(joined);
        } else {
            pending = Some(joined);
        }
    }
    if let Some(rest) = pending {
        match out.pop() {
            Some(last) => out.extend(trimmed(&chars, last.start, rest.end)),
            None => out.push(rest),
        }
    }
    out
}

/// How many characters of the text the caller heard: every sentence before `finished` (the
/// sentences whose end was reported played) and `fraction` of sentence `finished`.
pub fn heard_chars(sentences: &[Sentence], finished: usize, fraction: f64) -> u32 {
    let Some(current) = sentences.get(finished) else {
        return sentences.last().map_or(0, |s| s.end as u32);
    };
    let share = ((current.end - current.start) as f64 * fraction.clamp(0.0, 1.0)).round() as usize;
    (current.start + share) as u32
}

/// Whether `text` is only acknowledgement words ("hı hı", "evet", "tamam", ...).
pub fn is_backchannel(text: &str) -> bool {
    let lowered = lower_tr(text);
    let words: Vec<&str> = lowered
        .split(|c: char| !(c.is_alphanumeric() || c == '-'))
        .filter(|w| !w.is_empty())
        .collect();
    !words.is_empty() && words.iter().all(|w| BACKCHANNEL.contains(w))
}
