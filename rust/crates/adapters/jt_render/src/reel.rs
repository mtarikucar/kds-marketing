//! The photo reel: a vertical video drawn frame by frame and handed to the encoder one frame at
//! a time (`h264`, `mp4`). An optional title card, then each photo (slowly zooming and drifting,
//! its caption and the brand chip over it), then an optional closing card; consecutive parts
//! crossfade.
//!
//! Memory stays bounded whatever the photos: every text is measured before anything is decoded
//! (a text that does not fit is refused before any work), a photo is decoded only when its part
//! begins and is reduced at once to a working copy a little larger than the frame (its encoded
//! bytes and its decoded pixels are dropped there), and at most two parts are held at a time
//! (during a crossfade). Frames are never kept: each is converted and encoded as it is drawn.
use crate::fonts::FontSet;
use crate::h264::{EncodeLimits, H264};
use crate::layout::{Canvas, Ground};
use crate::raster::{self, Fit, Limits as DecodeLimits};
use crate::text::{self, Align};
use jt_app::ports::compose::{ComposeError, ComposeJob, OutputFormat, ReelJob, RenderedReel};
use jt_studio::compose::{BrandTokens, Color, FontRole, Role, Template, reel, template};
use std::collections::BTreeMap;
use std::time::Instant;
use tiny_skia::Pixmap;

const W: u32 = 1080;
const H: u32 = 1920;
/// How much larger than the frame a photo's working copy is: the room its motion moves in.
const ZOOM: f32 = 0.12;
const X: f32 = 72.0;

/// The names a refused text is reported under.
pub(crate) fn caption_field(i: usize) -> String {
    format!("photos.{i}.text")
}

fn rename(e: ComposeError, field: &str) -> ComposeError {
    match e {
        ComposeError::Overflow {
            max_chars,
            max_lines,
            lines_needed,
            word_too_wide,
            ..
        } => ComposeError::Overflow {
            slot: field.to_owned(),
            max_chars,
            max_lines,
            lines_needed,
            word_too_wide,
        },
        ComposeError::UnsupportedCharacter { character, .. } => {
            ComposeError::UnsupportedCharacter {
                slot: field.to_owned(),
                character,
            }
        }
        other => other,
    }
}

fn reel_template() -> Result<Template, ComposeError> {
    template(Role::Reel, reel::VARIANT)
        .ok_or_else(|| ComposeError::Internal("the reel template is missing".into()))
}

/// A one-card compose job: the reel's template with `texts`, the brand, no photo and no logo
/// (the logo is lent to each card's canvas, never copied).
fn card_job(t: &Template, brand: &BrandTokens, texts: &[(&str, &str)]) -> ComposeJob {
    ComposeJob {
        template: t.clone(),
        texts: texts
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect::<BTreeMap<_, _>>(),
        photos: BTreeMap::new(),
        logo: None,
        brand: brand.clone(),
        counter: None,
        output: OutputFormat::Png,
    }
}

/// Every text of the reel, with the slot it is set in and the field it is reported under.
fn texts(job: &ReelJob) -> Vec<(&'static str, String, &str)> {
    let mut out = Vec::new();
    if let Some(t) = &job.title {
        out.push((reel::TITLE, "title_text".to_owned(), t.as_str()));
    }
    for (i, p) in job.photos.iter().enumerate() {
        if let Some(c) = &p.caption {
            out.push((reel::CAPTION, caption_field(i), c.as_str()));
        }
    }
    for (slot, field, text) in [
        (reel::HEADING, "closing.heading", &job.closing_heading),
        (reel::SITE, "closing.site", &job.closing_site),
        (reel::SLOGAN, "closing.slogan", &job.closing_slogan),
    ] {
        if let Some(t) = text {
            out.push((slot, field.to_owned(), t.as_str()));
        }
    }
    out
}

/// Measures every text in its slot: the first that does not fit is refused, naming its field.
fn measure(fonts: &FontSet, t: &Template, job: &ReelJob) -> Result<(), ComposeError> {
    for (slot, field, value) in texts(job) {
        let spec = t
            .slot(slot)
            .ok_or_else(|| ComposeError::Internal(format!("the reel has no slot {slot}")))?;
        let style = spec
            .style
            .ok_or_else(|| ComposeError::Internal(format!("slot {slot} takes no text")))?;
        let family = match style.font {
            FontRole::Heading => job.brand.heading_font,
            FontRole::Body => job.brand.body_font,
        };
        text::layout(
            fonts,
            family,
            &style,
            value,
            f32::from(spec.width.unwrap_or(936)),
            usize::from(spec.max_lines.unwrap_or(1)),
            spec,
        )
        .map_err(|e| rename(e, &field))?;
    }
    Ok(())
}

/// What a part draws.
enum Kind {
    Title,
    Photo(usize),
    Closing,
}

/// A part being shown: a still card, or a photo's working copy, overlay and motion.
enum Part {
    Card(Pixmap),
    Photo {
        work: Pixmap,
        overlay: Pixmap,
        motion: Motion,
    },
}

/// A photo's slow zoom and drift: the window's scale (working pixels per frame pixel) and its
/// centre move linearly from the start to the end of the part.
#[derive(Clone, Copy)]
struct Motion {
    from: (f32, f32, f32),
    to: (f32, f32, f32),
}

impl Motion {
    fn of(i: usize, work: (f32, f32)) -> Motion {
        let (ww, wh) = work;
        let wide = (ww / 2.0, wh / 2.0, 1.0 + ZOOM);
        // At the close end the window has a margin to drift in; the direction turns with each
        // photo (left, up, right, down), and odd photos zoom out instead of in.
        let (mx, my) = ((ww - W as f32) / 2.0, (wh - H as f32) / 2.0);
        let (dx, dy) = [(-1.0, 0.0), (0.0, -1.0), (1.0, 0.0), (0.0, 1.0)][i % 4];
        let close = (ww / 2.0 + dx * mx * 0.8, wh / 2.0 + dy * my * 0.8, 1.0);
        if i.is_multiple_of(2) {
            Motion {
                from: wide,
                to: close,
            }
        } else {
            Motion {
                from: close,
                to: wide,
            }
        }
    }

    fn at(&self, p: f32) -> (f32, f32, f32) {
        let l = |a: f32, b: f32| a + (b - a) * p;
        (
            l(self.from.0, self.to.0),
            l(self.from.1, self.to.1),
            l(self.from.2, self.to.2),
        )
    }
}

struct Drawer<'a> {
    fonts: &'a FontSet,
    limits: &'a DecodeLimits,
    template: Template,
    job: &'a ReelJob,
}

impl Drawer<'_> {
    fn canvas<'b>(&'b self, job: &'b ComposeJob) -> Result<Canvas<'b>, ComposeError> {
        Canvas::with_logo(self.fonts, job, self.limits, self.job.logo.as_ref())
    }

    fn title(&self, text: &str) -> Result<Pixmap, ComposeError> {
        let job = card_job(&self.template, &self.job.brand, &[(reel::TITLE, text)]);
        let mut c = self.canvas(&job)?;
        let ink = c.brand.ink;
        c.fill(ink);
        let block = c
            .block(reel::TITLE)
            .map_err(|e| rename(e, "title_text"))?
            .ok_or_else(|| ComposeError::Internal("the title card has no title".into()))?;
        let top = reel::TOP_BAND as f32;
        let bottom = (H - reel::BOTTOM_BAND) as f32;
        c.chip(X, top, 64.0, Ground::Dark)?;
        let y = top + (bottom - top - block.height()) / 2.0;
        c.accent_bar(X, y - 44.0);
        c.draw(&block, X, y, 936.0, Align::Left, Color::WHITE, 1.0);
        Ok(c.pixmap)
    }

    fn closing(&self) -> Result<Pixmap, ComposeError> {
        let j = self.job;
        let mut texts = Vec::new();
        for (slot, text) in [
            (reel::HEADING, &j.closing_heading),
            (reel::SITE, &j.closing_site),
            (reel::SLOGAN, &j.closing_slogan),
        ] {
            if let Some(t) = text {
                texts.push((slot, t.as_str()));
            }
        }
        let job = card_job(&self.template, &j.brand, &texts);
        let mut c = self.canvas(&job)?;
        let (ink, bg, accent) = (c.brand.ink, c.brand.background, c.brand.accent);
        c.fill(ink);
        let heading = c
            .block(reel::HEADING)
            .map_err(|e| rename(e, "closing.heading"))?;
        let site = c.block(reel::SITE).map_err(|e| rename(e, "closing.site"))?;
        let slogan = c
            .block(reel::SLOGAN)
            .map_err(|e| rename(e, "closing.slogan"))?;
        let chip = 72.0;
        let has_chip = c.chip_width(chip)? > 0.0;
        let gap = 40.0;
        let parts = [
            has_chip.then_some(chip),
            heading.as_ref().map(|b| b.height()),
            site.as_ref().map(|b| b.height() + 14.0 + 28.0),
            slogan.as_ref().map(|b| b.height()),
        ];
        let shown: Vec<f32> = parts.iter().flatten().copied().collect();
        let total = shown.iter().sum::<f32>() + gap * (shown.len().saturating_sub(1)) as f32;
        let top = reel::TOP_BAND as f32;
        let bottom = (H - reel::BOTTOM_BAND) as f32;
        let mut y = top + ((bottom - top) - total).max(0.0) / 2.0;
        if has_chip {
            c.chip(X, y, chip, Ground::Dark)?;
            y += chip + gap;
        }
        if let Some(b) = &heading {
            c.draw(b, X, y, 936.0, Align::Left, Color::WHITE, 1.0);
            y += b.height() + gap;
        }
        if let Some(b) = &site {
            c.accent_bar(X, y);
            y += 14.0 + 28.0;
            c.draw(b, X, y, 936.0, Align::Left, bg, 1.0);
            y += b.height() + gap;
        }
        if let Some(b) = &slogan {
            c.draw(b, X, y, 936.0, Align::Left, accent, 1.0);
        }
        Ok(c.pixmap)
    }

    /// A photo's overlay on a transparent canvas: the scrims, the brand chip, the caption.
    fn overlay(&self, i: usize, caption: Option<&str>) -> Result<Pixmap, ComposeError> {
        let texts: Vec<(&str, &str)> = caption.map(|t| (reel::CAPTION, t)).into_iter().collect();
        let job = card_job(&self.template, &self.job.brand, &texts);
        let mut c = self.canvas(&job)?;
        let field = caption_field(i);
        let block = c.block(reel::CAPTION).map_err(|e| rename(e, &field))?;
        let top = reel::TOP_BAND as f32;
        c.scrim(0.0, top + 200.0, &[(0.0, 0.55), (1.0, 0.0)]);
        if let Some(block) = &block {
            let bottom = (H - reel::BOTTOM_BAND) as f32;
            let y = bottom - block.height();
            c.scrim(
                y - 360.0,
                H as f32 - (y - 360.0),
                &[(0.0, 0.0), (0.35, 0.6), (1.0, 0.88)],
            );
            c.accent_bar(X, y - 44.0);
            let width = (W - 72 - reel::RIGHT_BAND) as f32;
            c.draw(block, X, y, width, Align::Left, Color::WHITE, 1.0);
        }
        c.chip(X, top, 56.0, Ground::Dark)?;
        Ok(c.pixmap)
    }

    /// Prepares part `kind`: a card is drawn, a photo decoded, reduced to its working copy and
    /// its source dropped.
    fn part(&self, kind: &Kind, bytes: &mut [Option<Vec<u8>>]) -> Result<Part, ComposeError> {
        match kind {
            Kind::Title => {
                let text = self.job.title.as_deref().unwrap_or_default();
                Ok(Part::Card(self.title(text)?))
            }
            Kind::Closing => Ok(Part::Card(self.closing()?)),
            Kind::Photo(i) => {
                let p = &self.job.photos[*i];
                let field = format!("photos.{i}.material_id");
                let encoded = bytes[*i]
                    .take()
                    .ok_or_else(|| ComposeError::Internal("a reel photo is drawn twice".into()))?;
                let (ww, wh) = (
                    (W as f32 * (1.0 + ZOOM)).ceil() as u32,
                    (H as f32 * (1.0 + ZOOM)).ceil() as u32,
                );
                let mut work = Pixmap::new(ww, wh)
                    .ok_or_else(|| ComposeError::Internal("cannot allocate a frame".into()))?;
                {
                    let source = raster::decode(&encoded, &p.image.mime, &field, self.limits)?;
                    drop(encoded);
                    work.fill(raster::color(self.job.brand.ink, 1.0));
                    raster::draw_image(
                        &mut work,
                        &source,
                        (0.0, 0.0, ww as f32, wh as f32),
                        0.0,
                        p.image.focus,
                        Fit::Cover,
                    );
                }
                let overlay = self.overlay(*i, p.caption.as_deref())?;
                Ok(Part::Photo {
                    motion: Motion::of(*i, (ww as f32, wh as f32)),
                    work,
                    overlay,
                })
            }
        }
    }
}

/// One frame's bytes per row.
const ROW: usize = W as usize * 4;

/// How a part shows in one frame: a still card, or a photo's window at this frame's zoom and
/// position (each column's source position worked out once).
enum Shot<'a> {
    Card(&'a Pixmap),
    Photo {
        work: &'a Pixmap,
        overlay: &'a Pixmap,
        cols: Vec<(u32, u32)>,
        top: f32,
        scale: f32,
    },
}

/// A source position split into its whole pixel and a 1/256 fraction, kept a pixel inside.
fn fix(v: f32, max: u32) -> (u32, u32) {
    let v = v.clamp(0.0, (max - 2) as f32);
    let i = v.floor();
    (i as u32, ((v - i) * 256.0) as u32)
}

/// `part` at progress `p` (0 to 1).
fn shot(part: &Part, p: f32) -> Shot<'_> {
    match part {
        Part::Card(card) => Shot::Card(card),
        Part::Photo {
            work,
            overlay,
            motion,
        } => {
            let (cx, cy, s) = motion.at(p);
            let left = cx - W as f32 * s / 2.0;
            let cols = (0..W)
                .map(|x| fix(left + (x as f32 + 0.5) * s - 0.5, work.width()))
                .collect();
            Shot::Photo {
                work,
                overlay,
                cols,
                top: cy - H as f32 * s / 2.0,
                scale: s,
            }
        }
    }
}

/// Draws the rows from `y0` of `shot` into `band` (whole rows of the frame).
fn draw_band(shot: &Shot<'_>, band: &mut [u8], y0: usize) {
    match shot {
        Shot::Card(card) => band.copy_from_slice(&card.data()[y0 * ROW..y0 * ROW + band.len()]),
        Shot::Photo {
            work,
            overlay,
            cols,
            top,
            scale,
        } => {
            let data = work.data();
            let stride = work.width() as usize * 4;
            for (i, row) in band.chunks_exact_mut(ROW).enumerate() {
                let y = y0 + i;
                let (sy, fy) = fix(top + (y as f32 + 0.5) * scale - 0.5, work.height());
                let r0 = &data[sy as usize * stride..(sy as usize + 1) * stride];
                let r1 = &data[(sy as usize + 1) * stride..(sy as usize + 2) * stride];
                sample_row(r0, r1, fy, cols, row);
                over(&overlay.data()[y * ROW..(y + 1) * ROW], row);
            }
        }
    }
}

/// A pixel's four bytes as one word (R in the low byte).
fn word(b: &[u8]) -> u32 {
    u32::from_le_bytes([b[0], b[1], b[2], b[3]])
}

/// `a` moved toward `b` by `f`/256, all four channels at once: two channels per 16-bit lane,
/// each sum at most 255 x 256, so no lane spills into the next.
fn lerp(a: u32, b: u32, f: u32) -> u32 {
    let g = 256 - f;
    let rb = (((a & 0x00ff_00ff) * g + (b & 0x00ff_00ff) * f) >> 8) & 0x00ff_00ff;
    let ga = (((a >> 8) & 0x00ff_00ff) * g + ((b >> 8) & 0x00ff_00ff) * f) & 0xff00_ff00;
    rb | ga
}

/// One output row, bilinearly from source rows `r0` and `r1` (`fy`/256 of the way down).
fn sample_row(r0: &[u8], r1: &[u8], fy: u32, cols: &[(u32, u32)], row: &mut [u8]) {
    for (px, (sx, fx)) in row.chunks_exact_mut(4).zip(cols) {
        let at = *sx as usize * 4;
        let (a, b) = (&r0[at..at + 8], &r1[at..at + 8]);
        let top = lerp(word(a), word(&a[4..]), *fx);
        let bottom = lerp(word(b), word(&b[4..]), *fx);
        px.copy_from_slice(&(lerp(top, bottom, fy) | 0xff00_0000).to_le_bytes());
    }
}

/// Composites a premultiplied overlay over the opaque frame `out`.
fn over(overlay: &[u8], out: &mut [u8]) {
    for (o, d) in overlay.chunks_exact(4).zip(out.chunks_exact_mut(4)) {
        let a = u32::from(o[3]);
        if a == 0 {
            continue;
        }
        let keep = 255 - a;
        for k in 0..3 {
            d[k] = (u32::from(o[k]) + (u32::from(d[k]) * keep + 127) / 255).min(255) as u8;
        }
    }
}

/// `a` faded into `b` by `t` (0 to 256), into `a`.
fn fade(a: &mut [u8], b: &[u8], t: u32) {
    for (x, y) in a.chunks_exact_mut(4).zip(b.chunks_exact(4)) {
        x.copy_from_slice(&lerp(word(x), word(y), t).to_le_bytes());
    }
}

/// Draws one frame from `shots` (the outgoing part, then the incoming one with its fade) and
/// converts it into `yuv` (I420: Y, then U, then V), in `bands` horizontal bands at once; `a`
/// and `b` are RGBA scratch of the frame's size.
fn draw_frame(shots: &[(Shot<'_>, u32)], a: &mut [u8], b: &mut [u8], yuv: &mut [u8], bands: usize) {
    // Whole row pairs per band: chroma has one row per two.
    let rows = (H as usize).div_ceil(bands.max(1)).next_multiple_of(2);
    let w = W as usize;
    let (y_plane, chroma) = yuv.split_at_mut(w * H as usize);
    let (u_plane, v_plane) = chroma.split_at_mut(w * H as usize / 4);
    std::thread::scope(|s| {
        let bands = a
            .chunks_mut(rows * ROW)
            .zip(b.chunks_mut(rows * ROW))
            .zip(y_plane.chunks_mut(rows * w))
            .zip(u_plane.chunks_mut(rows * w / 4))
            .zip(v_plane.chunks_mut(rows * w / 4));
        for (i, ((((ba, bb), by), bu), bv)) in bands.enumerate() {
            s.spawn(move || {
                let y0 = i * rows;
                draw_band(&shots[0].0, ba, y0);
                if let Some((incoming, t)) = shots.get(1) {
                    draw_band(incoming, bb, y0);
                    fade(ba, bb, *t);
                }
                crate::h264::rgba_to_i420(ba, w, by, bu, bv);
            });
        }
    });
}

/// Renders `job` into an MP4 file, stopping at `deadline`. Frames are drawn on this thread (in
/// bands, on [`EncodeLimits::draw_threads`] threads) while the encoder, on a thread of its own,
/// encodes the previous one: three frame buffers circulate between them, no more.
pub(crate) fn render(
    fonts: &FontSet,
    mut job: ReelJob,
    limits: &DecodeLimits,
    encode: &EncodeLimits,
    deadline: Instant,
) -> Result<RenderedReel, ComposeError> {
    let n = job.photos.len();
    if !(reel::MIN_PHOTOS..=reel::MAX_PHOTOS).contains(&n) {
        return Err(ComposeError::Internal(format!(
            "a reel takes {} to {} photos",
            reel::MIN_PHOTOS,
            reel::MAX_PHOTOS
        )));
    }
    let (lo, hi) = reel::PHOTO_MS;
    if !(lo..=hi).contains(&job.photo_ms) {
        return Err(ComposeError::Internal(
            "a photo's length is out of range".into(),
        ));
    }
    let t = reel_template()?;
    measure(fonts, &t, &job)?;
    // The photos' encoded bytes move out of the job: each is dropped once decoded.
    let mut bytes: Vec<Option<Vec<u8>>> = job
        .photos
        .iter_mut()
        .map(|p| Some(std::mem::take(&mut p.image.bytes)))
        .collect();
    let title = job.title.is_some();
    let closing =
        job.closing_heading.is_some() || job.closing_site.is_some() || job.closing_slogan.is_some();
    let mut kinds = Vec::new();
    if title {
        kinds.push(Kind::Title);
    }
    kinds.extend((0..n).map(Kind::Photo));
    if closing {
        kinds.push(Kind::Closing);
    }
    let lengths = reel::parts(n, job.photo_ms, title, closing);
    let xf = reel::crossfade_frames();
    let mut starts = Vec::with_capacity(lengths.len());
    let mut at = 0u32;
    for len in &lengths {
        starts.push(at);
        at += len - xf;
    }
    let total = reel::total_frames(&lengths);
    let drawer = Drawer {
        fonts,
        limits,
        template: t,
        job: &job,
    };
    let size = (W * H * 4) as usize;
    let yuv_size = (W * H * 3 / 2) as usize;
    let encode = *encode;
    let (to_encoder, frames_in) = std::sync::mpsc::sync_channel::<Vec<u8>>(1);
    let (give_back, returned) = std::sync::mpsc::channel::<Vec<u8>>();
    for _ in 0..3 {
        let _ = give_back.send(vec![0u8; yuv_size]);
    }
    let (mut rgba, mut scratch) = (vec![0u8; size], vec![0u8; size]);
    let mut live: Vec<Option<Part>> = (0..kinds.len()).map(|_| None).collect();
    let mut drawing = std::time::Duration::ZERO;
    std::thread::scope(|s| {
        let encoder = s.spawn(move || {
            let mut h264 = H264::new(W, H, reel::FPS, &encode)?;
            let mut encoding = std::time::Duration::ZERO;
            for frame in frames_in {
                let began = Instant::now();
                h264.push(&frame)?;
                encoding += began.elapsed();
                // The buffer goes back to be drawn into again.
                let _ = give_back.send(frame);
            }
            h264.finish().map(|out| (out, encoding))
        });
        let drawn = (|| -> Result<(), ComposeError> {
            for f in 0..total {
                if Instant::now() > deadline {
                    return Err(ComposeError::TimedOut);
                }
                // A free buffer; none means the encoder stopped (its error is read below).
                let Ok(mut frame) = returned.recv() else {
                    return Ok(());
                };
                let mut shots = Vec::with_capacity(2);
                for (k, kind) in kinds.iter().enumerate() {
                    let (start, len) = (starts[k], lengths[k]);
                    if f < start || f >= start + len {
                        continue;
                    }
                    if live[k].is_none() {
                        live[k] = Some(drawer.part(kind, &mut bytes)?);
                    }
                    let p = (f - start) as f32 / (len - 1).max(1) as f32;
                    // The incoming part fades in over the crossfade.
                    let fade = (f - start + 1) * 256 / (xf + 1);
                    shots.push((k, p, fade));
                }
                let began = Instant::now();
                {
                    let shots: Vec<(Shot<'_>, u32)> = shots
                        .iter()
                        .map(|(k, p, fade)| (shot(live[*k].as_ref().expect("prepared"), *p), *fade))
                        .collect();
                    draw_frame(
                        &shots,
                        &mut rgba,
                        &mut scratch,
                        &mut frame,
                        encode.draw_threads,
                    );
                }
                drawing += began.elapsed();
                for (k, _, _) in &shots {
                    if f + 1 == starts[*k] + lengths[*k] {
                        // Its last frame: the part (and its working copy) goes.
                        live[*k] = None;
                    }
                }
                if to_encoder.send(frame).is_err() {
                    return Ok(());
                }
            }
            Ok(())
        })();
        drop(to_encoder);
        let encoded = encoder
            .join()
            .map_err(|_| ComposeError::Internal("the encoder thread panicked".into()))?;
        drawn?;
        let ((bytes, frames), encoding) = encoded?;
        tracing::debug!(
            frames,
            drawing_ms = drawing.as_millis() as u64,
            encoding_ms = encoding.as_millis() as u64,
            "reel frames drawn and encoded"
        );
        if frames != total {
            return Err(ComposeError::Internal(format!(
                "the encoder took {frames} of {total} frames"
            )));
        }
        Ok(RenderedReel {
            bytes,
            mime: "video/mp4",
            width: W,
            height: H,
            fps: reel::FPS,
            frames,
            duration_ms: reel::duration_ms(frames),
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn motion_stays_inside_the_working_copy() {
        let work = (
            (W as f32 * (1.0 + ZOOM)).ceil(),
            (H as f32 * (1.0 + ZOOM)).ceil(),
        );
        for i in 0..8 {
            let m = Motion::of(i, work);
            for p in [0.0, 0.5, 1.0] {
                let (cx, cy, s) = m.at(p);
                assert!(cx - W as f32 * s / 2.0 >= -0.5, "{i} {p}");
                assert!(cx + W as f32 * s / 2.0 <= work.0 + 0.5, "{i} {p}");
                assert!(cy - H as f32 * s / 2.0 >= -0.5, "{i} {p}");
                assert!(cy + H as f32 * s / 2.0 <= work.1 + 0.5, "{i} {p}");
            }
        }
    }

    #[test]
    fn a_packed_lerp_moves_every_channel() {
        let (a, b) = (0x10_20_30_ff_u32, 0xff_00_80_00_u32);
        assert_eq!(lerp(a, b, 0), a);
        assert_eq!(lerp(a, b, 256), b);
        let half = lerp(0x00_00_00_00, 0xfe_fe_fe_fe, 128);
        assert_eq!(half, 0x7f_7f_7f_7f);
        let mut x = vec![0u8, 100, 200, 255];
        fade(&mut x, &[200, 100, 0, 255], 64);
        assert_eq!(x, [50, 100, 150, 255]);
    }

    #[test]
    fn an_overlay_composites_premultiplied() {
        let mut out = vec![200u8, 100, 0, 255];
        over(&[0, 0, 0, 0], &mut out);
        assert_eq!(out, [200, 100, 0, 255]);
        over(&[128, 0, 0, 128], &mut out);
        assert_eq!(out[0], 128 + 100);
        over(&[10, 20, 30, 255], &mut out);
        assert_eq!(&out[..3], &[10, 20, 30]);
    }
}
