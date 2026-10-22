//! Typed identifiers. Each is a UUID newtype so ids of different kinds cannot be mixed up.

/// Declares a UUID newtype id with `new_v7`, `Display`, `FromStr`, `From<Uuid>` and `as_uuid`.
///
/// Exported so every domain crate declares its ids the same way, e.g.
/// `jt_tenancy::define_id!(StrategyVersionId);` (doc comments before the name are kept). The
/// calling crate must depend on `serde` (with `derive`) and `uuid`, as every domain crate does.
#[macro_export]
macro_rules! define_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(
            Clone,
            Copy,
            Debug,
            PartialEq,
            Eq,
            Hash,
            PartialOrd,
            Ord,
            ::serde::Serialize,
            ::serde::Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub ::uuid::Uuid);

        impl $name {
            /// A fresh, time-ordered (UUIDv7) identifier.
            pub fn new_v7() -> Self {
                Self(::uuid::Uuid::now_v7())
            }

            /// The underlying UUID.
            pub fn as_uuid(&self) -> ::uuid::Uuid {
                self.0
            }
        }

        impl ::std::fmt::Display for $name {
            fn fmt(&self, f: &mut ::std::fmt::Formatter<'_>) -> ::std::fmt::Result {
                ::std::fmt::Display::fmt(&self.0.hyphenated(), f)
            }
        }

        impl ::std::str::FromStr for $name {
            type Err = ::uuid::Error;

            fn from_str(s: &str) -> ::std::result::Result<Self, Self::Err> {
                ::uuid::Uuid::parse_str(s).map(Self)
            }
        }

        impl ::std::convert::From<::uuid::Uuid> for $name {
            fn from(id: ::uuid::Uuid) -> Self {
                Self(id)
            }
        }
    };
}

define_id!(
    /// A workspace (tenant).
    WorkspaceId
);
define_id!(
    /// A user account.
    UserId
);
define_id!(
    /// A user's membership in a workspace.
    MembershipId
);
define_id!(
    /// A role definition within a workspace.
    RoleId
);
define_id!(
    /// A panel login session.
    SessionId
);
define_id!(
    /// An API key.
    ApiKeyId
);
define_id!(
    /// A connection through which an agent acts on a user's behalf.
    AgentConnectionId
);
define_id!(
    /// A platform operator.
    OperatorId
);
