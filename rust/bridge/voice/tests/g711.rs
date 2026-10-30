use jeeta_voice_bridge::g711::{Codec, alaw_decode, alaw_encode, ulaw_decode, ulaw_encode};

#[test]
fn silence_has_its_known_code_words() {
    assert_eq!(ulaw_encode(0), 0xFF);
    assert_eq!(ulaw_decode(0xFF), 0);
    assert_eq!(alaw_encode(0), 0xD5);
    assert_eq!(alaw_decode(0xD5), 8);
}

/// Every sample comes back within half of its step (B4 review M4): the step of a μ-law segment
/// `e` is `8 << e` in 16-bit units, of an A-law segment `s` 16 below segment 2 and `8 << s` from
/// it; μ-law clips its input at 32 635 first.
#[test]
fn every_sample_survives_a_round_trip_within_half_its_step() {
    for x in i16::MIN..=i16::MAX {
        let wide = i32::from(x);
        let u = ulaw_encode(x);
        let segment = i32::from((!u >> 4) & 0x07);
        let clipped = (wide.abs() - 32_635).max(0);
        let error = (i32::from(ulaw_decode(u)) - wide).abs();
        assert!(error <= (4 << segment) + clipped, "ulaw {x} -> {error}");
        let a = alaw_encode(x);
        let segment = i32::from(((a ^ 0x55) >> 4) & 0x07);
        let half = if segment < 2 { 8 } else { 4 << segment };
        let error = (i32::from(alaw_decode(a)) - wide).abs();
        assert!(error <= half, "alaw {x} -> {error}");
    }
}

/// The ends of the scale (ITU-T G.711's tables).
#[test]
fn the_loudest_samples_have_their_known_code_words() {
    assert_eq!(ulaw_encode(i16::MAX), 0x80);
    assert_eq!(ulaw_encode(-i16::MAX), 0x00);
    assert_eq!(ulaw_encode(i16::MIN), 0x00);
    assert_eq!(alaw_encode(i16::MAX), 0xAA);
    assert_eq!(alaw_encode(i16::MIN), 0x2A);
    assert_eq!(ulaw_decode(0x80), 32_124);
    assert_eq!(ulaw_decode(0x00), -32_124);
    assert_eq!(alaw_decode(0xAA), 32_256);
    assert_eq!(alaw_decode(0x2A), -32_256);
}

/// Every code word decodes to a sample that encodes back to it, but μ-law's negative zero
/// (`0x7F`), which decodes to 0 and so encodes as the positive one (`0xFF`).
#[test]
fn every_code_word_survives_a_round_trip() {
    for byte in 0..=u8::MAX {
        assert_eq!(alaw_encode(alaw_decode(byte)), byte, "alaw {byte:#04x}");
        let back = ulaw_encode(ulaw_decode(byte));
        if byte == 0x7F {
            assert_eq!(back, 0xFF);
        } else {
            assert_eq!(back, byte, "ulaw {byte:#04x}");
        }
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
