//! Text: shaped with the bundled fonts (harfrust), wrapped by words into a slot's width, measured
//! so a text that does not fit is refused, and drawn from the glyph outlines.
use crate::fonts::FontSet;
use harfrust::font::glyph::outline::{DrawMemory, DrawOptions, PathSink};
use harfrust::{Buffer, GlyphId, ShapeOptions, ShaperFont};
use jt_app::ports::compose::ComposeError;
use jt_studio::compose::{FontFamily, SlotSpec, TextStyle};
use tiny_skia::{FillRule, Paint, PathBuilder, Pixmap, Transform};

/// One glyph placed on a line: its font instance, id and pen position (pixels, from the line's
/// left edge, on its baseline).
#[derive(Clone, Copy)]
struct Placed {
    instance: usize,
    glyph: u32,
    x: f32,
    y: f32,
}

/// A shaped word: its glyphs and advance.
struct Word {
    glyphs: Vec<Placed>,
    width: f32,
}

/// A laid-out line.
pub(crate) struct Line {
    glyphs: Vec<Placed>,
    pub width: f32,
}

/// A text laid out in its slot: its lines, the size and the box each line takes.
pub(crate) struct Block {
    pub lines: Vec<Line>,
    pub line_height: f32,
    /// From a line box's top to its baseline.
    baseline: f32,
    pub size: f32,
}

impl Block {
    pub fn height(&self) -> f32 {
        self.line_height * self.lines.len() as f32
    }
    pub fn width(&self) -> f32 {
        self.lines.iter().map(|l| l.width).fold(0.0, f32::max)
    }
}

/// Families of a text in the order a character is looked for: its own, then the other bundled
/// ones (per-glyph fallback, e.g. ₺ in a body font that lacks it).
fn chain(primary: FontFamily) -> Vec<FontFamily> {
    let mut out = vec![primary];
    out.extend(FontFamily::ALL.into_iter().filter(|f| *f != primary));
    out
}

/// Shapes `word` in `families` (fallback order) at `style`.
fn shape_word(
    fonts: &FontSet,
    families: &[FontFamily],
    style: &TextStyle,
    word: &str,
    slot: &str,
) -> Result<Word, ComposeError> {
    // Runs of consecutive characters drawn by the same family.
    let mut runs: Vec<(usize, String)> = Vec::new();
    for c in word.chars() {
        let family = families
            .iter()
            .find(|f| fonts.covers(**f, c))
            .ok_or_else(|| ComposeError::UnsupportedCharacter {
                slot: slot.to_owned(),
                character: c,
            })?;
        let instance = fonts.instance(*family, style.weight);
        match runs.last_mut() {
            Some((at, text)) if *at == instance => text.push(c),
            _ => runs.push((instance, c.to_string())),
        }
    }
    let tracking = style.tracking * style.size;
    let mut glyphs = Vec::new();
    let mut pen = 0.0f32;
    for (instance, text) in runs {
        let font = fonts.get(instance);
        let scale = style.size / font.units_per_em;
        let shaper = ShaperFont::new(&font.font);
        let mut buffer = Buffer::new();
        buffer.push_str(&text);
        buffer.set_language("tr".parse().ok());
        buffer.guess_segment_properties();
        harfrust::shape(&shaper, &mut buffer, ShapeOptions::new())
            .map_err(|e| ComposeError::Internal(format!("shaping failed: {e:?}")))?;
        for (info, pos) in buffer.glyph_infos().iter().zip(buffer.glyph_positions()) {
            glyphs.push(Placed {
                instance,
                glyph: info.glyph_id,
                x: pen + pos.x_offset as f32 * scale,
                y: -(pos.y_offset as f32) * scale,
            });
            pen += pos.x_advance as f32 * scale + tracking;
        }
    }
    // Letter spacing goes between letters, not after the last one.
    if !glyphs.is_empty() {
        pen -= tracking;
    }
    Ok(Word { glyphs, width: pen })
}

/// The advance of a space in `family` at `style`.
fn space(fonts: &FontSet, family: FontFamily, style: &TextStyle) -> f32 {
    let at = fonts.instance(family, style.weight);
    let font = fonts.get(at);
    let scale = style.size / font.units_per_em;
    let advance = fonts.glyph(at, ' ').map_or(style.size * 0.25, |g| {
        font.font.glyph_metrics().h_advance(g) * scale
    });
    advance + style.tracking * style.size
}

/// Lays `text` out in `width` pixels: words wrapped greedily, line feeds kept as breaks. More
/// lines than `max_lines`, or a word wider than the slot, is [`ComposeError::Overflow`]: nothing
/// is clipped, shrunk or hyphenated.
pub(crate) fn layout(
    fonts: &FontSet,
    family: FontFamily,
    style: &TextStyle,
    text: &str,
    width: f32,
    max_lines: usize,
    spec: &SlotSpec,
) -> Result<Block, ComposeError> {
    let families = chain(family);
    let space = space(fonts, family, style);
    let overflow =
        |lines_needed: Option<usize>, word_too_wide: Option<String>| ComposeError::Overflow {
            slot: spec.key.to_owned(),
            max_chars: spec.max_chars.unwrap_or(0),
            max_lines: spec.max_lines.unwrap_or(1),
            lines_needed,
            word_too_wide,
        };
    let mut lines: Vec<Line> = Vec::new();
    for paragraph in text.split('\n') {
        let mut current = Line {
            glyphs: Vec::new(),
            width: 0.0,
        };
        for word in paragraph.split_whitespace() {
            let w = shape_word(fonts, &families, style, word, spec.key)?;
            if w.width > width {
                // No wrapping fixes a word wider than the slot: named so it can be replaced.
                return Err(overflow(None, Some(word.to_owned())));
            }
            let start = if current.glyphs.is_empty() {
                0.0
            } else {
                current.width + space
            };
            if !current.glyphs.is_empty() && start + w.width > width {
                lines.push(std::mem::replace(
                    &mut current,
                    Line {
                        glyphs: Vec::new(),
                        width: 0.0,
                    },
                ));
                current.glyphs.extend(w.glyphs);
                current.width = w.width;
            } else {
                current.glyphs.extend(w.glyphs.into_iter().map(|g| Placed {
                    x: g.x + start,
                    ..g
                }));
                current.width = start + w.width;
            }
        }
        lines.push(current);
    }
    if lines.len() > max_lines {
        return Err(overflow(Some(lines.len()), None));
    }
    // CSS line boxes: the font's ascent and descent centred in the line height.
    let font = fonts.get(fonts.instance(family, style.weight));
    let scale = style.size / font.units_per_em;
    let ascent = font.ascender * scale;
    let descent = font.descender * scale;
    let line_height = style.size * style.line_height;
    Ok(Block {
        lines,
        line_height,
        baseline: (line_height - (ascent + descent)) / 2.0 + ascent,
        size: style.size,
    })
}

/// Collects a glyph's outline, scaled and placed, into a path.
struct Outline<'a> {
    path: &'a mut PathBuilder,
    x: f32,
    y: f32,
    scale: f32,
}

impl PathSink for Outline<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        self.path
            .move_to(self.x + x * self.scale, self.y - y * self.scale);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.path
            .line_to(self.x + x * self.scale, self.y - y * self.scale);
    }
    fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
        self.path.quad_to(
            self.x + x1 * self.scale,
            self.y - y1 * self.scale,
            self.x + x * self.scale,
            self.y - y * self.scale,
        );
    }
    fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
        self.path.cubic_to(
            self.x + x1 * self.scale,
            self.y - y1 * self.scale,
            self.x + x2 * self.scale,
            self.y - y2 * self.scale,
            self.x + x * self.scale,
            self.y - y * self.scale,
        );
    }
    fn close(&mut self) {
        self.path.close();
    }
}

/// How a block's lines sit horizontally in their box.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Align {
    Left,
    Right,
    Center,
}

/// Draws `block` with its first line box's top at `y`, aligned in `[x, x + width]`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn draw(
    pixmap: &mut Pixmap,
    fonts: &FontSet,
    block: &Block,
    x: f32,
    y: f32,
    width: f32,
    align: Align,
    paint: &Paint,
) {
    let mut path = PathBuilder::new();
    for (n, line) in block.lines.iter().enumerate() {
        let left = match align {
            Align::Left => x,
            Align::Right => x + width - line.width,
            Align::Center => x + (width - line.width) / 2.0,
        };
        let baseline = y + n as f32 * block.line_height + block.baseline;
        for g in &line.glyphs {
            let font = fonts.get(g.instance);
            let scale = block.size / font.units_per_em;
            let mut outline = Outline {
                path: &mut path,
                x: left + g.x,
                y: baseline + g.y,
                scale,
            };
            if let Some(glyph) = font.font.outline_glyphs().get(GlyphId::new(g.glyph)) {
                // Font units (no size), placed and scaled by the sink.
                let _ = glyph.draw(&DrawOptions::new(), DrawMemory::Scratch, &mut outline);
            }
        }
    }
    if let Some(path) = path.finish() {
        pixmap.fill_path(&path, paint, FillRule::Winding, Transform::identity(), None);
    }
}
