//! The photo reel renderer on images generated here (gradients with numbers, never photos): the
//! file is an MP4 whose index comes first, holding one H.264 track at 1080 x 1920 and 30 fps of
//! the expected length; texts that do not fit are refused before anything is encoded, naming
//! their field; the time limit stops a render; reels wait in their own bounded queue.
use image::{ImageBuffer, Rgb, RgbImage};
use jt_app::ports::compose::{ComposeError, Compositor, ReelJob, ReelPhoto, SourceImage};
use jt_render::{Limits, ReelLimits, Renderer};
use jt_studio::compose::{BrandTokens, reel};
use std::io::Cursor;
use std::time::Duration;

/// A `w` x `h` image: a diagonal gradient in a hue of its own and a large block digit `n`.
fn numbered(n: u8, w: u32, h: u32) -> Vec<u8> {
    const DIGITS: [[u8; 5]; 10] = [
        [7, 5, 5, 5, 7],
        [2, 6, 2, 2, 7],
        [7, 1, 7, 4, 7],
        [7, 1, 7, 1, 7],
        [5, 5, 7, 1, 1],
        [7, 4, 7, 1, 7],
        [7, 4, 7, 5, 7],
        [7, 1, 1, 1, 1],
        [7, 5, 7, 5, 7],
        [7, 5, 7, 1, 7],
    ];
    let hue = [
        [200u8, 60, 40],
        [40, 140, 200],
        [60, 170, 90],
        [190, 150, 40],
        [140, 70, 180],
        [40, 160, 160],
        [210, 90, 130],
        [110, 110, 110],
    ][usize::from(n) % 8];
    let cell = (w / 6).min(h / 8);
    let (ox, oy) = ((w - cell * 3) / 2, (h - cell * 5) / 2);
    let img: RgbImage = ImageBuffer::from_fn(w, h, |x, y| {
        let t = (x + y) as f32 / (w + h) as f32;
        let mut px = [0u8; 3];
        for (k, c) in px.iter_mut().enumerate() {
            *c = (f32::from(hue[k]) * (0.45 + 0.55 * t)) as u8;
        }
        if x >= ox && y >= oy && x < ox + cell * 3 && y < oy + cell * 5 {
            let (cx, cy) = ((x - ox) / cell, (y - oy) / cell);
            if DIGITS[usize::from(n % 10)][cy as usize] & (4 >> cx) != 0 {
                px = [245, 245, 240];
            }
        }
        // A fine grid, so the motion shows.
        if x % 120 < 3 || y % 120 < 3 {
            px = [20, 20, 20];
        }
        Rgb(px)
    });
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageFormat::Jpeg)
        .expect("encode test image");
    out.into_inner()
}

fn job(photos: usize) -> ReelJob {
    ReelJob {
        photos: (0..photos)
            .map(|i| ReelPhoto {
                image: SourceImage {
                    bytes: numbered(i as u8 + 1, 1600, 1200),
                    mime: "image/jpeg".into(),
                    focus: (0.5, 0.5),
                },
                caption: Some(format!("Adım {}: tezgâhta özenle hazırlanıyor", i + 1)),
            })
            .collect(),
        photo_ms: reel::DEFAULT_PHOTO_MS,
        title: Some("Atölyeden bir gün: baştan sona".into()),
        closing_heading: Some("Siparişler açık".into()),
        closing_site: Some("ornek.com.tr".into()),
        closing_slogan: Some("Elde yapılır, özenle gönderilir.".into()),
        logo: None,
        brand: BrandTokens {
            brand_name: "Örnek Atölye".into(),
            ..BrandTokens::default()
        },
    }
}

fn be32(b: &[u8], at: usize) -> u32 {
    u32::from_be_bytes(b[at..at + 4].try_into().unwrap())
}

/// The top-level boxes' types in order.
fn top(file: &[u8]) -> Vec<[u8; 4]> {
    let mut out = Vec::new();
    let mut at = 0;
    while at + 8 <= file.len() {
        out.push(file[at + 4..at + 8].try_into().unwrap());
        at += be32(file, at) as usize;
    }
    assert_eq!(at, file.len());
    out
}

#[test]
fn a_reel_is_a_fast_start_h264_mp4_of_its_length() {
    let renderer = Renderer::new(Limits::default());
    let out = renderer.render_reel_blocking(job(3)).expect("reel");
    assert_eq!(out.mime, "video/mp4");
    assert_eq!((out.width, out.height, out.fps), (1080, 1920, 30));
    let parts = reel::parts(3, reel::DEFAULT_PHOTO_MS, true, true);
    assert_eq!(out.frames, reel::total_frames(&parts));
    assert_eq!(out.duration_ms, reel::duration_ms(out.frames));
    assert_eq!(top(&out.bytes), [*b"ftyp", *b"moov", *b"mdat"]);
    // The SPS in avcC: Constrained Baseline (66, constraint_set1) at level 4.0.
    let at = out.bytes.windows(4).position(|w| w == b"avcC").unwrap() + 4;
    assert_eq!(out.bytes[at], 1);
    assert_eq!(out.bytes[at + 1], 66);
    assert_eq!(out.bytes[at + 3], 40);
    // mvhd's duration (ms) is the reel's.
    let mvhd = out.bytes.windows(4).position(|w| w == b"mvhd").unwrap() + 4;
    assert_eq!(u64::from(be32(&out.bytes, mvhd + 16)), out.duration_ms);
    // An IDR picture every two seconds.
    let stss = out.bytes.windows(4).position(|w| w == b"stss").unwrap() + 4;
    let syncs = be32(&out.bytes, stss + 4);
    assert_eq!(syncs, out.frames.div_ceil(60));
}

#[test]
fn a_text_that_does_not_fit_is_refused_naming_its_field() {
    let renderer = Renderer::new(Limits::default());
    let mut j = job(3);
    // Short enough for max_chars, too wide for three lines at the caption's size.
    j.photos[1].caption = Some("WWWW WWWW WWWW WWWW WWWW WWWW WWWW WWWW WWWW WWWW WWWW".into());
    match renderer.render_reel_blocking(j) {
        Err(ComposeError::Overflow { slot, .. }) => assert_eq!(slot, "photos.1.text"),
        Err(e) => panic!("{e:?}"),
        Ok(_) => panic!("rendered"),
    }
    let mut j = job(3);
    j.closing_site = Some("WWWWWWWWWWWWWWWWWWWWWWWWWWW".into());
    match renderer.render_reel_blocking(j) {
        Err(ComposeError::Overflow {
            slot,
            word_too_wide,
            ..
        }) => {
            assert_eq!(slot, "closing.site");
            assert!(word_too_wide.is_some());
        }
        Err(e) => panic!("{e:?}"),
        Ok(_) => panic!("rendered"),
    }
}

#[test]
fn the_time_limit_stops_a_render() {
    let renderer = Renderer::new(Limits {
        reel: ReelLimits {
            time_limit: Duration::from_millis(1),
            ..ReelLimits::default()
        },
        ..Limits::default()
    });
    assert!(matches!(
        renderer.render_reel_blocking(job(3)),
        Err(ComposeError::TimedOut)
    ));
}

#[test]
fn an_unreadable_photo_is_refused_naming_it() {
    let renderer = Renderer::new(Limits::default());
    let mut j = job(3);
    j.photos[2].image.bytes = b"not an image".to_vec();
    match renderer.render_reel_blocking(j) {
        Err(ComposeError::Image { slot, .. }) => assert_eq!(slot, "photos.2.material_id"),
        Err(e) => panic!("{e:?}"),
        Ok(_) => panic!("rendered"),
    }
}

#[tokio::test]
async fn reels_wait_in_their_own_bounded_queue() {
    let renderer = Renderer::new(Limits {
        reel: ReelLimits {
            max_waiting: 1,
            queue_wait: Duration::from_millis(50),
            ..ReelLimits::default()
        },
        ..Limits::default()
    });
    let first = renderer.reserve_reel().await.expect("turn");
    // The one waiting place times out without a turn; an image render is not held up.
    assert!(matches!(
        renderer.reserve_reel().await,
        Err(ComposeError::Busy)
    ));
    let image = renderer.reserve().await.expect("an image's turn");
    drop((first, image));
    assert!(renderer.reserve_reel().await.is_ok());
}

/// Writes a sample reel of eight generated photos to `JT_REEL_SAMPLE` (a path), and prints how
/// long it took. `cargo test -p jt_render --release --test reel -- --ignored sample`.
#[test]
#[ignore = "writes a sample file; run by hand"]
fn sample() {
    let Ok(path) = std::env::var("JT_REEL_SAMPLE") else {
        return;
    };
    let _ = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::DEBUG)
        .try_init();
    let renderer = Renderer::new(Limits::default());
    let started = std::time::Instant::now();
    let mut j = job(8);
    // `JT_REEL_SAMPLE_MS`: each photo's length (the longest reel is 8 photos at 4000 ms).
    if let Some(ms) = std::env::var("JT_REEL_SAMPLE_MS")
        .ok()
        .and_then(|v| v.parse().ok())
    {
        j.photo_ms = ms;
    }
    let out = renderer.render_reel_blocking(j).expect("reel");
    let elapsed = started.elapsed();
    std::fs::write(&path, &out.bytes).expect("write sample");
    println!(
        "reel: {} frames, {} ms, {} bytes, rendered in {:.1} s",
        out.frames,
        out.duration_ms,
        out.bytes.len(),
        elapsed.as_secs_f32()
    );
}
