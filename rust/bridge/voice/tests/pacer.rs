//! The media pacer (B1 review): one frame per 20 ms from `MEDIA_START`, silence when nothing is
//! queued, at most the lead ahead of Asterisk, paused by XOFF, back at once after a flush.
use jeeta_voice_bridge::media::{Out, Pacer};

fn frames(out: &[Out]) -> Vec<bool> {
    out.iter()
        .filter_map(|o| match o {
            Out::Frame { silence, .. } => Some(*silence),
            Out::Mark(_) => None,
        })
        .collect()
}

#[test]
fn silence_flows_from_media_start_one_frame_per_20_ms() {
    let mut p = Pacer::new(160, 0xD5, 1_000);
    let first = p.due(1_000);
    assert_eq!(first.len(), 3, "the lead at once");
    assert!(first.iter().all(|o| *o
        == Out::Frame {
            bytes: vec![0xD5; 160],
            silence: true
        }));
    assert!(p.due(1_019).is_empty());
    assert_eq!(frames(&p.due(1_020)), [true]);
    // Within the lead (B5 review: owing more than it is a stall, see below).
    assert_eq!(
        frames(&p.due(1_060)),
        [true; 2],
        "6 written by 60 ms: 3 periods and the lead"
    );
    assert_eq!(frames(&p.due(1_080)), [true]);
    assert_eq!(
        Pacer::new(160, 0xFF, 0).due(0)[0],
        Out::Frame {
            bytes: vec![0xFF; 160],
            silence: true
        }
    );
}

#[test]
fn audio_goes_in_whole_frames_and_a_sentence_tail_is_padded_before_its_mark() {
    let mut p = Pacer::new(160, 0xD5, 0);
    p.audio(&[0x11; 250]);
    p.audio(&[0x22; 150]); // 400 bytes: two whole frames and 80 waiting for the sentence's end
    p.mark("7:0");
    let out = p.due(0);
    let mut tail = vec![0x22; 80];
    tail.resize(160, 0xD5);
    let mut second = vec![0x11; 90];
    second.extend([0x22; 70]);
    assert_eq!(
        out,
        [
            Out::Frame {
                bytes: vec![0x11; 160],
                silence: false
            },
            Out::Frame {
                bytes: second,
                silence: false
            },
            Out::Frame {
                bytes: tail,
                silence: false
            },
            Out::Mark("7:0".into()),
        ]
    );
    assert!(p.is_idle());
    assert_eq!(
        frames(&p.due(20)),
        [true],
        "silence again, and no mark for it"
    );
}

#[test]
fn asterisk_never_holds_more_than_the_lead() {
    let mut p = Pacer::new(160, 0xD5, 0);
    p.audio(&[0x11; 1_600]);
    p.mark("1:0");
    assert_eq!(frames(&p.due(0)), [false; 3]);
    for t in 1..=6 {
        assert_eq!(
            p.due(t * 20),
            [Out::Frame {
                bytes: vec![0x11; 160],
                silence: false
            }],
            "one per period"
        );
    }
    // The tenth and last frame at 140 ms, its mark right after it; then silence.
    assert_eq!(
        p.due(140),
        [
            Out::Frame {
                bytes: vec![0x11; 160],
                silence: false
            },
            Out::Mark("1:0".into())
        ]
    );
    assert_eq!(frames(&p.due(160)), [true]);
}

#[test]
fn a_flush_drops_the_queue_and_writes_the_lead_of_silence_at_once() {
    let mut p = Pacer::new(160, 0xD5, 0);
    p.audio(&[0x11; 1_600]);
    p.mark("1:0");
    p.due(0);
    p.due(20);
    p.audio(&[0x33; 10]);
    p.flush(30);
    assert!(p.is_idle());
    let out = p.due(30);
    assert_eq!(
        frames(&out),
        [true; 3],
        "no real frame and no mark survive the flush"
    );
    assert!(p.due(49).is_empty());
    assert_eq!(frames(&p.due(50)), [true]);
}

#[test]
fn xoff_pauses_and_xon_resumes_with_the_lead_not_a_burst() {
    let mut p = Pacer::new(160, 0xD5, 0);
    p.due(0);
    p.pause();
    assert!(p.due(400).is_empty());
    p.resume(600);
    assert_eq!(frames(&p.due(600)), [true; 3]);
    assert_eq!(frames(&p.due(620)), [true]);
}

#[test]
fn a_held_up_loop_restarts_the_clock_instead_of_bursting() {
    let mut p = Pacer::new(160, 0xD5, 0);
    p.due(0);
    assert_eq!(frames(&p.due(60)).len(), 3, "a late tick is caught up");
    assert_eq!(
        frames(&p.due(2_000)).len(),
        3,
        "a 2 s stall: the lead again, not 97 frames"
    );
    assert_eq!(frames(&p.due(2_020)).len(), 1);
}

/// B5 review: Asterisk does not skip ahead after it ran dry, so a catch-up of more than the lead
/// would stay queued in it for the rest of the call (a later start and mark on every sentence).
/// Owing more than the lead writes the lead again.
#[test]
fn a_stall_past_the_lead_writes_the_lead_again_not_a_catch_up() {
    let mut p = Pacer::new(160, 0xD5, 0);
    p.due(0);
    assert_eq!(
        frames(&p.due(100)).len(),
        3,
        "100 ms late: the lead, not 5 frames"
    );
    assert_eq!(frames(&p.due(120)).len(), 1);
    assert_eq!(
        frames(&p.due(180)).len(),
        3,
        "60 ms late: Asterisk still held the lead, so it is caught up"
    );
}

#[test]
fn a_mark_with_nothing_queued_goes_out_at_once() {
    let mut p = Pacer::new(160, 0xD5, 0);
    p.due(0);
    p.mark("2:0");
    assert_eq!(p.due(0), [Out::Mark("2:0".into())]);
}
