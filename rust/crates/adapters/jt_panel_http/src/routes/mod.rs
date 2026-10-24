//! The route table: [`ROUTES`] lists every method and path the router serves, and the router
//! registers exactly the entries of [`api_routes`] and [`root_routes`], whose methods and paths
//! must equal it (pinned by `router_matches_routes_table`).
//!
//! Every API route names the catalog use case behind it. The router resolves each name in the
//! catalog when it is built, panicking on a name the catalog does not know or whose catalog
//! route differs, and wraps the route in the gate layer of the resolved [`UseCase`]
//! ([`crate::gate`]).

pub mod agents;
pub mod api_keys;
pub mod auth;
pub mod billing;
pub mod budget;
pub mod capabilities;
pub mod connector;
pub mod events;
pub mod groups;
pub mod inbox;
pub mod ledger;
pub mod oauth_callback;
pub mod platform;
pub mod roles;
pub mod strategy;
pub mod studio;
pub mod team;
pub mod work;
pub mod workspace;

use axum::Json;
use axum::handler::Handler;
use axum::http::Method;
use axum::routing::{MethodFilter, MethodRouter, on};
use jt_app::catalog::UseCase;
use serde_json::{Value, json};

use crate::API_PREFIX;
use crate::state::AppState;

/// Every route the panel HTTP adapter serves, as (method, path), in axum's path syntax as
/// `CATALOG.panel_route` writes it. The twin-rule test compares it with the catalog.
pub const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/studio/overview"),
    ("GET", "/api/studio/ledger"),
    ("POST", "/api/studio/ledger/export"),
    ("GET", "/api/studio/adsets"),
    ("POST", "/api/studio/adsets/bind"),
    ("POST", "/api/studio/budget-moves"),
    ("GET", "/api/studio/learned"),
    ("POST", "/api/studio/judgments"),
    ("POST", "/api/studio/files"),
    ("POST", "/api/studio/slots/{slot_id}/piece"),
    ("GET", "/api/studio/pending"),
    ("GET", "/api/studio/slots/{slot_id}"),
    ("POST", "/api/studio/slots/{slot_id}/cancel"),
    ("POST", "/api/studio/trends"),
    ("POST", "/api/studio/hypotheses/proposals"),
    ("POST", "/api/studio/brake"),
    ("PUT", "/api/studio/policy"),
    ("POST", "/api/studio/approvals"),
    ("GET", "/api/inbox/pending"),
    ("POST", "/api/inbox/people/{person_id}/consents"),
    ("GET", "/api/inbox/people/{person_id}/consents"),
    ("POST", "/api/inbox/people/{person_id}/suppressions"),
    (
        "DELETE",
        "/api/inbox/people/{person_id}/suppressions/{channel}/{reason}",
    ),
    ("POST", "/api/inbox/people/{person_id}/send"),
    ("POST", "/api/inbox/journeys/{journey_id}/quotes"),
    ("POST", "/api/inbox/quotes/{id}/accept"),
    ("GET", "/api/inbox/journeys/{journey_id}/quotes"),
    ("POST", "/api/inbox/journeys/{journey_id}/appointments"),
    ("POST", "/api/inbox/appointments/{id}/cancel"),
    ("POST", "/api/inbox/appointments/{id}/held"),
    ("GET", "/api/inbox/commissions"),
    ("POST", "/api/inbox/commissions/{id}/approve"),
    ("POST", "/api/inbox/commissions/{id}/pay"),
    ("PUT", "/api/inbox/commission-rates"),
    ("GET", "/api/inbox/conversations/{conversation_id}/context"),
    ("POST", "/api/inbox/people/{person_id}/erase"),
    ("GET", "/api/inbox/conversations"),
    ("GET", "/api/inbox/conversations/{conversation_id}"),
    ("GET", "/api/inbox/conversations/{conversation_id}/messages"),
    (
        "POST",
        "/api/inbox/conversations/{conversation_id}/take-over",
    ),
    (
        "POST",
        "/api/inbox/conversations/{conversation_id}/hand-to-agent",
    ),
    ("POST", "/api/inbox/conversations/{conversation_id}/snooze"),
    (
        "POST",
        "/api/inbox/conversations/{conversation_id}/unsnooze",
    ),
    ("POST", "/api/inbox/conversations/{conversation_id}/close"),
    ("POST", "/api/inbox/conversations/{conversation_id}/reply"),
    ("GET", "/api/inbox/merges"),
    ("POST", "/api/inbox/merges/{merge_id}/apply"),
    ("POST", "/api/inbox/merges/{merge_id}/undo"),
    ("POST", "/api/inbox/merges/{merge_id}/refuse"),
    ("POST", "/api/inbox/journeys/{journey_id}/tasks"),
    ("POST", "/api/inbox/tasks/{task_id}/complete"),
    ("GET", "/api/inbox/tasks"),
    ("POST", "/api/inbox/journeys/{journey_id}/notes"),
    ("PUT", "/api/inbox/status-labels"),
    ("GET", "/api/inbox/people"),
    ("GET", "/api/inbox/people/{person_id}"),
    ("POST", "/api/inbox/people"),
    ("POST", "/api/inbox/people/{person_id}/identities"),
    ("POST", "/api/inbox/people/{person_id}/journeys"),
    ("POST", "/api/inbox/journeys/{journey_id}/events"),
    ("GET", "/api/inbox/lost-reasons"),
    ("PUT", "/api/inbox/lost-reasons"),
    ("GET", "/api/inbox/journeys/{journey_id}"),
    ("POST", "/api/inbox/journeys/{journey_id}/owner"),
    ("POST", "/api/auth/register"),
    ("POST", "/api/auth/login"),
    ("POST", "/api/auth/logout"),
    ("GET", "/api/auth/me"),
    ("POST", "/api/auth/switch-workspace"),
    ("GET", "/api/billing"),
    ("POST", "/api/billing/payments"),
    ("GET", "/api/workspace"),
    ("GET", "/api/team"),
    ("POST", "/api/team/invites"),
    ("POST", "/api/team/invites/accept"),
    ("PATCH", "/api/team/{membership_id}/role"),
    ("DELETE", "/api/team/{membership_id}"),
    ("GET", "/api/roles"),
    ("POST", "/api/roles"),
    ("PATCH", "/api/roles/{role_id}"),
    ("DELETE", "/api/roles/{role_id}"),
    ("POST", "/api/api-keys"),
    ("GET", "/api/api-keys"),
    ("DELETE", "/api/api-keys/{key_id}"),
    ("GET", "/api/agents"),
    ("GET", "/api/whoami"),
    ("GET", "/api/ledger"),
    ("GET", "/api/strategy"),
    ("POST", "/api/strategy/consultation"),
    ("POST", "/api/strategy/consultation/entries"),
    ("PUT", "/api/strategy/draft/sections/{section_key}"),
    ("PUT", "/api/strategy/draft/hypotheses"),
    ("POST", "/api/strategy/draft/submit"),
    ("POST", "/api/strategy/draft/approve"),
    ("POST", "/api/strategy/archive"),
    ("GET", "/api/strategy/versions"),
    ("GET", "/api/strategy/versions/{version_id}/consultation"),
    ("GET", "/api/capabilities"),
    ("GET", "/api/capabilities/{capability_id}"),
    ("POST", "/api/capabilities"),
    ("PATCH", "/api/capabilities/{capability_id}"),
    ("POST", "/api/capabilities/{capability_id}/verify"),
    ("POST", "/api/capabilities/{capability_id}/unreachable"),
    ("PUT", "/api/capabilities/{capability_id}/policy"),
    ("POST", "/api/capabilities/{capability_id}/retire"),
    ("POST", "/api/capabilities/{capability_id}/budget-links"),
    (
        "DELETE",
        "/api/capabilities/{capability_id}/budget-links/{budget_item_id}",
    ),
    ("GET", "/api/capability-groups"),
    ("POST", "/api/capability-groups"),
    ("PATCH", "/api/capability-groups/{group_id}"),
    ("DELETE", "/api/capability-groups/{group_id}"),
    ("POST", "/api/capability-groups/{group_id}/members"),
    (
        "DELETE",
        "/api/capability-groups/{group_id}/members/{capability_id}",
    ),
    ("GET", "/api/budget/items"),
    ("POST", "/api/budget/items"),
    ("PATCH", "/api/budget/items/{budget_item_id}"),
    ("POST", "/api/budget/items/{budget_item_id}/retire"),
    ("POST", "/api/budget/items/{budget_item_id}/spend"),
    ("GET", "/api/budget/items/{budget_item_id}/spend"),
    ("POST", "/api/connectors/oauth/start"),
    ("GET", "/api/connectors/oauth/callback/{provider}"),
    ("POST", "/api/connectors/oauth/{pending_id}/confirm"),
    ("POST", "/api/connectors/credentials"),
    ("POST", "/api/connectors/{capability_id}/probe"),
    ("GET", "/api/connectors/health"),
    ("POST", "/api/connectors/{capability_id}/reconnect"),
    ("GET", "/api/connectors/hooks"),
    ("GET", "/api/events/pending"),
    ("POST", "/api/events/ack"),
    ("GET", "/api/events"),
    ("GET", "/api/work/pending"),
    ("PUT", "/api/work/checkin-interval"),
    ("POST", "/api/platform/login"),
    ("GET", "/api/platform/workspaces"),
    ("PATCH", "/api/platform/workspaces/{workspace_id}/status"),
    ("GET", "/healthz"),
];

/// A JSON API route: its method, its path relative to [`API_PREFIX`], the catalog id of its use
/// case and its handler. A `GET` route also answers `HEAD`, with the same use case.
pub struct ApiRoute {
    pub method: &'static str,
    pub path: &'static str,
    pub use_case: &'static str,
    pub handler: MethodRouter<AppState>,
}

/// A route outside the API, which no use case stands behind (e.g. `/healthz`).
pub struct RootRoute {
    pub method: &'static str,
    pub path: &'static str,
    pub handler: MethodRouter<AppState>,
}

/// A method router answering only `method` (a standard method name; `GET` includes `HEAD`).
fn only<H, T>(method: &'static str, handler: H) -> MethodRouter<AppState>
where
    H: Handler<T, AppState>,
    T: 'static,
{
    let filter = Method::from_bytes(method.as_bytes())
        .ok()
        .and_then(|m| MethodFilter::try_from(m).ok())
        .unwrap_or_else(|| panic!("route method {method} is not a standard method"));
    on(filter, handler)
}

/// An API route for use case `use_case`.
pub fn api_route<H, T>(
    method: &'static str,
    path: &'static str,
    use_case: &'static str,
    handler: H,
) -> ApiRoute
where
    H: Handler<T, AppState>,
    T: 'static,
{
    ApiRoute {
        method,
        path,
        use_case,
        handler: only(method, handler),
    }
}

fn root_route<H, T>(method: &'static str, path: &'static str, handler: H) -> RootRoute
where
    H: Handler<T, AppState>,
    T: 'static,
{
    RootRoute {
        method,
        path,
        handler: only(method, handler),
    }
}

/// The JSON API's routes.
pub fn api_routes() -> Vec<ApiRoute> {
    vec![
        api_route(
            "GET",
            "/studio/overview",
            "studio.overview",
            studio::overview,
        ),
        api_route("GET", "/studio/ledger", "studio.ledger", studio::ledger),
        api_route(
            "POST",
            "/studio/ledger/export",
            "studio.ledger_export",
            studio::ledger_export,
        ),
        api_route(
            "GET",
            "/studio/adsets",
            "studio.adsets_list",
            studio::adsets_list,
        ),
        api_route(
            "POST",
            "/studio/adsets/bind",
            "studio.adset_bind",
            studio::adset_bind,
        ),
        api_route(
            "POST",
            "/studio/budget-moves",
            "studio.budget_move",
            studio::budget_move,
        ),
        api_route("GET", "/studio/learned", "studio.learned", studio::learned),
        api_route(
            "POST",
            "/studio/judgments",
            "studio.judgment_record",
            studio::judgment_record,
        ),
        api_route(
            "POST",
            "/studio/files",
            "studio.file_upload",
            studio::file_upload,
        ),
        api_route(
            "POST",
            "/studio/slots/{slot_id}/piece",
            "studio.piece_submit",
            studio::piece_submit,
        ),
        api_route("GET", "/studio/pending", "studio.pending", studio::pending),
        api_route(
            "GET",
            "/studio/slots/{slot_id}",
            "studio.slot_get",
            studio::slot_get,
        ),
        api_route(
            "POST",
            "/studio/slots/{slot_id}/cancel",
            "studio.slot_cancel",
            studio::slot_cancel,
        ),
        api_route(
            "POST",
            "/studio/trends",
            "studio.trend_record",
            studio::trend_record,
        ),
        api_route(
            "POST",
            "/studio/hypotheses/proposals",
            "studio.hypothesis_propose",
            studio::hypothesis_propose,
        ),
        api_route("POST", "/studio/brake", "studio.brake", studio::brake),
        api_route(
            "PUT",
            "/studio/policy",
            "studio.policy_set",
            studio::policy_set,
        ),
        api_route(
            "POST",
            "/studio/approvals",
            "studio.approve",
            studio::approve,
        ),
        api_route("GET", "/inbox/pending", "inbox.pending", inbox::pending),
        api_route(
            "POST",
            "/inbox/people/{person_id}/consents",
            "inbox.consent.record",
            inbox::consent_record,
        ),
        api_route(
            "GET",
            "/inbox/people/{person_id}/consents",
            "inbox.consent.list",
            inbox::consent_list,
        ),
        api_route(
            "POST",
            "/inbox/people/{person_id}/suppressions",
            "inbox.suppressions.add",
            inbox::suppressions_add,
        ),
        api_route(
            "DELETE",
            "/inbox/people/{person_id}/suppressions/{channel}/{reason}",
            "inbox.suppressions.remove",
            inbox::suppressions_remove,
        ),
        api_route(
            "POST",
            "/inbox/people/{person_id}/send",
            "inbox.send",
            inbox::send,
        ),
        api_route(
            "POST",
            "/inbox/journeys/{journey_id}/quotes",
            "inbox.quotes.send",
            inbox::quotes_send,
        ),
        api_route(
            "POST",
            "/inbox/quotes/{id}/accept",
            "inbox.quotes.accept",
            inbox::quotes_accept,
        ),
        api_route(
            "GET",
            "/inbox/journeys/{journey_id}/quotes",
            "inbox.quotes.list",
            inbox::quotes_list,
        ),
        api_route(
            "POST",
            "/inbox/journeys/{journey_id}/appointments",
            "inbox.appointments.book",
            inbox::appointments_book,
        ),
        api_route(
            "POST",
            "/inbox/appointments/{id}/cancel",
            "inbox.appointments.cancel",
            inbox::appointments_cancel,
        ),
        api_route(
            "POST",
            "/inbox/appointments/{id}/held",
            "inbox.appointments.held",
            inbox::appointments_held,
        ),
        api_route(
            "GET",
            "/inbox/commissions",
            "inbox.commissions.list",
            inbox::commissions_list,
        ),
        api_route(
            "POST",
            "/inbox/commissions/{id}/approve",
            "inbox.commissions.approve",
            inbox::commissions_approve,
        ),
        api_route(
            "POST",
            "/inbox/commissions/{id}/pay",
            "inbox.commissions.pay",
            inbox::commissions_pay,
        ),
        api_route(
            "PUT",
            "/inbox/commission-rates",
            "inbox.commission_rates.set",
            inbox::commission_rates_set,
        ),
        api_route(
            "GET",
            "/inbox/conversations/{conversation_id}/context",
            "inbox.context",
            inbox::context,
        ),
        api_route(
            "POST",
            "/inbox/people/{person_id}/erase",
            "inbox.people.erase",
            inbox::people_erase,
        ),
        api_route(
            "GET",
            "/inbox/conversations",
            "inbox.conversations.list",
            inbox::conversations_list,
        ),
        api_route(
            "GET",
            "/inbox/conversations/{conversation_id}",
            "inbox.conversations.get",
            inbox::conversations_get,
        ),
        api_route(
            "GET",
            "/inbox/conversations/{conversation_id}/messages",
            "inbox.messages.list",
            inbox::messages_list,
        ),
        api_route(
            "POST",
            "/inbox/conversations/{conversation_id}/take-over",
            "inbox.take_over",
            inbox::take_over,
        ),
        api_route(
            "POST",
            "/inbox/conversations/{conversation_id}/hand-to-agent",
            "inbox.hand_to_agent",
            inbox::hand_to_agent,
        ),
        api_route(
            "POST",
            "/inbox/conversations/{conversation_id}/snooze",
            "inbox.snooze",
            inbox::snooze,
        ),
        api_route(
            "POST",
            "/inbox/conversations/{conversation_id}/unsnooze",
            "inbox.unsnooze",
            inbox::unsnooze,
        ),
        api_route(
            "POST",
            "/inbox/conversations/{conversation_id}/close",
            "inbox.close",
            inbox::close,
        ),
        api_route(
            "POST",
            "/inbox/conversations/{conversation_id}/reply",
            "inbox.reply",
            inbox::reply,
        ),
        api_route(
            "GET",
            "/inbox/merges",
            "inbox.merges.list",
            inbox::merges_list,
        ),
        api_route(
            "POST",
            "/inbox/merges/{merge_id}/apply",
            "inbox.merges.apply",
            inbox::merges_apply,
        ),
        api_route(
            "POST",
            "/inbox/merges/{merge_id}/undo",
            "inbox.merges.undo",
            inbox::merges_undo,
        ),
        api_route(
            "POST",
            "/inbox/merges/{merge_id}/refuse",
            "inbox.merges.refuse",
            inbox::merges_refuse,
        ),
        api_route(
            "POST",
            "/inbox/journeys/{journey_id}/tasks",
            "inbox.tasks.create",
            inbox::tasks_create,
        ),
        api_route(
            "POST",
            "/inbox/tasks/{task_id}/complete",
            "inbox.tasks.complete",
            inbox::tasks_complete,
        ),
        api_route("GET", "/inbox/tasks", "inbox.tasks.list", inbox::tasks_list),
        api_route(
            "POST",
            "/inbox/journeys/{journey_id}/notes",
            "inbox.notes.add",
            inbox::notes_add,
        ),
        api_route(
            "PUT",
            "/inbox/status-labels",
            "inbox.status_labels.set",
            inbox::status_labels_set,
        ),
        api_route(
            "GET",
            "/inbox/people",
            "inbox.people.search",
            inbox::people_search,
        ),
        api_route(
            "GET",
            "/inbox/people/{person_id}",
            "inbox.people.get",
            inbox::people_get,
        ),
        api_route(
            "POST",
            "/inbox/people",
            "inbox.people.create",
            inbox::people_create,
        ),
        api_route(
            "POST",
            "/inbox/people/{person_id}/identities",
            "inbox.identities.add",
            inbox::identities_add,
        ),
        api_route(
            "POST",
            "/inbox/people/{person_id}/journeys",
            "inbox.journeys.open",
            inbox::journeys_open,
        ),
        api_route(
            "POST",
            "/inbox/journeys/{journey_id}/events",
            "inbox.events.report",
            inbox::events_report,
        ),
        api_route(
            "GET",
            "/inbox/lost-reasons",
            "inbox.lost_reasons.list",
            inbox::lost_reasons_list,
        ),
        api_route(
            "PUT",
            "/inbox/lost-reasons",
            "inbox.lost_reasons.set",
            inbox::lost_reasons_set,
        ),
        api_route(
            "GET",
            "/inbox/journeys/{journey_id}",
            "inbox.journeys.get",
            inbox::journeys_get,
        ),
        api_route(
            "POST",
            "/inbox/journeys/{journey_id}/owner",
            "inbox.journeys.assign_owner",
            inbox::journeys_assign_owner,
        ),
        api_route("POST", "/auth/register", "auth.register", auth::register),
        api_route("POST", "/auth/login", "auth.login", auth::login),
        api_route("POST", "/auth/logout", "auth.logout", auth::logout),
        api_route("GET", "/auth/me", "auth.me", auth::me),
        api_route(
            "POST",
            "/auth/switch-workspace",
            "workspace.switch",
            auth::switch_workspace,
        ),
        api_route("GET", "/billing", "billing.status", billing::status),
        api_route(
            "POST",
            "/billing/payments",
            "billing.report_payment",
            billing::report_payment,
        ),
        api_route("GET", "/workspace", "workspace.info", workspace::info),
        api_route("GET", "/team", "team.list", team::list),
        api_route("POST", "/team/invites", "team.invite", team::invite),
        api_route(
            "POST",
            "/team/invites/accept",
            "team.accept_invite",
            team::accept,
        ),
        api_route(
            "PATCH",
            "/team/{membership_id}/role",
            "team.set_role",
            team::set_role,
        ),
        api_route(
            "DELETE",
            "/team/{membership_id}",
            "team.remove",
            team::remove,
        ),
        api_route("GET", "/roles", "roles.list", roles::list),
        api_route("POST", "/roles", "roles.create", roles::create),
        api_route("PATCH", "/roles/{role_id}", "roles.update", roles::update),
        api_route("DELETE", "/roles/{role_id}", "roles.delete", roles::delete),
        api_route("POST", "/api-keys", "api_keys.create", api_keys::create),
        api_route("GET", "/api-keys", "api_keys.list", api_keys::list),
        api_route(
            "DELETE",
            "/api-keys/{key_id}",
            "api_keys.revoke",
            api_keys::revoke,
        ),
        api_route("GET", "/agents", "agents.list", agents::list),
        api_route("GET", "/whoami", "agents.whoami", agents::whoami),
        api_route("GET", "/ledger", "ledger.list", ledger::list),
        api_route("GET", "/strategy", "strategy.get", strategy::get),
        api_route(
            "POST",
            "/strategy/consultation",
            "strategy.start_consultation",
            strategy::start_consultation,
        ),
        api_route(
            "POST",
            "/strategy/consultation/entries",
            "strategy.record",
            strategy::record,
        ),
        api_route(
            "PUT",
            "/strategy/draft/sections/{section_key}",
            "strategy.write_section",
            strategy::write_section,
        ),
        api_route(
            "PUT",
            "/strategy/draft/hypotheses",
            "strategy.set_hypotheses",
            strategy::set_hypotheses,
        ),
        api_route(
            "POST",
            "/strategy/draft/submit",
            "strategy.submit",
            strategy::submit,
        ),
        api_route(
            "POST",
            "/strategy/draft/approve",
            "strategy.approve",
            strategy::approve,
        ),
        api_route(
            "POST",
            "/strategy/archive",
            "strategy.archive",
            strategy::archive,
        ),
        api_route(
            "GET",
            "/strategy/versions",
            "strategy.list_versions",
            strategy::list_versions,
        ),
        api_route(
            "GET",
            "/strategy/versions/{version_id}/consultation",
            "strategy.consultation",
            strategy::consultation,
        ),
        api_route(
            "GET",
            "/capabilities",
            "capability.list",
            capabilities::list,
        ),
        api_route(
            "GET",
            "/capabilities/{capability_id}",
            "capability.get",
            capabilities::get,
        ),
        api_route(
            "POST",
            "/capabilities",
            "capability.declare",
            capabilities::declare,
        ),
        api_route(
            "PATCH",
            "/capabilities/{capability_id}",
            "capability.update",
            capabilities::update,
        ),
        api_route(
            "POST",
            "/capabilities/{capability_id}/verify",
            "capability.verify",
            capabilities::verify,
        ),
        api_route(
            "POST",
            "/capabilities/{capability_id}/unreachable",
            "capability.mark_unreachable",
            capabilities::mark_unreachable,
        ),
        api_route(
            "PUT",
            "/capabilities/{capability_id}/policy",
            "capability.set_policy",
            capabilities::set_policy,
        ),
        api_route(
            "POST",
            "/capabilities/{capability_id}/retire",
            "capability.retire",
            capabilities::retire,
        ),
        api_route(
            "POST",
            "/capabilities/{capability_id}/budget-links",
            "capability.link_budget",
            capabilities::link_budget,
        ),
        api_route(
            "DELETE",
            "/capabilities/{capability_id}/budget-links/{budget_item_id}",
            "capability.unlink_budget",
            capabilities::unlink_budget,
        ),
        api_route(
            "GET",
            "/capability-groups",
            "capability.groups.list",
            groups::list,
        ),
        api_route(
            "POST",
            "/capability-groups",
            "capability.groups.create",
            groups::create,
        ),
        api_route(
            "PATCH",
            "/capability-groups/{group_id}",
            "capability.groups.rename",
            groups::rename,
        ),
        api_route(
            "DELETE",
            "/capability-groups/{group_id}",
            "capability.groups.delete",
            groups::delete,
        ),
        api_route(
            "POST",
            "/capability-groups/{group_id}/members",
            "capability.groups.add_member",
            groups::add_member,
        ),
        api_route(
            "DELETE",
            "/capability-groups/{group_id}/members/{capability_id}",
            "capability.groups.remove_member",
            groups::remove_member,
        ),
        api_route(
            "GET",
            "/budget/items",
            "budget.items.list",
            budget::list_items,
        ),
        api_route(
            "POST",
            "/budget/items",
            "budget.items.create",
            budget::create_item,
        ),
        api_route(
            "PATCH",
            "/budget/items/{budget_item_id}",
            "budget.items.update",
            budget::update_item,
        ),
        api_route(
            "POST",
            "/budget/items/{budget_item_id}/retire",
            "budget.items.retire",
            budget::retire_item,
        ),
        api_route(
            "POST",
            "/budget/items/{budget_item_id}/spend",
            "budget.spend.record",
            budget::record_spend,
        ),
        api_route(
            "GET",
            "/budget/items/{budget_item_id}/spend",
            "budget.spend.list",
            budget::spend,
        ),
        api_route(
            "POST",
            "/connectors/oauth/start",
            "connector.start_oauth",
            connector::start_oauth,
        ),
        api_route(
            "GET",
            "/connectors/oauth/callback/{provider}",
            "connector.complete_oauth",
            oauth_callback::callback,
        ),
        api_route(
            "POST",
            "/connectors/oauth/{pending_id}/confirm",
            "connector.confirm_assets",
            connector::confirm_assets,
        ),
        api_route(
            "POST",
            "/connectors/credentials",
            "connector.set_credentials",
            connector::set_credentials,
        ),
        api_route(
            "POST",
            "/connectors/{capability_id}/probe",
            "connector.probe",
            connector::probe,
        ),
        api_route(
            "GET",
            "/connectors/health",
            "connector.health",
            connector::health,
        ),
        api_route(
            "POST",
            "/connectors/{capability_id}/reconnect",
            "connector.reconnect",
            connector::reconnect,
        ),
        api_route(
            "GET",
            "/connectors/hooks",
            "connector.hooks",
            connector::hooks,
        ),
        api_route("GET", "/events/pending", "events.pending", events::pending),
        api_route("POST", "/events/ack", "events.ack", events::ack),
        api_route("GET", "/events", "events.list", events::list),
        api_route("GET", "/work/pending", "work.pending", work::pending),
        api_route(
            "PUT",
            "/work/checkin-interval",
            "work.set_checkin_interval",
            work::set_checkin_interval,
        ),
        api_route("POST", "/platform/login", "platform.login", platform::login),
        api_route(
            "GET",
            "/platform/workspaces",
            "platform.workspaces.list",
            platform::list_workspaces,
        ),
        api_route(
            "PATCH",
            "/platform/workspaces/{workspace_id}/status",
            "platform.workspaces.set_status",
            platform::set_status,
        ),
    ]
}

/// The routes outside the API.
pub fn root_routes() -> Vec<RootRoute> {
    vec![root_route("GET", "/healthz", healthz)]
}

/// The catalog entry of `route`'s use case.
///
/// # Panics
///
/// When `catalog` has no use case with the route's id, or that use case's panel route is not
/// the route's method and full path, so a route the catalog does not describe stops the server
/// at startup instead of failing its requests.
pub fn resolve(route: &ApiRoute, catalog: &[UseCase]) -> UseCase {
    let (method, path, id) = (
        route.method,
        format!("{API_PREFIX}{}", route.path),
        route.use_case,
    );
    let Some(use_case) = catalog.iter().find(|uc| uc.id == id) else {
        panic!("route {method} {path} names use case `{id}`, which is not in the catalog");
    };
    if use_case.panel_route != Some((method, path.as_str())) {
        panic!(
            "route {method} {path} names use case `{id}`, whose catalog panel route is {:?}",
            use_case.panel_route
        );
    }
    *use_case
}

/// `200 {"ok":true}` while the process serves requests.
async fn healthz() -> Json<Value> {
    Json(json!({ "ok": true }))
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode, header};
    use jt_app::gate::NoStrategyYet;
    use jt_app::usecases::Deps;
    use jt_app::usecases::strategy::{NoChannelsYet, NoopArchivedHook};
    use jt_testkit::fakes::{
        FakeAppConfig, FixedClock, FixedTokenGen, InMemoryUow, PlainHasher, PlainSecretBox,
        RecordingTenantHosts, ScriptedRegistry, SeqIdGen,
    };
    use time::macros::datetime;
    use tower::ServiceExt;

    use super::*;
    use crate::router;

    fn registered() -> Vec<(&'static str, String)> {
        let api = api_routes()
            .into_iter()
            .map(|r| (r.method, format!("{API_PREFIX}{}", r.path)));
        let root = root_routes()
            .into_iter()
            .map(|r| (r.method, r.path.to_owned()));
        api.chain(root).collect()
    }

    #[tokio::test]
    async fn router_matches_routes_table() {
        // The router registers exactly the table's entries, each once.
        let table: Vec<(&str, String)> =
            ROUTES.iter().map(|(m, p)| (*m, (*p).to_owned())).collect();
        assert_eq!(registered(), table);
        let unique: BTreeSet<_> = table.iter().collect();
        assert_eq!(unique.len(), table.len(), "no route is listed twice");

        // And each entry is really served with its method (a `GET` also with `HEAD`): no 404
        // or 405 from the fallbacks. Building the router also resolves every API route's use
        // case in the catalog.
        let state = AppState {
            deps: Deps {
                uow: Arc::new(InMemoryUow::new()),
                clock: Arc::new(FixedClock(datetime!(2026-10-22 09:00 UTC))),
                ids: Arc::new(SeqIdGen::new()),
                tokens: Arc::new(FixedTokenGen::new(["t1", "t2", "t3"])),
                hasher: Arc::new(PlainHasher),
                seal: Arc::new(PlainSecretBox),
                channels: Arc::new(NoChannelsYet),
                file_maintenance: Arc::new(jt_app::ports::files::NoFileMaintenance),
                media_fetch: Arc::new(jt_app::ports::files::UnavailableMediaFetcher),
                files: Arc::new(jt_app::ports::files::UnavailableFileStore),
                transition_hook: Arc::new(jt_app::ports::studio::NoStrategyTransition),
                archived_hook: Arc::new(NoopArchivedHook),
                hosts: Arc::new(RecordingTenantHosts::new()),
                apps: Arc::new(FakeAppConfig::default()),
                connectors: Arc::new(ScriptedRegistry::new()),
                billing: jt_app::usecases::billing::BillingConfig {
                    price_minor: 123,
                    price_currency: "TRY".into(),
                    bank_instructions: "Synthetic bank instructions".into(),
                },
                job_lock: Arc::new(jt_testkit::fakes::FakeJobLock::new()),
            },
            gate: Arc::new(NoStrategyYet),
            cookie_secure: false,
            panel_dir: None,
        };
        let app = router(state);
        let with_head = ROUTES.iter().flat_map(|&(method, path)| {
            let head = (method == "GET").then_some(("HEAD", path));
            std::iter::once((method, path)).chain(head)
        });
        for (method, path) in with_head {
            let req = Request::builder()
                .method(method)
                .uri(path)
                .header("x-requested-with", "jeeta-panel")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from("{}"))
                .unwrap();
            let status = app.clone().oneshot(req).await.unwrap().status();
            assert!(
                status != StatusCode::NOT_FOUND && status != StatusCode::METHOD_NOT_ALLOWED,
                "{method} {path} answered {status}"
            );
        }
    }
}
