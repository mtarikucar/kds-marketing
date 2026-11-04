//! The public links every commercial email carries (spec §3.14, D62, D63): the one-click
//! unsubscribe address and, for a campaign that tracks clicks, the click redirects; their
//! addresses and MACs, and the use cases the public routes (`jt_webhook::links`) call.
//!
//! - **Token**: the email's outbox entry id, the id in its Message-ID (`<id@host>`), for an inbox
//!   send and an outreach send alike (an outreach send's row names it: `outreach_sends.outbox_id`).
//! - **MAC**: the first `jt_outreach::MAC_BYTES` bytes of HMAC-SHA256 under the workspace's key for
//!   the purpose (`deps.seal.hmac_key(ws, "outreach.unsubscribe" | "outreach.click")`) over
//!   `jt_outreach::mac_input(purpose, token, link)`, base64url without padding.
//! - **Address**: the platform's public base URL with `jt_outreach::unsubscribe_path` or
//!   `click_path`; only an `https` base gives one (the one-click address must be `https`).
//!
//! **The routes' use cases** have no authenticated caller: the MAC is the only proof, checked in
//! constant time before anything is read; a token that is not canonical, a MAC that does not hold
//! and a token of no outbox entry all answer `None` (the route's `404`) with nothing written.
//! They only ever reduce what may be sent: none queues, sends or opens anything.
//! - [`unsubscribe_page`]: what the confirmation page says (its language, the sender's company);
//!   reads only, never unsubscribes.
//! - [`unsubscribe`]: the email's recipient (the conversation's person, a merge followed to the
//!   survivor) gets the suppression `(email, unsubscribe)` and, unless their email consent is
//!   withdrawn already or the email was a test (which rests on no consent row, D73), a
//!   withdrawal (`customer`, now; the İYS sync pushes it); their active enrollment stops
//!   (`unsubscribed`); an outreach email's send records it once; the ledger
//!   entry `outreach.unsubscribed {person_id, send_id, via: "link"}` is written by the system
//!   actor `unsubscribe_link` when anything changed (a repeat changes nothing). Honoured whatever
//!   the workspace's status (D20). An erased recipient answers the page and writes nothing.
//! - `unsubscribed_by_mail` (crate-private): the consumer's half of the `mailto:` fallback
//!   (subject `unsubscribe`): the same stop, send mark and ledger entry (`via: "mail"`), for
//!   the person's outreach email of the last 90 days.
//! - [`click`]: where link `link` of the email went (the links the email's own intent recorded
//!   when they were rewritten); a `HEAD`, a request without `User-Agent` and a click within 60
//!   seconds of the send count as automated; a suspended workspace still redirects but records
//!   nothing. Nothing about the client is stored.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use hmac::{Hmac, KeyInit, Mac};
use jt_inbox::{
    Channel, Consent, ConsentId, ConsentKind, ConsentSource, PersonId, Suppression,
    SuppressionReason, SyncState, effective_consent,
};
use jt_ledger::Actor;
pub use jt_outreach::Lang;
use jt_outreach::{CampaignId, SendId};
use jt_outreach::{MAC_BYTES, MacPurpose, click_path, mac_input, unsubscribe_path};
use jt_tenancy::{WorkspaceId, WorkspaceStatus};
use serde_json::{Value, json};
use sha2::Sha256;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use super::{hooks, record};
use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::TenantRepos;
use crate::ports::connectors::Url;
use crate::ports::inbox::OutboxRow;
use crate::usecases::Deps;

/// A click this soon after its email was sent is a scanner's, not a person's (spec §3.14).
pub const AUTOMATED_CLICK_WINDOW: Duration = Duration::seconds(60);

/// How far back an emailed `unsubscribe` looks for the person's outreach email (spec §3.14).
pub const MAIL_UNSUBSCRIBE_WINDOW: Duration = Duration::days(90);

/// The system actor the one-click unsubscribe writes as.
pub const UNSUBSCRIBE_ACTOR: &str = "unsubscribe_link";

/// What the unsubscribe page says: the language of the email's footer and the sender's company
/// (the footer's, when configured). Nothing about the recipient.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LinkPage {
    pub lang: Lang,
    pub sender_company: Option<String>,
}

/// What a click request says about itself (nothing of it is stored).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ClickFrom {
    /// A `HEAD` request: a scanner's.
    pub head: bool,
    /// Whether the request carried a `User-Agent` (never its value).
    pub user_agent: bool,
}

/// `raw` as a token when it is a UUID in its canonical (hyphenated, lowercase) form, the only one
/// a link carries.
fn canonical_token(raw: &str) -> Option<Uuid> {
    Uuid::parse_str(raw).ok().filter(|t| t.to_string() == raw)
}

/// `raw` as a link index when it is one written in plain decimal (no sign, no leading zero).
fn canonical_index(raw: &str) -> Option<u16> {
    raw.parse::<u16>().ok().filter(|i| i.to_string() == raw)
}

/// The language of the footer the email whose outbox entry is `row` carried: its campaign
/// step's snapshot's (an outreach email's or a test's), else its template's, else Turkish (an
/// inbox send's footer is Turkish, D62).
async fn footer_lang(r: &mut dyn TenantRepos, row: &OutboxRow) -> Result<Lang, AppError> {
    let facts = row
        .intent
        .get("outreach")
        .or_else(|| row.intent.get("outreach_test"));
    let Some(facts) = facts else {
        return Ok(Lang::Tr);
    };
    let campaign = facts
        .get("campaign_id")
        .and_then(|v| serde_json::from_value::<CampaignId>(v.clone()).ok());
    let step = facts
        .get("step")
        .and_then(Value::as_u64)
        .and_then(|s| usize::try_from(s).ok());
    let (Some(campaign), Some(step)) = (campaign, step) else {
        return Ok(Lang::Tr);
    };
    let Some(c) = r.outreach_campaigns().get(campaign).await? else {
        return Ok(Lang::Tr);
    };
    let Some(s) = c.definition.steps.get(step.saturating_sub(1)) else {
        return Ok(Lang::Tr);
    };
    if let Some(snapshot) = &s.snapshot {
        return Ok(snapshot.language);
    }
    Ok(r.outreach_templates()
        .get(s.template_id)
        .await?
        .map_or(Lang::Tr, |t| t.template.language))
}

async fn page_of(r: &mut dyn TenantRepos, row: &OutboxRow) -> Result<LinkPage, AppError> {
    let lang = footer_lang(r, row).await?;
    let company = super::outreach_policy(r).await?.sender_company;
    Ok(LinkPage {
        lang,
        sender_company: Some(company.trim().to_owned()).filter(|c| !c.is_empty()),
    })
}

/// The token of an unsubscribe link of `ws` whose `mac` holds (checked before anything is read
/// or locked).
fn unsubscribe_token(
    deps: &Deps,
    ws: WorkspaceId,
    token: &str,
    mac: &str,
) -> Result<Option<Uuid>, AppError> {
    let Some(token) = canonical_token(token) else {
        return Ok(None);
    };
    Ok(verify(deps, ws, MacPurpose::Unsubscribe, token, None, mac)?.then_some(token))
}

/// `GET /u/{workspace_id}/{token}/{mac}`: what the confirmation page says, when the link holds;
/// reads only.
pub async fn unsubscribe_page(
    deps: &Deps,
    ws: WorkspaceId,
    token: &str,
    mac: &str,
) -> Result<Option<LinkPage>, AppError> {
    let Some(token) = unsubscribe_token(deps, ws, token, mac)? else {
        return Ok(None);
    };
    let mut r = deps.uow.tenant(ws).await?;
    let Some(row) = r.outbox().get(token).await? else {
        return Ok(None);
    };
    Ok(Some(page_of(r.as_mut(), &row).await?))
}

/// The person who holds the email's conversation now (a merge followed to the survivor); none
/// when they are erased or gone.
async fn recipient(r: &mut dyn TenantRepos, row: &OutboxRow) -> Result<Option<PersonId>, AppError> {
    let Some(conversation) = r.conversations().get(row.conversation_id).await? else {
        return Ok(None);
    };
    let mut id = conversation.person_id;
    for _ in 0..32 {
        let Some(person) = r.people().lock(id).await? else {
            return Ok(None);
        };
        if person.erased_at.is_some() || r.erasure().get(id).await?.is_some() {
            return Ok(None);
        }
        match person.merged_into {
            Some(survivor) => id = survivor,
            None => return Ok(Some(id)),
        }
    }
    Err(AppError::internal("person aliases do not end"))
}

/// The context the one-click unsubscribe acts in: the system, as [`UNSUBSCRIBE_ACTOR`].
fn link_ctx(ws: WorkspaceId, now: OffsetDateTime) -> Ctx {
    Ctx {
        workspace_id: ws,
        actor: Actor::System {
            component: UNSUBSCRIBE_ACTOR.into(),
        },
        permissions: Default::default(),
        role_key: None,
        now,
        agent_connection_id: None,
    }
}

/// `POST /u/{workspace_id}/{token}/{mac}` (RFC 8058 one-click, or the page's form): unsubscribes
/// the email's recipient, whatever the workspace's status, and answers the page; `None` when the
/// link does not hold (nothing written). Idempotent.
pub async fn unsubscribe(
    deps: &Deps,
    ws: WorkspaceId,
    token: &str,
    mac: &str,
) -> Result<Option<LinkPage>, AppError> {
    let Some(token) = unsubscribe_token(deps, ws, token, mac)? else {
        return Ok(None);
    };
    let ctx = link_ctx(ws, deps.clock.now());
    let mut r = deps.uow.tenant(ws).await?;
    // The inbox lock first, as every consent and suppression write takes it.
    r.people().lock_workspace().await?;
    r.people().set_write_time(ctx.now).await?;
    let Some(row) = r.outbox().get(token).await? else {
        return Ok(None);
    };
    let page = page_of(r.as_mut(), &row).await?;
    let Some(person) = recipient(r.as_mut(), &row).await? else {
        // Erased (or gone): nothing to do, and nothing about them to say.
        return Ok(Some(page));
    };
    let mut wrote = false;
    let suppressed = r
        .suppressions()
        .list(person)
        .await?
        .iter()
        .any(|s| s.channel == Channel::Email && s.reason == SuppressionReason::Unsubscribe);
    if !suppressed {
        r.suppressions()
            .insert(Suppression {
                person_id: person,
                channel: Channel::Email,
                reason: SuppressionReason::Unsubscribe,
            })
            .await?;
        wrote = true;
    }
    // A test email rests on the member's own request, with no consent row (D73): its unsubscribe
    // is the suppression alone (no withdrawal for the İYS sync to push about the member).
    let test = row.intent.get("outreach_test").is_some();
    let consents = r.consents().list(person).await?;
    let withdrawn = effective_consent(&consents, person, Channel::Email)
        .is_some_and(|c| c.kind == ConsentKind::Withdrawn);
    if !test && !withdrawn {
        r.consents()
            .insert(Consent {
                id: ConsentId::from(deps.ids.uuid()),
                person_id: person,
                channel: Channel::Email,
                kind: ConsentKind::Withdrawn,
                source: ConsentSource::Customer,
                at: ctx.now,
                sync_state: SyncState::Pending,
                attempts: 0,
            })
            .await?;
        wrote = true;
    }
    let send = r.outreach_sends().by_outbox(row.id).await?.map(|s| s.id);
    effects(r.as_mut(), &ctx, person, send, "link", wrote).await?;
    r.commit().await?;
    Ok(Some(page))
}

/// What an unsubscribe does beyond the suppression and the withdrawal (written before, `wrote`
/// saying whether anything was): the person's active enrollment stops (`unsubscribed`), the
/// outreach email's send records it once, and `outreach.unsubscribed` is written when anything
/// changed.
async fn effects(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    person: PersonId,
    send: Option<SendId>,
    via: &str,
    wrote: bool,
) -> Result<(), AppError> {
    let stopped = hooks::on_unsubscribed(r, ctx, person).await?;
    let marked = match send {
        Some(id) => r.outreach_sends().unsubscribed(id, ctx.now).await?,
        None => false,
    };
    if wrote || stopped || marked {
        record(
            r,
            ctx,
            "outreach.unsubscribed",
            "person",
            person,
            json!({ "person_id": person, "send_id": send, "via": via }),
        )
        .await?;
    }
    Ok(())
}

/// The consumer recorded an emailed withdrawal from `person` at `at` whose subject is
/// `unsubscribe` (the `mailto:` fallback, spec §3.14), the suppression and the withdrawal
/// written: when an outreach email reached them in the 90 days before, it is an unsubscribe
/// from it (the enrollment stops `unsubscribed`, the send records it, `outreach.unsubscribed`
/// with `via: "mail"`); whether it was. Otherwise the caller treats it as any withdrawal.
pub(crate) async fn unsubscribed_by_mail(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    person: PersonId,
    at: OffsetDateTime,
) -> Result<bool, AppError> {
    let Some(send) = r
        .outreach_sends()
        .latest_for_person(person, at - MAIL_UNSUBSCRIBE_WINDOW)
        .await?
    else {
        return Ok(false);
    };
    effects(r, ctx, person, Some(send.id), "mail", true).await?;
    Ok(true)
}

/// `GET`/`HEAD /c/{workspace_id}/{token}/{link}/{mac}`: where link `link` of the email went (an
/// `http(s)` address of the links its intent recorded when they were rewritten), counting the
/// click on its send (automated when [`ClickFrom`] or the 60 seconds say so), except in a
/// suspended workspace, which still redirects; `None` when the link does not hold.
pub async fn click(
    deps: &Deps,
    ws: WorkspaceId,
    token: &str,
    link: &str,
    mac: &str,
    from: ClickFrom,
) -> Result<Option<String>, AppError> {
    let (Some(token), Some(index)) = (canonical_token(token), canonical_index(link)) else {
        return Ok(None);
    };
    if !verify(deps, ws, MacPurpose::Click, token, Some(index), mac)? {
        return Ok(None);
    }
    let now = deps.clock.now();
    let status = {
        let mut p = deps.uow.platform().await?;
        p.workspace_get(ws).await?.map(|w| w.status)
    };
    let Some(status) = status else {
        return Ok(None);
    };
    let mut r = deps.uow.tenant(ws).await?;
    let Some(row) = r.outbox().get(token).await? else {
        return Ok(None);
    };
    let to = row.intent["outreach"]["links"]
        .get(usize::from(index))
        .and_then(Value::as_str)
        .filter(|l| {
            Url::parse(l).is_ok_and(|u| matches!(u.scheme(), "http" | "https"))
                && !l.chars().any(char::is_control)
        })
        .map(str::to_owned);
    let Some(to) = to else {
        return Ok(None);
    };
    if status == WorkspaceStatus::Suspended {
        return Ok(Some(to));
    }
    if let Some(send) = r.outreach_sends().by_outbox(row.id).await? {
        let sent = send.sent_at.unwrap_or(send.created_at);
        let automated = from.head || !from.user_agent || now - sent < AUTOMATED_CLICK_WINDOW;
        r.outreach_sends().click(send.id, automated, now).await?;
        r.commit().await?;
    }
    Ok(Some(to))
}

/// The MAC of `token` (and `link`) for `purpose` in `ws`, base64url without padding.
pub fn mac(
    deps: &Deps,
    ws: WorkspaceId,
    purpose: MacPurpose,
    token: Uuid,
    link: Option<u16>,
) -> Result<String, AppError> {
    let bytes = raw_mac(deps, ws, purpose, token, link)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

fn raw_mac(
    deps: &Deps,
    ws: WorkspaceId,
    purpose: MacPurpose,
    token: Uuid,
    link: Option<u16>,
) -> Result<Vec<u8>, AppError> {
    let secret = deps.seal.hmac_key(ws, purpose.key())?;
    let mut m = Hmac::<Sha256>::new_from_slice(secret.as_ref())
        .map_err(|_| AppError::internal("link key unavailable"))?;
    m.update(&mac_input(purpose, token, link));
    Ok(m.finalize().into_bytes()[..MAC_BYTES].to_vec())
}

/// Whether `given` (as a link carries it) is the MAC of `token` (and `link`) for `purpose` in
/// `ws`, compared in constant time; a value that is not base64url of the right length is not.
pub fn verify(
    deps: &Deps,
    ws: WorkspaceId,
    purpose: MacPurpose,
    token: Uuid,
    link: Option<u16>,
    given: &str,
) -> Result<bool, AppError> {
    let Ok(given) = URL_SAFE_NO_PAD.decode(given) else {
        return Ok(false);
    };
    let expected = raw_mac(deps, ws, purpose, token, link)?;
    if given.len() != expected.len() {
        return Ok(false);
    }
    let diff = given
        .iter()
        .zip(&expected)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b));
    Ok(diff == 0)
}

/// The platform's public base address when it is `https`: the only base a one-click
/// unsubscribe address may have.
pub(crate) fn https_base(deps: &Deps) -> Option<Url> {
    deps.apps
        .public_base_url()
        .filter(|u| u.scheme() == "https" && u.host_str().is_some_and(|h| !h.is_empty()))
}

/// The one-click unsubscribe address of the commercial email whose outbox entry is `token`:
/// `{base}/u/{workspace_id}/{token}/{mac}`.
pub fn unsubscribe_url(
    deps: &Deps,
    base: &Url,
    ws: WorkspaceId,
    token: Uuid,
) -> Result<String, AppError> {
    let mac = mac(deps, ws, MacPurpose::Unsubscribe, token, None)?;
    join(base, &unsubscribe_path(ws, token, &mac))
}

/// The click redirect of link `link` (its index in the step's snapshot) of the email whose
/// outbox entry is `token`: `{base}/c/{workspace_id}/{token}/{link}/{mac}`.
pub fn click_url(
    deps: &Deps,
    base: &Url,
    ws: WorkspaceId,
    token: Uuid,
    link: u16,
) -> Result<String, AppError> {
    let mac = mac(deps, ws, MacPurpose::Click, token, Some(link))?;
    join(base, &click_path(ws, token, link, &mac))
}

fn join(base: &Url, path: &str) -> Result<String, AppError> {
    base.join(path)
        .map(String::from)
        .map_err(|_| AppError::internal("a public link does not join the base address"))
}

/// The `mailto:` fallback of `List-Unsubscribe` for the sending address `from`, subject
/// `unsubscribe` (spec §3.14); `None` for an address that a URI cannot hold as it is (anything
/// beyond ASCII letters, digits and `@.!$'*+-=^_`{|}~`).
pub fn unsubscribe_mailto(from: &str) -> Option<String> {
    let ok = from.contains('@')
        && from.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'@' | b'.'
                        | b'!'
                        | b'$'
                        | b'\''
                        | b'*'
                        | b'+'
                        | b'-'
                        | b'='
                        | b'^'
                        | b'_'
                        | b'`'
                        | b'{'
                        | b'|'
                        | b'}'
                        | b'~'
                )
        });
    ok.then(|| format!("mailto:{from}?subject=unsubscribe"))
}
