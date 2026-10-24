//! Fakes for the application ports: a fixed clock, sequential ids, scripted tokens, a plain-text
//! "hasher", a plain-text "secret box", a fixed channel catalog, a recording tenant host registry,
//! an in-memory job lock, a configurable platform app configuration, scripted provider adapters
//! and an in-memory unit of work, plus [`deps`], which wires them all into a `Deps`.
//!
//! [`InMemoryUow`] keeps its tables behind one shared lock. Each bundle it opens works on a copy
//! taken when it opens (reads see that copy plus the bundle's own writes) and records its writes;
//! `commit` replays them onto the shared tables, and dropping a bundle uncommitted discards them.
//! Bundles keep the contracts of `jt_app::ports` and the constraints of migration 0001, answering
//! as `jt_pg` does so that a fake is never more permissive than the database:
//! - a duplicate where the schema has a unique key is `CONFLICT`;
//! - a reference to a role, user or workspace that does not exist is `NOT_FOUND`, as is a role
//!   that is not the membership's workspace's; any other dangling reference is `INTERNAL`;
//! - a tenant bundle sees only its own workspace's rows and refuses rows for another with
//!   `INTERNAL`;
//! - `RoleRepo::insert` refuses a role marked `is_system` with `INTERNAL`;
//! - a workspace has at most one draft and one approved strategy version (`CONFLICT`, as the
//!   partial unique indexes of migration 0002 answer), versions move only forward, and a
//!   hypothesis or consultation entry must hang off a version of the bundle's own workspace
//!   (`NOT_FOUND`); a hypothesis prior_confidence outside `0.0..=1.0` breaks the check constraint
//!   (`INTERNAL`);
//! - one external account (kind and external id) is held by at most one capability that is not
//!   retired (`CONFLICT`, as the partial unique index of migration 0003 answers); group members,
//!   budget links and spend hang only off rows of the bundle's own workspace (`NOT_FOUND`); a
//!   negative budget cap, a spend amount that is not positive and a check-in interval outside
//!   `15..=10080` break check constraints (`INTERNAL`); spend is never changed or removed;
//! - an inbound event is stored once per (workspace, provider, provider id): a replay is skipped
//!   (`None`) without spoiling the bundle; an event only gains a processing time and loses its
//!   raw body; a pending OAuth flow's state hash is unique across workspaces (`CONFLICT`); events
//!   and probe runs hang only off capabilities of the bundle's own workspace (`NOT_FOUND`); a
//!   probe run's error kind off the taxonomy breaks a check constraint (`INTERNAL`), and runs are
//!   never changed or removed (migration 0005);
//! - once any call on a bundle has failed, the bundle is spoiled: its `commit` returns
//!   `INTERNAL` and writes nothing, as a Postgres transaction aborted by a failed statement does.
//!
//! Ledger ids come from one shared sequence that, like a database sequence, never rolls back.
//!
//! Commit replays a bundle's buffered writes onto the shared tables without validating them again,
//! so two bundles that each passed their checks on their own copy both commit, where Postgres
//! would refuse one (a unique key, a row lock). Tests of races and concurrent transactions must
//! run against Postgres (`TestDb`), not these fakes.
//!
//! Layout: `services` holds the service fakes and [`deps`]; `providers` the platform app
//! configuration and the scripted provider adapters; `state` the tables, the shared checks and the
//! unit of work; `tenant`, `strategy`, `capability`, `connector`, `user` and `platform` the
//! bundles' repos.

mod capability;
mod compliance;
mod connector;
mod inbox;
pub use inbox::{MemInbox, StoredConsumption, StoredRequestKey};
mod platform;
mod providers;
mod services;
mod state;
mod strategy;
mod tenant;
mod user;

pub use providers::{
    ConnectorCall, FakeAppConfig, OAuthCall, ScriptedConnector, ScriptedOAuth, ScriptedRegistry,
    TEST_OAUTH_HOST, TEST_PUBLIC_BASE_URL,
};
pub use services::{
    DEPS_TOKENS, FIXED_NOW, FakeJobLock, FixedChannelCatalog, FixedClock, FixedTokenGen, HostCall,
    PLAIN_PREFIX, PlainHasher, PlainSecretBox, RecordingTenantHosts, SeqIdGen, deps,
};
pub use state::{
    InMemoryUow, MemState, StoredBudgetLink, StoredCapability, StoredCapabilityGroup,
    StoredConsultationEntry, StoredGroupMember, StoredHypothesis, StoredInboundEvent,
    StoredOutboundJob, StoredRole, StoredWorkspacePolicy,
};

mod inbox_merge;

mod erasure;

mod studio;
pub use studio::MemStudio;
