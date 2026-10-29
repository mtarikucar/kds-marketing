//! The talker: what one call does on its own between the core's commands (design addendum §3).
//! Pure: it is told what happened and when (milliseconds since the call was answered, on the
//! bridge's monotonic clock) and answers what to do. It plays only texts it was given: the core's
//! sentences, and the policy's phrases ([`BridgePhrases`]), which it picks by set and rotation.
//!
//! - After the caller's turn, while no reply is queued: an acknowledgement, then a filler, then
//!   the long wait ([`Timing`]); after that the core's fallback line and closing take over. None
//!   plays while a turn of the caller is open (from its start to its final or unheard words),
//!   its pauses included.
//! - After the agent's sentence, while the caller stays silent: "still there", once. A line of
//!   the core (`play`, such as a holding line while the agent works on) ends that wait.
//! - Words that were not heard: "not heard", at once, when nothing is owed, playing or queued.
//! - The core lost: what was queued is dropped, the fault sentence plays, then the line is hung
//!   up; once. A hangup the core already asked for goes on as it was (its closing is not
//!   replaced).
//!
//! The acknowledgement, the filler, the long wait and "still there" start no sooner than
//! [`Timing::phrase_gap_ms`] after the last phrase ended; "not heard" and the fault sentence answer
//! an event and wait for no gap. Nothing starts while the caller speaks, and the caller's speech
//! cuts what plays unless it asked to be heard through (a phrase always may be cut). Once the core
//! asked to hang up (or was lost), the line is hung up as soon as nothing is left to play, whether
//! the last item played to its end or was cut.

use std::collections::VecDeque;

use jt_calls::{BridgePhrases, PhraseSet};

/// Milliseconds since the call was answered.
pub type Ms = u64;

/// When the talker covers a silence (design addendum §3; tuned on real calls).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Timing {
    /// The acknowledgement, after the caller's turn.
    pub ack_after_ms: Ms,
    /// The filler, after the caller's turn.
    pub filler_after_ms: Ms,
    /// The long wait, after the caller's turn.
    pub long_wait_after_ms: Ms,
    /// "Still there", after the agent's sentence ended.
    pub still_there_after_ms: Ms,
    /// No phrase starts sooner than this after the last one ended.
    pub phrase_gap_ms: Ms,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            ack_after_ms: 600,
            filler_after_ms: 2_700,
            long_wait_after_ms: 8_000,
            still_there_after_ms: 9_000,
            phrase_gap_ms: 1_000,
        }
    }
}

/// Where an item's text comes from.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Source {
    /// A command of the core: the agent's `say` (`agent`) or a `play` of the plan or policy.
    Core { seq: u32, agent: bool },
    /// One of the policy's phrases.
    Phrase { set: PhraseSet, index: u8 },
}

/// Something to play.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub id: u64,
    pub source: Source,
    pub text: String,
    pub barge_in: bool,
}

/// What happened.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Input {
    Speak {
        seq: u32,
        text: String,
        barge_in: bool,
        agent: bool,
    },
    /// The core asked to hang up: once everything queued has played.
    HangupWhenDone,
    /// The caller started (or resumed) speaking.
    SpeechStart,
    SpeechEnd,
    /// The caller's turn ended with words (reported to the core).
    Final,
    /// The caller spoke but no words were recognised.
    Unheard,
    /// Item `id` played to its end.
    Played {
        id: u64,
    },
    /// The core is unreachable.
    CoreLost,
    Tick,
}

/// What to do.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Action {
    Play(Item),
    /// Stop `item` now (flush the line), and drop what was queued behind it.
    Cut {
        item: Item,
        dropped: Vec<Item>,
    },
    /// `item` played to its end.
    Done(Item),
    /// Items that were queued and will never play, while nothing played (the core was lost while
    /// the caller held the queue back): reported as heard to their first character.
    Dropped(Vec<Item>),
    /// Raise (or lower) the listener's echo guard: something is (no longer) playing.
    EchoGuard(bool),
    Hangup,
}

/// One call's talker (see the module docs).
pub struct Talker {
    timing: Timing,
    phrases: BridgePhrases,
    next_id: u64,
    queue: VecDeque<Item>,
    playing: Option<Item>,
    guard: bool,
    /// Since when the caller's turn waits for a reply.
    owed_since: Option<Ms>,
    /// How many of the wait's phrases played: 1 the acknowledgement, 2 the filler, 3 the long wait.
    stage: u8,
    /// Since when the agent's sentence waits for the caller.
    awaiting_since: Option<Ms>,
    still_there_done: bool,
    last_phrase_end: Option<Ms>,
    speaking: bool,
    /// From the caller's `SpeechStart` to its `Final` or `Unheard`: a `SpeechEnd` is a pause.
    turn_open: bool,
    hangup_when_done: bool,
    hung_up: bool,
    /// The next phrase of each set, by [`PhraseSet::position`].
    rotation: [usize; PhraseSet::ALL.len()],
}

impl Talker {
    pub fn new(timing: Timing, phrases: BridgePhrases) -> Talker {
        Talker {
            timing,
            phrases,
            next_id: 1,
            queue: VecDeque::new(),
            playing: None,
            guard: false,
            owed_since: None,
            stage: 0,
            awaiting_since: None,
            still_there_done: false,
            last_phrase_end: None,
            speaking: false,
            turn_open: false,
            hangup_when_done: false,
            hung_up: false,
            rotation: [0; PhraseSet::ALL.len()],
        }
    }

    /// Nothing plays and nothing is queued.
    pub fn is_idle(&self) -> bool {
        self.playing.is_none() && self.queue.is_empty()
    }

    /// The item playing now.
    pub fn playing(&self) -> Option<&Item> {
        self.playing.as_ref()
    }

    /// What to do about `input` at `now`.
    pub fn on(&mut self, input: Input, now: Ms) -> Vec<Action> {
        let mut out = Vec::new();
        if self.hung_up {
            return out;
        }
        match input {
            Input::Speak {
                seq,
                text,
                barge_in,
                agent,
            } => {
                if agent {
                    self.owed_since = None;
                    self.stage = 0;
                    self.still_there_done = false;
                }
                // The agent's sentence is waited for again once it has played; a line of the core
                // (a holding line while the agent works on) is no question to the caller.
                self.awaiting_since = None;
                let id = self.id();
                self.queue.push_back(Item {
                    id,
                    source: Source::Core { seq, agent },
                    text,
                    barge_in,
                });
                self.start_next(&mut out);
            }
            Input::HangupWhenDone => self.hangup_when_done = true,
            Input::SpeechStart => {
                self.speaking = true;
                self.turn_open = true;
                self.awaiting_since = None;
                self.cut(false, &mut out);
            }
            Input::SpeechEnd => {
                self.speaking = false;
                self.start_next(&mut out);
            }
            Input::Final => {
                self.speaking = false;
                self.turn_open = false;
                self.owed_since = Some(now);
                self.stage = 0;
                self.awaiting_since = None;
                self.still_there_done = false;
                self.start_next(&mut out);
            }
            Input::Unheard => {
                // The listener may end a turn so without a `SpeechEnd` (its 30 s cut, a failure):
                // what the caller held back plays now.
                self.speaking = false;
                self.turn_open = false;
                self.start_next(&mut out);
                if self.is_idle() && self.owed_since.is_none() && !self.hangup_when_done {
                    self.phrase(PhraseSet::NotHeard, &mut out);
                }
            }
            Input::Played { id } => {
                if let Some(item) = self.playing.take_if(|p| p.id == id) {
                    if matches!(item.source, Source::Phrase { .. }) {
                        self.last_phrase_end = Some(now);
                    }
                    let agent_spoke = matches!(item.source, Source::Core { agent: true, .. });
                    out.push(Action::Done(item));
                    if agent_spoke && self.queue.is_empty() && self.owed_since.is_none() {
                        self.awaiting_since = Some(now);
                        self.still_there_done = false;
                    }
                    self.start_next(&mut out);
                    self.lower_guard_if_silent(&mut out);
                }
            }
            Input::CoreLost => {
                // Once: a second loss (the core came back and went again) restarts nothing, and a
                // hangup the core already asked for ends the call with its own closing.
                if !self.hangup_when_done {
                    self.cut(true, &mut out);
                    let dropped: Vec<Item> = self.queue.drain(..).collect();
                    if !dropped.is_empty() {
                        out.push(Action::Dropped(dropped));
                    }
                    self.owed_since = None;
                    self.awaiting_since = None;
                    self.phrase(PhraseSet::Fault, &mut out);
                    self.hangup_when_done = true;
                }
            }
            Input::Tick => self.cover(now, &mut out),
        }
        // Whatever happened: a line that is to close closes once nothing is left to play.
        self.finish(&mut out);
        out
    }

    fn id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn start_next(&mut self, out: &mut Vec<Action>) {
        if self.playing.is_some() || self.speaking {
            return;
        }
        if let Some(item) = self.queue.pop_front() {
            if !self.guard {
                self.guard = true;
                out.push(Action::EchoGuard(true));
            }
            self.playing = Some(item.clone());
            out.push(Action::Play(item));
        }
    }

    /// Lowers the echo guard when nothing plays, even while the caller holds a queue back.
    fn lower_guard_if_silent(&mut self, out: &mut Vec<Action>) {
        if self.guard && self.playing.is_none() {
            self.guard = false;
            out.push(Action::EchoGuard(false));
        }
    }

    /// Cuts what plays when the caller speaks over it (or always, with `force`).
    fn cut(&mut self, force: bool, out: &mut Vec<Action>) {
        let Some(item) = self.playing.take_if(|p| force || p.barge_in) else {
            return;
        };
        if matches!(item.source, Source::Phrase { .. }) {
            self.last_phrase_end = None;
        }
        let dropped: Vec<Item> = self.queue.drain(..).collect();
        out.push(Action::Cut { item, dropped });
        self.lower_guard_if_silent(out);
    }

    fn finish(&mut self, out: &mut Vec<Action>) {
        if self.hangup_when_done && self.is_idle() && !self.hung_up {
            self.hung_up = true;
            out.push(Action::Hangup);
        }
    }

    /// Covers a silence with the next phrase that is due (see the module docs).
    fn cover(&mut self, now: Ms, out: &mut Vec<Action>) {
        // `turn_open` holds while the caller speaks and through the turn's pauses.
        if !self.is_idle() || self.turn_open || self.hangup_when_done {
            return;
        }
        if self
            .last_phrase_end
            .is_some_and(|end| now.saturating_sub(end) < self.timing.phrase_gap_ms)
        {
            return;
        }
        if let Some(since) = self.owed_since {
            let waited = now.saturating_sub(since);
            let due = if waited >= self.timing.long_wait_after_ms {
                3
            } else if waited >= self.timing.filler_after_ms {
                2
            } else if waited >= self.timing.ack_after_ms {
                1
            } else {
                0
            };
            if due > self.stage {
                self.stage = due;
                let set = match due {
                    1 => PhraseSet::Acknowledgement,
                    2 => PhraseSet::Filler,
                    _ => PhraseSet::LongWait,
                };
                self.phrase(set, out);
            }
            return;
        }
        if let Some(since) = self.awaiting_since
            && !self.still_there_done
            && now.saturating_sub(since) >= self.timing.still_there_after_ms
        {
            self.still_there_done = true;
            self.phrase(PhraseSet::StillThere, out);
        }
    }

    /// Queues the next phrase of `set` (rotating), if the policy has one.
    fn phrase(&mut self, set: PhraseSet, out: &mut Vec<Action>) {
        let count = self.phrases.set(set).len();
        if count == 0 {
            return;
        }
        let slot = set.position();
        let index = self.rotation[slot] % count;
        self.rotation[slot] += 1;
        let text = self.phrases.set(set)[index].clone();
        let id = self.id();
        self.queue.push_back(Item {
            id,
            source: Source::Phrase {
                set,
                index: u8::try_from(index).unwrap_or(u8::MAX),
            },
            text,
            barge_in: true,
        });
        self.start_next(out);
    }
}
