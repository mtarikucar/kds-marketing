//! Server-composed posts: the fixed templates a carousel slide or a story frame is laid out by,
//! the text each of their slots takes, and a workspace's brand tokens (its colours, its two fonts,
//! its name and logo). Pure data and rules; drawing is an adapter's (`jt_render`).
//!
//! Every template draws text exactly as given (no casing, no shortening): a text longer than its
//! slot takes is refused, naming the slot and its limits, so the caller shortens it.
use crate::MaterialId;
use serde::{Deserialize, Serialize};

/// The smallest text any template draws, in pixels. WCAG 2.x counts text of 24 px (18 pt) and
/// up as large text, so 3:1 is the AA contrast every pair of brand colours must reach.
pub const MIN_TEXT_PX: f32 = 24.0;
/// The contrast WCAG AA asks of large text.
pub const AA_LARGE: f64 = 3.0;
/// The longest brand name, in characters.
pub const MAX_BRAND_NAME_CHARS: usize = 32;
/// The renderer's name, recorded in each composition.
pub const RENDERER: &str = "jeeta-compose";
/// The generator a composition with an AI source is recorded with (an AI flag carries one).
pub const COMPOSED_AI_GENERATOR: &str = "jeeta-compose";

/// The frame a template fills: a carousel slide (1080 x 1350) or a story frame (1080 x 1920).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Frame {
    Slide,
    Story,
}

impl Frame {
    /// Width and height in pixels.
    pub fn size(self) -> (u32, u32) {
        match self {
            Self::Slide => (1080, 1350),
            Self::Story => (1080, 1920),
        }
    }

    /// Rows at the top and bottom that hold no text (a story's platform chrome covers them).
    pub fn text_free_band(self) -> u32 {
        match self {
            Self::Slide => 0,
            Self::Story => 250,
        }
    }
}

/// What a template is for in a post.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Cover,
    SecondCover,
    Steps,
    Closeup,
    Items,
    Cta,
    Moment,
    Question,
    Item,
}

impl Role {
    pub const ALL: [Role; 9] = [
        Self::Cover,
        Self::SecondCover,
        Self::Steps,
        Self::Closeup,
        Self::Items,
        Self::Cta,
        Self::Moment,
        Self::Question,
        Self::Item,
    ];

    pub fn key(self) -> &'static str {
        match self {
            Self::Cover => "cover",
            Self::SecondCover => "second_cover",
            Self::Steps => "steps",
            Self::Closeup => "closeup",
            Self::Items => "items",
            Self::Cta => "cta",
            Self::Moment => "moment",
            Self::Question => "question",
            Self::Item => "item",
        }
    }

    pub fn parse(key: &str) -> Option<Role> {
        Self::ALL.into_iter().find(|r| r.key() == key)
    }

    pub fn frame(self) -> Frame {
        match self {
            Self::Moment | Self::Question | Self::Item => Frame::Story,
            _ => Frame::Slide,
        }
    }

    /// Its layout variants, each a clearly different composition in the same family.
    pub fn variants(self) -> &'static [(&'static str, &'static str)] {
        match self {
            Self::Cover => &[
                (
                    "full_bottom",
                    "Full-bleed photo, dark scrim rising from the bottom, accent bar, large heading bottom-left.",
                ),
                (
                    "full_top",
                    "Full-bleed photo, dark scrim falling from the top, heading top-left under the brand chip.",
                ),
                (
                    "framed_dark",
                    "Dark slide, photo framed with rounded corners above, heading below it.",
                ),
            ],
            Self::SecondCover => &[
                (
                    "pair_top",
                    "Two tall photos side by side on top, heading and line below.",
                ),
                (
                    "pair_bottom",
                    "Heading and line on top, two photos side by side below.",
                ),
            ],
            Self::Steps => &[
                (
                    "photo_top",
                    "Photo on top, heading, then up to three numbered lines.",
                ),
                (
                    "photo_bottom",
                    "Heading and numbered lines on top, photo filling the rest below.",
                ),
            ],
            Self::Closeup => &[
                (
                    "card_bottom",
                    "Full-bleed photo with a light card at the bottom.",
                ),
                (
                    "card_top",
                    "Full-bleed photo with a light card at the top holding the brand chip.",
                ),
            ],
            Self::Items => &[
                (
                    "columns",
                    "Two photos on dark cards side by side, each with name, line and price.",
                ),
                (
                    "rows",
                    "Two rows, a photo on a dark card left and name, line and price right.",
                ),
            ],
            Self::Cta => &[
                (
                    "photos_top",
                    "Dark slide, two small photos, large heading, line, footer with site and slogan.",
                ),
                (
                    "photos_bottom",
                    "Dark slide, large heading on top, two larger photos below, footer.",
                ),
            ],
            Self::Moment => &[
                (
                    "text_bottom",
                    "Full-bleed photo, label, heading and line at the bottom of the safe zone.",
                ),
                (
                    "text_top",
                    "Full-bleed photo, label, heading and line at the top of the safe zone.",
                ),
            ],
            Self::Question => &[
                (
                    "photo_top",
                    "Light frame, rounded photo on top, heading, empty area for the poll sticker.",
                ),
                (
                    "photo_full",
                    "Full-bleed photo, heading at the top, empty area for the poll sticker.",
                ),
            ],
            Self::Item => &[
                (
                    "card_bottom",
                    "Photo on top, light card below with name, line, price and an empty link sticker area.",
                ),
                (
                    "framed_dark",
                    "Dark frame, rounded photo, name, line, price and an empty link sticker area.",
                ),
            ],
        }
    }
}

/// Which of the workspace's two fonts a text uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FontRole {
    Heading,
    Body,
}

/// How a slot's text is set: its font and weight, size, line height (a multiple of the size) and
/// tracking (letter spacing, a multiple of the size).
#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct TextStyle {
    pub font: FontRole,
    pub weight: u16,
    pub size: f32,
    pub line_height: f32,
    pub tracking: f32,
}

impl TextStyle {
    /// A heading: the heading font, extra bold, tight.
    pub const fn heading(size: f32) -> Self {
        Self {
            font: FontRole::Heading,
            weight: 800,
            size,
            line_height: 1.04,
            tracking: -0.014,
        }
    }
    /// A short emphasised line (a step, an item's name, the footer): the heading font, semibold.
    pub const fn sub(size: f32) -> Self {
        Self {
            font: FontRole::Heading,
            weight: 600,
            size,
            line_height: 1.18,
            tracking: -0.012,
        }
    }
    /// Running text: the body font, medium.
    pub const fn body(size: f32) -> Self {
        Self {
            font: FontRole::Body,
            weight: 500,
            size,
            line_height: 1.28,
            tracking: 0.0,
        }
    }
    /// A label chip's text: the body font, bold, spaced.
    pub const fn label() -> Self {
        Self {
            font: FontRole::Body,
            weight: 700,
            size: 24.0,
            line_height: 1.0,
            tracking: 0.08,
        }
    }
    /// A price: the heading font (which carries ₺), extra bold.
    pub const fn price(size: f32) -> Self {
        Self {
            font: FontRole::Heading,
            weight: 800,
            size,
            line_height: 1.0,
            tracking: -0.012,
        }
    }
}

/// What a slot takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SlotKind {
    /// A material id (a JPEG, PNG or WebP image).
    Photo,
    /// A short text.
    Text,
    /// A price text, e.g. "₺1.490".
    Price,
}

/// One slot of a template. A text slot's text is wrapped by words into at most `max_lines` lines
/// of `width` pixels; it is refused when longer than `max_chars` characters or when it does not
/// fit those lines.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SlotSpec {
    pub key: &'static str,
    pub kind: SlotKind,
    pub required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_chars: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_lines: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<TextStyle>,
}

impl SlotSpec {
    const fn photo(key: &'static str, required: bool) -> Self {
        Self {
            key,
            kind: SlotKind::Photo,
            required,
            max_chars: None,
            max_lines: None,
            width: None,
            style: None,
        }
    }
    const fn text(
        key: &'static str,
        required: bool,
        max_chars: u16,
        max_lines: u8,
        width: u16,
        style: TextStyle,
    ) -> Self {
        Self {
            key,
            kind: SlotKind::Text,
            required,
            max_chars: Some(max_chars),
            max_lines: Some(max_lines),
            width: Some(width),
            style: Some(style),
        }
    }
    const fn price(key: &'static str, required: bool, width: u16, size: f32) -> Self {
        Self {
            key,
            kind: SlotKind::Price,
            required,
            max_chars: Some(16),
            max_lines: Some(1),
            width: Some(width),
            style: Some(TextStyle::price(size)),
        }
    }
}

/// A template: a role, one of its variants, its frame and its slots.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Template {
    pub role: Role,
    pub variant: &'static str,
    pub frame: Frame,
    pub description: &'static str,
    pub slots: Vec<SlotSpec>,
}

impl Template {
    pub fn slot(&self, key: &str) -> Option<&SlotSpec> {
        self.slots.iter().find(|s| s.key == key)
    }
}

/// The slide's full text width: 1080 less two 64 px margins.
const SLIDE_W: u16 = 952;
/// The story's text width: 1080 less two 72 px margins.
const STORY_W: u16 = 936;

fn slots(role: Role, variant: &str) -> Option<Vec<SlotSpec>> {
    use SlotSpec as S;
    use TextStyle as T;
    let label = S::text("label", false, 22, 1, 600, T::label());
    Some(match (role, variant) {
        (Role::Cover, "full_bottom") => vec![
            S::photo("photo", true),
            S::text("heading", true, 48, 3, SLIDE_W, T::heading(104.0)),
            S::text("line", false, 70, 2, 820, T::body(34.0)),
        ],
        (Role::Cover, "full_top") => vec![
            S::photo("photo", true),
            S::text("heading", true, 48, 3, SLIDE_W, T::heading(100.0)),
            S::text("line", false, 70, 2, SLIDE_W, T::body(34.0)),
        ],
        (Role::Cover, "framed_dark") => vec![
            S::photo("photo", true),
            S::text("heading", true, 40, 2, SLIDE_W, T::heading(88.0)),
            S::text("line", false, 70, 2, 820, T::body(32.0)),
        ],
        (Role::SecondCover, "pair_top" | "pair_bottom") => vec![
            S::photo("photo_1", true),
            S::photo("photo_2", true),
            S::text(
                "heading",
                true,
                if variant == "pair_top" { 60 } else { 44 },
                if variant == "pair_top" { 3 } else { 2 },
                SLIDE_W,
                T::heading(76.0),
            ),
            S::text("line", false, 80, 2, SLIDE_W, T::body(32.0)),
        ],
        (Role::Steps, "photo_top" | "photo_bottom") => vec![
            S::photo("photo", true),
            S::text("heading", true, 50, 2, SLIDE_W, T::heading(68.0)),
            S::text("step_1", true, 36, 1, 854, T::sub(40.0)),
            S::text("step_2", false, 36, 1, 854, T::sub(40.0)),
            S::text("step_3", false, 36, 1, 854, T::sub(40.0)),
        ],
        (Role::Closeup, "card_bottom" | "card_top") => vec![
            S::photo("photo", true),
            label,
            S::text("heading", true, 50, 2, 848, T::heading(72.0)),
            S::text("line", false, 80, 2, 848, T::body(32.0)),
        ],
        (Role::Items, "columns") => vec![
            S::text("heading", false, 50, 2, SLIDE_W, T::heading(72.0)),
            S::photo("photo_1", true),
            S::text("name_1", true, 22, 1, 460, T::sub(40.0)),
            S::text("line_1", false, 60, 2, 460, T::body(26.0)),
            S::price("price_1", false, 460, 64.0),
            S::photo("photo_2", true),
            S::text("name_2", true, 22, 1, 460, T::sub(40.0)),
            S::text("line_2", false, 60, 2, 460, T::body(26.0)),
            S::price("price_2", false, 460, 64.0),
            S::text("note", false, 70, 1, SLIDE_W, T::body(28.0)),
        ],
        (Role::Items, "rows") => vec![
            S::text("heading", false, 50, 2, SLIDE_W, T::heading(72.0)),
            S::photo("photo_1", true),
            S::text("name_1", true, 40, 2, 512, T::sub(40.0)),
            S::text("line_1", false, 80, 2, 512, T::body(28.0)),
            S::price("price_1", false, 512, 64.0),
            S::photo("photo_2", true),
            S::text("name_2", true, 40, 2, 512, T::sub(40.0)),
            S::text("line_2", false, 80, 2, 512, T::body(28.0)),
            S::price("price_2", false, 512, 64.0),
            S::text("note", false, 70, 1, SLIDE_W, T::body(28.0)),
        ],
        (Role::Cta, "photos_top" | "photos_bottom") => vec![
            S::photo("photo_1", true),
            S::photo("photo_2", true),
            S::text("heading", true, 44, 3, SLIDE_W, T::heading(108.0)),
            S::text("line", false, 80, 2, SLIDE_W, T::body(36.0)),
            S::text("site", false, 28, 1, 520, T::sub(36.0)),
            S::text("slogan", false, 24, 1, 420, T::sub(36.0)),
        ],
        (Role::Moment, "text_bottom" | "text_top") => vec![
            S::photo("photo", true),
            label,
            S::text("heading", true, 44, 3, STORY_W, T::heading(96.0)),
            S::text("line", false, 80, 2, STORY_W, T::body(36.0)),
        ],
        (Role::Question, "photo_top" | "photo_full") => vec![
            S::photo("photo", true),
            label,
            S::text("heading", true, 56, 3, STORY_W, T::heading(84.0)),
        ],
        (Role::Item, "card_bottom" | "framed_dark") => vec![
            S::photo("photo", true),
            label,
            S::text("name", true, 22, 1, STORY_W, T::heading(96.0)),
            S::text("line", false, 50, 1, STORY_W, T::body(34.0)),
            S::price("price", true, 500, 80.0),
        ],
        _ => return None,
    })
}

/// The template of `role` in `variant`, when it has one.
pub fn template(role: Role, variant: &str) -> Option<Template> {
    let (name, description) = role
        .variants()
        .iter()
        .find(|(name, _)| *name == variant)
        .copied()?;
    Some(Template {
        role,
        variant: name,
        frame: role.frame(),
        description,
        slots: slots(role, name)?,
    })
}

/// Every template, role by role, variants in order.
pub fn templates() -> Vec<Template> {
    Role::ALL
        .into_iter()
        .flat_map(|role| {
            role.variants()
                .iter()
                .filter_map(move |(name, _)| template(role, name))
        })
        .collect()
}

/// Why a slot's text is refused before anything is drawn.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum TextRefusal {
    /// Over the slot's `max_chars`.
    TooLong,
    /// A control character other than a line feed.
    ControlCharacter,
    /// Empty (or only spaces) where the slot needs text.
    Empty,
}

/// Whether `text` may go in `slot` before it is measured: its length and its characters. Line
/// feeds are kept as line breaks; nothing is changed in the text.
pub fn check_text(slot: &SlotSpec, text: &str) -> Result<(), TextRefusal> {
    if text.chars().any(|c| c.is_control() && c != '\n') {
        return Err(TextRefusal::ControlCharacter);
    }
    if text.trim().is_empty() {
        return Err(TextRefusal::Empty);
    }
    if slot
        .max_chars
        .is_some_and(|max| text.chars().count() > usize::from(max))
    {
        return Err(TextRefusal::TooLong);
    }
    Ok(())
}

/// An sRGB colour, written `#rrggbb`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Color(pub u8, pub u8, pub u8);

impl Color {
    pub const WHITE: Color = Color(0xff, 0xff, 0xff);

    /// `#rrggbb` (either case); anything else is `None`.
    pub fn parse(text: &str) -> Option<Color> {
        let hex = text.strip_prefix('#')?;
        if hex.len() != 6 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            return None;
        }
        let byte = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
        Some(Color(byte(0)?, byte(2)?, byte(4)?))
    }

    pub fn hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.0, self.1, self.2)
    }

    /// WCAG 2.x relative luminance.
    pub fn luminance(self) -> f64 {
        let channel = |c: u8| {
            let c = f64::from(c) / 255.0;
            if c <= 0.039_28 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        };
        0.2126 * channel(self.0) + 0.7152 * channel(self.1) + 0.0722 * channel(self.2)
    }

    /// WCAG 2.x contrast ratio of two colours (1 to 21).
    pub fn contrast(self, other: Color) -> f64 {
        let (a, b) = (self.luminance(), other.luminance());
        let (hi, lo) = if a > b { (a, b) } else { (b, a) };
        (hi + 0.05) / (lo + 0.05)
    }
}

impl Serialize for Color {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.hex())
    }
}

impl<'de> Deserialize<'de> for Color {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let text = String::deserialize(d)?;
        Color::parse(&text)
            .ok_or_else(|| serde::de::Error::custom("a colour is written #rrggbb (e.g. #1f2937)"))
    }
}

/// A font family bundled with the renderer (each under the SIL Open Font License 1.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FontFamily {
    /// Bricolage Grotesque: a grotesque display face; carries ₺.
    BricolageGrotesque,
    /// Figtree: a geometric text face; has no ₺, which is drawn from the other family.
    Figtree,
}

impl FontFamily {
    pub const ALL: [FontFamily; 2] = [Self::BricolageGrotesque, Self::Figtree];

    pub fn key(self) -> &'static str {
        match self {
            Self::BricolageGrotesque => "bricolage_grotesque",
            Self::Figtree => "figtree",
        }
    }
}

/// A workspace's brand tokens: what every composed post of it is drawn with. Workspace data;
/// [`BrandTokens::default`] is neutral and names no business.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BrandTokens {
    /// The light ground of inner slides and cards.
    pub background: Color,
    /// Text on the light ground, and the ground of dark slides and photo scrims.
    pub ink: Color,
    /// The accent: bars, label chips, step digits, the closing slogan.
    pub accent: Color,
    /// Secondary text on the light ground.
    pub muted: Color,
    pub heading_font: FontFamily,
    pub body_font: FontFamily,
    /// Shown in the brand chip beside the logo (or its first letter); empty for no chip.
    #[serde(default)]
    pub brand_name: String,
    /// An image material drawn in the brand chip in place of the first letter.
    #[serde(default)]
    pub logo_material_id: Option<MaterialId>,
}

impl Default for BrandTokens {
    fn default() -> Self {
        Self {
            background: Color(0xf5, 0xf5, 0xf3),
            ink: Color(0x17, 0x1a, 0x1f),
            accent: Color(0xf2, 0xb8, 0x3c),
            muted: Color(0x55, 0x5b, 0x66),
            heading_font: FontFamily::BricolageGrotesque,
            body_font: FontFamily::Figtree,
            brand_name: String::new(),
            logo_material_id: None,
        }
    }
}

/// A brand colour the renderer does not use as given, and why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BrandFallback {
    pub token: String,
    pub given: Color,
    pub used: Color,
    pub reason: String,
}

/// Why brand tokens are refused outright (not fallen back from).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BrandRefusal {
    BrandName,
}

impl BrandTokens {
    /// Whether the tokens may be stored: the brand name is a short single line.
    pub fn validate(&self) -> Result<(), BrandRefusal> {
        let name = &self.brand_name;
        if name.chars().count() > MAX_BRAND_NAME_CHARS
            || name.chars().any(char::is_control)
            || name.trim() != name
        {
            return Err(BrandRefusal::BrandName);
        }
        Ok(())
    }

    /// The tokens the renderer draws with, and each colour it could not use as given. Every text
    /// pair a template draws reaches [`AA_LARGE`]: ink on the background, white on the ink (a
    /// photo's scrim), muted on the background, and the accent against the ink (step digits, the
    /// slogan, a label's ink text on the accent). Ink and background fall back together to the
    /// defaults; muted to the default muted, else the ink; the accent to the default accent,
    /// else the background.
    pub fn effective(&self) -> (BrandTokens, Vec<BrandFallback>) {
        let defaults = BrandTokens::default();
        let mut out = self.clone();
        let mut fallbacks = Vec::new();
        let mut fall = |token: &str, given: Color, used: Color, reason: String| {
            fallbacks.push(BrandFallback {
                token: token.into(),
                given,
                used,
                reason,
            });
        };
        let ink_bg = out.ink.contrast(out.background);
        let white_ink = Color::WHITE.contrast(out.ink);
        if ink_bg < AA_LARGE || white_ink < AA_LARGE {
            let reason = if ink_bg < AA_LARGE {
                format!("ink on background contrast {ink_bg:.2}:1 is under {AA_LARGE}:1")
            } else {
                format!(
                    "white text on the ink (photo scrims, dark slides) contrast {white_ink:.2}:1 is under {AA_LARGE}:1"
                )
            };
            if out.ink != defaults.ink {
                fall("ink", out.ink, defaults.ink, reason.clone());
            }
            if out.background != defaults.background {
                fall("background", out.background, defaults.background, reason);
            }
            out.ink = defaults.ink;
            out.background = defaults.background;
        }
        let muted = out.muted.contrast(out.background);
        if muted < AA_LARGE {
            let used = if defaults.muted.contrast(out.background) >= AA_LARGE {
                defaults.muted
            } else {
                out.ink
            };
            fall(
                "muted",
                out.muted,
                used,
                format!("muted on background contrast {muted:.2}:1 is under {AA_LARGE}:1"),
            );
            out.muted = used;
        }
        let accent = out.accent.contrast(out.ink);
        if accent < AA_LARGE {
            let used = if defaults.accent.contrast(out.ink) >= AA_LARGE {
                defaults.accent
            } else {
                out.background
            };
            fall(
                "accent",
                out.accent,
                used,
                format!("accent against the ink contrast {accent:.2}:1 is under {AA_LARGE}:1"),
            );
            out.accent = used;
        }
        (out, fallbacks)
    }
}

/// How a material was composed by the server (a slide or a story frame drawn from other
/// materials): fixed when the material is created. `sources` are the materials drawn, photos
/// in slot order and the logo last; any AI-generated source makes the composition AI-generated.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Composition {
    pub renderer: String,
    pub role: Role,
    pub variant: String,
    pub frame: Frame,
    pub sources: Vec<MaterialId>,
    /// The brand logo drawn in its chip, also listed in `sources` (for provenance, the AI flag
    /// and the cascades); absent without a logo, and on a composition stored before this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<MaterialId>,
}

impl Composition {
    /// What it was drawn from as content: its sources less the brand logo, which is the
    /// workspace's, never content. For a composition stored before `logo` was recorded, a source
    /// equal to the workspace's current logo (`brand_logo`) is taken for the logo.
    pub fn content_sources(&self, brand_logo: Option<MaterialId>) -> Vec<MaterialId> {
        self.sources
            .iter()
            .copied()
            .filter(|s| Some(*s) != self.logo && (self.logo.is_some() || Some(*s) != brand_logo))
            .collect()
    }
}

/// The variant a cover should take after `last` (the workspace's last rendered cover's): the next
/// one in order, so consecutive posts never open alike.
pub fn next_cover_variant(last: Option<&str>) -> &'static str {
    let variants = Role::Cover.variants();
    let at = last
        .and_then(|l| variants.iter().position(|(name, _)| *name == l))
        .map_or(0, |i| (i + 1) % variants.len());
    variants[at].0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_role_has_variants_and_cover_three() {
        for role in Role::ALL {
            let n = role.variants().len();
            assert!(n >= 2, "{role:?}");
            for (name, _) in role.variants() {
                let t = template(role, name).expect("template");
                assert!(t.slots.iter().any(|s| s.kind == SlotKind::Photo));
                for s in &t.slots {
                    if let Some(style) = s.style {
                        assert!(style.size >= MIN_TEXT_PX, "{role:?} {name} {}", s.key);
                    }
                }
            }
        }
        assert_eq!(Role::Cover.variants().len(), 3);
        assert_eq!(templates().len(), 19);
    }

    #[test]
    fn colours_parse_and_contrast() {
        assert_eq!(Color::parse("#1A2b3c"), Some(Color(0x1a, 0x2b, 0x3c)));
        for bad in ["1a2b3c", "#1a2b3", "#1a2b3g", "#1a2b3c0", "red"] {
            assert_eq!(Color::parse(bad), None, "{bad}");
        }
        let c = Color(0, 0, 0).contrast(Color::WHITE);
        assert!((c - 21.0).abs() < 1e-9);
    }

    #[test]
    fn defaults_pass_and_bad_pairs_fall_back() {
        let (eff, f) = BrandTokens::default().effective();
        assert!(f.is_empty());
        assert_eq!(eff, BrandTokens::default());
        let low = BrandTokens {
            ink: Color(0xcc, 0xcc, 0xcc),
            ..BrandTokens::default()
        };
        let (eff, f) = low.effective();
        assert_eq!(eff.ink, BrandTokens::default().ink);
        assert_eq!(f[0].token, "ink");
        let accent = BrandTokens {
            accent: Color(0x20, 0x20, 0x20),
            ..BrandTokens::default()
        };
        let (eff, f) = accent.effective();
        assert_eq!(eff.accent, BrandTokens::default().accent);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].token, "accent");
    }

    #[test]
    fn covers_rotate() {
        assert_eq!(next_cover_variant(None), "full_bottom");
        assert_eq!(next_cover_variant(Some("full_bottom")), "full_top");
        assert_eq!(next_cover_variant(Some("framed_dark")), "full_bottom");
    }
}
