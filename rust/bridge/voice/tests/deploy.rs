//! The deploy files agree with the bridge and with each other (plan D3): the environment example
//! is the bridge's own defaults, on staging's loopback core; the speech services' units serve the
//! sockets it names, each in a directory of its own service; the trace file it writes is the one
//! rotated; and the bridge's unit runs the line from the release link as the bridge's user, on
//! loopback, writing only its state directory.
use std::collections::HashMap;
use std::path::Path;

use jeeta_voice_bridge::config::Config;
use jeeta_voice_bridge::speech::Endpoint;

const UNIT: &str = include_str!("../deploy/jeeta-voice-bridge.service");
const ENV: &str = include_str!("../deploy/bridge.env.example");
const LISTEN_UNIT: &str = include_str!("../deploy/jeeta-voice-listen.service");
const SPEAK_UNIT: &str = include_str!("../deploy/jeeta-voice-speak.service");
const TMPFILES: &str = include_str!("../deploy/jeeta-voice.tmpfiles");
const LOGROTATE: &str = include_str!("../deploy/jeeta-voice-bridge.logrotate");

/// The example's `NAME=value` lines (comments left out), as systemd's `EnvironmentFile` reads them.
fn example() -> HashMap<String, String> {
    ENV.lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_owned(), v.trim().to_owned()))
        .collect()
}

fn unix_path(e: &Endpoint) -> &Path {
    match e {
        Endpoint::Unix(p) => p,
        Endpoint::Tcp(_) => panic!("a unix socket was expected"),
    }
}

#[test]
fn the_environment_example_is_the_bridges_defaults_and_the_speech_units_sockets() {
    let vars = example();
    // Nothing secret is in the repository: the key is filled in on the host, ARI's password is in
    // ari.env, and the core is staging's on loopback.
    assert_eq!(vars["JEETA_BRIDGE_KEY"], "");
    assert!(!vars.contains_key("ARI_PASSWORD"));
    assert_eq!(vars["JEETA_BASE_URL"], "http://127.0.0.1:8091");
    let filled = |k: &str| match k {
        "JEETA_BRIDGE_KEY" => Some("k".to_owned()),
        "ARI_PASSWORD" => Some("p".to_owned()),
        _ => vars.get(k).cloned(),
    };
    let from_example = Config::from_env(filled, true).unwrap();
    let defaults = Config::from_env(
        |k| match k {
            "JEETA_BASE_URL" => Some("http://127.0.0.1:8091".to_owned()),
            "JEETA_BRIDGE_KEY" => Some("k".to_owned()),
            "ARI_PASSWORD" => Some("p".to_owned()),
            _ => None,
        },
        true,
    )
    .unwrap();
    assert_eq!(from_example.extension, defaults.extension);
    assert_eq!(from_example.ari_url, defaults.ari_url);
    assert_eq!(from_example.ari_user, defaults.ari_user);
    assert_eq!(from_example.listen, defaults.listen);
    assert_eq!(from_example.speak, defaults.speak);
    assert_eq!(from_example.cache_dir, defaults.cache_dir);
    assert_eq!(from_example.trace_file, defaults.trace_file);
    // The speech units serve the sockets the bridge reaches, each in its own service's directory.
    assert!(LISTEN_UNIT.contains(&format!("-e LISTEN_SOCKET={} ", vars["LISTEN_SOCKET"])));
    assert!(SPEAK_UNIT.contains(&format!("-e SPEAK_SOCKET={} ", vars["SPEAK_SOCKET"])));
    for (socket, owner) in [
        (&from_example.listen, "jeeta-voice-svc"),
        (&from_example.speak, "jeeta-voice-speak"),
    ] {
        let dir = unix_path(socket).parent().unwrap().display().to_string();
        let line = format!("d {dir} 0710 {owner} jeeta-voice -");
        assert!(TMPFILES.lines().any(|l| l == line), "{line}");
    }
    // The trace file the bridge writes is the one rotated.
    let rotated = format!("{} {{", from_example.trace_file.display());
    assert!(LOGROTATE.lines().any(|l| l == rotated), "{rotated}");
}

#[test]
fn the_unit_runs_the_line_as_the_bridge_on_loopback_writing_only_its_state() {
    for line in [
        "ExecStart=/opt/jeeta-voice/current/jeeta-voice-bridge run",
        "User=jeeta-voice-bridge",
        "Group=jeeta-voice-bridge",
        "SupplementaryGroups=jeeta-voice",
        "EnvironmentFile=/etc/jeeta-voice/ari.env",
        "EnvironmentFile=/etc/jeeta-voice/bridge.env",
        "UMask=0077",
        "NoNewPrivileges=true",
        "ProtectSystem=strict",
        "ProtectHome=true",
        "ReadWritePaths=/var/lib/jeeta-voice",
        "IPAddressDeny=any",
        "IPAddressAllow=localhost",
    ] {
        assert!(UNIT.lines().any(|l| l == line), "{line}");
    }
    // What it writes is under the one writable path: the phrase cache and the traces.
    let vars = example();
    for name in ["VOICE_CACHE_DIR", "VOICE_TRACE_FILE"] {
        assert!(vars[name].starts_with("/var/lib/jeeta-voice/"), "{name}");
    }
}
