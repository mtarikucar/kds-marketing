# Modular agent workspace

Jeeta's entry point is an agent hub. Workspaces assemble their own work modules from portable blueprints, then choose the agents and abilities each module uses. Growth Studio, engineering, and legal work are examples, not a closed taxonomy.

## Three layers

| Layer | What it represents | Examples |
| --- | --- | --- |
| Agent connection | A recorded external client's connection to this workspace | Codex, Claude, another MCP client |
| Work module | A purpose, workflow, brief, agent assignments, and selected abilities | Growth Studio, procurement, quality assurance, legal review |
| Ability | A service, device, resource, or action available to the workspace | Instagram, email, CAD software, phone control, a connected peripheral |

An assignment describes the intended working relationship. It does not issue credentials, grant permissions, start an external agent, or make an unsupported integration executable. Existing authorization and action approval policies continue to apply. A last-contact timestamp is not a live connection guarantee.

## Interaction model

- The hub starts with real recorded agent connections. Selecting an agent shows its assigned modules.
- Inbox and Strategy are permanent modules. All business modules beyond these can be installed or removed.
- The sidebar shows the permanent modules, installed optional modules, and an **Add module** action. Administrative tools are grouped under a disclosure.
- The catalog offers existing built-in modules and a custom blueprint editor/importer. New domains are represented by definitions rather than new hardcoded sidebar entries.
- A module's setup separates its portable workflow from workspace-specific agent and ability bindings.
- Removing a module preserves its records and bindings. It does not cancel existing schedules or revoke the agent's independent API permissions. The removal UI explains this consequence.
- The ability inventory accepts arbitrary identities through the existing generic capability kind, as well as the existing service, phone, computer, and peripheral kinds. Recording an ability and connecting a functional adapter are distinct states.

## Blueprint boundary

A portable blueprint contains `id`, `name`, `description`, `version`, `requirements`, and `workflow`. Requirements and workflow steps describe the intended work. They do not execute automatically. Unknown executable fields, navigation URLs, and workspace-specific credentials are not accepted. Agent IDs, ability IDs, and the current brief are stored separately in the tenant's module configuration and are excluded from exports.

Built-in module routes are supplied by the application. Custom modules use the generic module workspace, so importing a definition cannot inject a new route, script, or permission. Native integrations may be added independently through the existing adapter system. A future executable blueprint runtime needs its own action protocol, runner, approval, and result contract; declarative blueprints do not claim to provide those capabilities.

Module state is persisted on the server and keyed by workspace in the browser cache. Required modules are protected server-side. Configuration updates use revision checks to reject stale edits. The navigation gate is a presentation rule, not a replacement for backend authorization.

## Visual direction

- Product: a workspace where a person directs connected agents across different kinds of work.
- Character: composed, legible, operational.
- World: a shared workbench with distinct tools and responsibilities.
- Main visual moment: actual agent connections and their assigned modules; brand navy and orange retain Jeeta's identity.
- Signature: the same agent → module → ability relationship in the hub, module setup, and ability inventory.

The previous menu gave every business area equal permanent prominence, and the home screen foregrounded operational lists. The new hierarchy reduces initial choices and reveals configuration when requested. Existing IBM Plex typography, neutral surfaces, visible focus states, and restrained brand accents are retained. Mobile views stack controls in reading order; optional administration stays collapsed.

Design review follows [Unslop](https://github.com/heydamir/unslop) by Damir Sokolovsky ([@heydamir](https://x.com/heydamir)), licensed CC BY 4.0.

## Verification

Implemented with migration 32, four HTTP operations and four equivalent MCP tools. The panel's full suite passes 526 tests across 70 files. TypeScript, production panel build, native server build, and targeted Clippy checks passed. Backend checks cover module lifecycle, catalog/schema parity, tenant isolation, migration upgrade/downgrade/idempotence, HTTP permissions and status gates, and architecture contracts.

A real local PostgreSQL-backed browser exercise created a custom blueprint, attached a real registered MCP client and a custom ability, rejected stale/foreign bindings, read the registry through MCP, exported the portable definition, and removed/reinstalled the module without deleting its bindings. Eight desktop/mobile views passed without runtime exceptions, overflow, or broken images. Temporary API keys were revoked, the test ability retired, and the test module removed; their historical records remain. No external device operation, message, or social publication was performed.

Verification ran in the development environment. This change has not been deployed to staging or production. Migration 32 remains unpublished; the disposable preview database was reconciled after its definition was finalized. Existing published migration files were not modified.
