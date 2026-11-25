//! H.264 encoding of the reel's frames with OpenH264 (Cisco's encoder, BSD-2-Clause, compiled
//! from its source into the binary by `openh264-sys2`; no Cisco-provided binary is downloaded or
//! loaded). Each frame is converted to 4:2:0 BT.709 limited-range YUV, encoded at once, and only
//! its encoded samples are kept: no frame is held after it is encoded.
//!
//! The stream is Constrained Baseline at level 4.0 (1080 x 1920 at 30 fps fits it), with an IDR
//! picture every two seconds and no other intra refresh, so every group of pictures is closed;
//! the SPS carries BT.709 colour and a limited range in its VUI.
use crate::mp4::Track;
use jt_app::ports::compose::ComposeError;
use openh264::OpenH264API;
use openh264::encoder::{
    BitRate, Complexity, Encoder, EncoderConfig, FrameRate, FrameType, IntraFramePeriod, Level,
    Profile, RateControlMode, UsageType, VuiConfig,
};
use openh264::formats::YUVSlices;

/// Media time units per second (512 per frame at 30 fps).
const TIMESCALE: u32 = 15_360;

/// How the encoder runs.
#[derive(Clone, Copy, Debug)]
pub struct EncodeLimits {
    /// The encoder's own threads. Each frame is one slice, which one thread encodes, so one is
    /// enough; the frames are drawn and converted on other threads meanwhile.
    pub threads: u16,
    /// The threads that draw each frame (in horizontal bands) while the encoder encodes the one
    /// before.
    pub draw_threads: usize,
    /// The target bit rate.
    pub bitrate: u32,
    /// The largest encoded stream kept, in bytes; past it the reel is refused.
    pub max_bytes: usize,
}

impl Default for EncodeLimits {
    fn default() -> Self {
        Self {
            threads: 1,
            draw_threads: 2,
            bitrate: 6_000_000,
            max_bytes: 80_000_000,
        }
    }
}

fn failed(what: &str, e: impl std::fmt::Display) -> ComposeError {
    ComposeError::Internal(format!("{what}: {e}"))
}

pub(crate) struct H264 {
    encoder: Encoder,
    width: usize,
    height: usize,
    fps: u32,
    gop: u32,
    sps: Option<Vec<u8>>,
    pps: Option<Vec<u8>>,
    media: Vec<u8>,
    sizes: Vec<u32>,
    sync: Vec<u32>,
    max_bytes: usize,
}

/// The NAL units of an Annex B stream, start codes removed.
fn nal_units(stream: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut starts = Vec::new();
    let mut i = 0;
    while i + 3 <= stream.len() {
        if stream[i] == 0 && stream[i + 1] == 0 && stream[i + 2] == 1 {
            starts.push(i + 3);
            i += 3;
        } else {
            i += 1;
        }
    }
    let ends: Vec<usize> = starts
        .iter()
        .skip(1)
        .map(|s| {
            // The next start code, less a leading zero of a four-byte one.
            let mut e = s - 3;
            while e > 0 && stream[e - 1] == 0 {
                e -= 1;
            }
            e
        })
        .chain(std::iter::once(stream.len()))
        .collect();
    starts
        .into_iter()
        .zip(ends)
        .filter(|(s, e)| e > s)
        .map(move |(s, e)| &stream[s..e])
}

impl H264 {
    pub fn new(
        width: u32,
        height: u32,
        fps: u32,
        limits: &EncodeLimits,
    ) -> Result<Self, ComposeError> {
        let gop = fps * 2;
        let config = EncoderConfig::new()
            .usage_type(UsageType::CameraVideoRealTime)
            .profile(Profile::Baseline)
            .level(Level::Level_4_0)
            .rate_control_mode(RateControlMode::Bitrate)
            .bitrate(BitRate::from_bps(limits.bitrate))
            .max_frame_rate(FrameRate::from_hz(fps as f32))
            .skip_frames(false)
            .complexity(Complexity::Medium)
            .intra_frame_period(IntraFramePeriod::from_num_frames(gop))
            .scene_change_detect(false)
            .long_term_reference(false)
            .num_threads(limits.threads.max(1))
            .vui(VuiConfig::bt709())
            .debug(false);
        let encoder = Encoder::with_api_config(OpenH264API::from_source(), config)
            .map_err(|e| failed("cannot start the H.264 encoder", e))?;
        let (w, h) = (width as usize, height as usize);
        Ok(Self {
            encoder,
            width: w,
            height: h,
            fps,
            gop,
            sps: None,
            pps: None,
            media: Vec::new(),
            sizes: Vec::new(),
            sync: Vec::new(),
            max_bytes: limits.max_bytes,
        })
    }

    /// Encodes one frame given as I420: `width * height` luma bytes, then a quarter of that for
    /// U, then for V.
    pub fn push(&mut self, yuv: &[u8]) -> Result<(), ComposeError> {
        let n = self.sizes.len() as u32;
        let (w, h) = (self.width, self.height);
        if yuv.len() != w * h * 3 / 2 {
            return Err(ComposeError::Internal("a frame of the wrong size".into()));
        }
        if n.is_multiple_of(self.gop) {
            self.encoder.force_intra_frame();
        }
        let (y, chroma) = yuv.split_at(w * h);
        let (u, v) = chroma.split_at(w * h / 4);
        let yuv = YUVSlices::new((y, u, v), (w, h), (w, w / 2, w / 2));
        let ms = u64::from(n) * 1000 / u64::from(self.fps);
        let out = self
            .encoder
            .encode_at(&yuv, openh264::Timestamp::from_millis(ms))
            .map_err(|e| failed("the H.264 encoder failed", e))?;
        let idr = out.frame_type() == FrameType::IDR;
        let stream = out.to_vec();
        let mut size = 0u32;
        for nal in nal_units(&stream) {
            match nal[0] & 0x1f {
                7 => {
                    self.sps.get_or_insert_with(|| nal.to_vec());
                }
                8 => {
                    self.pps.get_or_insert_with(|| nal.to_vec());
                }
                // Access unit delimiters and SEI are left out of the samples.
                6 | 9 => {}
                _ => {
                    self.media
                        .extend_from_slice(&(nal.len() as u32).to_be_bytes());
                    self.media.extend_from_slice(nal);
                    size += 4 + nal.len() as u32;
                }
            }
        }
        if size == 0 {
            return Err(ComposeError::Internal(
                "the H.264 encoder gave no picture for a frame".into(),
            ));
        }
        if n == 0 && !idr {
            return Err(ComposeError::Internal(
                "the H.264 stream does not open with an IDR picture".into(),
            ));
        }
        if idr {
            self.sync.push(n + 1);
        }
        self.sizes.push(size);
        if self.media.len() > self.max_bytes {
            return Err(ComposeError::Internal(format!(
                "the encoded reel would exceed {} bytes",
                self.max_bytes
            )));
        }
        Ok(())
    }

    /// The MP4 file of the frames pushed, and their count.
    pub fn finish(self) -> Result<(Vec<u8>, u32), ComposeError> {
        let (Some(sps), Some(pps)) = (self.sps, self.pps) else {
            return Err(ComposeError::Internal(
                "the H.264 stream has no parameter sets".into(),
            ));
        };
        let frames = self.sizes.len() as u32;
        let track = Track {
            width: self.width as u32,
            height: self.height as u32,
            timescale: TIMESCALE,
            sample_delta: TIMESCALE / self.fps,
            sps,
            pps,
            sizes: self.sizes,
            sync: self.sync,
            chunk_samples: self.fps,
        };
        Ok((crate::mp4::write(&track, self.media), frames))
    }
}

/// BT.709 limited-range coefficients, scaled by 2^16.
const KY: [i32; 3] = [11_966, 40_254, 4_064];
const KU: [i32; 3] = [-6_596, -22_189, 28_784];
const KV: [i32; 3] = [28_784, -26_145, -2_639];

/// Converts opaque RGBA rows (an even number of them, `width` pixels each) to I420: luma per
/// pixel, chroma from each 2 x 2 block's mean.
pub(crate) fn rgba_to_i420(rgba: &[u8], width: usize, y: &mut [u8], u: &mut [u8], v: &mut [u8]) {
    let luma = |p: &[u8]| -> (u8, i32, i32, i32) {
        let (r, g, b) = (i32::from(p[0]), i32::from(p[1]), i32::from(p[2]));
        let l = ((KY[0] * r + KY[1] * g + KY[2] * b + (1 << 15)) >> 16) + 16;
        (l.clamp(16, 235) as u8, r, g, b)
    };
    let pairs = rgba
        .chunks_exact(width * 8)
        .zip(y.chunks_exact_mut(width * 2))
        .zip(u.chunks_exact_mut(width / 2))
        .zip(v.chunks_exact_mut(width / 2));
    for (((pair, ly), ur), vr) in pairs {
        let (top, bottom) = pair.split_at(width * 4);
        let (lt, lb) = ly.split_at_mut(width);
        let quads = top
            .chunks_exact(8)
            .zip(bottom.chunks_exact(8))
            .zip(lt.chunks_exact_mut(2))
            .zip(lb.chunks_exact_mut(2))
            .zip(ur.iter_mut().zip(vr.iter_mut()));
        for ((((t, b), yt), yb), (cu, cv)) in quads {
            let (y0, r0, g0, b0) = luma(&t[..4]);
            let (y1, r1, g1, b1) = luma(&t[4..]);
            let (y2, r2, g2, b2) = luma(&b[..4]);
            let (y3, r3, g3, b3) = luma(&b[4..]);
            yt.copy_from_slice(&[y0, y1]);
            yb.copy_from_slice(&[y2, y3]);
            let (sr, sg, sb) = (r0 + r1 + r2 + r3, g0 + g1 + g2 + g3, b0 + b1 + b2 + b3);
            let cb = (KU[0] * sr + KU[1] * sg + KU[2] * sb + (1 << 17)) >> 18;
            let cr = (KV[0] * sr + KV[1] * sg + KV[2] * sb + (1 << 17)) >> 18;
            *cu = (cb + 128).clamp(16, 240) as u8;
            *cv = (cr + 128).clamp(16, 240) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn colours_convert_to_limited_range_bt709() {
        let mut px = Vec::new();
        for c in [
            [255u8, 255, 255, 255],
            [0, 0, 0, 255],
            [255, 0, 0, 255],
            [0, 0, 255, 255],
        ] {
            px.clear();
            for _ in 0..4 {
                px.extend_from_slice(&c);
            }
            let (mut y, mut u, mut v) = (vec![0; 4], vec![0; 1], vec![0; 1]);
            rgba_to_i420(&px, 2, &mut y, &mut u, &mut v);
            match c {
                [255, 255, 255, _] => assert_eq!((y[0], u[0], v[0]), (235, 128, 128)),
                [0, 0, 0, _] => assert_eq!((y[0], u[0], v[0]), (16, 128, 128)),
                // BT.709 red: Y 63, Cb 102, Cr 240.
                [255, 0, 0, _] => assert_eq!((y[0], u[0], v[0]), (63, 102, 240)),
                // BT.709 blue: Y 32, Cb 240, Cr 118.
                _ => assert_eq!((y[0], u[0], v[0]), (32, 240, 118)),
            }
        }
    }

    #[test]
    fn start_codes_split_the_stream() {
        let s = [
            0, 0, 0, 1, 0x67, 1, 2, 0, 0, 1, 0x68, 3, 0, 0, 0, 1, 0x65, 9, 9,
        ];
        let units: Vec<&[u8]> = nal_units(&s).collect();
        assert_eq!(units, [&[0x67, 1, 2][..], &[0x68, 3], &[0x65, 9, 9]]);
    }
}
