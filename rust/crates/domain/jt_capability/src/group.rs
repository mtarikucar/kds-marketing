//! Capability groups: named sets of capabilities — a brand, a branch, a persona, a purpose (spec
//! §6.3). A capability may be in many groups; groups do not nest.

use jt_tenancy::{WorkspaceId, define_id};
use serde::{Deserialize, Serialize};

use crate::{CapabilityError, MAX_DESCRIPTION_CHARS, check_len, checked_name};

define_id!(
    /// A capability group.
    CapabilityGroupId
);

/// A named set of capabilities ("Brand A accounts"). Its members are kept beside it.
///
/// Stored, so reading is tolerant: an unknown field is ignored, a missing name reads as empty and
/// a missing purpose as `None`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityGroup {
    pub id: CapabilityGroupId,
    pub workspace_id: WorkspaceId,
    /// 1 to [`crate::MAX_NAME_CHARS`] characters, unique within the workspace.
    #[serde(default)]
    pub name: String,
    /// What the group stands for, at most [`MAX_DESCRIPTION_CHARS`] characters.
    #[serde(default)]
    pub purpose: Option<String>,
}

impl CapabilityGroup {
    /// A new group; the name is trimmed and checked by [`crate::validate_name`], the purpose is
    /// bounded (`TextTooLong`).
    pub fn new(
        id: CapabilityGroupId,
        workspace_id: WorkspaceId,
        name: String,
        purpose: Option<String>,
    ) -> Result<CapabilityGroup, CapabilityError> {
        let name = checked_name(name)?;
        if let Some(purpose) = &purpose {
            check_len("purpose", purpose, MAX_DESCRIPTION_CHARS)?;
        }
        Ok(CapabilityGroup {
            id,
            workspace_id,
            name,
            purpose,
        })
    }
}
