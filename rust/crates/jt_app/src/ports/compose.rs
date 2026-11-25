//! Composing a post's slide or story frame from photos and texts: the renderer port
//! (`jt_render` implements it). The use case reads the materials and the brand tokens, the
//! renderer only draws.
use async_trait::async_trait;
use jt_studio::compose::{BrandTokens, Template};
use serde::Serialize;
use std::collections::BTreeMap;

/// An image a template draws: its stored bytes and type (`image/jpeg`, `image/png` or
/// `image/webp`), and the point of it that a crop keeps in view (0 to 1 from the left and top).
#[derive(Clone)]
pub struct SourceImage {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub focus: (f32, f32),
}

/// The encoding of a composed image.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum OutputFormat {
    /// JPEG: what Instagram's API takes for stories and feed images (the default).
    #[default]
    Jpeg,
    Png,
}

impl OutputFormat {
    pub fn mime(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
        }
    }
    pub fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
        }
    }
}

/// One image to compose.
#[derive(Clone)]
pub struct ComposeJob {
    pub template: Template,
    /// The text of each text slot given, by slot key.
    pub texts: BTreeMap<String, String>,
    /// The image of each photo slot given, by slot key.
    pub photos: BTreeMap<String, SourceImage>,
    /// The brand's logo, drawn in the brand chip.
    pub logo: Option<SourceImage>,
    /// The effective brand tokens ([`BrandTokens::effective`]).
    pub brand: BrandTokens,
    /// A slide's place in its carousel, drawn as "index/total".
    pub counter: Option<(u8, u8)>,
    pub output: OutputFormat,
}

/// A rectangle in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, serde::Deserialize)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// A composed image.
#[derive(Clone)]
pub struct Composed {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
    /// The area left empty for the platform's own sticker (a poll, a link), when the template
    /// has one.
    pub sticker_area: Option<Rect>,
}

/// Why an image could not be composed.
#[derive(Clone, Debug, PartialEq)]
pub enum ComposeError {
    /// A text does not fit its slot at the template's size: the caller shortens it. Either it
    /// needs more lines than the slot has (`lines_needed`), or one of its words is wider than the
    /// slot on its own (`word_too_wide`, that word), which no wrapping fixes.
    Overflow {
        slot: String,
        max_chars: u16,
        max_lines: u8,
        lines_needed: Option<usize>,
        word_too_wide: Option<String>,
    },
    /// A text fits its own slot but would run into another element (`with`): shorten it.
    Collision {
        slot: String,
        with: String,
    },
    /// A character no bundled font draws.
    UnsupportedCharacter {
        slot: String,
        character: char,
    },
    /// A source image could not be read: its type, its size or its bytes.
    Image {
        slot: String,
        reason: String,
    },
    /// A required slot was left out.
    MissingSlot {
        slot: String,
    },
    /// Too many renders run or wait already: try again shortly.
    Busy,
    /// The render ran past its time limit and was stopped; nothing is stored.
    TimedOut,
    Internal(String),
}

/// A turn to render, taken before a source's bytes are read and held until the image is
/// composed ([`Compositor::reserve`]). Opaque: what it holds is the renderer's.
pub struct RenderTicket(pub Box<dyn std::any::Any + Send>);

/// Draws composed images. An implementation renders off the async runtime, bounds how many
/// renders run at once and how many wait, and how large a source it decodes.
#[async_trait]
pub trait Compositor: Send + Sync {
    /// Takes a turn: [`ComposeError::Busy`] when too many renders wait already. The caller takes
    /// it before reading any source's bytes, so waiting renders hold no image in memory.
    async fn reserve(&self) -> Result<RenderTicket, ComposeError>;
    /// Composes `job` in the turn `ticket` (released when this returns).
    async fn compose(
        &self,
        ticket: RenderTicket,
        job: ComposeJob,
    ) -> Result<Composed, ComposeError>;
    /// The characters of `text` that no bundled font draws, each once, in order.
    fn uncovered(&self, text: &str) -> Vec<char>;
    /// Takes a turn to render a reel ([`Compositor::reserve`]'s rule, in the reels' own queue).
    async fn reserve_reel(&self) -> Result<RenderTicket, ComposeError> {
        Err(ComposeError::Internal(
            "reel rendering is not configured".into(),
        ))
    }
    /// Renders `job` in the turn `ticket` (released when this returns), off the async runtime
    /// and within the renderer's time limit, reading each photo's bytes from `photos` only when
    /// that photo's part begins.
    async fn render_reel(
        &self,
        _ticket: RenderTicket,
        _job: ReelJob,
        _photos: Box<dyn ReelPhotoBytes>,
    ) -> Result<RenderedReel, ComposeError> {
        Err(ComposeError::Internal(
            "reel rendering is not configured".into(),
        ))
    }
}

/// One photo of a reel: its type (`image/jpeg`, `image/png` or `image/webp`), the point a crop
/// keeps in view, and the caption drawn over it. Its bytes are read when its part begins
/// ([`ReelPhotoBytes`]).
#[derive(Clone)]
pub struct ReelPhoto {
    pub mime: String,
    pub focus: (f32, f32),
    pub caption: Option<String>,
}

/// Reads a reel photo's stored bytes, by its index in [`ReelJob::photos`], when the renderer
/// reaches it: called on the renderer's blocking thread, once per photo, so at most one photo's
/// encoded bytes are in memory at a time.
pub trait ReelPhotoBytes: Send {
    fn read(&mut self, index: usize) -> Result<Vec<u8>, ComposeError>;
}

/// Photos already in memory (the renderer's own tests and samples).
impl ReelPhotoBytes for Vec<Vec<u8>> {
    fn read(&mut self, index: usize) -> Result<Vec<u8>, ComposeError> {
        self.get_mut(index)
            .map(std::mem::take)
            .ok_or_else(|| ComposeError::Internal(format!("no reel photo {index}")))
    }
}

/// One photo reel to render ([`Compositor::render_reel`]): photos in order, each shown
/// `photo_ms`, an opening title card when `title` is given, a closing card when any closing text
/// is given. Texts are drawn exactly as given; a text that does not fit is
/// [`ComposeError::Overflow`] naming it (`title_text`, `photos.N.text`, `closing.heading`, ...).
#[derive(Clone)]
pub struct ReelJob {
    pub photos: Vec<ReelPhoto>,
    pub photo_ms: u32,
    pub title: Option<String>,
    pub closing_heading: Option<String>,
    pub closing_site: Option<String>,
    pub closing_slogan: Option<String>,
    /// The brand's logo, drawn in the brand chip.
    pub logo: Option<SourceImage>,
    /// The effective brand tokens ([`BrandTokens::effective`]).
    pub brand: BrandTokens,
}

/// A rendered reel: an MP4 file.
#[derive(Clone)]
pub struct RenderedReel {
    pub bytes: Vec<u8>,
    pub mime: &'static str,
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    pub frames: u32,
    pub duration_ms: u64,
}

/// Refuses every render: the default where no renderer is wired (tests that do not draw).
pub struct UnavailableCompositor;

#[async_trait]
impl Compositor for UnavailableCompositor {
    async fn reserve(&self) -> Result<RenderTicket, ComposeError> {
        Err(ComposeError::Internal(
            "post rendering is not configured".into(),
        ))
    }
    async fn compose(&self, _: RenderTicket, _: ComposeJob) -> Result<Composed, ComposeError> {
        Err(ComposeError::Internal(
            "post rendering is not configured".into(),
        ))
    }
    fn uncovered(&self, _: &str) -> Vec<char> {
        Vec::new()
    }
}

/// A workspace's stored brand tokens, with how many times they were set and when last.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct BrandRecord {
    pub tokens: BrandTokens,
    pub revision: u64,
    #[serde(with = "jt_studio::time_compat")]
    pub updated_at: time::OffsetDateTime,
}
