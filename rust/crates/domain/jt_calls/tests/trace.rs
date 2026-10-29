//! A caller turn's timings and their percentiles (design addendum §7).
use jt_calls::{
    BARGE_IN_P95_ALERT_MS, CONTENT_P95_ALERT_MS, EndpointBy, PERCEIVED_P95_ALERT_MS, TurnTrace,
    percentiles, summarize,
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
    let s = summarize(&traces, &[4_100, 3_200]);
    assert_eq!(s.turns, 2);
    assert_eq!(s.perceived.p95, Some(640));
    assert_eq!(s.content.p95, Some(4_760));
    assert_eq!(s.agent.p50, Some(3_200));
    assert!(s.content.p95.unwrap() > CONTENT_P95_ALERT_MS);
    assert_eq!(s.alerts, vec!["content_p95_over_3s".to_owned()]);
    let slow = vec![turn(Some(1_200), Some(1_500))];
    let s = summarize(&slow, &[]);
    assert!(s.perceived.p95.unwrap() > PERCEIVED_P95_ALERT_MS);
    assert_eq!(s.alerts, vec!["perceived_p95_over_1s".to_owned()]);
    let mut cut = turn(Some(600), Some(900));
    cut.barge_in_stop_ms = Some(BARGE_IN_P95_ALERT_MS + 50);
    assert_eq!(
        summarize(&[cut], &[]).alerts,
        vec!["barge_in_p95_over_300ms".to_owned()]
    );
    assert!(summarize(&[], &[]).alerts.is_empty());
}

#[test]
fn a_trace_reads_tolerantly() {
    let t: TurnTrace = serde_json::from_value(serde_json::json!({
        "endpoint_ms": 250, "stt_final_ms": 300
    }))
    .unwrap();
    assert_eq!(t.endpoint_by, None);
    assert_eq!(t.first_audio_ms, None);
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
    let s = summarize(&[at], &[]);
    assert_eq!(s.perceived.p95, Some(1_000));
    assert_eq!(s.content.p95, Some(3_000));
    assert_eq!(s.barge_in_stop.p95, Some(300));
    assert!(s.alerts.is_empty(), "{:?}", s.alerts);

    let mut over = turn(Some(1_001), Some(3_001));
    over.barge_in_stop_ms = Some(301);
    assert_eq!(
        summarize(&[over], &[]).alerts,
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
        summarize(&[quick_ack_slow_reply], &[]).alerts,
        ["content_p95_over_3s"]
    );
    // A turn with no sound at all alerts on nothing: there is nothing to measure.
    assert!(summarize(&[turn(None, None)], &[]).alerts.is_empty());
}

#[test]
fn the_p95_of_twenty_turns_ignores_only_the_worst_one() {
    let slow = |ms| turn(Some(ms), Some(ms));
    let mut traces = vec![slow(600); 19];
    traces.push(slow(5_000));
    let s = summarize(&traces, &[]);
    assert_eq!(s.perceived.p95, Some(600));
    assert!(s.alerts.is_empty(), "{:?}", s.alerts);
    traces[18] = slow(5_000);
    let s = summarize(&traces, &[]);
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
