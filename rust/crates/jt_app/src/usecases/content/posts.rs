//! Paylaşımlar's read model (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §2.3–§2.6, §3.2,
//! §3.3): one row per post a person works with, and what each waits for. A row is a planned post
//! (`post`), a finished version with no planned post yet (`version`), a content still being made
//! (`content`) or an open request of the çekim listesi (`need`). Each carries its status, its
//! eight-dot progress, the waits that stand between it and going out (derived from the facts on
//! every read: a wait goes the moment its cause does, R2), and the actions this caller may take
//! now, with the revisions they need.
//!
//! The read is one tenant bundle and takes no lock (§3.2.4): neither the Studio control's fence
//! nor the execution frame's. Every row of the workspace is built (areas not archived, posts of
//! the last [`POST_WINDOW_DAYS`] days, open requests), then ordered, filtered and paged; the
//! counts are over every row.
use super::pipeline::{PostReads, STAGES, StageKey, StageState, VersionFact};
use crate::{
    ctx::Ctx,
    error::AppError,
    ports::{
        TenantRepos,
        materials::{AnalysisStatus, MaterialIntelligence},
        posts::PostingSettings,
        production_projects::*,
        studio::SlotQuery,
    },
    usecases::{
        Deps,
        social::schedule::{VersionAccounts, area_key, caption},
        studio::{chain, control, library, materials, posts as studio_posts},
        wake::{self, AgentReach, ReachState},
    },
};
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use jt_capability::{Capability, CapabilityId};
use jt_ledger::Actor;
use jt_strategy::LaneKind;
use jt_studio::{
    Depicts, Material, MaterialId, OlayId, Origin, PlannedPost, PostFormat, PublishOutcome,
    Quality, RedactedPublishError, RetirementReason, ShootReason, ShootRequest, ShootRequestId,
    ShootStatus, Slot, SlotId, SlotState, Subject, UseRole, check_use, istanbul_day,
};
use jt_tenancy::{Permission, UserId};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use time::{Date, Duration, OffsetDateTime};
use uuid::Uuid;

/// Who may read the page (§3.1): whoever works the library, the content or the social accounts.
pub const PAGE_PERMISSIONS: &[Permission] = &[
    Permission::ContentWork,
    Permission::ContentManage,
    Permission::SocialWork,
    Permission::SocialManage,
    Permission::MaterialsWork,
];
/// How far back the posts of no content are listed.
pub const POST_WINDOW_DAYS: i64 = 180;
/// How long a failed post without a wait stays in the default view, and a TikTok draft waits.
pub const RECENT_DAYS: i64 = 7;
/// How near a special day's preparation must be for its line (D27).
pub const DAY_LINE_DAYS: i64 = 14;
/// The most special-day lines shown; the rest are counted.
pub const MAX_DAY_LINES: usize = 3;
/// The longest title of a row, in characters.
pub const MAX_TITLE_CHARS: usize = 80;
const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 100;

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostsQuery {
    /// `you`, or a stage key (`hazirlik` … `sonuc`); absent: every row.
    #[serde(default)]
    pub filter: Option<String>,
    /// Opaque, from `next_cursor`.
    #[serde(default)]
    pub cursor: Option<String>,
    /// 1..=100, 50 unless given.
    #[serde(default)]
    pub limit: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowKind {
    Post,
    Version,
    Content,
    Need,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RowStatus {
    Failed,
    TiktokDraft,
    WaitingYou,
    Paused,
    Revising,
    Preparing,
    Scheduling,
    Scheduled,
    Published,
}

/// The finer line under a `preparing` row's title (§2.4).
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SubState {
    /// An agent holds the claim, at this stage.
    Claimed { stage: StageKey },
    /// Queued: an agent can take it and is woken now (`wakes_now`), or starts at its next
    /// expected check-in (`next_at`), which may have passed (`late`).
    Queued {
        wakes_now: bool,
        #[serde(with = "time::serde::rfc3339::option")]
        next_at: Option<OffsetDateTime>,
        late: bool,
    },
    /// Its start time is in the future (a special day's content).
    Starts {
        #[serde(with = "time::serde::rfc3339")]
        at: OffsetDateTime,
    },
    /// The files a person attached wait for their analysis.
    FilesAnalysing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Progress {
    /// The current stage, 0..=7; every one before it is done.
    pub index: u8,
    pub state: StageState,
}

impl Progress {
    fn at(index: u8, state: StageState) -> Self {
        Progress { index, state }
    }

    /// The stage key of its index (a fully done row is `sonuc`).
    pub fn stage(&self) -> StageKey {
        STAGES[usize::from(self.index.min(7))].0
    }
}

/// Why a row waits for a person (§2.6).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WaitCode {
    Approval,
    PostingScreen,
    Capture,
    FilesPermission,
    FilesQuality,
    DeliveryHeld,
    CheckHold,
    Failed,
    TiktokDraft,
    NoAccount,
    NoAccountForPlatform,
    AccountUnavailable,
    AccountPaused,
    Media,
    MaterialRemoved,
    KnowledgeEmpty,
    NoAgent,
    PickTime,
    NeedPhoto,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Wait {
    pub code: WaitCode,
    #[serde(with = "time::serde::rfc3339")]
    pub since: OffsetDateTime,
    /// What the sentence needs: `account` (name), `kind` (platform kind key), `request` (text),
    /// `found` (face, name, child, logo, company), `finding` (a finding code), `reason` (why a
    /// post failed), `recovered` (its account posts again), `material_ids`.
    pub facts: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct SlotRef {
    pub slot_id: SlotId,
    pub expected_revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct RedoRef {
    pub project_id: Uuid,
    pub package_revision: Option<u32>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CancelRef {
    Post {
        slot_id: SlotId,
        expected_revision: u64,
    },
    Version {
        project_id: Uuid,
        version_id: Uuid,
        package_revision: u32,
    },
    Content {
        project_id: Uuid,
        expected_revision: u64,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PickRef {
    pub project_id: Uuid,
    pub version_id: Uuid,
    pub accounts: Vec<CapabilityId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct AreaRef {
    pub project_id: Uuid,
    pub expected_revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct MaterialRef {
    pub material_id: MaterialId,
    pub expected_revision: u64,
}

/// Where `content.files_add` puts files.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FilesTarget {
    Capture { project_id: Uuid, request_id: Uuid },
    Need { shoot_request_id: ShootRequestId },
    SpecialDay { key: String, year: i32 },
}

/// What `Gerek yok` closes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DismissRef {
    /// A content's capture request (`studio.project_request_update`, `dismissed`).
    Capture {
        project_id: Uuid,
        request_id: Uuid,
        expected_revision: u64,
    },
    /// The çekim listesi's request (`studio.shoot_resolve`, `dismissed`).
    Need { shoot_request_id: ShootRequestId },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct AccountRef {
    pub capability_id: CapabilityId,
    /// What `social.account_pause` names: the posting settings' revision.
    pub expected_revision: u64,
}

/// Only what this caller may do now (§3.2.3).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct RowActions {
    pub approve: Option<SlotRef>,
    pub tiktok: Option<SlotRef>,
    pub redo: Option<RedoRef>,
    pub cancel: Option<CancelRef>,
    pub pick_time: Option<PickRef>,
    pub release_check: Option<SlotRef>,
    pub accept_held: Option<AreaRef>,
    pub permit_files: Vec<MaterialRef>,
    pub add_files: Option<FilesTarget>,
    pub dismiss: Option<DismissRef>,
    pub resume_account: Option<AccountRef>,
    pub reconnect: Option<CapabilityId>,
    pub acknowledge: Option<SlotRef>,
    pub connect: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Cover {
    pub material_id: MaterialId,
    pub mime: String,
    /// Short-lived signed URL; only for a caller holding `materials.work`.
    pub preview_url: Option<String>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub preview_expires_at: Option<OffsetDateTime>,
    pub ai_generated: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ChannelRef {
    pub capability_id: CapabilityId,
    pub kind: String,
    pub name: String,
    /// `{Platform}`, or `{Platform} · {name}` when two connected accounts share the platform.
    pub label: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct MediaSummary {
    pub images: u8,
    /// A video's length, when its analysis read it; `None` otherwise (or no video).
    pub video_seconds: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Category {
    pub olay_id: Option<OlayId>,
    /// The olay's title, or `Genel`.
    pub title: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Sibling {
    pub row_id: String,
    pub channel: Option<ChannelRef>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub publish_at: Option<OffsetDateTime>,
    pub status: RowStatus,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PostRow {
    /// `slot:{uuid}` | `version:{uuid}` | `content:{uuid}` | `need:{uuid}`.
    pub id: String,
    pub kind: RowKind,
    pub area_id: Option<Uuid>,
    pub version_id: Option<Uuid>,
    pub slot_id: Option<SlotId>,
    pub shoot_request_id: Option<ShootRequestId>,
    pub title: String,
    pub cover: Option<Cover>,
    pub channel: Option<ChannelRef>,
    pub format: Option<PostFormat>,
    pub media: Option<MediaSummary>,
    pub category: Category,
    #[serde(with = "time::serde::rfc3339::option")]
    pub publish_at: Option<OffsetDateTime>,
    #[serde(with = "time::serde::rfc3339::option")]
    pub published_at: Option<OffsetDateTime>,
    pub url: Option<String>,
    pub status: RowStatus,
    /// A TikTok post that was sent to the creator's drafts, also once it reads `published`.
    pub tiktok_draft: bool,
    pub sub_state: Option<SubState>,
    pub progress: Progress,
    /// The first is the one shown.
    pub waits: Vec<Wait>,
    pub actions: RowActions,
    pub ai_illustration: bool,
    /// The other rows of the same content.
    pub siblings: Vec<Sibling>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct PostCounts {
    pub all: u32,
    pub you: u32,
    pub stages: BTreeMap<StageKey, u32>,
}

/// Where a special day's files are (§3.2.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DayFilesState {
    None,
    Analysing,
    NeedsPermission,
    Unchecked,
    Quality,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DayFiles {
    pub state: DayFilesState,
    pub material_ids: Vec<MaterialId>,
    /// Their revisions, in the same order, for `İzin ver` and `Yine de kullan`.
    pub permit: Vec<MaterialRef>,
    pub found: Vec<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SpecialDayLine {
    pub key: String,
    pub year: i32,
    pub name: String,
    #[serde(with = "jt_studio::time_compat::date")]
    pub window_start: Date,
    #[serde(with = "jt_studio::time_compat::date")]
    pub window_end: Date,
    #[serde(with = "jt_studio::time_compat::date")]
    pub prepares_from: Date,
    pub phase: super::views::DayPhase,
    pub shoot_request_id: Option<ShootRequestId>,
    pub can_add: bool,
    pub can_skip: bool,
    pub files: DayFiles,
}

/// A composer stop (§2.8): said before sending, never blocking it (D20).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Stop {
    pub code: &'static str,
    /// The next expected check-in of `agent_sleeps` and `agent_late`.
    #[serde(with = "time::serde::rfc3339::option")]
    pub at: Option<OffsetDateTime>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Connected {
    pub kind: String,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ComposerState {
    pub allowed: bool,
    pub files_allowed: bool,
    pub stops: Vec<Stop>,
    pub advice: Vec<&'static str>,
    pub connected: Vec<Connected>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct BrakeState {
    /// The control revision `studio.brake` needs.
    pub revision: u64,
    pub can_resume: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PostsOut {
    pub rows: Vec<PostRow>,
    pub next_cursor: Option<String>,
    pub counts: PostCounts,
    pub days: Vec<SpecialDayLine>,
    pub days_more: u32,
    pub composer: ComposerState,
    pub knowledge_empty: bool,
    pub brake: Option<BrakeState>,
    #[serde(with = "time::serde::rfc3339")]
    pub as_of: OffsetDateTime,
}

/// A person's cancellation of a post: who, when, why.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CancelFact {
    /// The person's name as the workspace knows it; empty when unknown.
    pub by_name: String,
    #[serde(with = "time::serde::rfc3339")]
    pub at: OffsetDateTime,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct PostDetail {
    pub row: PostRow,
    /// The whole caption; before delivery, the area's brief.
    pub text: String,
    pub materials: Vec<Cover>,
    pub redo_note: Option<String>,
    pub cancelled: Option<CancelFact>,
    /// `false` when no list holds the row any more (an archived content's, a cancelled
    /// version's, a retired post's): its `actions` are empty.
    pub listed: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostGetInput {
    pub row_id: String,
}

// ---------------------------------------------------------------------------------------------
// Words the server writes (titles before a caption exists)
// ---------------------------------------------------------------------------------------------

/// A platform's name as the owner reads it.
pub(crate) fn platform_name(kind: &str) -> &'static str {
    match kind {
        "instagram" => "Instagram",
        "facebook_page" => "Facebook",
        "x" => "X",
        "linkedin_page" | "linkedin_member" => "LinkedIn",
        "tiktok" => "TikTok",
        "youtube" => "YouTube",
        "pinterest" => "Pinterest",
        "google_business" => "Google",
        _ => "Hesap",
    }
}

fn format_word(f: PostFormat) -> &'static str {
    match f {
        PostFormat::Story => "Hikâye",
        PostFormat::FeedPost => "Gönderi",
        PostFormat::Carousel => "Kaydırmalı",
        PostFormat::Reel => "Reels",
        PostFormat::TiktokVideo => "Video",
    }
}

/// The first non-empty line of `text`, at most [`MAX_TITLE_CHARS`] characters.
pub(crate) fn first_line(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or_default();
    let mut out: String = line.chars().take(MAX_TITLE_CHARS).collect();
    if line.chars().count() > MAX_TITLE_CHARS {
        out.pop();
        out.push('…');
    }
    out
}

fn micros(at: OffsetDateTime) -> i64 {
    i64::try_from(at.unix_timestamp_nanos() / 1000).unwrap_or(i64::MAX)
}

// ---------------------------------------------------------------------------------------------
// The caller
// ---------------------------------------------------------------------------------------------

/// What the caller may do, read once from the session (§3.2.3: the read checks as the write will).
pub(crate) struct Viewer {
    perms: BTreeSet<Permission>,
    person: Option<UserId>,
    decider: bool,
}

impl Viewer {
    pub(crate) fn of(ctx: &Ctx) -> Self {
        Viewer {
            perms: ctx.permissions.clone(),
            person: library::person(ctx),
            decider: control::human_approver(ctx).is_ok(),
        }
    }

    fn has(&self, p: Permission) -> bool {
        self.perms.contains(&p)
    }

    fn any(&self, ps: &[Permission]) -> bool {
        ps.iter().any(|p| self.has(*p))
    }

    fn person(&self) -> bool {
        self.person.is_some()
    }
}

// ---------------------------------------------------------------------------------------------
// The facts, read once
// ---------------------------------------------------------------------------------------------

/// A file a person attached, as its pending wait sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum FileState {
    /// Its analysis is coming.
    Analysing,
    /// The analysis found people or marks.
    Found(Vec<&'static str>),
    /// Not checked for people: the analysis failed, was made without `sensitive_checked`, or no
    /// agent can analyse it.
    Unchecked,
    /// The analysis found it not publishable.
    Quality(Option<Quality>),
}

/// What a material shows that needs a person: the `found` words of the waits.
fn found_of(m: &Material) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = m
        .tags
        .depicts
        .iter()
        .map(|d| match d {
            Depicts::Face => "face",
            Depicts::Name => "name",
            Depicts::Child => "child",
            Depicts::ClientLogo => "logo",
            Depicts::CorporateRef => "company",
        })
        .collect();
    if !m.people.is_empty() && !out.contains(&"name") {
        out.push("name");
    }
    out
}

/// Where pending file `m` stands; `None` once it has its share (it is no longer pending).
pub(crate) fn file_state(
    m: &Material,
    i: &MaterialIntelligence,
    materials_agent: bool,
) -> Option<FileState> {
    if m.share.is_some() || m.erased_at.is_some() {
        return None;
    }
    Some(match i.status {
        AnalysisStatus::Completed => {
            let found = found_of(m);
            if !found.is_empty() {
                FileState::Found(found)
            } else if m.tags.quality != Some(Quality::Publishable) {
                FileState::Quality(m.tags.quality)
            } else {
                FileState::Unchecked
            }
        }
        AnalysisStatus::Failed => FileState::Unchecked,
        AnalysisStatus::Pending | AnalysisStatus::Running if !materials_agent => {
            FileState::Unchecked
        }
        AnalysisStatus::Pending | AnalysisStatus::Running => FileState::Analysing,
    })
}

/// Everything the rows are built from, read once in one bundle without a lock.
struct Facts {
    now: OffsetDateTime,
    knowledge_empty: bool,
    post_approval: bool,
    braked: bool,
    control_revision: u64,
    settings: PostingSettings,
    areas: Vec<ProductionProject>,
    /// Every planned post by slot.
    posts: BTreeMap<SlotId, PlannedPost>,
    /// The slots of no content to list (posts and weekly slots).
    loose: Vec<SlotId>,
    reads: PostReads,
    pieces: BTreeMap<SlotId, jt_studio::Piece>,
    materials: BTreeMap<MaterialId, Material>,
    intelligence: BTreeMap<MaterialId, MaterialIntelligence>,
    olays: BTreeMap<OlayId, jt_studio::Olay>,
    shoots: Vec<ShootRequest>,
    accounts: Vec<Capability>,
    postable: Vec<Capability>,
    /// Which slots the material gate holds now, with its findings.
    holds: BTreeMap<SlotId, Value>,
    /// Waiting versions' choices: by version id, (accounts, blocked).
    versions: BTreeMap<Uuid, (Vec<CapabilityId>, Option<&'static str>)>,
    content_agent: AgentReach,
    social_agent: AgentReach,
    materials_agent: AgentReach,
    lib: materials::Library,
    content_module: bool,
}

impl Facts {
    async fn read(
        d: &Deps,
        r: &mut dyn TenantRepos,
        now: OffsetDateTime,
    ) -> Result<Self, AppError> {
        let settings_k = r.knowledge().settings().await?;
        let frame = r.strategy().current_approved().await?;
        let knowledge_empty = match &settings_k {
            Some(_) => jt_knowledge::is_empty(&r.knowledge().cards().await?),
            None => frame.is_none(),
        };
        let post_approval = settings_k.as_ref().is_some_and(|k| k.post_approval);
        let control = r.studio_control().read_control().await?;
        let braked = control.is_braked(LaneKind::Organic);
        let settings = r.studio_posts().posting_settings().await?;
        let areas = r.studio_projects().list_live_areas().await?;
        let lib = materials::library(r, now).await?;
        // Every planned post; those of no content in the window, and the weekly slots of the
        // window that have no post.
        let all_posts = r.studio_posts().list_posts().await?;
        let request_keys: BTreeMap<_, String> = r
            .studio_posts()
            .list_package_requests()
            .await?
            .into_iter()
            .map(|q| (q.id, q.key))
            .collect();
        let from = now - Duration::days(POST_WINDOW_DAYS);
        let mut loose: Vec<SlotId> = all_posts
            .iter()
            .filter(|p| {
                p.publish_at >= from
                    && request_keys
                        .get(&p.package_request_id)
                        .is_none_or(|k| area_key(k).is_none())
            })
            .map(|p| p.slot_id)
            .collect();
        let posts: BTreeMap<SlotId, PlannedPost> =
            all_posts.into_iter().map(|p| (p.slot_id, p)).collect();
        let weekly = r
            .studio()
            .list_slots(SlotQuery {
                from,
                until: now + Duration::days(POST_WINDOW_DAYS),
                hypothesis_id: None,
                lane: Some(LaneKind::Organic),
            })
            .await?;
        loose.extend(
            weekly
                .iter()
                .filter(|s| !posts.contains_key(&s.id) && s.state != SlotState::Retired)
                .map(|s| s.id),
        );
        let mut slots: Vec<SlotId> = areas
            .iter()
            .flat_map(|p| p.posts().into_iter().map(|x| x.slot_id))
            .collect();
        slots.extend(loose.iter().copied());
        let reads = PostReads::load(r, &slots).await?;
        let wanted: Vec<(SlotId, u64)> = slots
            .iter()
            .filter_map(|id| reads.slot(*id).map(|s| (s.id, s.revision)))
            .collect();
        let pieces: BTreeMap<SlotId, jt_studio::Piece> =
            r.studio().get_pieces(&wanted).await?.into_iter().collect();
        // Every material a row may show or wait for.
        let mut ids: BTreeSet<MaterialId> = BTreeSet::new();
        for p in &areas {
            ids.extend(p.sources.iter().map(|s| s.material_id));
            ids.extend(p.pending_files.iter().copied());
            for k in &p.packages {
                for v in &k.versions {
                    ids.extend(v.material_ids.iter().copied());
                }
            }
        }
        for id in &slots {
            if let Some(p) = posts.get(id) {
                ids.extend(p.material_ids.iter().copied());
            }
        }
        let library_materials = r.studio_materials().list_materials().await?;
        // A need's and a day's pending files are found by what they were attached for.
        for m in &library_materials {
            if m.upload_for.is_some() && m.share.is_none() && m.erased_at.is_none() {
                ids.insert(m.id);
            }
        }
        let materials: BTreeMap<MaterialId, Material> = library_materials
            .into_iter()
            .filter(|m| ids.contains(&m.id) || m.olay_id().is_some())
            .map(|m| (m.id, m))
            .collect();
        let rows: BTreeMap<MaterialId, _> = r
            .studio_materials()
            .list_intelligence()
            .await?
            .into_iter()
            .map(|row| (row.material_id, row))
            .collect();
        let intelligence = materials
            .values()
            .map(|m| (m.id, library::intelligence_of(m, rows.get(&m.id), now)))
            .collect();
        let olays = lib.olays.iter().map(|o| (o.id, o.clone())).collect();
        let shoots = r
            .studio_materials()
            .list_shoot_requests()
            .await?
            .into_iter()
            .filter(|q| q.status == ShootStatus::Open)
            .collect();
        let accounts: Vec<Capability> = r
            .capabilities()
            .list(Default::default())
            .await?
            .into_iter()
            .filter(|c| chain::ORGANIC_KINDS.contains(&c.kind_key.as_str()))
            .collect();
        let postable: Vec<Capability> = accounts
            .iter()
            .filter(|c| studio_posts::postable(d, c, now))
            .cloned()
            .collect();
        // The material gate of the ready, never-attempted posts (as `studio.pending` checks).
        let mut holds = BTreeMap::new();
        for id in &slots {
            let Some(s) = reads.slot(*id) else { continue };
            if s.state == SlotState::Ready && reads.attempts(s.id).is_empty() {
                let s = s.clone();
                if let Err(e) = materials::publish_check(r, &s, now.max(s.scheduled_at)).await {
                    if e.code == crate::error::ErrorCode::Internal {
                        return Err(e);
                    }
                    holds.insert(s.id, e.details["findings"].clone());
                }
            }
        }
        // The versions waiting for a time, with the accounts each can go out on.
        let mut versions = BTreeMap::new();
        if areas.iter().any(|p| p.waiting_versions().next().is_some()) {
            let reader = VersionAccounts::load(d, r, now).await?;
            for p in &areas {
                for v in p.waiting_versions() {
                    let (choices, blocked) = reader.of_known(d, r, p, v, &materials, now).await?;
                    versions.insert(
                        v.id,
                        (choices.iter().map(|c| c.capability_id).collect(), blocked),
                    );
                }
            }
        }
        let reach = wake::takers(r, now, &[wake::CONTENT, wake::SOCIAL, wake::MATERIALS]).await?;
        let registry = r.workspace().module_registry().await?;
        let content_module = crate::usecases::modules::installed_in(
            registry.as_ref(),
            crate::usecases::modules::CONTENT,
        )?;
        Ok(Facts {
            now,
            knowledge_empty,
            post_approval,
            braked,
            control_revision: control.revision,
            settings,
            areas,
            posts,
            loose,
            reads,
            pieces,
            materials,
            intelligence,
            olays,
            shoots,
            accounts,
            postable,
            holds,
            versions,
            content_agent: reach[0],
            social_agent: reach[1],
            materials_agent: reach[2],
            lib,
            content_module,
        })
    }

    fn agent_takes(reach: &AgentReach) -> bool {
        reach.state != ReachState::None
    }

    fn category(&self, olay: Option<OlayId>) -> Category {
        match olay.and_then(|id| self.olays.get(&id)) {
            Some(o) => Category {
                olay_id: Some(o.id),
                title: o.title.clone(),
            },
            None => Category {
                olay_id: None,
                title: "Genel".into(),
            },
        }
    }

    fn channel(&self, id: CapabilityId) -> Option<ChannelRef> {
        let c = self
            .accounts
            .iter()
            .find(|c| c.id == id)
            .or_else(|| self.reads.account(id))?;
        let platform = platform_name(&c.kind_key);
        let shared = self
            .accounts
            .iter()
            .filter(|o| platform_name(&o.kind_key) == platform)
            .count()
            > 1;
        Some(ChannelRef {
            capability_id: c.id,
            kind: c.kind_key.clone(),
            name: c.name.clone(),
            label: if shared {
                format!("{platform} · {}", c.name)
            } else {
                platform.to_owned()
            },
        })
    }

    fn file_state(&self, id: MaterialId) -> Option<(&Material, FileState)> {
        let m = self.materials.get(&id)?;
        let i = self.intelligence.get(&id)?;
        file_state(m, i, Self::agent_takes(&self.materials_agent)).map(|s| (m, s))
    }

    fn media(&self, ids: &[MaterialId]) -> Option<MediaSummary> {
        if ids.is_empty() {
            return None;
        }
        let shown: Vec<&Material> = ids.iter().filter_map(|id| self.materials.get(id)).collect();
        let videos = shown
            .iter()
            .filter(|m| m.mime.starts_with("video/"))
            .count();
        Some(MediaSummary {
            images: u8::try_from(shown.len() - videos).unwrap_or(u8::MAX),
            video_seconds: None,
        })
    }

    fn ai(&self, ids: &[MaterialId]) -> bool {
        ids.iter()
            .filter_map(|id| self.materials.get(id))
            .any(|m| matches!(m.origin, Origin::AiGenerated { .. }))
    }
}

// ---------------------------------------------------------------------------------------------
// Building the rows
// ---------------------------------------------------------------------------------------------

/// A row with what orders it, before the cover is signed.
struct Built {
    row: PostRow,
    /// The materials it shows, in order (the cover is the first).
    shows: Vec<MaterialId>,
    /// When the area was made (the order of `preparing` rows).
    area_at: Option<OffsetDateTime>,
    /// When a failed post failed.
    failed_at: Option<OffsetDateTime>,
    text: String,
    redo_note: Option<String>,
    cancelled: Option<VersionCancel>,
}

fn wait(code: WaitCode, since: OffsetDateTime, facts: Value) -> Wait {
    Wait { code, since, facts }
}

/// The stage of a reported workflow step (§2.5).
fn step_stage(step: u8) -> u8 {
    match step {
        0..=3 => 0,
        4..=6 => 1,
        7..=8 => 2,
        9..=10 => 3,
        _ => 4,
    }
}

/// The waits a pending file gives, its material ref, and whether it is only analysing.
fn file_waits(
    f: &Facts,
    ids: &[MaterialId],
    since_floor: OffsetDateTime,
    waits: &mut Vec<Wait>,
    permit: &mut Vec<MaterialRef>,
) -> bool {
    let mut analysing = false;
    let mut found: Vec<&'static str> = Vec::new();
    let mut unchecked: Vec<MaterialId> = Vec::new();
    let mut quality: Vec<(MaterialId, Option<Quality>)> = Vec::new();
    let mut since = None::<OffsetDateTime>;
    for id in ids {
        let Some((m, state)) = f.file_state(*id) else {
            continue;
        };
        match state {
            FileState::Analysing => {
                analysing = true;
                continue;
            }
            FileState::Found(words) => {
                for w in words {
                    if !found.contains(&w) {
                        found.push(w);
                    }
                }
                unchecked.push(m.id);
            }
            FileState::Unchecked => unchecked.push(m.id),
            FileState::Quality(q) => quality.push((m.id, q)),
        }
        since = Some(since.map_or(m.created_at, |s: OffsetDateTime| s.min(m.created_at)));
        permit.push(MaterialRef {
            material_id: m.id,
            expected_revision: m.revision,
        });
    }
    let since = since.unwrap_or(since_floor);
    if !unchecked.is_empty() {
        waits.push(wait(
            WaitCode::FilesPermission,
            since,
            json!({"found": found, "material_ids": unchecked}),
        ));
    }
    if !quality.is_empty() {
        waits.push(wait(
            WaitCode::FilesQuality,
            since,
            json!({"finding": quality[0].1.map(|q| match q {
                        Quality::Publishable => "publishable",
                        Quality::NeedsCrop => "needs_crop",
                        Quality::Unusable => "unusable",
                    }).unwrap_or("unset"),
                   "material_ids": quality.iter().map(|(id, _)| *id).collect::<Vec<_>>()}),
        ));
    }
    analysing && waits.is_empty()
}

/// The sub-state of a queued content (§2.4).
fn queued(f: &Facts, p: &ProductionProject) -> Option<SubState> {
    let now = f.now;
    if p.claim.as_ref().is_some_and(|c| c.lease_until > now) {
        let step = p.progress.as_ref().map_or(1, |g| g.step);
        return Some(SubState::Claimed {
            stage: STAGES[usize::from(step_stage(step))].0,
        });
    }
    if p.starts_at() > now {
        return Some(SubState::Starts { at: p.starts_at() });
    }
    match f.content_agent.state {
        ReachState::None => None,
        ReachState::Ok => Some(SubState::Queued {
            wakes_now: true,
            next_at: None,
            late: false,
        }),
        ReachState::Asleep | ReachState::Late => Some(SubState::Queued {
            wakes_now: false,
            next_at: f.content_agent.next_at,
            late: f.content_agent.state == ReachState::Late,
        }),
    }
}

/// The `content` row of area `p`, whose current package is not finished.
fn content_row(f: &Facts, v: &Viewer, p: &ProductionProject) -> Built {
    let now = f.now;
    let state = p.state(now);
    let mut waits = Vec::new();
    let mut actions = RowActions::default();
    if state == AreaState::Held {
        let first = p
            .refusal
            .as_ref()
            .and_then(|x| x.findings.as_array().and_then(|a| a.first().cloned()))
            .and_then(|x| x["findings"].as_array().and_then(|a| a.first().cloned()));
        waits.push(wait(
            WaitCode::DeliveryHeld,
            p.refusal.as_ref().map_or(p.updated_at, |x| x.at),
            json!({"finding": first.as_ref().map(|x| x["code"].clone())}),
        ));
        // Releasable when only the text check holds it (`content.delivery_accept` checks again).
        let text_only = p
            .refusal
            .as_ref()
            .is_some_and(|x| super::delivery::releasable(&x.findings));
        if text_only && v.person() && v.has(Permission::ContentManage) {
            actions.accept_held = Some(AreaRef {
                project_id: p.id,
                expected_revision: p.revision,
            });
        }
    }
    let open: Vec<&ProjectMaterialRequest> = p
        .requests
        .iter()
        .filter(|q| q.status == RequestStatus::Open)
        .collect();
    for q in &open {
        waits.push(wait(
            WaitCode::Capture,
            q.created_at,
            json!({"request": q.text, "request_id": q.id}),
        ));
    }
    let decider_files = v.decider && v.has(Permission::MaterialsWork);
    if let Some(q) = open.first() {
        if decider_files && v.any(&[Permission::ContentWork, Permission::ContentManage]) {
            actions.add_files = Some(FilesTarget::Capture {
                project_id: p.id,
                request_id: q.id,
            });
        }
        if v.any(&[Permission::ContentWork, Permission::ContentManage]) {
            actions.dismiss = Some(DismissRef::Capture {
                project_id: p.id,
                request_id: q.id,
                expected_revision: p.revision,
            });
        }
    }
    let mut permit = Vec::new();
    let analysing = file_waits(f, &p.pending_files, p.created_at, &mut waits, &mut permit);
    if decider_files {
        actions.permit_files = permit;
    }
    if f.knowledge_empty {
        waits.push(wait(WaitCode::KnowledgeEmpty, p.created_at, json!({})));
    }
    if state == AreaState::Queued && !Facts::agent_takes(&f.content_agent) {
        waits.push(wait(WaitCode::NoAgent, p.created_at, json!({})));
    }
    let files_wait = waits
        .iter()
        .any(|w| matches!(w.code, WaitCode::Capture | WaitCode::FilesPermission));
    let progress = if state == AreaState::Held {
        Progress::at(4, StageState::Problem)
    } else if files_wait || state == AreaState::WaitingMaterial {
        Progress::at(3, StageState::WaitingPerson)
    } else {
        let step = p
            .steps
            .last()
            .map(|s| s.step)
            .or(p.progress.as_ref().map(|g| g.step));
        Progress::at(step.map_or(0, step_stage), StageState::Current)
    };
    let status = if p.redo.is_some() {
        RowStatus::Revising
    } else if !waits.is_empty() {
        RowStatus::WaitingYou
    } else {
        RowStatus::Preparing
    };
    let sub_state = if analysing {
        Some(SubState::FilesAnalysing)
    } else if status == RowStatus::Preparing && state != AreaState::WaitingMaterial {
        queued(f, p)
    } else {
        None
    };
    if v.person() && v.has(Permission::ContentManage) {
        actions.redo = Some(RedoRef {
            project_id: p.id,
            package_revision: p.packages.last().map(|k| k.revision),
        });
        actions.cancel = Some(CancelRef::Content {
            project_id: p.id,
            expected_revision: p.revision,
        });
    }
    let shows: Vec<MaterialId> = p.sources.iter().map(|s| s.material_id).collect();
    let channel = match p.hints.capability_ids.as_slice() {
        [one] => f.channel(*one),
        _ => None,
    };
    Built {
        row: PostRow {
            id: format!("content:{}", p.id),
            kind: RowKind::Content,
            area_id: Some(p.id),
            version_id: None,
            slot_id: None,
            shoot_request_id: None,
            title: first_line(&p.title),
            cover: None,
            channel,
            format: p.hints.formats.first().copied(),
            media: f.media(&shows),
            category: f.category(p.olay_id),
            publish_at: None,
            published_at: None,
            url: None,
            status,
            tiktok_draft: false,
            sub_state,
            progress,
            waits,
            actions,
            ai_illustration: f.ai(&shows),
            siblings: Vec::new(),
        },
        shows,
        area_at: Some(p.created_at),
        failed_at: None,
        text: p.brief.clone(),
        redo_note: p.redo.as_ref().map(|x| x.note.clone()),
        cancelled: None,
    }
}

/// Why a post failed, in the codes of §2.6, and whether its account posts again.
fn failure(f: &Facts, fact: &VersionFact) -> (&'static str, bool) {
    let slot = fact.publication.slot_id;
    if fact.publication.retirement == Some(RetirementReason::MissedGrace) {
        return ("missed_grace", false);
    }
    let reason = f
        .reads
        .attempts(slot)
        .iter()
        .filter_map(|a| match a.outcome() {
            Some(PublishOutcome::Refused(_)) => Some("refused"),
            Some(PublishOutcome::Failed(e)) => Some(
                match crate::usecases::failure::publish_category(*e, a.failure_reason()) {
                    // Before the kinds: reconnecting fixes neither (the account is not at fault).
                    RedactedPublishError::AppNotAudited => "app_not_audited",
                    RedactedPublishError::MediaUnfetched => "media_unfetched",
                    RedactedPublishError::Auth => "auth",
                    RedactedPublishError::Permission => "permission",
                    RedactedPublishError::Throttle => "rate_limited",
                    RedactedPublishError::Permanent | RedactedPublishError::Policy => "validation",
                    _ => "unreachable",
                },
            ),
            _ => None,
        })
        .next()
        .unwrap_or("unreachable");
    let recovered = matches!(reason, "auth" | "permission")
        && f.postable
            .iter()
            .any(|c| c.id == fact.publication.capability_id);
    (reason, recovered)
}

/// The `post` row of planned post `fact`, of area `area` (none for a post of no content).
fn post_row(
    f: &Facts,
    v: &Viewer,
    area: Option<&ProductionProject>,
    version: Option<&PackageVersion>,
    fact: &VersionFact,
) -> Option<Built> {
    let now = f.now;
    let slot_id = fact.publication.slot_id;
    let slot: &Slot = f.reads.slot(slot_id)?;
    let post = f.posts.get(&slot_id);
    let published_at = fact.publication.published_at;
    let failed = fact.publication.failed;
    // A retired post that never went out is history, not a row.
    if slot.state == SlotState::Retired && published_at.is_none() && !failed {
        return None;
    }
    let screen = fact.approval.posting_screen;
    let draft = screen
        && f.reads
            .receipt(slot_id)
            .and_then(|a| a.tiktok.as_ref())
            .is_some_and(|t| t.is_draft());
    let acknowledged = post.and_then(|p| p.acknowledged);
    let attempts = f.reads.attempts(slot_id);
    let cap = fact.publication.capability_id;
    let account = f
        .accounts
        .iter()
        .find(|c| c.id == cap)
        .or_else(|| f.reads.account(cap));
    let account_name = account.map(|c| c.name.clone());
    let kind = account.map(|c| c.kind_key.clone());
    let created = post.map_or(slot.scheduled_at, |p| p.created_at);
    let mut waits = Vec::new();
    let mut actions = RowActions::default();
    let unsent = matches!(slot.state, SlotState::Planned | SlotState::Ready) && attempts.is_empty();
    let manage_post = v.person() && v.any(&[Permission::SocialManage, Permission::ContentManage]);
    let (status, progress) = if let Some(at) = published_at.filter(|_| draft) {
        let open = acknowledged.is_none() && at + Duration::days(RECENT_DAYS) > now;
        if open {
            waits.push(wait(
                WaitCode::TiktokDraft,
                at,
                json!({"account": account_name}),
            ));
            if manage_post {
                actions.acknowledge = Some(SlotRef {
                    slot_id,
                    expected_revision: slot.revision,
                });
            }
            (
                RowStatus::TiktokDraft,
                Progress::at(6, StageState::WaitingPerson),
            )
        } else {
            (RowStatus::Published, Progress::at(7, StageState::Done))
        }
    } else if published_at.is_some() {
        let measured = matches!(slot.state, SlotState::Measured | SlotState::Retired);
        (
            RowStatus::Published,
            Progress::at(
                7,
                if measured {
                    StageState::Done
                } else {
                    StageState::Current
                },
            ),
        )
    } else if failed {
        let (reason, recovered) = failure(f, fact);
        // A content's failed post waits until the owner acts on it or lets it go; once a redo
        // stands, or for a post of no content, it waits for nothing (D26).
        let waiting = area.is_some_and(|p| p.redo.is_none()) && acknowledged.is_none();
        if waiting {
            // An unaudited refusal is answered with a draft, which needs the draft grant: without
            // it the account is reconnected first.
            let drafts = account.is_some_and(crate::usecases::studio::tiktok::drafts_granted);
            waits.push(wait(
                WaitCode::Failed,
                slot.scheduled_at,
                json!({"account": account_name, "kind": kind, "reason": reason,
                       "recovered": recovered, "drafts": drafts}),
            ));
            if manage_post {
                actions.acknowledge = Some(SlotRef {
                    slot_id,
                    expected_revision: slot.revision,
                });
            }
            if (matches!(reason, "auth" | "permission") && !recovered
                || reason == "app_not_audited" && !drafts)
                && v.has(Permission::CapabilitiesManage)
            {
                actions.reconnect = Some(cap);
            }
        }
        (RowStatus::Failed, Progress::at(6, StageState::Problem))
    } else {
        if fact.approval.waiting {
            let code = if screen {
                WaitCode::PostingScreen
            } else {
                WaitCode::Approval
            };
            waits.push(wait(
                code,
                created,
                json!({"account": account_name, "kind": kind}),
            ));
            let approver = v.person()
                && v.decider
                && v.any(&[Permission::SocialManage, Permission::AdsManage]);
            let target = Some(SlotRef {
                slot_id,
                expected_revision: slot.revision,
            });
            if screen && approver && v.has(Permission::SocialManage) {
                actions.tiktok = target;
            } else if !screen && approver {
                actions.approve = target;
            }
        }
        if let Some(findings) = f.holds.get(&slot_id) {
            let codes: Vec<&str> = findings
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|x| x["code"].as_str())
                .collect();
            let sensitive = codes
                .iter()
                .any(|c| matches!(*c, "sensitive_needs_human" | "share_unset"));
            if sensitive {
                let ids: Vec<MaterialId> = post.map(|p| p.material_ids.clone()).unwrap_or_default();
                let mut permit = Vec::new();
                let mut unshared = Vec::new();
                let mut found = Vec::new();
                for id in &ids {
                    if let Some(m) = f.materials.get(id)
                        && (m.share.is_none()
                            || (m.needs_human_permission()
                                && m.share.as_ref().is_some_and(|s| s.by.is_none())))
                    {
                        for w in found_of(m) {
                            if !found.contains(&w) {
                                found.push(w);
                            }
                        }
                        unshared.push(m.id);
                        permit.push(MaterialRef {
                            material_id: m.id,
                            expected_revision: m.revision,
                        });
                    }
                }
                waits.push(wait(
                    WaitCode::FilesPermission,
                    created,
                    json!({"found": found, "material_ids": unshared}),
                ));
                if v.decider && v.has(Permission::MaterialsWork) {
                    actions.permit_files = permit;
                }
            } else {
                waits.push(wait(
                    WaitCode::CheckHold,
                    created,
                    json!({"finding": codes.first()}),
                ));
                if materials::hold_next_action(findings) == "fix_piece_or_release"
                    && v.person()
                    && v.decider
                {
                    actions.release_check = Some(SlotRef {
                        slot_id,
                        expected_revision: slot.revision,
                    });
                }
            }
        }
        if unsent && f.settings.paused_capability_ids.contains(&cap) {
            waits.push(wait(
                WaitCode::AccountPaused,
                created,
                json!({"account": account_name, "kind": kind}),
            ));
            if v.has(Permission::SocialManage) && v.decider {
                actions.resume_account = Some(AccountRef {
                    capability_id: cap,
                    expected_revision: f.settings.revision,
                });
            }
        } else if unsent && account.is_none_or(|c| chain::capability_access(c, now, true).is_err())
        {
            waits.push(wait(
                WaitCode::AccountUnavailable,
                created,
                json!({"account": account_name, "kind": kind}),
            ));
            if v.has(Permission::CapabilitiesManage) {
                actions.reconnect = Some(cap);
            }
        }
        if let Some(w) = waits.first() {
            let progress = match w.code {
                WaitCode::Approval | WaitCode::PostingScreen => {
                    Progress::at(5, StageState::WaitingPerson)
                }
                _ => Progress::at(6, StageState::WaitingPerson),
            };
            (RowStatus::WaitingYou, progress)
        } else if f.braked {
            (RowStatus::Paused, Progress::at(6, StageState::Current))
        } else {
            (RowStatus::Scheduled, Progress::at(6, StageState::Current))
        }
    };
    if unsent && manage_post {
        actions.cancel = Some(CancelRef::Post {
            slot_id,
            expected_revision: slot.revision,
        });
    }
    if let Some(p) = area.filter(|p| !p.archived)
        && v.person()
        && v.has(Permission::ContentManage)
    {
        actions.redo = Some(RedoRef {
            project_id: p.id,
            package_revision: p.packages.last().map(|k| k.revision),
        });
    }
    // The caption that goes out: the slot's piece, else the version's.
    let text = f
        .pieces
        .get(&slot_id)
        .map(|x| x.text.clone())
        .or_else(|| version.map(caption))
        .unwrap_or_default();
    let format = post.map(|p| p.format).or(version.map(|v| v.format));
    let title = match first_line(&text) {
        t if !t.is_empty() => t,
        _ => format!(
            "{} · {}",
            format.map_or("Paylaşım", format_word),
            kind.as_deref().map_or("Hesap", platform_name)
        ),
    };
    let shows: Vec<MaterialId> = post
        .map(|p| p.material_ids.clone())
        .or(version.map(|v| v.material_ids.clone()))
        .unwrap_or_default();
    let olay = post
        .and_then(|p| p.olay_id)
        .or(area.and_then(|p| p.olay_id));
    let failed_at = failed.then_some(slot.scheduled_at);
    Some(Built {
        row: PostRow {
            id: format!("slot:{}", slot_id),
            kind: RowKind::Post,
            area_id: area.map(|p| p.id),
            version_id: version.map(|v| v.id),
            slot_id: Some(slot_id),
            shoot_request_id: None,
            title,
            cover: None,
            channel: f.channel(cap),
            format,
            media: f.media(&shows),
            category: f.category(olay),
            publish_at: Some(slot.scheduled_at),
            published_at,
            url: fact.publication.url.clone(),
            status,
            tiktok_draft: draft,
            sub_state: None,
            progress,
            waits,
            actions,
            ai_illustration: f.ai(&shows),
            siblings: Vec::new(),
        },
        shows,
        area_at: area.map(|p| p.created_at),
        failed_at,
        text,
        redo_note: area.and_then(|p| p.redo.as_ref().map(|x| x.note.clone())),
        cancelled: version.and_then(|v| v.cancelled.clone()),
    })
}

/// The `version` row of version `ver` of area `p`'s finished package, waiting for a time.
fn version_row(f: &Facts, v: &Viewer, p: &ProductionProject, ver: &PackageVersion) -> Built {
    let (accounts, blocked) = f
        .versions
        .get(&ver.id)
        .cloned()
        .unwrap_or((Vec::new(), Some("knowledge_empty")));
    let since = p.packages.last().map_or(p.updated_at, |k| k.delivered_at);
    let own = ver.capability_id.and_then(|id| f.channel(id));
    let mut waits = Vec::new();
    let mut actions = RowActions::default();
    let mut status = RowStatus::Scheduling;
    let mut progress = Progress::at(5, StageState::Current);
    let facts = json!({"account": own.as_ref().map(|c| c.name.clone()),
                       "kind": own.as_ref().map(|c| c.kind.clone())});
    match blocked {
        Some("braked") => status = RowStatus::Paused,
        Some("hypothesis_does_not_post") => {}
        Some(code) => {
            let code = match code {
                "material_removed" => WaitCode::MaterialRemoved,
                "knowledge_empty" => WaitCode::KnowledgeEmpty,
                "no_connected_account" => WaitCode::NoAccount,
                "its_account_unavailable" => WaitCode::AccountUnavailable,
                "account_paused" => WaitCode::AccountPaused,
                "format_not_supported"
                    if !f.postable.iter().any(|c| {
                        jt_studio::supported_formats(&c.kind_key).contains(&ver.format)
                    }) =>
                {
                    WaitCode::NoAccountForPlatform
                }
                _ => WaitCode::Media,
            };
            let mut facts = facts.clone();
            if code == WaitCode::NoAccountForPlatform {
                // The platform that takes this format.
                facts["kind"] = json!(
                    chain::ORGANIC_KINDS
                        .iter()
                        .find(|k| jt_studio::supported_formats(k).contains(&ver.format))
                );
            }
            waits.push(wait(code, since, facts));
            progress = Progress::at(5, StageState::Problem);
            status = RowStatus::WaitingYou;
            match code {
                WaitCode::NoAccount | WaitCode::NoAccountForPlatform => {
                    actions.connect = v.has(Permission::CapabilitiesManage);
                }
                WaitCode::AccountUnavailable => {
                    if v.has(Permission::CapabilitiesManage) {
                        actions.reconnect = ver.capability_id;
                    }
                }
                WaitCode::AccountPaused => {
                    let paused = ver.capability_id.or_else(|| {
                        f.postable
                            .iter()
                            .find(|c| f.settings.paused_capability_ids.contains(&c.id))
                            .map(|c| c.id)
                    });
                    if let Some(id) = paused
                        && v.has(Permission::SocialManage)
                        && v.decider
                    {
                        actions.resume_account = Some(AccountRef {
                            capability_id: id,
                            expected_revision: f.settings.revision,
                        });
                    }
                }
                _ => {}
            }
        }
        None => {
            if !Facts::agent_takes(&f.social_agent) {
                waits.push(wait(WaitCode::PickTime, since, json!({})));
                status = RowStatus::WaitingYou;
            }
            if v.has(Permission::SocialWork) {
                actions.pick_time = Some(PickRef {
                    project_id: p.id,
                    version_id: ver.id,
                    accounts: accounts.clone(),
                });
            }
        }
    }
    if v.person() {
        if let Some(k) = p.packages.last()
            && v.any(&[Permission::ContentManage, Permission::SocialManage])
        {
            actions.cancel = Some(CancelRef::Version {
                project_id: p.id,
                version_id: ver.id,
                package_revision: k.revision,
            });
        }
        if v.has(Permission::ContentManage) {
            actions.redo = Some(RedoRef {
                project_id: p.id,
                package_revision: p.packages.last().map(|k| k.revision),
            });
        }
    }
    let text = caption(ver);
    let title = match first_line(&text) {
        t if !t.is_empty() => t,
        _ => first_line(&p.title),
    };
    Built {
        row: PostRow {
            id: format!("version:{}", ver.id),
            kind: RowKind::Version,
            area_id: Some(p.id),
            version_id: Some(ver.id),
            slot_id: None,
            shoot_request_id: None,
            title,
            cover: None,
            channel: own,
            format: Some(ver.format),
            media: f.media(&ver.material_ids),
            category: f.category(p.olay_id),
            publish_at: None,
            published_at: None,
            url: None,
            status,
            tiktok_draft: false,
            sub_state: None,
            progress,
            waits,
            actions,
            ai_illustration: f.ai(&ver.material_ids),
            siblings: Vec::new(),
        },
        shows: ver.material_ids.clone(),
        area_at: Some(p.created_at),
        failed_at: None,
        text,
        redo_note: p.redo.as_ref().map(|x| x.note.clone()),
        cancelled: None,
    }
}

/// The files attached to need `q` that wait for their share.
fn need_files(f: &Facts, q: &ShootRequest) -> Vec<MaterialId> {
    f.materials
        .values()
        .filter(|m| {
            m.share.is_none()
                && m.erased_at.is_none()
                && m.upload_for
                    .as_ref()
                    .is_some_and(|u| u.shoot_request_id == Some(q.id))
        })
        .map(|m| m.id)
        .collect()
}

/// The `need` row of open request `q` of the çekim listesi.
fn need_row(f: &Facts, v: &Viewer, q: &ShootRequest) -> Built {
    let mut waits = Vec::new();
    let mut actions = RowActions::default();
    let mut permit = Vec::new();
    let files = need_files(f, q);
    let analysing = file_waits(f, &files, q.created_at, &mut waits, &mut permit);
    if files.is_empty() {
        waits.push(wait(
            WaitCode::NeedPhoto,
            q.created_at,
            json!({"request": q.text}),
        ));
    }
    if v.decider && v.has(Permission::MaterialsWork) {
        actions.add_files = Some(FilesTarget::Need {
            shoot_request_id: q.id,
        });
        actions.permit_files = permit;
    }
    if v.person() && v.has(Permission::MaterialsWork) {
        actions.dismiss = Some(DismissRef::Need {
            shoot_request_id: q.id,
        });
    }
    let status = if waits.is_empty() {
        RowStatus::Preparing
    } else {
        RowStatus::WaitingYou
    };
    let olay = match &q.reason {
        ShootReason::OlayUpcoming { olay_id } => Some(*olay_id),
        _ => None,
    };
    Built {
        row: PostRow {
            id: format!("need:{}", q.id),
            kind: RowKind::Need,
            area_id: None,
            version_id: None,
            slot_id: None,
            shoot_request_id: Some(q.id),
            title: first_line(&q.text),
            cover: None,
            channel: None,
            format: None,
            media: None,
            category: f.category(olay),
            publish_at: None,
            published_at: None,
            url: None,
            status,
            tiktok_draft: false,
            sub_state: analysing.then_some(SubState::FilesAnalysing),
            progress: Progress::at(3, StageState::WaitingPerson),
            waits,
            actions,
            ai_illustration: false,
            siblings: Vec::new(),
        },
        shows: files,
        area_at: Some(q.created_at),
        failed_at: None,
        text: q.text.clone(),
        redo_note: None,
        cancelled: None,
    }
}

/// Every row of area `p`: its content row while it is being made, its finished package's
/// versions and posts, and the posts of earlier packages that went out.
fn area_rows(f: &Facts, v: &Viewer, p: &ProductionProject) -> Vec<Built> {
    let mut out = Vec::new();
    let done = p.done_at().is_some();
    if !done {
        out.push(content_row(f, v, p));
    }
    let versions: BTreeMap<Uuid, &PackageVersion> = p
        .packages
        .iter()
        .flat_map(|k| k.versions.iter())
        .map(|ver| (ver.id, ver))
        .collect();
    for post in p.posts() {
        for fact in f.reads.facts(&[post]) {
            if let Some(b) = post_row(
                f,
                v,
                Some(p),
                versions.get(&post.version_id).copied(),
                &fact,
            ) {
                out.push(b);
            }
        }
    }
    if done {
        for ver in p.waiting_versions().filter(|ver| ver.cancelled.is_none()) {
            out.push(version_row(f, v, p, ver));
        }
    }
    // Siblings: the other rows of the same content.
    let all: Vec<Sibling> = out
        .iter()
        .map(|b| Sibling {
            row_id: b.row.id.clone(),
            channel: b.row.channel.clone(),
            publish_at: b.row.publish_at,
            status: b.row.status,
        })
        .collect();
    for b in &mut out {
        b.row.siblings = all
            .iter()
            .filter(|s| s.row_id != b.row.id)
            .cloned()
            .collect();
    }
    out
}

/// The special days of §2.7.5, sorted by `prepares_from`, and the `season:` request keys of
/// each (whose need rows they replace).
fn day_lines(f: &Facts, v: &Viewer, policy_lead: u16) -> (Vec<SpecialDayLine>, BTreeSet<String>) {
    let today = istanbul_day(f.now);
    let mut lines = Vec::new();
    let season_year = |o: &jt_studio::Olay| {
        o.occasion
            .as_deref()
            .and_then(|k| f.lib.calendar.season_year(k, o.starts_on))
    };
    for e in &f.lib.calendar.entries {
        let Some((start, end)) = e.window() else {
            continue;
        };
        let prepares_from = start - Duration::days(i64::from(e.lead_days.unwrap_or(policy_lead)));
        if end < today || prepares_from > today + Duration::days(DAY_LINE_DAYS) {
            continue;
        }
        let olays: Vec<&jt_studio::Olay> = f
            .lib
            .olays
            .iter()
            .filter(|o| {
                o.is_confirmed()
                    && o.occasion.as_deref() == Some(e.key.as_str())
                    && season_year(o) == Some(e.year)
            })
            .collect();
        let at = f.now.max(studio_posts::istanbul_noon(start));
        let cx = f.lib.context(at);
        let usable = olays.iter().any(|o| {
            let subject = Subject::Olay { olay_id: o.id };
            f.materials.values().any(|m| {
                // A drawn slide never stands for the season's own photos.
                m.olay_id() == Some(o.id)
                    && m.composition.is_none()
                    && check_use(m, UseRole::Anchor, &subject, &cx).is_ok()
            })
        });
        if usable {
            continue;
        }
        let key = jt_studio::season_request_key(&e.key, e.year);
        let pending: Vec<&Material> = f
            .materials
            .values()
            .filter(|m| {
                m.share.is_none()
                    && m.erased_at.is_none()
                    && m.upload_for
                        .as_ref()
                        .and_then(|u| u.day.as_ref())
                        .is_some_and(|d| d.key == e.key && d.year == e.year)
            })
            .collect();
        let mut state = DayFilesState::None;
        let mut found: Vec<&'static str> = Vec::new();
        for m in &pending {
            let next = match f.file_state(m.id).map(|(_, s)| s) {
                Some(FileState::Found(words)) => {
                    for w in words {
                        if !found.contains(&w) {
                            found.push(w);
                        }
                    }
                    DayFilesState::NeedsPermission
                }
                Some(FileState::Unchecked) => DayFilesState::Unchecked,
                Some(FileState::Quality(_)) => DayFilesState::Quality,
                Some(FileState::Analysing) => DayFilesState::Analysing,
                None => continue,
            };
            let rank = |s: DayFilesState| match s {
                DayFilesState::NeedsPermission => 4,
                DayFilesState::Unchecked => 3,
                DayFilesState::Quality => 2,
                DayFilesState::Analysing => 1,
                DayFilesState::None => 0,
            };
            if rank(next) > rank(state) {
                state = next;
            }
        }
        lines.push(SpecialDayLine {
            key: e.key.clone(),
            year: e.year,
            name: e.name.clone(),
            window_start: start,
            window_end: end,
            prepares_from,
            phase: if start <= today {
                super::views::DayPhase::Open
            } else if prepares_from <= today {
                super::views::DayPhase::Preparing
            } else {
                super::views::DayPhase::Ahead
            },
            shoot_request_id: f.shoots.iter().find(|q| q.key == key).map(|q| q.id),
            can_add: v.decider && v.has(Permission::MaterialsWork),
            can_skip: v.decider && v.any(&[Permission::ContentWork, Permission::MaterialsWork]),
            files: DayFiles {
                state,
                material_ids: pending.iter().map(|m| m.id).collect(),
                permit: pending
                    .iter()
                    .map(|m| MaterialRef {
                        material_id: m.id,
                        expected_revision: m.revision,
                    })
                    .collect(),
                found,
            },
        });
    }
    lines.sort_by(|a, b| (a.prepares_from, &a.key).cmp(&(b.prepares_from, &b.key)));
    // Only a day shown as a line replaces its çekim listesi request; the days folded into
    // `days_more` keep their need rows (§3.2.4).
    let keys = lines
        .iter()
        .take(MAX_DAY_LINES)
        .map(|l| jt_studio::season_request_key(&l.key, l.year))
        .collect();
    (lines, keys)
}

/// The composer's state (§3.2.5).
fn composer(f: &Facts, v: &Viewer) -> ComposerState {
    let allowed = f.content_module && v.person() && v.has(Permission::ContentManage);
    let mut stops = Vec::new();
    let stop = |code: &'static str| Stop { code, at: None };
    if f.knowledge_empty {
        stops.push(stop("knowledge_empty"));
    }
    if f.braked {
        stops.push(stop("braked"));
    }
    if f.postable.is_empty() {
        stops.push(stop("no_account"));
    }
    match f.content_agent.state {
        ReachState::None => stops.push(stop("no_content_agent")),
        ReachState::Asleep => stops.push(Stop {
            code: "agent_sleeps",
            at: f.content_agent.next_at,
        }),
        ReachState::Late => stops.push(Stop {
            code: "agent_late",
            at: f.content_agent.next_at,
        }),
        ReachState::Ok => {}
    }
    let mut advice = Vec::new();
    if f.post_approval {
        advice.push("approval");
    }
    if f.postable
        .iter()
        .any(|c| jt_studio::requires_posting_screen(&c.kind_key))
    {
        advice.push("posting_screen");
    }
    if !f.postable.is_empty()
        && f.postable.iter().all(|c| {
            jt_studio::supported_formats(&c.kind_key)
                .iter()
                .all(|x| matches!(x, PostFormat::TiktokVideo | PostFormat::Reel))
        })
    {
        advice.push("video_only");
    }
    ComposerState {
        allowed,
        files_allowed: allowed && v.has(Permission::MaterialsWork),
        stops,
        advice,
        connected: f
            .postable
            .iter()
            .map(|c| Connected {
                kind: c.kind_key.clone(),
                name: c.name.clone(),
            })
            .collect(),
    }
}

/// Every row of the workspace, unordered.
fn every_row(f: &Facts, v: &Viewer, season_keys: &BTreeSet<String>) -> Vec<Built> {
    let mut out = Vec::new();
    for p in &f.areas {
        out.extend(area_rows(f, v, p));
    }
    for slot in &f.loose {
        let post = loose_post(*slot);
        for fact in f.reads.facts(&[post]) {
            if let Some(b) = post_row(f, v, None, None, &fact) {
                out.push(b);
            }
        }
    }
    for q in &f.shoots {
        if season_keys.contains(&q.key) {
            continue;
        }
        out.push(need_row(f, v, q));
    }
    out
}

/// A loose slot as the reads take it: no version, of the current package.
fn loose_post(slot: SlotId) -> AreaPost {
    AreaPost {
        version_id: Uuid::nil(),
        slot_id: slot,
        current: true,
    }
}

// ---------------------------------------------------------------------------------------------
// Order, filter, page
// ---------------------------------------------------------------------------------------------

/// Where a row sorts: its group (§3.2.6) and its time within it, ascending.
fn order(b: &Built, now: OffsetDateTime) -> (u8, i64) {
    let r = &b.row;
    if let Some(w) = r.waits.first() {
        return (1, micros(w.since));
    }
    match r.status {
        RowStatus::Failed => {
            let at = b.failed_at.or(r.publish_at).unwrap_or(now);
            if at + Duration::days(RECENT_DAYS) > now {
                (2, -micros(at))
            } else {
                (5, -micros(at))
            }
        }
        RowStatus::Scheduling | RowStatus::Scheduled | RowStatus::Paused => {
            (3, r.publish_at.map_or(i64::MAX, micros))
        }
        RowStatus::Preparing | RowStatus::Revising | RowStatus::WaitingYou => {
            (4, -b.area_at.map_or(0, micros))
        }
        RowStatus::Published | RowStatus::TiktokDraft => (5, -r.published_at.map_or(0, micros)),
    }
}

/// A failed post with no wait that left the default view (seven days after it failed).
fn hidden_by_default(b: &Built, now: OffsetDateTime) -> bool {
    b.row.status == RowStatus::Failed && b.row.waits.is_empty() && order(b, now).0 == 5
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    f: Option<String>,
    g: u8,
    t: i64,
    id: String,
}

fn invalid(field: &str, reason: &str) -> AppError {
    AppError::validation(reason, json!({"field": field, "reason": reason}))
}

/// The stage of a filter key.
fn stage_of(key: &str) -> Option<StageKey> {
    STAGES.iter().map(|(k, _)| *k).find(|k| {
        serde_json::to_value(k)
            .ok()
            .and_then(|v| v.as_str().map(str::to_owned))
            == Some(key.to_owned())
    })
}

// ---------------------------------------------------------------------------------------------
// The use cases
// ---------------------------------------------------------------------------------------------

/// A read-only tenant bundle for a page reader.
async fn open(d: &Deps, ctx: &Ctx) -> Result<Box<dyn TenantRepos>, AppError> {
    ctx.require_any(PAGE_PERMISSIONS)?;
    let mut r = d.uow.tenant(ctx.workspace_id).await?;
    chain::active(r.as_mut()).await?;
    Ok(r)
}

/// Signs the cover (and, for a detail, every material) of `b` for a caller holding
/// `materials.work` (no I/O: a signed URL).
async fn cover(
    d: &Deps,
    ctx: &Ctx,
    f: &Facts,
    id: MaterialId,
    sign: bool,
) -> Result<Option<Cover>, AppError> {
    let Some(m) = f.materials.get(&id) else {
        return Ok(None);
    };
    if m.erased_at.is_some() {
        return Ok(None);
    }
    let (preview_url, preview_expires_at) = if sign {
        let expires = ctx.now + Duration::minutes(30);
        let url = d
            .files
            .device_url(ctx.workspace_id, m.file_id, expires)
            .await?;
        (Some(url.to_string()), Some(expires))
    } else {
        (None, None)
    };
    Ok(Some(Cover {
        material_id: m.id,
        mime: m.mime.clone(),
        preview_url,
        preview_expires_at,
        ai_generated: matches!(m.origin, Origin::AiGenerated { .. }),
    }))
}

/// Every row of the workspace now, with the page's other parts, for `ctx`.
struct Page {
    rows: Vec<Built>,
    days: Vec<SpecialDayLine>,
    composer: ComposerState,
    knowledge_empty: bool,
    brake: Option<BrakeState>,
    facts: Facts,
}

async fn page(d: &Deps, r: &mut dyn TenantRepos, ctx: &Ctx) -> Result<Page, AppError> {
    let f = Facts::read(d, r, ctx.now).await?;
    let v = Viewer::of(ctx);
    let lead = r.studio_materials().material_policy().await?.lead_days;
    let (days, season_keys) = day_lines(&f, &v, lead);
    let mut rows = every_row(&f, &v, &season_keys);
    let now = ctx.now;
    rows.sort_by(|a, b| (order(a, now), &a.row.id).cmp(&(order(b, now), &b.row.id)));
    let brake = f.braked.then(|| BrakeState {
        revision: f.control_revision,
        can_resume: v.has(Permission::SocialManage),
    });
    Ok(Page {
        rows,
        days,
        composer: composer(&f, &v),
        knowledge_empty: f.knowledge_empty,
        brake,
        facts: f,
    })
}

/// `content.posts` (panel; any of the page's permissions): a page of Paylaşımlar's rows, the
/// counts over every row, the special-day lines, the composer's state and the brake.
pub async fn posts(d: &Deps, ctx: &Ctx, q: PostsQuery) -> Result<PostsOut, AppError> {
    let stage = match q.filter.as_deref() {
        None | Some("you") => None,
        Some(key) => Some(stage_of(key).ok_or_else(|| invalid("filter", "unknown_filter"))?),
    };
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT);
    if !(1..=MAX_LIMIT).contains(&limit) {
        return Err(invalid("limit", "out_of_range"));
    }
    let after: Option<Cursor> = q
        .cursor
        .as_deref()
        .map(|c| {
            URL_SAFE_NO_PAD
                .decode(c)
                .ok()
                .and_then(|b| serde_json::from_slice::<Cursor>(&b).ok())
                .filter(|c| c.f == q.filter)
                .ok_or_else(|| invalid("cursor", "invalid_cursor"))
        })
        .transpose()?;
    let mut r = open(d, ctx).await?;
    let Page {
        rows,
        days,
        composer,
        knowledge_empty,
        brake,
        facts,
    } = page(d, r.as_mut(), ctx).await?;
    let now = ctx.now;
    // The counts are over every row, whatever the filter and the page (§3.2.6); only the rows
    // listed leave out the old failed posts the default view no longer shows.
    let mut counts = PostCounts::default();
    for b in &rows {
        counts.all += 1;
        if !b.row.waits.is_empty() {
            counts.you += 1;
        }
        *counts.stages.entry(b.row.progress.stage()).or_default() += 1;
    }
    let matching: Vec<&Built> = rows
        .iter()
        .filter(|b| stage.is_some() || !hidden_by_default(b, now))
        .filter(|b| match (q.filter.as_deref(), stage) {
            (Some("you"), _) => !b.row.waits.is_empty(),
            (_, Some(s)) => b.row.progress.stage() == s,
            _ => true,
        })
        .filter(|b| {
            after.as_ref().is_none_or(|c| {
                let (g, t) = order(b, now);
                (g, t, b.row.id.as_str()) > (c.g, c.t, c.id.as_str())
            })
        })
        .collect();
    let more = matching.len() > limit as usize;
    let page: Vec<&Built> = matching.into_iter().take(limit as usize).collect();
    let next_cursor = more.then(|| page.last()).flatten().map(|b| {
        let (g, t) = order(b, now);
        let c = Cursor {
            f: q.filter.clone(),
            g,
            t,
            id: b.row.id.clone(),
        };
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&c).unwrap_or_default())
    });
    let sign = ctx.permissions.contains(&Permission::MaterialsWork);
    let mut out = Vec::with_capacity(page.len());
    for b in page {
        let mut row = b.row.clone();
        if let Some(first) = b.shows.first() {
            row.cover = cover(d, ctx, &facts, *first, sign).await?;
        }
        out.push(row);
    }
    let days_more = u32::try_from(days.len().saturating_sub(MAX_DAY_LINES)).unwrap_or(u32::MAX);
    Ok(PostsOut {
        rows: out,
        next_cursor,
        counts,
        days: days.into_iter().take(MAX_DAY_LINES).collect(),
        days_more,
        composer,
        knowledge_empty,
        brake,
        as_of: now,
    })
}

/// The ids a `content:` row name stands for (§2.11): its `content` row, else its first waiting
/// post, else its next post, else its last published one.
fn content_target(rows: &[Built], area: Uuid, now: OffsetDateTime) -> Option<&Built> {
    let of: Vec<&Built> = rows
        .iter()
        .filter(|b| b.row.area_id == Some(area))
        .collect();
    of.iter()
        .find(|b| b.row.kind == RowKind::Content)
        .or_else(|| of.iter().find(|b| !b.row.waits.is_empty()))
        .or_else(|| {
            of.iter()
                .filter(|b| {
                    b.row.published_at.is_none() && b.row.publish_at.is_some_and(|t| t >= now)
                })
                .min_by_key(|b| b.row.publish_at)
        })
        .or_else(|| {
            of.iter()
                .filter(|b| b.row.published_at.is_some())
                .max_by_key(|b| b.row.published_at)
        })
        .or(of.first())
        .copied()
}

/// One row as [`posts`] builds it, by its id, with the whole text and every material.
async fn detail_of(
    d: &Deps,
    ctx: &Ctx,
    facts: &Facts,
    b: &Built,
    listed: bool,
) -> Result<PostDetail, AppError> {
    let sign = ctx.permissions.contains(&Permission::MaterialsWork);
    let mut row = b.row.clone();
    if let Some(first) = b.shows.first() {
        row.cover = cover(d, ctx, facts, *first, sign).await?;
    }
    let mut shown = Vec::new();
    for id in &b.shows {
        if let Some(c) = cover(d, ctx, facts, *id, sign).await? {
            shown.push(c);
        }
    }
    Ok(PostDetail {
        row,
        text: b.text.clone(),
        materials: shown,
        redo_note: b.redo_note.clone(),
        cancelled: b.cancelled.as_ref().map(|c| CancelFact {
            by_name: String::new(),
            at: c.at,
            reason: c.reason.clone(),
        }),
        listed,
    })
}

/// Parses a row id: its kind and uuid.
fn parse_row_id(id: &str) -> Option<(&str, Uuid)> {
    let (kind, uuid) = id.split_once(':')?;
    let uuid = Uuid::parse_str(uuid).ok()?;
    matches!(kind, "slot" | "version" | "content" | "need").then_some((kind, uuid))
}

/// `content.post_get` (panel; the page's permissions): one row even when no list holds it (an
/// archived content's, a retired post: `actions` is then empty).
pub async fn post_get(d: &Deps, ctx: &Ctx, i: PostGetInput) -> Result<PostDetail, AppError> {
    let (kind, id) = parse_row_id(&i.row_id).ok_or_else(|| AppError::not_found("post"))?;
    let mut r = open(d, ctx).await?;
    let page = page(d, r.as_mut(), ctx).await?;
    let now = ctx.now;
    let found = match kind {
        "content" => content_target(&page.rows, id, now),
        _ => page.rows.iter().find(|b| b.row.id == i.row_id),
    };
    if let Some(b) = found {
        return detail_of(d, ctx, &page.facts, b, true).await;
    }
    // Not listed: an archived content's row, a retired post, a version of an archived content.
    let area = match kind {
        "content" => r.studio_projects().get_project(id).await?,
        "version" => r.studio_projects().find_area_by_version(id).await?,
        "slot" => match crate::usecases::social::schedule::area_of(r.as_mut(), SlotId(id)).await? {
            Some(a) => r.studio_projects().get_project(a).await?,
            None => None,
        },
        _ => None,
    };
    let gone = gone_row(r.as_mut(), ctx, &page.facts, kind, id, area).await?;
    match gone {
        Some(b) => detail_of(d, ctx, &page.facts, &b, false).await,
        None => Err(AppError::not_found("post")),
    }
}

/// A row no list holds, read as it was, with no action.
async fn gone_row(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    facts: &Facts,
    kind: &str,
    id: Uuid,
    area: Option<ProductionProject>,
) -> Result<Option<Built>, AppError> {
    let v = Viewer {
        perms: BTreeSet::new(),
        person: None,
        decider: false,
    };
    let _ = ctx;
    match (kind, area) {
        ("content", Some(p)) => {
            let mut b = content_row(facts, &v, &p);
            b.row.waits.clear();
            Ok(Some(b))
        }
        ("version", Some(p)) => {
            let Some(ver) = p
                .packages
                .iter()
                .flat_map(|k| k.versions.iter())
                .find(|ver| ver.id == id)
            else {
                return Ok(None);
            };
            let mut b = version_row(facts, &v, &p, ver);
            b.row.waits.clear();
            b.cancelled = ver.cancelled.clone();
            Ok(Some(b))
        }
        ("slot", area) => {
            let slot = SlotId(id);
            let reads = PostReads::load(r, &[slot]).await?;
            let Some(fact) = reads.facts(&[loose_post(slot)]).into_iter().next() else {
                return Ok(None);
            };
            let s = reads.slot(slot).cloned();
            let post = r.studio_posts().get_post(slot).await?;
            let version = area.as_ref().and_then(|p| {
                p.packages
                    .iter()
                    .flat_map(|k| k.versions.iter())
                    .find(|ver| ver.slot_id == Some(slot))
                    .cloned()
            });
            let text = match &s {
                Some(s) => r
                    .studio()
                    .get_piece(s.id, s.revision)
                    .await?
                    .map(|x| x.text)
                    .or_else(|| version.as_ref().map(caption))
                    .unwrap_or_default(),
                None => String::new(),
            };
            let shows = post
                .as_ref()
                .map(|p| p.material_ids.clone())
                .unwrap_or_default();
            let status = if fact.publication.published_at.is_some() {
                RowStatus::Published
            } else if fact.publication.failed {
                RowStatus::Failed
            } else {
                RowStatus::Scheduled
            };
            let title = match first_line(&text) {
                t if !t.is_empty() => t,
                _ => "Paylaşım".into(),
            };
            Ok(Some(Built {
                row: PostRow {
                    id: format!("slot:{slot}"),
                    kind: RowKind::Post,
                    area_id: area.as_ref().map(|p| p.id),
                    version_id: version.as_ref().map(|v| v.id),
                    slot_id: Some(slot),
                    shoot_request_id: None,
                    title,
                    cover: None,
                    channel: facts.channel(fact.publication.capability_id),
                    format: post.as_ref().map(|p| p.format),
                    media: facts.media(&shows),
                    category: facts.category(post.as_ref().and_then(|p| p.olay_id)),
                    publish_at: Some(fact.publication.scheduled_at),
                    published_at: fact.publication.published_at,
                    url: fact.publication.url.clone(),
                    status,
                    tiktok_draft: false,
                    sub_state: None,
                    // As it was: out (done at Sonuç), failed (a problem at Yayın), else planned
                    // and not yet out (current at Yayın, as a scheduled row reads).
                    progress: match status {
                        RowStatus::Published => Progress::at(7, StageState::Done),
                        RowStatus::Failed => Progress::at(6, StageState::Problem),
                        _ => Progress::at(6, StageState::Current),
                    },
                    waits: Vec::new(),
                    actions: RowActions::default(),
                    ai_illustration: facts.ai(&shows),
                    siblings: Vec::new(),
                },
                shows,
                area_at: area.as_ref().map(|p| p.created_at),
                failed_at: None,
                text,
                redo_note: None,
                cancelled: version.and_then(|v| v.cancelled),
            }))
        }
        _ => Ok(None),
    }
}

/// The row `row_id` as [`posts`] builds it now, for an answer of a write in the same bundle.
pub(crate) async fn row_in(
    d: &Deps,
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    row_id: &str,
) -> Result<Option<PostRow>, AppError> {
    let page = page(d, r, ctx).await?;
    let Some(b) = page.rows.iter().find(|b| b.row.id == row_id) else {
        return Ok(None);
    };
    let mut row = b.row.clone();
    if let Some(first) = b.shows.first() {
        row.cover = cover(
            d,
            ctx,
            &page.facts,
            *first,
            ctx.permissions.contains(&Permission::MaterialsWork),
        )
        .await?;
    }
    Ok(Some(row))
}

/// The row a `content:` address of area `area` names now (§2.11), for an answer of a write.
pub(crate) async fn row_of_area(
    d: &Deps,
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    area: Uuid,
) -> Result<Option<PostRow>, AppError> {
    let page = page(d, r, ctx).await?;
    let Some(b) = content_target(&page.rows, area, ctx.now) else {
        return Ok(None);
    };
    let mut row = b.row.clone();
    if let Some(first) = b.shows.first() {
        row.cover = cover(
            d,
            ctx,
            &page.facts,
            *first,
            ctx.permissions.contains(&Permission::MaterialsWork),
        )
        .await?;
    }
    Ok(Some(row))
}

/// The line of special day `key` of `year` now, when it still has one.
pub(crate) async fn day_in(
    d: &Deps,
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    key: &str,
    year: i32,
) -> Result<Option<SpecialDayLine>, AppError> {
    let page = page(d, r, ctx).await?;
    Ok(page
        .days
        .into_iter()
        .find(|l| l.key == key && l.year == year))
}

/// The composer's stops now, for `content.post_request`'s answer.
pub(crate) async fn stops_in(
    d: &Deps,
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
) -> Result<Vec<Stop>, AppError> {
    let f = Facts::read(d, r, ctx.now).await?;
    Ok(composer(&f, &Viewer::of(ctx)).stops)
}

/// Who a row's actor is, for a cancellation's name; unused facts are kept out of answers.
#[allow(dead_code)]
fn actor_user(a: &Actor) -> Option<UserId> {
    match a {
        Actor::Human { user_id } => Some(*user_id),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_is_the_first_line_cut_at_eighty() {
        assert_eq!(first_line("\n  Merhaba  \nikinci"), "Merhaba");
        let long = "x".repeat(100);
        let t = first_line(&long);
        assert_eq!(t.chars().count(), MAX_TITLE_CHARS);
        assert!(t.ends_with('…'));
    }

    #[test]
    fn steps_map_to_their_stage() {
        assert_eq!(
            [1, 3, 4, 6, 7, 8, 9, 10, 11, 14].map(step_stage),
            [0, 0, 1, 1, 2, 2, 3, 3, 4, 4]
        );
    }

    #[test]
    fn filter_keys_are_the_stage_keys() {
        assert_eq!(stage_of("hazirlik"), Some(StageKey::Hazirlik));
        assert_eq!(stage_of("paket"), Some(StageKey::Paket));
        assert_eq!(stage_of("sonuc"), Some(StageKey::Sonuc));
        assert_eq!(stage_of("you"), None);
        assert_eq!(stage_of("nope"), None);
    }

    #[test]
    fn row_ids_parse_by_kind() {
        let id = Uuid::from_u128(7);
        assert_eq!(parse_row_id(&format!("slot:{id}")), Some(("slot", id)));
        assert_eq!(parse_row_id(&format!("need:{id}")), Some(("need", id)));
        assert_eq!(parse_row_id(&format!("other:{id}")), None);
        assert_eq!(parse_row_id("slot:nope"), None);
    }
}
