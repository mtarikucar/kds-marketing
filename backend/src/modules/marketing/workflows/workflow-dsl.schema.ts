import { z } from 'zod';

/**
 * The workflow DSL — executable-simple JSON validated here at every API
 * boundary AND before the executor runs it. Deliberately NOT a general
 * language: a fixed trigger + an ordered, capped step list with whitelisted
 * filter fields and safe token interpolation (no eval/handlebars). Shared with
 * Campaign audience filters (P4) via the Filter schema.
 */

export const TRIGGER_TYPES = [
  'lead.created',
  'lead.status_changed',
  'form.submitted',
  'conversation.message.received',
  'booking.created',
  'review.received',
  'task.completed',
  // Tag automation: fires when a tag is added to a lead.
  'tag.added',
  // Opportunity / pipeline automation (GHL parity) — backed by the
  // OpportunitiesService outbox events. stage_changed is the workhorse
  // (filter on trigger.toStageId / trigger.status).
  'opportunity.created',
  'opportunity.stage_changed',
  'opportunity.won',
  'opportunity.lost',
  // Standalone trigger link clicked (GHL parity). Filter on trigger.triggerLinkId.
  'link.clicked',
  // Inbound webhook received (GHL parity). An external system POSTs to the
  // workspace's public hook URL; filter on trigger.body.<field> (the posted
  // JSON is carried under trigger.body) or trigger.webhookId.
  'webhook.received',
  // Course-completion certificate issued (memberships, Epic 10b). Filter on
  // trigger.courseId.
  'certificate.issued',
] as const;
export type WorkflowTriggerType = (typeof TRIGGER_TYPES)[number];

export const FILTER_OPS = ['eq', 'neq', 'in', 'contains', 'gte', 'lte', 'exists'] as const;

// Filter fields are whitelisted to the read-only context roots the evaluator
// knows how to resolve — never arbitrary object paths.
const FIELD_RE = /^(lead|trigger|context)\.[a-zA-Z0-9_.]{1,60}$/;

export const FilterSchema = z.object({
  field: z.string().regex(FIELD_RE),
  op: z.enum(FILTER_OPS),
  value: z.any().optional(),
});
export type WorkflowFilter = z.infer<typeof FilterSchema>;

const sendStep = <T extends string>(type: T) =>
  z.object({
    type: z.literal(type),
    /** Channel id or null = the lead's default for this kind. */
    channelId: z.string().max(64).optional(),
    subject: z.string().max(200).optional(),
    body: z.string().min(1).max(8000),
  });

const StepSchema = z.discriminatedUnion('type', [
  sendStep('send_email'),
  sendStep('send_sms'),
  sendStep('send_whatsapp'),
  sendStep('send_webchat'),
  z.object({
    type: z.literal('ai_generate'),
    prompt: z.string().min(1).max(4000),
    /** Context key the generated text is saved under for later steps. */
    saveAs: z.string().max(60).default('ai_output'),
  }),
  z
    .object({
      type: z.literal('ai_classify'),
      prompt: z.string().min(1).max(4000),
      categories: z.array(z.string().max(60)).min(2).max(10),
      /** category → step index to jump to. */
      routes: z.record(z.string(), z.number().int().nonnegative()).optional(),
    })
    // Every route key must be one of the declared categories — a route keyed on
    // a non-category can never fire (aiClassify only looks up routes[picked]
    // where picked ∈ categories), so it's a config error worth rejecting.
    .refine(
      (s) =>
        !s.routes ||
        Object.keys(s.routes).every((k) => s.categories.includes(k)),
      { message: 'ai_classify routes keys must all be declared categories', path: ['routes'] },
    ),
  z.object({
    type: z.literal('branch'),
    filters: z.array(FilterSchema).max(20),
    /** Step index to jump to when the filters DON'T match (default = end). */
    elseGoto: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('wait'),
    mode: z.enum(['duration', 'until_reply']),
    /** Required for mode=duration. 60s..30d. */
    seconds: z.number().int().min(60).max(2_592_000).optional(),
    /** Cap for until_reply so a silent lead doesn't wait forever. */
    timeoutSeconds: z.number().int().min(60).max(2_592_000).optional(),
  }),
  z.object({
    type: z.literal('create_task'),
    title: z.string().min(1).max(200),
    dueInHours: z.number().int().min(0).max(8760).optional(),
  }),
  z.object({
    type: z.literal('assign_lead'),
    strategy: z.enum(['auto', 'user']).default('auto'),
    userId: z.string().max(64).optional(),
  }),
  z.object({
    type: z.literal('update_lead'),
    /** Whitelisted scalar fields only (status/priority/notes/...). */
    set: z.record(z.string().max(40), z.any()),
  }),
  z.object({
    type: z.literal('notify_user'),
    message: z.string().min(1).max(500),
  }),
  z.object({
    type: z.literal('http_webhook_out'),
    url: z.string().max(2000),
    payload: z.any().optional(),
  }),
  z.object({ type: z.literal('start_workflow'), workflowId: z.string().max(64) }),
  z.object({ type: z.literal('stop_workflow') }),
  z.object({ type: z.literal('send_review_request') }), // wired in P6
  // Tag automation (GHL parity): add/remove a tag on the lead by name. add_tag
  // resolves-or-creates the tag (idempotent); remove_tag is a no-op if absent.
  z.object({ type: z.literal('add_tag'), tag: z.string().min(1).max(60) }),
  z.object({ type: z.literal('remove_tag'), tag: z.string().min(1).max(60) }),
]);
export type WorkflowStep = z.infer<typeof StepSchema>;

export const TriggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES),
  filters: z.array(FilterSchema).max(20).default([]),
});
export type WorkflowTrigger = z.infer<typeof TriggerSchema>;

/**
 * A workflow goal (GoHighLevel parity): when the subject reaches a target state
 * (the filter set matches), the run short-circuits — either leaving the workflow
 * (`onMet: 'exit'`) or jumping ahead to `gotoStep`. Evaluated before every step
 * so a state change between waits is honoured at the next checkpoint. The goto
 * target is bounds-checked against steps.length at the top level (like the
 * ai_classify routes). A persistently-true `goto` goal that points backward is a
 * config-level cycle, bounded by the executor's per-run goto-jump cap
 * (MAX_GOAL_JUMPS_PER_RUN, which survives wait/resume checkpoints) so the run
 * fails fast rather than re-firing forever.
 */
export const GoalSchema = z
  .object({
    filters: z.array(FilterSchema).min(1).max(20),
    onMet: z.enum(['exit', 'goto']).default('exit'),
    /** Required when onMet === 'goto'. Step index to jump to. */
    gotoStep: z.number().int().nonnegative().optional(),
  })
  .refine((g) => g.onMet !== 'goto' || g.gotoStep != null, {
    message: 'goal.gotoStep is required when onMet is "goto"',
    path: ['gotoStep'],
  });
export type WorkflowGoal = z.infer<typeof GoalSchema>;

export const WorkflowDslSchema = z
  .object({
    version: z.number().int().default(1),
    trigger: TriggerSchema,
    steps: z.array(StepSchema).min(1).max(100), // hard 100-step/run cap
    /** Optional goal: short-circuit the run when the subject hits a target state. */
    goal: GoalSchema.optional(),
  })
  // Every ai_classify route target must point at a real step index (< steps.length).
  // steps.length is only reachable here at the top level, so the in-bounds check
  // lives here (the per-step refine above only constrains keys ⊆ categories).
  .refine(
    (dsl) =>
      dsl.steps.every(
        (s) =>
          s.type !== 'ai_classify' ||
          !s.routes ||
          Object.values(s.routes).every((idx) => idx < dsl.steps.length),
      ),
    { message: 'ai_classify route targets must be valid step indexes (< steps.length)', path: ['steps'] },
  )
  // A goto goal must point at a real step index (same bounds rule as ai_classify).
  .refine(
    (dsl) => dsl.goal?.onMet !== 'goto' || (dsl.goal.gotoStep ?? -1) < dsl.steps.length,
    { message: 'goal.gotoStep must be a valid step index (< steps.length)', path: ['goal', 'gotoStep'] },
  )
  // A branch.elseGoto must point at a real step index too — an out-of-bounds
  // value otherwise lands on the executor's stepIndex>=length guard and silently
  // ENDS the run as DONE instead of branching (same bounds rule as ai_classify).
  .refine(
    (dsl) =>
      dsl.steps.every(
        (s) => s.type !== 'branch' || s.elseGoto == null || s.elseGoto < dsl.steps.length,
      ),
    { message: 'branch.elseGoto must be a valid step index (< steps.length)', path: ['steps'] },
  );
export type WorkflowDsl = z.infer<typeof WorkflowDslSchema>;

/** Max trigger-chain depth (a workflow that starts another). */
export const MAX_WORKFLOW_DEPTH = 3;

export function parseWorkflowDsl(input: unknown): WorkflowDsl {
  return WorkflowDslSchema.parse(input);
}

/** Validate a (trigger, steps, goal?) tuple as stored on the Workflow row. */
export function parseWorkflowParts(trigger: unknown, steps: unknown, goal?: unknown): WorkflowDsl {
  return WorkflowDslSchema.parse({
    version: 1,
    trigger,
    steps,
    ...(goal == null ? {} : { goal }),
  });
}
