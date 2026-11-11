//! `jeeta.outreach.*`: plain-text email outreach (spec `2026-10-30-leads-pool-outreach-design.md`
//! §3.10–§3.16, §7.1): templates, campaigns of one to six steps, their audience and enrollments,
//! the per-recipient personalization, a test email, the report and the settings.
//!
//! **Cold email is locked.** Campaigns can be prepared, but a launch, a resume, an approval that
//! starts one, the dispatcher and a test email refuse while the platform switch
//! `JEETA_OUTREACH_ENABLED` is off (`outreach_disabled_on_platform`). Outreach reaches consented
//! people only, unless a human owner turned on the business-recipient basis with the counsel's
//! confirmation; every email carries the opt-out footer and a one-click unsubscribe.

use jt_app::ctx::Ctx;
use jt_app::error::AppError;
use jt_app::usecases::Deps;
use jt_app::usecases::outreach::{
    self, ApproveInput, CampaignListInput, CampaignSaveInput, ControlInput, EnrollInput,
    EnrollmentListInput, LaunchInput, PersonalizeInput, PreviewInput, SettingsInput, StopInput,
    TemplateListInput, TemplateSaveInput, TestSendInput, report,
};
use jt_outreach::{CampaignId, EnrollmentId, TemplateId};
use jt_tenancy::Permission;
use schemars::{Schema, json_schema};
use serde_json::{Value, json};
use uuid::Uuid;

use super::{NoArgs, ToolDef, args, to_json};
use crate::registry::{ToolFuture, schema_for};

/// The description of a tool that can lead to a send: `$text`, then the lock and the basis,
/// then its risk (`WRITE`, last, as every description ends).
macro_rules! locked {
    ($text:literal) => {
        concat!(
            $text,
            " Locked while the platform switch JEETA_OUTREACH_ENABLED is off \
             (FORBIDDEN outreach_disabled_on_platform). Outreach reaches consented people only, \
             unless a human owner turned on the business-recipient basis (email to business \
             recipients, with the counsel's confirmation recorded); every email carries the \
             opt-out footer and a one-click unsubscribe. [risk: WRITE]"
        )
    };
}

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "outreach.templates_list",
            description: "Read the email templates, most recently edited first: include_archived, \
                          limit 1 to 200 (50), before_at and before_id (the previous page's next). \
                          Each {template {id, name, language, subject, body, revision, archived}, \
                          facts {vars, links}, updated_at}. [risk: READ]",
            permissions: &[Permission::OutreachWork],
            schema: templates_list_schema,
            run: templates_list,
        },
        ToolDef {
            use_case: "outreach.templates_save",
            description: "Save a plain-text email template: a new one (no template_id), or the \
                          next revision of one (template_id and the expected_revision you read). \
                          name (1 to 120), language tr | en, subject (one line, 1 to 200, no \
                          link), body (1 to 20000). Variables {{name}} or {{name|fallback}}: \
                          first_name, contact_name, company, city, district, sector, \
                          sender_name, sender_company, custom.<key> (written per recipient with \
                          jeeta.outreach.personalize); links only http(s). Jeeta appends the \
                          footer (sender identity, why the email comes, privacy notice, \
                          unsubscribe): never write one. A running campaign keeps the snapshot \
                          it launched with. VALIDATION names the field and reason; CONFLICT \
                          stale_revision or archived. A request_key replays a creation for 24 \
                          hours. [risk: WRITE]",
            permissions: &[Permission::OutreachWork],
            schema: templates_save_schema,
            run: templates_save,
        },
        ToolDef {
            use_case: "outreach.templates_archive",
            description: "Archive a template (template_id): new campaigns cannot use it; a \
                          campaign that snapshotted it keeps sending its snapshot. Archiving an \
                          archived one changes nothing. [risk: WRITE]",
            permissions: &[Permission::OutreachWork],
            schema: template_id_schema,
            run: templates_archive,
        },
        ToolDef {
            use_case: "outreach.campaigns_list",
            description: "Read the campaigns, newest first: status (draft, awaiting_approval, \
                          scheduled, running, paused, completed, canceled), limit 1 to 200 (50), \
                          before_at and before_id (the previous page's next). [risk: READ]",
            permissions: &[Permission::OutreachWork],
            schema: campaigns_list_schema,
            run: campaigns_list,
        },
        ToolDef {
            use_case: "outreach.campaigns_get",
            description: "Read a campaign (campaign_id): its definition, status, revision, \
                          approval and pause reason, whether a launch or resume now needs a \
                          person's approval, and its active enrollments. [risk: READ]",
            permissions: &[Permission::OutreachWork],
            schema: campaign_id_schema,
            run: campaigns_get,
        },
        ToolDef {
            use_case: "outreach.campaigns_save",
            description: "Save a campaign while draft or paused: a new draft (no campaign_id), or \
                          the next revision (campaign_id and expected_revision), which voids its \
                          approval. name (1 to 120), mailbox_id (a mailbox capability: the \
                          sender), definition {sender_name (1 to 80), steps (1 to 6: \
                          {template_id, delay_days: 0 for the first, then 1 to 30, same_thread}), \
                          audience {people (open journeys: journey_statuses, owner, source_kinds, \
                          recipient_kind, segments, cities, sectors, opened_after, opened_before) \
                          | prospects (qualified prospects, promoted at enrollment: segment_keys, \
                          research_task_ids, cities, sectors, min_score) | explicit (up to 500 \
                          person ids)}, schedule {start_at, window {tz, from, to, days}}, \
                          throttle {per_hour 1 to 60, per_day 1 to 500}, click_tracking, \
                          evergreen, segment_key}. Needs an approved strategy. Check the audience \
                          with jeeta.outreach.audience_preview first. [risk: WRITE]",
            permissions: &[Permission::OutreachWork],
            schema: campaigns_save_schema,
            run: campaigns_save,
        },
        ToolDef {
            use_case: "outreach.audience_preview",
            description: "Preview an audience (audience, as in a campaign's definition) from a \
                          mailbox (mailbox_id), writing nothing: {eligible, by_skip_reason \
                          (person_gone, journey_closed, no_deliverable_email, suppressed, \
                          do_not_contact, no_basis, active_elsewhere, promotion_cap), basis \
                          {consent, business_recipient}, promotions_needed, \
                          business_basis_in_force, truncated}. While the business-recipient \
                          basis is not in force, people without consent are no_basis. \
                          [risk: READ]",
            permissions: &[Permission::OutreachWork],
            schema: preview_schema,
            run: audience_preview,
        },
        ToolDef {
            use_case: "outreach.campaigns_launch",
            description: locked!(
                "Launch a draft campaign (campaign_id) at the expected_revision you read: \
                 needs the sender identity (sender_company, sender_address, \
                 privacy_notice_url in jeeta.outreach.settings_set, else FORBIDDEN \
                 sender_identity_missing). When the outreach settings or the mailbox require \
                 approval, the campaign waits in awaiting_approval for a person with \
                 outreach.manage (a person with outreach.manage launching approves it); else it \
                 is scheduled (a future start_at) or running, its audience enrolled and its \
                 steps snapshotted."
            ),
            permissions: &[Permission::OutreachWork],
            schema: revision_schema,
            run: campaigns_launch,
        },
        ToolDef {
            use_case: "outreach.campaigns_approve",
            description: locked!(
                "Approve a campaign's revision (campaign_id, expected_revision): a person's act \
                 with outreach.manage (FORBIDDEN human_required for an agent); a stale revision \
                 is CONFLICT stale_revision. A waiting campaign then starts."
            ),
            permissions: &[Permission::OutreachManage],
            schema: revision_schema,
            run: campaigns_approve,
        },
        ToolDef {
            use_case: "outreach.campaigns_control",
            description: locked!(
                "Pause, resume or cancel a campaign (campaign_id, action pause | resume | \
                 cancel). A resume re-checks the approval at the current revision (an edited \
                 campaign waits for a new one); a cancel needs outreach.manage and stops every \
                 active enrollment (campaign_canceled)."
            ),
            permissions: &[Permission::OutreachWork],
            schema: control_schema,
            run: campaigns_control,
        },
        ToolDef {
            use_case: "outreach.enroll",
            description: locked!(
                "Enroll people into a scheduled, running or paused campaign (campaign_id): \
                 exactly one of audience: true (its audience as it resolves now), person_ids \
                 or prospect_ids (up to 500; qualified prospects are promoted first, within the \
                 pool's daily cap). One active enrollment per person in the workspace. Answers \
                 {enrolled, skipped by reason, already_enrolled, promoted, \
                 waiting_for_promotion, truncated}. Nothing is sent here: the dispatcher \
                 checks every rule again at each send."
            ),
            permissions: &[Permission::OutreachWork],
            schema: enroll_schema,
            run: enroll,
        },
        ToolDef {
            use_case: "outreach.enrollments_list",
            description: "Read a campaign's enrollments (campaign_id) by id: status (active, \
                          completed, stopped, skipped), limit 1 to 200 (50), after (the previous \
                          page's next). Each names the person, its next step and send time, the \
                          stop or skip reason, the basis and the personalization. Answers \
                          {items, next}. [risk: READ]",
            permissions: &[Permission::OutreachWork],
            schema: enrollments_list_schema,
            run: enrollments_list,
        },
        ToolDef {
            use_case: "outreach.enrollments_stop",
            description: "Stop an active enrollment (enrollment_id) by hand (reason manual); it \
                          never restarts. CONFLICT not_active when it is not active. Answers the \
                          enrollment. [risk: WRITE]",
            permissions: &[Permission::OutreachWork],
            schema: enrollment_id_schema,
            run: enrollments_stop,
        },
        ToolDef {
            use_case: "outreach.personalize",
            description: "Write per-recipient values (items: 1 to 100 {enrollment_id, values}): \
                          the custom.<key> variables the campaign's templates use (keys with or \
                          without custom., [a-z0-9_]{1,32}, up to 20, values up to 500 \
                          characters about the business). A step whose template uses a custom \
                          variable without a fallback waits for it (personalization_due in \
                          jeeta.work.pending) up to 72 hours. Answers {updated}. [risk: WRITE]",
            permissions: &[Permission::OutreachWork],
            schema: personalize_schema,
            run: personalize,
        },
        ToolDef {
            use_case: "outreach.test_send",
            description: locked!(
                "Send one step (step, 1 unless given) of a campaign (campaign_id) as a test \
                 email to the calling member's own login address only (to, if given, must be \
                 it: else FORBIDDEN not_a_members_login_address), from the campaign's mailbox, \
                 through the same outbox as every email. Missing values read as [variable]. \
                 Answers {to, step, message_id, state}."
            ),
            permissions: &[Permission::OutreachWork],
            schema: test_send_schema,
            run: test_send,
        },
        ToolDef {
            use_case: "outreach.report",
            description: "Read outreach's report for [from, to) (RFC 3339 instants, at most 366 \
                          days; computed now), of one campaign (campaign_id) or all, grouped by \
                          group_by campaign (default) | step | template: enrolled and skipped by \
                          reason, sent, unknown, failed, refused, bounced, complained, replied \
                          (threaded and unthreaded), unsubscribed, unique_clicks (when tracked), \
                          automated_clicks, meetings_30d and won_30d (within 30 days of the \
                          person's first email), stopped by reason. Read it weekly with \
                          jeeta.prospects.report. [risk: READ]",
            permissions: &[Permission::OutreachWork],
            schema: report_schema,
            run: report_run,
        },
        ToolDef {
            use_case: "outreach.settings_get",
            description: "Read the outreach settings: requires_approval, b2b_basis, \
                          require_iys_lookup, legal_ack, sender_company, sender_address, \
                          privacy_notice_url, warmup, frequency, click_tracking_default, and \
                          what counts now: sender_identity_complete, platform_enabled (the \
                          switch JEETA_OUTREACH_ENABLED) and b2b_channels_in_force. \
                          [risk: READ]",
            permissions: &[Permission::OutreachWork],
            schema: schema_for::<NoArgs>,
            run: settings_get,
        },
        ToolDef {
            use_case: "outreach.settings_set",
            description: "Change the outreach settings (outreach.manage): any of \
                          requires_approval, sender_company (1 to 200), sender_address (1 to \
                          300), privacy_notice_url (http(s)), warmup {enabled, start, step, \
                          max}, frequency {min_gap_days, max_per_30_days}, \
                          click_tracking_default; an empty text clears it. Giving b2b_basis \
                          channels (email only) or turning require_iys_lookup off needs a human \
                          owner and legal_ack {counsel_confirmed: true, note} in the same call \
                          (FORBIDDEN owner_required, counsel_confirmation_required); an agent \
                          never can. Narrowing needs only outreach.manage. The business basis \
                          counts only while JEETA_OUTREACH_ENABLED is on. [risk: WRITE]",
            permissions: &[Permission::OutreachManage],
            schema: settings_schema,
            run: settings_set,
        },
    ]
}

fn uuid(description: &str) -> Value {
    json!({ "type": "string", "format": "uuid", "description": description })
}

fn page(cursor: &str) -> Value {
    json!({ "type": "integer", "minimum": 1, "maximum": 200, "description": format!("1 to 200 (50); {cursor}") })
}

fn templates_list_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "include_archived": { "type": "boolean" },
            "limit": page("next with before_at and before_id"),
            "before_at": { "type": "string", "format": "date-time" },
            "before_id": uuid("next.before_id of the previous page."),
        },
        "additionalProperties": false,
    })
}

fn templates_save_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "template_id": uuid("The template to revise; none for a new one."),
            "expected_revision": { "type": "integer", "minimum": 1 },
            "name": { "type": "string", "minLength": 1, "maxLength": 120 },
            "language": { "type": "string", "enum": ["tr", "en"] },
            "subject": { "type": "string", "minLength": 1, "maxLength": 200 },
            "body": { "type": "string", "minLength": 1, "maxLength": 20000 },
            "request_key": { "type": "string", "minLength": 1, "maxLength": 128 },
        },
        "required": ["name", "language", "subject", "body"],
        "additionalProperties": false,
    })
}

fn template_id_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": { "template_id": uuid("The template.") },
        "required": ["template_id"],
        "additionalProperties": false,
    })
}

fn campaign_id_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": { "campaign_id": uuid("The campaign.") },
        "required": ["campaign_id"],
        "additionalProperties": false,
    })
}

fn enrollment_id_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": { "enrollment_id": uuid("The enrollment.") },
        "required": ["enrollment_id"],
        "additionalProperties": false,
    })
}

fn campaigns_list_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "status": { "type": "string", "enum": ["draft", "awaiting_approval", "scheduled", "running", "paused", "completed", "canceled"] },
            "limit": page("next with before_at and before_id"),
            "before_at": { "type": "string", "format": "date-time" },
            "before_id": uuid("next.before_id of the previous page."),
        },
        "additionalProperties": false,
    })
}

/// An audience as a campaign's definition holds it (the use case checks its bounds).
fn audience() -> Value {
    json!({
        "type": "object",
        "description": "people (a filter over open journeys), prospects (a filter over qualified prospects) and/or explicit person ids.",
        "properties": {
            "people": { "type": "object" },
            "prospects": { "type": "object" },
            "explicit": { "type": "array", "maxItems": 500, "items": { "type": "string", "format": "uuid" } },
        },
        "additionalProperties": false,
    })
}

fn campaigns_save_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "campaign_id": uuid("The campaign to revise; none for a new draft."),
            "expected_revision": { "type": "integer", "minimum": 1 },
            "name": { "type": "string", "minLength": 1, "maxLength": 120 },
            "mailbox_id": uuid("A mailbox capability of the workspace: the sender."),
            "definition": {
                "type": "object",
                "properties": {
                    "sender_name": { "type": "string", "minLength": 1, "maxLength": 80 },
                    "steps": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": 6,
                        "items": {
                            "type": "object",
                            "properties": {
                                "template_id": uuid("The step's template."),
                                "delay_days": { "type": "integer", "minimum": 0, "maximum": 30 },
                                "same_thread": { "type": "boolean" },
                            },
                            "required": ["template_id", "delay_days"],
                        },
                    },
                    "audience": audience(),
                    "schedule": {
                        "type": "object",
                        "properties": {
                            "start_at": { "type": ["string", "null"], "format": "date-time" },
                            "window": {
                                "type": "object",
                                "properties": {
                                    "tz": { "type": "string", "description": "An IANA time zone." },
                                    "from": { "type": "integer", "minimum": 0, "maximum": 23 },
                                    "to": { "type": "integer", "minimum": 1, "maximum": 24 },
                                    "days": { "type": "array", "minItems": 1, "maxItems": 7, "items": { "type": "integer", "minimum": 1, "maximum": 7 } },
                                },
                                "required": ["tz", "from", "to", "days"],
                            },
                        },
                        "required": ["window"],
                    },
                    "throttle": {
                        "type": "object",
                        "properties": {
                            "per_hour": { "type": "integer", "minimum": 1, "maximum": 60 },
                            "per_day": { "type": "integer", "minimum": 1, "maximum": 500 },
                        },
                        "required": ["per_hour", "per_day"],
                    },
                    "click_tracking": { "type": "boolean" },
                    "evergreen": { "type": "boolean" },
                    "segment_key": { "type": ["string", "null"] },
                },
                "required": ["sender_name", "steps", "audience", "schedule", "throttle"],
            },
            "request_key": { "type": "string", "minLength": 1, "maxLength": 128 },
        },
        "required": ["name", "mailbox_id", "definition"],
        "additionalProperties": false,
    })
}

fn preview_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "audience": audience(),
            "mailbox_id": uuid("The mailbox the campaign would send from."),
        },
        "required": ["audience", "mailbox_id"],
        "additionalProperties": false,
    })
}

fn revision_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "campaign_id": uuid("The campaign."),
            "expected_revision": { "type": "integer", "minimum": 1, "description": "The revision you read." },
        },
        "required": ["campaign_id", "expected_revision"],
        "additionalProperties": false,
    })
}

fn control_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "campaign_id": uuid("The campaign."),
            "action": { "type": "string", "enum": ["pause", "resume", "cancel"] },
        },
        "required": ["campaign_id", "action"],
        "additionalProperties": false,
    })
}

fn enroll_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "campaign_id": uuid("The campaign."),
            "audience": { "type": "boolean", "description": "Enroll the campaign's audience as it resolves now." },
            "person_ids": { "type": "array", "maxItems": 500, "items": { "type": "string", "format": "uuid" } },
            "prospect_ids": { "type": "array", "maxItems": 500, "items": { "type": "string", "format": "uuid" } },
        },
        "required": ["campaign_id"],
        "additionalProperties": false,
    })
}

fn enrollments_list_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "campaign_id": uuid("The campaign."),
            "status": { "type": "string", "enum": ["active", "completed", "stopped", "skipped"] },
            "limit": page("next as after"),
            "after": uuid("next of the previous page."),
        },
        "required": ["campaign_id"],
        "additionalProperties": false,
    })
}

fn personalize_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "minItems": 1,
                "maxItems": 100,
                "items": {
                    "type": "object",
                    "properties": {
                        "enrollment_id": uuid("The enrollment."),
                        "values": {
                            "type": "object",
                            "maxProperties": 20,
                            "additionalProperties": { "type": "string", "maxLength": 500 },
                        },
                    },
                    "required": ["enrollment_id", "values"],
                    "additionalProperties": false,
                },
            },
        },
        "required": ["items"],
        "additionalProperties": false,
    })
}

fn test_send_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "campaign_id": uuid("The campaign."),
            "step": { "type": "integer", "minimum": 1, "maximum": 6 },
            "to": { "type": "string", "format": "email", "description": "Your own login address; any other is refused." },
        },
        "required": ["campaign_id"],
        "additionalProperties": false,
    })
}

fn report_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "campaign_id": uuid("Only this campaign."),
            "from": { "type": "string", "format": "date-time", "description": "The range's start (included)." },
            "to": { "type": "string", "format": "date-time", "description": "The range's end (excluded), at most 366 days after from." },
            "group_by": { "type": "string", "enum": ["campaign", "step", "template"] },
        },
        "required": ["from", "to"],
        "additionalProperties": false,
    })
}

fn settings_schema() -> Schema {
    json_schema!({
        "type": "object",
        "properties": {
            "requires_approval": { "type": "boolean" },
            "b2b_basis": { "type": "array", "maxItems": 1, "items": { "type": "string", "enum": ["email"] } },
            "require_iys_lookup": { "type": "boolean" },
            "legal_ack": {
                "type": "object",
                "properties": {
                    "counsel_confirmed": { "type": "boolean" },
                    "note": { "type": "string", "minLength": 1, "maxLength": 500 },
                },
                "required": ["counsel_confirmed", "note"],
                "additionalProperties": false,
            },
            "sender_company": { "type": "string", "maxLength": 200 },
            "sender_address": { "type": "string", "maxLength": 300 },
            "privacy_notice_url": { "type": "string", "maxLength": 2048 },
            "warmup": {
                "type": "object",
                "properties": {
                    "enabled": { "type": "boolean" },
                    "start": { "type": "integer", "minimum": 1, "maximum": 500 },
                    "step": { "type": "integer", "minimum": 0, "maximum": 100 },
                    "max": { "type": "integer", "minimum": 1, "maximum": 500 },
                },
                "additionalProperties": false,
            },
            "frequency": {
                "type": "object",
                "properties": {
                    "min_gap_days": { "type": "integer", "minimum": 0, "maximum": 30 },
                    "max_per_30_days": { "type": "integer", "minimum": 1, "maximum": 30 },
                },
                "additionalProperties": false,
            },
            "click_tracking_default": { "type": "boolean" },
        },
        "additionalProperties": false,
    })
}

/// The id under `key` of a call's arguments, and the arguments without it.
fn split(mut raw: Value, key: &str) -> Result<(Uuid, Value), AppError> {
    let id = raw
        .as_object_mut()
        .and_then(|o| o.remove(key))
        .unwrap_or(Value::Null);
    let id: Uuid = args(id)?;
    Ok((id, raw))
}

fn templates_list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: TemplateListInput = args(raw)?;
        to_json(&outreach::templates_list(deps, ctx, input).await?)
    })
}

fn templates_save<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: TemplateSaveInput = args(raw)?;
        to_json(&outreach::templates_save(deps, ctx, input).await?)
    })
}

fn templates_archive<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "template_id")?;
        let NoArgs {} = args(rest)?;
        to_json(&outreach::templates_archive(deps, ctx, TemplateId(id)).await?)
    })
}

fn campaigns_list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: CampaignListInput = args(raw)?;
        to_json(&outreach::campaigns_list(deps, ctx, input).await?)
    })
}

fn campaigns_get<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "campaign_id")?;
        let NoArgs {} = args(rest)?;
        to_json(&outreach::campaigns_get(deps, ctx, CampaignId(id)).await?)
    })
}

fn campaigns_save<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: CampaignSaveInput = args(raw)?;
        to_json(&outreach::campaigns_save(deps, ctx, input).await?)
    })
}

fn audience_preview<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: PreviewInput = args(raw)?;
        to_json(&outreach::audience_preview(deps, ctx, input).await?)
    })
}

fn campaigns_launch<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "campaign_id")?;
        let input: LaunchInput = args(rest)?;
        to_json(&outreach::campaigns_launch(deps, ctx, CampaignId(id), input).await?)
    })
}

fn campaigns_approve<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "campaign_id")?;
        let input: ApproveInput = args(rest)?;
        to_json(&outreach::campaigns_approve(deps, ctx, CampaignId(id), input).await?)
    })
}

fn campaigns_control<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "campaign_id")?;
        let input: ControlInput = args(rest)?;
        to_json(&outreach::campaigns_control(deps, ctx, CampaignId(id), input).await?)
    })
}

fn enroll<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "campaign_id")?;
        let input: EnrollInput = args(rest)?;
        to_json(&outreach::enroll(deps, ctx, CampaignId(id), input).await?)
    })
}

fn enrollments_list<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "campaign_id")?;
        let input: EnrollmentListInput = args(rest)?;
        to_json(&outreach::enrollments_list(deps, ctx, CampaignId(id), input).await?)
    })
}

fn enrollments_stop<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "enrollment_id")?;
        let input: StopInput = args(rest)?;
        to_json(&outreach::enrollments_stop(deps, ctx, EnrollmentId(id), input).await?)
    })
}

fn personalize<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: PersonalizeInput = args(raw)?;
        to_json(&outreach::personalize(deps, ctx, input).await?)
    })
}

fn test_send<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let (id, rest) = split(raw, "campaign_id")?;
        let input: TestSendInput = args(rest)?;
        to_json(&outreach::test_send(deps, ctx, CampaignId(id), input).await?)
    })
}

fn report_run<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: report::ReportInput = args(raw)?;
        to_json(&report::report(deps, ctx, input).await?)
    })
}

fn settings_get<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&outreach::settings_get(deps, ctx).await?)
    })
}

fn settings_set<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: SettingsInput = args(raw)?;
        to_json(&outreach::settings_set(deps, ctx, input).await?)
    })
}
