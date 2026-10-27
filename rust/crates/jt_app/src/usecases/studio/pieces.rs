//! Revision-bound, atomic agent content submission.
use super::{
    files::{self, decode, encode},
    work::{SlotOut, gated, slot_in},
};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::TenantRepos,
    usecases::{Deps, ledger_entry},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use jt_studio::*;
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use url::Url;

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MediaInput {
    HostedUrl {
        url: Url,
        mime: String,
        size_bytes: u64,
    },
    File {
        id: FileId,
    },
    Bytes {
        data: String,
        mime: String,
        filename: String,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChannelInput {
    pub text: String,
    pub media: Vec<MediaInput>,
    pub link: Option<Url>,
    /// Who may see the post on this account (`jt_studio::PRIVACY_LEVELS`; TikTok's names), else
    /// public.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub privacy: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct WirePieceInput {
    pub slot_id: SlotId,
    pub expected_revision: u64,
    pub request_key: String,
    pub text: String,
    pub media: Vec<MediaInput>,
    pub adaptations: BTreeMap<String, ChannelInput>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(try_from = "WirePieceInput", into = "WirePieceInput")]
pub struct PieceInput {
    pub slot_id: SlotId,
    pub expected_revision: u64,
    pub request_key: String,
    pub text: String,
    pub media: Vec<MediaAsset>,
    pub adaptations: BTreeMap<String, ChannelContent>,
}
impl TryFrom<MediaInput> for MediaAsset {
    type Error = AppError;
    fn try_from(i: MediaInput) -> Result<Self, AppError> {
        Ok(match i {
            MediaInput::File { id } => Self::File { id },
            MediaInput::HostedUrl {
                url,
                mime,
                size_bytes,
            } => Self::HostedUrl {
                url,
                mime,
                size_bytes,
            },
            MediaInput::Bytes {
                data,
                mime,
                filename,
            } => {
                if data.len() as u64 > 4 * files::limit(&mime)?.div_ceil(3) {
                    return Err(files::invalid());
                }
                Self::Bytes {
                    upload: MediaUpload {
                        bytes: STANDARD.decode(data).map_err(|_| files::invalid())?,
                        mime,
                        filename,
                    },
                }
            }
        })
    }
}
impl From<MediaAsset> for MediaInput {
    fn from(m: MediaAsset) -> Self {
        match m {
            MediaAsset::File { id } => Self::File { id },
            MediaAsset::HostedUrl {
                url,
                mime,
                size_bytes,
            } => Self::HostedUrl {
                url,
                mime,
                size_bytes,
            },
            MediaAsset::Bytes { upload } => Self::Bytes {
                data: STANDARD.encode(upload.bytes),
                mime: upload.mime,
                filename: upload.filename,
            },
        }
    }
}
impl TryFrom<WirePieceInput> for PieceInput {
    type Error = AppError;
    fn try_from(i: WirePieceInput) -> Result<Self, AppError> {
        let mut adaptations = BTreeMap::new();
        for (k, v) in i.adaptations {
            adaptations.insert(
                k,
                ChannelContent {
                    text: v.text,
                    media: v
                        .media
                        .into_iter()
                        .map(TryInto::try_into)
                        .collect::<Result<_, _>>()?,
                    link: v.link,
                    privacy: v.privacy,
                },
            );
        }
        Ok(Self {
            slot_id: i.slot_id,
            expected_revision: i.expected_revision,
            request_key: i.request_key,
            text: i.text,
            media: i
                .media
                .into_iter()
                .map(TryInto::try_into)
                .collect::<Result<_, _>>()?,
            adaptations,
        })
    }
}
impl From<PieceInput> for WirePieceInput {
    fn from(i: PieceInput) -> Self {
        Self {
            slot_id: i.slot_id,
            expected_revision: i.expected_revision,
            request_key: i.request_key,
            text: i.text,
            media: i.media.into_iter().map(Into::into).collect(),
            adaptations: i
                .adaptations
                .into_iter()
                .map(|(k, v)| {
                    (
                        k,
                        ChannelInput {
                            text: v.text,
                            media: v.media.into_iter().map(Into::into).collect(),
                            link: v.link,
                            privacy: v.privacy,
                        },
                    )
                })
                .collect(),
        }
    }
}
async fn normalize(
    d: &Deps,
    ctx: &Ctx,
    media: Vec<MediaAsset>,
    stored: &mut files::Staging,
) -> Result<Vec<MediaAsset>, AppError> {
    let mut out = vec![];
    for m in media {
        out.push(match m {
            MediaAsset::File { id } => MediaAsset::File { id },
            MediaAsset::HostedUrl {
                url,
                mime,
                size_bytes,
            } => {
                if size_bytes == 0 || size_bytes > files::limit(&mime)? {
                    return Err(files::invalid());
                }
                let u = d
                    .media_fetch
                    .fetch(ctx.workspace_id, &url, &mime, "asset")
                    .await?;
                files::validate_upload(&u)?;
                if u.bytes.len() as u64 != size_bytes {
                    return Err(files::invalid());
                }
                MediaAsset::HostedUrl {
                    url,
                    mime,
                    size_bytes,
                }
            }
            MediaAsset::Bytes { upload: u } => {
                let f = stored.put(d, ctx.workspace_id, u).await?;
                let id = f.id;
                MediaAsset::File { id }
            }
        })
    }
    Ok(out)
}
async fn validate(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    i: &PieceInput,
) -> Result<(Slot, jt_strategy::StrategyVersion), AppError> {
    let frame = gated(r, ctx).await?;
    r.studio_control().lock_control().await?;
    let s = r
        .studio()
        .get_slot(i.slot_id)
        .await?
        .ok_or_else(|| AppError::not_found("slot"))?;
    if s.revision != i.expected_revision
        || !matches!(s.state, SlotState::Planned | SlotState::Ready)
    {
        return Err(AppError::conflict("slot revision changed"));
    }
    // A frozen attempt cannot be replaced while a provider may still accept it.
    if r.studio()
        .slot_evidence(s.id)
        .await?
        .0
        .iter()
        .any(|a| matches!(a.state(), PublishState::Sending | PublishState::Unknown))
    {
        return Err(AppError::conflict("publication in flight"));
    }
    let arm = r
        .studio()
        .get_arm(s.chain.arm_id)
        .await?
        .ok_or_else(|| AppError::not_found("arm"))?;
    let c = r
        .capabilities()
        .find(s.capability_id)
        .await?
        .ok_or_else(|| AppError::not_found("capability"))?;
    let birth = r
        .strategy()
        .find(s.chain.born_version_id)
        .await?
        .ok_or_else(|| AppError::not_found("birth strategy"))?;
    let bh = r.hypotheses().list(birth.id).await?;
    let hs = r.hypotheses().list(frame.id).await?;
    let groups: Vec<_> = r
        .capability_groups()
        .list()
        .await?
        .into_iter()
        .filter(|(_, ids)| ids.contains(&c.id))
        .map(|(g, _)| g.id.0)
        .collect();
    validate_chain(
        &s.chain,
        &ChainContext {
            workspace_id: ctx.workspace_id,
            birth_version: &birth,
            birth_hypotheses: &bh,
            current_version: &frame,
            hypotheses: &hs,
            arm: &arm,
            target: &c,
            target_group_ids: &groups,
            supported_kinds: super::chain::ORGANIC_KINDS,
            lane: jt_strategy::LaneKind::Organic,
        },
    )
    .map_err(|_| AppError::conflict("invalid content chain"))?;
    for account in i.adaptations.keys() {
        if c.external_id.as_deref() != Some(account.as_str()) {
            return Err(AppError::validation(
                "adaptation must name the slot account",
                json!({"field":"adaptations"}),
            ));
        }
    }
    Ok((s, frame))
}
pub async fn piece_submit(d: &Deps, ctx: &Ctx, i: PieceInput) -> Result<SlotOut, AppError> {
    let mut stage = files::Staging::new();
    let result = submit(d, ctx, i, &mut stage).await;
    stage.compensate(d, ctx.workspace_id).await;
    result
}
async fn submit(
    d: &Deps,
    ctx: &Ctx,
    i: PieceInput,
    stored: &mut files::Staging,
) -> Result<SlotOut, AppError> {
    ctx.require(Permission::StudioWork)?;
    files::key(&i.request_key)?;
    let payload = json!(crate::usecases::hash_token(&encode(&i)?.to_string()));
    {
        let mut r = d.uow.tenant(ctx.workspace_id).await?;
        gated(r.as_mut(), ctx).await?;
        if let Some(v) = r
            .studio()
            .request_replay("studio.piece_submit", &i.request_key, &payload)
            .await?
        {
            return decode(v);
        }
        validate(r.as_mut(), ctx, &i).await?;
    }
    let media = normalize(d, ctx, i.media.clone(), stored).await?;
    let mut adaptations = BTreeMap::new();
    for (key, a) in &i.adaptations {
        adaptations.insert(
            key.clone(),
            ChannelContent {
                text: a.text.clone(),
                media: normalize(d, ctx, a.media.clone(), stored).await?,
                link: a.link.clone(),
                privacy: a.privacy.clone(),
            },
        );
    }
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    gated(r.as_mut(), ctx).await?;
    if let Some(v) = r
        .studio()
        .request_replay("studio.piece_submit", &i.request_key, &payload)
        .await?
    {
        return decode(v);
    }
    let (s, frame) = validate(r.as_mut(), ctx, &i).await?;
    for f in &stored.files {
        r.studio().save_file(f.clone()).await?;
    }
    let p = Piece {
        id: PieceId(d.ids.uuid()),
        chain: s.chain,
        revision: i
            .expected_revision
            .checked_add(1)
            .ok_or_else(|| AppError::conflict("revision overflow"))?,
        text: i.text,
        media,
        adaptations,
    };
    p.validate_persisted().map_err(|_| files::invalid())?;
    // Recheck physical availability while holding the same control fence as cleanup.
    // Metadata alone can be stale after delete succeeds and its marker transaction fails.
    for m in p
        .media
        .iter()
        .chain(p.adaptations.values().flat_map(|a| a.media.iter()))
    {
        if let MediaAsset::File { id } = m {
            let f = r
                .studio()
                .get_file(*id)
                .await?
                .ok_or_else(|| AppError::not_found("file"))?;
            if f.deleted_at.is_some() {
                return Err(AppError::not_found("file"));
            }
            files::available(d, ctx.workspace_id, &f).await?;
        }
    }
    r.studio()
        .save_piece(s.id, i.expected_revision, p.clone(), &i.request_key)
        .await?;
    r.ledger().append(ledger_entry(ctx,"studio.piece_submit","studio_slot",s.id,json!({"piece_id":p.id,"revision":p.revision,"born_version_id":p.chain.born_version_id,"executed_version_id":frame.id}))?).await?;
    let out = slot_in(r.as_mut(), s.id, &frame).await?;
    r.studio()
        .request_receipt(
            "studio.piece_submit",
            &i.request_key,
            &payload,
            &encode(&out)?,
        )
        .await?;
    stored.commit_started = true;
    r.commit().await?;
    Ok(out)
}
