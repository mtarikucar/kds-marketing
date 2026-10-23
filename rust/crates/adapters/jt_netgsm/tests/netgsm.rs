//! The NetGSM adapter against the in-process mock: hosts, SMS send (body, basic auth, numeric job
//! ids), the error table, retries, delivery reports, the inbox backup, the rate budget, probes,
//! Netsantral calls, İYS and call records. Every test is offline.

mod support;

use std::sync::Arc;
use std::time::Duration as StdDuration;

use jt_app::ports::connectors::{
    Connector, ConsentRow, ConsentSync, DeliveryReports, DeliveryState, SmsSender, Telephony,
};
use jt_connector::{ConnectorError, Credential, EventKind, Provider};
use jt_netgsm::{
    IysStatus, NETGSM_HOSTS, NetgsmBases, NetgsmConnector, RateBudgeter, RetryPolicy, fmt_tr,
};
use jt_outbound::FIXED_HOSTS;
use serde_json::{Value, json};
use support::*;
use time::Duration;
use time::macros::datetime;

const SEND: &str = "/api/sms/rest/v2/send";
const REPORT: &str = "/api/sms/rest/v2/report";
const INBOX: &str = "/api/sms/rest/v2/inbox";
const BALANCE: &str = "/api/balance";
const HEADERS: &str = "/api/sms/rest/v2/msgheader";
const IYS_ADD: &str = "/api/iys/add";
const IYS_SEARCH: &str = "/api/iys/search";
const CDR: &str = "/api/netsantral/report";

/// The Netsantral path of `verb` for the fixtures' PBX user.
fn pbx(verb: &str) -> String {
    format!("/pbx/{PBX_USER}/{verb}")
}

fn kind_of<T: std::fmt::Debug>(r: Result<T, ConnectorError>) -> &'static str {
    r.expect_err("an error").kind()
}

/// `n` job ids, `17` followed by 24 digits.
fn job_ids(n: usize) -> Vec<String> {
    (1..=n).map(|i| format!("17{i:024}")).collect()
}

// ---------------------------------------------------------------------------------------------
// Hosts and the connector itself
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn hosts_are_the_fixed_netgsm_hosts() {
    let r = rig().await;
    let fixed: Vec<&str> = FIXED_HOSTS
        .iter()
        .filter(|h| h.connector == "netgsm")
        .map(|h| h.host)
        .collect();
    assert_eq!(r.netgsm.hosts(), fixed.as_slice());
    assert_eq!(NETGSM_HOSTS, fixed.as_slice());
    assert_eq!(r.netgsm.provider(), Provider::Netgsm);
    // The production bases reach exactly those hosts: the API over https, Netsantral over the
    // one plain-http exception.
    let production = NetgsmBases::production();
    assert_eq!(production.api.as_str(), "https://api.netgsm.com.tr/");
    assert_eq!(
        production.pbx.as_str(),
        "http://crmsntrl.netgsm.com.tr:9111/"
    );
    assert!(fixed.contains(&production.api.host_str().unwrap()));
    let pbx_host = format!(
        "{}:{}",
        production.pbx.host_str().unwrap(),
        production.pbx.port().unwrap()
    );
    assert!(fixed.contains(&pbx_host.as_str()), "{pbx_host}");
}

#[tokio::test]
async fn refresh_needs_nothing_and_connecting_does_nothing() {
    let r = rig().await;
    assert_eq!(r.netgsm.refresh(&sms_cred()).await, Ok(None));
    assert_eq!(
        r.netgsm
            .on_connected(&sms_cred(), &public("sms_line"))
            .await,
        Ok(Value::Null)
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn debug_masks_every_secret() {
    let r = rig().await;
    let printed = format!("{:?} {:?}", r.netgsm, r.netgsm.bases());
    assert_no_password(&printed);
    assert!(printed.contains("NetgsmConnector"), "{printed}");
}

// ---------------------------------------------------------------------------------------------
// SMS send
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn send_posts_the_v2_body_with_basic_auth() {
    let r = rig().await;
    r.mock.on("POST", SEND, rest("send"));
    let receipt = r
        .netgsm
        .send(
            &sms_cred(),
            "+90 500 000 00 01",
            "Merhaba dünya, randevunuz yarın",
            Some("ref-1"),
            false,
        )
        .await
        .unwrap();
    assert_eq!(receipt.provider_id, "17000000000000000000000001");
    let sent = r.mock.request("POST", SEND);
    assert_eq!(
        sent.header("authorization"),
        Some(basic(USERCODE, PASSWORD).as_str())
    );
    assert_eq!(sent.header("content-type"), Some("application/json"));
    assert_eq!(
        sent.json(),
        json!({
            "msgheader": MSGHEADER,
            "messages": [{
                "msg": "Merhaba dünya, randevunuz yarın",
                "no": "905000000001",
                "referansID": "ref-1",
            }],
            "encoding": "TR",
            "iysfilter": "0",
        })
    );
    // Plain text needs no Turkish encoding; no reference, no `referansID`.
    r.mock.clear();
    r.netgsm
        .send(&sms_cred(), "905000000002", "Randevu: 10:30", None, false)
        .await
        .unwrap();
    assert_eq!(
        r.mock.request("POST", SEND).json(),
        json!({
            "msgheader": MSGHEADER,
            "messages": [{ "msg": "Randevu: 10:30", "no": "905000000002" }],
            "iysfilter": "0",
        })
    );
}

#[tokio::test]
async fn send_keeps_a_numeric_job_id_exact() {
    let r = rig().await;
    r.mock.on(
        "POST",
        SEND,
        raw(200, &fixture_text("rest/send_numeric_jobid.txt")),
    );
    let receipt = r
        .netgsm
        .send(&sms_cred(), "905000000001", "Merhaba", None, false)
        .await
        .unwrap();
    assert_eq!(receipt.provider_id, "17000000000000000000000009");
}

#[tokio::test]
async fn send_refuses_what_cannot_be_sent_without_calling() {
    let r = rig().await;
    for (to, text) in [("", "Merhaba"), ("abc", "Merhaba"), ("905000000001", "  ")] {
        assert_eq!(
            kind_of(r.netgsm.send(&sms_cred(), to, text, None, false).await),
            "permanent",
            "{to:?} {text:?}"
        );
    }
    // A credential of another kind cannot send SMS.
    assert_eq!(
        kind_of(
            r.netgsm
                .send(&pbx_cred(), "905000000001", "x", None, false)
                .await
        ),
        "permanent"
    );
    assert!(r.mock.recorded().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Errors and retries
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn error_codes_map_by_the_table() {
    let r = rig().await;
    for (code, expected) in [
        ("20", "permanent"),
        ("30", "auth"),
        ("40", "permission"),
        ("50", "permanent"),
        ("51", "permission"),
        ("60", "permission"),
        ("70", "permanent"),
        ("80", "throttle"),
        ("85", "permanent"),
        ("100", "transient"),
        ("999", "permanent"),
    ] {
        r.mock.set(
            "POST",
            SEND,
            ok(json!({ "code": code, "description": "synthetic" })),
        );
        let e = r
            .netgsm
            .send(&sms_cred(), "905000000001", "Merhaba", None, false)
            .await
            .expect_err(code);
        assert_eq!(e.kind(), expected, "code {code}: {e}");
        if code != "80" {
            assert!(e.to_string().contains(code), "code {code}: {e}");
        }
    }
    // Code 30 says where to look; a bare code in a plain-text body reads the same.
    r.mock.set("POST", SEND, raw(200, "30"));
    let e = r
        .netgsm
        .send(&sms_cred(), "905000000001", "Merhaba", None, false)
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "auth");
    assert!(
        e.reason().unwrap().contains("credentials or IP allowlist"),
        "{e}"
    );
    // A throttle carries the provider's wait when it gives one.
    r.mock.set(
        "POST",
        SEND,
        ok(json!({ "code": "80" })).with_header("retry-after", "30"),
    );
    assert_eq!(
        r.netgsm
            .send(&sms_cred(), "905000000001", "Merhaba", None, false)
            .await,
        Err(ConnectorError::throttle(Some(Duration::seconds(30))))
    );
    // Without a code, the HTTP status decides.
    for (reply, expected) in [
        (raw(502, "<html>Bad gateway</html>"), "transient"),
        (raw(503, ""), "transient"),
        // A bare number on an error page is no NetGSM code.
        (raw(502, "502"), "transient"),
        (raw(429, ""), "throttle"),
        (raw(401, ""), "auth"),
        (raw(403, ""), "permission"),
        (raw(404, "not here"), "permanent"),
        (ok(json!({ "description": "no code, no job" })), "permanent"),
    ] {
        r.mock.set("POST", SEND, reply.clone());
        let e = r
            .netgsm
            .send(&sms_cred(), "905000000001", "Merhaba", None, false)
            .await
            .expect_err("an error");
        assert_eq!(e.kind(), expected, "{reply:?}: {e}");
    }
}

#[tokio::test]
async fn no_retry_after_an_unparseable_response() {
    let r = rig().await;
    r.mock
        .on("POST", SEND, raw(200, "<html>beklenmedik yanit</html>"));
    let e = r
        .netgsm
        .send(&sms_cred(), "905000000001", "Merhaba", None, false)
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent", "{e}");
    // The provider may have accepted (and billed) the message: it is never sent twice.
    assert_eq!(r.mock.requests("POST", SEND).len(), 1);

    // Nor after a server error: an answer arrived, so the request reached NetGSM.
    r.mock.clear();
    r.mock.set("POST", SEND, raw(500, "Internal Server Error"));
    let e = r
        .netgsm
        .send(&sms_cred(), "905000000001", "Merhaba", None, false)
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "transient", "{e}");
    assert_eq!(r.mock.requests("POST", SEND).len(), 1);
}

/// A pause long enough for an attempt to time out, and the attempt timeout that makes it so.
const STALL: StdDuration = StdDuration::from_millis(1_500);
const SHORT_TIMEOUT: StdDuration = StdDuration::from_millis(200);

#[tokio::test]
async fn reads_retry_when_no_answer_arrived() {
    // A socket that closes every connection: no answer ever arrives.
    let dropper = Dropper::start().await;
    let netgsm = connector_at(dropper.addr, no_pause(), StdDuration::from_secs(5));
    let window = (START - Duration::hours(1), START);
    let mut reads: Vec<(&str, Result<(), ConnectorError>)> = Vec::new();
    let mut before = dropper.accepted();
    let mut seen = |name: &'static str, outcome: Result<(), ConnectorError>| {
        reads.push((name, outcome));
    };
    seen(
        "report",
        netgsm.report(&sms_cred(), &job_ids(1)).await.map(drop),
    );
    let counts_report = dropper.accepted() - before;
    before = dropper.accepted();
    seen(
        "inbox",
        netgsm
            .inbox(&sms_cred(), window.0, window.1)
            .await
            .map(drop),
    );
    let counts_inbox = dropper.accepted() - before;
    before = dropper.accepted();
    seen("balance", netgsm.balance(&sms_cred()).await.map(drop));
    let counts_balance = dropper.accepted() - before;
    before = dropper.accepted();
    seen("msgheaders", netgsm.msgheaders(&sms_cred()).await.map(drop));
    let counts_headers = dropper.accepted() - before;
    before = dropper.accepted();
    seen(
        "iys_search",
        netgsm
            .iys_search(&iys_cred(), "+905000000061", "MESAJ")
            .await
            .map(drop),
    );
    let counts_search = dropper.accepted() - before;
    before = dropper.accepted();
    let probe = netgsm.probe(&pbx_cred(), &public("netgsm_pbx")).await;
    seen("queuestats", probe.error.map_or(Ok(()), Err));
    let counts_queuestats = dropper.accepted() - before;
    before = dropper.accepted();
    seen(
        "call_records",
        netgsm
            .call_records(&pbx_cred(), window.0, window.1)
            .await
            .map(drop),
    );
    let counts_records = dropper.accepted() - before;
    assert_eq!(
        [
            counts_report,
            counts_inbox,
            counts_balance,
            counts_headers,
            counts_search,
            counts_queuestats,
            counts_records,
        ],
        [3; 7],
        "every read is tried three times"
    );
    for (name, outcome) in reads {
        let e = outcome.expect_err(name);
        assert_eq!(e.kind(), "transient", "{name}: {e}");
        assert!(e.reason().unwrap().contains("no answer"), "{name}: {e}");
    }

    // A read that timed out is tried again, and the second answer is read.
    let r = rig_with_timeout(SHORT_TIMEOUT).await;
    r.mock.on("GET", INBOX, rest("inbox").delayed(STALL));
    r.mock.on("GET", INBOX, rest("inbox"));
    let drafts = r
        .netgsm
        .inbox(&sms_cred(), window.0, window.1)
        .await
        .unwrap();
    assert_eq!(drafts.len(), 2);
    assert_eq!(r.mock.requests("GET", INBOX).len(), 2);
}

#[tokio::test]
async fn post_write_transport_failure_is_unknown() {
    let r = rig_with_timeout(SHORT_TIMEOUT).await;
    let stalled = |name: &str| rest(name).delayed(STALL);
    r.mock.on("POST", SEND, stalled("send"));
    r.mock.on("GET", &pbx("originate"), stalled("originate"));
    r.mock.on("GET", &pbx("linkup"), stalled("linkup"));
    r.mock.on("GET", &pbx("hangup"), stalled("hangup"));
    r.mock.on("POST", IYS_ADD, stalled("iys_add"));
    let mut linkup = public("netgsm_pbx");
    linkup["call_mode"] = json!("linkup");
    let errors = [
        r.netgsm
            .send(&sms_cred(), "905000000001", "Merhaba", None, false)
            .await
            .map(drop),
        r.netgsm
            .click_to_call(&pbx_cred(), &public("netgsm_pbx"), "101", "905000000021")
            .await
            .map(drop),
        r.netgsm
            .click_to_call(&pbx_cred(), &linkup, "905000000022", "905000000021")
            .await
            .map(drop),
        r.netgsm.hangup(&pbx_cred(), "1700000000.9").await,
        r.netgsm.add(&iys_cred(), &[consent_row(0)]).await.map(drop),
    ];
    for e in errors {
        let e = e.expect_err("a timeout");
        assert_eq!(e.kind(), "unknown", "{e}");
        assert!(!e.is_retriable());
        assert!(e.reason().unwrap().contains("outcome is unknown"), "{e}");
        assert_no_password(&format!("{e} {e:?}"));
    }
    // The provider saw each exactly once: no second SMS, no second ring.
    for (method, path) in [
        ("POST", SEND.to_owned()),
        ("GET", pbx("originate")),
        ("GET", pbx("linkup")),
        ("GET", pbx("hangup")),
        ("POST", IYS_ADD.to_owned()),
    ] {
        assert_eq!(r.mock.requests(method, &path).len(), 1, "{method} {path}");
    }

    // Nor when the connection drops before any answer.
    let dropper = Dropper::start().await;
    let netgsm = connector_at(dropper.addr, no_pause(), StdDuration::from_secs(5));
    let before = dropper.accepted();
    assert!(
        netgsm
            .send(&sms_cred(), "905000000001", "Merhaba", None, false)
            .await
            .is_err()
    );
    assert!(
        netgsm
            .click_to_call(&pbx_cred(), &public("netgsm_pbx"), "101", "905000000021")
            .await
            .is_err()
    );
    assert!(netgsm.hangup(&pbx_cred(), "1700000000.9").await.is_err());
    assert!(netgsm.add(&iys_cred(), &[consent_row(0)]).await.is_err());
    assert_eq!(dropper.accepted() - before, 4, "one connection per action");
}

#[tokio::test]
async fn no_password_in_any_error_text() {
    let r = rig().await;
    let mut errors: Vec<ConnectorError> = Vec::new();
    let echo = format!("hata: password={PASSWORD} kullanici={USERCODE} {PASSWORD}");
    let pbx_echo = format!("Kullanici dogrulanamadi password={PBX_PASSWORD} ({PBX_PASSWORD})");
    // A refusal whose own words are quoted in the reason.
    let pbx_quoted = format!("Hatali istek: {PBX_PASSWORD} password={PBX_PASSWORD}");
    for reply in [
        ok(json!({ "code": "30", "description": echo })),
        raw(200, &echo),
        raw(500, &echo),
        raw(401, &echo),
        ok(json!({ "description": echo })),
    ] {
        r.mock.set("POST", SEND, reply.clone());
        r.mock.set("POST", REPORT, reply.clone());
        r.mock.set("GET", INBOX, reply.clone());
        r.mock.set("POST", BALANCE, reply.clone());
        r.mock.set("POST", IYS_ADD, reply.clone());
        r.mock.set("POST", IYS_SEARCH, reply.clone());
        errors.push(
            r.netgsm
                .send(&sms_cred(), "905000000001", "Merhaba", None, false)
                .await
                .unwrap_err(),
        );
        errors.push(r.netgsm.report(&sms_cred(), &job_ids(1)).await.unwrap_err());
        r.clock.advance(Duration::minutes(5));
        errors.push(
            r.netgsm
                .inbox(&sms_cred(), START - Duration::hours(2), START)
                .await
                .unwrap_err(),
        );
        let probe = r.netgsm.probe(&sms_cred(), &public("sms_line")).await;
        assert!(!probe.ok);
        assert_no_password(&format!("{probe:?}"));
        errors.push(probe.error.unwrap());
        errors.push(
            r.netgsm
                .add(&iys_cred(), &[consent_row(0)])
                .await
                .unwrap_err(),
        );
        errors.push(
            r.netgsm
                .iys_search(&iys_cred(), "+905000000061", "MESAJ")
                .await
                .unwrap_err(),
        );
    }
    for reply in [
        ok(json!({ "status": "Error", "message": pbx_echo })),
        ok(json!({ "status": "Error", "message": pbx_quoted })),
        ok(json!({ "code": "30", "status": "Error", "message": pbx_echo })),
        raw(200, &pbx_echo),
        raw(502, &pbx_echo),
    ] {
        for verb in ["originate", "linkup", "hangup", "queuestats"] {
            r.mock.set("GET", &pbx(verb), reply.clone());
        }
        r.mock.set("POST", CDR, reply.clone());
        errors.push(
            r.netgsm
                .click_to_call(&pbx_cred(), &public("netgsm_pbx"), "101", "905000000021")
                .await
                .unwrap_err(),
        );
        let mut linkup = public("netgsm_pbx");
        linkup["call_mode"] = json!("linkup");
        errors.push(
            r.netgsm
                .click_to_call(&pbx_cred(), &linkup, "905000000022", "905000000021")
                .await
                .unwrap_err(),
        );
        errors.push(
            r.netgsm
                .hangup(&pbx_cred(), "1700000000.1")
                .await
                .unwrap_err(),
        );
        let probe = r.netgsm.probe(&pbx_cred(), &public("netgsm_pbx")).await;
        assert!(!probe.ok);
        errors.push(probe.error.unwrap());
        errors.push(
            r.netgsm
                .call_records(&pbx_cred(), START - Duration::hours(1), START)
                .await
                .unwrap_err(),
        );
    }
    // No answer at all from a Netsantral verb, whose URL holds the password.
    let dropper = Dropper::start().await;
    let silent = connector_at(dropper.addr, no_pause(), StdDuration::from_secs(5));
    let mut linkup = public("netgsm_pbx");
    linkup["call_mode"] = json!("linkup");
    errors.push(
        silent
            .click_to_call(&pbx_cred(), &public("netgsm_pbx"), "101", "905000000021")
            .await
            .unwrap_err(),
    );
    errors.push(
        silent
            .click_to_call(&pbx_cred(), &linkup, "905000000022", "905000000021")
            .await
            .unwrap_err(),
    );
    errors.push(
        silent
            .hangup(&pbx_cred(), "1700000000.1")
            .await
            .unwrap_err(),
    );
    errors.push(
        silent
            .probe(&pbx_cred(), &public("netgsm_pbx"))
            .await
            .error
            .unwrap(),
    );
    // A password with reserved characters, echoed encoded.
    let odd = Credential::NetgsmPbx {
        username: PBX_USER.into(),
        password: "Pa&ss w+rd".into(),
        trunk: Some(TRUNK.into()),
        pbxnum: None,
    };
    for echo in [
        "Hatali: Pa%26ss+w%2Brd",
        "Hatali: Pa%26ss%20w%2brd",
        "Hatali: Pa&ss w+rd",
    ] {
        r.mock.set(
            "GET",
            &pbx("originate"),
            ok(json!({ "status": "Error", "message": echo })),
        );
        let e = r
            .netgsm
            .click_to_call(&odd, &public("netgsm_pbx"), "101", "905000000021")
            .await
            .unwrap_err();
        for form in ["Pa%26ss", "Pa&ss", "w+rd", "w%2B", "w%2b"] {
            assert!(!format!("{e} {e:?}").contains(form), "{echo}: {e}");
        }
    }
    assert!(errors.len() > 50, "{}", errors.len());
    // The quoted refusal is quoted, its password gone.
    assert!(
        errors
            .iter()
            .any(|e| e.reason().is_some_and(|r| r.contains("Hatali istek: ***"))),
        "{errors:#?}"
    );
    for e in &errors {
        assert_no_password(&format!("{e}"));
        assert_no_password(&format!("{e:?}"));
    }
}

// ---------------------------------------------------------------------------------------------
// Delivery reports and the inbox backup
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn report_chunks_job_ids_by_fifty() {
    let r = rig().await;
    r.mock.on("POST", REPORT, rest("report"));
    let ids = job_ids(120);
    let statuses = r.netgsm.report(&sms_cred(), &ids).await.unwrap();
    let calls = r.mock.requests("POST", REPORT);
    let sizes: Vec<usize> = calls
        .iter()
        .map(|c| c.json()["jobids"].as_array().unwrap().len())
        .collect();
    assert_eq!(sizes, [50, 50, 20]);
    let sent: Vec<String> = calls
        .iter()
        .flat_map(|c| {
            c.json()["jobids"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        })
        .collect();
    assert_eq!(sent, ids);
    for call in &calls {
        assert_eq!(
            call.header("authorization"),
            Some(basic(USERCODE, PASSWORD).as_str())
        );
    }
    // Each answer has four rows with a job id (a row without one is left out).
    assert_eq!(statuses.len(), 12);
    let first = &statuses[..4];
    assert_eq!(first[0].job_id, "17000000000000000000000001");
    assert_eq!(first[0].recipient, "905000000001");
    assert_eq!(first[0].status, DeliveryState::Delivered);
    // 12:15 Turkish time is 09:15 UTC.
    assert_eq!(first[0].at, Some(datetime!(2026-10-23 09:15 UTC)));
    assert_eq!(first[0].raw_code, "1");
    assert_eq!(first[1].status, DeliveryState::Pending);
    assert_eq!(first[1].at, None);
    assert_eq!(first[2].status, DeliveryState::Failed);
    assert_eq!(first[2].raw_code, "13:105");
    assert_eq!(first[3].status, DeliveryState::Unknown("99".into()));
}

#[tokio::test]
async fn report_code_60_reads_as_no_records() {
    let r = rig().await;
    // Two chunks: the first reports four jobs, the second's are not known (yet, or any more).
    r.mock.on("POST", REPORT, rest("report"));
    r.mock.on("POST", REPORT, ok(json!({ "code": "60" })));
    let statuses = r.netgsm.report(&sms_cred(), &job_ids(60)).await.unwrap();
    assert_eq!(r.mock.requests("POST", REPORT).len(), 2);
    assert_eq!(statuses.len(), 4, "{statuses:#?}");
    assert_eq!(statuses[0].status, DeliveryState::Delivered);
    // A chunk of its own with nothing known is an empty answer, not an error.
    assert_eq!(r.netgsm.report(&sms_cred(), &job_ids(3)).await, Ok(vec![]));
}

#[tokio::test]
async fn report_without_jobs_calls_nothing_and_checks_its_ids() {
    let r = rig().await;
    assert_eq!(r.netgsm.report(&sms_cred(), &[]).await, Ok(vec![]));
    for bad in ["", "17x", "../balance", "17 1"] {
        assert_eq!(
            kind_of(r.netgsm.report(&sms_cred(), &[bad.to_owned()]).await),
            "permanent",
            "{bad:?}"
        );
    }
    // More than a minute's budget of chunks can never be read in one call.
    assert_eq!(
        kind_of(r.netgsm.report(&sms_cred(), &job_ids(50 * 60 + 1)).await),
        "permanent"
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn inbox_always_sends_both_dates_in_turkish_time() {
    let r = rig().await;
    r.mock.on("GET", INBOX, rest("inbox"));
    // 20:30 UTC is 23:30 in Türkiye on the 22nd; 22:30 UTC is 01:30 on the 23rd.
    let (from, to) = (
        datetime!(2026-10-22 20:30 UTC),
        datetime!(2026-10-22 22:30 UTC),
    );
    let drafts = r.netgsm.inbox(&sms_cred(), from, to).await.unwrap();
    let call = r.mock.request("GET", INBOX);
    assert_eq!(call.param("startdate"), Some("221020262330"));
    assert_eq!(call.param("stopdate"), Some("231020260130"));
    assert_eq!(call.param("startdate"), Some(fmt_tr(from).as_str()));
    assert_eq!(
        call.header("authorization"),
        Some(basic(USERCODE, PASSWORD).as_str())
    );
    // The row without a sender is left out; ids are the webhook's, so a poll never duplicates a
    // push.
    assert_eq!(drafts.len(), 2, "{drafts:#?}");
    assert_eq!(drafts[0].external_id, "netgsm-mo:880000001");
    assert_eq!(drafts[0].kind, EventKind::Message);
    assert_eq!(drafts[0].payload["from"], "+905000000011");
    assert_eq!(drafts[0].payload["text"], "Merhaba, bilgi alabilir miyim?");
    assert_eq!(drafts[0].occurred_at, Some(datetime!(2026-10-23 07:15 UTC)));
    assert!(
        drafts[1].external_id.starts_with("netgsm-mo-digest:"),
        "{}",
        drafts[1].external_id
    );
    assert_eq!(drafts[1].payload["from"], "+905000000012");
    assert_eq!(drafts[1].payload["text"], "Teşekkürler");

    // "No message to show" is no message.
    r.clock.advance(Duration::minutes(1));
    r.mock.set("GET", INBOX, ok(json!({ "code": "40" })));
    assert_eq!(r.netgsm.inbox(&sms_cred(), from, to).await, Ok(vec![]));
    r.mock.set("GET", INBOX, ok(json!({ "code": "30" })));
    assert_eq!(kind_of(r.netgsm.inbox(&sms_cred(), from, to).await), "auth");

    // A window that ends before it starts is refused before any call.
    r.mock.clear();
    assert_eq!(
        kind_of(r.netgsm.inbox(&sms_cred(), to, from).await),
        "permanent"
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn rate_budget_refuses_before_calling_provider() {
    let r = rig().await;
    r.mock
        .on("GET", INBOX, ok(json!({ "code": "00", "messages": [] })));
    let window = (START - Duration::hours(2), START);
    for _ in 0..2 {
        assert_eq!(
            r.netgsm.inbox(&sms_cred(), window.0, window.1).await,
            Ok(vec![])
        );
    }
    r.clock.advance(Duration::seconds(20));
    // The third poll within the minute is refused here, with the wait until the first ages out.
    assert_eq!(
        r.netgsm.inbox(&sms_cred(), window.0, window.1).await,
        Err(ConnectorError::throttle(Some(Duration::seconds(40))))
    );
    assert_eq!(r.mock.requests("GET", INBOX).len(), 2);
    // Another account has its own budget.
    let other = Credential::NetgsmSms {
        usercode: "8500000009".into(),
        password: PASSWORD.into(),
        msgheader: MSGHEADER.into(),
    };
    assert!(r.netgsm.inbox(&other, window.0, window.1).await.is_ok());
    // A minute after the first two, there is room again.
    r.clock.advance(Duration::seconds(40));
    assert!(
        r.netgsm
            .inbox(&sms_cred(), window.0, window.1)
            .await
            .is_ok()
    );
    assert_eq!(r.mock.requests("GET", INBOX).len(), 4);

    // A report that would overrun the minute's 60 calls is refused whole.
    r.mock
        .on("POST", REPORT, ok(json!({ "code": "00", "jobs": [] })));
    assert!(
        r.netgsm
            .report(&sms_cred(), &job_ids(50 * 59))
            .await
            .is_ok()
    );
    assert_eq!(r.mock.requests("POST", REPORT).len(), 59);
    assert_eq!(
        kind_of(r.netgsm.report(&sms_cred(), &job_ids(51)).await),
        "throttle"
    );
    assert_eq!(r.mock.requests("POST", REPORT).len(), 59);
}

// ---------------------------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn probe_sms_line_binds_msgheader_as_account_id() {
    let r = rig().await;
    r.mock.on("POST", BALANCE, rest("balance"));
    r.mock.on("GET", HEADERS, rest("msgheader"));
    let probe = r.netgsm.probe(&sms_cred(), &public("sms_line")).await;
    assert!(probe.ok, "{probe:?}");
    assert_eq!(probe.facts["account_id"], MSGHEADER);
    assert_eq!(probe.facts["headers_approved"], true);
    assert_eq!(probe.facts["balance"]["credit"], "125,50");
    assert_eq!(probe.facts["balance"]["packages"][1]["name"], "Adet SMS");
    let balance = r.mock.request("POST", BALANCE);
    assert_eq!(balance.json(), json!({ "stip": 3 }));
    assert_eq!(
        balance.header("authorization"),
        Some(basic(USERCODE, PASSWORD).as_str())
    );
    assert_eq!(
        r.mock.request("GET", HEADERS).header("authorization"),
        Some(basic(USERCODE, PASSWORD).as_str())
    );
    // The account named is the credential's own sender name, never one from `public`.
    let mut claimed = public("sms_line");
    claimed["external_id"] = json!("SOMEONEELSE");
    let probe = r.netgsm.probe(&sms_cred(), &claimed).await;
    assert_eq!(probe.facts["account_id"], MSGHEADER);
}

#[tokio::test]
async fn probe_refuses_unapproved_header() {
    let r = rig().await;
    r.mock.on("POST", BALANCE, rest("balance"));
    r.mock.on(
        "GET",
        HEADERS,
        ok(json!({ "code": "00", "msgheaders": ["OTHERHDR", "testhdr"] })),
    );
    let probe = r.netgsm.probe(&sms_cred(), &public("sms_line")).await;
    assert!(!probe.ok);
    assert_eq!(
        probe.error,
        Some(ConnectorError::permission("msgheader not approved"))
    );
    // Credentials refused: the sender names are not even asked for.
    r.mock.clear();
    r.mock.set("POST", BALANCE, ok(json!({ "code": "30" })));
    let probe = r.netgsm.probe(&sms_cred(), &public("sms_line")).await;
    assert_eq!(probe.error.map(|e| e.kind()), Some("auth"));
    assert!(r.mock.requests("GET", HEADERS).is_empty());
}

#[tokio::test]
async fn probe_sms_line_without_a_package_still_checks_the_header() {
    let r = rig().await;
    // Code 60 on the balance: the credentials are valid, the account has no package.
    r.mock.on("POST", BALANCE, ok(json!({ "code": "60" })));
    r.mock.on("GET", HEADERS, rest("msgheader"));
    let probe = r.netgsm.probe(&sms_cred(), &public("sms_line")).await;
    assert!(probe.ok, "{probe:?}");
    assert_eq!(probe.facts["account_id"], MSGHEADER);
    assert_eq!(probe.facts["balance"], Value::Null);
    assert_eq!(probe.facts["balance_note"], "no_package");
    assert_eq!(probe.facts["headers_approved"], true);
    assert_eq!(r.netgsm.balance(&sms_cred()).await, Ok(None));
    // The header check still decides.
    r.mock.set(
        "GET",
        HEADERS,
        ok(json!({ "code": "00", "msgheaders": ["OTHERHDR"] })),
    );
    let probe = r.netgsm.probe(&sms_cred(), &public("sms_line")).await;
    assert_eq!(
        probe.error,
        Some(ConnectorError::permission("msgheader not approved"))
    );
    // With a package, no note.
    r.mock.set("POST", BALANCE, rest("balance"));
    r.mock.set("GET", HEADERS, rest("msgheader"));
    let probe = r.netgsm.probe(&sms_cred(), &public("sms_line")).await;
    assert!(probe.facts.get("balance_note").is_none(), "{probe:?}");
}

#[tokio::test]
async fn the_sender_name_is_trimmed_once_for_send_check_and_account() {
    let r = rig().await;
    let padded = Credential::NetgsmSms {
        usercode: USERCODE.into(),
        password: PASSWORD.into(),
        msgheader: format!("  {MSGHEADER} "),
    };
    r.mock.on("POST", BALANCE, rest("balance"));
    r.mock.on("GET", HEADERS, rest("msgheader"));
    r.mock.on("POST", SEND, rest("send"));
    let probe = r.netgsm.probe(&padded, &public("sms_line")).await;
    assert_eq!(probe.facts["account_id"], MSGHEADER, "{probe:?}");
    r.netgsm
        .send(&padded, "905000000001", "Merhaba", None, false)
        .await
        .unwrap();
    assert_eq!(r.mock.request("POST", SEND).json()["msgheader"], MSGHEADER);
}

#[tokio::test]
async fn probe_pbx_names_the_username() {
    let r = rig().await;
    r.mock.on("GET", &pbx("queuestats"), rest("queuestats"));
    let probe = r.netgsm.probe(&pbx_cred(), &public("netgsm_pbx")).await;
    assert!(probe.ok, "{probe:?}");
    assert_eq!(probe.facts["account_id"], PBX_USER);
    let call = r.mock.request("GET", &pbx("queuestats"));
    assert_eq!(call.param("username"), Some(PBX_USER));
    assert_eq!(call.param("password"), Some(PBX_PASSWORD));
    // An unknown user is an authentication failure.
    r.mock
        .set("GET", &pbx("queuestats"), rest("santral_unverified"));
    let probe = r.netgsm.probe(&pbx_cred(), &public("netgsm_pbx")).await;
    assert_eq!(probe.error.map(|e| e.kind()), Some("auth"));
}

#[tokio::test]
async fn probe_needs_a_netgsm_kind_and_its_credential() {
    let r = rig().await;
    for public in [
        json!({}),
        json!({ "kind_key": "facebook_page" }),
        json!(null),
    ] {
        let probe = r.netgsm.probe(&sms_cred(), &public).await;
        assert_eq!(
            probe.error,
            Some(ConnectorError::permanent("kind_key missing")),
            "{public}"
        );
    }
    let probe = r.netgsm.probe(&pbx_cred(), &public("sms_line")).await;
    assert_eq!(probe.error.map(|e| e.kind()), Some("permanent"));
    let probe = r.netgsm.probe(&sms_cred(), &public("netgsm_pbx")).await;
    assert_eq!(probe.error.map(|e| e.kind()), Some("permanent"));
    assert!(r.mock.recorded().is_empty());
}

// ---------------------------------------------------------------------------------------------
// Netsantral
// ---------------------------------------------------------------------------------------------

#[tokio::test]
async fn telephony_passes_recording_flags_only_when_allowed() {
    let r = rig().await;
    r.mock.on("GET", &pbx("originate"), rest("originate"));
    let receipt = r
        .netgsm
        .click_to_call(
            &pbx_cred(),
            &public("netgsm_pbx"),
            "101",
            "+90 500 000 00 21",
        )
        .await
        .unwrap();
    let call = r.mock.request("GET", &pbx("originate"));
    assert_eq!(call.param("username"), Some(PBX_USER));
    assert_eq!(call.param("password"), Some(PBX_PASSWORD));
    assert_eq!(call.param("customer_num"), Some("905000000021"));
    assert_eq!(call.param("internal_num"), Some("101"));
    assert_eq!(call.param("trunk"), Some(TRUNK));
    assert_eq!(call.param("pbxnum"), Some(""));
    assert_eq!(call.param("ring_timeout"), Some("30"));
    assert_eq!(call.param("wait_response"), Some("0"));
    assert_eq!(call.param("originate_order"), Some("if"));
    // The call is correlated by the crm_id the adapter chose.
    assert!(!receipt.provider_id.is_empty());
    assert_eq!(call.param("crm_id"), Some(receipt.provider_id.as_str()));
    assert_eq!(call.param("caller_record"), None);
    assert_eq!(call.param("called_record"), None);

    // Recorded only when the workspace's policy says so, as a boolean.
    for (allowed, records) in [
        (json!(true), true),
        (json!("true"), false),
        (json!(1), false),
        (json!(false), false),
    ] {
        r.mock.clear();
        let mut p = public("netgsm_pbx");
        p["recording_allowed"] = allowed.clone();
        r.netgsm
            .click_to_call(&pbx_cred(), &p, "101", "905000000021")
            .await
            .unwrap();
        let call = r.mock.request("GET", &pbx("originate"));
        let expected = records.then_some("1");
        assert_eq!(call.param("caller_record"), expected, "{allowed}");
        assert_eq!(call.param("called_record"), expected, "{allowed}");
    }
}

#[tokio::test]
async fn linkup_rings_the_reps_phone_when_the_mode_says() {
    let r = rig().await;
    r.mock.on("GET", &pbx("linkup"), rest("linkup"));
    let mut p = public("netgsm_pbx");
    p["call_mode"] = json!("linkup");
    p["recording_allowed"] = json!(true);
    let receipt = r
        .netgsm
        .click_to_call(&pbx_cred(), &p, "0500 000 00 22", "905000000021")
        .await
        .unwrap();
    let call = r.mock.request("GET", &pbx("linkup"));
    assert_eq!(call.param("caller"), Some("05000000022"));
    assert_eq!(call.param("called"), Some("905000000021"));
    assert_eq!(call.param("trunk"), Some(TRUNK));
    assert_eq!(call.param("crm_id"), Some(receipt.provider_id.as_str()));
    assert_eq!(call.param("caller_record"), Some("1"));
    assert_eq!(call.param("called_record"), Some("1"));
    assert_eq!(call.param("internal_num"), None);

    // An unknown mode, a missing trunk or a bad extension calls nothing.
    r.mock.clear();
    p["call_mode"] = json!("teleport");
    assert_eq!(
        kind_of(
            r.netgsm
                .click_to_call(&pbx_cred(), &p, "101", "905000000021")
                .await
        ),
        "permanent"
    );
    let no_trunk = Credential::NetgsmPbx {
        username: PBX_USER.into(),
        password: PBX_PASSWORD.into(),
        trunk: None,
        pbxnum: None,
    };
    assert_eq!(
        kind_of(
            r.netgsm
                .click_to_call(&no_trunk, &public("netgsm_pbx"), "101", "905000000021")
                .await
        ),
        "permanent"
    );
    assert_eq!(
        kind_of(
            r.netgsm
                .click_to_call(&pbx_cred(), &public("netgsm_pbx"), "10/1", "905000000021")
                .await
        ),
        "permanent"
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn hangup_sends_the_calls_unique_id() {
    let r = rig().await;
    r.mock.on("GET", &pbx("hangup"), rest("hangup"));
    r.netgsm
        .hangup(&pbx_cred(), "sip3-1700000000.9")
        .await
        .unwrap();
    let call = r.mock.request("GET", &pbx("hangup"));
    assert_eq!(call.param("unique_id"), Some("1700000000.9"));
    assert_eq!(call.param("username"), Some(PBX_USER));
    assert_eq!(
        kind_of(r.netgsm.hangup(&pbx_cred(), " ").await),
        "permanent"
    );
    // The receipt's crm_id is not the PBX's call id: refused before any call.
    r.mock.on("GET", &pbx("originate"), rest("originate"));
    let receipt = r
        .netgsm
        .click_to_call(&pbx_cred(), &public("netgsm_pbx"), "101", "905000000021")
        .await
        .unwrap();
    r.mock.clear();
    let e = r
        .netgsm
        .hangup(&pbx_cred(), &receipt.provider_id)
        .await
        .unwrap_err();
    assert_eq!(e.kind(), "permanent");
    assert!(e.reason().unwrap().contains("crm_id"), "{e}");
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn netsantral_errors_map_by_the_table() {
    let r = rig().await;
    for (reply, expected) in [
        (rest("santral_error"), "permanent"),
        (rest("santral_unverified"), "auth"),
        (ok(json!({ "code": "30", "status": "Error" })), "auth"),
        (ok(json!({ "code": "80", "status": "Error" })), "throttle"),
        (raw(200, "40 trunk yetkisiz"), "permission"),
        (raw(200, ""), "permanent"),
        (ok(json!({ "status": "Bilinmiyor" })), "permanent"),
        (raw(502, "<html>Bad gateway</html>"), "transient"),
        (raw(502, "502 Bad Gateway"), "transient"),
        (raw(503, "30 servis disi"), "transient"),
    ] {
        r.mock.set("GET", &pbx("originate"), reply.clone());
        let e = r
            .netgsm
            .click_to_call(&pbx_cred(), &public("netgsm_pbx"), "101", "905000000021")
            .await
            .expect_err("an error");
        assert_eq!(e.kind(), expected, "{reply:?}: {e}");
    }
    // A plain-text acceptance is an acceptance, and so is a JSON success code.
    for accepted in [
        raw(200, "01 queued"),
        ok(json!({ "code": "00", "message": "İşlem başarılı" })),
        ok(json!({ "code": 0 })),
    ] {
        r.mock.set("GET", &pbx("originate"), accepted.clone());
        assert!(
            r.netgsm
                .click_to_call(&pbx_cred(), &public("netgsm_pbx"), "101", "905000000021")
                .await
                .is_ok(),
            "{accepted:?}"
        );
    }
}

#[tokio::test]
async fn call_records_send_the_credentials_in_the_body() {
    let r = rig().await;
    r.mock.on("POST", CDR, rest("cdr"));
    let (from, to) = (
        datetime!(2026-10-23 06:00 UTC),
        datetime!(2026-10-23 08:00 UTC),
    );
    let drafts = r.netgsm.call_records(&pbx_cred(), from, to).await.unwrap();
    let call = r.mock.request("POST", CDR);
    assert_eq!(
        call.json(),
        json!({
            "usercode": PBX_USER,
            "password": PBX_PASSWORD,
            "startdate": "231020260900",
            "stopdate": "231020261100",
        })
    );
    assert_eq!(call.header("authorization"), None);
    assert_eq!(drafts.len(), 2);
    assert_eq!(drafts[0].kind, EventKind::CallEvent);
    // The same id as the call's `cdr` webhook event, so a poll never duplicates a push.
    assert_eq!(drafts[0].external_id, "netgsm-call:1700000000.101:cdr");
    assert_eq!(drafts[0].payload["duration_sec"], 42);
    assert_eq!(drafts[0].occurred_at, Some(datetime!(2026-10-23 07:00 UTC)));
    assert!(drafts[1].external_id.starts_with("netgsm-call:"));
    // Recording links keep their path but lose the provider's token, in the normalised field
    // and in the raw copy alike.
    assert_eq!(
        drafts[0].payload["recording"],
        "https://dosya.example.invalid/kayit/1700000000.101.wav"
    );
    assert_eq!(
        drafts[0].payload["raw"]["recording"],
        "https://dosya.example.invalid/kayit/1700000000.101.wav"
    );
    for draft in &drafts {
        let text = draft.payload.to_string();
        assert!(!text.contains("SECRET"), "{text}");
    }
}

// ---------------------------------------------------------------------------------------------
// İYS
// ---------------------------------------------------------------------------------------------

fn consent_row(i: usize) -> ConsentRow {
    ConsentRow {
        recipient: format!("+90500{i:07}"),
        channel: ["MESAJ", "ARAMA"][i % 2].into(),
        granted: !i.is_multiple_of(3),
        source: "HS_WEB".into(),
        at: START,
    }
}

#[tokio::test]
async fn iys_add_chunks_rows_by_five_hundred() {
    let r = rig().await;
    r.mock.on("POST", IYS_ADD, rest("iys_add"));
    let rows: Vec<ConsentRow> = (0..1200).map(consent_row).collect();
    let receipt = r.netgsm.add(&iys_cred(), &rows).await.unwrap();
    let calls = r.mock.requests("POST", IYS_ADD);
    let sizes: Vec<usize> = calls
        .iter()
        .map(|c| c.json()["iysRecipients"].as_array().unwrap().len())
        .collect();
    assert_eq!(sizes, [500, 500, 200]);
    let first = calls[0].json();
    assert_eq!(
        first["header"],
        json!({ "username": USERCODE, "password": PASSWORD, "brandCode": BRAND_CODE })
    );
    assert_eq!(
        first["iysRecipients"][0],
        json!({
            "recipient": "+905000000000",
            "type": "MESAJ",
            "status": "RET",
            // 09:00 UTC is 12:00 in Türkiye.
            "consentDate": "2026-10-23 12:00:00",
            "source": "HS_WEB",
        })
    );
    assert_eq!(first["iysRecipients"][1]["status"], "ONAY");
    assert_eq!(first["iysRecipients"][1]["type"], "ARAMA");
    assert_eq!(
        calls[0].header("authorization"),
        Some(basic(USERCODE, PASSWORD).as_str())
    );
    assert_eq!(
        receipt.provider_id,
        "iys-ref-1,iys-ref-2,iys-ref-1,iys-ref-2,iys-ref-1,iys-ref-2"
    );
}

#[tokio::test]
async fn iys_add_checks_its_rows_and_credential_first() {
    let r = rig().await;
    let mut bad = consent_row(0);
    bad.channel = "FAKS".into();
    assert_eq!(
        kind_of(r.netgsm.add(&iys_cred(), &[bad]).await),
        "permanent"
    );
    // An SMS credential carries no İYS brand code.
    assert_eq!(
        kind_of(r.netgsm.add(&sms_cred(), &[consent_row(0)]).await),
        "permanent"
    );
    // Nothing to add, nothing called.
    assert_eq!(
        r.netgsm.add(&iys_cred(), &[]).await.unwrap().provider_id,
        ""
    );
    assert!(r.mock.recorded().is_empty());
}

#[tokio::test]
async fn iys_search_reads_the_consent_state() {
    let r = rig().await;
    r.mock.on("POST", IYS_SEARCH, rest("iys_search"));
    assert_eq!(
        r.netgsm
            .iys_search(&iys_cred(), "+905000000061", "MESAJ")
            .await,
        Ok(IysStatus::Granted)
    );
    let call = r.mock.request("POST", IYS_SEARCH);
    assert_eq!(
        call.json(),
        json!({
            "header": { "username": USERCODE, "password": PASSWORD, "brandCode": BRAND_CODE },
            "recipient": "+905000000061",
            "type": "MESAJ",
        })
    );
    for (status, expected) in [("RET", IysStatus::Refused), ("YOK", IysStatus::Absent)] {
        r.mock.set(
            "POST",
            IYS_SEARCH,
            ok(json!({ "code": "00", "status": status })),
        );
        assert_eq!(
            r.netgsm
                .iys_search(&iys_cred(), "+905000000061", "ARAMA")
                .await,
            Ok(expected)
        );
    }
    // Exactly as İYS writes it: a near miss is never read as consent.
    for near in ["BELKI", "yok", "onay", " ONAY"] {
        r.clock.advance(Duration::minutes(1));
        r.mock.set(
            "POST",
            IYS_SEARCH,
            ok(json!({ "code": "00", "status": near })),
        );
        let outcome = r
            .netgsm
            .iys_search(&iys_cred(), "+905000000061", "MESAJ")
            .await;
        if near == " ONAY" {
            // Surrounding blanks are not part of the value.
            assert_eq!(outcome, Ok(IysStatus::Granted));
        } else {
            assert_eq!(kind_of(outcome), "permanent", "{near:?}");
        }
    }
}

#[tokio::test]
async fn the_budgeter_is_shared_by_clones_of_its_handle() {
    // One budgeter handed to two adapters (two registries in one process) counts once.
    let mock = Mock::start().await;
    mock.on("GET", INBOX, ok(json!({ "code": "00", "messages": [] })));
    let clock = ManualClock::new();
    let budget = RateBudgeter::new(Arc::new(clock));
    let a = NetgsmConnector::new(egress(mock.host()), bases(&mock)).with_budgeter(budget.clone());
    let b = NetgsmConnector::new(egress(mock.host()), bases(&mock)).with_budgeter(budget);
    let window = (START - Duration::hours(1), START);
    assert!(a.inbox(&sms_cred(), window.0, window.1).await.is_ok());
    assert!(b.inbox(&sms_cred(), window.0, window.1).await.is_ok());
    assert_eq!(
        kind_of(a.inbox(&sms_cred(), window.0, window.1).await),
        "throttle"
    );
}

#[tokio::test]
async fn broken_response_body_preserves_write_uncertainty() {
    let addr = broken_response(true).await;
    let netgsm = connector_at(addr, RetryPolicy::default(), StdDuration::from_secs(5));
    let mut linkup = public("netgsm_pbx");
    linkup["call_mode"] = json!("linkup");
    for result in [
        netgsm
            .send(&sms_cred(), "905000000001", "hello", None, false)
            .await
            .map(drop),
        netgsm
            .click_to_call(&pbx_cred(), &public("netgsm_pbx"), "101", "905000000021")
            .await
            .map(drop),
        netgsm
            .click_to_call(&pbx_cred(), &linkup, "905000000022", "905000000021")
            .await
            .map(drop),
        netgsm.hangup(&pbx_cred(), "1700000000.9").await,
        netgsm.add(&iys_cred(), &[consent_row(0)]).await.map(drop),
    ] {
        let e = result.unwrap_err();
        assert_eq!(e.kind(), "unknown", "{e}");
        assert!(!e.is_retriable());
    }
    assert_eq!(
        netgsm
            .probe(&sms_cred(), &public("sms_line"))
            .await
            .error
            .unwrap()
            .kind(),
        "transient"
    );
}

#[tokio::test]
async fn send_receipt_carries_only_reported_minor_unit_cost() {
    let r = rig().await;
    for (cost, expected) in [
        (json!(23), Some(23)),
        (json!("42"), Some(42)),
        (json!(0), Some(0)),
        (Value::Null, None),
        (json!("unknown"), None),
        (json!(1.25), None),
    ] {
        r.mock.set(
            "POST",
            SEND,
            ok(json!({ "code": "00", "jobid": "job-1", "cost_minor": cost })),
        );
        let receipt = r
            .netgsm
            .send(&sms_cred(), "905000000001", "hello", None, false)
            .await
            .unwrap();
        assert_eq!(receipt.cost_minor, expected);
    }
    r.mock.set("POST", SEND, rest("send"));
    assert_eq!(
        r.netgsm
            .send(&sms_cred(), "905000000001", "hello", None, false)
            .await
            .unwrap()
            .cost_minor,
        None
    );
}

#[tokio::test]
async fn sms_commercial_iysfilter_mapping() {
    for (commercial, expected) in [(true, "11"), (false, "0")] {
        let r = rig().await;
        r.mock.on("POST", SEND, rest("send"));
        r.netgsm
            .send(
                &sms_cred(),
                "905000000001",
                "Merhaba",
                Some("ref"),
                commercial,
            )
            .await
            .unwrap();
        let body = r.mock.request("POST", SEND).json();
        assert_eq!(body["iysfilter"], expected);
        assert_eq!(body["messages"][0]["referansID"], "ref");
    }
}
