//! One call's talker against a scripted clock (design addendum §3).
use jeeta_voice_bridge::talker::{Action, Input, Source, Talker, Timing};
use jt_calls::{BridgePhrases, PhraseSet};

fn talker() -> Talker {
    Talker::new(Timing::default(), BridgePhrases::default())
}

fn plays(actions: &[Action]) -> Vec<String> {
    actions
        .iter()
        .filter_map(|a| match a {
            Action::Play(item) => Some(item.text.clone()),
            _ => None,
        })
        .collect()
}

/// Every item `actions` started plays to its end at `now`.
fn finish(t: &mut Talker, actions: &[Action], now: u64) -> Vec<Action> {
    let mut out = Vec::new();
    for a in actions {
        if let Action::Play(item) = a {
            out.extend(t.on(Input::Played { id: item.id }, now));
        }
    }
    out
}

fn say(seq: u32, text: &str) -> Input {
    Input::Speak {
        seq,
        text: text.into(),
        barge_in: true,
        agent: true,
    }
}

#[test]
fn an_acknowledgement_plays_600_ms_after_the_callers_turn() {
    let mut t = talker();
    t.on(Input::Final, 1_000);
    assert!(plays(&t.on(Input::Tick, 1_580)).is_empty());
    let a = t.on(Input::Tick, 1_600);
    assert_eq!(plays(&a), ["Hı hı."]);
    assert!(a.contains(&Action::EchoGuard(true)));
}

#[test]
fn no_acknowledgement_when_the_reply_came_first() {
    let mut t = talker();
    t.on(Input::Final, 1_000);
    assert_eq!(
        plays(&t.on(say(7, "Perşembe uygun."), 1_400)),
        ["Perşembe uygun."]
    );
    assert!(plays(&t.on(Input::Tick, 1_700)).is_empty());
    assert!(plays(&t.on(Input::Tick, 4_000)).is_empty());
}

#[test]
fn a_filler_then_the_long_wait_cover_a_slow_reply_and_rotate_next_time() {
    let mut t = talker();
    t.on(Input::Final, 0);
    let ack = t.on(Input::Tick, 600);
    assert_eq!(plays(&ack), ["Hı hı."]);
    finish(&mut t, &ack, 1_100);
    let filler = t.on(Input::Tick, 2_700);
    assert_eq!(plays(&filler), ["Bir saniye, hemen bakıyorum."]);
    finish(&mut t, &filler, 4_500);
    let long = t.on(Input::Tick, 8_000);
    assert_eq!(
        plays(&long),
        ["Biraz daha zaman alıyor, beklediğiniz için teşekkürler."]
    );
    finish(&mut t, &long, 11_000);
    assert!(plays(&t.on(Input::Tick, 15_000)).is_empty());
    t.on(Input::Final, 20_000);
    assert_eq!(plays(&t.on(Input::Tick, 20_600)), ["Anladım."]);
}

#[test]
fn two_phrases_never_play_within_a_second() {
    let mut t = talker();
    t.on(Input::Final, 0);
    let ack = t.on(Input::Tick, 600);
    finish(&mut t, &ack, 2_500);
    assert!(plays(&t.on(Input::Tick, 2_700)).is_empty());
    assert_eq!(
        plays(&t.on(Input::Tick, 3_500)),
        ["Bir saniye, hemen bakıyorum."]
    );
}

#[test]
fn the_caller_cuts_the_agent_and_the_queue_is_dropped() {
    let mut t = talker();
    t.on(say(3, "Uzun bir cümle."), 0);
    t.on(say(4, "İkinci cümle."), 10);
    let cut = t.on(Input::SpeechStart, 500);
    let (item, dropped) = cut
        .iter()
        .find_map(|a| match a {
            Action::Cut { item, dropped } => Some((item.clone(), dropped.clone())),
            _ => None,
        })
        .expect("a cut");
    assert_eq!(
        item.source,
        Source::Core {
            seq: 3,
            agent: true
        }
    );
    assert_eq!(dropped.len(), 1);
    assert!(cut.contains(&Action::EchoGuard(false)));
}

#[test]
fn a_sentence_that_asks_to_be_heard_through_is_not_cut() {
    let mut t = talker();
    t.on(
        Input::Speak {
            seq: 3,
            text: "Önemli bilgi.".into(),
            barge_in: false,
            agent: true,
        },
        0,
    );
    let a = t.on(Input::SpeechStart, 500);
    assert!(!a.iter().any(|x| matches!(x, Action::Cut { .. })));
}

#[test]
fn the_caller_is_asked_once_whether_they_are_still_there() {
    let mut t = talker();
    let a = t.on(say(5, "Hangi gün uygun?"), 0);
    finish(&mut t, &a, 2_000);
    assert!(plays(&t.on(Input::Tick, 10_900)).is_empty());
    assert_eq!(plays(&t.on(Input::Tick, 11_000)), ["Hâlâ orada mısınız?"]);
    let again = t.on(Input::Tick, 30_000);
    assert!(plays(&again).is_empty());
}

#[test]
fn unheard_words_are_asked_again_only_when_nothing_is_owed() {
    let mut t = talker();
    assert_eq!(
        plays(&t.on(Input::Unheard, 100)),
        ["Sizi tam duyamadım, tekrar eder misiniz?"]
    );
    let mut t = talker();
    t.on(Input::Final, 0);
    assert!(plays(&t.on(Input::Unheard, 100)).is_empty());
}

#[test]
fn the_closing_plays_to_its_end_then_the_line_is_hung_up() {
    let mut t = talker();
    let a = t.on(
        Input::Speak {
            seq: 9,
            text: "Görüşmek üzere, iyi günler.".into(),
            barge_in: true,
            agent: false,
        },
        0,
    );
    assert!(!t.on(Input::HangupWhenDone, 5).contains(&Action::Hangup));
    let done = finish(&mut t, &a, 3_000);
    assert!(done.contains(&Action::Hangup));
    assert!(t.on(Input::Tick, 3_020).is_empty());
}

#[test]
fn losing_the_core_plays_the_fault_sentence_and_hangs_up() {
    let mut t = talker();
    t.on(
        Input::Speak {
            seq: 3,
            text: "Bir şey.".into(),
            barge_in: false,
            agent: true,
        },
        0,
    );
    let lost = t.on(Input::CoreLost, 100);
    assert!(lost.iter().any(|a| matches!(a, Action::Cut { .. })));
    assert_eq!(
        plays(&lost),
        ["Kısa bir teknik sorun yaşıyoruz, sizi birkaç dakika içinde geri arayacağız."]
    );
    assert!(finish(&mut t, &lost, 5_000).contains(&Action::Hangup));
}

#[test]
fn nothing_starts_while_the_caller_is_speaking() {
    let mut t = talker();
    t.on(Input::SpeechStart, 0);
    assert!(plays(&t.on(say(2, "Evet."), 100)).is_empty());
    assert_eq!(plays(&t.on(Input::SpeechEnd, 300)), ["Evet."]);
}

#[test]
fn a_phrase_is_reported_by_its_set_and_index() {
    let mut t = talker();
    t.on(Input::Final, 0);
    let a = t.on(Input::Tick, 600);
    let Some(Action::Play(item)) = a.iter().find(|x| matches!(x, Action::Play(_))) else {
        panic!("a phrase");
    };
    assert_eq!(
        item.source,
        Source::Phrase {
            set: PhraseSet::Acknowledgement,
            index: 0
        }
    );
}
