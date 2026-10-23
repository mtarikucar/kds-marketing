//! The NetGSM credentials, by what they reach, and the capability's kind as the use cases hand it
//! in `public`.

use std::fmt;

use jt_connector::{ConnectorError, Credential, Provider};
use serde_json::Value;

use crate::Masked;

/// An SMS API sub-user and its approved sender name. `Debug` masks the password.
#[derive(Clone, Copy)]
pub(crate) struct SmsCred<'a> {
    pub(crate) usercode: &'a str,
    pub(crate) password: &'a str,
    pub(crate) msgheader: &'a str,
}

/// A Netsantral (PBX) user. `Debug` masks the password.
#[derive(Clone, Copy)]
pub(crate) struct PbxCred<'a> {
    pub(crate) username: &'a str,
    pub(crate) password: &'a str,
    pub(crate) trunk: Option<&'a str>,
    pub(crate) pbxnum: Option<&'a str>,
}

/// An İYS user and its brand code. `Debug` masks the password.
#[derive(Clone, Copy)]
pub(crate) struct IysCred<'a> {
    pub(crate) usercode: &'a str,
    pub(crate) password: &'a str,
    pub(crate) brand_code: &'a str,
}

/// `Permanent`: `cred` is not of a kind that can `what` on NetGSM.
pub(crate) fn wrong_credential(cred: &Credential, what: &str) -> ConnectorError {
    ConnectorError::permanent(format!(
        "a {} credential cannot {what} on NetGSM",
        cred.kind()
    ))
}

/// `Permanent`: a field the call needs is empty.
fn empty(what: &str) -> ConnectorError {
    ConnectorError::permanent(format!("the NetGSM credential has no {what}"))
}

/// `value` when it holds something besides whitespace.
fn present<'a>(value: &'a str, what: &str) -> Result<&'a str, ConnectorError> {
    if value.trim().is_empty() {
        Err(empty(what))
    } else {
        Ok(value)
    }
}

impl<'a> SmsCred<'a> {
    /// `cred` as an SMS credential, else `Permanent` (it cannot `what`).
    pub(crate) fn of(cred: &'a Credential, what: &str) -> Result<SmsCred<'a>, ConnectorError> {
        match cred {
            Credential::NetgsmSms {
                usercode,
                password,
                msgheader,
            } => Ok(SmsCred {
                usercode: present(usercode, "user code")?,
                password: present(password, "password")?,
                msgheader: present(msgheader, "sender name")?,
            }),
            other => Err(wrong_credential(other, what)),
        }
    }
}

impl<'a> PbxCred<'a> {
    /// `cred` as a PBX credential, else `Permanent` (it cannot `what`).
    pub(crate) fn of(cred: &'a Credential, what: &str) -> Result<PbxCred<'a>, ConnectorError> {
        match cred {
            Credential::NetgsmPbx {
                username,
                password,
                trunk,
                pbxnum,
            } => Ok(PbxCred {
                username: present(username, "user name")?,
                password: present(password, "password")?,
                trunk: trunk.as_deref().filter(|t| !t.trim().is_empty()),
                pbxnum: pbxnum.as_deref().filter(|p| !p.trim().is_empty()),
            }),
            other => Err(wrong_credential(other, what)),
        }
    }
}

impl<'a> IysCred<'a> {
    /// `cred` as an İYS credential, else `Permanent` (it cannot `what`; an SMS credential carries
    /// no brand code).
    pub(crate) fn of(cred: &'a Credential, what: &str) -> Result<IysCred<'a>, ConnectorError> {
        match cred {
            Credential::NetgsmIys {
                usercode,
                password,
                brand_code,
            } => Ok(IysCred {
                usercode: present(usercode, "user code")?,
                password: present(password, "password")?,
                brand_code: present(brand_code, "brand code")?,
            }),
            other => Err(wrong_credential(other, what)),
        }
    }
}

impl fmt::Debug for SmsCred<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("SmsCred")
            .field("usercode", &self.usercode)
            .field("password", &Masked)
            .field("msgheader", &self.msgheader)
            .finish()
    }
}

impl fmt::Debug for PbxCred<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PbxCred")
            .field("username", &self.username)
            .field("password", &Masked)
            .field("trunk", &self.trunk)
            .field("pbxnum", &self.pbxnum)
            .finish()
    }
}

impl fmt::Debug for IysCred<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("IysCred")
            .field("usercode", &self.usercode)
            .field("password", &Masked)
            .field("brand_code", &self.brand_code)
            .finish()
    }
}

/// The reason every operation that depends on the kind refuses a `public` without a NetGSM kind.
pub(crate) const KIND_MISSING: &str = "kind_key missing";

/// The capability's kind, as the use cases hand it in `public["kind_key"]`: one of the kinds
/// NetGSM serves (`sms_line`, `netgsm_pbx`), else `Permanent` ([`KIND_MISSING`]). Never guessed
/// from the credential.
pub(crate) fn kind_of(public: &Value) -> Result<&str, ConnectorError> {
    public["kind_key"]
        .as_str()
        .filter(|kind| Provider::Netgsm.kinds().contains(kind))
        .ok_or_else(|| ConnectorError::permanent(KIND_MISSING))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn debug_masks_every_password() {
        let sms = Credential::NetgsmSms {
            usercode: "8500000001".into(),
            password: "sms-SECRET".into(),
            msgheader: "TESTHDR".into(),
        };
        let pbx = Credential::NetgsmPbx {
            username: "8500000002".into(),
            password: "pbx-SECRET".into(),
            trunk: Some("8500000003".into()),
            pbxnum: None,
        };
        let iys = Credential::NetgsmIys {
            usercode: "8500000001".into(),
            password: "iys-SECRET".into(),
            brand_code: "600001".into(),
        };
        let printed = [
            format!("{:?}", SmsCred::of(&sms, "t").unwrap()),
            format!("{:#?}", PbxCred::of(&pbx, "t").unwrap()),
            format!("{:?}", IysCred::of(&iys, "t").unwrap()),
        ];
        for text in &printed {
            assert!(!text.contains("SECRET"), "{text}");
            assert!(text.contains("***"), "{text}");
        }
        assert!(printed[0].contains("TESTHDR"), "{}", printed[0]);
        assert!(printed[1].contains("8500000003"), "{}", printed[1]);
        assert!(printed[2].contains("600001"), "{}", printed[2]);
    }

    #[test]
    fn a_credential_of_another_kind_or_with_an_empty_field_is_refused() {
        let pbx = Credential::NetgsmPbx {
            username: "8500000002".into(),
            password: "pw".into(),
            trunk: Some(" ".into()),
            pbxnum: None,
        };
        assert_eq!(PbxCred::of(&pbx, "t").unwrap().trunk, None);
        let e = SmsCred::of(&pbx, "send SMS").unwrap_err();
        assert_eq!(e.kind(), "permanent");
        assert_eq!(
            e.reason(),
            Some("a netgsm_pbx credential cannot send SMS on NetGSM")
        );
        let blank = Credential::NetgsmSms {
            usercode: "8500000001".into(),
            password: "pw".into(),
            msgheader: "  ".into(),
        };
        assert_eq!(SmsCred::of(&blank, "t").unwrap_err().kind(), "permanent");
        assert!(IysCred::of(&blank, "t").is_err());
    }

    #[test]
    fn the_kind_is_one_netgsm_serves() {
        assert_eq!(
            kind_of(&json!({ "kind_key": "sms_line" })).unwrap(),
            "sms_line"
        );
        assert_eq!(
            kind_of(&json!({ "kind_key": "netgsm_pbx" })).unwrap(),
            "netgsm_pbx"
        );
        for public in [
            json!({}),
            json!({ "kind_key": null }),
            json!({ "kind_key": "messenger" }),
            json!({ "kind_key": "SMS_LINE" }),
            json!(null),
        ] {
            let e = kind_of(&public).unwrap_err();
            assert_eq!((e.kind(), e.reason()), ("permanent", Some(KIND_MISSING)));
        }
    }
}
