//! İYS, the consent registry, through NetGSM: recording consent changes (`POST /iys/add`, at most
//! 500 rows per call; NetGSM confirms them later, by callback) and reading one recipient's state
//! (`POST /iys/search`).
//!
//! Both take HTTP basic authentication and İYS's own header in the body,
//! `{username, password, brandCode}`; a row is `{recipient, type, status, consentDate, source}`
//! with `type` one of `MESAJ`, `ARAMA`, `EPOSTA`, `status` `ONAY` (granted) or `RET` (withdrawn)
//! and `consentDate` as `yyyy-MM-dd HH:mm:ss` in Turkish time. Every call is taken from the
//! account's İYS budget (10 a minute), all of a request's calls at once before the first is sent.

use jt_app::ports::connectors::{ConsentRow, SendReceipt};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::{Value, json};

use crate::NetgsmConnector;
use crate::budget::Bucket;
use crate::client::{Auth, Body, outcome};
use crate::credential::IysCred;
use crate::json::{pick, text};
use crate::sms::take;
use crate::tr_time::fmt_iys;

/// The most rows İYS takes per call.
pub(crate) const ADD_CHUNK: usize = 500;

/// The consent channels İYS knows.
pub(crate) const CHANNELS: &[&str] = &["MESAJ", "ARAMA", "EPOSTA"];

/// A recipient's consent as İYS holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum IysStatus {
    /// `ONAY`: consent granted.
    Granted,
    /// `RET`: consent refused or withdrawn.
    Refused,
    /// `YOK`: İYS holds no record (no consent to commercial messages).
    Absent,
}

/// İYS's header in the body. It holds the password: the body is never logged.
fn header(iys: &IysCred<'_>) -> Value {
    json!({
        "username": iys.usercode,
        "password": iys.password,
        "brandCode": iys.brand_code,
    })
}

/// `channel` when İYS knows it, else `Permanent`.
fn channel(channel: &str) -> Result<&str, ConnectorError> {
    CHANNELS
        .iter()
        .copied()
        .find(|c| *c == channel)
        .ok_or_else(|| {
            ConnectorError::permanent("the consent channel is not MESAJ, ARAMA or EPOSTA")
        })
}

/// One row in İYS's form, checked.
fn row(index: usize, row: &ConsentRow) -> Result<Value, ConnectorError> {
    let refuse = |what: &str| ConnectorError::permanent(format!("consent row {index}: {what}"));
    let kind = channel(&row.channel).map_err(|_| refuse("unknown channel"))?;
    if row.recipient.trim().is_empty() {
        return Err(refuse("no recipient"));
    }
    if row.source.trim().is_empty() {
        return Err(refuse("no source"));
    }
    Ok(json!({
        "recipient": row.recipient.trim(),
        "type": kind,
        "status": if row.granted { "ONAY" } else { "RET" },
        "consentDate": fmt_iys(row.at),
        "source": row.source.trim(),
    }))
}

/// Records `rows` (see the module docs). The receipt's provider id is the request ids İYS gave
/// the rows, in order, joined by `,` (empty when it gave none). No rows: nothing is called and the
/// id is empty. A chunk refused after others were accepted fails the whole request; sending it
/// again is safe (İYS keeps one record per recipient and channel).
pub(crate) async fn add(
    connector: &NetgsmConnector,
    cred: &Credential,
    rows: &[ConsentRow],
) -> Result<SendReceipt, ConnectorError> {
    let iys = IysCred::of(cred, "record consent")?;
    let wire: Vec<Value> = rows
        .iter()
        .enumerate()
        .map(|(i, r)| row(i, r))
        .collect::<Result<_, _>>()?;
    if wire.is_empty() {
        return Ok(SendReceipt {
            provider_id: String::new(),
        });
    }
    let chunks: Vec<&[Value]> = wire.chunks(ADD_CHUNK).collect();
    let most = Bucket::Iys.limit();
    if chunks.len() > most {
        return Err(ConnectorError::permanent(format!(
            "at most {} consent rows are recorded per call",
            most * ADD_CHUNK
        )));
    }
    take(connector, iys.usercode, Bucket::Iys, chunks.len())?;
    let mut refids = Vec::new();
    for chunk in chunks {
        let body = Body::Json(json!({ "header": header(&iys), "iysRecipients": chunk }));
        let answer = connector
            .call(
                Method::POST,
                connector.api_url(&["iys", "add"], &[]),
                Auth::Basic {
                    user: iys.usercode,
                    password: iys.password,
                },
                &body,
            )
            .await?;
        let json = outcome(answer, "the consent records", false)?;
        refids.extend(request_ids(&json));
    }
    Ok(SendReceipt {
        provider_id: refids.join(","),
    })
}

/// The request ids of an `/iys/add` answer: its rows (`iysRecipients`, `iys_recipients`,
/// `recipients` or `refids`), each a string or an object with `refid` (in any of its casings).
fn request_ids(json: &Value) -> Vec<String> {
    let rows = ["iysRecipients", "iys_recipients", "recipients", "refids"]
        .iter()
        .find_map(|key| json[*key].as_array())
        .map_or(&[][..], Vec::as_slice);
    rows.iter()
        .filter_map(|r| {
            text(r).or_else(|| pick(r, &["refid", "refId", "RefId", "referenceId", "refID"]))
        })
        .collect()
}

impl NetgsmConnector {
    /// The consent İYS holds for `recipient` on `channel` (`MESAJ`, `ARAMA` or `EPOSTA`), with the
    /// İYS credential `cred`; one call from the account's İYS budget. An answer naming no known
    /// state is `Permanent` (consent is never guessed).
    pub async fn iys_search(
        &self,
        cred: &Credential,
        recipient: &str,
        channel_name: &str,
    ) -> Result<IysStatus, ConnectorError> {
        let iys = IysCred::of(cred, "read consent")?;
        let kind = channel(channel_name)?;
        let recipient = recipient.trim();
        if recipient.is_empty() {
            return Err(ConnectorError::permanent("no recipient to look up"));
        }
        take(self, iys.usercode, Bucket::Iys, 1)?;
        let body = Body::Json(json!({
            "header": header(&iys),
            "recipient": recipient,
            "type": kind,
        }));
        let answer = self
            .call(
                Method::POST,
                self.api_url(&["iys", "search"], &[]),
                Auth::Basic {
                    user: iys.usercode,
                    password: iys.password,
                },
                &body,
            )
            .await?;
        let json = outcome(answer, "the consent lookup", false)?;
        match pick(&json, &["status", "durum", "sonuc"])
            .map(|s| s.to_uppercase())
            .as_deref()
        {
            Some("ONAY") => Ok(IysStatus::Granted),
            Some("RET") => Ok(IysStatus::Refused),
            Some("YOK") => Ok(IysStatus::Absent),
            _ => Err(ConnectorError::permanent(
                "İYS answered no consent state it is known to give",
            )),
        }
    }
}

#[cfg(test)]
mod tests {
    use time::macros::datetime;

    use super::*;

    fn consent(channel: &str, recipient: &str, source: &str) -> ConsentRow {
        ConsentRow {
            recipient: recipient.into(),
            channel: channel.into(),
            granted: true,
            source: source.into(),
            at: datetime!(2026-10-22 22:00 UTC),
        }
    }

    #[test]
    fn rows_take_iys_form_and_are_checked() {
        assert_eq!(
            row(0, &consent("EPOSTA", " ornek@example.invalid ", "HS_WEB")).unwrap(),
            json!({
                "recipient": "ornek@example.invalid",
                "type": "EPOSTA",
                "status": "ONAY",
                "consentDate": "2026-10-23 01:00:00",
                "source": "HS_WEB",
            })
        );
        for bad in [
            consent("mesaj", "+905000000001", "HS_WEB"),
            consent("MESAJ", " ", "HS_WEB"),
            consent("MESAJ", "+905000000001", ""),
        ] {
            let e = row(3, &bad).unwrap_err();
            assert!(e.reason().unwrap().starts_with("consent row 3: "), "{e}");
        }
    }

    #[test]
    fn request_ids_come_in_every_casing() {
        assert_eq!(
            request_ids(&json!({ "iysRecipients": [{ "refid": "a" }, { "refId": 2 }, {}] })),
            ["a", "2"]
        );
        assert_eq!(request_ids(&json!({ "refids": ["x", "y"] })), ["x", "y"]);
        assert!(request_ids(&json!({ "code": "00" })).is_empty());
    }
}
