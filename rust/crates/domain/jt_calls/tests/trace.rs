//! A caller turn's timings and their percentiles (design addendum §7).
use jt_calls::{
    AgentReply, BARGE_IN_P95_ALERT_MS, CONTENT_P95_ALERT_MS, EndpointBy, PERCEIVED_P95_ALERT_MS,
    TurnTrace, percentiles, summarize,
};

fn turn(ack: Option<u32>, first_audio: Option<u32>) -> TurnTrace {
    TurnTrace {
        endpoint_ms: 260,
        endpoint_by: Some(EndpointBy::SmartTurn),
        stt_final_ms: 310,
        delivered_ms: Some(340),
        say_ms: Some(4_340),
        tts_first_ms: Some(4_700),
        first_audio_ms: first_audio,
        ack_ms: ack,
        barge_in_stop_ms: None,
        backchannel_cut: false,
        reply_seq: None,
    }
}

#[test]
fn nearest_rank_percentiles() {
    let p = percentiles([400, 100, 300, 200]);
    assert_eq!((p.n, p.p50, p.p95), (4, Some(200), Some(400)));
    let p = percentiles(1..=100);
    assert_eq!((p.n, p.p50, p.p95), (100, Some(50), Some(95)));
    let p = percentiles([7]);
    assert_eq!((p.p50, p.p95), (Some(7), Some(7)));
    let p = percentiles(std::iter::empty());
    assert_eq!((p.n, p.p50, p.p95), (0, None, None));
}

#[test]
fn perceived_is_the_first_sound_and_content_the_reply() {
    let t = turn(Some(620), Some(4_760));
    assert_eq!(t.perceived_ms(), Some(620));
    assert_eq!(t.core_round_ms(), Some(4_000));
    assert_eq!(turn(None, Some(900)).perceived_ms(), Some(900));
    assert_eq!(turn(None, None).perceived_ms(), None);
}

#[test]
fn summary_alerts_on_the_reports_thresholds() {
    let traces = vec![turn(Some(620), Some(4_760)), turn(Some(640), Some(3_900))];
    let s = summarize(&traces, &[4_100, 3_200], &[]);
    assert_eq!(s.turns, 2);
    assert_eq!(s.perceived.p95, Some(640));
    assert_eq!(s.content.p95, Some(4_760));
    assert_eq!(s.agent.p50, Some(3_200));
    assert!(s.content.p95.unwrap() > CONTENT_P95_ALERT_MS);
    assert_eq!(s.alerts, vec!["content_p95_over_3s".to_owned()]);
    let slow = vec![turn(Some(1_200), Some(1_500))];
    let s = summarize(&slow, &[], &[]);
    assert!(s.perceived.p95.unwrap() > PERCEIVED_P95_ALERT_MS);
    assert_eq!(s.alerts, vec!["perceived_p95_over_1s".to_owned()]);
    let mut cut = turn(Some(600), Some(900));
    cut.barge_in_stop_ms = Some(BARGE_IN_P95_ALERT_MS + 50);
    assert_eq!(
        summarize(&[cut], &[], &[]).alerts,
        vec!["barge_in_p95_over_300ms".to_owned()]
    );
    assert!(summarize(&[], &[], &[]).alerts.is_empty());
}

#[test]
fn a_trace_reads_tolerantly() {
    let t: TurnTrace = serde_json::from_value(serde_json::json!({
        "endpoint_ms": 250, "stt_final_ms": 300
    }))
    .unwrap();
    assert_eq!(t.endpoint_by, None);
    assert_eq!(t.first_audio_ms, None);
    assert_eq!(t.reply_seq, None);
    let t: TurnTrace = serde_json::from_value(serde_json::json!({ "reply_seq": 7 })).unwrap();
    assert_eq!(t.reply_seq, Some(7));
}

// Added in the A2 fix-up: the thresholds are strict (a p95 exactly at the limit is no alert).

#[test]
fn a_p95_exactly_at_a_limit_raises_no_alert_and_one_millisecond_over_does() {
    assert_eq!(
        (
            PERCEIVED_P95_ALERT_MS,
            CONTENT_P95_ALERT_MS,
            BARGE_IN_P95_ALERT_MS
        ),
        (1_000, 3_000, 300)
    );
    let mut at = turn(Some(1_000), Some(3_000));
    at.barge_in_stop_ms = Some(300);
    let s = summarize(&[at], &[], &[]);
    assert_eq!(s.perceived.p95, Some(1_000));
    assert_eq!(s.content.p95, Some(3_000));
    assert_eq!(s.barge_in_stop.p95, Some(300));
    assert!(s.alerts.is_empty(), "{:?}", s.alerts);

    let mut over = turn(Some(1_001), Some(3_001));
    over.barge_in_stop_ms = Some(301);
    assert_eq!(
        summarize(&[over], &[], &[]).alerts,
        [
            "perceived_p95_over_1s",
            "content_p95_over_3s",
            "barge_in_p95_over_300ms"
        ]
    );
}

#[test]
fn each_alert_is_raised_on_its_own_measure_only() {
    // Perceived is the smaller of the acknowledgement and the reply, so a slow reply behind a
    // quick acknowledgement alerts on content alone.
    let quick_ack_slow_reply = turn(Some(500), Some(3_500));
    assert_eq!(
        summarize(&[quick_ack_slow_reply], &[], &[]).alerts,
        ["content_p95_over_3s"]
    );
    // A turn with no sound at all alerts on nothing: there is nothing to measure.
    assert!(summarize(&[turn(None, None)], &[], &[]).alerts.is_empty());
}

#[test]
fn the_p95_of_twenty_turns_ignores_only_the_worst_one() {
    let slow = |ms| turn(Some(ms), Some(ms));
    let mut traces = vec![slow(600); 19];
    traces.push(slow(5_000));
    let s = summarize(&traces, &[], &[]);
    assert_eq!(s.perceived.p95, Some(600));
    assert!(s.alerts.is_empty(), "{:?}", s.alerts);
    traces[18] = slow(5_000);
    let s = summarize(&traces, &[], &[]);
    assert_eq!(s.perceived.p95, Some(5_000));
    assert_eq!(s.alerts, ["perceived_p95_over_1s", "content_p95_over_3s"]);
}

#[test]
fn nearest_rank_is_the_smallest_rank_covering_the_share_for_every_size() {
    // Pinned against the definition itself (the smallest k with k / n >= q), not against a
    // formula: no rounding of a float product may move a rank by one.
    for n in 1..=400_u32 {
        let p = percentiles(1..=n);
        let smallest = |num: u32, den: u32| (1..=n).find(|k| k * den >= num * n).unwrap();
        assert_eq!(p.n, n);
        assert_eq!(p.p50, Some(smallest(50, 100)), "n = {n}");
        assert_eq!(p.p95, Some(smallest(95, 100)), "n = {n}");
    }
    assert_eq!(percentiles(1..=20).p95, Some(19));
    assert_eq!(percentiles(1..=40).p95, Some(38));
    assert_eq!(percentiles(1..=21).p95, Some(20));
}

#[test]
fn percentiles_ignore_input_order_and_keep_duplicates() {
    let p = percentiles([5, 1, 5, 5, 1, 9]);
    assert_eq!((p.n, p.p50, p.p95), (6, Some(5), Some(9)));
}

// Added in the third A2 fix-up: the transport overhead, matched by the reply's seq.

/// A turn the core answered: its trace names the agent `say` (`reply_seq`) that arrived `say_ms`
/// after speech end, the core having answered the utterance `delivered_ms` after it.
fn answered(reply_seq: u32, delivered_ms: u32, say_ms: u32) -> TurnTrace {
    TurnTrace {
        delivered_ms: Some(delivered_ms),
        say_ms: Some(say_ms),
        reply_seq: Some(reply_seq),
        ..TurnTrace::default()
    }
}

/// The last turn of a call, which the agent never answered: a trace with no reply.
fn unanswered() -> TurnTrace {
    TurnTrace {
        delivered_ms: Some(300),
        ..TurnTrace::default()
    }
}

fn reply(seq: u32, latency_ms: u32) -> AgentReply {
    AgentReply { seq, latency_ms }
}

#[test]
fn transport_is_the_core_round_less_the_latency_of_the_named_reply() {
    // The replies are listed in the other order: the match is by seq, not by position.
    let traces = [answered(3, 340, 4_340), answered(7, 100, 3_100)];
    let replies = [reply(7, 2_950), reply(3, 3_900)];
    let s = summarize(&traces, &[3_900, 2_950], &replies);
    assert_eq!(
        (s.transport.n, s.transport.p50, s.transport.p95),
        (2, Some(50), Some(100))
    );
    // The measures that do not need the pairing are unchanged.
    assert_eq!(s.core_round.n, 2);
    assert_eq!(s.agent.n, 2);
}

#[test]
fn a_trace_without_a_reply_seq_is_left_out_of_transport() {
    let mut no_key = answered(3, 340, 4_340);
    no_key.reply_seq = None;
    let s = summarize(&[no_key, unanswered()], &[3_900], &[reply(3, 3_900)]);
    assert_eq!(s.transport, Default::default());
    // A trace whose say came before the core answered has no core round either.
    let backwards = answered(3, 500, 400);
    let s = summarize(&[backwards], &[3_900], &[reply(3, 3_900)]);
    assert_eq!(s.transport.n, 0);
}

#[test]
fn a_seq_with_no_latency_is_left_out_of_transport() {
    // The agent spoke when nothing was owed (no latency recorded), or the seq is a core `play`.
    let traces = [answered(3, 340, 4_340), answered(9, 100, 3_100)];
    let s = summarize(&traces, &[3_900], &[reply(3, 3_900)]);
    assert_eq!((s.transport.n, s.transport.p95), (1, Some(100)));
    let s = summarize(&traces, &[], &[]);
    assert_eq!(s.transport, Default::default());
}

#[test]
fn transport_saturates_at_zero_when_the_two_windows_differ_by_the_post_tail() {
    // The core's wait began when it took the utterance; the bridge's round began when its POST was
    // answered, a little later: the core's latency can exceed the bridge's round.
    let s = summarize(&[answered(3, 400, 4_300)], &[3_950], &[reply(3, 3_950)]);
    assert_eq!(
        (s.transport.n, s.transport.p50, s.transport.p95),
        (1, Some(0), Some(0))
    );
}

#[test]
fn the_e3_scripts_shapes_pair_what_they_can() {
    // Three caller turns, the last unanswered, two replies: two pairs.
    let traces = [
        answered(2, 300, 2_300),
        answered(4, 300, 3_300),
        unanswered(),
    ];
    let s = summarize(
        &traces,
        &[2_000, 3_000],
        &[reply(2, 2_000), reply(4, 3_000)],
    );
    assert_eq!(s.turns, 3);
    assert_eq!((s.transport.n, s.transport.p95), (2, Some(0)));
    // Two caller turns, the last unanswered, one reply: one pair.
    let traces = [answered(2, 300, 2_380), unanswered()];
    let s = summarize(&traces, &[2_000], &[reply(2, 2_000)]);
    assert_eq!((s.transport.n, s.transport.p95), (1, Some(80)));
    // A latency no trace names (a key press the agent answered, a say after a fallback line) is
    // simply not used, and the counts need not agree.
    let traces = [answered(2, 300, 2_300), answered(4, 300, 3_340)];
    let replies = [
        reply(2, 2_000),
        reply(4, 3_000),
        reply(6, 1_200),
        reply(8, 900),
    ];
    let s = summarize(&traces, &[2_000, 3_000, 1_200, 900], &replies);
    assert_eq!(
        (s.transport.n, s.transport.p50, s.transport.p95),
        (2, Some(0), Some(40))
    );
}

#[test]
fn the_first_latency_of_a_seq_is_the_one_used() {
    let s = summarize(
        &[answered(3, 340, 4_340)],
        &[3_900, 1_000],
        &[reply(3, 3_900), reply(3, 1_000)],
    );
    assert_eq!(s.transport.p95, Some(100));
}

#[test]
fn transport_is_not_an_alert() {
    let s = summarize(&[answered(3, 100, 5_100)], &[1_000], &[reply(3, 1_000)]);
    assert_eq!(s.transport.p95, Some(4_000));
    assert!(
        !s.alerts.iter().any(|a| a.contains("transport")),
        "{:?}",
        s.alerts
    );
}
