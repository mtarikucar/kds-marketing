//! `jeeta.connector.start_oauth`, `jeeta.connector.confirm_assets`,
//! `jeeta.connector.set_credentials`, `jeeta.connector.probe`, `jeeta.connector.health`,
//! `jeeta.connector.reconnect` and `jeeta.connector.hooks`: connecting the workspace's accounts
//! through their providers, and the webhook addresses to register at them.
//!
//! **An agent cannot complete an OAuth flow.** It starts one (or a reconnection) and gets the
//! provider's authorize URL, which it hands to the owner: the owner signs in at the provider in
//! their own browser, which comes back to the panel's page, and only that signed-in session
//! completes the flow (`connector.complete_oauth` is the panel's callback route, with no tool).
//! The answer says so in a `handoff` sentence, in Turkish and English ([`handoff`]). Once the
//! owner's browser has come back, the agent may confirm the assets the flow found.
//!
//! NetGSM credentials the owner gave the agent are entered with `jeeta.connector.set_credentials`;
//! the ledger entry notes that an agent entered them (`by_agent: true`, from the caller), never a
//! value. Changes need `capabilities.manage`; probing and reading health need `workspace.read`.
//! The arguments are the panel's bodies, read by the same types (unknown fields are refused, and
//! a refused credential repeats no value), and the outputs are the panel's JSON: an object as it
//! is, a list under a named key, and a started flow with the `handoff` added.

use jt_app::ctx::Ctx;
use jt_app::error::AppError;
use jt_app::usecases::Deps;
use jt_app::usecases::connector::{self, ConfirmAssets, SetCredentials, StartOAuth, StartOut};
use jt_capability::CapabilityId;
use jt_tenancy::Permission;
use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{NoArgs, ToolDef, args, listed, to_json};
use crate::registry::{ToolFuture, schema_for};

/// What an agent is told to do with an authorize URL, in Turkish (`tr`) and English (`en`).
pub(crate) const HANDOFF_TR: &str = "Bu bağlantı adresini (authorize_url) alanın sahibine \
                                     iletin: sahip sağlayıcıda kendi tarayıcısında oturum açıp \
                                     panele döner ve hesap bağlantısını orada tamamlar; ajan hesap \
                                     bağlantısını tamamlayamaz.";
pub(crate) const HANDOFF_EN: &str = "Hand this sign-in link (authorize_url) to the workspace \
                                     owner: the owner signs in at the provider in their own \
                                     browser and comes back to the panel, which completes the \
                                     account connection; you cannot complete the account \
                                     connection yourself.";

pub(super) fn definitions() -> Vec<ToolDef> {
    vec![
        ToolDef {
            use_case: "connector.start_oauth",
            description: "Start connecting an account through its provider's sign-in (OAuth): \
                          kind_key is a Meta kind (instagram, facebook_page, whatsapp_cloud, \
                          instagram_dm, messenger, meta_ads), x, tiktok, linkedin_member (a \
                          LinkedIn member's own feed) or linkedin_page (an organization page; \
                          CONFLICT provider_product_not_enabled until the platform's LinkedIn app \
                          is approved for organizations) (review_facebook cannot be connected \
                          yet: no sign-in finds Facebook comments); NetGSM kinds (sms_line, \
                          netgsm_pbx) take credentials instead (jeeta.connector.set_credentials). \
                          Returns {authorize_url, pending_id, expires_at, handoff}: hand the \
                          authorize_url to the owner, who signs in in their own browser within \
                          ten minutes; the panel completes the flow and the owner chooses the \
                          accounts. You cannot complete it. Needs the platform's provider app to \
                          be configured (else CONFLICT). [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<StartArgs>,
            run: start_oauth,
        },
        ToolDef {
            use_case: "connector.confirm_assets",
            description: "Confirm which assets of a flow the owner completed become \
                          capabilities: selected lists their external ids, as the panel showed \
                          them. Each becomes a connector capability; in a flow bound to a \
                          capability (jeeta.connector.reconnect) the first selected asset of its \
                          kind becomes that capability (renewing it, or giving a declared one its \
                          account) and the rest new capabilities. Each is probed and returned as \
                          it stands after the probe. Before the owner's browser came back the \
                          flow is CONFLICT; an unknown flow is NOT_FOUND; an account another \
                          capability of the kind holds is CONFLICT. Returns {capabilities: \
                          [...]}. [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<ConfirmArgs>,
            run: confirm_assets,
        },
        ToolDef {
            use_case: "connector.set_credentials",
            description: "Enter credentials the owner gave you, for an existing connector \
                          capability (capability_id) or a new one (kind_key and name): a NetGSM \
                          SMS line (kind_key sms_line, credential {kind: netgsm_sms, usercode, \
                          password, msgheader}), the NetGSM PBX (netgsm_pbx, {kind: netgsm_pbx, \
                          username, password, trunk?, pbxnum?}) or a pasted Meta token ({kind: \
                          meta_token, access_token}; a Page or WhatsApp token needs external_id). \
                          IYS attaches to an existing SMS line only (capability_id required), using credential {kind: netgsm_iys, usercode, password, brand_code}; its usercode must match the SMS line and it never replaces SMS credentials. A mailbox takes kind mailbox, smtp_host, smtp_port, imap_host, imap_port, username, password, from_address, tls (implicit or start_tls). X, TikTok and LinkedIn connect through OAuth only. The credentials are sealed and probed \
                          at once; they are never shown again, and the ledger notes that you \
                          entered them. A verified capability keeps its credentials until a \
                          probe fails (CONFLICT). Returns the capability. [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: set_credentials_schema,
            run: set_credentials,
        },
        ToolDef {
            use_case: "connector.probe",
            description: "Probe a connector capability: a cheap authenticated call to its \
                          provider with its sealed credentials, the only way a connector is \
                          verified. Returns {result: {ok, latency_ms, error_kind, error_reason, \
                          facts}, status}; an auth failure marks it unreachable and asks for a \
                          reconnection. [risk: WRITE]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<CapabilityArgs>,
            run: probe,
        },
        ToolDef {
            use_case: "connector.health",
            description: "Read the health of every connector capability that is not retired: \
                          its status, its last probe (when, ok, error_kind), when its token \
                          expires and whether it must be reconnected. Returns {connectors: \
                          [...]}. [risk: READ]",
            permission: Permission::WorkspaceRead,
            schema: schema_for::<NoArgs>,
            run: health,
        },
        ToolDef {
            use_case: "connector.reconnect",
            description: "Start a sign-in bound to a Meta, X, TikTok or LinkedIn capability: \
                          one whose login expired or was refused (a LinkedIn login lasts 60 \
                          days), or a declared one never connected yet. Returns \
                          {authorize_url, pending_id, expires_at, handoff} as \
                          jeeta.connector.start_oauth does; hand the authorize_url to the owner. \
                          Confirming the flow renews the capability's credentials, or gives the \
                          declared capability the account chosen first. A NetGSM capability \
                          takes new credentials instead (VALIDATION, details.reason \
                          use_set_credentials). [risk: WRITE]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<CapabilityArgs>,
            run: reconnect,
        },
        ToolDef {
            use_case: "connector.hooks",
            description: "Read the webhook addresses to register at the providers, to hand to \
                          the owner: the workspace's NetGSM callback URL for each purpose (mo: \
                          incoming SMS, events: Netsantral call events, iys: consent changes, \
                          voice-report, autocall-report), each carrying the workspace's own \
                          token, which lets NetGSM's calls in (keep it to the owner); and the \
                          platform's Meta webhook URL (null until the platform's Meta app is \
                          configured), whose verify token is set in the Meta app dashboard and \
                          never shown. Returns {meta, netgsm: [{purpose, url}]}. [risk: READ]",
            permission: Permission::CapabilitiesManage,
            schema: schema_for::<NoArgs>,
            run: hooks,
        },
    ]
}

/// The schema of `jeeta.connector.start_oauth`: the kind of capability to connect. The arguments
/// are read as the panel's body is ([`StartOAuth`]).
#[derive(JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct StartArgs {
    /// A Meta kind or x.
    #[schemars(schema_with = "oauth_kind_schema")]
    kind_key: String,
}

/// The schema of `jeeta.connector.confirm_assets`: a completed flow and the assets to connect. The
/// arguments are read as [`ConfirmAssets`].
#[derive(JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct ConfirmArgs {
    /// The pending_id jeeta.connector.start_oauth returned.
    pending_id: Uuid,
    /// External ids of the assets to connect, at least one.
    #[schemars(length(min = 1))]
    selected: Vec<String>,
}

/// The schema of `jeeta.connector.set_credentials`; the arguments themselves are read as the
/// panel's body is ([`SetCredentials`]).
#[derive(JsonSchema)]
#[serde(deny_unknown_fields)]
#[allow(dead_code)]
struct SetCredentialsArgs {
    /// An existing connector capability; or give kind_key and name for a new one.
    capability_id: Option<Uuid>,
    /// The kind of a new capability: sms_line, netgsm_pbx or a Meta kind.
    kind_key: Option<String>,
    /// The name of a new capability.
    name: Option<String>,
    /// The provider's id of the account; required for a pasted Page or WhatsApp token.
    external_id: Option<String>,
    /// The credentials, by kind.
    #[schemars(schema_with = "credential_schema")]
    credential: Value,
}

/// A connector capability.
#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct CapabilityArgs {
    /// The capability id, from jeeta.capability.list or jeeta.connector.health.
    capability_id: Uuid,
}

/// The JSON Schema of a kind OAuth connects: every kind Meta, X, TikTok or LinkedIn serves.
fn oauth_kind_schema(_: &mut SchemaGenerator) -> Schema {
    let kinds: Vec<&str> = [
        jt_connector::Provider::Meta,
        jt_connector::Provider::X,
        jt_connector::Provider::Tiktok,
        jt_connector::Provider::Linkedin,
    ]
    .iter()
    .flat_map(|p| p.kinds().iter().copied())
    .collect();
    json_schema!({ "type": "string", "enum": kinds })
}

fn set_credentials_schema() -> Schema {
    let mut schema = schema_for::<SetCredentialsArgs>();
    schema.as_object_mut().expect("object schema").insert("allOf".into(),json!([{
        "if":{"properties":{"credential":{"properties":{"kind":{"const":"netgsm_iys"}},"required":["kind"]}},"required":["credential"]},
        "then":{"required":["capability_id"],"properties":{"capability_id":{"type":"string","format":"uuid"}},"not":{"anyOf":[{"required":["kind_key"]},{"required":["name"]},{"required":["external_id"]}]}}
    }]));
    schema
}

/// The JSON Schema of the credentials entered by hand, one shape per `kind`.
fn credential_schema(_: &mut SchemaGenerator) -> Schema {
    let field = |description: &str| json!({ "type": "string", "description": description });
    json_schema!({
        "oneOf": [
            {
                "type":"object",
                "properties": {
                    "kind":{"const":"mailbox"},
                    "smtp_host":field("Public SMTP hostname."),
                    "smtp_port":{"type":"integer","enum":[465,587]},
                    "imap_host":field("Public IMAP hostname."),
                    "imap_port":{"type":"integer","enum":[993,143]},
                    "username":field("IMAP-authenticated account name."),
                    "password":field("Mailbox password."),
                    "from_address":field("SMTP-authorized sender address."),
                    "tls":{"type":"string","enum":["implicit","start_tls"]}
                },
                "required":["kind","smtp_host","smtp_port","imap_host","imap_port","username","password","from_address","tls"],
                "additionalProperties":false
            },
            {
                "type": "object",
                "properties": {
                    "kind": { "const": "netgsm_sms" },
                    "usercode": field("The NetGSM user code (the API sub-user)."),
                    "password": field("Its password."),
                    "msgheader": field("The approved sender name."),
                },
                "required": ["kind", "usercode", "password", "msgheader"],
                "additionalProperties": false,
            },
            {
                "type":"object", "properties": {
                    "kind":{"const":"netgsm_iys"},
                    "usercode":field("Must equal the existing SMS line usercode; capability_id is required."),
                    "password":field("IYS password, sealed separately from SMS."),
                    "brand_code":field("IYS brand code, stored publicly on the line.")
                }, "required":["kind","usercode","password","brand_code"], "additionalProperties":false
            },
            {
                "type": "object",
                "properties": {
                    "kind": { "const": "netgsm_pbx" },
                    "username": field("The Netsantral user."),
                    "password": field("Its password."),
                    "trunk": field("The trunk, when the account has several."),
                    "pbxnum": field("The PBX number, when the account has several."),
                },
                "required": ["kind", "username", "password"],
                "additionalProperties": false,
            },
            {
                "type": "object",
                "properties": {
                    "kind": { "const": "meta_token" },
                    "access_token": field("A Meta access token the owner pasted."),
                },
                "required": ["kind", "access_token"],
                "additionalProperties": false,
            },
        ],
    })
}

/// A started flow as an agent gets it: the panel's answer and the [`HANDOFF_TR`]/[`HANDOFF_EN`]
/// sentence under `handoff`.
fn handoff(out: &StartOut) -> Result<Value, AppError> {
    let mut value = to_json(out)?;
    value["handoff"] = json!({ "tr": HANDOFF_TR, "en": HANDOFF_EN });
    Ok(value)
}

fn start_oauth<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: StartOAuth = args(raw)?;
        handoff(&connector::start_oauth(deps, ctx, input).await?)
    })
}

fn confirm_assets<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: ConfirmAssets = args(raw)?;
        listed(
            "capabilities",
            &connector::confirm_assets(deps, ctx, input).await?,
        )
    })
}

fn set_credentials<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let input: SetCredentials = args(raw)?;
        to_json(&connector::set_credentials(deps, ctx, input).await?)
    })
}

fn probe<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let CapabilityArgs { capability_id } = args(raw)?;
        to_json(&connector::probe(deps, ctx, CapabilityId(capability_id)).await?)
    })
}

fn health<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        listed("connectors", &connector::health(deps, ctx).await?)
    })
}

fn reconnect<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let CapabilityArgs { capability_id } = args(raw)?;
        handoff(&connector::reconnect(deps, ctx, CapabilityId(capability_id)).await?)
    })
}

fn hooks<'a>(deps: &'a Deps, ctx: &'a Ctx, raw: Value) -> ToolFuture<'a> {
    Box::pin(async move {
        let NoArgs {} = args(raw)?;
        to_json(&connector::hooks(deps, ctx).await?)
    })
}
