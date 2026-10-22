//! The state every handler shares.

use std::path::PathBuf;
use std::sync::Arc;

use jt_app::gate::StrategyGate;
use jt_app::usecases::Deps;

/// What the panel's handlers need, built once by the binary (or a test).
#[derive(Clone)]
pub struct AppState {
    /// The ports the use cases call.
    pub deps: Deps,
    /// Whether a workspace has an approved strategy, for `Gated` use cases.
    pub gate: Arc<dyn StrategyGate>,
    /// Marks the session cookie `Secure`; set whenever the panel is served over TLS.
    pub cookie_secure: bool,
    /// The built panel (`index.html`, `assets/…`); `None` serves no files.
    pub panel_dir: Option<PathBuf>,
}
