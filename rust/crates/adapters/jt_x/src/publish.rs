//! Posts: the checks made before anything is sent, the image uploads, the post and its receipt
//! (see the crate docs, "Posts").

use jt_app::ports::connectors::{MediaUpload, PublishReceipt, PublishRequest};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::{Map, Value, json};
use url::Url;

use crate::client::{Auth, Body, Endpoint, Upload, missing, text};
use crate::credential::{kind_of, token_of};
use crate::{IMAGE_MIMES, LINK_CHARS, MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TEXT_CHARS, XConnector};

/// Why media URLs without their bytes are refused: X takes uploads only.
pub(crate) const MEDIA_BYTES_REQUIRED: &str = "x needs media bytes";

/// The upload category of a post's image.
const MEDIA_CATEGORY: &str = "tweet_image";

/// Where a post's public page is (a browser URL, never fetched).
const PERMALINK_BASE: &str = "https://x.com";

/// The longest post id taken, in digits (X's ids have at most 19).
const MAX_ID_DIGITS: usize = 32;

/// The longest X handle, in characters.
const MAX_HANDLE_CHARS: usize = 15;

/// The longest upload file name sent, in characters.
const MAX_FILENAME_CHARS: usize = 100;

/// `id` when it can be an X post id in a path: 1 to [`MAX_ID_DIGITS`] ASCII digits; else
/// `Permanent` (so an id never changes the path it is put in).
pub(crate) fn post_id(id: &str) -> Result<&str, ConnectorError> {
    let ok = (1..=MAX_ID_DIGITS).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit());
    if ok {
        Ok(id)
    } else {
        Err(ConnectorError::permanent("not a valid X post id"))
    }
}

/// Whether `name` is an X handle: 1 to 15 ASCII letters, digits or `_`.
fn is_handle(name: &str) -> bool {
    (1..=MAX_HANDLE_CHARS).contains(&name.len())
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// `name` fit for a multipart header: ASCII letters, digits, `.`, `_` and `-` kept, anything else
/// `_`, at most [`MAX_FILENAME_CHARS`]; `image` when nothing is left.
fn safe_filename(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(MAX_FILENAME_CHARS)
        .collect();
    if safe.is_empty() {
        "image".to_owned()
    } else {
        safe
    }
}

/// The text to post: the request's text (none when blank) and its link on a line of its own after
/// it. `Permanent` when longer than [`MAX_TEXT_CHARS`] characters, the link counting
/// [`LINK_CHARS`].
fn compose(request: &PublishRequest) -> Result<Option<String>, ConnectorError> {
    let text = Some(request.text.as_str()).filter(|t| !t.trim().is_empty());
    let link = request.link.as_ref();
    let length = text.map_or(0, |t| t.chars().count())
        + link.map_or(0, |_| LINK_CHARS)
        + if text.is_some() && link.is_some() {
            2
        } else {
            0
        };
    if length > MAX_TEXT_CHARS {
        return Err(ConnectorError::permanent(format!(
            "a post is at most {MAX_TEXT_CHARS} characters, a link counting {LINK_CHARS}; this \
             one is {length}"
        )));
    }
    Ok(match (text, link) {
        (Some(text), Some(link)) => Some(format!("{text}\n\n{link}")),
        (Some(text), None) => Some(text.to_owned()),
        (None, Some(link)) => Some(link.to_string()),
        (None, None) => None,
    })
}

/// The media type of each image of the request (lowercase, trimmed), once every image is checked
/// (see the crate docs).
fn check_media(request: &PublishRequest) -> Result<Vec<String>, ConnectorError> {
    if request.media.is_empty() && !request.media_urls.is_empty() {
        return Err(ConnectorError::permanent(MEDIA_BYTES_REQUIRED));
    }
    if request.media.len() > MAX_IMAGES {
        return Err(ConnectorError::permanent(format!(
            "an X post carries at most {MAX_IMAGES} images"
        )));
    }
    request
        .media
        .iter()
        .map(|media| {
            let mime = media.mime.trim().to_ascii_lowercase();
            if !IMAGE_MIMES.contains(&mime.as_str()) {
                return Err(ConnectorError::permanent(
                    "an X post carries JPEG, PNG, GIF or WebP images only",
                ));
            }
            if media.bytes.is_empty() {
                return Err(ConnectorError::permanent("an image is empty"));
            }
            if media.bytes.len() > MAX_IMAGE_BYTES {
                return Err(ConnectorError::permanent(format!(
                    "an image is larger than {} MB",
                    MAX_IMAGE_BYTES / (1024 * 1024)
                )));
            }
            Ok(mime)
        })
        .collect()
}

/// Where post `id` is seen: under the account's handle, the first of `public["username"]`, the
/// last probe's (`public["facts"]["username"]`) and the OAuth asset's
/// (`public["asset"]["username"]`, where the connection use cases keep them) that is an X handle;
/// else under `i`.
fn permalink(public: &Value, id: &str) -> Option<Url> {
    let handle = [
        &public["username"],
        &public["facts"]["username"],
        &public["asset"]["username"],
    ]
    .into_iter()
    .filter_map(Value::as_str)
    .map(str::trim)
    .find(|u| is_handle(u))
    .unwrap_or("i");
    Url::parse(&format!("{PERMALINK_BASE}/{handle}/status/{id}")).ok()
}

/// Publishes `request` (see the crate docs).
pub(crate) async fn publish(
    connector: &XConnector,
    cred: &Credential,
    public: &Value,
    request: &PublishRequest,
) -> Result<PublishReceipt, ConnectorError> {
    kind_of(public)?;
    let token = token_of(cred, "publish")?;
    let mimes = check_media(request)?;
    let composed = compose(request)?;
    if composed.is_none() && request.media.is_empty() {
        return Err(ConnectorError::permanent(
            "a post needs text, a link or an image",
        ));
    }
    let mut ids = Vec::with_capacity(request.media.len());
    for (media, mime) in request.media.iter().zip(&mimes) {
        ids.push(upload(connector, token, media, mime).await?);
    }
    let mut body = Map::new();
    if let Some(composed) = composed {
        body.insert("text".to_owned(), json!(composed));
    }
    if !ids.is_empty() {
        body.insert("media".to_owned(), json!({ "media_ids": ids }));
    }
    let url = connector.api_url(&["2", "tweets"], &[]);
    let answer = connector
        .call(
            Method::POST,
            url,
            Auth::Bearer(token),
            &Body::Json(Value::Object(body)),
            Endpoint::Api,
        )
        .await?;
    let id = text(&answer["data"]["id"])
        .filter(|id| post_id(id).is_ok())
        .ok_or_else(|| missing("post id"))?;
    Ok(PublishReceipt {
        url: permalink(public, &id),
        external_id: id,
    })
}

/// Uploads one image of type `mime` and returns its media id.
async fn upload(
    connector: &XConnector,
    token: &str,
    media: &MediaUpload,
    mime: &str,
) -> Result<String, ConnectorError> {
    let body = Body::Upload(Upload {
        bytes: &media.bytes,
        mime,
        filename: safe_filename(&media.filename),
        category: MEDIA_CATEGORY,
    });
    let url = connector.upload_url(&["2", "media", "upload"]);
    let answer = connector
        .call(Method::POST, url, Auth::Bearer(token), &body, Endpoint::Api)
        .await?;
    text(&answer["data"]["id"])
        .or_else(|| text(&answer["media_id_string"]))
        .ok_or_else(|| missing("media id"))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn request(text: &str, link: Option<&str>) -> PublishRequest {
        PublishRequest {
            text: text.into(),
            link: link.map(|l| Url::parse(l).unwrap()),
            ..PublishRequest::default()
        }
    }

    #[test]
    fn the_length_counts_characters_and_a_link_as_23() {
        assert_eq!(
            compose(&request(&"ş".repeat(280), None)).unwrap(),
            Some("ş".repeat(280))
        );
        assert!(compose(&request(&"ş".repeat(281), None)).is_err());
        let link = "https://jeeta.test/a-very-long-path-that-x-shortens-anyway";
        assert_eq!(
            compose(&request(&"a".repeat(255), Some(link)))
                .unwrap()
                .unwrap()
                .chars()
                .count(),
            255 + 2 + link.chars().count()
        );
        assert!(compose(&request(&"a".repeat(256), Some(link))).is_err());
        assert_eq!(
            compose(&request(" ", Some("https://jeeta.test/"))).unwrap(),
            Some("https://jeeta.test/".to_owned())
        );
        assert_eq!(compose(&request("\n ", None)).unwrap(), None);
    }

    #[test]
    fn permalinks_use_the_handle_when_it_is_one() {
        let url = |public: Value| {
            permalink(&public, "1800000000000000001")
                .unwrap()
                .to_string()
        };
        assert_eq!(
            url(json!({ "username": " jeeta_test " })),
            "https://x.com/jeeta_test/status/1800000000000000001"
        );
        // Where the connection use cases keep it: the last probe's facts, the OAuth asset's.
        assert_eq!(
            url(json!({ "facts": { "username": "probed" }, "asset": { "username": "asset" } })),
            "https://x.com/probed/status/1800000000000000001"
        );
        assert_eq!(
            url(json!({ "username": "a/b", "asset": { "username": "asset" } })),
            "https://x.com/asset/status/1800000000000000001"
        );
        for bad in [
            json!({}),
            json!({ "username": "a/b" }),
            json!({ "username": "sixteen_chars_xx" }),
            json!({ "username": "" }),
        ] {
            assert_eq!(url(bad), "https://x.com/i/status/1800000000000000001");
        }
    }

    #[test]
    fn file_names_cannot_break_a_part_header() {
        assert_eq!(safe_filename("menü \"1\".png"), "men___1_.png");
        assert_eq!(safe_filename("a\r\nb"), "a__b");
        assert_eq!(safe_filename(""), "image");
        assert_eq!(safe_filename(&"a".repeat(300)).len(), MAX_FILENAME_CHARS);
    }

    #[test]
    fn post_ids_are_digits() {
        assert_eq!(
            post_id("1800000000000000001").unwrap(),
            "1800000000000000001"
        );
        for bad in ["", "1a", "../1", "1 ", &"1".repeat(33)] {
            assert!(post_id(bad).is_err(), "{bad:?}");
        }
    }
}
