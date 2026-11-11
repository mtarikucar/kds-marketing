//! The signals that wake the long-polls of the bridges and of what waits on them (the bridge
//! kernel, `usecases::bridges`): a bridge's poll for its commands, an agent's wait on what a
//! bridge reported (`calls.listen`). One registry serves every bridge, each waking only the polls
//! of its own topic in its own workspace.

use std::future::Future;
use std::pin::Pin;

use jt_tenancy::WorkspaceId;

/// What a signal wakes: the long-polls of `topic` (`"calls"`, ...) in workspace `workspace_id`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SignalKey {
    pub workspace_id: WorkspaceId,
    pub topic: &'static str,
}

/// What a long-poll awaits ([`BridgeSignals::watch`]): done once its key was signalled after the
/// watch began.
pub type BridgeWatch = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Wakes the long-polls of a key when something they wait for was committed: a turn appended, a
/// command queued. A poll starts watching *before* it reads, so a signal sent between its read
/// and its wait still wakes it. Signals are a hint, never the record: a poll reads the store
/// again when woken, and also, at least every second, when nothing woke it (a signal sent by
/// another server instance reaches none of this one's polls).
pub trait BridgeSignals: Send + Sync {
    /// A watch on `key`, done at the first [`BridgeSignals::notify`] of `key` after this call.
    fn watch(&self, key: SignalKey) -> BridgeWatch;
    /// Wakes every watch on `key` begun before this call.
    fn notify(&self, key: SignalKey);
}
