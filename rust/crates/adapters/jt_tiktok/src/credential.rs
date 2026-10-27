//! The TikTok credential and the capability's kind, as the use cases hand it in `public`.

use jt_connector::{ConnectorError, Credential, Provider};
use serde_json::Value;

/// The reason every operation that takes `public` refuses one without the TikTok kind.
pub(crate) const KIND_MISSING: &str = "kind_key missing";

/// The capability's kind, as the use cases hand it in `public["kind_key"]`: the kind TikTok
/// serves (`tiktok`), else `Permanent` ([`KIND_MISSING`]).
pub(crate) fn kind_of(public: &Value) -> Result<&str, ConnectorError> {
    public["kind_key"]
        .as_str()
        .filter(|kind| Provider::Tiktok.kinds().contains(kind))
        .ok_or_else(|| ConnectorError::permanent(KIND_MISSING))
}

/// The access token of a TikTok credential (an [`Credential::OAuth`] one); `Permanent` for
/// another kind of credential, which cannot `what` on TikTok.
pub(crate) fn token_of<'a>(cred: &'a Credential, what: &str) -> Result<&'a str, ConnectorError> {
    match cred {
        Credential::OAuth { access_token, .. } if !access_token.is_empty() => Ok(access_token),
        Credential::OAuth { .. } => Err(ConnectorError::permanent(
            "the TikTok credential has no access token",
        )),
        other => Err(ConnectorError::permanent(format!(
            "a {} credential cannot {what} on TikTok",
            other.kind()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_kind_is_tiktok() {
        assert_eq!(kind_of(&json!({ "kind_key": "tiktok" })).unwrap(), "tiktok");
        for public in [
            json!({}),
            json!(null),
            json!({ "kind_key": null }),
            json!({ "kind_key": "TikTok" }),
            json!({ "kind_key": "tiktok_ads" }),
            json!({ "kind_key": "x" }),
        ] {
            let e = kind_of(&public).unwrap_err();
            assert_eq!((e.kind(), e.reason()), ("permanent", Some(KIND_MISSING)));
        }
    }

    #[test]
    fn only_an_oauth_credential_has_a_tiktok_token() {
        let oauth = Credential::OAuth {
            access_token: "act.tok".into(),
            refresh_token: None,
            expires_at: None,
            scopes: vec![],
        };
        assert_eq!(token_of(&oauth, "publish").unwrap(), "act.tok");
        let empty = Credential::OAuth {
            access_token: String::new(),
            refresh_token: None,
            expires_at: None,
            scopes: vec![],
        };
        assert_eq!(token_of(&empty, "publish").unwrap_err().kind(), "permanent");
        let page = Credential::PageToken {
            page_id: "1".into(),
            token: "EAAB-SECRET".into(),
        };
        let e = token_of(&page, "publish").unwrap_err();
        assert_eq!(
            e.reason(),
            Some("a page_token credential cannot publish on TikTok")
        );
    }
}
