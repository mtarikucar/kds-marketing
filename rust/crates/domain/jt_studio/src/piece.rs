use crate::{Chain, FileId, PieceId, StudioError, require_id};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt};
use url::Url;

/// Connector transport bytes. Never serializable; T5's strict base64 input normalizes these
/// into a File before storing a piece. Debug intentionally omits bytes.
#[derive(Clone, PartialEq, Eq)]
pub struct MediaUpload {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub filename: String,
}
impl fmt::Debug for MediaUpload {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MediaUpload")
            .field("bytes", &format_args!("<{} bytes>", self.bytes.len()))
            .field("mime", &self.mime)
            .field("filename", &self.filename)
            .finish()
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MediaAsset {
    HostedUrl {
        url: Url,
        mime: String,
        size_bytes: u64,
    },
    File {
        id: FileId,
    },
    #[serde(skip)]
    Bytes {
        upload: MediaUpload,
    },
}
impl MediaAsset {
    pub fn validate_persisted(&self) -> Result<(), StudioError> {
        match self {
            Self::Bytes { .. } => Err(StudioError::UnstoredMedia),
            Self::File { id } => require_id(id.0, "file_id"),
            Self::HostedUrl {
                url,
                mime,
                size_bytes,
            } => {
                validate_public_url(url)?;
                if mime.trim().is_empty() || *size_bytes == 0 {
                    return Err(StudioError::InvalidEvidence("media metadata"));
                }
                Ok(())
            }
        }
    }
}
pub(crate) fn validate_public_url(url: &Url) -> Result<(), StudioError> {
    if !matches!(url.scheme(), "https" | "http")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(StudioError::InvalidEvidence("public URL"));
    }
    // DNS, egress, MIME sniffing and bounded fetching belong to T5, not a pure URL parser.
    Ok(())
}
/// Who may see a post, by TikTok's names (`privacy_level`): the values a channel adaptation's
/// `privacy` takes. A provider without such a setting ignores it.
pub const PRIVACY_LEVELS: &[&str] = &[
    "PUBLIC_TO_EVERYONE",
    "MUTUAL_FOLLOW_FRIENDS",
    "FOLLOWER_OF_CREATOR",
    "SELF_ONLY",
];
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelContent {
    pub text: String,
    pub media: Vec<MediaAsset>,
    pub link: Option<Url>,
    /// Who may see the post (one of [`PRIVACY_LEVELS`]); `None`: public. Absent from stored
    /// pieces written before it existed, and never written when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Piece {
    pub id: PieceId,
    pub chain: Chain,
    pub revision: u64,
    pub text: String,
    pub media: Vec<MediaAsset>,
    pub adaptations: BTreeMap<String, ChannelContent>,
}
impl Piece {
    pub fn validate_persisted(&self) -> Result<(), StudioError> {
        require_id(self.id.0, "piece_id")?;
        self.chain.validate()?;
        if self.revision == 0 {
            return Err(StudioError::RevisionConflict);
        }
        for media in &self.media {
            media.validate_persisted()?;
        }
        for (account, content) in &self.adaptations {
            if account.trim().is_empty() {
                return Err(StudioError::InvalidEvidence("adaptation account"));
            }
            for media in &content.media {
                media.validate_persisted()?;
            }
            if let Some(url) = &content.link {
                validate_public_url(url)?;
            }
            if content
                .privacy
                .as_deref()
                .is_some_and(|p| !PRIVACY_LEVELS.contains(&p))
            {
                return Err(StudioError::InvalidEvidence("privacy"));
            }
        }
        Ok(())
    }
}
