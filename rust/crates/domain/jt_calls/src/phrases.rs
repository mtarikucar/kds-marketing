//! The phrases the voice bridge may play on its own while the agent thinks or the line needs a word
//! (owner decisions V-4 and the approved set of 2026-10-29): acknowledgements, fillers, the long
//! wait, "not heard", "still there" and the fault sentence. They are the policy's text: the bridge
//! picks one by set and index and reports which, and the core logs the policy's text for it. A set
//! left empty is never played.
//!
//! The closing is not a bridge phrase: the core plays it at the scripted ending (`CallPlan.closing`,
//! by default the policy's `closing`).

use serde::{Deserialize, Serialize};

/// Which kind of phrase.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PhraseSet {
    /// Right after the caller's turn, when no reply is queued yet (about 0.6 s).
    Acknowledgement,
    /// The reply is late (about 2.7 s).
    Filler,
    /// The reply is very late (about 8 s).
    LongWait,
    /// The caller spoke but no words were recognised.
    NotHeard,
    /// The caller stayed silent after the agent spoke.
    StillThere,
    /// The bridge lost the core during a call; played before it hangs up.
    Fault,
}

impl PhraseSet {
    pub const ALL: [PhraseSet; 6] = [
        PhraseSet::Acknowledgement,
        PhraseSet::Filler,
        PhraseSet::LongWait,
        PhraseSet::NotHeard,
        PhraseSet::StillThere,
        PhraseSet::Fault,
    ];

    /// The set's position in [`PhraseSet::ALL`].
    pub fn position(self) -> usize {
        PhraseSet::ALL
            .iter()
            .position(|s| *s == self)
            .unwrap_or_default()
    }
}

/// The policy's phrases, one list per set.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct BridgePhrases {
    pub acknowledgements: Vec<String>,
    pub fillers: Vec<String>,
    pub long_wait: Vec<String>,
    pub not_heard: Vec<String>,
    pub still_there: Vec<String>,
    pub fault: Vec<String>,
}

fn lines(texts: &[&str]) -> Vec<String> {
    texts.iter().map(|t| (*t).to_owned()).collect()
}

impl Default for BridgePhrases {
    /// The set the owner approved on 2026-10-29.
    fn default() -> Self {
        BridgePhrases {
            acknowledgements: lines(&["Hı hı.", "Anladım.", "Tamam.", "Peki."]),
            fillers: lines(&[
                "Bir saniye, hemen bakıyorum.",
                "Kontrol ediyorum, kısa bir an.",
            ]),
            long_wait: lines(&["Biraz daha zaman alıyor, beklediğiniz için teşekkürler."]),
            not_heard: lines(&["Sizi tam duyamadım, tekrar eder misiniz?"]),
            still_there: lines(&["Hâlâ orada mısınız?"]),
            fault: lines(&[
                "Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız.",
            ]),
        }
    }
}

impl BridgePhrases {
    /// The phrases of `set`.
    pub fn set(&self, set: PhraseSet) -> &[String] {
        match set {
            PhraseSet::Acknowledgement => &self.acknowledgements,
            PhraseSet::Filler => &self.fillers,
            PhraseSet::LongWait => &self.long_wait,
            PhraseSet::NotHeard => &self.not_heard,
            PhraseSet::StillThere => &self.still_there,
            PhraseSet::Fault => &self.fault,
        }
    }

    /// Phrase `index` of `set`, if there is one.
    pub fn text(&self, set: PhraseSet, index: u8) -> Option<&str> {
        self.set(set).get(usize::from(index)).map(String::as_str)
    }

    /// Every phrase, set by set.
    pub fn all(&self) -> impl Iterator<Item = &str> {
        PhraseSet::ALL
            .into_iter()
            .flat_map(move |s| self.set(s).iter().map(String::as_str))
    }
}
