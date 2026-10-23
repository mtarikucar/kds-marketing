//! Typed identifiers. Each is a UUID newtype so ids of different kinds cannot be mixed up.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Declares a UUID newtype id with `new_v7`, `Display`, `FromStr`, `From<Uuid>` and `as_uuid`.
macro_rules! uuid_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(
            Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize,
        )]
        #[serde(transparent)]
        pub struct $name(pub Uuid);

        impl $name {
            /// A fresh, time-ordered (UUIDv7) identifier.
            pub fn new_v7() -> Self {
                Self(Uuid::now_v7())
            }

            /// The underlying UUID.
            pub fn as_uuid(&self) -> Uuid {
                self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                fmt::Display::fmt(&self.0.hyphenated(), f)
            }
        }

        impl FromStr for $name {
            type Err = uuid::Error;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Uuid::parse_str(s).map(Self)
            }
        }

        impl From<Uuid> for $name {
            fn from(id: Uuid) -> Self {
                Self(id)
            }
        }
    };
}

uuid_id!(
    /// A workspace (tenant).
    WorkspaceId
);
uuid_id!(
    /// A user account.
    UserId
);
uuid_id!(
    /// A user's membership in a workspace.
    MembershipId
);
uuid_id!(
    /// A role definition within a workspace.
    RoleId
);
uuid_id!(
    /// A panel login session.
    SessionId
);
uuid_id!(
    /// An API key.
    ApiKeyId
);
uuid_id!(
    /// A connection through which an agent acts on a user's behalf.
    AgentConnectionId
);
uuid_id!(
    /// A platform operator.
    OperatorId
);
