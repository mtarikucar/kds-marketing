//! The renderer on images generated here (gradients and solid colours, never photos): every role
//! and variant renders at its frame's size, texts that do not fit are refused, sources are
//! bounded, and the work runs off the async runtime.
use image::{ImageBuffer, Rgb, RgbImage};
use jt_app::ports::compose::{ComposeError, ComposeJob, Compositor, OutputFormat, SourceImage};
use jt_render::{DecodeLimits, Limits, Renderer};
use jt_studio::compose::{BrandTokens, SlotKind, Template, templates};
use std::collections::BTreeMap;
use std::io::Cursor;

/// A `w` x `h` gradient image encoded as `format`.
fn gradient(w: u32, h: u32, format: image::ImageFormat) -> Vec<u8> {
    let img: RgbImage = ImageBuffer::from_fn(w, h, |x, y| {
        Rgb([
            (x * 255 / w.max(1)) as u8,
            (y * 255 / h.max(1)) as u8,
            ((x + y) % 256) as u8,
        ])
    });
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, format).expect("encode test image");
    out.into_inner()
}

fn source(w: u32, h: u32) -> SourceImage {
    SourceImage {
        bytes: gradient(w, h, image::ImageFormat::Png),
        mime: "image/png".into(),
        focus: (0.5, 0.5),
    }
}

/// A text for `key` that fits any slot it may be in.
fn sample(kind: SlotKind, key: &str) -> String {
    match (kind, key) {
        (SlotKind::Price, _) => "₺1.490".into(),
        (_, "label") => "Öne çıkan".into(),
        (_, k) if k.starts_with("name") => "Işık Ağacı".into(),
        (_, k) if k.starts_with("step") => "Kapağı aç.".into(),
        (_, "heading") => "Güneşli öğle, ılık çay İçeride".into(),
        (_, "site") => "ornek.com.tr".into(),
        (_, "slogan") => "Görüşmek üzere.".into(),
        _ => "Özenle hazırlandı, şimdi sırada.".into(),
    }
}

fn job(t: &Template) -> ComposeJob {
    let mut texts = BTreeMap::new();
    let mut photos = BTreeMap::new();
    for s in &t.slots {
        match s.kind {
            SlotKind::Photo => {
                photos.insert(s.key.to_owned(), source(640, 480));
            }
            kind => {
                texts.insert(s.key.to_owned(), sample(kind, s.key));
            }
        }
    }
    ComposeJob {
        template: t.clone(),
        texts,
        photos,
        logo: None,
        brand: BrandTokens {
            brand_name: "Örnek Dükkân".into(),
            ..BrandTokens::default()
        },
        counter: (t.frame == jt_studio::compose::Frame::Slide).then_some((2, 7)),
        output: OutputFormat::Png,
    }
}

#[test]
fn every_role_and_variant_renders_at_its_size() {
    let renderer = Renderer::new(Limits::default());
    for t in templates() {
        let out = renderer
            .compose_blocking(&job(&t))
            .unwrap_or_else(|e| panic!("{:?} {}: {e:?}", t.role, t.variant));
        let img = image::load_from_memory(&out.bytes).expect("decodes");
        assert_eq!(
            (img.width(), img.height()),
            t.frame.size(),
            "{:?} {}",
            t.role,
            t.variant
        );
        assert_eq!((out.width, out.height), t.frame.size());
        let sticker = matches!(t.role.key(), "question" | "item");
        assert_eq!(out.sticker_area.is_some(), sticker, "{:?}", t.role);
        if let Some(area) = out.sticker_area {
            assert!(
                area.y >= 250 && area.y + area.height <= 1920 - 250,
                "{area:?}"
            );
        }
    }
}

#[test]
fn jpeg_output_is_jpeg() {
    let renderer = Renderer::new(Limits::default());
    let t = jt_studio::compose::template(jt_studio::compose::Role::Moment, "text_bottom").unwrap();
    let mut j = job(&t);
    j.output = OutputFormat::Jpeg;
    let out = renderer.compose_blocking(&j).unwrap();
    assert_eq!(out.mime, "image/jpeg");
    assert!(out.bytes.starts_with(&[0xff, 0xd8, 0xff]));
    assert!(
        out.bytes.len() < 8_000_000,
        "a story image stays under Instagram's 8 MB"
    );
}

#[test]
fn a_heading_that_does_not_fit_is_refused_naming_its_slot() {
    let renderer = Renderer::new(Limits::default());
    let t = jt_studio::compose::template(jt_studio::compose::Role::Cover, "full_bottom").unwrap();
    let mut j = job(&t);
    // Within max_chars, but wide letters need more lines than the slot has.
    j.texts.insert(
        "heading".into(),
        "MMMMMM WWWWWW MMMMMM WWWWWW MMMMMM WWW".into(),
    );
    match renderer.compose_blocking(&j) {
        Err(ComposeError::Overflow {
            slot,
            max_lines,
            lines_needed,
            word_too_wide,
            ..
        }) => {
            assert_eq!(slot, "heading");
            assert_eq!(max_lines, 3);
            assert!(lines_needed.unwrap() > 3);
            assert_eq!(word_too_wide, None);
        }
        other => panic!("expected an overflow, got {:?}", other.map(|_| ())),
    }
    // A single word wider than the slot is never broken or shrunk: it is named.
    j.texts
        .insert("heading".into(), "Bir Çokuzunbirkelimeburadasığmaz".into());
    match renderer.compose_blocking(&j) {
        Err(ComposeError::Overflow {
            slot,
            lines_needed,
            word_too_wide,
            ..
        }) => {
            assert_eq!(slot, "heading");
            assert_eq!(lines_needed, None);
            assert_eq!(
                word_too_wide.as_deref(),
                Some("Çokuzunbirkelimeburadasığmaz")
            );
        }
        other => panic!("expected a word too wide, got {:?}", other.map(|_| ())),
    }
}

#[test]
fn the_body_font_draws_the_lira_sign_through_fallback() {
    let renderer = Renderer::new(Limits::default());
    let t = jt_studio::compose::template(jt_studio::compose::Role::Cover, "full_bottom").unwrap();
    let mut j = job(&t);
    // Figtree, the body font here, has no ₺: it is drawn from the other family.
    j.texts
        .insert("line".into(), "Şimdi ₺1.490 İstanbul'da".into());
    renderer.compose_blocking(&j).expect("₺ in a body slot");
    j.texts.insert("line".into(), "日本".into());
    assert!(matches!(
        renderer.compose_blocking(&j),
        Err(ComposeError::UnsupportedCharacter { .. })
    ));
}

#[test]
fn a_missing_required_slot_is_refused() {
    let renderer = Renderer::new(Limits::default());
    let t = jt_studio::compose::template(jt_studio::compose::Role::Cta, "photos_top").unwrap();
    let mut j = job(&t);
    j.photos.remove("photo_2");
    assert!(matches!(
        renderer.compose_blocking(&j),
        Err(ComposeError::MissingSlot { slot }) if slot == "photo_2"
    ));
}

#[test]
fn sources_are_bounded_and_typed() {
    let renderer = Renderer::new(Limits {
        decode: DecodeLimits {
            max_side: 1_000,
            max_pixels: 500_000,
            max_alloc: 64 * 1024 * 1024,
        },
        ..Limits::default()
    });
    let t = jt_studio::compose::template(jt_studio::compose::Role::Moment, "text_top").unwrap();
    let mut j = job(&t);
    j.photos.insert("photo".into(), source(1_200, 300));
    assert!(matches!(
        renderer.compose_blocking(&j),
        Err(ComposeError::Image { .. })
    ));
    j.photos.insert(
        "photo".into(),
        SourceImage {
            bytes: b"GIF89a....".to_vec(),
            mime: "image/gif".into(),
            focus: (0.5, 0.5),
        },
    );
    assert!(matches!(
        renderer.compose_blocking(&j),
        Err(ComposeError::Image { .. })
    ));
    j.photos.insert(
        "photo".into(),
        SourceImage {
            bytes: gradient(300, 200, image::ImageFormat::WebP),
            mime: "image/webp".into(),
            focus: (0.2, 0.8),
        },
    );
    renderer.compose_blocking(&j).expect("a WebP source");
}

#[tokio::test]
async fn renders_take_a_turn_and_the_queue_is_bounded() {
    let renderer = std::sync::Arc::new(Renderer::new(Limits {
        concurrency: 1,
        max_waiting: 1,
        ..Limits::default()
    }));
    let t = jt_studio::compose::template(jt_studio::compose::Role::Steps, "photo_bottom").unwrap();
    // The one turn is taken: one more render may wait, the next is refused at once.
    let held = renderer.reserve().await.unwrap();
    let waiter = {
        let r = renderer.clone();
        let j = job(&t);
        tokio::spawn(async move {
            let ticket = r.reserve().await?;
            r.compose(ticket, j).await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(matches!(renderer.reserve().await, Err(ComposeError::Busy)));
    assert!(renderer.compose(held, job(&t)).await.is_ok());
    assert!(waiter.await.unwrap().is_ok());
    // Both turns are back: a new render goes through.
    let ticket = renderer.reserve().await.unwrap();
    renderer.compose(ticket, job(&t)).await.unwrap();
}

#[test]
fn the_label_and_the_brand_chip_never_meet_on_an_item_story() {
    let renderer = Renderer::new(Limits::default());
    let t = jt_studio::compose::template(jt_studio::compose::Role::Item, "card_bottom").unwrap();
    let mut j = job(&t);
    j.brand.brand_name = "Mağaza Mağaza Mağaza Mağaza MMMM".into();
    j.texts
        .insert("label".into(), "MMMMMMMMMMMMMMMMMMMMMM".into());
    assert!(matches!(
        renderer.compose_blocking(&j),
        Err(ComposeError::Collision { slot, .. }) if slot == "label"
    ));
    j.texts.insert("label".into(), "YENİ".into());
    renderer
        .compose_blocking(&j)
        .expect("a short label fits beside the chip");
}

#[test]
fn a_brand_name_no_font_draws_is_named() {
    let renderer = Renderer::new(Limits::default());
    assert_eq!(renderer.uncovered("Örnek İş ₺"), Vec::<char>::new());
    assert_eq!(renderer.uncovered("Örnek 日本日"), vec!['日', '本']);
    let t = jt_studio::compose::template(jt_studio::compose::Role::Steps, "photo_top").unwrap();
    let mut j = job(&t);
    j.brand.brand_name = "日本".into();
    assert!(matches!(
        renderer.compose_blocking(&j),
        Err(ComposeError::UnsupportedCharacter { slot, .. }) if slot == "brand_name"
    ));
}

#[test]
fn a_source_over_the_decoded_size_limit_is_refused_before_decoding() {
    let renderer = Renderer::new(Limits {
        decode: DecodeLimits {
            max_side: 8_000,
            max_pixels: 24_000_000,
            // 300 x 200 RGB takes 180 000 bytes decoded.
            max_alloc: 100_000,
        },
        ..Limits::default()
    });
    let t = jt_studio::compose::template(jt_studio::compose::Role::Moment, "text_top").unwrap();
    let mut j = job(&t);
    j.photos.insert("photo".into(), source(300, 200));
    assert!(matches!(
        renderer.compose_blocking(&j),
        Err(ComposeError::Image { .. })
    ));
}
