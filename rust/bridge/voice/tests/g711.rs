use jeeta_voice_bridge::g711::{Codec, alaw_decode, alaw_encode, ulaw_decode, ulaw_encode};

#[test]
fn silence_has_its_known_code_words() {
    assert_eq!(ulaw_encode(0), 0xFF);
    assert_eq!(ulaw_decode(0xFF), 0);
    assert_eq!(alaw_encode(0), 0xD5);
    assert_eq!(alaw_decode(0xD5), 8);
}

#[test]
fn every_sample_survives_a_round_trip_within_the_step() {
    for x in (i16::MIN..=i16::MAX).step_by(7) {
        let bound = i32::from(x).unsigned_abs() as i32 / 16 + 16;
        let u = i32::from(ulaw_decode(ulaw_encode(x)));
        let a = i32::from(alaw_decode(alaw_encode(x)));
        assert!((u - i32::from(x)).abs() <= bound + 32, "ulaw {x} -> {u}");
        assert!((a - i32::from(x)).abs() <= bound + 32, "alaw {x} -> {a}");
    }
}

#[test]
fn a_frame_is_160_bytes_both_ways() {
    let pcm = vec![1000i16; 160];
    for codec in [Codec::Alaw, Codec::Ulaw] {
        let bytes = codec.encode(&pcm);
        assert_eq!(bytes.len(), 160);
        assert_eq!(codec.decode(&bytes).len(), 160);
    }
    assert_eq!(Codec::from_format("alaw"), Some(Codec::Alaw));
    assert_eq!(Codec::from_format("ulaw"), Some(Codec::Ulaw));
    assert_eq!(Codec::from_format("slin16"), None);
}
