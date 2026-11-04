//! The voice bridge's HTTP bodies read and write the same in the server and the bridge program.
use jt_calls::wire::{BridgeCommand, CommandsQuery, EventsInput, RegisterInput, RegisterOut};
use jt_calls::{BridgeEvent, CallCommandId, CallId, CallPlan, Command, PlayKind};
use serde_json::json;
use uuid::Uuid;

fn plan() -> CallPlan {
    serde_json::from_value(json!({
        "opening": "Ahmet Bey ile mi görüşüyorum?",
        "goal": "Randevuyu teyit etmek",
        "holding": ["Bir saniye."],
        "closing": "Görüşmek üzere, iyi günler.",
        "max_duration_s": 300,
    }))
    .unwrap()
}

#[test]
fn every_command_kind_round_trips_through_the_wire() {
    let commands = vec![
        Command::Answer {
            greeting_text: "Merhaba.".into(),
            then_record: false,
        },
        Command::Dial {
            to_e164: "+905321234567".into(),
            plan: plan(),
            script: Default::default(),
        },
        Command::Say {
            seq: 3,
            text: "Tamam.".into(),
            allow_barge_in: true,
        },
        Command::Play {
            seq: 4,
            clip: PlayKind::Closing,
            index: 0,
            text: "İyi günler.".into(),
        },
        Command::Record { start: false },
        Command::Transfer { to: "101".into() },
        Command::Hangup,
    ];
    for c in commands {
        let wire = BridgeCommand::of(
            CallCommandId(Uuid::nil()),
            CallId(Uuid::nil()),
            Some("c-1".into()),
            &c,
        );
        let text = serde_json::to_string(&wire).unwrap();
        let back: BridgeCommand = serde_json::from_str(&text).unwrap();
        assert_eq!(back, wire, "{text}");
        assert!(back.payload.get("kind").is_none(), "{text}");
        assert_eq!(back.command().unwrap(), c, "{text}");
    }
}

#[test]
fn events_input_reads_the_documented_batch_and_writes_it_back() {
    let batch = json!({ "events": [
        { "bridge_call_id": "c-1", "bridge_seq": 1, "at": "2026-10-28T09:00:01Z", "kind": "ringing" },
        { "bridge_call_id": "c-1", "bridge_seq": 2, "at": "2026-10-28T09:00:04Z", "kind": "command_done",
          "id": "00000000-0000-0000-0000-000000000000" },
        { "bridge_call_id": "c-1", "bridge_seq": 3, "at": "2026-10-28T09:00:06Z", "kind": "utterance",
          "text": "evet", "is_final": true, "confidence": 0.5, "stt_ms": 80 }
    ]});
    let read: EventsInput = serde_json::from_value(batch).unwrap();
    assert_eq!(read.events.len(), 3);
    assert!(matches!(
        read.events[2].event,
        BridgeEvent::Utterance { is_final: true, .. }
    ));
    let again: EventsInput = serde_json::from_value(serde_json::to_value(&read).unwrap()).unwrap();
    assert_eq!(again.events[1].bridge_seq, 2);
    assert!(matches!(
        again.events[1].event,
        BridgeEvent::CommandDone { .. }
    ));
}

#[test]
fn register_input_refuses_unknown_fields() {
    let body = json!({
        "extension": "102", "codecs": ["PCMA"], "max_calls": 1,
        "stt": { "engine": "seda", "model": "seda-v0.1" },
        "tts": { "engine": "ema", "voice": "ema-lightning-1.1.2" },
        "version": "0.1.0", "extra": 1,
    });
    assert!(serde_json::from_value::<RegisterInput>(body).is_err());
}

#[test]
fn commands_query_writes_only_what_is_set() {
    let q = CommandsQuery {
        wait_s: Some(25),
        extension: None,
    };
    assert_eq!(serde_json::to_value(&q).unwrap(), json!({ "wait_s": 25 }));
}

#[test]
fn register_out_reads_the_servers_answer() {
    let out: RegisterOut = serde_json::from_value(json!({
        "capability_id": "00000000-0000-0000-0000-000000000000",
        "status": "verified",
        "heartbeat_s": 15,
    }))
    .unwrap();
    assert_eq!(out.heartbeat_s, 15);
}
