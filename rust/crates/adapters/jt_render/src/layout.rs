//! The templates' compositions: where each role's variant puts its photos, texts, brand chip and
//! counter. Sizes and limits of the texts are the domain's (`jt_studio::compose`); positions are
//! here. Every text block is measured before anything is placed, so a text that does not fit is
//! refused before a pixel is drawn.
use crate::fonts::FontSet;
use crate::raster::{self, Fit, Limits, fill_rounded, solid, vertical_gradient};
use crate::text::{self, Align, Block};
use jt_app::ports::compose::{ComposeError, ComposeJob, Rect};
use jt_studio::compose::{BrandTokens, Color, FontRole, Role, SlotKind, TextStyle};
use tiny_skia::Pixmap;

const M: f32 = 64.0;
const SM: f32 = 72.0;

/// The colours a chip or a counter is drawn in.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ground {
    /// On the light background.
    Light,
    /// On the ink, or a photo's dark scrim.
    Dark,
}

pub(crate) struct Canvas<'a> {
    pub pixmap: Pixmap,
    fonts: &'a FontSet,
    job: &'a ComposeJob,
    limits: &'a Limits,
    brand: &'a BrandTokens,
    w: f32,
    h: f32,
}

impl<'a> Canvas<'a> {
    pub fn new(
        fonts: &'a FontSet,
        job: &'a ComposeJob,
        limits: &'a Limits,
    ) -> Result<Self, ComposeError> {
        let (w, h) = job.template.frame.size();
        let pixmap = Pixmap::new(w, h)
            .ok_or_else(|| ComposeError::Internal("cannot allocate the canvas".into()))?;
        Ok(Self {
            pixmap,
            fonts,
            job,
            limits,
            brand: &job.brand,
            w: w as f32,
            h: h as f32,
        })
    }

    fn text(&self, key: &str) -> Option<&'a str> {
        self.job
            .texts
            .get(key)
            .map(String::as_str)
            .filter(|t| !t.trim().is_empty())
    }

    fn family(&self, role: FontRole) -> jt_studio::compose::FontFamily {
        match role {
            FontRole::Heading => self.brand.heading_font,
            FontRole::Body => self.brand.body_font,
        }
    }

    /// The laid-out text of slot `key`, `None` when the slot is empty.
    fn block(&self, key: &str) -> Result<Option<Block>, ComposeError> {
        let spec = self
            .job
            .template
            .slot(key)
            .ok_or_else(|| ComposeError::Internal(format!("template has no slot {key}")))?;
        let Some(text) = self.text(key) else {
            return if spec.required {
                Err(ComposeError::MissingSlot { slot: key.into() })
            } else {
                Ok(None)
            };
        };
        let style = spec
            .style
            .ok_or_else(|| ComposeError::Internal(format!("slot {key} takes no text")))?;
        text::layout(
            self.fonts,
            self.family(style.font),
            &style,
            text,
            f32::from(spec.width.unwrap_or(952)),
            usize::from(spec.max_lines.unwrap_or(1)),
            spec,
        )
        .map(Some)
    }

    /// A text that is not a slot (the brand name, a counter, a step's digit) on one line. A
    /// character no bundled font draws is refused as the brand name's (`brand_set` refuses such a
    /// name; this catches one stored before that check).
    fn free(&self, style: TextStyle, text: &str) -> Result<Block, ComposeError> {
        let spec = jt_studio::compose::SlotSpec {
            key: "brand_name",
            kind: SlotKind::Text,
            required: false,
            max_chars: None,
            max_lines: Some(1),
            width: None,
            style: Some(style),
        };
        text::layout(
            self.fonts,
            self.family(style.font),
            &style,
            text,
            f32::MAX,
            1,
            &spec,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn draw(
        &mut self,
        block: &Block,
        x: f32,
        y: f32,
        width: f32,
        align: Align,
        c: Color,
        alpha: f32,
    ) {
        text::draw(
            &mut self.pixmap,
            self.fonts,
            block,
            x,
            y,
            width,
            align,
            &solid(c, alpha),
        );
    }

    fn fill(&mut self, c: Color) {
        self.pixmap.fill(raster::color(c, 1.0));
    }

    /// Draws photo slot `key` into a box. The source is decoded here and dropped after, so at
    /// most one decoded source is held at a time.
    fn photo(
        &mut self,
        key: &str,
        rect: (f32, f32, f32, f32),
        radius: f32,
    ) -> Result<(), ComposeError> {
        let source = self
            .job
            .photos
            .get(key)
            .ok_or_else(|| ComposeError::MissingSlot { slot: key.into() })?;
        let image = raster::decode(&source.bytes, &source.mime, key, self.limits)?;
        raster::draw_image(
            &mut self.pixmap,
            &image,
            rect,
            radius,
            source.focus,
            Fit::Cover,
        );
        Ok(())
    }

    /// Draws photo slot `key` on a dark rounded card (an item's), inset by `inset`.
    fn carded_photo(
        &mut self,
        key: &str,
        rect: (f32, f32, f32, f32),
        radius: f32,
        inset: f32,
    ) -> Result<(), ComposeError> {
        let (x, y, w, h) = rect;
        if let Some(path) = raster::rounded(x, y, w, h, [radius; 4]) {
            let top = mix(self.brand.ink, self.brand.background, 0.18);
            raster::two_color_gradient(&mut self.pixmap, &path, (y, top), (y + h, self.brand.ink));
        }
        self.photo(
            key,
            (x + inset, y + inset, w - 2.0 * inset, h - 2.0 * inset),
            (radius - inset * 0.6).max(8.0),
        )
    }

    /// The brand chip at `(x, y)`, `size` its mark's side: the logo (contain-fitted) or the
    /// brand name's first letter with an accent dot, then the brand name. Its width; 0 when the
    /// brand has neither name nor logo.
    fn chip(&mut self, x: f32, y: f32, size: f32, ground: Ground) -> Result<f32, ComposeError> {
        let name = self.brand.brand_name.clone();
        let logo = self.job.logo.as_ref();
        if name.is_empty() && logo.is_none() {
            return Ok(0.0);
        }
        let (mark_bg, mark_fg, name_fg) = match ground {
            Ground::Light => (self.brand.ink, self.brand.background, self.brand.ink),
            Ground::Dark => (self.brand.background, self.brand.ink, Color::WHITE),
        };
        let radius = size * 0.2;
        if let Some(logo) = logo {
            fill_rounded(
                &mut self.pixmap,
                x,
                y,
                size,
                size,
                [radius; 4],
                &solid(self.brand.background, 1.0),
            );
            let image = raster::decode(&logo.bytes, &logo.mime, "logo", self.limits)?;
            let pad = size * 0.1;
            raster::draw_image(
                &mut self.pixmap,
                &image,
                (x + pad, y + pad, size - 2.0 * pad, size - 2.0 * pad),
                radius * 0.6,
                (0.5, 0.5),
                Fit::Contain,
            );
        } else if let Some(first) = name.chars().next() {
            fill_rounded(
                &mut self.pixmap,
                x,
                y,
                size,
                size,
                [radius; 4],
                &solid(mark_bg, 1.0),
            );
            {
                let letter = self.free(TextStyle::heading(size * 0.66), &first.to_string())?;
                let ly = y + (size - letter.height()) / 2.0;
                self.draw(
                    &letter,
                    x - size * 0.04,
                    ly,
                    size,
                    Align::Center,
                    mark_fg,
                    1.0,
                );
            }
            let dot = (size * 0.14).round();
            let inset = size * 0.13;
            fill_rounded(
                &mut self.pixmap,
                x + size - inset - dot,
                y + size - inset - dot,
                dot,
                dot,
                [0.0; 4],
                &solid(self.brand.accent, 1.0),
            );
        }
        let mut width = size;
        if !name.is_empty() {
            let block = self.free(TextStyle::sub((size * 0.55).max(24.0)), &name)?;
            let ny = y + (size - block.height()) / 2.0;
            self.draw(
                &block,
                x + size + 14.0,
                ny,
                block.width(),
                Align::Left,
                name_fg,
                1.0,
            );
            width += 14.0 + block.width();
        }
        Ok(width)
    }

    /// The slide counter ("2/7") right-aligned at `right`, its box's top at `y`.
    fn counter(&mut self, right: f32, y: f32, ground: Ground) {
        let Some((index, total)) = self.job.counter else {
            return;
        };
        if let Ok(block) = self.free(TextStyle::body(24.0), &format!("{index}/{total}")) {
            let c = match ground {
                Ground::Light => self.brand.ink,
                Ground::Dark => Color::WHITE,
            };
            self.draw(&block, right - 200.0, y, 200.0, Align::Right, c, 0.75);
        }
    }

    /// The counter's line height, or 0 without a counter.
    fn counter_height(&self) -> f32 {
        if self.job.counter.is_some() {
            24.0 * TextStyle::body(24.0).line_height
        } else {
            0.0
        }
    }

    /// The header row of an inner slide: the brand chip left, the counter right.
    fn header(&mut self, y: f32, ground: Ground) -> Result<(), ComposeError> {
        self.chip(M, y, 48.0, ground)?;
        self.counter(self.w - M, y + 12.0, ground);
        Ok(())
    }

    /// The label chip of slot `label` at `(x, y)`: the accent pill with the text in ink. Its
    /// height, 0 without a label.
    fn label(&mut self, x: f32, y: f32) -> Result<f32, ComposeError> {
        let Some(block) = self.block("label")? else {
            return Ok(0.0);
        };
        let h = 52.0;
        let w = block.width() + 44.0;
        fill_rounded(
            &mut self.pixmap,
            x,
            y,
            w,
            h,
            [h / 2.0; 4],
            &solid(self.brand.accent, 1.0),
        );
        let ty = y + (h - block.height()) / 2.0;
        self.draw(
            &block,
            x + 22.0,
            ty,
            block.width(),
            Align::Left,
            self.brand.ink,
            1.0,
        );
        Ok(h)
    }

    fn accent_bar(&mut self, x: f32, y: f32) {
        fill_rounded(
            &mut self.pixmap,
            x,
            y,
            120.0,
            14.0,
            [7.0; 4],
            &solid(self.brand.accent, 1.0),
        );
    }

    /// A photo's dark scrim, in ink: `stops` are (offset, alpha), top to bottom.
    fn scrim(&mut self, y: f32, h: f32, stops: &[(f32, f32)]) {
        let w = self.w;
        vertical_gradient(&mut self.pixmap, (0.0, y, w, h), self.brand.ink, stops);
    }
}

/// `a` moved toward `b` by `t`.
fn mix(a: Color, b: Color, t: f32) -> Color {
    let m = |x: u8, y: u8| (f32::from(x) + (f32::from(y) - f32::from(x)) * t).round() as u8;
    Color(m(a.0, b.0), m(a.1, b.1), m(a.2, b.2))
}

fn h(block: &Option<Block>) -> f32 {
    block.as_ref().map_or(0.0, Block::height)
}

/// Lays out and draws the job's template. The empty sticker area, when the template has one.
pub(crate) fn compose(c: &mut Canvas<'_>) -> Result<Option<Rect>, ComposeError> {
    let t = &c.job.template;
    match (t.role, t.variant) {
        (Role::Cover, "full_bottom") => cover_full_bottom(c).map(|()| None),
        (Role::Cover, "full_top") => cover_full_top(c).map(|()| None),
        (Role::Cover, _) => cover_framed(c).map(|()| None),
        (Role::SecondCover, v) => second_cover(c, v == "pair_top").map(|()| None),
        (Role::Steps, v) => steps(c, v == "photo_top").map(|()| None),
        (Role::Closeup, v) => closeup(c, v == "card_bottom").map(|()| None),
        (Role::Items, "columns") => items_columns(c).map(|()| None),
        (Role::Items, _) => items_rows(c).map(|()| None),
        (Role::Cta, v) => cta(c, v == "photos_top").map(|()| None),
        (Role::Moment, v) => moment(c, v == "text_bottom").map(|()| None),
        (Role::Question, v) => question(c, v == "photo_top").map(Some),
        (Role::Item, v) => item(c, v == "card_bottom").map(Some),
    }
}

fn cover_full_bottom(c: &mut Canvas<'_>) -> Result<(), ComposeError> {
    let heading = c.block("heading")?;
    let line = c.block("line")?;
    let (w, hh) = (c.w, c.h);
    let ink = c.brand.ink;
    c.fill(ink);
    c.photo("photo", (0.0, 0.0, w, hh), 0.0)?;
    c.scrim(0.0, 260.0, &[(0.0, 0.65), (1.0, 0.0)]);
    c.scrim(hh - 760.0, 760.0, &[(0.0, 0.0), (0.45, 0.78), (1.0, 0.96)]);
    c.chip(M, 60.0, 56.0, Ground::Dark)?;
    let bottom = hh - 70.0;
    let row = h(&line).max(c.counter_height());
    let row_top = bottom - row;
    if let Some(line) = &line {
        let bg = c.brand.background;
        c.draw(line, M, row_top, 820.0, Align::Left, bg, 0.92);
    }
    c.counter(w - M, bottom - c.counter_height(), Ground::Dark);
    let heading = heading.ok_or(ComposeError::MissingSlot {
        slot: "heading".into(),
    })?;
    let heading_top = row_top - if row > 0.0 { 26.0 } else { 0.0 } - heading.height();
    c.draw(
        &heading,
        M,
        heading_top,
        952.0,
        Align::Left,
        Color::WHITE,
        1.0,
    );
    c.accent_bar(M, heading_top - 30.0 - 14.0);
    Ok(())
}

fn cover_full_top(c: &mut Canvas<'_>) -> Result<(), ComposeError> {
    let heading = c.block("heading")?;
    let line = c.block("line")?;
    let (w, hh) = (c.w, c.h);
    let ink = c.brand.ink;
    c.fill(ink);
    c.photo("photo", (0.0, 0.0, w, hh), 0.0)?;
    c.scrim(0.0, 860.0, &[(0.0, 0.96), (0.5, 0.8), (1.0, 0.0)]);
    c.scrim(hh - 220.0, 220.0, &[(0.0, 0.0), (1.0, 0.55)]);
    c.chip(M, 60.0, 56.0, Ground::Dark)?;
    let mut y = 176.0;
    c.accent_bar(M, y);
    y += 14.0 + 30.0;
    if let Some(heading) = &heading {
        c.draw(heading, M, y, 952.0, Align::Left, Color::WHITE, 1.0);
        y += heading.height() + 26.0;
    }
    if let Some(line) = &line {
        let bg = c.brand.background;
        c.draw(line, M, y, 952.0, Align::Left, bg, 0.92);
    }
    c.counter(w - M, hh - 70.0 - c.counter_height(), Ground::Dark);
    Ok(())
}

fn cover_framed(c: &mut Canvas<'_>) -> Result<(), ComposeError> {
    let heading = c.block("heading")?;
    let line = c.block("line")?;
    let ink = c.brand.ink;
    c.fill(ink);
    c.header(M, Ground::Dark)?;
    c.photo("photo", (M, 148.0, 952.0, 720.0), 32.0)?;
    let mut y = 912.0;
    c.accent_bar(M, y);
    y += 14.0 + 30.0;
    if let Some(heading) = &heading {
        c.draw(heading, M, y, 952.0, Align::Left, Color::WHITE, 1.0);
        y += heading.height() + 22.0;
    }
    if let Some(line) = &line {
        let bg = c.brand.background;
        c.draw(line, M, y, 820.0, Align::Left, bg, 0.85);
    }
    Ok(())
}

fn second_cover(c: &mut Canvas<'_>, photos_top: bool) -> Result<(), ComposeError> {
    let heading = c.block("heading")?;
    let line = c.block("line")?;
    let bg = c.brand.background;
    c.fill(bg);
    c.header(M, Ground::Light)?;
    let text_h = h(&heading) + if line.is_some() { 20.0 + h(&line) } else { 0.0 };
    let bottom = c.h - M;
    let draw_text = |c: &mut Canvas<'_>, mut y: f32| {
        let (ink, muted) = (c.brand.ink, c.brand.muted);
        if let Some(heading) = &heading {
            c.draw(heading, M, y, 952.0, Align::Left, ink, 1.0);
            y += heading.height() + 20.0;
        }
        if let Some(line) = &line {
            c.draw(line, M, y, 952.0, Align::Left, muted, 1.0);
        }
    };
    if photos_top {
        c.photo("photo_1", (M, 156.0, 466.0, 720.0), 32.0)?;
        c.photo("photo_2", (550.0, 156.0, 466.0, 720.0), 32.0)?;
        let zone = (876.0, bottom);
        draw_text(c, zone.0 + (zone.1 - zone.0 - text_h) / 2.0);
    } else {
        draw_text(c, 172.0);
        let top = (172.0 + text_h + 56.0).max(470.0);
        c.photo("photo_1", (M, top, 466.0, bottom - top), 32.0)?;
        c.photo(
            "photo_2",
            (550.0, top + 64.0, 466.0, bottom - top - 64.0),
            32.0,
        )?;
    }
    Ok(())
}

fn step_blocks(c: &Canvas<'_>) -> Result<Vec<Block>, ComposeError> {
    let mut out = Vec::new();
    for key in ["step_1", "step_2", "step_3"] {
        if let Some(b) = c.block(key)? {
            out.push(b);
        }
    }
    Ok(out)
}

fn draw_steps(c: &mut Canvas<'_>, steps: &[Block], mut y: f32) -> f32 {
    let (ink, accent) = (c.brand.ink, c.brand.accent);
    for (n, step) in steps.iter().enumerate() {
        fill_rounded(&mut c.pixmap, M, y, 72.0, 72.0, [36.0; 4], &solid(ink, 1.0));
        if let Ok(digit) = c.free(TextStyle::heading(38.0), &(n + 1).to_string()) {
            c.draw(
                &digit,
                M,
                y + (72.0 - digit.height()) / 2.0,
                72.0,
                Align::Center,
                accent,
                1.0,
            );
        }
        c.draw(
            step,
            M + 98.0,
            y + (72.0 - step.height()) / 2.0,
            854.0,
            Align::Left,
            ink,
            1.0,
        );
        y += 72.0 + 20.0;
    }
    y - 20.0
}

fn steps(c: &mut Canvas<'_>, photo_top: bool) -> Result<(), ComposeError> {
    let heading = c.block("heading")?;
    let steps = step_blocks(c)?;
    let bg = c.brand.background;
    let ink = c.brand.ink;
    c.fill(bg);
    c.header(M, Ground::Light)?;
    if photo_top {
        c.photo("photo", (M, 156.0, 952.0, 620.0), 32.0)?;
        let mut y = 820.0;
        if let Some(heading) = &heading {
            c.draw(heading, M, y, 952.0, Align::Left, ink, 1.0);
            y += heading.height() + 36.0;
        }
        draw_steps(c, &steps, y);
    } else {
        let mut y = 172.0;
        if let Some(heading) = &heading {
            c.draw(heading, M, y, 952.0, Align::Left, ink, 1.0);
            y += heading.height() + 36.0;
        }
        let end = draw_steps(c, &steps, y);
        let top = end + 48.0;
        c.photo("photo", (M, top, 952.0, c.h - M - top), 32.0)?;
    }
    Ok(())
}

fn closeup(c: &mut Canvas<'_>, card_bottom: bool) -> Result<(), ComposeError> {
    let heading = c.block("heading")?;
    let line = c.block("line")?;
    let has_label = c.text("label").is_some();
    let (w, hh) = (c.w, c.h);
    let (ink, bg, muted) = (c.brand.ink, c.brand.background, c.brand.muted);
    c.fill(ink);
    c.photo("photo", (0.0, 0.0, w, hh), 0.0)?;
    let (pad_x, pad_y) = (52.0, 48.0);
    let inner = 952.0 - 2.0 * pad_x;
    let has_chip = !c.brand.brand_name.is_empty() || c.job.logo.is_some();
    let row = if card_bottom {
        if has_label { 52.0 } else { c.counter_height() }
    } else if has_chip {
        48.0
    } else {
        c.counter_height()
    };
    let top_label = if !card_bottom && has_label {
        52.0 + 24.0
    } else {
        0.0
    };
    let content = row
        + if row > 0.0 { 24.0 } else { 0.0 }
        + top_label
        + h(&heading)
        + if line.is_some() { 18.0 + h(&line) } else { 0.0 };
    let card_h = content + 2.0 * pad_y;
    let card_y = if card_bottom { hh - M - card_h } else { M };
    if card_bottom && has_chip {
        // The chip on a light pill over the photo.
        let pill_w = c.chip_width(48.0)? + 30.0;
        fill_rounded(
            &mut c.pixmap,
            M,
            60.0,
            pill_w,
            68.0,
            [18.0; 4],
            &solid(bg, 1.0),
        );
        c.chip(M + 10.0, 70.0, 48.0, Ground::Light)?;
    }
    fill_rounded(
        &mut c.pixmap,
        M,
        card_y,
        952.0,
        card_h,
        [32.0; 4],
        &solid(bg, 1.0),
    );
    let x = M + pad_x;
    let mut y = card_y + pad_y;
    if card_bottom {
        c.label(x, y)?;
        c.counter(
            x + inner,
            y + (row - c.counter_height()) / 2.0,
            Ground::Light,
        );
    } else {
        c.chip(x, y, 48.0, Ground::Light)?;
        c.counter(
            x + inner,
            y + (row - c.counter_height()) / 2.0,
            Ground::Light,
        );
    }
    if row > 0.0 {
        y += row + 24.0;
    }
    if !card_bottom && has_label {
        c.label(x, y)?;
        y += 52.0 + 24.0;
    }
    if let Some(heading) = &heading {
        c.draw(heading, x, y, inner, Align::Left, ink, 1.0);
        y += heading.height() + 18.0;
    }
    if let Some(line) = &line {
        c.draw(line, x, y, inner, Align::Left, muted, 1.0);
    }
    Ok(())
}

impl Canvas<'_> {
    /// The brand chip's width at `size`, without drawing it.
    fn chip_width(&self, size: f32) -> Result<f32, ComposeError> {
        let name = &self.brand.brand_name;
        if name.is_empty() {
            return Ok(if self.job.logo.is_some() { size } else { 0.0 });
        }
        Ok(size
            + 14.0
            + self
                .free(TextStyle::sub((size * 0.55).max(24.0)), name)?
                .width())
    }
}

/// An item's name, line and price, laid out.
struct ItemText {
    name: Option<Block>,
    line: Option<Block>,
    price: Option<Block>,
}

fn item_text(c: &Canvas<'_>, n: u8) -> Result<ItemText, ComposeError> {
    Ok(ItemText {
        name: c.block(&format!("name_{n}"))?,
        line: c.block(&format!("line_{n}"))?,
        price: c.block(&format!("price_{n}"))?,
    })
}

fn items_columns(c: &mut Canvas<'_>) -> Result<(), ComposeError> {
    let heading = c.block("heading")?;
    let note = c.block("note")?;
    let items = [item_text(c, 1)?, item_text(c, 2)?];
    let (bg, ink, muted) = (c.brand.background, c.brand.ink, c.brand.muted);
    c.fill(bg);
    c.header(M, Ground::Light)?;
    let mut y = 156.0;
    if let Some(heading) = &heading {
        c.draw(heading, M, y, 952.0, Align::Left, ink, 1.0);
        y += heading.height() + 44.0;
    }
    let name_h = items.iter().map(|i| h(&i.name)).fold(0.0, f32::max);
    let line_h = items.iter().map(|i| h(&i.line)).fold(0.0, f32::max);
    let price_h = items.iter().map(|i| h(&i.price)).fold(0.0, f32::max);
    let below = 26.0
        + name_h
        + if line_h > 0.0 { 6.0 + line_h } else { 0.0 }
        + if price_h > 0.0 { 14.0 + price_h } else { 0.0 };
    let note_h = if note.is_some() { 44.0 + h(&note) } else { 0.0 };
    let card_h = (c.h - M - y - below - note_h).min(600.0);
    for (n, (x, item)) in [M, 556.0].into_iter().zip(&items).enumerate() {
        c.carded_photo(
            &format!("photo_{}", n + 1),
            (x, y, 460.0, card_h),
            28.0,
            16.0,
        )?;
        let mut ty = y + card_h + 26.0;
        if let Some(name) = &item.name {
            c.draw(name, x, ty, 460.0, Align::Left, ink, 1.0);
        }
        ty += name_h;
        if let Some(line) = &item.line {
            c.draw(line, x, ty + 6.0, 460.0, Align::Left, muted, 1.0);
        }
        if line_h > 0.0 {
            ty += 6.0 + line_h;
        }
        if let Some(price) = &item.price {
            c.draw(price, x, ty + 14.0, 460.0, Align::Left, ink, 1.0);
        }
    }
    if let Some(note) = &note {
        let ny = y + card_h + below + 44.0;
        c.draw(note, M, ny, 952.0, Align::Left, muted, 1.0);
    }
    Ok(())
}

fn items_rows(c: &mut Canvas<'_>) -> Result<(), ComposeError> {
    let heading = c.block("heading")?;
    let note = c.block("note")?;
    let items = [item_text(c, 1)?, item_text(c, 2)?];
    let (bg, ink, muted) = (c.brand.background, c.brand.ink, c.brand.muted);
    c.fill(bg);
    c.header(M, Ground::Light)?;
    let mut y = 156.0;
    if let Some(heading) = &heading {
        c.draw(heading, M, y, 952.0, Align::Left, ink, 1.0);
        y += heading.height() + 44.0;
    }
    let note_h = if note.is_some() { 40.0 + h(&note) } else { 0.0 };
    let row = ((c.h - M - y - note_h - 36.0) / 2.0).min(400.0);
    for (n, item) in items.iter().enumerate() {
        c.carded_photo(&format!("photo_{}", n + 1), (M, y, row, row), 28.0, 14.0)?;
        let x = M + row + 40.0;
        let text_h = h(&item.name)
            + if item.line.is_some() {
                8.0 + h(&item.line)
            } else {
                0.0
            }
            + if item.price.is_some() {
                14.0 + h(&item.price)
            } else {
                0.0
            };
        let mut ty = y + (row - text_h) / 2.0;
        if let Some(name) = &item.name {
            c.draw(name, x, ty, 512.0, Align::Left, ink, 1.0);
            ty += name.height();
        }
        if let Some(line) = &item.line {
            c.draw(line, x, ty + 8.0, 512.0, Align::Left, muted, 1.0);
            ty += 8.0 + line.height();
        }
        if let Some(price) = &item.price {
            c.draw(price, x, ty + 14.0, 512.0, Align::Left, ink, 1.0);
        }
        y += row + 36.0;
    }
    if let Some(note) = &note {
        c.draw(note, M, y + 4.0, 952.0, Align::Left, muted, 1.0);
    }
    Ok(())
}

fn cta(c: &mut Canvas<'_>, photos_top: bool) -> Result<(), ComposeError> {
    let heading = c.block("heading")?;
    let line = c.block("line")?;
    let site = c.block("site")?;
    let slogan = c.block("slogan")?;
    let (ink, bg, accent) = (c.brand.ink, c.brand.background, c.brand.accent);
    let (w, hh) = (c.w, c.h);
    c.fill(ink);
    c.header(M, Ground::Dark)?;
    let footer_h = h(&site).max(h(&slogan));
    let mut zone_bottom = hh - M;
    if footer_h > 0.0 {
        let footer_y = hh - M - footer_h;
        if let Some(site) = &site {
            c.draw(site, M, footer_y, 520.0, Align::Left, Color::WHITE, 1.0);
        }
        if let Some(slogan) = &slogan {
            c.draw(
                slogan,
                w - M - 420.0,
                footer_y,
                420.0,
                Align::Right,
                accent,
                1.0,
            );
        }
        let rule_y = footer_y - 36.0;
        fill_rounded(
            &mut c.pixmap,
            M,
            rule_y,
            952.0,
            2.0,
            [0.0; 4],
            &solid(mix(ink, bg, 0.2), 1.0),
        );
        zone_bottom = rule_y - 40.0;
    }
    let text_h = h(&heading) + if line.is_some() { 30.0 + h(&line) } else { 0.0 };
    if photos_top {
        let block = 250.0 + 56.0 + text_h;
        let mut y = 156.0 + ((zone_bottom - 156.0) - block) / 2.0;
        c.photo("photo_1", (M, y, 250.0, 250.0), 28.0)?;
        c.photo("photo_2", (M + 274.0, y, 250.0, 250.0), 28.0)?;
        y += 250.0 + 56.0;
        if let Some(heading) = &heading {
            c.draw(heading, M, y, 952.0, Align::Left, Color::WHITE, 1.0);
            y += heading.height() + 30.0;
        }
        if let Some(line) = &line {
            c.draw(line, M, y, 952.0, Align::Left, bg, 0.85);
        }
    } else {
        let mut y = 172.0;
        if let Some(heading) = &heading {
            c.draw(heading, M, y, 952.0, Align::Left, Color::WHITE, 1.0);
            y += heading.height() + 30.0;
        }
        if let Some(line) = &line {
            c.draw(line, M, y, 952.0, Align::Left, bg, 0.85);
            y += line.height();
        }
        let top = y + 48.0;
        let ph = zone_bottom - top;
        c.photo("photo_1", (M, top, 466.0, ph), 32.0)?;
        c.photo("photo_2", (550.0, top, 466.0, ph), 32.0)?;
    }
    Ok(())
}

/// A story's label, heading and line, stacked; their total height.
fn story_text_height(c: &Canvas<'_>, heading: &Option<Block>, line: &Option<Block>) -> f32 {
    let label = if c.text("label").is_some() {
        52.0 + 26.0
    } else {
        0.0
    };
    label + h(heading) + if line.is_some() { 22.0 + h(line) } else { 0.0 }
}

fn moment(c: &mut Canvas<'_>, text_bottom: bool) -> Result<(), ComposeError> {
    let heading = c.block("heading")?;
    let line = c.block("line")?;
    let (w, hh) = (c.w, c.h);
    let (ink, bg) = (c.brand.ink, c.brand.background);
    let band = c.job.template.frame.text_free_band() as f32;
    c.fill(ink);
    c.photo("photo", (0.0, 0.0, w, hh), 0.0)?;
    let text_h = story_text_height(c, &heading, &line);
    let mut y = if text_bottom {
        c.scrim(hh - 1000.0, 1000.0, &[(0.0, 0.0), (0.4, 0.82), (1.0, 0.97)]);
        hh - band - text_h
    } else {
        c.scrim(0.0, 1000.0, &[(0.0, 0.97), (0.6, 0.82), (1.0, 0.0)]);
        band
    };
    let label = c.label(SM, y)?;
    if label > 0.0 {
        y += label + 26.0;
    }
    if let Some(heading) = &heading {
        c.draw(heading, SM, y, 936.0, Align::Left, Color::WHITE, 1.0);
        y += heading.height() + 22.0;
    }
    if let Some(line) = &line {
        c.draw(line, SM, y, 936.0, Align::Left, bg, 0.9);
    }
    Ok(())
}

fn question(c: &mut Canvas<'_>, photo_top: bool) -> Result<Rect, ComposeError> {
    let heading = c.block("heading")?;
    let (w, hh) = (c.w, c.h);
    let (ink, bg) = (c.brand.ink, c.brand.background);
    let band = c.job.template.frame.text_free_band() as f32;
    let (text_c, mut y, sticker_y) = if photo_top {
        c.fill(bg);
        c.photo("photo", (56.0, 120.0, 968.0, 880.0), 40.0)?;
        (ink, 1050.0, 1400.0)
    } else {
        c.fill(ink);
        c.photo("photo", (0.0, 0.0, w, hh), 0.0)?;
        c.scrim(0.0, 1000.0, &[(0.0, 0.97), (0.6, 0.8), (1.0, 0.0)]);
        (Color::WHITE, band, 1220.0)
    };
    let label = c.label(SM, y)?;
    if label > 0.0 {
        y += label + 22.0;
    }
    if let Some(heading) = &heading {
        c.draw(heading, SM, y, 936.0, Align::Left, text_c, 1.0);
    }
    Ok(Rect {
        x: 150,
        y: sticker_y as u32,
        width: 780,
        height: 250,
    })
}

fn item(c: &mut Canvas<'_>, card_bottom: bool) -> Result<Rect, ComposeError> {
    let name = c.block("name")?;
    let line = c.block("line")?;
    let price = c.block("price")?;
    let (w, hh) = (c.w, c.h);
    let (ink, bg, muted) = (c.brand.ink, c.brand.background, c.brand.muted);
    let (name_c, line_c, line_a) = if card_bottom {
        c.fill(bg);
        c.photo("photo", (0.0, 0.0, w, 1280.0), 0.0)?;
        fill_rounded(
            &mut c.pixmap,
            0.0,
            1220.0,
            w,
            hh - 1220.0,
            [48.0, 48.0, 0.0, 0.0],
            &solid(bg, 1.0),
        );
        (ink, muted, 1.0)
    } else {
        c.fill(ink);
        c.photo("photo", (56.0, 180.0, 968.0, 900.0), 40.0)?;
        (Color::WHITE, bg, 0.85)
    };
    let mut y = if card_bottom { 1280.0 } else { 1130.0 };
    // The label pill and the brand chip share one row: refused when they would meet.
    let label_w = c.block("label")?.map_or(0.0, |b| b.width() + 44.0);
    let chip_w = c.chip_width(44.0)?;
    if label_w > 0.0 && chip_w > 0.0 && label_w + 24.0 + chip_w > w - 2.0 * SM {
        return Err(ComposeError::Collision {
            slot: "label".into(),
            with: "brand chip".into(),
        });
    }
    let label = c.label(SM, y)?;
    if chip_w > 0.0 {
        let ground = if card_bottom {
            Ground::Light
        } else {
            Ground::Dark
        };
        c.chip(w - SM - chip_w, y + 4.0, 44.0, ground)?;
    }
    if label > 0.0 || chip_w > 0.0 {
        y += 52.0 + 22.0;
    }
    if let Some(name) = &name {
        c.draw(name, SM, y, 936.0, Align::Left, name_c, 1.0);
        y += name.height() + 10.0;
    }
    if let Some(line) = &line {
        c.draw(line, SM, y, 936.0, Align::Left, line_c, line_a);
        y += line.height() + 22.0;
    }
    let price_h = h(&price);
    if let Some(price) = &price {
        c.draw(price, SM, y, 500.0, Align::Left, name_c, 1.0);
    }
    Ok(if card_bottom {
        Rect {
            x: (w - SM - 400.0) as u32,
            y: (y + (price_h - 96.0) / 2.0).max(0.0) as u32,
            width: 400,
            height: 96,
        }
    } else {
        Rect {
            x: SM as u32,
            y: (y + price_h + 30.0) as u32,
            width: 600,
            height: 110,
        }
    })
}
