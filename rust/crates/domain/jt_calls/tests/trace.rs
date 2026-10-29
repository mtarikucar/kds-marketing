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
