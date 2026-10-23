//! The X credential and the capability's kind, as the use cases hand it in `public`.

use jt_connector::{ConnectorError, Credential, Provider};
use serde_json::Value;

/// The reason every operation that takes `public` refuses one without the X kind.
pub(crate) const KIND_MISSING: &str = "kind_key missing";

/// The capability's kind, as the use cases hand it in `public["kind_key"]`: the kind X serves
/// (`x`), else `Permanent` ([`KIND_MISSING`]).
pub(crate) fn kind_of(public: &Value) -> Result<&str, ConnectorError> {
    public["kind_key"]
        .as_str()
        .filter(|kind| Provider::X.kinds().contains(kind))
        .ok_or_else(|| ConnectorError::permanent(KIND_MISSING))
}

/// The access token of an X credential (an [`Credential::OAuth`] one); `Permanent` for another
/// kind of credential, which cannot `what` on X.
pub(crate) fn token_of<'a>(cred: &'a Credential, what: &str) -> Result<&'a str, ConnectorError> {
    match cred {
        Credential::OAuth { access_token, .. } if !access_token.is_empty() => Ok(access_token),
        Credential::OAuth { .. } => Err(ConnectorError::permanent(
            "the X credential has no access token",
        )),
        other => Err(ConnectorError::permanent(format!(
            "a {} credential cannot {what} on X",
            other.kind()
        ))),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_kind_is_x() {
        assert_eq!(kind_of(&json!({ "kind_key": "x" })).unwrap(), "x");
        for public in [
            json!({}),
            json!(null),
            json!({ "kind_key": null }),
            json!({ "kind_key": "X" }),
            json!({ "kind_key": "instagram" }),
        ] {
            let e = kind_of(&public).unwrap_err();
            assert_eq!((e.kind(), e.reason()), ("permanent", Some(KIND_MISSING)));
        }
    }

    #[test]
    fn only_an_oauth_credential_has_an_x_token() {
        let oauth = Credential::OAuth {
            access_token: "tok".into(),
            refresh_token: None,
            expires_at: None,
            scopes: vec![],
        };
        assert_eq!(token_of(&oauth, "post").unwrap(), "tok");
        let empty = Credential::OAuth {
            access_token: String::new(),
            refresh_token: None,
            expires_at: None,
            scopes: vec![],
        };
        assert_eq!(token_of(&empty, "post").unwrap_err().kind(), "permanent");
        let page = Credential::PageToken {
            page_id: "1".into(),
            token: "EAAB-SECRET".into(),
        };
        let e = token_of(&page, "post").unwrap_err();
        assert_eq!(e.reason(), Some("a page_token credential cannot post on X"));
    }
}
