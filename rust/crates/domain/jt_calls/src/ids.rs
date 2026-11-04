//! Typed identities of calls.
use jt_tenancy::define_id;

define_id!(
    /// A call session.
    CallId
);
define_id!(
    /// A command queued for the voice bridge.
    CallCommandId
);
