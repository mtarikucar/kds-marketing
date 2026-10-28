//! The TikTok posting screen. TikTok's Content Sharing Guidelines
//! (<https://developers.tiktok.com/doc/content-sharing-guidelines>, "Required UX Implementation in
//! Your App") ask that a post reach TikTok only after a human chose its settings against the
//! account's latest `creator_info` and expressly consented, whatever else the client automates.
//! So a Studio piece for a `tiktok` capability is published only with an approval carrying that
//! choice ([`crate::ApprovalReceipt::tiktok`]), even in a lane that needs no human approval: a
//! TikTok-only exception to the default no-approval lane policy, required by TikTok.
//!
//! The human chooses there how it goes out: posted directly (the Direct Post), or sent to their
//! TikTok drafts to finish editing and post in TikTok (the Content Posting API's upload,
//! <https://developers.tiktok.com/doc/content-posting-api-reference-upload-video>; for photos,
//! `post_mode` `MEDIA_UPLOAD`, <https://developers.tiktok.com/doc/content-posting-api-reference-photo-post>).
//! A draft carries only what those references take for it: a video nothing but the file (the
//! video upload's init has no `post_info`), photos their caption (`title` and `description`;
//! the privacy, the comment switch and the commercial toggles are the Direct Post's). The rest
//! is chosen in TikTok.
//!
//! Pure rules: the application reads the account fresh before showing the screen and before
//! accepting a choice, and the adapter checks the choice again before it sends anything.
use crate::MediaUpload;
use serde::{Deserialize, Serialize};
use url::Url;

/// The longest video caption, in UTF-16 units (the Direct Post reference's `title`,
/// <https://developers.tiktok.com/doc/content-posting-api-reference-direct-post>).
pub const MAX_TIKTOK_TITLE_UNITS: usize = 2200;

/// The longest photo post description, in UTF-16 units (the photo post reference's
/// `description`, <https://developers.tiktok.com/doc/content-posting-api-reference-photo-post>).
pub const MAX_TIKTOK_DESCRIPTION_UNITS: usize = 4000;

/// Whether a piece for a capability of kind `kind_key` is posted only from its provider's posting
/// screen, whatever the lane's or the capability's approval policy: TikTok's alone.
pub fn requires_posting_screen(kind_key: &str) -> bool {
    kind_key == "tiktok"
}

/// What TikTok's `creator_info` says about the account a post goes to, read when the posting
/// screen is shown and again before a post is sent
/// (<https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info>).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TiktokCreator {
    /// `creator_nickname`: the account the screen names.
    pub nickname: Option<String>,
    /// `creator_username`.
    pub username: Option<String>,
    /// `creator_avatar_url` (TikTok's URL lives two hours).
    pub avatar_url: Option<Url>,
    /// `privacy_level_options`: the only privacy levels a post may take.
    pub privacy_level_options: Vec<String>,
    /// Whether the creator turned comments, duets and stitches off in their TikTok settings.
    pub comment_disabled: bool,
    pub duet_disabled: bool,
    pub stitch_disabled: bool,
    /// `max_video_post_duration_sec`: the longest video the account may post.
    pub max_video_post_duration_sec: Option<u32>,
    /// Why the account may not post at this moment, by TikTok's error code
    /// (`spam_risk_too_many_posts`, `spam_risk_user_banned_from_posting`,
    /// `reached_active_user_cap`); `None` when it may.
    pub cannot_post: Option<String>,
}

/// What a TikTok post carries, as the screen's rules need it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TiktokMedia {
    /// One video, and its length when it could be read ([`MediaUpload::video_duration_ms`]).
    Video { duration_ms: Option<u64> },
    /// Photos: TikTok offers comments only on them.
    Photos,
}

impl TiktokMedia {
    /// The longest caption the post takes, in UTF-16 units.
    pub fn max_title_units(&self) -> usize {
        match self {
            TiktokMedia::Video { .. } => MAX_TIKTOK_TITLE_UNITS,
            TiktokMedia::Photos => MAX_TIKTOK_DESCRIPTION_UNITS,
        }
    }
}

/// How a TikTok post goes out.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TiktokPostMode {
    /// Posted on the account directly, with the screen's settings (the Direct Post).
    #[default]
    DirectPost,
    /// Sent to the creator's TikTok drafts: TikTok notifies them in its inbox, and they finish
    /// editing and post it in TikTok (the upload).
    Draft,
}

/// What a human chose on the posting screen. Nothing is preset: the privacy has no default, the
/// interactions and the commercial content disclosure start off.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TiktokPost {
    /// Posted directly or sent as a draft; a choice recorded before drafts existed was a direct
    /// post. A draft leaves the privacy unchosen and every switch below off.
    #[serde(default)]
    pub mode: TiktokPostMode,
    /// The caption as the human left it: a video's title, photos' description. It replaces the
    /// drafted text and link.
    pub title: String,
    /// Who may see the post: one of the account's `privacy_level_options`.
    pub privacy_level: String,
    /// Allow Comment, Duet and Stitch (a photo post offers comments only).
    pub allow_comment: bool,
    pub allow_duet: bool,
    pub allow_stitch: bool,
    /// The commercial content disclosure toggle.
    pub disclose_commercial: bool,
    /// "Your brand": the creator promotes themself or their own business (labelled
    /// "Promotional content"; TikTok's `brand_organic_toggle`).
    pub your_brand: bool,
    /// "Branded content": a third party (labelled "Paid partnership"; `brand_content_toggle`).
    pub branded_content: bool,
}

/// The `post_info` switches a choice sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TiktokPostFlags {
    pub disable_comment: bool,
    pub disable_duet: bool,
    pub disable_stitch: bool,
    pub brand_content_toggle: bool,
    pub brand_organic_toggle: bool,
}

/// Why a choice cannot be posted; [`TiktokPostRefusal::reason`] is its stable reason.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum TiktokPostRefusal {
    /// `creator_info` says the account may not post at this moment: try again later.
    #[error("tiktok_cannot_post_now")]
    CannotPostNow,
    #[error("tiktok_privacy_not_chosen")]
    PrivacyNotChosen,
    /// Not among the account's `privacy_level_options`.
    #[error("tiktok_privacy_not_offered")]
    PrivacyNotOffered,
    /// Branded content can only be public or seen by friends.
    #[error("tiktok_branded_content_private")]
    BrandedContentPrivate,
    /// The disclosure is on, but names neither "Your brand" nor "Branded content".
    #[error("tiktok_commercial_unspecified")]
    CommercialUnspecified,
    /// "Your brand" or "Branded content" chosen with the disclosure off.
    #[error("tiktok_commercial_not_disclosed")]
    CommercialNotDisclosed,
    /// An interaction the creator turned off was allowed.
    #[error("tiktok_interaction_disabled")]
    InteractionDisabled,
    /// Duet or Stitch allowed on photos.
    #[error("tiktok_photo_interaction")]
    PhotoInteraction,
    /// Longer than `max_video_post_duration_sec`.
    #[error("tiktok_video_too_long")]
    VideoTooLong,
    #[error("tiktok_title_too_long")]
    TitleTooLong,
    /// A draft naming what TikTok does not take for it: a privacy, an interaction, the
    /// commercial disclosure, or a video's caption.
    #[error("tiktok_draft_settings")]
    DraftSettings,
}

impl TiktokPostRefusal {
    /// The stable reason, as refusals name it.
    pub fn reason(&self) -> String {
        self.to_string()
    }
}

impl TiktokPost {
    /// Whether the post is sent to the creator's TikTok drafts.
    pub fn is_draft(&self) -> bool {
        self.mode == TiktokPostMode::Draft
    }

    /// Whether this choice may be accepted on the posting screen for `creator`'s account and
    /// `media`: [`TiktokPost::check_postable`], and no interaction the screen greys out (one the
    /// creator turned off, Duet or Stitch on photos) allowed.
    pub fn check(
        &self,
        creator: &TiktokCreator,
        media: &TiktokMedia,
    ) -> Result<(), TiktokPostRefusal> {
        self.check_postable(creator, media)?;
        if self.is_draft() {
            return Ok(());
        }
        if (self.allow_comment && creator.comment_disabled)
            || (self.allow_duet && creator.duet_disabled)
            || (self.allow_stitch && creator.stitch_disabled)
        {
            return Err(TiktokPostRefusal::InteractionDisabled);
        }
        if *media == TiktokMedia::Photos && (self.allow_duet || self.allow_stitch) {
            return Err(TiktokPostRefusal::PhotoInteraction);
        }
        Ok(())
    }

    /// Whether this (accepted) choice may be sent to `creator`'s account now: the account may
    /// post, the privacy is one it is offered, branded content is not private, a disclosed
    /// commercial post names whom it promotes, a video is no longer than the account may post
    /// (when its length could be read) and the caption fits. An interaction the creator turned
    /// off since is not a refusal: it is sent off ([`TiktokPost::flags`]). A draft: the account
    /// may post, it names nothing but what TikTok takes for it (see the module docs), the video
    /// is no longer than the account may post and the caption fits.
    pub fn check_postable(
        &self,
        creator: &TiktokCreator,
        media: &TiktokMedia,
    ) -> Result<(), TiktokPostRefusal> {
        if creator.cannot_post.is_some() {
            return Err(TiktokPostRefusal::CannotPostNow);
        }
        if self.is_draft() {
            let settings = !self.privacy_level.trim().is_empty()
                || self.allow_comment
                || self.allow_duet
                || self.allow_stitch
                || self.disclose_commercial
                || self.your_brand
                || self.branded_content;
            let video_caption =
                matches!(media, TiktokMedia::Video { .. }) && !self.title.trim().is_empty();
            if settings || video_caption {
                return Err(TiktokPostRefusal::DraftSettings);
            }
            return check_media(&self.title, creator, media);
        }
        if self.privacy_level.trim().is_empty() {
            return Err(TiktokPostRefusal::PrivacyNotChosen);
        }
        if !creator.privacy_level_options.contains(&self.privacy_level) {
            return Err(TiktokPostRefusal::PrivacyNotOffered);
        }
        if self.disclose_commercial && !self.your_brand && !self.branded_content {
            return Err(TiktokPostRefusal::CommercialUnspecified);
        }
        if !self.disclose_commercial && (self.your_brand || self.branded_content) {
            return Err(TiktokPostRefusal::CommercialNotDisclosed);
        }
        if self.branded_content && self.privacy_level == "SELF_ONLY" {
            return Err(TiktokPostRefusal::BrandedContentPrivate);
        }
        check_media(&self.title, creator, media)
    }

    /// The switches this choice sends to `creator`'s account: an interaction is on only when the
    /// human allowed it and the creator has not turned it off; the commercial toggles only with
    /// the disclosure on.
    pub fn flags(&self, creator: &TiktokCreator) -> TiktokPostFlags {
        TiktokPostFlags {
            disable_comment: !self.allow_comment || creator.comment_disabled,
            disable_duet: !self.allow_duet || creator.duet_disabled,
            disable_stitch: !self.allow_stitch || creator.stitch_disabled,
            brand_content_toggle: self.disclose_commercial && self.branded_content,
            brand_organic_toggle: self.disclose_commercial && self.your_brand,
        }
    }
}

/// A video no longer than `creator`'s account may post (when its length could be read), and a
/// caption `title` that fits `media`.
fn check_media(
    title: &str,
    creator: &TiktokCreator,
    media: &TiktokMedia,
) -> Result<(), TiktokPostRefusal> {
    if let (
        TiktokMedia::Video {
            duration_ms: Some(length),
        },
        Some(max),
    ) = (media, creator.max_video_post_duration_sec)
        && *length > u64::from(max) * 1000
    {
        return Err(TiktokPostRefusal::VideoTooLong);
    }
    if title.encode_utf16().count() > media.max_title_units() {
        return Err(TiktokPostRefusal::TitleTooLong);
    }
    Ok(())
}

impl MediaUpload {
    /// The length of an MP4 video (`video/mp4`, compared ignoring case and surrounding space), in
    /// milliseconds, read from its movie header (`moov/mvhd`), or for a fragmented video whose
    /// header names none from its extends header (`moov/mvex/mehd`); `None` for another type, or
    /// when no length can be read.
    pub fn video_duration_ms(&self) -> Option<u64> {
        if !self.mime.trim().eq_ignore_ascii_case("video/mp4") {
            return None;
        }
        crate::mp4::duration_ms(&self.bytes)
    }
}
