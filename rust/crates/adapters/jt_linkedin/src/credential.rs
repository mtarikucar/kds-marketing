//! The LinkedIn credential, the capability's kind and account as the use cases hand them in
//! `public`, and the URNs built from them.

use jt_connector::{ConnectorError, Credential, Provider};
use serde_json::Value;

use crate::client::text;

/// The reason every operation that takes `public` refuses one without a LinkedIn kind.
pub(crate) const KIND_MISSING: &str = "kind_key missing";

/// The longest member id taken (OpenID `sub`), in characters.
const MAX_PERSON_ID_CHARS: usize = 64;

/// The longest organization number taken, in digits.
const MAX_ORGANIZATION_DIGITS: usize = 20;

/// The longest post number taken, in digits.
const MAX_POST_DIGITS: usize = 32;

/// The URN prefix of an organization.
pub(crate) const ORGANIZATION_URN: &str = "urn:li:organization:";

/// The URN prefix of a member.
const PERSON_URN: &str = "urn:li:person:";

/// The kind of a LinkedIn capability.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Kind {
    /// `linkedin_member`: the member's own feed.
    Member,
    /// `linkedin_page`: an organization page the member administers.
    Page,
}

/// The capability's kind, as the use cases hand it in `public["kind_key"]`: one LinkedIn serves,
/// else `Permanent` ([`KIND_MISSING`]).
pub(crate) fn kind_of(public: &Value) -> Result<Kind, ConnectorError> {
    match public["kind_key"].as_str() {
        Some(kind) if Provider::Linkedin.kinds().contains(&kind) => Ok(match kind {
            "linkedin_page" => Kind::Page,
            _ => Kind::Member,
        }),
        _ => Err(ConnectorError::permanent(KIND_MISSING)),
    }
}

/// The access token of a LinkedIn credential (an [`Credential::OAuth`] one); `Permanent` for
/// another kind of credential, which cannot `what` on LinkedIn.
pub(crate) fn token_of<'a>(cred: &'a Credential, what: &str) -> Result<&'a str, ConnectorError> {
    match cred {
        Credential::OAuth { access_token, .. } if !access_token.is_empty() => Ok(access_token),
        Credential::OAuth { .. } => Err(ConnectorError::permanent(
            "the LinkedIn credential has no access token",
        )),
        other => Err(ConnectorError::permanent(format!(
            "a {} credential cannot {what} on LinkedIn",
            other.kind()
        ))),
    }
}

/// Whether the [`Credential::OAuth`] `cred` was granted `scope`.
pub(crate) fn granted(cred: &Credential, scope: &str) -> bool {
    match cred {
        Credential::OAuth { scopes, .. } => scopes.iter().any(|s| s == scope),
        _ => false,
    }
}

/// `id` when it can be a member id (OpenID `sub`) in a URN: 1 to [`MAX_PERSON_ID_CHARS`] ASCII
/// letters, digits, `-` or `_`.
pub(crate) fn person_id(id: &str) -> Option<&str> {
    let ok = (1..=MAX_PERSON_ID_CHARS).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'));
    ok.then_some(id)
}

/// `id` when it can be an organization number: 1 to [`MAX_ORGANIZATION_DIGITS`] ASCII digits.
pub(crate) fn organization_id(id: &str) -> Option<&str> {
    let ok =
        (1..=MAX_ORGANIZATION_DIGITS).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit());
    ok.then_some(id)
}

/// The organization number of the organization URN `urn` (`urn:li:organization:N`).
pub(crate) fn organization_of_urn(urn: &str) -> Option<&str> {
    urn.trim()
        .strip_prefix(ORGANIZATION_URN)
        .and_then(organization_id)
}

/// `urn` when it is a post's URN: `urn:li:share:N` or `urn:li:ugcPost:N`, `N` 1 to
/// [`MAX_POST_DIGITS`] digits.
pub(crate) fn post_urn(urn: &str) -> Option<&str> {
    let number = urn
        .strip_prefix("urn:li:share:")
        .or_else(|| urn.strip_prefix("urn:li:ugcPost:"))?;
    let ok =
        (1..=MAX_POST_DIGITS).contains(&number.len()) && number.bytes().all(|b| b.is_ascii_digit());
    ok.then_some(urn)
}

/// The account of the capability, `public["external_id"]` (a member's `sub`, an organization's
/// number), checked for its kind's shape; `Permanent` when it is missing or misshapen.
pub(crate) fn account_of(kind: Kind, public: &Value) -> Result<String, ConnectorError> {
    let id = text(&public["external_id"]);
    let valid = match kind {
        Kind::Member => id.as_deref().and_then(person_id).map(str::to_owned),
        Kind::Page => id.as_deref().and_then(organization_id).map(str::to_owned),
    };
    valid.ok_or_else(|| {
        ConnectorError::permanent(match kind {
            Kind::Member => "the capability names no LinkedIn member id",
            Kind::Page => "the capability names no LinkedIn organization number",
        })
    })
}

/// The URN of the capability's account: `urn:li:person:{sub}` or `urn:li:organization:{N}`.
pub(crate) fn author_of(kind: Kind, public: &Value) -> Result<String, ConnectorError> {
    let id = account_of(kind, public)?;
    Ok(match kind {
        Kind::Member => format!("{PERSON_URN}{id}"),
        Kind::Page => format!("{ORGANIZATION_URN}{id}"),
    })
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn the_kinds_are_linkedin_member_and_page() {
        assert_eq!(
            kind_of(&json!({ "kind_key": "linkedin_member" })).unwrap(),
            Kind::Member
        );
        assert_eq!(
            kind_of(&json!({ "kind_key": "linkedin_page" })).unwrap(),
            Kind::Page
        );
        for public in [
            json!({}),
            json!(null),
            json!({ "kind_key": null }),
            json!({ "kind_key": "LinkedIn_Page" }),
            json!({ "kind_key": "linkedin_ads" }),
            json!({ "kind_key": "x" }),
        ] {
            let e = kind_of(&public).unwrap_err();
            assert_eq!((e.kind(), e.reason()), ("permanent", Some(KIND_MISSING)));
        }
    }

    #[test]
    fn only_an_oauth_credential_has_a_linkedin_token() {
        let oauth = Credential::OAuth {
            access_token: "tok".into(),
            refresh_token: None,
            expires_at: None,
            scopes: vec!["openid".into()],
        };
        assert_eq!(token_of(&oauth, "post").unwrap(), "tok");
        assert!(granted(&oauth, "openid"));
        assert!(!granted(&oauth, "rw_organization_admin"));
        let page = Credential::PageToken {
            page_id: "1".into(),
            token: "EAAB-SECRET".into(),
        };
        let e = token_of(&page, "post").unwrap_err();
        assert_eq!(
            e.reason(),
            Some("a page_token credential cannot post on LinkedIn")
        );
        assert!(!granted(&page, "openid"));
    }

    #[test]
    fn accounts_and_urns_cannot_change_what_they_are_put_in() {
        let member = json!({ "external_id": "a1B2-c_3" });
        assert_eq!(
            author_of(Kind::Member, &member).unwrap(),
            "urn:li:person:a1B2-c_3"
        );
        assert_eq!(
            author_of(Kind::Page, &json!({ "external_id": 2_414_183 })).unwrap(),
            "urn:li:organization:2414183"
        );
        for bad in [
            json!({}),
            json!({ "external_id": "" }),
            json!({ "external_id": "a/b" }),
            json!({ "external_id": "a:b" }),
            json!({ "external_id": "x".repeat(65) }),
        ] {
            assert!(account_of(Kind::Member, &bad).is_err(), "{bad}");
        }
        for bad in [
            json!({ "external_id": "12a" }),
            json!({ "external_id": "urn:li:organization:1" }),
            json!({ "external_id": "1".repeat(21) }),
        ] {
            assert!(account_of(Kind::Page, &bad).is_err(), "{bad}");
        }
        assert_eq!(organization_of_urn("urn:li:organization:42"), Some("42"));
        assert_eq!(organization_of_urn("urn:li:organizationBrand:42"), None);
        assert_eq!(organization_of_urn("urn:li:organization:4/2"), None);
        assert_eq!(post_urn("urn:li:share:1"), Some("urn:li:share:1"));
        assert_eq!(post_urn("urn:li:ugcPost:12"), Some("urn:li:ugcPost:12"));
        for bad in [
            "",
            "urn:li:share:",
            "urn:li:share:1a",
            "urn:li:video:1",
            "1",
            "urn:li:share:1)",
        ] {
            assert_eq!(post_urn(bad), None, "{bad:?}");
        }
    }
}
