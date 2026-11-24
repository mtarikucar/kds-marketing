//! Decoding the source photos (JPEG, PNG and WebP only, bounded), drawing them cover- or
//! contain-fitted with rounded corners, shapes and gradients, and encoding the result.
use image::metadata::Orientation;
use image::{
    DynamicImage, ImageBuffer, ImageDecoder, ImageFormat, ImageReader, Pixel, RgbImage, RgbaImage,
    imageops,
};
use jt_app::ports::compose::{ComposeError, OutputFormat};
use jt_studio::compose::Color;
use std::io::Cursor;
use tiny_skia::{
    FillRule, GradientStop, LinearGradient, Mask, Paint, PathBuilder, Pixmap, PixmapPaint, Point,
    Rect, Shader, SpreadMode, Transform,
};

/// How large a source image the renderer decodes.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// The longest side, in pixels.
    pub max_side: u32,
    /// Width times height.
    pub max_pixels: u64,
    /// What a decoder may allocate, in bytes.
    pub max_alloc: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_side: 8_000,
            // 24 MP: a 6000 x 4000 camera photo. Decoded as RGBA that is 96 MB, the most one
            // render holds of a source at a time.
            max_pixels: 24_000_000,
            max_alloc: 100 * 1024 * 1024,
        }
    }
}

fn image_error(slot: &str, reason: impl Into<String>) -> ComposeError {
    ComposeError::Image {
        slot: slot.to_owned(),
        reason: reason.into(),
    }
}

/// A decoded source, as its file stores it: 8-bit RGB or RGBA (other layouts are converted), and
/// the EXIF orientation still to apply. The orientation is applied to what is drawn, after the
/// crop and resample, never to the whole source (that would copy it).
pub(crate) struct Source {
    pixels: Pixels,
    orientation: Orientation,
}

enum Pixels {
    Rgb(RgbImage),
    Rgba(RgbaImage),
}

impl Source {
    fn stored_size(&self) -> (u32, u32) {
        match &self.pixels {
            Pixels::Rgb(i) => i.dimensions(),
            Pixels::Rgba(i) => i.dimensions(),
        }
    }

    /// Whether drawing it upright swaps its width and height.
    fn transposed(&self) -> bool {
        matches!(
            self.orientation,
            Orientation::Rotate90
                | Orientation::Rotate270
                | Orientation::Rotate90FlipH
                | Orientation::Rotate270FlipH
        )
    }

    /// Its size as drawn (upright).
    fn upright_size(&self) -> (u32, u32) {
        let (w, h) = self.stored_size();
        if self.transposed() { (h, w) } else { (w, h) }
    }

    /// The stored point that shows at upright point `(x, y)` (each 0 to 1).
    fn stored_point(&self, (x, y): (f32, f32)) -> (f32, f32) {
        match self.orientation {
            Orientation::NoTransforms => (x, y),
            Orientation::Rotate90 => (y, 1.0 - x),
            Orientation::Rotate180 => (1.0 - x, 1.0 - y),
            Orientation::Rotate270 => (1.0 - y, x),
            Orientation::FlipHorizontal => (1.0 - x, y),
            Orientation::FlipVertical => (x, 1.0 - y),
            Orientation::Rotate90FlipH => (y, x),
            Orientation::Rotate270FlipH => (1.0 - y, 1.0 - x),
        }
    }
}

/// Decodes `bytes` of type `mime` (JPEG, PNG or WebP; nothing else is tried) within `limits`:
/// its side, its pixel count and the bytes the decoded image takes are checked from its header,
/// before anything is decoded.
pub(crate) fn decode(
    bytes: &[u8],
    mime: &str,
    slot: &str,
    limits: &Limits,
) -> Result<Source, ComposeError> {
    let format = match mime.trim().to_ascii_lowercase().as_str() {
        "image/jpeg" => ImageFormat::Jpeg,
        "image/png" => ImageFormat::Png,
        "image/webp" => ImageFormat::WebP,
        _ => {
            return Err(image_error(
                slot,
                "only JPEG, PNG and WebP images are drawn",
            ));
        }
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut l = image::Limits::default();
    l.max_image_width = Some(limits.max_side);
    l.max_image_height = Some(limits.max_side);
    l.max_alloc = Some(limits.max_alloc);
    reader.limits(l);
    let mut decoder = reader
        .into_decoder()
        .map_err(|e| image_error(slot, format!("unreadable image: {e}")))?;
    let (w, h) = decoder.dimensions();
    if w > limits.max_side || h > limits.max_side || u64::from(w) * u64::from(h) > limits.max_pixels
    {
        return Err(image_error(
            slot,
            format!(
                "the image is {w}x{h}; at most {} pixels and {} on a side are drawn",
                limits.max_pixels, limits.max_side
            ),
        ));
    }
    // `into_decoder` hands the limits to the decoder but does not check the decoded size itself
    // (`decode` would): checked here.
    if decoder.total_bytes() > limits.max_alloc {
        return Err(image_error(
            slot,
            format!(
                "the decoded image would take {} bytes; at most {} are",
                decoder.total_bytes(),
                limits.max_alloc
            ),
        ));
    }
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let image = DynamicImage::from_decoder(decoder)
        .map_err(|e| image_error(slot, format!("unreadable image: {e}")))?;
    let pixels = match image {
        DynamicImage::ImageRgb8(i) => Pixels::Rgb(i),
        DynamicImage::ImageRgba8(i) => Pixels::Rgba(i),
        // Grey or 16-bit sources (rare from cameras) are converted once.
        other => Pixels::Rgba(other.into_rgba8()),
    };
    Ok(Source {
        pixels,
        orientation,
    })
}

/// A tiny-skia colour of `c` at `alpha` (0 to 1).
pub(crate) fn color(c: Color, alpha: f32) -> tiny_skia::Color {
    tiny_skia::Color::from_rgba8(c.0, c.1, c.2, (alpha.clamp(0.0, 1.0) * 255.0).round() as u8)
}

/// A solid paint.
pub(crate) fn solid(c: Color, alpha: f32) -> Paint<'static> {
    let mut paint = Paint::default();
    paint.set_color(color(c, alpha));
    paint.anti_alias = true;
    paint
}

/// A rectangle's path with each corner's radius (top-left, top-right, bottom-right,
/// bottom-left).
pub(crate) fn rounded(x: f32, y: f32, w: f32, h: f32, r: [f32; 4]) -> Option<tiny_skia::Path> {
    // The cubic Bézier constant for a quarter circle.
    const K: f32 = 0.552_284_8;
    let clamp = |v: f32| v.min(w / 2.0).min(h / 2.0).max(0.0);
    let [tl, tr, br, bl] = r.map(clamp);
    let mut p = PathBuilder::new();
    p.move_to(x + tl, y);
    p.line_to(x + w - tr, y);
    p.cubic_to(
        x + w - tr + tr * K,
        y,
        x + w,
        y + tr - tr * K,
        x + w,
        y + tr,
    );
    p.line_to(x + w, y + h - br);
    p.cubic_to(
        x + w,
        y + h - br + br * K,
        x + w - br + br * K,
        y + h,
        x + w - br,
        y + h,
    );
    p.line_to(x + bl, y + h);
    p.cubic_to(
        x + bl - bl * K,
        y + h,
        x,
        y + h - bl + bl * K,
        x,
        y + h - bl,
    );
    p.line_to(x, y + tl);
    p.cubic_to(x, y + tl - tl * K, x + tl - tl * K, y, x + tl, y);
    p.close();
    p.finish()
}

/// Fills a rounded rectangle.
pub(crate) fn fill_rounded(
    pixmap: &mut Pixmap,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    r: [f32; 4],
    paint: &Paint,
) {
    if let Some(path) = rounded(x, y, w, h, r) {
        pixmap.fill_path(&path, paint, FillRule::Winding, Transform::identity(), None);
    }
}

/// Fills a rectangle with a top-to-bottom gradient of `c`: `stops` are (offset, alpha).
pub(crate) fn vertical_gradient(
    pixmap: &mut Pixmap,
    rect: (f32, f32, f32, f32),
    c: Color,
    stops: &[(f32, f32)],
) {
    let (x, y, w, h) = rect;
    let Some(r) = Rect::from_xywh(x, y, w, h) else {
        return;
    };
    let Some(shader) = LinearGradient::new(
        Point::from_xy(x, y),
        Point::from_xy(x, y + h),
        stops
            .iter()
            .map(|(at, alpha)| GradientStop::new(*at, color(c, *alpha)))
            .collect(),
        SpreadMode::Pad,
        Transform::identity(),
    ) else {
        return;
    };
    let paint = Paint {
        shader,
        anti_alias: false,
        ..Paint::default()
    };
    pixmap.fill_rect(r, &paint, Transform::identity(), None);
}

/// A gradient between two colours, for a card's ground.
pub(crate) fn two_color_gradient(
    pixmap: &mut Pixmap,
    path: &tiny_skia::Path,
    top: (f32, Color),
    bottom: (f32, Color),
) {
    let shader = LinearGradient::new(
        Point::from_xy(0.0, top.0),
        Point::from_xy(0.0, bottom.0),
        vec![
            GradientStop::new(0.0, color(top.1, 1.0)),
            GradientStop::new(1.0, color(bottom.1, 1.0)),
        ],
        SpreadMode::Pad,
        Transform::identity(),
    )
    .unwrap_or(Shader::SolidColor(color(bottom.1, 1.0)));
    let paint = Paint {
        shader,
        anti_alias: true,
        ..Paint::default()
    };
    pixmap.fill_path(path, &paint, FillRule::Winding, Transform::identity(), None);
}

/// How a source fills its box.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Fit {
    /// The box is filled; what falls outside is cropped around the focus point.
    Cover,
    /// The whole image shows inside the box.
    Contain,
}

/// The part `(x, y, w, h)` of `image` (stored pixels) resampled to `tw` x `th`, without copying
/// the part first: an area average when it shrinks (no intermediate buffer), Catmull-Rom when it
/// grows.
fn resample<P>(
    image: &ImageBuffer<P, Vec<u8>>,
    (x, y, w, h): (u32, u32, u32, u32),
    (tw, th): (u32, u32),
) -> ImageBuffer<P, Vec<u8>>
where
    P: Pixel<Subpixel = u8> + 'static,
{
    let part = imageops::crop_imm(image, x, y, w.max(1), h.max(1));
    if w >= tw && h >= th {
        imageops::thumbnail(&*part, tw, th)
    } else {
        imageops::resize(&*part, tw, th, imageops::FilterType::CatmullRom)
    }
}

/// Draws `source` upright into the box `(x, y, w, h)` with corner radius `radius`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn draw_image(
    pixmap: &mut Pixmap,
    source: &Source,
    (x, y, w, h): (f32, f32, f32, f32),
    radius: f32,
    focus: (f32, f32),
    fit: Fit,
) {
    let (uw, uh) = source.upright_size();
    let (iw, ih) = (uw as f32, uh as f32);
    if iw < 1.0 || ih < 1.0 || w < 1.0 || h < 1.0 {
        return;
    }
    // In upright coordinates: the part shown and the size it is drawn at.
    let (ox, oy, part, (tw, th)) = match fit {
        Fit::Cover => {
            // The largest part of the box's aspect, centred on the focus point where it can be.
            let scale = (w / iw).max(h / ih);
            let (cw, ch) = ((w / scale).min(iw), (h / scale).min(ih));
            let cx = (focus.0.clamp(0.0, 1.0) * iw - cw / 2.0).clamp(0.0, iw - cw);
            let cy = (focus.1.clamp(0.0, 1.0) * ih - ch / 2.0).clamp(0.0, ih - ch);
            (
                x,
                y,
                (cx / iw, cy / ih, (cx + cw) / iw, (cy + ch) / ih),
                (w.round().max(1.0) as u32, h.round().max(1.0) as u32),
            )
        }
        Fit::Contain => {
            let scale = (w / iw).min(h / ih);
            let (tw, th) = ((iw * scale).round().max(1.0), (ih * scale).round().max(1.0));
            (
                x + (w - tw) / 2.0,
                y + (h - th) / 2.0,
                (0.0, 0.0, 1.0, 1.0),
                (tw as u32, th as u32),
            )
        }
    };
    // The same part in stored coordinates: its two corners mapped back, in either order.
    let (sw, sh) = source.stored_size();
    let a = source.stored_point((part.0, part.1));
    let b = source.stored_point((part.2, part.3));
    let (x0, x1) = (a.0.min(b.0), a.0.max(b.0));
    let (y0, y1) = (a.1.min(b.1), a.1.max(b.1));
    let rect = (
        (x0 * sw as f32).round() as u32,
        (y0 * sh as f32).round() as u32,
        ((x1 - x0) * sw as f32).round() as u32,
        ((y1 - y0) * sh as f32).round() as u32,
    );
    let target = if source.transposed() {
        (th, tw)
    } else {
        (tw, th)
    };
    // Only the small, resampled part is turned upright.
    let mut out = match &source.pixels {
        Pixels::Rgb(i) => DynamicImage::ImageRgb8(resample(i, rect, target)),
        Pixels::Rgba(i) => DynamicImage::ImageRgba8(resample(i, rect, target)),
    };
    out.apply_orientation(source.orientation);
    let out = out.into_rgba8();
    let Some(size) = tiny_skia::IntSize::from_wh(out.width(), out.height()) else {
        return;
    };
    // tiny-skia keeps premultiplied pixels.
    let mut data = out.into_raw();
    for px in data.chunks_exact_mut(4) {
        let a = u16::from(px[3]);
        if a < 255 {
            for c in &mut px[..3] {
                *c = ((u16::from(*c) * a + 127) / 255) as u8;
            }
        }
    }
    let Some(src) = Pixmap::from_vec(data, size) else {
        return;
    };
    let mask = if radius > 0.0 {
        let (mw, mh) = (src.width() as f32, src.height() as f32);
        rounded(ox, oy, mw, mh, [radius; 4]).and_then(|path| {
            let mut mask = Mask::new(pixmap.width(), pixmap.height())?;
            mask.fill_path(&path, FillRule::Winding, true, Transform::identity());
            Some(mask)
        })
    } else {
        None
    };
    pixmap.draw_pixmap(
        ox.round() as i32,
        oy.round() as i32,
        src.as_ref(),
        &PixmapPaint::default(),
        Transform::identity(),
        mask.as_ref(),
    );
}

/// Encodes the (opaque) canvas.
pub(crate) fn encode(pixmap: &Pixmap, format: OutputFormat) -> Result<Vec<u8>, ComposeError> {
    let (w, h) = (pixmap.width(), pixmap.height());
    let mut rgb = Vec::with_capacity((w * h * 3) as usize);
    for px in pixmap.pixels() {
        let c = px.demultiply();
        rgb.extend_from_slice(&[c.red(), c.green(), c.blue()]);
    }
    let mut out = Vec::new();
    let failed = |e: image::ImageError| ComposeError::Internal(format!("cannot encode: {e}"));
    match format {
        OutputFormat::Jpeg => {
            let encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 92);
            image::ImageEncoder::write_image(encoder, &rgb, w, h, image::ExtendedColorType::Rgb8)
                .map_err(failed)?;
        }
        OutputFormat::Png => {
            let encoder = image::codecs::png::PngEncoder::new(&mut out);
            image::ImageEncoder::write_image(encoder, &rgb, w, h, image::ExtendedColorType::Rgb8)
                .map_err(failed)?;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A 60 x 40 image whose every pixel is distinct.
    fn sample() -> RgbaImage {
        ImageBuffer::from_fn(60, 40, |x, y| {
            image::Rgba([x as u8 * 4, y as u8 * 6, 128, 255])
        })
    }

    /// Drawing with the orientation applied to the small part equals turning the whole source
    /// upright first, for each EXIF orientation.
    #[test]
    fn orientation_is_applied_to_the_part_as_to_the_whole() {
        use Orientation::*;
        for o in [
            NoTransforms,
            Rotate90,
            Rotate180,
            Rotate270,
            FlipHorizontal,
            FlipVertical,
            Rotate90FlipH,
            Rotate270FlipH,
        ] {
            let lazy = Source {
                pixels: Pixels::Rgba(sample()),
                orientation: o,
            };
            let mut upright = DynamicImage::ImageRgba8(sample());
            upright.apply_orientation(o);
            let eager = Source {
                pixels: Pixels::Rgba(upright.into_rgba8()),
                orientation: NoTransforms,
            };
            assert_eq!(lazy.upright_size(), eager.stored_size(), "{o:?}");
            for (focus, fit) in [((0.2, 0.7), Fit::Cover), ((0.5, 0.5), Fit::Contain)] {
                let mut a = Pixmap::new(30, 30).unwrap();
                let mut b = Pixmap::new(30, 30).unwrap();
                draw_image(&mut a, &lazy, (0.0, 0.0, 24.0, 18.0), 0.0, focus, fit);
                draw_image(&mut b, &eager, (0.0, 0.0, 24.0, 18.0), 0.0, focus, fit);
                let differ = a
                    .data()
                    .iter()
                    .zip(b.data())
                    .filter(|(x, y)| x.abs_diff(**y) > 12)
                    .count();
                assert!(differ * 50 < a.data().len(), "{o:?} {differ}");
            }
        }
    }
}
