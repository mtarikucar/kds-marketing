import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { LeadBulkService } from '../../inbox/lead-bulk.service';
import { WorkflowsService } from '../../workflows/workflows.service';
import { assertFeature } from '../mcp-feature-gate';
import { McpPrincipalService } from '../mcp-principal.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface WorkflowToolDeps {
  workflows: WorkflowsService;
  /** The product's only manual-execution path — see `jeeta.trigger_workflow`. */
  leadBulk: LeadBulkService;
  principals: McpPrincipalService;
  entitlements: EntitlementsService;
}

/** Free-form JSON node. The workflow DSL is validated by `WorkflowsService`
 *  with the same Zod schema the REST route uses, so declaring the full DSL a
 *  second time here would be a copy that can drift. The tool declares SHAPE
 *  (object / array of objects, bounded) and lets the service own MEANING. */
const jsonObject = z.record(z.string(), z.unknown());

/**
 * Faz 5 D4 — marketing automations (workflows).
 *
 * ## The two-verb split
 * Authoring an automation and ARMING it are separate acts with very different
 * blast radii, and the catalogue keeps them separate:
 *
 *  - `jeeta.create_workflow` writes a DRAFT. `WorkflowsService.create`
 *    hardcodes `status: 'DRAFT'` and `WorkflowTriggerService` only ever starts
 *    `status: 'ACTIVE'` workflows, so a created workflow is inert by
 *    construction — nothing is exposed here that could ask for anything else.
 *    Unattended, like every other draft-authoring tool in the catalogue.
 *  - `jeeta.set_workflow_enabled` is the gated verb. Arming an automation is
 *    not one send: it is a standing instruction that will email/SMS/WhatsApp
 *    every future lead that matches its trigger, spend AI credits on
 *    `ai_generate`/`ai_classify` steps and call out over `http_webhook_out`,
 *    unattended and indefinitely. That is `PUBLISH`-class in the spec's terms:
 *    approval-gated by default, and (like `jeeta.schedule_social_post`)
 *    runnable inline by a workspace that has explicitly opted into AUTONOMOUS.
 *
 *    The gate is symmetric — disabling is queued in APPROVAL mode too, which is
 *    the one wart in this group. It is accepted deliberately rather than
 *    special-cased: `requiresApproval` is a property of the TOOL, not of an
 *    argument, and inventing per-argument gating in the broker for one tool
 *    would put policy back in the tool layer that the whole design keeps in the
 *    broker. Stopping a runaway automation instantly stays a one-click action
 *    in the panel, which is where an operator reacting to a runaway already is.
 *
 * ## `jeeta.trigger_workflow` is SPEND
 * There is no "run this workflow" REST route: the product's only manual
 * execution path is enrolling LEADS into it (`LeadBulkService.bulkEnroll`,
 * behind `leads.manage` in the panel). That is what this tool does, and it is
 * why the tool takes lead ids rather than a bare workflow id. What follows is
 * real: `WorkflowActionHandler` sends email/SMS/WhatsApp/web-chat, reserves AI
 * credits per generate/classify step and performs outbound HTTP — once per
 * enrolled lead. Money and messages both leave the workspace, so it is `SPEND`:
 * queued for a human in every write mode.
 */
export function registerWorkflowTools(registry: McpToolRegistry, deps: WorkflowToolDeps): void {
  registry.register({
    name: 'jeeta.list_workflows',
    description:
      'List this workspace\'s marketing automations with their status (DRAFT = never armed, ACTIVE = running, PAUSED = stopped), trigger, goal and run statistics. Read-only.',
    domain: 'workflows',
    scopes: ['automations.manage'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'workflows');
      return deps.workflows.list(ctx.workspaceId);
    },
  });

  registry.register({
    name: 'jeeta.get_workflow',
    description:
      'Read one automation in full: its trigger (which event starts it, and the filters that must match) and its ordered steps. Read-only.',
    domain: 'workflows',
    // Deferred (spec §3): the detail read behind `jeeta.list_workflows`.
    defer: true,
    scopes: ['automations.manage'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      workflowId: z.string().min(1).describe('Id from jeeta.list_workflows.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'workflows');
      return deps.workflows.get(ctx.workspaceId, String(args.workflowId ?? ''));
    },
  });

  registry.register({
    name: 'jeeta.create_workflow',
    description:
      'Create a marketing automation as a DRAFT: a trigger (which event starts it, plus filters) and the ordered steps to run. It is created switched OFF and will not fire for anyone until it is armed with jeeta.set_workflow_enabled, which needs a human approval. The definition is validated against the automation DSL, so an invalid trigger or step is refused with an explanation.',
    domain: 'workflows',
    // Deferred (spec §3): a large, occasional authoring call.
    defer: true,
    scopes: ['automations.manage'],
    risk: 'WRITE',
    requiresApproval: false,
    inputSchema: z.object({
      name: z.string().min(1).max(120).describe('Automation name, for the panel.'),
      description: z.string().max(500).optional().describe('What this automation is for.'),
      trigger: jsonObject.describe(
        'What starts the automation: { "type": <trigger type, e.g. "lead.created">, "filters": [{ "field": "lead.city", "op": "eq", "value": "Istanbul" }] }. Call jeeta.get_workflow on an existing automation to see valid trigger types and filter shapes.',
      ),
      steps: z
        .array(jsonObject)
        .min(1)
        .max(100)
        .describe(
          'Ordered steps, each an object with a "type" (send_email, send_sms, ai_generate, branch, wait, create_task, assign_lead, update_lead, notify_user, http_webhook_out, stop_workflow, …) plus that type\'s fields.',
        ),
      goal: jsonObject.optional().describe('Optional goal/exit condition for the automation.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'workflows');
      // No status/enabled field is forwarded (or accepted — the registry makes
      // every schema strict, so an undeclared one is an error, not a silently
      // dropped argument): `WorkflowsService.create` always writes DRAFT.
      return deps.workflows.create(ctx.workspaceId, {
        name: String(args.name ?? ''),
        ...(args.description !== undefined ? { description: String(args.description) } : {}),
        trigger: args.trigger,
        steps: args.steps,
        ...(args.goal !== undefined ? { goal: args.goal } : {}),
      });
    },
  });

  registry.register({
    name: 'jeeta.set_workflow_enabled',
    description:
      'Arm or stop a marketing automation. Arming it means every future lead matching its trigger is processed unattended — that can send email/SMS/WhatsApp, spend AI credits and call external webhooks indefinitely — so this requires a human approval. Arming also re-validates the definition and is refused if it is invalid.',
    domain: 'workflows',
    // Deferred (spec §3): armed once, then rarely touched.
    defer: true,
    scopes: ['automations.manage'],
    risk: 'WRITE',
    requiresApproval: true,
    approvalKind: 'CHANNEL_LAUNCH',
    resourceType: 'workflow',
    resourceIdFrom: (args) => (typeof args.workflowId === 'string' ? args.workflowId : undefined),
    inputSchema: z.object({
      workflowId: z.string().min(1).describe('Id from jeeta.list_workflows.'),
      enabled: z
        .boolean()
        .describe('true arms the automation (status ACTIVE); false stops it (status PAUSED). Existing runs are unaffected.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'workflows');
      return deps.workflows.setStatus(
        ctx.workspaceId,
        String(args.workflowId ?? ''),
        args.enabled === true ? 'ACTIVE' : 'PAUSED',
      );
    },
  });

  registry.register({
    name: 'jeeta.trigger_workflow',
    description:
      'Run an armed automation right now over a specific set of leads (manual enrolment). Each enrolled lead is processed for real: the automation may email or message them, spend AI credits and call external webhooks. Because that reaches real people and spends real money it always requires a human approval, in every write mode including autonomous. Enrolment runs in the background; a lead already in a live run of this automation is skipped.',
    domain: 'workflows',
    // Deferred (spec §3): the rare manual override next to event triggering.
    defer: true,
    scopes: ['automations.manage'],
    risk: 'SPEND',
    requiresApproval: true,
    approvalKind: 'SEND',
    resourceType: 'workflow',
    resourceIdFrom: (args) => (typeof args.workflowId === 'string' ? args.workflowId : undefined),
    inputSchema: z.object({
      workflowId: z.string().min(1).describe('Id from jeeta.list_workflows. Must be ACTIVE.'),
      leadIds: z
        .array(z.string().min(1))
        .min(1)
        .max(200)
        .describe('Leads to enrol. Leads from another workspace, deleted or merged leads are ignored.'),
    }),
    handler: async (ctx, args) => {
      await assertFeature(deps.entitlements, ctx.workspaceId, 'workflows');
      const workflowId = String(args.workflowId ?? '');
      // `LeadBulkService.bulkEnroll` checks only that the workflow exists in
      // this workspace — a DRAFT or PAUSED automation executes in full when
      // manually enrolled. Applying the product's own "armed" predicate
      // (`WorkflowTriggerService` starts ACTIVE workflows only) before the call
      // keeps `jeeta.set_workflow_enabled`'s approval gate meaningful, rather
      // than leaving trigger as a way around it. This is the existing rule
      // applied before a service that does not apply it, not a new rule.
      const workflow = (await deps.workflows.get(ctx.workspaceId, workflowId)) as { status?: string };
      if (workflow?.status !== 'ACTIVE') {
        throw new BadRequestException(
          `automation ${workflowId} is ${workflow?.status ?? 'unknown'}, not ACTIVE — arm it with jeeta.set_workflow_enabled (which needs a human approval) before running it over real leads`,
        );
      }
      // Enrolment is attributed to a real MarketingUser: the consenting human on
      // an OAuth session, the workspace's automation principal on an API key.
      const actor = await deps.principals.resolve(ctx);
      return deps.leadBulk.bulkEnroll(ctx.workspaceId, args.leadIds as string[], workflowId, actor.id);
    },
  });
}
