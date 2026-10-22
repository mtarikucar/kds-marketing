//! Which API key each MCP session belongs to.
//!
//! rmcp serves any request that names a live `Mcp-Session-Id`, whoever sends it. The bearer
//! check ([`crate::auth`]) therefore binds each session to the key that created it (the key of
//! the request whose response carried the new session id) and answers a request naming a
//! session that is not bound to its key exactly as rmcp answers an unknown session: `404`, here
//! with the structured body `{"code":"NOT_FOUND","message":"unknown session","details":{}}`.
//! That covers a session bound to another key and one bound to none at all, so a leaked session
//! id is worth nothing to anyone but its own key, and its existence is not revealed.
//!
//! The bindings live in memory, one process, like rmcp's sessions themselves. An entry is
//! dropped when its session is deleted; beyond [`MAX_BOUND_SESSIONS`] the oldest binding is
//! evicted. Eviction fails closed: the evicted session can no longer be used by anyone, its own
//! key included (that client re-initialises), so flooding the map with new sessions cannot make
//! another key's session reachable.

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, PoisonError};

use jt_tenancy::ApiKeyId;

/// The most session bindings kept; beyond it the oldest is evicted.
pub const MAX_BOUND_SESSIONS: usize = 10_000;

/// Session id to the API key that created the session.
#[derive(Debug)]
pub struct SessionKeys {
    capacity: usize,
    inner: Mutex<Bindings>,
}

#[derive(Debug, Default)]
struct Bindings {
    owners: HashMap<String, ApiKeyId>,
    /// Session ids in the order they were bound; may still hold ids since forgotten.
    order: VecDeque<String>,
}

impl Default for SessionKeys {
    fn default() -> Self {
        SessionKeys::with_capacity(MAX_BOUND_SESSIONS)
    }
}

impl SessionKeys {
    /// Bindings for at most `capacity` sessions.
    pub fn with_capacity(capacity: usize) -> SessionKeys {
        SessionKeys {
            capacity: capacity.max(1),
            inner: Mutex::default(),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Bindings> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Binds session `id` to `key`, unless it is already bound (a binding never changes
    /// owner). Evicts the oldest bindings beyond the capacity.
    pub fn bind(&self, id: &str, key: ApiKeyId) {
        let mut b = self.lock();
        if b.owners.contains_key(id) {
            return;
        }
        b.owners.insert(id.to_owned(), key);
        b.order.push_back(id.to_owned());
        while b.order.len() > self.capacity {
            if let Some(oldest) = b.order.pop_front() {
                b.owners.remove(&oldest);
            }
        }
    }

    /// The key session `id` is bound to, if it is bound.
    pub fn owner(&self, id: &str) -> Option<ApiKeyId> {
        self.lock().owners.get(id).copied()
    }

    /// Drops the binding of session `id`, e.g. once the session is deleted.
    pub fn forget(&self, id: &str) {
        self.lock().owners.remove(id);
    }

    /// How many sessions are bound.
    pub fn len(&self) -> usize {
        self.lock().owners.len()
    }

    /// Whether no session is bound.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_binding_keeps_its_first_owner_until_forgotten() {
        let sessions = SessionKeys::default();
        let (a, b) = (ApiKeyId::new_v7(), ApiKeyId::new_v7());
        assert_eq!(sessions.owner("s1"), None);
        sessions.bind("s1", a);
        sessions.bind("s1", b);
        assert_eq!(sessions.owner("s1"), Some(a));
        sessions.forget("s1");
        assert_eq!(sessions.owner("s1"), None);
        assert!(sessions.is_empty());
    }

    #[test]
    fn the_oldest_bindings_are_evicted_beyond_the_capacity() {
        let sessions = SessionKeys::with_capacity(3);
        let key = ApiKeyId::new_v7();
        for id in ["s1", "s2", "s3", "s4"] {
            sessions.bind(id, key);
        }
        assert_eq!(sessions.len(), 3);
        assert_eq!(sessions.owner("s1"), None);
        assert_eq!(sessions.owner("s4"), Some(key));

        // Forgotten ids still count in the order until they age out, so the order stays
        // bounded too; live bindings never exceed the capacity.
        sessions.forget("s2");
        for id in ["s5", "s6", "s7"] {
            sessions.bind(id, key);
        }
        assert_eq!(sessions.len(), 3);
        for gone in ["s2", "s3", "s4"] {
            assert_eq!(sessions.owner(gone), None, "{gone}");
        }
        assert_eq!(MAX_BOUND_SESSIONS, 10_000);
    }
}
