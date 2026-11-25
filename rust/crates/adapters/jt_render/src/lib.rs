//! The post renderer: composes a carousel slide or a story frame from a template, its texts, its
//! photos and the workspace's brand tokens, as JPEG or PNG ([`jt_app::ports::compose`]).
//!
//! Pure Rust, CPU only: tiny-skia draws (paths, gradients, masks), rustybuzz shapes text in the
//! bundled fonts (`fonts/`, SIL Open Font License 1.1) and their outlines are filled as paths,
//! and `image` decodes JPEG, PNG and WebP only (no other codec is compiled in) and encodes the
//! result. Rendering runs on tokio's blocking pool, at most [`Limits::concurrency`] at once; a
//! source is decoded only within [`Limits::decode`] and dropped once drawn.
//!
//! It also renders photo reels ([`Compositor::render_reel`]): vertical H.264 videos in MP4,
//! encoded by OpenH264 compiled from its source into the binary (`h264`, `mp4`, `reel`). Reels
//! have a queue of their own, one at a time ([`ReelLimits`]), each within a hard time limit.
mod fonts;
mod h264;
mod layout;
mod mp4;
mod raster;
mod reel;
mod text;

use async_trait::async_trait;
use jt_app::ports::compose::{
    ComposeError, ComposeJob, Composed, Compositor, ReelJob, ReelPhotoBytes, RenderTicket,
    RenderedReel,
};
use jt_studio::compose::SlotKind;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::Semaphore;

pub use h264::EncodeLimits;
pub use raster::Limits as DecodeLimits;

/// What the renderer may spend.
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    /// How many renders run at once; the rest wait.
    pub concurrency: usize,
    /// How many renders may wait for a turn; one more is refused as busy at once.
    pub max_waiting: usize,
    /// How long a render waits for its turn before it is refused as busy.
    pub queue_wait: Duration,
    pub decode: DecodeLimits,
    pub reel: ReelLimits,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            concurrency: 2,
            max_waiting: 4,
            queue_wait: Duration::from_secs(30),
            decode: DecodeLimits::default(),
            reel: ReelLimits::default(),
        }
    }
}

/// What reels may spend. One renders at a time: a reel keeps the encoder's threads busy for
/// seconds, beside the application on the same host.
#[derive(Clone, Copy, Debug)]
pub struct ReelLimits {
    /// How many reels may wait for their turn; one more is refused as busy at once.
    pub max_waiting: usize,
    /// How long a reel waits for its turn before it is refused as busy.
    pub queue_wait: Duration,
    /// The longest a reel may take once its turn came; past it the render is stopped.
    pub time_limit: Duration,
    pub encode: EncodeLimits,
}

impl Default for ReelLimits {
    fn default() -> Self {
        Self {
            max_waiting: 2,
            queue_wait: Duration::from_secs(90),
            time_limit: Duration::from_secs(150),
            encode: EncodeLimits::default(),
        }
    }
}

/// The renderer: the parsed fonts and the render permits, shared by every request.
pub struct Renderer {
    fonts: Option<Arc<fonts::FontSet>>,
    permits: Arc<Semaphore>,
    waiting: Arc<AtomicUsize>,
    reel_permits: Arc<Semaphore>,
    reel_waiting: Arc<AtomicUsize>,
    limits: Limits,
}

/// Counts a render waiting for its turn while it lives.
struct Waiting(Arc<AtomicUsize>);

impl Drop for Waiting {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

impl Renderer {
    pub fn new(limits: Limits) -> Self {
        Self {
            fonts: fonts::FontSet::load().map(Arc::new),
            permits: Arc::new(Semaphore::new(limits.concurrency.max(1))),
            waiting: Arc::new(AtomicUsize::new(0)),
            reel_permits: Arc::new(Semaphore::new(1)),
            reel_waiting: Arc::new(AtomicUsize::new(0)),
            limits,
        }
    }

    /// Composes `job` on the calling thread (what [`Compositor::compose`] runs on the blocking
    /// pool).
    pub fn compose_blocking(&self, job: &ComposeJob) -> Result<Composed, ComposeError> {
        let fonts = self
            .fonts
            .as_ref()
            .ok_or_else(|| ComposeError::Internal("the bundled fonts do not parse".into()))?;
        render(fonts, job, &self.limits.decode)
    }

    /// Renders the reel `job` on the calling thread within the reel time limit (what
    /// [`Compositor::render_reel`] runs on the blocking pool).
    pub fn render_reel_blocking(
        &self,
        job: ReelJob,
        photos: &mut dyn ReelPhotoBytes,
    ) -> Result<RenderedReel, ComposeError> {
        let fonts = self
            .fonts
            .as_ref()
            .ok_or_else(|| ComposeError::Internal("the bundled fonts do not parse".into()))?;
        let deadline = std::time::Instant::now() + self.limits.reel.time_limit;
        reel::render(
            fonts,
            job,
            photos,
            &self.limits.decode,
            &self.limits.reel.encode,
            deadline,
        )
    }
}

fn render(
    fonts: &fonts::FontSet,
    job: &ComposeJob,
    limits: &DecodeLimits,
) -> Result<Composed, ComposeError> {
    for slot in &job.template.slots {
        let given = match slot.kind {
            SlotKind::Photo => job.photos.contains_key(slot.key),
            SlotKind::Text | SlotKind::Price => job
                .texts
                .get(slot.key)
                .is_some_and(|t| !t.trim().is_empty()),
        };
        if slot.required && !given {
            return Err(ComposeError::MissingSlot {
                slot: slot.key.into(),
            });
        }
    }
    let mut canvas = layout::Canvas::new(fonts, job, limits)?;
    let sticker_area = layout::compose(&mut canvas)?;
    let bytes = raster::encode(&canvas.pixmap, job.output)?;
    let (width, height) = job.template.frame.size();
    Ok(Composed {
        bytes,
        mime: job.output.mime(),
        width,
        height,
        sticker_area,
    })
}

/// A turn in the queue of `permits`: refused at once with `max_waiting` already waiting, and
/// after `wait` without a turn.
async fn turn(
    permits: &Arc<Semaphore>,
    waiting: &Arc<AtomicUsize>,
    max_waiting: usize,
    wait: Duration,
) -> Result<RenderTicket, ComposeError> {
    if waiting.fetch_add(1, Ordering::SeqCst) >= max_waiting {
        waiting.fetch_sub(1, Ordering::SeqCst);
        return Err(ComposeError::Busy);
    }
    let in_queue = Waiting(Arc::clone(waiting));
    let permit = tokio::time::timeout(wait, Arc::clone(permits).acquire_owned())
        .await
        .map_err(|_| ComposeError::Busy)?
        .map_err(|_| ComposeError::Busy)?;
    drop(in_queue);
    Ok(RenderTicket(Box::new(permit)))
}

#[async_trait]
impl Compositor for Renderer {
    async fn reserve(&self) -> Result<RenderTicket, ComposeError> {
        if self.fonts.is_none() {
            return Err(ComposeError::Internal(
                "the bundled fonts do not parse".into(),
            ));
        }
        // A bounded queue: past `max_waiting` renders already waiting, refuse at once.
        turn(
            &self.permits,
            &self.waiting,
            self.limits.max_waiting,
            self.limits.queue_wait,
        )
        .await
    }

    async fn compose(
        &self,
        ticket: RenderTicket,
        job: ComposeJob,
    ) -> Result<Composed, ComposeError> {
        let fonts = self
            .fonts
            .clone()
            .ok_or_else(|| ComposeError::Internal("the bundled fonts do not parse".into()))?;
        let limits = self.limits.decode;
        let started = std::time::Instant::now();
        let result = tokio::task::spawn_blocking(move || {
            // The turn is held until the image is drawn and encoded.
            let _ticket = ticket;
            render(&fonts, &job, &limits)
        })
        .await
        .map_err(|e| ComposeError::Internal(format!("render task failed: {e}")))?;
        tracing::info!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            ok = result.is_ok(),
            "post rendered"
        );
        result
    }

    fn uncovered(&self, text: &str) -> Vec<char> {
        let Some(fonts) = &self.fonts else {
            return Vec::new();
        };
        let mut out: Vec<char> = Vec::new();
        for c in text.chars().filter(|c| !c.is_whitespace()) {
            if !jt_studio::compose::FontFamily::ALL
                .iter()
                .any(|f| fonts.covers(*f, c))
                && !out.contains(&c)
            {
                out.push(c);
            }
        }
        out
    }

    async fn reserve_reel(&self) -> Result<RenderTicket, ComposeError> {
        if self.fonts.is_none() {
            return Err(ComposeError::Internal(
                "the bundled fonts do not parse".into(),
            ));
        }
        turn(
            &self.reel_permits,
            &self.reel_waiting,
            self.limits.reel.max_waiting,
            self.limits.reel.queue_wait,
        )
        .await
    }

    async fn render_reel(
        &self,
        ticket: RenderTicket,
        job: ReelJob,
        mut photos: Box<dyn ReelPhotoBytes>,
    ) -> Result<RenderedReel, ComposeError> {
        let fonts = self
            .fonts
            .clone()
            .ok_or_else(|| ComposeError::Internal("the bundled fonts do not parse".into()))?;
        let limits = self.limits;
        let count = job.photos.len();
        let started = std::time::Instant::now();
        let result = tokio::task::spawn_blocking(move || {
            // The turn is held until the reel is encoded; the time limit counts from here.
            let _ticket = ticket;
            let deadline = std::time::Instant::now() + limits.reel.time_limit;
            reel::render(
                &fonts,
                job,
                photos.as_mut(),
                &limits.decode,
                &limits.reel.encode,
                deadline,
            )
        })
        .await
        .map_err(|e| ComposeError::Internal(format!("reel task failed: {e}")))?;
        tracing::info!(
            elapsed_ms = started.elapsed().as_millis() as u64,
            photos = count,
            ok = result.is_ok(),
            bytes = result.as_ref().map_or(0, |r| r.bytes.len()),
            "reel rendered"
        );
        result
    }
}
