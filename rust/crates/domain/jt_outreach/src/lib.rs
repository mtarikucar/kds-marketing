//! Outreach's pure domain (spec 2026-10-30-leads-pool-outreach-design.md §3.10–§3.14, §5.2):
//! plain-text templates with a strict variable set, rendering with the mandatory footer (D12),
//! the campaign state machine with revision-bound approval (D19), definition and audience
//! bounds, enrollment states with stable stop and skip reasons (D16), warm-up, frequency and
//! budget arithmetic (D15; the numbers are product defaults, not provider facts), link rewriting
//! and MAC input bytes for the public links, the outreach policy and the outreach fence (F2, F3,
//! F7, F9, F10). No I/O, no clock, no crypto: the application reads the facts, computes MACs
//! with its seal and calls these rules.
//!
//! **Cold email is locked by default.** [`outreach_fence`] and [`launch_fence`] check the
//! platform switch (`JEETA_OUTREACH_ENABLED`, D24) before anything else, and the
//! business-recipient basis ([`OutreachPolicy::b2b_channels`], D17) is empty unless a human
//! owner recorded the counsel's confirmation, and then holds only the messaging channels that
//! owner opened.
//!
//! Errors name a field and a stable reason key, never a value.

mod campaign;
mod enrollment;
mod fence;
mod footer;
mod ids;
mod links;
mod policy;
mod template;
mod throttle;

pub use campaign::{
    Approval, ApprovalChange, Audience, CampaignError, CampaignEvent, CampaignStatus, Definition,
    MAX_CAMPAIGN_NAME_CHARS, MAX_DELAY_DAYS, MAX_ENROLLMENTS, MAX_EXPLICIT, MAX_FILTER_VALUE_CHARS,
    MAX_FILTER_VALUES, MAX_PER_DAY, MAX_PER_HOUR, MAX_SENDER_NAME_CHARS, MAX_STEPS, OwnerFilter,
    PauseReason, PeopleFilter, ProspectFilter, Schedule, Step, StepSnapshot, Throttle,
    campaign_next, requires_approval, validate_audience, validate_campaign_name,
    validate_definition,
};
pub use enrollment::{
    EnrollmentStatus, MAX_PERSONALIZATION_KEYS, MAX_PERSONALIZATION_VALUE_CHARS, SendOutcome,
    SkipReason, StopReason, next_step_after, validate_personalization,
};
pub use fence::{OutreachFacts, OutreachRefusal, launch_fence, outreach_fence};
pub use footer::{Footer, FooterSource, append_footer};
pub use ids::{CampaignId, EnrollmentId, SendId, TemplateId};
pub use links::{
    MAC_BYTES, MAX_LINK_CHARS, MacPurpose, click_path, mac_input, rewrite_links, unsubscribe_path,
};
pub use policy::{
    B2B_BASIS_CHANNELS, LegalAck, MAX_SENDER_ADDRESS_CHARS, MAX_SENDER_COMPANY_CHARS,
    OutreachPolicy,
};
pub use template::{
    Lang, MAX_BODY_CHARS, MAX_CUSTOM_KEY_CHARS, MAX_FALLBACK_CHARS, MAX_LINKS, MAX_SUBJECT_CHARS,
    MAX_TEMPLATE_NAME_CHARS, RenderError, RenderVars, Rendered, Template, TemplateError,
    TemplateFacts, Var, render, render_body, validate_template, validate_template_name,
};
pub use throttle::{
    BOUNCE_WINDOW, BudgetInput, COMPLAINT_LIMIT, COMPLAINT_WINDOW, DOMAIN_PER_HOUR,
    DOMAIN_POSTPONE, Frequency, MAILBOX_DAY_CEILING, WARMUP_IDLE_DAYS, WarmupPolicy, auto_pause,
    budget, domain_ok, frequency_next_allowed, warmup_cap, warmup_day_index,
};

/// Characters, not bytes: every length bound of the spec counts characters.
pub(crate) fn chars(s: &str) -> usize {
    s.chars().count()
}

/// A trimmed one-line text of `min..=max` characters without control characters: `Ok`, or the
/// reason key (`length`, `control_character`).
pub(crate) fn line(s: &str, min: usize, max: usize) -> Result<(), &'static str> {
    if s.chars().any(char::is_control) {
        return Err("control_character");
    }
    if (min..=max).contains(&chars(s.trim())) {
        Ok(())
    } else {
        Err("length")
    }
}
