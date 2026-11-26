//! The owner's email notices (migration `0049_owner_notices`): when the automatic replies hand a
//! conversation to a person (or, from the orders' release, create an order), the workspace's team
//! managers are told by email, through the workspace's own oldest verified mailbox.
//!
//! - **Written** in the hand-over's own transaction, inside a savepoint (`queue_best_effort`): one
//!   row per hand-over (its dedupe key names the conversation and the executor generation the
//!   hand-over wrote). A failure undoes only the notice (logged by code): the hand-over commits.
//!   Nothing at all while the setting is off (`AutoReply::notify_email`) or no verified mailbox
//!   exists; over [`DAILY_NOTICES`] in a rolling day the row is kept as `skipped` (`daily_cap`).
//! - **Sent** by a job of its own ([`run`], `owner_notices`), never by the automatic replies'
//!   job: at most [`RUN_PER_WORKSPACE`] notices per workspace and [`RUN_BUDGET`] per run. Each is
//!   claimed (one attempt counted) and marked `sending` in a transaction of its own, then sent
//!   with no lock held, each email within [`SEND_TIMEOUT`], one to each of at most
//!   [`MAX_RECIPIENTS`] active members whose role has `team.manage`. A transient failure (or any
//!   error before the send) waits [`BACKOFF_MINUTES`] before the next of at most [`MAX_ATTEMPTS`]
//!   attempts; an answer that may have reached the mail server (`Unknown`, a timeout) counts as
//!   sent, never again, and so does a row found still `sending` later (a crash in between).
//! - **What it says**: what happened, the reason in plain words (a fixed table of codes), for an
//!   order its amount and the shop's reference, and the conversation's link in the panel. Never a
//!   customer's name, text or summary; the row holds codes and ids only. While the agent keeps
//!   every conversation (`AutoReply::keeps`), a would-be hand-over's notice says the automatic
//!   replies need the owner on a point and keep the conversation (its dedupe key starts with
//!   `NEEDS_YOU`: one per open item of the owner's).
//! - **Never back in the inbox** (`own_notice`): a polled mail (the notice's inbox copy, its Sent
//!   copy, an answer to it, or a bounce of it) is dropped when its `Message-ID` or `In-Reply-To` is
//!   `<jeeta-notice.{id}.…>`, or it comes from the workspace's own mailbox address with
//!   `Auto-Submitted` and `X-Jeeta-Notice: {id}`, or it is a delivery report that quotes such an id
//!   (or bears a notice's subject within [`BOUNCE_WINDOW`] of a notice): each id one the workspace
//!   holds.

use jt_capability::{Capability, StoredStatus};
use jt_connector::{ConnectorError, Provider};
use jt_inbox::ConversationId;
use jt_tenancy::{MembershipStatus, Permission, WorkspaceId};
use serde_json::Value;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::connectors::MailMessage;
use crate::ports::notices::{NoticeKind, NoticeRow, NoticeState};
use crate::ports::reply_model::OrderRow;
use crate::ports::{CapabilityFilter, TenantRepos};
use crate::usecases::Deps;
use crate::usecases::connector::open_credential;
use crate::usecases::jobs::JobReport;

/// The most notices a workspace is sent in a rolling day; past it they are kept as skipped.
pub const DAILY_NOTICES: u32 = 20;
/// The most people one notice is sent to.
pub const MAX_RECIPIENTS: usize = 5;
/// The most attempts at one notice.
pub const MAX_ATTEMPTS: u32 = 4;
/// How long a notice waits after its first, second and third failed attempt, in minutes.
pub const BACKOFF_MINUTES: [i64; 3] = [1, 5, 15];
/// The most notices one run of the job sends for a workspace.
pub const RUN_PER_WORKSPACE: u32 = 3;
/// How long one run of the job starts new notices for.
pub const RUN_BUDGET: std::time::Duration = std::time::Duration::from_secs(20);
/// How long one email may take; past it, it may have gone out, so it counts as sent.
pub const SEND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);
/// A notice left `sending` this long is taken as sent.
const SENDING_STALE: Duration = Duration::minutes(10);
/// How long after a notice a delivery report bearing its subject is taken as its bounce.
pub const BOUNCE_WINDOW: Duration = Duration::minutes(30);
/// What every notice's `Message-ID` starts with.
const ID_PREFIX: &str = "jeeta-notice.";
/// What the dedupe key of a notice starts with when the automatic replies kept the conversation
/// and ask the owner (`autoreply::keep`): `needs_you:{conversation}:{task}`.
pub(crate) const NEEDS_YOU: &str = "needs_you:";
/// The subjects of the notices.
const SUBJECTS: [&str; 2] = [
    "Jeeta: bir konuşma sizi bekliyor",
    "Jeeta: yeni sipariş oluşturuldu",
];

/// The workspace's mailbox the notices go out through: its oldest live, verified mailbox.
pub(crate) fn mailbox(capabilities: &[Capability]) -> Option<&Capability> {
    capabilities
        .iter()
        .filter(|c| c.kind_key == "mailbox" && c.status == StoredStatus::Verified)
        .min_by_key(|c| (c.created_at, c.id))
}

async fn mailboxes(r: &mut dyn TenantRepos) -> Result<Vec<Capability>, AppError> {
    r.capabilities()
        .list(CapabilityFilter {
            kind: Some("mailbox"),
            status: Some(StoredStatus::Verified),
            ..Default::default()
        })
        .await
}

/// [`queue_in`] inside a savepoint of the caller's transaction: a failure (a settings read, the
/// mailbox list, the count, the insert) undoes only the notice and is logged by code; the caller's
/// work (a hand-over) commits all the same. `Err` only when the savepoint itself cannot be undone.
/// A bundle without savepoints writes no notice.
pub(crate) async fn queue_best_effort(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    kind: NoticeKind,
    conversation: ConversationId,
    dedupe_key: String,
    reason: Option<&str>,
) -> Result<(), AppError> {
    if let Err(e) = r.savepoint().await {
        warn(ctx.workspace_id, e.code.as_str());
        return Ok(());
    }
    match queue_in(deps, ctx, r, kind, conversation, dedupe_key, reason).await {
        Ok(()) => r.release_savepoint().await,
        Err(e) => {
            warn(ctx.workspace_id, e.code.as_str());
            r.rollback_to_savepoint().await?;
            r.release_savepoint().await
        }
    }
}

/// Queues a notice of `kind` about conversation `conversation`, in the caller's transaction: at
/// most one per `dedupe_key`. Nothing while the automatic replies or their notices are off, or no
/// verified mailbox exists; past [`DAILY_NOTICES`] in the rolling day, kept as skipped.
pub(crate) async fn queue_in(
    deps: &Deps,
    ctx: &Ctx,
    r: &mut dyn TenantRepos,
    kind: NoticeKind,
    conversation: ConversationId,
    dedupe_key: String,
    reason: Option<&str>,
) -> Result<(), AppError> {
    let on = r
        .knowledge()
        .settings()
        .await?
        .and_then(|s| s.auto_reply)
        .is_some_and(|a| a.notifies());
    if !on || mailbox(&mailboxes(r).await?).is_none() {
        return Ok(());
    }
    let capped = r.notices().count_since(ctx.now - Duration::days(1)).await? >= DAILY_NOTICES;
    let (state, reason) = if capped {
        (NoticeState::Skipped, Some("daily_cap".to_owned()))
    } else {
        (NoticeState::Queued, reason.map(str::to_owned))
    };
    r.notices()
        .insert(&NoticeRow {
            id: deps.ids.uuid(),
            kind,
            conversation_id: conversation,
            dedupe_key,
            reason,
            created_at: ctx.now,
            state,
            attempts: 0,
            next_at: None,
            sent_at: None,
            mailbox_capability_id: None,
        })
        .await?;
    Ok(())
}

/// Whether polled mail `payload`, received at `at`, is one of the workspace's own notices, an
/// answer to one or a bounce of one (see the module docs). A `jeeta-notice` id the workspace does
/// not hold is not: the mail is consumed as any other.
pub(crate) async fn own_notice(
    r: &mut dyn TenantRepos,
    payload: &Value,
    at: OffsetDateTime,
) -> Result<bool, AppError> {
    let text = |key: &str| payload[key].as_str().unwrap_or_default();
    // 1. Its `Message-ID`, or the one it answers.
    for field in ["message_id", "in_reply_to"] {
        if let Some(id) = notice_id(text(field))
            && r.notices().get(id).await?.is_some()
        {
            return Ok(true);
        }
    }
    let ours = |address: &str, mailboxes: &[Capability]| {
        let address = address.trim().to_ascii_lowercase();
        !address.is_empty()
            && mailboxes.iter().any(|m| {
                m.external_id
                    .as_deref()
                    .is_some_and(|a| a.trim().eq_ignore_ascii_case(&address))
            })
    };
    // 2. From the workspace's own mailbox, a machine's message, with the notice's marker.
    let auto = text("auto_submitted")
        .trim()
        .to_ascii_lowercase()
        .starts_with("auto-generated");
    if auto
        && let Ok(id) = text("jeeta_notice").trim().parse::<Uuid>()
        && ours(text("from"), &mailboxes(r).await?)
        && r.notices().get(id).await?.is_some()
    {
        return Ok(true);
    }
    // 3. A delivery report: from a mail daemon, or a `multipart/report`.
    let from = text("from").trim().to_ascii_lowercase();
    let daemon = from
        .split('@')
        .next()
        .is_some_and(|local| local.starts_with("mailer-daemon") || local == "postmaster");
    if !(daemon || payload["report"] == true) {
        return Ok(false);
    }
    let body = format!("{}\n{}", text("subject"), text("text"));
    for id in quoted_ids(&body) {
        if r.notices().get(id).await?.is_some() {
            return Ok(true);
        }
    }
    // Its subject, addressed back to the mailbox, shortly after a notice.
    let subject = text("subject");
    if SUBJECTS.iter().any(|s| subject.contains(s)) {
        let caps = mailboxes(r).await?;
        if text("to").split(',').any(|to| ours(bare(to), &caps))
            && r.notices().count_since(at - BOUNCE_WINDOW).await? > 0
        {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The address in `Name <address>`, or the text itself.
fn bare(field: &str) -> &str {
    match (field.find('<'), field.rfind('>')) {
        (Some(a), Some(b)) if a < b => &field[a + 1..b],
        _ => field,
    }
}

/// The notice id in a `Message-ID` `<jeeta-notice.{uuid}.{n}@{domain}>` (with or without the
/// angle brackets, or among others in an `In-Reply-To`).
fn notice_id(header: &str) -> Option<Uuid> {
    header.split_whitespace().find_map(|id| {
        let id = id.trim_matches(['<', '>']);
        let rest = id.strip_prefix(ID_PREFIX)?;
        let (uuid, _) = rest.split_once('.')?;
        uuid.parse().ok()
    })
}

/// Every notice id a delivery report's text quotes: `jeeta-notice.{uuid}` (its Message-ID) or
/// `X-Jeeta-Notice: {uuid}` (its marker header).
fn quoted_ids(body: &str) -> Vec<Uuid> {
    let mut out = Vec::new();
    for (i, _) in body.match_indices(ID_PREFIX) {
        let rest = &body[i + ID_PREFIX.len()..];
        if let Some(id) = rest.get(..36).and_then(|s| s.parse().ok()) {
            out.push(id);
        }
    }
    let lower = body.to_ascii_lowercase();
    for (i, _) in lower.match_indices("x-jeeta-notice:") {
        let rest = body[i + "x-jeeta-notice:".len()..].trim_start();
        if let Some(id) = rest.get(..36).and_then(|s| s.parse().ok()) {
            out.push(id);
        }
    }
    out
}

fn warn(ws: WorkspaceId, code: &str) {
    tracing::warn!(job = "owner_notices", workspace_id = %ws, code, "an owner notice failed");
}

/// One run of the `owner_notices` job: the due notices of every workspace holding one (found with
/// one platform-wide read), at most [`RUN_PER_WORKSPACE`] each, within [`RUN_BUDGET`]. Nothing
/// without a mail sender.
pub async fn run(deps: &Deps, now: OffsetDateTime) -> JobReport {
    let mut report = JobReport::default();
    let Some(sender) = deps.connectors.mail_sender(Provider::Mail) else {
        return report;
    };
    let workspaces = async {
        let mut platform = deps.uow.platform().await?;
        platform.workspaces_with_due_notices(now).await
    };
    let workspaces = match workspaces.await {
        Ok(found) => found,
        Err(e) => {
            report.failed += 1;
            tracing::warn!(
                job = "owner_notices",
                code = e.code.as_str(),
                "owner notices failed"
            );
            return report;
        }
    };
    let deadline = std::time::Instant::now() + RUN_BUDGET;
    for ws in workspaces {
        if std::time::Instant::now() >= deadline {
            break;
        }
        match send_due(deps, sender.as_ref(), ws, now, deadline).await {
            Ok((sent, failed)) => {
                report.touched += u64::from(sent + failed);
                report.changed += u64::from(sent);
                report.failed += u64::from(failed);
            }
            Err(e) => {
                report.failed += 1;
                warn(ws, e.code.as_str());
            }
        }
    }
    report
}

/// Workspace `ws`'s turn: rows left `sending` are taken as sent, then its due notices are sent one
/// after the other (each failure counted on its row, the next tried all the same). How many went
/// out and how many failed.
async fn send_due(
    deps: &Deps,
    sender: &dyn crate::ports::connectors::MailSender,
    ws: WorkspaceId,
    now: OffsetDateTime,
    deadline: std::time::Instant,
) -> Result<(u32, u32), AppError> {
    let ids = {
        let mut r = deps.uow.tenant(ws).await?;
        r.notices().settle_sending(now - SENDING_STALE).await?;
        let ids = r.notices().due(now, RUN_PER_WORKSPACE).await?;
        r.commit().await?;
        ids
    };
    if ids.is_empty() {
        return Ok((0, 0));
    }
    crate::usecases::connector::refresh_tenant_hosts(deps, ws).await?;
    let (mut sent, mut failed) = (0, 0);
    for id in ids {
        if std::time::Instant::now() >= deadline {
            break;
        }
        match send_one(deps, sender, ws, id, now).await {
            Ok(true) => sent += 1,
            Ok(false) => failed += 1,
            Err(e) => {
                failed += 1;
                warn(ws, e.code.as_str());
                if let Err(e) = attempt_failed(deps, ws, id, now).await {
                    warn(ws, e.code.as_str());
                }
            }
        }
    }
    Ok((sent, failed))
}

/// The state a notice takes after a failed attempt: queued again after its backoff, or failed once
/// its attempts are spent.
fn after_failure(row: &mut NoticeRow, now: OffsetDateTime) {
    if row.attempts >= MAX_ATTEMPTS {
        row.state = NoticeState::Failed;
        row.next_at = None;
    } else {
        let wait =
            BACKOFF_MINUTES[(row.attempts.max(1) as usize - 1).min(BACKOFF_MINUTES.len() - 1)];
        row.state = NoticeState::Queued;
        row.next_at = Some(now + Duration::minutes(wait));
    }
}

/// An error before the send (the claim, the credential): the attempt is counted on the row, which
/// waits its backoff or fails. A row already `sending` is left to be taken as sent.
async fn attempt_failed(
    deps: &Deps,
    ws: WorkspaceId,
    id: Uuid,
    now: OffsetDateTime,
) -> Result<(), AppError> {
    let mut r = deps.uow.tenant(ws).await?;
    let Some(mut row) = r.notices().lock(id).await? else {
        return Ok(());
    };
    if row.state != NoticeState::Queued {
        return Ok(());
    }
    row.attempts += 1;
    after_failure(&mut row, now);
    r.notices().save(&row).await?;
    r.commit().await
}

/// Sends notice `id`: `Ok(true)` when it went out (or may have), `Ok(false)` when this attempt
/// failed or it was not due, `Err` for an error before the send (the caller counts the attempt).
async fn send_one(
    deps: &Deps,
    sender: &dyn crate::ports::connectors::MailSender,
    ws: WorkspaceId,
    id: Uuid,
    now: OffsetDateTime,
) -> Result<bool, AppError> {
    // Claim: the attempt counted, `sending` from here; the credential opened first, so an error
    // before the send leaves the row queued for `attempt_failed`.
    let (row, credential, to, domain, order) = {
        let mut r = deps.uow.tenant(ws).await?;
        let Some(mut row) = r.notices().lock(id).await? else {
            return Ok(false);
        };
        if row.state != NoticeState::Queued || row.next_at.is_some_and(|at| at > now) {
            return Ok(false);
        }
        if row.attempts >= MAX_ATTEMPTS {
            row.state = NoticeState::Failed;
            r.notices().save(&row).await?;
            r.commit().await?;
            return Ok(false);
        }
        let caps = mailboxes(r.as_mut()).await?;
        let mailbox = mailbox(&caps).cloned();
        let sealed = match &mailbox {
            Some(m) => r.capabilities().read_sealed(m.id).await?,
            None => None,
        };
        let to = recipients(r.as_mut()).await?;
        // An order's notice shows its amount and the shop's reference.
        let order = match row
            .dedupe_key
            .strip_prefix("order:")
            .map(str::parse::<Uuid>)
        {
            Some(Ok(id)) if row.kind == NoticeKind::OrderCreated => {
                r.auto_reply().order_get(id).await?
            }
            _ => None,
        };
        row.attempts += 1;
        let (Some(mailbox), Some(sealed)) = (mailbox, sealed) else {
            row.state = NoticeState::Failed;
            r.notices().save(&row).await?;
            r.commit().await?;
            warn(ws, "no_mailbox");
            return Ok(false);
        };
        if to.is_empty() {
            row.state = NoticeState::Failed;
            r.notices().save(&row).await?;
            r.commit().await?;
            warn(ws, "no_recipient");
            return Ok(false);
        }
        let credential = open_credential(deps, ws, &sealed)?;
        let domain = mailbox
            .external_id
            .as_deref()
            .and_then(|a| a.rsplit_once('@').map(|(_, d)| d.to_owned()))
            .or_else(|| {
                deps.apps
                    .public_base_url()
                    .and_then(|u| u.host_str().map(str::to_owned))
            })
            .unwrap_or_else(|| "jeeta.invalid".to_owned());
        row.state = NoticeState::Sending;
        row.sent_at = Some(now);
        row.mailbox_capability_id = Some(mailbox.id);
        r.notices().save(&row).await?;
        r.commit().await?;
        (row, credential, to, domain, order)
    };
    let (subject, text) = words(deps, &row, order.as_ref());
    // Sent: any mail that went out, or that may have.
    let mut reached = false;
    let mut transient = false;
    for (n, address) in to.iter().enumerate() {
        let mail = MailMessage {
            to: address.clone(),
            subject: subject.to_owned(),
            text: text.clone(),
            message_id: format!("<{ID_PREFIX}{}.{n}@{domain}>", row.id),
            in_reply_to: None,
            references: Vec::new(),
            attachments: Vec::new(),
            from_name: Some("Jeeta".to_owned()),
            list_unsubscribe: None,
            attachment_files: Vec::new(),
            auto_submitted: true,
            notice_marker: Some(row.id.to_string()),
        };
        match tokio::time::timeout(SEND_TIMEOUT, sender.send(ws, &credential, mail)).await {
            Ok(Ok(_)) | Ok(Err(ConnectorError::Unknown { .. })) | Err(_) => reached = true,
            Ok(Err(ConnectorError::Transient { .. } | ConnectorError::Throttle { .. })) => {
                transient = true
            }
            Ok(Err(_)) => {}
        }
    }
    let mut r = deps.uow.tenant(ws).await?;
    let Some(mut done) = r.notices().lock(id).await? else {
        return Ok(reached);
    };
    if done.state != NoticeState::Sending {
        return Ok(reached);
    }
    if reached {
        done.state = NoticeState::Sent;
        done.sent_at = Some(now);
    } else if transient {
        done.sent_at = None;
        after_failure(&mut done, now);
    } else {
        done.state = NoticeState::Failed;
        done.sent_at = None;
    }
    r.notices().save(&done).await?;
    r.commit().await?;
    if !reached {
        warn(ws, "send_failed");
    }
    Ok(reached)
}

/// The addresses a notice goes to: active members whose role has `team.manage`, each once, at
/// most [`MAX_RECIPIENTS`], oldest first.
async fn recipients(r: &mut dyn TenantRepos) -> Result<Vec<String>, AppError> {
    let managers: Vec<String> = r
        .roles()
        .list()
        .await?
        .into_iter()
        .filter(|role| role.permissions.contains(&Permission::TeamManage))
        .map(|role| role.key)
        .collect();
    let mut out: Vec<String> = Vec::new();
    for m in r.memberships().list().await? {
        if m.status != MembershipStatus::Active || !managers.contains(&m.role_key) {
            continue;
        }
        let address = m.email.as_str().to_owned();
        if !out.iter().any(|a| a.eq_ignore_ascii_case(&address)) {
            out.push(address);
        }
        if out.len() == MAX_RECIPIENTS {
            break;
        }
    }
    Ok(out)
}

/// A notice's subject and its three lines: what happened, why (in plain words; for an order its
/// amount and the shop's reference, `order`) and where.
fn words(deps: &Deps, row: &NoticeRow, order: Option<&OrderRow>) -> (&'static str, String) {
    let (subject, what) = headline(row);
    let why = match row.kind {
        NoticeKind::HandedOver => format!("Neden: {}", reason_words(row.reason.as_deref())),
        NoticeKind::OrderCreated => match order {
            Some(o) => format!(
                "Tutar: {} {} · Mağaza referansı: {}",
                whole(o.amount_minor),
                o.currency,
                o.reference.as_deref().unwrap_or("-")
            ),
            None => "Ayrıntılar konuşmada.".to_owned(),
        },
    };
    let link = match deps.apps.public_base_url() {
        Some(base) => format!(
            "{}/inbox/{}",
            base.as_str().trim_end_matches('/'),
            row.conversation_id
        ),
        None => format!("Gelen kutusu, konuşma {}", row.conversation_id),
    };
    (
        subject,
        format!(
            "{what}\n{why}\n{link}\n\nBu e-postaları Bilgi bankası → Kurallar'dan kapatabilirsiniz."
        ),
    )
}

/// A notice's subject and its first line, what happened.
fn headline(row: &NoticeRow) -> (&'static str, &'static str) {
    match row.kind {
        // The conversation stayed the agent's: the owner is needed on one point.
        NoticeKind::HandedOver if row.dedupe_key.starts_with(NEEDS_YOU) => (
            "Jeeta: bir konuşma sizi bekliyor",
            "Otomatik yanıtın bir konuda size ihtiyacı var; konuşma otomatik yanıtta kalıyor ve \
             siz Devral'a basmadıkça müşteriye o yanıt vermeye devam ediyor.",
        ),
        NoticeKind::HandedOver => (
            "Jeeta: bir konuşma sizi bekliyor",
            "Otomatik yanıt bir konuşmayı size devretti.",
        ),
        NoticeKind::OrderCreated => (
            "Jeeta: yeni sipariş oluşturuldu",
            "Otomatik yanıt yeni bir sipariş oluşturdu.",
        ),
    }
}

/// Minor units as whole units, with the kuruş only when there are some.
fn whole(minor: i64) -> String {
    if minor % 100 == 0 {
        (minor / 100).to_string()
    } else {
        format!("{}.{:02}", minor / 100, (minor % 100).abs())
    }
}

/// A hand-over's reason code in plain Turkish: a fixed table, "Diğer" for anything else.
pub(crate) fn reason_words(code: Option<&str>) -> &'static str {
    let Some(code) = code else {
        return "Diğer";
    };
    match code {
        "asks_for_person" => "Müşteri bir kişiyle görüşmek istedi",
        "out_of_standard" => "İstek standart işin dışında",
        "bulk_or_corporate" => "Toplu ya da kurumsal bir istek",
        "complaint" => "Müşteri bir şikâyetini iletti",
        "payment_problem" => "Bir ödeme sorusu var",
        "not_covered" => "Kartlarda yanıtı olmayan bir soru",
        "outside_active_hours" => "Çalışma saatleri dışında",
        "failed" => "Otomatik yanıt şu an yanıt üretemedi",
        "requote" => "Müşteri ikinci bir teklif istedi",
        "human_quoted" => "Fiyatı ekipten biri konuşmuştu",
        "response_overdue" => "Müşteri zamanında yanıt alamadı",
        c if c.starts_with("limit_") => "Günlük otomatik yanıt sınırı doldu",
        c if c.starts_with("judge_") => "Hazırlanan yanıt denetimden geçmedi",
        "order_link_unsent" => "Sipariş oluştu, ödeme bağlantısını siz gönderin",
        "no_auto_quote" | "quote_expired" | "quote_ambiguous" | "acceptance_unverified" => {
            "Sipariş için teklif ya da onay doğrulanamadı"
        }
        c if c.starts_with("order_") => "Sipariş oluşturulamadı",
        _ => "Diğer",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_notice_id_is_read_from_its_message_id_only() {
        let id = Uuid::now_v7();
        assert_eq!(
            notice_id(&format!("<jeeta-notice.{id}.0@example.com>")),
            Some(id)
        );
        assert_eq!(
            notice_id(&format!(
                "<other@example.com> <jeeta-notice.{id}.3@example.com>"
            )),
            Some(id)
        );
        assert_eq!(notice_id("<jeeta-notice.not-a-uuid.0@example.com>"), None);
        assert_eq!(notice_id(&format!("<{id}@example.com>")), None);
    }

    #[test]
    fn a_report_quotes_a_notice_by_its_message_id_or_its_marker() {
        let (a, b) = (Uuid::now_v7(), Uuid::now_v7());
        let body = format!(
            "Original-Message-ID: <jeeta-notice.{a}.0@example.com>
x-jeeta-notice:  {b}
"
        );
        assert_eq!(quoted_ids(&body), vec![a, b]);
        assert!(quoted_ids("jeeta-notice.short X-Jeeta-Notice: nope").is_empty());
    }

    #[test]
    fn a_failed_attempt_waits_one_five_then_fifteen_minutes_and_then_fails() {
        let now = OffsetDateTime::UNIX_EPOCH;
        let mut row = NoticeRow {
            id: Uuid::now_v7(),
            kind: NoticeKind::HandedOver,
            conversation_id: ConversationId::new_v7(),
            dedupe_key: "k".into(),
            reason: None,
            created_at: now,
            state: NoticeState::Sending,
            attempts: 0,
            next_at: None,
            sent_at: None,
            mailbox_capability_id: None,
        };
        for (attempts, wait) in [(1, 1), (2, 5), (3, 15)] {
            row.attempts = attempts;
            after_failure(&mut row, now);
            assert_eq!(row.state, NoticeState::Queued);
            assert_eq!(row.next_at, Some(now + Duration::minutes(wait)));
        }
        row.attempts = MAX_ATTEMPTS;
        after_failure(&mut row, now);
        assert_eq!(row.state, NoticeState::Failed);
    }

    #[test]
    fn a_kept_conversations_notice_says_it_needs_the_owner_and_stays_the_agents() {
        let row = |key: &str| NoticeRow {
            id: Uuid::now_v7(),
            kind: NoticeKind::HandedOver,
            conversation_id: ConversationId::new_v7(),
            dedupe_key: key.into(),
            reason: Some("not_covered".into()),
            created_at: OffsetDateTime::UNIX_EPOCH,
            state: NoticeState::Queued,
            attempts: 0,
            next_at: None,
            sent_at: None,
            mailbox_capability_id: None,
        };
        let (subject, kept) = headline(&row(&format!("{NEEDS_YOU}c:t")));
        assert_eq!(subject, SUBJECTS[0]);
        assert!(kept.contains("size ihtiyacı var"), "{kept}");
        assert!(kept.contains("otomatik yanıtta kalıyor"), "{kept}");
        assert!(!kept.contains("devretti"), "{kept}");
        let (_, handed) = headline(&row("handed_over:c:1"));
        assert!(handed.contains("size devretti"), "{handed}");
        assert_eq!(
            reason_words(Some("response_overdue")),
            "Müşteri zamanında yanıt alamadı"
        );
    }

    #[test]
    fn reasons_read_in_plain_words() {
        assert_eq!(
            reason_words(Some("asks_for_person")),
            "Müşteri bir kişiyle görüşmek istedi"
        );
        assert_eq!(
            reason_words(Some("limit_spend")),
            "Günlük otomatik yanıt sınırı doldu"
        );
        assert_eq!(
            reason_words(Some("order_rejected")),
            "Sipariş oluşturulamadı"
        );
        assert_eq!(reason_words(Some("something_new")), "Diğer");
        assert_eq!(reason_words(None), "Diğer");
    }
}
