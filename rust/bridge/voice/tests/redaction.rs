//! The bridge's types that carry a sentence never print it in `Debug` (lib.rs, Logging; B4 review
//! I7): a value logged or printed by mistake shows a length, not the words.
use jeeta_voice_bridge::talker::{Action, Input, Item, Source};
use jeeta_voice_bridge::text::{Redacted, sentences};
use jt_calls::PhraseSet;

const SAID: &str = "Yarın saat dokuzda kapıda buluşalım.";

fn shows_no_text(shown: &str) {
    for word in ["Yarın", "dokuzda", "kapıda", "buluşalım"] {
        assert!(!shown.contains(word), "{shown}");
    }
    assert!(shown.contains("<36 chars>"), "{shown}");
}

fn item() -> Item {
    Item {
        id: 7,
        source: Source::Core {
            seq: 3,
            agent: true,
        },
        text: SAID.into(),
        barge_in: true,
    }
}

#[test]
fn an_item_and_every_action_that_holds_one_print_no_text() {
    let shown = format!("{:?}", item());
    shows_no_text(&shown);
    assert!(
        shown.contains("id: 7") && shown.contains("seq: 3"),
        "{shown}"
    );
    for action in [
        Action::Play(item()),
        Action::Done(item()),
        Action::Cut {
            item: item(),
            dropped: vec![item()],
        },
        Action::Dropped(vec![item()]),
    ] {
        shows_no_text(&format!("{action:?}"));
        shows_no_text(&format!("{action:#?}"));
    }
}

#[test]
fn a_spoken_input_prints_no_text() {
    let input = Input::Speak {
        seq: 3,
        text: SAID.into(),
        barge_in: false,
        agent: true,
    };
    let shown = format!("{input:?}");
    shows_no_text(&shown);
    assert!(
        shown.contains("seq: 3") && shown.contains("barge_in: false"),
        "{shown}"
    );
    assert_eq!(format!("{:?}", Input::Played { id: 4 }), "Played { id: 4 }");
    assert_eq!(format!("{:?}", Input::CoreLost), "CoreLost");
    // The bridge's own closing (B6 review D).
    shows_no_text(&format!("{:?}", Input::Close { text: SAID.into() }));
}

#[test]
fn a_sentence_prints_its_offsets_and_no_text() {
    let s = sentences(SAID);
    let shown = format!("{s:?}");
    shows_no_text(&shown);
    assert!(
        shown.contains("start: 0") && shown.contains("end: 36"),
        "{shown}"
    );
}

#[test]
fn a_redacted_text_is_its_length_in_characters() {
    assert_eq!(
        format!("{:?}", Redacted("Hâlâ orada mısınız?")),
        "<19 chars>"
    );
    assert_eq!(format!("{:?}", Redacted("")), "<0 chars>");
    // A phrase's source holds no text to hide.
    let phrase = Source::Phrase {
        set: PhraseSet::Filler,
        index: 1,
    };
    assert_eq!(format!("{phrase:?}"), "Phrase { set: Filler, index: 1 }");
}
