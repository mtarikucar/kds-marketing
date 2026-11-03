//! Which of the caller's turns the standalone `slice` answers (plan B6; live use after B7: a caller
//! who spoke only over the opening was never answered, and the call ran to `VOICE_MAX_CALL_S`).
use std::time::Duration;

use jeeta_voice_bridge::slice::{OVER_OPENING_WAIT, ReplyTurn};

#[test]
fn the_first_turn_after_the_opening_is_answered_and_words_over_it_wait() {
    let mut t = ReplyTurn::default();
    t.opening_asked(1);
    assert_eq!(t.utterance("Alo?".into()), None);
    assert!(
        t.said(1),
        "the opening's end starts the wait for another turn"
    );
    assert_eq!(
        t.utterance("Evet, benim.".into()).as_deref(),
        Some("Evet, benim.")
    );
    assert_eq!(t.waited(), None, "answered once");
    assert_eq!(t.utterance("Peki.".into()), None);
}

#[test]
fn a_turn_spoken_only_over_the_opening_is_answered_once_nothing_follows_it() {
    let mut t = ReplyTurn::default();
    t.opening_asked(1);
    assert_eq!(t.utterance("Alo?".into()), None);
    assert_eq!(t.utterance("Evet, benim.".into()), None);
    assert!(t.said(1));
    // The words over the opening are the turn: the latest of them is shown.
    assert_eq!(t.waited().as_deref(), Some("Evet, benim."));
    assert_eq!(t.waited(), None);
    assert_eq!(t.utterance("Alo?".into()), None, "answered once");
}

#[test]
fn nothing_waits_without_words_over_the_opening_or_before_its_end() {
    let mut t = ReplyTurn::default();
    t.opening_asked(1);
    assert_eq!(t.utterance("Alo?".into()), None);
    assert!(!t.said(7), "another line's end is not the opening's");
    assert_eq!(t.waited(), None, "the opening still plays");

    let mut t = ReplyTurn::default();
    t.opening_asked(1);
    assert!(!t.said(1));
    assert_eq!(t.waited(), None);
    assert_eq!(t.utterance("Evet.".into()).as_deref(), Some("Evet."));
}

#[test]
fn the_wait_is_the_listeners_end_of_turn_silence() {
    // Design addendum §6: without Smart Turn's "complete", 1.5 s of silence ends a turn.
    assert_eq!(OVER_OPENING_WAIT, Duration::from_millis(1_500));
}
