//! The post renderer: composes a carousel slide or a story frame from a template, its texts, its
//! photos and the workspace's brand tokens, as JPEG or PNG ([`jt_app::ports::compose`]).
//!
//! Pure Rust, CPU only: tiny-skia draws (paths, gradients, masks), rustybuzz shapes text in the
//! bundled fonts (`fonts/`, SIL Open Font License 1.1) and their outlines are filled as paths,
//! and `image` decodes JPEG, PNG and WebP only (no other codec is compiled in) and encodes the
//! result. Rendering runs on tokio's blocking pool, at most [`Limits::concurrency`] at once; a
//! source is decoded only within [`Limits::decode`] and dropped once drawn.
mod fonts;
mod layout;
mod raster;
mod text;

use async_trait::async_trait;
use jt_app::ports::compose::{ComposeError, ComposeJob, Composed, Compositor, RenderTicket};
use jt_studio::compose::SlotKind;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::Semaphore;

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
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            concurrency: 2,
            max_waiting: 4,
            queue_wait: Duration::from_secs(30),
            decode: DecodeLimits::default(),
        }
    }
}

/// The renderer: the parsed fonts and the render permits, shared by every request.
pub struct Renderer {
    fonts: Option<Arc<fonts::FontSet>>,
    permits: Arc<Semaphore>,
    waiting: Arc<AtomicUsize>,
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

#[async_trait]
impl Compositor for Renderer {
    async fn reserve(&self) -> Result<RenderTicket, ComposeError> {
        if self.fonts.is_none() {
            return Err(ComposeError::Internal(
                "the bundled fonts do not parse".into(),
            ));
        }
        // A bounded queue: past `max_waiting` renders already waiting, refuse at once.
        if self.waiting.fetch_add(1, Ordering::SeqCst) >= self.limits.max_waiting {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            return Err(ComposeError::Busy);
        }
        let waiting = Waiting(Arc::clone(&self.waiting));
        let permit = tokio::time::timeout(
            self.limits.queue_wait,
            Arc::clone(&self.permits).acquire_owned(),
        )
        .await
        .map_err(|_| ComposeError::Busy)?
        .map_err(|_| ComposeError::Busy)?;
        drop(waiting);
        Ok(RenderTicket(Box::new(permit)))
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
}
