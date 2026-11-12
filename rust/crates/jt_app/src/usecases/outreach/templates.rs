//! Templates (spec §3.10; §7.1 `outreach.templates_list`, `templates_save`,
//! `templates_archive`): a one-line subject and a plain-text body with variables from a fixed
//! set, checked at save (`jt_outreach::validate_template`). Each save is the next revision; a
//! running campaign keeps the snapshot it took at launch, so an edit never reaches it.

use jt_outreach::{Lang, Template, TemplateFacts, TemplateId, validate_template_name};
use jt_tenancy::Permission;
use serde::{Deserialize, Serialize};
use serde_json::json;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

use super::{record, refused, request_key, stale, template_error};
use crate::ctx::Ctx;
use crate::error::{AppError, ErrorCode};
use crate::ports::TenantRepos;
use crate::ports::outreach::{MAX_OUTREACH_PAGE, TemplateCursor, TemplateQuery, TemplateRow};
use crate::usecases::{Deps, invalid, keyset_cursor};

/// The prefix that keeps a template creation's request keys apart from every other operation's.
pub const REQUEST_KEY_PREFIX: &str = "outreach.templates_save:";

/// `jeeta.outreach.templates_save`'s input: a new template (no `template_id`), or the next
/// revision of one (`template_id` and the `expected_revision` it was read at).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateSaveInput {
    #[serde(default)]
    pub template_id: Option<TemplateId>,
    #[serde(default)]
    pub expected_revision: Option<u32>,
    pub name: String,
    pub language: Lang,
    pub subject: String,
    pub body: String,
    /// Replays a creation for 24 hours (the id only is stored).
    #[serde(default)]
    pub request_key: Option<String>,
}

/// A template with what it uses.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TemplateOut {
    pub template: Template,
    pub facts: TemplateFacts,
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
}

fn out(row: TemplateRow) -> Result<TemplateOut, AppError> {
    // A stored template was validated when saved; one that no longer parses is the store's.
    let facts = jt_outreach::validate_template(&row.template.subject, &row.template.body)
        .map_err(|_| AppError::internal("a stored template no longer parses"))?;
    Ok(TemplateOut {
        template: row.template,
        facts,
        updated_at: row.updated_at,
    })
}

/// `NOT_FOUND` for a template that is not the workspace's.
pub(crate) fn no_such_template() -> AppError {
    AppError::not_found("no such template")
}

/// `jeeta.outreach.templates_save`: creates a template (revision 1) or writes the next revision
/// of one, checked as `validate_template` says. An archived template is not edited
/// (`CONFLICT archived`); a revision read before another save is `CONFLICT stale_revision`.
pub async fn templates_save(
    deps: &Deps,
    ctx: &Ctx,
    input: TemplateSaveInput,
) -> Result<TemplateOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    validate_template_name(&input.name).map_err(template_error)?;
    jt_outreach::validate_template(&input.subject, &input.body).map_err(template_error)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let Some(id) = input.template_id else {
        if input.expected_revision.is_some() {
            return Err(invalid(
                "expected_revision",
                "expected_revision comes with template_id",
            ));
        }
        let key = request_key(REQUEST_KEY_PREFIX, input.request_key.as_deref())?;
        if let Some(key) = &key
            && let Some(out) = replay(r.as_mut(), ctx, key).await?
        {
            return Ok(out);
        }
        let row = TemplateRow {
            template: Template {
                id: TemplateId::from(deps.ids.uuid()),
                name: input.name.trim().to_owned(),
                language: input.language,
                subject: input.subject.trim().to_owned(),
                body: input.body,
                revision: 1,
                archived: false,
            },
            created_by: ctx.actor.clone(),
            updated_at: ctx.now,
        };
        r.outreach_templates().insert(&row).await?;
        saved(r.as_mut(), ctx, &row.template).await?;
        if let Some(key) = &key
            && !r
                .request_keys()
                .store(key, json!({ "template_id": row.template.id }), ctx.now)
                .await?
        {
            return Err(AppError::conflict("request key changed while recording"));
        }
        r.commit().await?;
        return out(row);
    };
    if input.request_key.is_some() {
        return Err(invalid(
            "request_key",
            "a request key replays a creation; an edit is revision-checked",
        ));
    }
    let expected = input.expected_revision.ok_or_else(|| {
        invalid(
            "expected_revision",
            "an edit names the revision it was read at",
        )
    })?;
    let mut row = r
        .outreach_templates()
        .lock(id)
        .await?
        .ok_or_else(no_such_template)?;
    if row.template.archived {
        return Err(refused(
            ErrorCode::Conflict,
            "archived",
            "an archived template is not edited",
            json!({}),
        ));
    }
    if row.template.revision != expected {
        return Err(stale(row.template.revision));
    }
    row.template.name = input.name.trim().to_owned();
    row.template.language = input.language;
    row.template.subject = input.subject.trim().to_owned();
    row.template.body = input.body;
    row.template.revision = expected + 1;
    row.updated_at = ctx.now;
    if !r.outreach_templates().update(&row, expected).await? {
        return Err(stale(expected));
    }
    saved(r.as_mut(), ctx, &row.template).await?;
    r.commit().await?;
    out(row)
}

async fn saved(r: &mut dyn TenantRepos, ctx: &Ctx, t: &Template) -> Result<(), AppError> {
    record(
        r,
        ctx,
        "outreach.template_saved",
        "outreach_template",
        t.id,
        json!({ "template_id": t.id, "revision": t.revision, "language": t.language.key() }),
    )
    .await
}

/// The template a creation's request key recorded, read again now.
async fn replay(
    r: &mut dyn TenantRepos,
    ctx: &Ctx,
    key: &str,
) -> Result<Option<TemplateOut>, AppError> {
    let Some(stored) = r.request_keys().get(key, ctx.now).await? else {
        return Ok(None);
    };
    let id: TemplateId = serde_json::from_value(stored["template_id"].clone())
        .map_err(|_| AppError::internal("a stored request key names no template"))?;
    let row = r
        .outreach_templates()
        .get(id)
        .await?
        .ok_or_else(no_such_template)?;
    out(row).map(Some)
}

/// `jeeta.outreach.templates_archive`: hides a template from new campaigns (a campaign that
/// snapshotted it keeps sending its snapshot). Archiving an archived one changes nothing.
pub async fn templates_archive(
    deps: &Deps,
    ctx: &Ctx,
    id: TemplateId,
) -> Result<TemplateOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let mut row = r
        .outreach_templates()
        .lock(id)
        .await?
        .ok_or_else(no_such_template)?;
    if row.template.archived {
        return out(row);
    }
    let expected = row.template.revision;
    row.template.archived = true;
    row.updated_at = ctx.now;
    if !r.outreach_templates().update(&row, expected).await? {
        return Err(stale(expected));
    }
    record(
        r.as_mut(),
        ctx,
        "outreach.template_archived",
        "outreach_template",
        id,
        json!({ "template_id": id }),
    )
    .await?;
    r.commit().await?;
    out(row)
}

/// `jeeta.outreach.templates_list`'s input: a page, most recently edited first.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TemplateListInput {
    #[serde(default)]
    pub include_archived: bool,
    /// `1..=200`, 50 unless given.
    #[serde(default)]
    pub limit: Option<u32>,
    #[serde(default)]
    pub before_at: Option<String>,
    #[serde(default)]
    pub before_id: Option<TemplateId>,
}

/// Where the next page of templates starts.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TemplateNext {
    pub before_at: String,
    pub before_id: TemplateId,
}

/// A page of templates.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TemplateListOut {
    pub items: Vec<TemplateOut>,
    pub next: Option<TemplateNext>,
}

/// `jeeta.outreach.templates_list`.
pub async fn templates_list(
    deps: &Deps,
    ctx: &Ctx,
    input: TemplateListInput,
) -> Result<TemplateListOut, AppError> {
    ctx.require(Permission::OutreachWork)?;
    let limit = page_limit(input.limit)?;
    let before = keyset_cursor(input.before_at.as_deref(), input.before_id)?
        .map(|(updated_at, id)| TemplateCursor { updated_at, id });
    let mut r = deps.uow.tenant(ctx.workspace_id).await?;
    let page = r
        .outreach_templates()
        .list(&TemplateQuery {
            include_archived: input.include_archived,
            limit,
            before,
        })
        .await?;
    let next = match page.next {
        Some(c) => Some(TemplateNext {
            before_at: c
                .updated_at
                .format(&Rfc3339)
                .map_err(|_| AppError::internal("an edit time does not format"))?,
            before_id: c.id,
        }),
        None => None,
    };
    Ok(TemplateListOut {
        items: page.items.into_iter().map(out).collect::<Result<_, _>>()?,
        next,
    })
}

/// A page size of `1..=MAX_OUTREACH_PAGE`, 50 unless given.
pub(crate) fn page_limit(limit: Option<u32>) -> Result<u32, AppError> {
    match limit {
        None => Ok(50),
        Some(n) if (1..=MAX_OUTREACH_PAGE).contains(&n) => Ok(n),
        Some(_) => Err(invalid(
            "limit",
            &format!("limit is 1..={MAX_OUTREACH_PAGE}"),
        )),
    }
}
