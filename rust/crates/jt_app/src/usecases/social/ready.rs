//! What stands between a request and a post on an account (design 2026-11-19 F3, rule R1).
//!
//! Every gate a post meets on its way out is worked out here at once, from the facts as they are
//! now, so that the panel can say it all when a person connects an account or asks for a content,
//! instead of each gate speaking only when the work reaches it. Each stop names its cause and the
//! one action that fixes it; read again on every answer, a stop goes the moment its cause does.
use crate::{
    error::AppError,
    ports::{TenantRepos, posts::PostingSettings, production_projects::ProductionProject},
    usecases::{Deps, studio::posts::postable},
};
use jt_capability::Capability;
use jt_knowledge::KnowledgeSettings;
use jt_strategy::LaneKind;
use jt_studio::PostFormat;
use serde::Serialize;
use time::OffsetDateTime;

/// What a stop is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopCode {
    /// The connection cannot post: its login lapsed, a permission is missing, or it is not
    /// verified. Reconnecting fixes it.
    Reconnect,
    /// A person paused posting on the account.
    Paused,
    /// Posting is stopped for every account (the organic brake).
    Braked,
    /// The knowledge base has no card text yet, so there is no frame: nothing is planned
    /// anywhere (design 2026-11-19 "Paylaşımlar and Bilgi bankası" §4.5.1). Every connected
    /// account is used once it has one (K6): no stop names a channel or a topic.
    KnowledgeEmpty,
    /// The content has no material the platform takes (`format`: what it would need).
    MediaMissing,
    /// The platform takes one format only (`format`), and it is a video: TikTok.
    OnlyFormat,
    /// Every post passes the platform's posting screen, which a person fills (TikTok).
    PostingScreen,
    /// Every post waits for a person's approval (the account's policy).
    Approval,
    /// The earliest a post can be planned: `hours` from now for `format`.
    Lead,
}

/// The one thing a person does about a stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StopAction {
    Reconnect,
    Resume,
    /// Write a few lines in Bilgi bankası.
    OpenKnowledge,
    AddMaterial,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Stop {
    pub code: StopCode,
    /// Nothing goes out on the account while it holds. A stop that does not block is said now so
    /// that it does not surprise later.
    pub blocking: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<StopAction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<PostFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hours: Option<u32>,
}

impl Stop {
    fn new(code: StopCode, blocking: bool, action: Option<StopAction>) -> Self {
        Stop {
            code,
            blocking,
            action,
            format: None,
            hours: None,
        }
    }
}

/// The stops of one account for one content: the account's, and the content's materials there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AccountStops {
    pub capability_id: jt_capability::CapabilityId,
    pub stops: Vec<Stop>,
}

/// What the stops are read from, once for any number of accounts.
pub(crate) struct Reader {
    frame: bool,
    /// The knowledge base's rules, for the effective post gate (none before seeding).
    knowledge: Option<KnowledgeSettings>,
    settings: PostingSettings,
    braked: bool,
}

impl Reader {
    pub(crate) async fn load(r: &mut dyn TenantRepos) -> Result<Self, AppError> {
        let frame = r.strategy().current_approved().await?.is_some();
        let knowledge = super::approval::rules(r).await?;
        let settings = r.studio_posts().posting_settings().await?;
        let braked = r
            .studio_control()
            .lock_control()
            .await?
            .is_braked(LaneKind::Organic);
        Ok(Reader {
            frame,
            knowledge,
            settings,
            braked,
        })
    }

    /// The knowledge base's rules the stops were read with (none before seeding).
    pub(crate) fn knowledge(&self) -> Option<&KnowledgeSettings> {
        self.knowledge.as_ref()
    }

    /// What would stop a post on account `c` at `now`, blocking stops first, then what a post
    /// there will meet. `formats` narrows the lead to the formats asked for (all the platform's
    /// when empty).
    pub(crate) fn account(
        &self,
        d: &Deps,
        c: &Capability,
        formats: &[PostFormat],
        now: OffsetDateTime,
    ) -> Vec<Stop> {
        use StopAction as A;
        use StopCode as S;
        let mut out = Vec::new();
        if !postable(d, c, now) {
            out.push(Stop::new(S::Reconnect, true, Some(A::Reconnect)));
        }
        if self.settings.paused_capability_ids.contains(&c.id) {
            out.push(Stop::new(S::Paused, true, Some(A::Resume)));
        }
        if self.braked {
            out.push(Stop::new(S::Braked, true, None));
        }
        if !self.frame {
            out.push(Stop::new(S::KnowledgeEmpty, true, Some(A::OpenKnowledge)));
        }
        let supported = jt_studio::supported_formats(&c.kind_key);
        // Said where it surprises: a platform that takes only a video (an image will not do).
        if let [only] = supported
            && *only == PostFormat::TiktokVideo
        {
            out.push(Stop {
                format: Some(*only),
                ..Stop::new(S::OnlyFormat, false, None)
            });
        }
        match super::approval::post_gate(c, self.knowledge.as_ref()) {
            Some(super::schedule::HumanGate::PostingScreen) => {
                out.push(Stop::new(S::PostingScreen, false, None));
            }
            Some(super::schedule::HumanGate::Approval) => {
                out.push(Stop::new(S::Approval, false, None));
            }
            None => {}
        }
        let asked: Vec<PostFormat> = supported
            .iter()
            .copied()
            .filter(|f| formats.is_empty() || formats.contains(f))
            .collect();
        if let Some((format, minutes)) = asked
            .iter()
            .map(|f| (*f, self.settings.policy.lead(*f).whole_minutes()))
            .min_by_key(|(_, m)| *m)
            && minutes >= 60
        {
            out.push(Stop {
                format: Some(format),
                hours: u32::try_from(minutes / 60).ok(),
                ..Stop::new(S::Lead, false, None)
            });
        }
        out
    }

    /// The stops of area `p` on each account it names, with its materials: an account's own,
    /// and whether the content has anything the platform takes. An area naming no account
    /// has none.
    pub(crate) async fn area(
        &self,
        d: &Deps,
        r: &mut dyn TenantRepos,
        p: &ProductionProject,
        now: OffsetDateTime,
    ) -> Result<Vec<AccountStops>, AppError> {
        if p.hints.capability_ids.is_empty() || p.archived {
            return Ok(Vec::new());
        }
        let mut mimes = Vec::new();
        for id in crate::usecases::studio::projects::available_material_ids(r, p).await? {
            if let Some(m) = r.studio_materials().get_material(id).await?
                && m.erased_at.is_none()
            {
                mimes.push(m.mime);
            }
        }
        let mut out = Vec::new();
        for id in &p.hints.capability_ids {
            let Some(c) = r.capabilities().find(*id).await? else {
                continue;
            };
            let mut stops = self.account(d, &c, &p.hints.formats, now);
            if let Some(stop) = media(&c, &p.hints.formats, &mimes) {
                stops.insert(0, stop);
            }
            out.push(AccountStops {
                capability_id: c.id,
                stops,
            });
        }
        Ok(out)
    }
}

/// [`StopCode::MediaMissing`] when none of a content's materials (of `mimes`) is something
/// account `c`'s platform takes in any of `formats` (all it takes when empty): a version made of
/// them could not go out there.
pub(crate) fn media(c: &Capability, formats: &[PostFormat], mimes: &[String]) -> Option<Stop> {
    let asked: Vec<PostFormat> = jt_studio::supported_formats(&c.kind_key)
        .iter()
        .copied()
        .filter(|f| formats.is_empty() || formats.contains(f))
        .collect();
    let fits = asked.iter().any(|f| {
        mimes
            .iter()
            .any(|m| jt_studio::media_types_ok(*f, &c.kind_key, &[m.as_str()]))
    });
    (!fits && !asked.is_empty()).then(|| Stop {
        format: asked.first().copied(),
        ..Stop::new(StopCode::MediaMissing, false, Some(StopAction::AddMaterial))
    })
}
