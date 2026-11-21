//! A first-message draft model answering from a script ([`ScriptedDrafter`]).

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard};

use async_trait::async_trait;
use jt_app::ports::draft_model::{DraftAnswer, DraftModel, DraftRequest, ModelError};

/// What a [`ScriptedDrafter`] answers one call with.
pub type DraftResult = Result<DraftAnswer, ModelError>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Answers from a script, one answer per call in order (a call past the end answers no draft),
/// recording every request. Never reaches the network.
#[derive(Default)]
pub struct ScriptedDrafter {
    answers: Mutex<VecDeque<DraftResult>>,
    requests: Mutex<Vec<DraftRequest>>,
}

impl ScriptedDrafter {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// Queues `answer` for the next call.
    pub fn answer(&self, answer: DraftResult) {
        lock(&self.answers).push_back(answer);
    }

    /// The requests so far, oldest first.
    pub fn requests(&self) -> Vec<DraftRequest> {
        lock(&self.requests).clone()
    }
}

#[async_trait]
impl DraftModel for ScriptedDrafter {
    fn model(&self) -> &str {
        "scripted-drafter"
    }

    async fn draft(&self, request: &DraftRequest) -> DraftResult {
        lock(&self.requests).push(request.clone());
        let next = lock(&self.answers).pop_front();
        next.unwrap_or(Ok(DraftAnswer {
            draft: None,
            usage: Default::default(),
        }))
    }
}
