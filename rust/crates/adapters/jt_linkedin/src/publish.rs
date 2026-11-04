//! Posts: the checks made before anything is sent, the image and video uploads, the post and its
//! receipt (see the crate docs, "Posts").

use jt_app::ports::connectors::{MediaUpload, PublishReceipt, PublishRequest};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::{Map, Value, json};
use url::Url;

use crate::client::{Answer, Auth, Body, Endpoint, missing, text};
use crate::credential::{author_of, kind_of, post_urn, token_of};
use crate::{
    IMAGE_MIMES, LinkedinConnector, MAX_ARTICLE_TITLE_CHARS, MAX_COMMENTARY_CHARS, MAX_IMAGES,
    MAX_VIDEO_BYTES, MIN_VIDEO_BYTES, VIDEO_MIME,
};

/// Why media URLs without their bytes are refused: LinkedIn takes uploads only.
pub(crate) const MEDIA_BYTES_REQUIRED: &str = "linkedin needs media bytes";

/// Why media bytes and media URLs of different counts are refused: a file would be lost or
/// invented.
pub(crate) const MEDIA_COUNT_MISMATCH: &str = "media bytes and urls disagree";

/// Why a post without anything to post is refused.
const NOTHING_TO_POST: &str = "a post needs text, a link, images or a video";

/// The media type a video part is uploaded as (the Videos API's example).
const PART_MIME: &str = "application/octet-stream";

/// Where a post's public page is (a browser URL, never fetched; the Posts API's form).
const FEED_UPDATE: &str = "https://www.linkedin.com/feed/update/";

/// The most parts a video upload may be split into (LinkedIn's parts are 4 MB: 500 MB is 125).
const MAX_VIDEO_PARTS: usize = 1024;

/// The characters `little` reserves, each escaped with a backslash to be plain text.
const RESERVED: &[char] = &[
    '|', '{', '}', '@', '[', ']', '(', ')', '<', '>', '#', '\\', '*', '_', '~',
];

/// The media of a post, once checked.
enum Media<'a> {
    None,
    /// 1 to [`MAX_IMAGES`] images, with their media types.
    Images(Vec<(&'a MediaUpload, String)>),
    /// One video.
    Video(&'a MediaUpload),
}

impl Media<'_> {
    fn is_none(&self) -> bool {
        matches!(self, Media::None)
    }
}

/// `text` in LinkedIn's `little` format: every reserved character escaped with a backslash, but a
/// `#` that starts a word (at the start, or after whitespace) and is followed by a letter or digit,
/// which stays a hashtag.
pub(crate) fn little_text(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() + text.len() / 8);
    for (i, &c) in chars.iter().enumerate() {
        let hashtag = c == '#'
            && (i == 0 || chars[i - 1].is_whitespace())
            && chars.get(i + 1).is_some_and(|n| n.is_alphanumeric());
        if RESERVED.contains(&c) && !hashtag {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// The checked media of `request` (see the crate docs, "Posts").
fn check_media(request: &PublishRequest) -> Result<Media<'_>, ConnectorError> {
    if request.media.is_empty() && !request.media_urls.is_empty() {
        return Err(ConnectorError::permanent(MEDIA_BYTES_REQUIRED));
    }
    if !request.media_urls.is_empty() && request.media.len() != request.media_urls.len() {
        return Err(ConnectorError::permanent(MEDIA_COUNT_MISMATCH));
    }
    let mut images = Vec::new();
    let mut videos = Vec::new();
    for media in &request.media {
        let mime = media.mime.trim().to_ascii_lowercase();
        if media.bytes.is_empty() {
            return Err(ConnectorError::permanent("a media file is empty"));
        }
        if mime == VIDEO_MIME {
            videos.push(media);
        } else if IMAGE_MIMES.contains(&mime.as_str()) {
            images.push((media, mime));
        } else {
            return Err(ConnectorError::permanent(
                "a LinkedIn post carries JPEG, PNG or GIF images or one MP4 video",
            ));
        }
    }
    match videos.as_slice() {
        [] => {}
        [video] => {
            if !(MIN_VIDEO_BYTES..=MAX_VIDEO_BYTES).contains(&video.bytes.len()) {
                return Err(ConnectorError::permanent(
                    "a LinkedIn video is 75 KB to 500 MB",
                ));
            }
            if !images.is_empty() {
                tracing::debug!(
                    left_out = images.len(),
                    "a LinkedIn post with a video leaves its images out"
                );
            }
            return Ok(Media::Video(video));
        }
        _ => {
            return Err(ConnectorError::permanent(
                "a LinkedIn post carries one video",
            ));
        }
    }
    if images.len() > MAX_IMAGES {
        return Err(ConnectorError::permanent(format!(
            "a LinkedIn post carries at most {MAX_IMAGES} images"
        )));
    }
    Ok(if images.is_empty() {
        Media::None
    } else {
        Media::Images(images)
    })
}

/// The post's text before escaping, and the article a link becomes: with media the link goes
/// after the text on a line of its own; without, it is the article. `Permanent` when the text is
/// longer than [`MAX_COMMENTARY_CHARS`] characters.
fn compose(
    request: &PublishRequest,
    has_media: bool,
) -> Result<(String, Option<Url>), ConnectorError> {
    let text = Some(request.text.as_str()).filter(|t| !t.trim().is_empty());
    let (plain, article) = match (text, &request.link) {
        (Some(text), Some(link)) if has_media => (format!("{text}\n\n{link}"), None),
        (None, Some(link)) if has_media => (link.to_string(), None),
        (text, link) => (text.unwrap_or_default().to_owned(), link.clone()),
    };
    let length = plain.chars().count();
    if length > MAX_COMMENTARY_CHARS {
        return Err(ConnectorError::permanent(format!(
            "a LinkedIn post is at most {MAX_COMMENTARY_CHARS} characters; this one is {length}"
        )));
    }
    Ok((plain, article))
}

/// Publishes `request` (see the crate docs).
pub(crate) async fn publish(
    connector: &LinkedinConnector,
    cred: &Credential,
    public: &Value,
    request: &PublishRequest,
) -> Result<PublishReceipt, ConnectorError> {
    let kind = kind_of(public)?;
    let token = token_of(cred, "publish")?;
    let author = author_of(kind, public)?;
    let media = check_media(request)?;
    let (plain, article) = compose(request, !media.is_none())?;
    if plain.is_empty() && article.is_none() && media.is_none() {
        return Err(ConnectorError::permanent(NOTHING_TO_POST));
    }
    let content = match (&media, &article) {
        (Media::Images(images), _) => {
            let mut ids = Vec::with_capacity(images.len());
            for (image, mime) in images {
                ids.push(upload_image(connector, token, &author, image, mime).await?);
            }
            if let [id] = ids.as_slice() {
                Some(json!({ "media": { "id": id } }))
            } else {
                let images: Vec<Value> = ids.iter().map(|id| json!({ "id": id })).collect();
                Some(json!({ "multiImage": { "images": images } }))
            }
        }
        (Media::Video(video), _) => {
            let id = upload_video(connector, token, &author, video).await?;
            Some(json!({ "media": { "id": id } }))
        }
        (Media::None, Some(link)) => {
            let title: String = link
                .as_str()
                .chars()
                .take(MAX_ARTICLE_TITLE_CHARS)
                .collect();
            Some(json!({ "article": { "source": link.as_str(), "title": title } }))
        }
        (Media::None, None) => None,
    };
    let mut body = Map::new();
    body.insert("author".to_owned(), json!(author));
    body.insert("commentary".to_owned(), json!(little_text(&plain)));
    body.insert("visibility".to_owned(), json!("PUBLIC"));
    body.insert(
        "distribution".to_owned(),
        json!({
            "feedDistribution": "MAIN_FEED",
            "targetEntities": [],
            "thirdPartyDistributionChannels": [],
        }),
    );
    if let Some(content) = content {
        body.insert("content".to_owned(), content);
    }
    body.insert("lifecycleState".to_owned(), json!("PUBLISHED"));
    body.insert("isReshareDisabledByAuthor".to_owned(), json!(false));
    let answer = connector
        .call(
            Method::POST,
            connector.rest_url(&["posts"], None),
            Auth::Bearer(token),
            &Body::Json(Value::Object(body)),
            Endpoint::Rest,
        )
        .await?;
    receipt(&answer)
}

/// The receipt of an accepted post: its URN from `x-restli-id` and its page; `Unknown` without a
/// valid one (the post may well exist).
fn receipt(answer: &Answer) -> Result<PublishReceipt, ConnectorError> {
    let urn = answer
        .header("x-restli-id")
        .and_then(post_urn)
        .ok_or_else(|| ConnectorError::unknown("accepted response lacks a valid post id"))?;
    Ok(PublishReceipt {
        url: Url::parse(&format!("{FEED_UPDATE}{urn}/")).ok(),
        external_id: urn.to_owned(),
    })
}

/// `value` when it is a URN with `prefix` and a non-empty id of ASCII letters, digits, `-` or
/// `_` (an image's or a video's).
fn media_urn(value: &Value, prefix: &str) -> Option<String> {
    let urn = text(value)?;
    let id = urn.strip_prefix(prefix)?;
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'));
    ok.then_some(urn)
}

/// `value` as an upload URL (http or https; the egress client decides whether its host may be
/// reached).
fn upload_url(value: &Value) -> Result<Url, ConnectorError> {
    value
        .as_str()
        .and_then(|u| Url::parse(u).ok())
        .filter(|u| matches!(u.scheme(), "https" | "http"))
        .ok_or_else(|| missing("upload URL"))
}

/// Uploads one image owned by `owner` and returns its URN: `initializeUpload`, then `PUT` the
/// bytes to the URL LinkedIn hands out, with the token (the Assets API's rule for images).
async fn upload_image(
    connector: &LinkedinConnector,
    token: &str,
    owner: &str,
    image: &MediaUpload,
    mime: &str,
) -> Result<String, ConnectorError> {
    let init = connector
        .call(
            Method::POST,
            connector.rest_url(&["images"], Some("action=initializeUpload")),
            Auth::Bearer(token),
            &Body::Json(json!({ "initializeUploadRequest": { "owner": owner } })),
            Endpoint::Rest,
        )
        .await?;
    let value = &init.json()?["value"];
    let urn = media_urn(&value["image"], "urn:li:image:").ok_or_else(|| missing("image URN"))?;
    let url = upload_url(&value["uploadUrl"])?;
    connector
        .call(
            Method::PUT,
            url,
            Auth::Bearer(token),
            &Body::Bytes {
                bytes: &image.bytes,
                mime,
            },
            Endpoint::Upload,
        )
        .await?;
    Ok(urn)
}

/// One part of a video upload: its byte range (inclusive) and where it goes.
struct Part {
    first: usize,
    last: usize,
    url: Url,
}

/// The parts of LinkedIn's `uploadInstructions` for a file of `size` bytes, once they cover it
/// exactly, in order and without overlap; `Permanent` otherwise.
fn parts_of(instructions: &Value, size: usize) -> Result<Vec<Part>, ConnectorError> {
    let refused =
        || ConnectorError::permanent("LinkedIn's upload instructions do not cover the video");
    let list = instructions
        .as_array()
        .ok_or_else(|| missing("upload instructions"))?;
    if list.is_empty() || list.len() > MAX_VIDEO_PARTS {
        return Err(refused());
    }
    let mut parts = Vec::with_capacity(list.len());
    let mut next = 0usize;
    for instruction in list {
        let byte = |name: &str| {
            instruction[name]
                .as_u64()
                .and_then(|b| usize::try_from(b).ok())
        };
        let (Some(first), Some(last)) = (byte("firstByte"), byte("lastByte")) else {
            return Err(refused());
        };
        if first != next || last < first || last >= size {
            return Err(refused());
        }
        parts.push(Part {
            first,
            last,
            url: upload_url(&instruction["uploadUrl"])?,
        });
        next = last + 1;
    }
    if next != size {
        return Err(refused());
    }
    Ok(parts)
}

/// Uploads one video owned by `owner` and returns its URN: `initializeUpload`, `PUT` each part
/// (no token: the Assets API's rule for videos) keeping its `ETag`, `finalizeUpload`.
async fn upload_video(
    connector: &LinkedinConnector,
    token: &str,
    owner: &str,
    video: &MediaUpload,
) -> Result<String, ConnectorError> {
    let size = video.bytes.len();
    let init = connector
        .call(
            Method::POST,
            connector.rest_url(&["videos"], Some("action=initializeUpload")),
            Auth::Bearer(token),
            &Body::Json(json!({ "initializeUploadRequest": {
                "owner": owner,
                "fileSizeBytes": size,
                "uploadCaptions": false,
                "uploadThumbnail": false,
            }})),
            Endpoint::Rest,
        )
        .await?;
    let value = &init.json()?["value"];
    let urn = media_urn(&value["video"], "urn:li:video:").ok_or_else(|| missing("video URN"))?;
    // LinkedIn's own session id for the parts (documented as possibly empty): passed back as is.
    let upload_token = value["uploadToken"].as_str().unwrap_or_default().to_owned();
    let parts = parts_of(&value["uploadInstructions"], size)?;
    let mut etags = Vec::with_capacity(parts.len());
    for part in parts {
        let answer = connector
            .call(
                Method::PUT,
                part.url,
                Auth::Anonymous,
                &Body::Bytes {
                    bytes: &video.bytes[part.first..=part.last],
                    mime: PART_MIME,
                },
                Endpoint::Upload,
            )
            .await?;
        let etag = answer
            .header("etag")
            .map(|e| e.trim_start_matches("W/").trim_matches('"').to_owned())
            .filter(|e| !e.is_empty())
            .ok_or_else(|| missing("upload part id (ETag)"))?;
        etags.push(etag);
    }
    connector
        .call(
            Method::POST,
            connector.rest_url(&["videos"], Some("action=finalizeUpload")),
            Auth::Bearer(token),
            &Body::Json(json!({ "finalizeUploadRequest": {
                "video": urn,
                "uploadToken": upload_token,
                "uploadedPartIds": etags,
            }})),
            Endpoint::Rest,
        )
        .await?;
    Ok(urn)
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
    fn little_text_escapes_reserved_characters_and_keeps_hashtags() {
        assert_eq!(little_text("Merhaba dünya"), "Merhaba dünya");
        assert_eq!(
            little_text("a|b{c}d@e[f]g(h)i<j>k\\l*m_n~o"),
            "a\\|b\\{c\\}d\\@e\\[f\\]g\\(h\\)i\\<j\\>k\\\\l\\*m\\_n\\~o"
        );
        assert_eq!(little_text("#yeni menü #2026"), "#yeni menü #2026");
        assert_eq!(little_text("a#b # c #"), "a\\#b \\# c \\#");
        assert_eq!(
            little_text("https://jeeta.test/a_b#top"),
            "https://jeeta.test/a\\_b\\#top"
        );
        // A would-be mention stays text.
        assert_eq!(
            little_text("@[Devtestco](urn:li:organization:2414183)"),
            "\\@\\[Devtestco\\]\\(urn:li:organization:2414183\\)"
        );
    }

    #[test]
    fn a_link_is_an_article_without_media_and_text_with_it() {
        let (plain, article) =
            compose(&request("Yeni", Some("https://jeeta.test/m")), false).unwrap();
        assert_eq!(plain, "Yeni");
        assert_eq!(article.unwrap().as_str(), "https://jeeta.test/m");
        let (plain, article) =
            compose(&request("Yeni", Some("https://jeeta.test/m")), true).unwrap();
        assert_eq!(plain, "Yeni\n\nhttps://jeeta.test/m");
        assert!(article.is_none());
        let (plain, _) = compose(&request(" ", Some("https://jeeta.test/m")), true).unwrap();
        assert_eq!(plain, "https://jeeta.test/m");
        assert!(compose(&request(&"ş".repeat(MAX_COMMENTARY_CHARS), None), false).is_ok());
        assert!(compose(&request(&"ş".repeat(MAX_COMMENTARY_CHARS + 1), None), false).is_err());
    }

    #[test]
    fn upload_instructions_must_cover_the_file() {
        let at = |first: u64, last: u64| json!({ "uploadUrl": "https://www.linkedin.com/dms-uploads/x", "firstByte": first, "lastByte": last });
        let parts = parts_of(&json!([at(0, 9), at(10, 14)]), 15).unwrap();
        assert_eq!(
            parts.iter().map(|p| (p.first, p.last)).collect::<Vec<_>>(),
            [(0, 9), (10, 14)]
        );
        for bad in [
            json!([]),
            json!([at(0, 9)]),
            json!([at(1, 14)]),
            json!([at(0, 9), at(9, 14)]),
            json!([at(0, 9), at(11, 14)]),
            json!([at(0, 15)]),
            json!([{ "uploadUrl": "ftp://x", "firstByte": 0, "lastByte": 14 }]),
            json!("parts"),
        ] {
            assert!(parts_of(&bad, 15).is_err(), "{bad}");
        }
    }

    #[test]
    fn media_urns_are_checked() {
        assert_eq!(
            media_urn(&json!("urn:li:image:C4E10AQ-x_1"), "urn:li:image:").as_deref(),
            Some("urn:li:image:C4E10AQ-x_1")
        );
        for bad in [
            json!("urn:li:video:C4"),
            json!("urn:li:image:"),
            json!("urn:li:image:a/b"),
            json!(7),
        ] {
            assert_eq!(media_urn(&bad, "urn:li:image:"), None, "{bad}");
        }
    }
}
