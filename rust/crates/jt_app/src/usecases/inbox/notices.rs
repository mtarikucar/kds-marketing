//! The owner's email notices (migration `0049_owner_notices`): when the automatic replies hand a
//! conversation to a person (or, from the orders' release, create an order), the workspace's team
//! managers are told by email, through the workspace's own oldest verified mailbox.
//!
//! - **Written** in the hand-over's own transaction (`queue_in`): one row per hand-over (its
//!   dedupe key names the conversation and the executor generation the hand-over wrote). Nothing at
//!   all while the setting is off (`AutoReply::notify_email`) or no verified mailbox exists; over
//!   [`DAILY_NOTICES`] in a rolling day the row is kept as `skipped` (`daily_cap`).
//! - **Sent** after each workspace's turn of the automatic replies' job and in its minute sweep
//!   ([`send_queued`]): claimed (one attempt counted) in a transaction of its own, then sent with no
//!   lock held, one email to each of at most [`MAX_RECIPIENTS`] active members whose role has
//!   `team.manage`. A transient failure is asked again, up to [`MAX_ATTEMPTS`] attempts; an
//!   answer that may have reached the mail server (`Unknown`) counts as sent, never again.
//! - **What it says**: what happened, the reason in plain words (a fixed table of codes) and the
//!   conversation's link in the panel. Never a customer's name, text or summary; the row holds
//!   codes and ids only.
//! - **Never back in the inbox**: each email's `Message-ID` is `<jeeta-notice.{id}.{n}@{domain}>`.
//!   The consumer drops a polled mail (its inbox copy, its Sent copy, an answer to it) whose
//!   `Message-ID` or `In-Reply-To` names a notice the workspace holds (`own_notice`).

use jt_capability::{Capability, StoredStatus};
use jt_connector::Provider;
use jt_inbox::ConversationId;
use jt_tenancy::{MembershipStatus, Permission, WorkspaceId};
use serde_json::Value;
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

use crate::ctx::Ctx;
use crate::error::AppError;
use crate::ports::connectors::MailMessage;
use crate::ports::notices::{NoticeKind, NoticeRow, NoticeState};
use crate::ports::{CapabilityFilter, TenantRepos};
use crate::usecases::Deps;
use crate::usecases::connector::open_credential;

/// The most notices a workspace is sent in a rolling day; past it they are kept as skipped.
pub const DAILY_NOTICES: u32 = 20;
/// The most people one notice is sent to.
pub const MAX_RECIPIENTS: usize = 5;
/// The most attempts at one notice.
pub const MAX_ATTEMPTS: u32 = 3;
/// The most notices one turn sends for a workspace.
const SEND_BATCH: u32 = 10;
/// What every notice's `Message-ID` starts with.
const ID_PREFIX: &str = "jeeta-notice.";

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
            sent_at: None,
            mailbox_capability_id: None,
        })
        .await?;
    Ok(())
}

/// Whether polled mail `payload` (its `message_id` and `in_reply_to`) is one of the workspace's own
/// notices, or an answer to one: a `Message-ID` `<jeeta-notice.{id}.…>` whose id the workspace
/// holds. An id it does not hold is not (the mail is consumed as any other).
pub(crate) async fn own_notice(r: &mut dyn TenantRepos, payload: &Value) -> Result<bool, AppError> {
    for field in ["message_id", "in_reply_to"] {
        let Some(id) = payload[field].as_str().and_then(notice_id) else {
            continue;
        };
        if r.notices().get(id).await?.is_some() {
            return Ok(true);
        }
    }
    Ok(false)
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

/// Sends workspace `ws`'s queued notices (see the module docs); failures are logged by code and
/// never stop the job.
pub async fn send_queued(deps: &Deps, ws: WorkspaceId, now: OffsetDateTime) {
    if let Err(e) = send_all(deps, ws, now).await {
        warn(ws, e.code.as_str());
    }
}

fn warn(ws: WorkspaceId, code: &str) {
    tracing::warn!(job = "inbox_auto_reply", workspace_id = %ws, code, "an owner notice failed");
}

async fn send_all(deps: &Deps, ws: WorkspaceId, now: OffsetDateTime) -> Result<(), AppError> {
    let ids = {
        let mut r = deps.uow.tenant(ws).await?;
        r.notices().queued(SEND_BATCH).await?
    };
    if ids.is_empty() {
        return Ok(());
    }
    let Some(sender) = deps.connectors.mail_sender(Provider::Mail) else {
        return Ok(());
    };
    crate::usecases::connector::refresh_tenant_hosts(deps, ws).await?;
    for id in ids {
        // Claim: one attempt counted before anything is sent.
        let mut r = deps.uow.tenant(ws).await?;
        let Some(mut row) = r.notices().lock(id).await? else {
            continue;
        };
        if row.state != NoticeState::Queued {
            continue;
        }
        row.attempts += 1;
        let caps = mailboxes(r.as_mut()).await?;
        let mailbox = mailbox(&caps).cloned();
        let sealed = match &mailbox {
            Some(m) => r.capabilities().read_sealed(m.id).await?,
            None => None,
        };
        let to = recipients(r.as_mut()).await?;
        let (Some(mailbox), Some(sealed)) = (mailbox, sealed) else {
            row.state = NoticeState::Failed;
            r.notices().save(&row).await?;
            r.commit().await?;
            warn(ws, "no_mailbox");
            continue;
        };
        if to.is_empty() {
            row.state = NoticeState::Failed;
            r.notices().save(&row).await?;
            r.commit().await?;
            warn(ws, "no_recipient");
            continue;
        }
        row.mailbox_capability_id = Some(mailbox.id);
        r.notices().save(&row).await?;
        r.commit().await?;
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
        let (subject, text) = words(deps, &row);
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
            };
            match sender.send(ws, &credential, mail).await {
                Ok(_) => reached = true,
                Err(jt_connector::ConnectorError::Unknown { .. }) => reached = true,
                Err(
                    jt_connector::ConnectorError::Transient { .. }
                    | jt_connector::ConnectorError::Throttle { .. },
                ) => transient = true,
                Err(_) => {}
            }
        }
        let mut r = deps.uow.tenant(ws).await?;
        let Some(mut done) = r.notices().lock(id).await? else {
            continue;
        };
        done.state = if reached {
            done.sent_at = Some(now);
            NoticeState::Sent
        } else if transient && done.attempts < MAX_ATTEMPTS {
            NoticeState::Queued
        } else {
            NoticeState::Failed
        };
        r.notices().save(&done).await?;
        r.commit().await?;
        if !reached {
            warn(ws, "send_failed");
        }
    }
    Ok(())
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

/// A notice's subject and its three lines: what happened, why (in plain words) and where.
fn words(deps: &Deps, row: &NoticeRow) -> (&'static str, String) {
    let (subject, what) = match row.kind {
        NoticeKind::HandedOver => (
            "Jeeta: bir konuşma sizi bekliyor",
            "Otomatik yanıt bir konuşmayı size devretti.",
        ),
        NoticeKind::OrderCreated => (
            "Jeeta: yeni sipariş oluşturuldu",
            "Otomatik yanıt yeni bir sipariş oluşturdu.",
        ),
    };
    let why = match row.kind {
        NoticeKind::HandedOver => format!("Neden: {}", reason_words(row.reason.as_deref())),
        NoticeKind::OrderCreated => "Ayrıntılar konuşmada.".to_owned(),
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
        c if c.starts_with("limit_") => "Günlük otomatik yanıt sınırı doldu",
        c if c.starts_with("judge_") => "Hazırlanan yanıt denetimden geçmedi",
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
