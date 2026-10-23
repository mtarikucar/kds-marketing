//! SMS over REST v2: sending, delivery reports, the inbox backup, the balance and the approved
//! sender names.
//!
//! | Call | Request | Answer read |
//! |---|---|---|
//! | send | `POST /sms/rest/v2/send {msgheader, messages: [{msg, no, referansID?}], encoding?: "TR", iysfilter: "1" | "0"}` | `jobid` (a string, or a number kept digit for digit), optional integer `cost_minor` |
//! | report | `POST /sms/rest/v2/report {jobids}`, at most 50 per call | `jobs[] {jobid, telno, status, deliveredDate, errorCode}` |
//! | inbox | `GET /sms/rest/v2/inbox?startdate&stopdate`, always both (`ddMMyyyyHHmm`, Turkish time) | `messages[] {msg, no, date, id}` |
//! | balance | `POST /balance {stip: 3}` | rows `{balance_name, amount}`, bare or under `balance` |
//! | sender names | `GET /sms/rest/v2/msgheader` | `msgheaders[]` |
//!
//! All with HTTP basic authentication (`usercode:password`). `encoding: "TR"` is sent only when
//! the text holds a letter only the Turkish alphabet has (it shortens a segment, so plain text
//! goes without); `iysfilter` is `"1"` for commercial messages and `"0"` for informational replies. The inbox is never asked without both dates: NetGSM's dateless form
//! marks every message as read, racing the callback.
//!
//! Codes that say "nothing here" rather than an error, read as such (NetGSM's meaning on these
//! endpoints, where the table's meaning cannot apply):
//!
//! | Endpoint | Code | Read as |
//! |---|---|---|
//! | inbox | `40`: no message to show | no message |
//! | report | `60`: no record for these job ids (not yet reportable, or past the report window) | no row for that chunk; the other chunks' rows are kept |
//! | balance | `60`: the credentials are valid but the account has no package | no balance (`None`); the probe goes on to the sender names |
//!
//! The balance, the sender names, reports and the inbox are reads (retried when no answer
//! arrived); sending is an action, sent once.

use jt_app::ports::connectors::{DeliveryState, DeliveryStatus, InboundEventDraft, SendReceipt};
use jt_connector::{ConnectorError, Credential};
use jt_outbound::Method;
use serde_json::{Map, Value, json};
use time::OffsetDateTime;

use crate::budget::Bucket;
use crate::client::{Auth, Body, Retry, outcome};
use crate::credential::SmsCred;
use crate::json::{pick, text};
use crate::tr_time::{fmt_tr, parse_tr};
use crate::{NetgsmConnector, webhook};

/// The most job ids NetGSM reports on per call.
pub(crate) const REPORT_CHUNK: usize = 50;

/// The longest job id taken, in digits.
const MAX_JOB_ID_DIGITS: usize = 64;

/// The inbox's code for "no message to show".
const INBOX_EMPTY: &str = "40";

/// The report's code for "no record for these job ids".
const REPORT_EMPTY: &str = "60";

/// The balance's code for "valid credentials, no package".
const BALANCE_NO_PACKAGE: &str = "60";

/// The letters only the Turkish alphabet has, which need `encoding: "TR"`.
const TURKISH_LETTERS: &[char] = &['ç', 'Ç', 'ğ', 'Ğ', 'ı', 'İ', 'ö', 'Ö', 'ş', 'Ş', 'ü', 'Ü'];

/// Report statuses that are final failures: generic failures (2, 3, 4, 11, 12), a duplicate
/// (13), a blacklisted recipient (15), no İYS consent (16, 17), expired (22).
const FAILED_STATUSES: &[&str] = &["2", "3", "4", "11", "12", "13", "15", "16", "17", "22"];

/// An account's balance: its credit in Turkish lira when NetGSM names one, and every package
/// with what remains of it, as NetGSM words them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Balance {
    pub credit: Option<String>,
    pub packages: Vec<Package>,
}

/// One package of a [`Balance`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Package {
    pub name: String,
    pub remaining: Option<String>,
}

impl Balance {
    /// The balance as a probe fact.
    pub(crate) fn facts(&self) -> Value {
        json!({
            "credit": self.credit,
            "packages": self
                .packages
                .iter()
                .map(|p| json!({ "name": p.name, "remaining": p.remaining }))
                .collect::<Vec<_>>(),
        })
    }
}

/// The digits of a phone number (`+90 500 000 00 01` is `905000000001`), as NetGSM takes them;
/// `Permanent` when it has fewer than 7 or more than 15.
pub(crate) fn phone_digits(number: &str, what: &str) -> Result<String, ConnectorError> {
    let digits: String = number.chars().filter(char::is_ascii_digit).collect();
    if (7..=15).contains(&digits.len()) {
        Ok(digits)
    } else {
        Err(ConnectorError::permanent(format!(
            "the {what} is not a phone number"
        )))
    }
}

/// `throttle` with the budget's wait, or nothing.
pub(crate) fn take(
    connector: &NetgsmConnector,
    account: &str,
    bucket: Bucket,
    n: usize,
) -> Result<(), ConnectorError> {
    connector
        .budget
        .try_take(account, bucket, n)
        .map_err(|wait| ConnectorError::throttle(Some(wait)))
}

impl NetgsmConnector {
    /// The balance of the SMS account behind `cred` (`POST /balance {stip: 3}`); `None` when the
    /// credentials are valid but the account has no package (code `60`).
    pub async fn balance(&self, cred: &Credential) -> Result<Option<Balance>, ConnectorError> {
        let sms = SmsCred::of(cred, "read the balance")?;
        self.balance_of(sms.usercode, sms.password).await
    }

    pub(crate) async fn balance_of(
        &self,
        usercode: &str,
        password: &str,
    ) -> Result<Option<Balance>, ConnectorError> {
        let answer = self
            .call(
                Method::POST,
                self.api_url(&["balance"], &[]),
                Auth::Basic {
                    user: usercode,
                    password,
                },
                &Body::Json(json!({ "stip": 3 })),
                Retry::Reads,
            )
            .await?;
        if answer.code().as_deref() == Some(BALANCE_NO_PACKAGE) {
            return Ok(None);
        }
        let json = outcome(answer, "the balance", true)?;
        let rows = match &json {
            Value::Array(rows) => rows.as_slice(),
            other => other["balance"].as_array().map_or(&[][..], Vec::as_slice),
        };
        let packages: Vec<Package> = rows
            .iter()
            .filter(|row| row.is_object())
            .map(|row| Package {
                name: pick(row, &["balance_name", "paket", "name"])
                    .unwrap_or_else(|| "paket".into()),
                remaining: pick(row, &["amount", "miktar"])
                    .or_else(|| decimal(row, &["amount", "miktar"])),
            })
            .collect();
        let named_credit = packages
            .iter()
            .find(|p| {
                let name = p.name.to_lowercase();
                ["tl", "kredi", "bakiye"].iter().any(|w| name.contains(w))
            })
            .and_then(|p| p.remaining.clone());
        let bare_credit = text(&json["balance"]).or_else(|| decimal(&json, &["balance", "credit"]));
        Ok(Some(Balance {
            credit: named_credit.or(bare_credit),
            packages,
        }))
    }

    /// The sender names approved on the SMS account behind `cred`
    /// (`GET /sms/rest/v2/msgheader`).
    pub async fn msgheaders(&self, cred: &Credential) -> Result<Vec<String>, ConnectorError> {
        let sms = SmsCred::of(cred, "list sender names")?;
        self.msgheaders_of(sms.usercode, sms.password).await
    }

    pub(crate) async fn msgheaders_of(
        &self,
        usercode: &str,
        password: &str,
    ) -> Result<Vec<String>, ConnectorError> {
        let answer = self
            .call(
                Method::GET,
                self.api_url(&["sms", "rest", "v2", "msgheader"], &[]),
                Auth::Basic {
                    user: usercode,
                    password,
                },
                &Body::Empty,
                Retry::Reads,
            )
            .await?;
        let json = outcome(answer, "the sender names", false)?;
        Ok(json["msgheaders"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(text)
            .collect())
    }
}

/// A decimal number under one of `keys`, as text (a balance may come as `12.5`).
fn decimal(row: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| match &row[*key] {
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

/// Sends `text` to `to` (see the module docs).
pub(crate) async fn send(
    connector: &NetgsmConnector,
    cred: &Credential,
    to: &str,
    text_body: &str,
    reference: Option<&str>,
    commercial: bool,
) -> Result<SendReceipt, ConnectorError> {
    let sms = SmsCred::of(cred, "send SMS")?;
    let no = phone_digits(to, "recipient")?;
    if text_body.trim().is_empty() {
        return Err(ConnectorError::permanent("the message is empty"));
    }
    let mut message = Map::new();
    message.insert("msg".into(), json!(text_body));
    message.insert("no".into(), json!(no));
    if let Some(reference) = reference.map(str::trim).filter(|r| !r.is_empty()) {
        message.insert("referansID".into(), json!(reference));
    }
    let mut body = Map::new();
    body.insert("msgheader".into(), json!(sms.msgheader));
    body.insert("messages".into(), json!([Value::Object(message)]));
    if text_body.contains(TURKISH_LETTERS) {
        body.insert("encoding".into(), json!("TR"));
    }
    // Commercial SMS targets individuals ("11"); business recipients ("12") are not used yet.
    body.insert(
        "iysfilter".into(),
        json!(if commercial { "11" } else { "0" }),
    );
    let answer = connector
        .call(
            Method::POST,
            connector.api_url(&["sms", "rest", "v2", "send"], &[]),
            Auth::Basic {
                user: sms.usercode,
                password: sms.password,
            },
            &Body::Json(Value::Object(body)),
            Retry::Never,
        )
        .await?;
    let json = outcome(answer, "the send", false)?;
    let job = text(&json["jobid"])
        .ok_or_else(|| ConnectorError::permanent("NetGSM accepted the send but named no job id"))?;
    Ok(SendReceipt {
        provider_id: job,
        cost_minor: text(&json["cost_minor"]).and_then(|cost| cost.parse().ok()),
    })
}

/// The delivery reports of `job_ids`, 50 per call; the calls are taken from the account's
/// report budget all at once, before the first is sent.
pub(crate) async fn report(
    connector: &NetgsmConnector,
    cred: &Credential,
    job_ids: &[String],
) -> Result<Vec<DeliveryStatus>, ConnectorError> {
    let sms = SmsCred::of(cred, "read delivery reports")?;
    if job_ids.is_empty() {
        return Ok(Vec::new());
    }
    for id in job_ids {
        let valid = !id.is_empty()
            && id.len() <= MAX_JOB_ID_DIGITS
            && id.bytes().all(|b| b.is_ascii_digit());
        if !valid {
            return Err(ConnectorError::permanent("not a NetGSM job id"));
        }
    }
    let chunks: Vec<&[String]> = job_ids.chunks(REPORT_CHUNK).collect();
    let most = Bucket::Report.limit();
    if chunks.len() > most {
        return Err(ConnectorError::permanent(format!(
            "at most {} job ids are reported on per call",
            most * REPORT_CHUNK
        )));
    }
    take(connector, sms.usercode, Bucket::Report, chunks.len())?;
    let mut statuses = Vec::new();
    for chunk in chunks {
        let answer = connector
            .call(
                Method::POST,
                connector.api_url(&["sms", "rest", "v2", "report"], &[]),
                Auth::Basic {
                    user: sms.usercode,
                    password: sms.password,
                },
                &Body::Json(json!({ "jobids": chunk })),
                Retry::Reads,
            )
            .await?;
        if answer.code().as_deref() == Some(REPORT_EMPTY) {
            continue;
        }
        let json = outcome(answer, "the delivery report", false)?;
        for row in json["jobs"].as_array().into_iter().flatten() {
            if let Some(status) = delivery_status(row) {
                statuses.push(status);
            }
        }
    }
    Ok(statuses)
}

/// One report row as a [`DeliveryStatus`]; `None` without a job id. `raw_code` is the status,
/// with `:<errorCode>` when the row has one (`"13:105"`).
fn delivery_status(row: &Value) -> Option<DeliveryStatus> {
    let job_id = text(&row["jobid"])?;
    let code = text(&row["status"]).unwrap_or_default();
    let state = match code.as_str() {
        "1" => DeliveryState::Delivered,
        "0" => DeliveryState::Pending,
        c if FAILED_STATUSES.contains(&c) => DeliveryState::Failed,
        c => DeliveryState::Unknown(c.to_owned()),
    };
    let raw_code = match text(&row["errorCode"]) {
        Some(error) => format!("{code}:{error}"),
        None => code,
    };
    Some(DeliveryStatus {
        job_id,
        recipient: text(&row["telno"]).unwrap_or_default(),
        status: state,
        at: row["deliveredDate"].as_str().and_then(parse_tr),
        raw_code,
    })
}

/// The messages that arrived between `from` and `to`, as the callback's events (see the module
/// docs); one call from the account's inbox budget.
pub(crate) async fn inbox(
    connector: &NetgsmConnector,
    cred: &Credential,
    from: OffsetDateTime,
    to: OffsetDateTime,
) -> Result<Vec<InboundEventDraft>, ConnectorError> {
    let sms = SmsCred::of(cred, "read the inbox")?;
    if to < from {
        return Err(ConnectorError::permanent(
            "the inbox window ends before it starts",
        ));
    }
    take(connector, sms.usercode, Bucket::Inbox, 1)?;
    let (start, stop) = (fmt_tr(from), fmt_tr(to));
    let answer = connector
        .call(
            Method::GET,
            connector.api_url(
                &["sms", "rest", "v2", "inbox"],
                &[("startdate", &start), ("stopdate", &stop)],
            ),
            Auth::Basic {
                user: sms.usercode,
                password: sms.password,
            },
            &Body::Empty,
            Retry::Reads,
        )
        .await?;
    if answer.code().as_deref() == Some(INBOX_EMPTY) {
        return Ok(Vec::new());
    }
    let json = outcome(answer, "the inbox", false)?;
    let rows = match json.get("messages") {
        Some(Value::Array(rows)) => rows.clone(),
        _ => Vec::new(),
    };
    Ok(rows.into_iter().filter_map(webhook::mo_draft).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phone_numbers_are_their_digits() {
        assert_eq!(
            phone_digits("+90 (500) 000-00-01", "r").unwrap(),
            "905000000001"
        );
        assert_eq!(phone_digits("05000000001", "r").unwrap(), "05000000001");
        for bad in ["", "abc", "123456", "1234567890123456"] {
            assert_eq!(
                phone_digits(bad, "r").unwrap_err().kind(),
                "permanent",
                "{bad}"
            );
        }
    }

    #[test]
    fn report_rows_map_to_states() {
        for (status, expected) in [
            (json!(1), DeliveryState::Delivered),
            (json!("0"), DeliveryState::Pending),
            (json!(16), DeliveryState::Failed),
            (json!("22"), DeliveryState::Failed),
            (json!(7), DeliveryState::Unknown("7".into())),
            (json!(null), DeliveryState::Unknown(String::new())),
        ] {
            let row = json!({ "jobid": "1", "telno": "905000000001", "status": status });
            assert_eq!(delivery_status(&row).unwrap().status, expected, "{row}");
        }
        assert_eq!(delivery_status(&json!({ "status": 1 })), None);
    }
}
