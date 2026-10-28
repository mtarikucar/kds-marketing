//! Posts through the Content Posting API: the checks made before anything is sent, the creator's
//! settings (read before every post, and for the posting screen), a video's init and chunked
//! upload, a photo post's init, the receipt, and the status a receipt resolves to (see the crate
//! docs, "Posts", "The posting screen" and "Status").

use jt_app::ports::connectors::{
    MediaUpload, PublishReceipt, PublishRequest, PublishResolution, TiktokCreator, TiktokMedia,
    TiktokPost, TiktokPostFlags, TiktokPostRefusal,
};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::{Map, Value, json};
use url::Url;

use crate::client::{Auth, Body, Chunk, Effect, Endpoint, error_code, missing, text, words};
use crate::credential::{kind_of, token_of};
use crate::{
    CANNOT_POST_CODES, CHUNK_BYTES, MAX_DESCRIPTION_UNITS, MAX_PHOTOS, MAX_TITLE_UNITS,
    MAX_VIDEO_BYTES, PRIVACY_LEVELS, TiktokConnector, VIDEO_MIME,
};

/// Why a post without the posting screen's choice is refused: TikTok's guidelines leave the
/// privacy, the interactions and the commercial content disclosure to a human.
pub(crate) const NO_CHOICE: &str = "a TikTok post needs what a human chose on its posting screen \
     (privacy, interactions, commercial content)";

/// The longest nickname taken, in characters.
const MAX_NICKNAME_CHARS: usize = 200;

/// Why a post with neither a video nor photos is refused: TikTok has no text-only posts.
pub(crate) const NOTHING_TO_POST: &str =
    "a TikTok post is a video or photos: text alone cannot be posted";

/// Why a post with both a video (bytes) and photos (URLs) is refused.
pub(crate) const VIDEO_AND_PHOTOS: &str =
    "a TikTok post is one uploaded video or photos by URL, not both";

/// The longest publish id taken, in characters (TikTok's are at most 64).
const MAX_PUBLISH_ID_CHARS: usize = 64;

/// The longest video id taken, in digits (TikTok's are int64: at most 19).
const MAX_VIDEO_ID_DIGITS: usize = 32;

/// The longest TikTok handle taken, in characters.
const MAX_HANDLE_CHARS: usize = 24;

/// Where a post's public page is (a browser URL, never fetched).
const PERMALINK_BASE: &str = "https://www.tiktok.com";

/// The statuses of a post TikTok is still working on
/// (<https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status>).
const PENDING_STATUSES: &[&str] = &[
    "PROCESSING_UPLOAD",
    "PROCESSING_DOWNLOAD",
    "SEND_TO_USER_INBOX",
];

/// `POST {api}/v2/post/publish/creator_info/query/`, what TikTok says about the account a post
/// goes to (<https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info>):
/// a read (it changes nothing), tried once more when no answer arrived. An account that may not
/// post at this moment is an error (see the crate docs, "Errors").
pub(crate) async fn creator_info(
    connector: &TiktokConnector,
    token: &str,
) -> Result<TiktokCreator, ConnectorError> {
    read_creator(connector, token, &[]).await
}

/// The account as the posting screen shows it ([`creator_info`]): an account that may not post at
/// this moment ([`CANNOT_POST_CODES`]) is not an error but says why in `cannot_post`.
pub(crate) async fn posting_creator(
    connector: &TiktokConnector,
    cred: &Credential,
    public: &Value,
) -> Result<TiktokCreator, ConnectorError> {
    kind_of(public)?;
    let token = token_of(cred, "read the creator's posting settings")?;
    read_creator(connector, token, CANNOT_POST_CODES).await
}

/// `creator_info`, its 2xx answers with a code of `taken` read as an account that may not post.
async fn read_creator(
    connector: &TiktokConnector,
    token: &str,
    taken: &[&str],
) -> Result<TiktokCreator, ConnectorError> {
    let url = connector.api_url(&["v2", "post", "publish", "creator_info", "query", ""], &[]);
    let answer = connector
        .call_taking(
            Method::POST,
            url,
            Auth::Bearer(token),
            &Body::EmptyJson,
            Endpoint::Api,
            Effect::Read,
            taken,
        )
        .await?;
    let cannot_post = error_code(&answer)
        .filter(|code| *code != "ok")
        .map(str::to_owned);
    let data = &answer["data"];
    if !data.is_object() && cannot_post.is_none() {
        return Err(missing("creator info"));
    }
    let flag = |name: &str| data[name].as_bool().unwrap_or(false);
    Ok(TiktokCreator {
        nickname: words(&data["creator_nickname"])
            .map(|n| n.chars().take(MAX_NICKNAME_CHARS).collect()),
        username: text(&data["creator_username"]),
        // Shown as an image: an https URL only.
        avatar_url: words(&data["creator_avatar_url"])
            .and_then(|u| Url::parse(u).ok())
            .filter(|u| u.scheme() == "https"),
        privacy_level_options: data["privacy_level_options"]
            .as_array()
            .map(|options| {
                options
                    .iter()
                    .filter_map(words)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        comment_disabled: flag("comment_disabled"),
        duet_disabled: flag("duet_disabled"),
        stitch_disabled: flag("stitch_disabled"),
        max_video_post_duration_sec: data["max_video_post_duration_sec"]
            .as_u64()
            .and_then(|s| u32::try_from(s).ok()),
        cannot_post,
    })
}

/// How a video is cut for `FILE_UPLOAD` (see the crate docs).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ChunkPlan {
    /// The video's size, in bytes.
    pub(crate) size: u64,
    /// `chunk_size`: every chunk's size but the last's.
    pub(crate) chunk_size: u64,
    /// `total_chunk_count`.
    pub(crate) count: u64,
}

impl ChunkPlan {
    /// The plan of a video of `size` bytes; `Permanent` for an empty one or one over
    /// [`MAX_VIDEO_BYTES`].
    pub(crate) fn of(size: u64) -> Result<ChunkPlan, ConnectorError> {
        if size == 0 {
            return Err(ConnectorError::permanent("the video is empty"));
        }
        if size > MAX_VIDEO_BYTES {
            return Err(ConnectorError::permanent("a TikTok video is at most 4 GB"));
        }
        if size < CHUNK_BYTES {
            return Ok(ChunkPlan {
                size,
                chunk_size: size,
                count: 1,
            });
        }
        Ok(ChunkPlan {
            size,
            chunk_size: CHUNK_BYTES,
            count: size / CHUNK_BYTES,
        })
    }

    /// The byte range of chunk `index` (`first..=last`): the last chunk takes every byte left.
    pub(crate) fn range(&self, index: u64) -> (u64, u64) {
        let first = index * self.chunk_size;
        let last = if index + 1 == self.count {
            self.size - 1
        } else {
            first + self.chunk_size - 1
        };
        (first, last)
    }
}

/// What a request posts, once checked.
enum Post<'a> {
    /// One video, its title and how it is cut.
    Video {
        media: &'a MediaUpload,
        mime: String,
        title: Option<String>,
        plan: ChunkPlan,
    },
    /// Photos by URL, and their description.
    Photos {
        urls: &'a [Url],
        description: Option<String>,
    },
}

/// The request's text (none when blank) and its link on a line of its own after it; `Permanent`
/// when longer than `max` UTF-16 units (the TikTok `what`).
fn compose(
    request: &PublishRequest,
    max: usize,
    what: &str,
) -> Result<Option<String>, ConnectorError> {
    let text = Some(request.text.as_str()).filter(|t| !t.trim().is_empty());
    let composed = match (text, request.link.as_ref()) {
        (Some(text), Some(link)) => Some(format!("{text}\n\n{link}")),
        (Some(text), None) => Some(text.to_owned()),
        (None, Some(link)) => Some(link.to_string()),
        (None, None) => None,
    };
    if let Some(composed) = &composed {
        let units = composed.encode_utf16().count();
        if units > max {
            return Err(ConnectorError::permanent(format!(
                "a TikTok {what} is at most {max} UTF-16 units (the text and the link); this one \
                 is {units}"
            )));
        }
    }
    Ok(composed)
}

/// What `request` posts, once every check of the crate docs passed; nothing is sent.
fn plan(request: &PublishRequest) -> Result<Post<'_>, ConnectorError> {
    match (request.media.as_slice(), request.media_urls.as_slice()) {
        ([], []) => Err(ConnectorError::permanent(NOTHING_TO_POST)),
        ([_, ..], [_, ..]) => Err(ConnectorError::permanent(VIDEO_AND_PHOTOS)),
        ([media], []) => {
            let mime = media.mime.trim().to_ascii_lowercase();
            if mime != VIDEO_MIME {
                return Err(ConnectorError::permanent(
                    "TikTok takes one video/mp4 upload; photos go by URL",
                ));
            }
            let plan = ChunkPlan::of(media.bytes.len() as u64)?;
            let title = compose(request, MAX_TITLE_UNITS, "video title")?;
            Ok(Post::Video {
                media,
                mime,
                title,
                plan,
            })
        }
        ([_, _, ..], []) => Err(ConnectorError::permanent("a TikTok post carries one video")),
        ([], urls) => {
            if urls.len() > MAX_PHOTOS {
                return Err(ConnectorError::permanent(format!(
                    "a TikTok post carries at most {MAX_PHOTOS} photos"
                )));
            }
            if urls.iter().any(|u| u.scheme() != "https") {
                return Err(ConnectorError::permanent(
                    "TikTok pulls photos over https only",
                ));
            }
            let description = compose(request, MAX_DESCRIPTION_UNITS, "photo description")?;
            Ok(Post::Photos { urls, description })
        }
    }
}

/// The posting screen's choice of `request`, its privacy one of [`PRIVACY_LEVELS`] as TikTok
/// names them; `Permanent` without a choice ([`NO_CHOICE`]), without a privacy, or for another
/// name. Nothing is defaulted.
fn choice_of(request: &PublishRequest) -> Result<&TiktokPost, ConnectorError> {
    let choice = request
        .tiktok
        .as_ref()
        .ok_or_else(|| ConnectorError::permanent(NO_CHOICE))?;
    if choice.privacy_level.trim().is_empty() {
        return Err(ConnectorError::permanent(
            "no privacy level was chosen on the posting screen",
        ));
    }
    if !PRIVACY_LEVELS.contains(&choice.privacy_level.as_str()) {
        return Err(ConnectorError::permanent("not a TikTok privacy level"));
    }
    Ok(choice)
}

/// Why `choice` cannot be sent to `creator`'s account now, as an error: a privacy the account is
/// not offered is `Permission` (an app TikTok has not audited is offered `SELF_ONLY` only), an
/// account that may not post `Throttle`, anything else `Permanent`.
fn refusal(
    e: TiktokPostRefusal,
    choice: &TiktokPost,
    creator: &TiktokCreator,
    media: &TiktokMedia,
) -> ConnectorError {
    match e {
        TiktokPostRefusal::PrivacyNotOffered => ConnectorError::permission(format!(
            "privacy level {} not available (app not audited or private account)",
            choice.privacy_level
        )),
        TiktokPostRefusal::CannotPostNow => ConnectorError::throttle(None),
        TiktokPostRefusal::PrivacyNotChosen => {
            ConnectorError::permanent("no privacy level was chosen on the posting screen")
        }
        TiktokPostRefusal::BrandedContentPrivate => {
            ConnectorError::permanent("branded content cannot be private (SELF_ONLY)")
        }
        TiktokPostRefusal::CommercialUnspecified => ConnectorError::permanent(
            "the commercial content disclosure names neither your brand nor branded content",
        ),
        TiktokPostRefusal::CommercialNotDisclosed => ConnectorError::permanent(
            "your brand or branded content chosen without the commercial content disclosure",
        ),
        TiktokPostRefusal::VideoTooLong => {
            let length = match media {
                TiktokMedia::Video {
                    duration_ms: Some(ms),
                } => ms.div_ceil(1000),
                _ => 0,
            };
            ConnectorError::permanent(format!(
                "the video is {length} s long; this TikTok account posts videos of at most {} s",
                creator.max_video_post_duration_sec.unwrap_or_default()
            ))
        }
        other => ConnectorError::permanent(format!("the post was refused: {other}")),
    }
}

/// `id` when it can be a publish id: 1 to [`MAX_PUBLISH_ID_CHARS`] characters, none of them
/// space or control.
fn publish_id(id: &str) -> Option<&str> {
    let ok = (1..=MAX_PUBLISH_ID_CHARS).contains(&id.chars().count())
        && !id.chars().any(|c| c.is_whitespace() || c.is_control());
    ok.then_some(id)
}

/// `id` when it can be a TikTok video id: 1 to [`MAX_VIDEO_ID_DIGITS`] ASCII digits; else
/// `Permanent`.
pub(crate) fn video_id(id: &str) -> Result<&str, ConnectorError> {
    let ok =
        (1..=MAX_VIDEO_ID_DIGITS).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit());
    if ok {
        Ok(id)
    } else {
        Err(ConnectorError::permanent(
            "not a TikTok video id (a post TikTok names no public id for has no counters)",
        ))
    }
}

/// Whether `name` is a TikTok handle that cannot change a URL's path: 1 to 24 ASCII letters,
/// digits, `_` or `.`, not only dots.
fn is_handle(name: &str) -> bool {
    (1..=MAX_HANDLE_CHARS).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'.')
        && !name.bytes().all(|b| b == b'.')
}

/// Where video `id` is seen: under the account's handle, the first of `public["username"]`, the
/// last probe's (`public["facts"]["username"]`) and the OAuth asset's
/// (`public["asset"]["username"]`) that is one (a leading `@` dropped); `None` without one.
fn permalink(public: &Value, id: &str) -> Option<Url> {
    let handle = [
        &public["username"],
        &public["facts"]["username"],
        &public["asset"]["username"],
    ]
    .into_iter()
    .filter_map(Value::as_str)
    .map(|u| u.trim().trim_start_matches('@'))
    .find(|u| is_handle(u))?;
    Url::parse(&format!("{PERMALINK_BASE}/@{handle}/video/{id}")).ok()
}

/// Publishes `request` (see the crate docs): checks it, reads the creator's settings, then posts
/// the video or the photos. The receipt is the publish id.
pub(crate) async fn publish(
    connector: &TiktokConnector,
    cred: &Credential,
    public: &Value,
    request: &PublishRequest,
) -> Result<PublishReceipt, ConnectorError> {
    kind_of(public)?;
    let token = token_of(cred, "publish")?;
    let post = plan(request)?;
    let choice = choice_of(request)?;
    let creator = creator_info(connector, token).await?;
    let media = match &post {
        Post::Video { media, .. } => TiktokMedia::Video {
            duration_ms: media.video_duration_ms(),
        },
        Post::Photos { .. } => TiktokMedia::Photos,
    };
    choice
        .check_postable(&creator, &media)
        .map_err(|e| refusal(e, choice, &creator, &media))?;
    let flags = choice.flags(&creator);
    let privacy = choice.privacy_level.as_str();
    let external_id = match post {
        Post::Video {
            media,
            mime,
            title,
            plan,
        } => post_video(connector, token, &flags, privacy, media, &mime, title, plan).await?,
        Post::Photos { urls, description } => {
            post_photos(connector, token, &flags, privacy, urls, description).await?
        }
    };
    Ok(PublishReceipt {
        external_id,
        url: None,
    })
}

/// The `post_info` both kinds of post share: the chosen privacy, and the switches of the choice.
fn post_info(flags: &TiktokPostFlags, privacy: &str) -> Map<String, Value> {
    let mut info = Map::new();
    info.insert("privacy_level".to_owned(), json!(privacy));
    info.insert("disable_comment".to_owned(), json!(flags.disable_comment));
    info.insert(
        "brand_content_toggle".to_owned(),
        json!(flags.brand_content_toggle),
    );
    info.insert(
        "brand_organic_toggle".to_owned(),
        json!(flags.brand_organic_toggle),
    );
    info
}

/// A video: `POST /v2/post/publish/video/init/`, then each chunk `PUT` to the upload URL, one
/// after the other (<https://developers.tiktok.com/doc/content-posting-api-reference-direct-post>,
/// <https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide>).
#[allow(clippy::too_many_arguments)]
async fn post_video(
    connector: &TiktokConnector,
    token: &str,
    flags: &TiktokPostFlags,
    privacy: &str,
    media: &MediaUpload,
    mime: &str,
    title: Option<String>,
    plan: ChunkPlan,
) -> Result<String, ConnectorError> {
    let mut info = post_info(flags, privacy);
    if let Some(title) = title {
        info.insert("title".to_owned(), json!(title));
    }
    info.insert("disable_duet".to_owned(), json!(flags.disable_duet));
    info.insert("disable_stitch".to_owned(), json!(flags.disable_stitch));
    let body = json!({
        "post_info": info,
        "source_info": {
            "source": "FILE_UPLOAD",
            "video_size": plan.size,
            "chunk_size": plan.chunk_size,
            "total_chunk_count": plan.count,
        },
    });
    let url = connector.api_url(&["v2", "post", "publish", "video", "init", ""], &[]);
    // Nothing is posted before the whole video is uploaded: a lost answer is not `Unknown`.
    let answer = connector
        .call(
            Method::POST,
            url,
            Auth::Bearer(token),
            &Body::Json(body),
            Endpoint::Api,
            Effect::Stage,
        )
        .await?;
    let data = &answer["data"];
    let id = text(&data["publish_id"])
        .filter(|id| publish_id(id).is_some())
        .ok_or_else(|| missing("publish id"))?;
    let upload = words(&data["upload_url"])
        .and_then(|u| Url::parse(u).ok())
        .ok_or_else(|| missing("upload URL"))?;
    for index in 0..plan.count {
        let (first, last) = plan.range(index);
        let bytes = &media.bytes[first as usize..=last as usize];
        let effect = if index + 1 == plan.count {
            Effect::Commit
        } else {
            Effect::Stage
        };
        let chunk = Chunk {
            bytes,
            first,
            total: plan.size,
            mime,
            effect,
        };
        connector.put_chunk(&upload, &chunk).await?;
    }
    Ok(id)
}

/// Photos: `POST /v2/post/publish/content/init/`, TikTok pulling them from their URLs
/// (<https://developers.tiktok.com/doc/content-posting-api-reference-photo-post>).
async fn post_photos(
    connector: &TiktokConnector,
    token: &str,
    flags: &TiktokPostFlags,
    privacy: &str,
    urls: &[Url],
    description: Option<String>,
) -> Result<String, ConnectorError> {
    let mut info = post_info(flags, privacy);
    if let Some(description) = description {
        info.insert("description".to_owned(), json!(description));
    }
    let images: Vec<&str> = urls.iter().map(Url::as_str).collect();
    let body = json!({
        "media_type": "PHOTO",
        "post_mode": "DIRECT_POST",
        "post_info": info,
        "source_info": {
            "source": "PULL_FROM_URL",
            "photo_cover_index": 0,
            "photo_images": images,
        },
    });
    let url = connector.api_url(&["v2", "post", "publish", "content", "init", ""], &[]);
    let answer = connector
        .call(
            Method::POST,
            url,
            Auth::Bearer(token),
            &Body::Json(body),
            Endpoint::Api,
            Effect::Commit,
        )
        .await?;
    text(&answer["data"]["publish_id"])
        .filter(|id| publish_id(id).is_some())
        .ok_or_else(|| ConnectorError::unknown("accepted response lacks a valid publish id"))
}

/// The first public post id of a status answer's `publicaly_available_post_id` (int64s; strings
/// taken too).
fn first_post_id(ids: &Value) -> Option<String> {
    ids.as_array()?
        .iter()
        .filter_map(text)
        .find(|id| video_id(id).is_ok())
}

/// Where the post `receipt` names stands (see the crate docs, "Status"):
/// `POST /v2/post/publish/status/fetch/ {publish_id}`, a read.
pub(crate) async fn resolve(
    connector: &TiktokConnector,
    cred: &Credential,
    public: &Value,
    receipt: &PublishReceipt,
) -> Result<Option<PublishResolution>, ConnectorError> {
    kind_of(public)?;
    let token = token_of(cred, "read a post's status")?;
    let id = publish_id(receipt.external_id.trim())
        .ok_or_else(|| ConnectorError::permanent("not a TikTok publish id"))?;
    let url = connector.api_url(&["v2", "post", "publish", "status", "fetch", ""], &[]);
    let answer = connector
        .call(
            Method::POST,
            url,
            Auth::Bearer(token),
            &Body::Json(json!({ "publish_id": id })),
            Endpoint::Api,
            Effect::Read,
        )
        .await?;
    let data = &answer["data"];
    let status = words(&data["status"]).ok_or_else(|| missing("publish status"))?;
    Ok(Some(match status {
        "PUBLISH_COMPLETE" => {
            let receipt = match first_post_id(&data["publicaly_available_post_id"]) {
                Some(post) => PublishReceipt {
                    url: permalink(public, &post),
                    external_id: post,
                },
                // Nobody else may see it (`SELF_ONLY`): TikTok names no public id.
                None => PublishReceipt {
                    external_id: id.to_owned(),
                    url: None,
                },
            };
            PublishResolution::Published(receipt)
        }
        "FAILED" => {
            let why: String = words(&data["fail_reason"])
                .unwrap_or("TikTok gave no reason")
                .chars()
                .take(120)
                .collect();
            let reason = crate::client::scrub(&format!("publish failed: {why}"), &[token]);
            PublishResolution::Failed(if why == "auth_removed" {
                ConnectorError::auth(reason)
            } else {
                ConnectorError::permanent(reason)
            })
        }
        pending if PENDING_STATUSES.contains(&pending) => PublishResolution::Pending,
        _ => {
            tracing::warn!("TikTok answered a publish status the adapter does not know; pending");
            PublishResolution::Pending
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(text: &str, link: Option<&str>) -> PublishRequest {
        PublishRequest {
            text: text.into(),
            link: link.map(|l| Url::parse(l).unwrap()),
            ..PublishRequest::default()
        }
    }

    #[test]
    fn chunk_plans_follow_the_media_transfer_guide() {
        const MIB: u64 = 1024 * 1024;
        // Below one chunk: whole.
        for size in [1, 4 * MIB, CHUNK_BYTES - 1] {
            let plan = ChunkPlan::of(size).unwrap();
            assert_eq!((plan.chunk_size, plan.count), (size, 1), "{size}");
            assert_eq!(plan.range(0), (0, size - 1));
        }
        // From one chunk on: floor(size / chunk), the last chunk taking the rest.
        let plan = ChunkPlan::of(CHUNK_BYTES).unwrap();
        assert_eq!((plan.chunk_size, plan.count), (CHUNK_BYTES, 1));
        let size = 2 * CHUNK_BYTES + 12_345;
        let plan = ChunkPlan::of(size).unwrap();
        assert_eq!((plan.chunk_size, plan.count), (CHUNK_BYTES, 2));
        assert_eq!(plan.range(0), (0, CHUNK_BYTES - 1));
        assert_eq!(plan.range(1), (CHUNK_BYTES, size - 1));
        // Within TikTok's bounds at the largest video: at most 1000 chunks, the last under 128 MB.
        let plan = ChunkPlan::of(MAX_VIDEO_BYTES).unwrap();
        assert!(plan.count <= 1000, "{plan:?}");
        let (first, last) = plan.range(plan.count - 1);
        assert!(last - first < 128 * MIB);
        assert!((5 * MIB..=64 * MIB).contains(&plan.chunk_size));
        assert!(ChunkPlan::of(0).is_err());
        assert!(ChunkPlan::of(MAX_VIDEO_BYTES + 1).is_err());
    }

    #[test]
    fn texts_are_counted_in_utf16_units() {
        assert_eq!(
            compose(&request(&"ş".repeat(2200), None), MAX_TITLE_UNITS, "t").unwrap(),
            Some("ş".repeat(2200))
        );
        // An emoji outside the BMP is two units.
        assert!(compose(&request(&"😀".repeat(1101), None), MAX_TITLE_UNITS, "t").is_err());
        assert!(compose(&request(&"😀".repeat(1100), None), MAX_TITLE_UNITS, "t").is_ok());
        let link = "https://jeeta.test/menu";
        assert_eq!(
            compose(&request("Yeni menü", Some(link)), 90, "t").unwrap(),
            Some(format!("Yeni menü\n\n{link}"))
        );
        assert_eq!(compose(&request(" \n", None), 90, "t").unwrap(), None);
    }

    #[test]
    fn privacy_is_chosen_never_defaulted_and_named_as_tiktok_does() {
        let with = |p: Option<&str>| PublishRequest {
            // The request's own privacy does not count: the screen's choice does.
            privacy: Some("PUBLIC_TO_EVERYONE".into()),
            tiktok: p.map(|privacy| TiktokPost {
                title: String::new(),
                privacy_level: privacy.into(),
                allow_comment: false,
                allow_duet: false,
                allow_stitch: false,
                disclose_commercial: false,
                your_brand: false,
                branded_content: false,
            }),
            ..PublishRequest::default()
        };
        assert_eq!(
            choice_of(&with(None)).unwrap_err().reason(),
            Some(NO_CHOICE)
        );
        for blank in ["", " "] {
            assert_eq!(
                choice_of(&with(Some(blank))).unwrap_err().kind(),
                "permanent"
            );
        }
        for level in PRIVACY_LEVELS {
            assert_eq!(choice_of(&with(Some(level))).unwrap().privacy_level, *level);
        }
        for other in ["PRIVATE", " self_only ", "public_to_everyone"] {
            assert_eq!(
                choice_of(&with(Some(other))).unwrap_err().reason(),
                Some("not a TikTok privacy level")
            );
        }
    }

    #[test]
    fn permalinks_use_a_handle_only() {
        let url = |public: Value| permalink(&public, "7300000000000000001").map(|u| u.to_string());
        assert_eq!(
            url(json!({ "username": " @jeeta.test_1 " })).as_deref(),
            Some("https://www.tiktok.com/@jeeta.test_1/video/7300000000000000001")
        );
        assert_eq!(
            url(json!({ "username": "a/b", "facts": { "username": "probed" }, "asset": { "username": "asset" } }))
                .as_deref(),
            Some("https://www.tiktok.com/@probed/video/7300000000000000001")
        );
        for bad in [
            json!({}),
            json!({ "username": "../x" }),
            json!({ "username": ".." }),
            json!({ "username": "a".repeat(25) }),
            json!({ "username": 7 }),
        ] {
            assert_eq!(url(bad.clone()), None, "{bad}");
        }
    }

    #[test]
    fn ids_are_checked() {
        assert_eq!(publish_id("v_pub_file~v2-1.7"), Some("v_pub_file~v2-1.7"));
        for bad in ["", "a b", "a\nb", &"x".repeat(65)] {
            assert_eq!(publish_id(bad), None, "{bad:?}");
        }
        assert_eq!(
            video_id("7300000000000000001").unwrap(),
            "7300000000000000001"
        );
        for bad in ["", "v_pub_file~1", "12a", &"1".repeat(33)] {
            assert!(video_id(bad).is_err(), "{bad:?}");
        }
        assert_eq!(
            first_post_id(&json!([
                7_300_000_000_000_000_001_u64,
                "7300000000000000002"
            ])),
            Some("7300000000000000001".to_owned())
        );
        assert_eq!(
            first_post_id(&json!(["x", "7300000000000000002"])),
            Some("7300000000000000002".to_owned())
        );
        assert_eq!(first_post_id(&json!([])), None);
        assert_eq!(first_post_id(&json!(null)), None);
    }
}
