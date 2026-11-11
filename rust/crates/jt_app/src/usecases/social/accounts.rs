//! The module's accounts (design 2026-11-10 §7.1, §7.5, §7.6): each connected social account
//! with what its platform says about it day by day, what is coming on it and what went out; a
//! person's pause of one account; and the daily read of the accounts' own numbers.
//!
//! A number a platform does not give is `None` everywhere here, never zero.
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        CapabilityFilter, TenantRepos,
        posts::{AccountDay, AccountNumbers, PostingSettings},
        studio::ApprovalTarget,
    },
    usecases::{
        Deps,
        connector::{adapter_public, open_credential},
        ledger_entry, modules,
        studio::{
            chain::{self, ORGANIC_KINDS},
            control::human_approver,
            materials,
            posts::{local_day, zone_or_default},
            work::EmptyInput,
        },
    },
};
use jt_capability::{Capability, CapabilityId, StoredStatus};
use jt_connector::provider_for_kind;
use jt_studio::{PostFormat, SlotId, SlotState};
use jt_tenancy::{Permission, WorkspaceId};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use time::{Date, Duration, OffsetDateTime};

/// How long a snapshot is kept.
pub const ACCOUNT_DAYS_KEPT: i64 = 400;
/// The longest period one read of an account covers.
pub const MAX_PERIOD_DAYS: i64 = 366;
/// The period read when none is asked for.
const DEFAULT_PERIOD_DAYS: i64 = 30;
/// The most posts listed as coming or as gone out.
const MAX_LISTED: usize = 50;

/// One day's numbers of an account, as an answer carries them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DayOut {
    #[serde(with = "jt_studio::time_compat::date")]
    pub day: Date,
    #[serde(flatten)]
    pub numbers: AccountNumbers,
}

impl From<&AccountDay> for DayOut {
    fn from(d: &AccountDay) -> Self {
        DayOut {
            day: d.day,
            numbers: d.numbers,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct NextPost {
    #[serde(with = "jt_studio::time_compat")]
    pub publish_at: OffsetDateTime,
    pub format: PostFormat,
}

/// A connected social account: what it is, whether a person paused it, its latest numbers and
/// its next planned post.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SocialAccount {
    pub capability_id: CapabilityId,
    pub name: String,
    /// The capability's kind, e.g. `instagram`.
    pub kind: String,
    pub status: StoredStatus,
    pub paused: bool,
    pub latest: Option<DayOut>,
    pub next: Option<NextPost>,
}

/// Why a planned post that is not going out by itself waits.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitsFor {
    /// TikTok's posting screen, which a person fills (design §7.4).
    TiktokScreen,
    /// The connection's own approval flag (design B35).
    Approval,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpcomingState {
    /// Goes out at its time.
    Ready,
    /// Waits for a person: see `waits_for`.
    WaitingPerson,
    /// Held: its content is not there or the checks hold it, or its account or lane is stopped.
    Held,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Upcoming {
    pub slot_id: SlotId,
    #[serde(with = "jt_studio::time_compat")]
    pub publish_at: OffsetDateTime,
    pub format: PostFormat,
    /// The first line of what goes out.
    pub title: String,
    /// Whether the platform's own scheduler holds it (design §7.3).
    pub held_at_provider: bool,
    pub state: UpcomingState,
    pub waits_for: Option<WaitsFor>,
}

/// What a post reached, by its latest measurement.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct PostNumbers {
    pub reach: Option<i64>,
    pub views: Option<i64>,
    pub engagement: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Recent {
    pub slot_id: SlotId,
    #[serde(with = "jt_studio::time_compat")]
    pub published_at: OffsetDateTime,
    pub format: Option<PostFormat>,
    pub title: String,
    pub url: Option<String>,
    pub metrics: PostNumbers,
}

/// The period's posts and the sum of what they reached; a sum with no number in it is `None`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Totals {
    pub posts: u32,
    pub reach: Option<i64>,
    pub views: Option<i64>,
    pub engagement: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AccountDetail {
    pub account: SocialAccount,
    pub days: Vec<DayOut>,
    pub upcoming: Vec<Upcoming>,
    pub recent: Vec<Recent>,
    pub totals: Totals,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AccountQuery {
    pub capability_id: CapabilityId,
    /// The first and last day of the period, in the workspace's posting time zone; the last 30
    /// days when left out. At most 366 days.
    #[serde(default, with = "jt_studio::time_compat::date_option")]
    pub from: Option<Date>,
    #[serde(default, with = "jt_studio::time_compat::date_option")]
    pub until: Option<Date>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PauseInput {
    pub capability_id: CapabilityId,
    pub paused: bool,
    pub expected_revision: u64,
}

fn invalid(field: &str, reason: &str) -> AppError {
    AppError::validation(reason, json!({"field":field,"reason":reason}))
}

/// The five numbers out of a platform's own counters: each from the first name a connector
/// uses for it. What no connector reads stays `None`.
pub(crate) fn numbers(raw: &BTreeMap<String, i64>) -> AccountNumbers {
    let first = |names: &[&str]| names.iter().find_map(|n| raw.get(*n).copied());
    AccountNumbers {
        followers: first(&[
            "followers_count",
            "follower_count",
            "fan_count",
            "followers",
        ]),
        reach: first(&["reach"]),
        views: first(&["views", "impressions"]),
        engagement: first(&["engagement", "accounts_engaged", "total_interactions"]),
        profile_visits: first(&["profile_views", "profile_visits"]),
    }
}

/// The first line of `text`, at most 80 characters.
fn first_line(text: &str) -> String {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default()
        .chars()
        .take(80)
        .collect()
}

/// The workspace's social accounts: its capabilities of the kinds posts go out on, retired ones
/// left out, by name.
async fn accounts(r: &mut dyn TenantRepos) -> Result<Vec<Capability>, AppError> {
    let mut list: Vec<Capability> = r
        .capabilities()
        .list(CapabilityFilter::default())
        .await?
        .into_iter()
        .filter(|c| {
            ORGANIC_KINDS.contains(&c.kind_key.as_str()) && c.status != StoredStatus::Retired
        })
        .collect();
    list.sort_by(|a, b| (a.name.as_str(), a.id).cmp(&(b.name.as_str(), b.id)));
    Ok(list)
}

/// The posts still to go out on each account (planned or ready, not retired), earliest first.
async fn queued(
    r: &mut dyn TenantRepos,
) -> Result<Vec<(jt_studio::PlannedPost, jt_studio::Slot)>, AppError> {
    let mut out = Vec::new();
    for p in r.studio_posts().list_posts().await? {
        if p.retired.is_some() {
            continue;
        }
        if let Some(s) = r.studio().get_slot(p.slot_id).await?
            && matches!(s.state, SlotState::Planned | SlotState::Ready)
        {
            out.push((p, s));
        }
    }
    out.sort_by_key(|(p, _)| (p.publish_at, p.slot_id));
    Ok(out)
}

fn account_of(
    c: &Capability,
    settings: &PostingSettings,
    latest: &[AccountDay],
    queue: &[(jt_studio::PlannedPost, jt_studio::Slot)],
) -> SocialAccount {
    SocialAccount {
        capability_id: c.id,
        name: c.name.clone(),
        kind: c.kind_key.clone(),
        status: c.status,
        paused: settings.paused_capability_ids.contains(&c.id),
        latest: latest
            .iter()
            .find(|d| d.capability_id == c.id)
            .map(DayOut::from),
        next: queue
            .iter()
            .find(|(p, _)| p.capability_id == c.id)
            .map(|(p, _)| NextPost {
                publish_at: p.publish_at,
                format: p.format,
            }),
    }
}

/// `social.accounts_list`: the connected social accounts, each with its latest numbers and its
/// next planned post.
pub async fn accounts_list(
    d: &Deps,
    ctx: &Ctx,
    _: EmptyInput,
) -> Result<Vec<SocialAccount>, AppError> {
    ctx.require(Permission::SocialWork)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    chain::active(r.as_mut()).await?;
    let settings = r.studio_posts().posting_settings().await?;
    let latest = r.studio_posts().latest_account_days().await?;
    let queue = queued(r.as_mut()).await?;
    Ok(accounts(r.as_mut())
        .await?
        .iter()
        .map(|c| account_of(c, &settings, &latest, &queue))
        .collect())
}

/// `social.account_get`: one account over a period: its numbers day by day, the posts coming on
/// it (and, for one that does not go out by itself, why), the posts that went out with what each
/// reached, and the period's totals.
pub async fn account_get(d: &Deps, ctx: &Ctx, q: AccountQuery) -> Result<AccountDetail, AppError> {
    ctx.require(Permission::SocialWork)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    chain::active(r.as_mut()).await?;
    let settings = r.studio_posts().posting_settings().await?;
    let tz = zone_or_default(&settings.tz);
    let today = local_day(tz, ctx.now);
    let until = q.until.unwrap_or(today);
    let from = q
        .from
        .unwrap_or(until - Duration::days(DEFAULT_PERIOD_DAYS - 1));
    if from > until || (until - from).whole_days() >= MAX_PERIOD_DAYS {
        return Err(invalid("from", "period_of_1_to_366_days"));
    }
    let c = accounts(r.as_mut())
        .await?
        .into_iter()
        .find(|c| c.id == q.capability_id)
        .ok_or_else(|| AppError::not_found("social account"))?;
    let latest = r.studio_posts().latest_account_days().await?;
    let queue = queued(r.as_mut()).await?;
    let days = r
        .studio_posts()
        .account_days(c.id, from, until)
        .await?
        .iter()
        .map(DayOut::from)
        .collect();

    // What is coming: is it going out by itself, and if not, what does it wait for.
    let control = r.studio_control().lock_control().await?;
    let stopped = control.is_braked(jt_strategy::LaneKind::Organic)
        || settings.paused_capability_ids.contains(&c.id);
    let mut upcoming = Vec::new();
    for (p, s) in queue.iter().filter(|(p, _)| p.capability_id == c.id) {
        if upcoming.len() == MAX_LISTED {
            break;
        }
        let piece = r.studio().get_piece(s.id, s.revision).await?;
        let approved = r
            .studio()
            .get_approval(ApprovalTarget::Slot(s.id), s.revision)
            .await?;
        let waits_for = if s.state != SlotState::Ready {
            None
        } else if jt_studio::requires_posting_screen(&c.kind_key)
            && approved.as_ref().is_none_or(|a| a.tiktok.is_none())
        {
            Some(WaitsFor::TiktokScreen)
        } else if c.policy.requires_human_approval && approved.is_none() {
            Some(WaitsFor::Approval)
        } else {
            None
        };
        // Its platform's own scheduler holds it (design §7.3).
        let held_at_provider = r
            .studio()
            .slot_evidence(s.id)
            .await?
            .0
            .iter()
            .any(jt_studio::PublishAttempt::is_held);
        let held = match &piece {
            None => true,
            Some(piece) => {
                stopped
                    || materials::material_check(r.as_mut(), s.id, piece, ctx.now.max(p.publish_at))
                        .await?
                        .is_some_and(|check| check.holds)
            }
        };
        upcoming.push(Upcoming {
            slot_id: s.id,
            publish_at: p.publish_at,
            format: p.format,
            title: piece
                .as_ref()
                .map(|x| first_line(&x.text))
                .unwrap_or_default(),
            held_at_provider,
            state: if held {
                UpcomingState::Held
            } else if waits_for.is_some() {
                UpcomingState::WaitingPerson
            } else {
                UpcomingState::Ready
            },
            waits_for: if held { None } else { waits_for },
        });
    }

    // What went out, newest first, each with its latest measurement.
    let mut published: Vec<_> = r
        .studio()
        .list_publications()
        .await?
        .into_iter()
        .filter(|p| p.capability_id == c.id)
        .collect();
    published.sort_by_key(|p| std::cmp::Reverse((p.published_at, p.id.0)));
    let measurements = r.studio().list_measurements().await?;
    let reached = |id| {
        let latest = measurements
            .iter()
            .filter(|m| m.publication_id == Some(id))
            .max_by_key(|m| (m.measured_at, m.id.0));
        let value = |names: &[&str]| {
            latest.and_then(|m| {
                names
                    .iter()
                    .find_map(|n| m.raw_metrics.get(*n).copied().flatten())
            })
        };
        PostNumbers {
            reach: value(&["reach"]),
            views: value(&["impressions", "views"]),
            engagement: value(&["engagements"]),
        }
    };
    let mut totals = Totals::default();
    let mut recent = Vec::new();
    for p in &published {
        let numbers = reached(p.id);
        let day = local_day(tz, p.published_at);
        if day >= from && day <= until {
            totals.posts += 1;
            let add = |sum: &mut Option<i64>, n: Option<i64>| {
                if let Some(n) = n {
                    *sum = Some(sum.unwrap_or(0).saturating_add(n));
                }
            };
            add(&mut totals.reach, numbers.reach);
            add(&mut totals.views, numbers.views);
            add(&mut totals.engagement, numbers.engagement);
        }
        if recent.len() < MAX_LISTED {
            // What went out is what its attempt sent: the slot has moved on since.
            let (attempts, _) = r.studio().slot_evidence(p.slot_id).await?;
            let title = attempts
                .iter()
                .find(|a| a.id() == p.attempt_id)
                .map(|a| first_line(&a.piece().text))
                .unwrap_or_default();
            recent.push(Recent {
                slot_id: p.slot_id,
                published_at: p.published_at,
                format: r
                    .studio_posts()
                    .get_post(p.slot_id)
                    .await?
                    .map(|x| x.format),
                title,
                url: p.url.as_ref().map(ToString::to_string),
                metrics: numbers,
            });
        }
    }
    Ok(AccountDetail {
        account: account_of(&c, &settings, &latest, &queue),
        days,
        upcoming,
        recent,
        totals,
    })
}

/// `social.account_pause`: a person pauses one account's posting, or resumes it (design §7.6).
/// Panel-only and a person's in person. While paused, nothing is planned for the account and
/// nothing goes out on it, as under a brake, for that account alone; what is planned stays and
/// goes out once it is resumed, if its time has not passed.
pub async fn account_pause(
    d: &Deps,
    ctx: &Ctx,
    i: PauseInput,
) -> Result<PostingSettings, AppError> {
    ctx.require(Permission::SocialManage)?;
    human_approver(ctx)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    chain::active(r.as_mut()).await?;
    r.studio_control().lock_control().await?;
    let mut settings = r.studio_posts().posting_settings().await?;
    if settings.revision != i.expected_revision {
        return Err(AppError::conflict("posting settings changed"));
    }
    if !accounts(r.as_mut())
        .await?
        .iter()
        .any(|c| c.id == i.capability_id)
    {
        return Err(AppError::not_found("social account"));
    }
    let changed = if i.paused {
        settings.paused_capability_ids.insert(i.capability_id)
    } else {
        settings.paused_capability_ids.remove(&i.capability_id)
    };
    if changed {
        settings.revision = settings
            .revision
            .checked_add(1)
            .ok_or_else(|| AppError::conflict("posting settings revision overflow"))?;
        r.studio_posts()
            .save_posting_settings(settings.clone())
            .await?;
        r.ledger()
            .append(ledger_entry(
                ctx,
                if i.paused {
                    "social.account.paused"
                } else {
                    "social.account.resumed"
                },
                "capability",
                i.capability_id,
                json!({"revision": settings.revision}),
            )?)
            .await?;
        r.commit().await?;
    }
    Ok(settings)
}

/// Reads today's numbers of each live social account of `ws` that has none yet, and forgets
/// the snapshots older than [`ACCOUNT_DAYS_KEPT`] days (the `studio_measure` job, every six
/// hours). Only where the social module is installed; a paused account is not read. A read that
/// fails stores nothing and is tried again by the next run: a missing day is a gap, never a
/// zero. Answers how many snapshots were stored.
pub async fn read_days(d: &Deps, ws: WorkspaceId, now: OffsetDateTime) -> Result<u32, AppError> {
    // What to read, and with which credential: nothing of this run holds a transaction while a
    // provider is asked.
    let (today, due) = {
        let mut r = d.uow.tenant(ws).await?;
        chain::active(r.as_mut()).await?;
        if !modules::installed(r.as_mut(), modules::SOCIAL).await? {
            return Ok(0);
        }
        let settings = r.studio_posts().posting_settings().await?;
        let today = local_day(zone_or_default(&settings.tz), now);
        let have: Vec<CapabilityId> = r
            .studio_posts()
            .latest_account_days()
            .await?
            .into_iter()
            .filter(|x| x.day == today)
            .map(|x| x.capability_id)
            .collect();
        let mut due = Vec::new();
        for c in accounts(r.as_mut()).await? {
            if have.contains(&c.id)
                || settings.paused_capability_ids.contains(&c.id)
                || chain::capability_access(&c, now, false).is_err()
            {
                continue;
            }
            let Some(sealed) = r.capabilities().read_sealed(c.id).await? else {
                continue;
            };
            due.push((c, sealed));
        }
        r.studio_posts()
            .purge_account_days(today - Duration::days(ACCOUNT_DAYS_KEPT))
            .await?;
        r.commit().await?;
        (today, due)
    };
    let mut stored = 0;
    for (c, sealed) in due {
        let Some(reader) = provider_for_kind(&c.kind_key).and_then(|p| d.connectors.insights(p))
        else {
            continue;
        };
        let Ok(credential) = open_credential(d, ws, &sealed) else {
            continue;
        };
        let Ok(read) = reader
            .account_metrics(&credential, &adapter_public(&c))
            .await
        else {
            continue;
        };
        if read.metrics.is_empty() {
            continue;
        }
        let mut r = d.uow.tenant(ws).await?;
        if r.studio_posts()
            .insert_account_day(AccountDay {
                workspace_id: ws,
                capability_id: c.id,
                day: today,
                numbers: numbers(&read.metrics),
                raw: read.metrics,
                read_at: now,
            })
            .await?
        {
            stored += 1;
        }
        r.commit().await?;
    }
    Ok(stored)
}
