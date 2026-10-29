//! Sentences of a text to speak, with their character offsets (so a cut can say how much was
//! heard), and the caller's acknowledgement words. Synthesis and the phrase cache work sentence by
//! sentence; a number, a clock time or an abbreviation is never split.

/// A sentence: characters `[start, end)` of the original text, and its text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sentence {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

/// Words a period after which ends no sentence (the speak service keeps the same list:
/// `speech/speak/jeeta_speak.py`, `ABBREVIATIONS`).
const ABBREVIATIONS: [&str; 18] = [
    "dr", "sn", "av", "prof", "doç", "yrd", "no", "tel", "vb", "vs", "ltd", "şti", "cad", "sok",
    "mah", "apt", "bul", "st",
];
/// A sentence longer than this is cut at its next comma.
const MAX_SENTENCE_CHARS: usize = 220;
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

/// Adds characters `[start, end)` to `out` as a sentence, without their surrounding spaces.
fn push(out: &mut Vec<Sentence>, chars: &[char], mut start: usize, mut end: usize) {
    while start < end && chars[start].is_whitespace() {
        start += 1;
    }
    while end > start && chars[end - 1].is_whitespace() {
        end -= 1;
    }
    if start < end {
        out.push(Sentence {
            start,
            end,
            text: chars[start..end].iter().collect(),
        });
    }
}

/// `text` cut after `.`, `!`, `?` and `…` followed by a space or the end, except after an
/// abbreviation; a sentence past 220 characters is also cut after its next comma.
pub fn sentences(text: &str) -> Vec<Sentence> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut start = 0;
    for i in 0..chars.len() {
        let at_break = i + 1 >= chars.len() || chars[i + 1].is_whitespace();
        let mark = matches!(chars[i], '.' | '!' | '?' | '…');
        let sentence_end =
            mark && at_break && !(chars[i] == '.' && ends_abbreviation(&chars, start, i));
        let long_comma = chars[i] == ',' && at_break && i + 1 - start >= MAX_SENTENCE_CHARS;
        if sentence_end || long_comma {
            push(&mut out, &chars, start, i + 1);
            start = i + 1;
        }
    }
    push(&mut out, &chars, start, chars.len());
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
