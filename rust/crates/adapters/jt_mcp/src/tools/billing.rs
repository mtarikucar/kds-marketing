//! Evidence-only bank-transfer notification; activation codes never enter MCP.
use super::{ToolDef, args, to_json};
use crate::registry::{ToolFuture, schema_for};
use jt_app::{
    ctx::Ctx,
    usecases::{
        Deps,
        billing::{self, ReportPaymentInput},
    },
};
use jt_tenancy::Permission;
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct ReportArgs {
    reference: String,
    #[schemars(range(min = 1))]
    amount_minor: i64,
    #[schemars(schema_with = "paid_at_schema")]
    #[serde(with = "time::serde::rfc3339")]
    paid_at: time::OffsetDateTime,
    #[schemars(length(min = 1, max = 128))]
    request_key: String,
}
pub(super) fn definitions() -> Vec<ToolDef> {
    vec![ToolDef {
        use_case: "billing.report_payment",
        description: "Report bank-transfer evidence as the current workspace owner. Requires the workspace payment reference from the panel. Does not verify settlement or activate access. Reuse a request key only with identical evidence. No activation code. [risk: WRITE]",
        permission: Permission::TeamManage,
        schema: schema_for::<ReportArgs>,
        run: report,
    }]
}
fn report<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let a: ReportArgs = args(raw)?;
        to_json(
            &billing::report_payment(
                deps,
                ctx,
                ReportPaymentInput {
                    reference: a.reference,
                    amount_minor: a.amount_minor,
                    paid_at: a.paid_at,
                    request_key: a.request_key,
                },
            )
            .await?,
        )
    })
}

fn paid_at_schema(_: &mut schemars::SchemaGenerator) -> schemars::Schema {
    schemars::json_schema!({"type":"string","format":"date-time"})
}
