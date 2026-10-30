//! G.711 A-law and μ-law (ITU-T G.711), the line's codecs: one byte per 8 kHz sample, 160 bytes a
//! 20 ms frame. Asterisk's `MEDIA_START` names which one the call uses.

/// The codec of a call's media.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Codec {
    Alaw,
    Ulaw,
}

impl Codec {
    /// The codec of an Asterisk format name (`alaw`, `ulaw`).
    pub fn from_format(format: &str) -> Option<Codec> {
        match format {
            "alaw" => Some(Codec::Alaw),
            "ulaw" => Some(Codec::Ulaw),
            _ => None,
        }
    }

    /// One byte per sample of `pcm` (16-bit linear).
    pub fn encode(self, pcm: &[i16]) -> Vec<u8> {
        match self {
            Codec::Alaw => pcm.iter().map(|s| alaw_encode(*s)).collect(),
            Codec::Ulaw => pcm.iter().map(|s| ulaw_encode(*s)).collect(),
        }
    }

    /// One 16-bit linear sample per byte of `bytes`.
    pub fn decode(self, bytes: &[u8]) -> Vec<i16> {
        match self {
            Codec::Alaw => bytes.iter().map(|b| alaw_decode(*b)).collect(),
            Codec::Ulaw => bytes.iter().map(|b| ulaw_decode(*b)).collect(),
        }
    }
}

const ULAW_BIAS: i32 = 0x84;
const ULAW_CLIP: i32 = 32_635;

/// The μ-law code word of a 16-bit sample (silence is `0xFF`).
pub fn ulaw_encode(sample: i16) -> u8 {
    let mut pcm = i32::from(sample);
    let sign = if pcm < 0 {
        pcm = -pcm;
        0x80
    } else {
        0
    };
    pcm = pcm.min(ULAW_CLIP) + ULAW_BIAS;
    let mut exponent = 7;
    let mut mask = 0x4000;
    while exponent > 0 && pcm & mask == 0 {
        exponent -= 1;
        mask >>= 1;
    }
    let mantissa = (pcm >> (exponent + 3)) & 0x0F;
    !((sign | (exponent << 4) | mantissa) as u8)
}

/// The 16-bit sample of a μ-law code word: the middle of its step.
pub fn ulaw_decode(byte: u8) -> i16 {
    let u = !byte;
    let exponent = i32::from((u >> 4) & 0x07);
    let mantissa = i32::from(u & 0x0F);
    let magnitude = (((mantissa << 3) + ULAW_BIAS) << exponent) - ULAW_BIAS;
    (if u & 0x80 != 0 { -magnitude } else { magnitude }) as i16
}

/// The last 13-bit magnitude of each of A-law's eight segments.
const ALAW_SEGMENT_END: [i32; 8] = [0x1F, 0x3F, 0x7F, 0xFF, 0x1FF, 0x3FF, 0x7FF, 0xFFF];

/// The A-law code word of a 16-bit sample (silence is `0xD5`).
pub fn alaw_encode(sample: i16) -> u8 {
    let mut pcm = i32::from(sample) >> 3;
    let mask = if pcm >= 0 {
        0xD5
    } else {
        pcm = -pcm - 1;
        0x55
    };
    let segment = ALAW_SEGMENT_END
        .iter()
        .position(|end| pcm <= *end)
        .unwrap_or(8) as i32;
    if segment >= 8 {
        return (0x7F ^ mask) as u8;
    }
    let mut value = segment << 4;
    value |= if segment < 2 {
        (pcm >> 1) & 0x0F
    } else {
        (pcm >> segment) & 0x0F
    };
    (value ^ mask) as u8
}

/// The 16-bit sample of an A-law code word: the middle of its step.
pub fn alaw_decode(byte: u8) -> i16 {
    let a = i32::from(byte ^ 0x55);
    let mut t = (a & 0x0F) << 4;
    let segment = (a & 0x70) >> 4;
    match segment {
        0 => t += 8,
        1 => t += 0x108,
        _ => {
            t += 0x108;
            t <<= segment - 1;
        }
    }
    (if a & 0x80 != 0 { t } else { -t }) as i16
}
