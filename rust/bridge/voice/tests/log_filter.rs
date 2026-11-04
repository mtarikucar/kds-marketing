//! The bridge's log filter: whatever `JEETA_VOICE_BRIDGE_LOG` asks, the HTTP and WebSocket
//! libraries log at `info` at most, since their `debug` and `trace` lines carry what crosses the
//! wire (a frame of a transcript, a dial's number). Review of D, L7.
use jeeta_voice_bridge::log_filter;

const QUIET: [&str; 5] = [
    "tungstenite",
    "tokio_tungstenite",
    "hyper",
    "hyper_util",
    "reqwest",
];

#[test]
fn the_wire_libraries_never_log_below_info_whatever_the_level() {
    for spec in [
        None,
        Some("info"),
        Some("trace"),
        Some("debug,jeeta_voice_bridge=trace"),
        Some("trace,tungstenite=trace,reqwest=debug,hyper::proto=trace"),
        Some(" , ,"),
    ] {
        let shown = log_filter(spec).to_string();
        let directives: Vec<&str> = shown.split(',').collect();
        for target in QUIET {
            let own: Vec<&&str> = directives
                .iter()
                .filter(|d| {
                    d.split('=').next() == Some(target) || d.starts_with(&format!("{target}::"))
                })
                .collect();
            assert_eq!(
                own,
                [&format!("{target}=info").as_str()],
                "{spec:?}: {shown}"
            );
        }
    }
    // The bridge's own level is the one asked for, `info` without one.
    assert!(
        log_filter(Some("debug,jeeta_voice_bridge=trace"))
            .to_string()
            .contains("jeeta_voice_bridge=trace")
    );
    assert!(log_filter(None).to_string().split(',').any(|d| d == "info"));
}
