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
  z.object({
    type: z.literal('ai_classify'),
    prompt: z.string().min(1).max(4000),
    categories: z.array(z.string().max(60)).min(2).max(10),
    /** category → step index to jump to. */
    routes: z.record(z.string(), z.number().int().nonnegative()).optional(),
  }),
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
]);
export type WorkflowStep = z.infer<typeof StepSchema>;

export const TriggerSchema = z.object({
  type: z.enum(TRIGGER_TYPES),
  filters: z.array(FilterSchema).max(20).default([]),
});
export type WorkflowTrigger = z.infer<typeof TriggerSchema>;

export const WorkflowDslSchema = z.object({
  version: z.number().int().default(1),
  trigger: TriggerSchema,
  steps: z.array(StepSchema).min(1).max(100), // hard 100-step/run cap
});
export type WorkflowDsl = z.infer<typeof WorkflowDslSchema>;

/** Max trigger-chain depth (a workflow that starts another). */
export const MAX_WORKFLOW_DEPTH = 3;

export function parseWorkflowDsl(input: unknown): WorkflowDsl {
  return WorkflowDslSchema.parse(input);
}

/** Validate a (trigger, steps) pair as stored on the Workflow row. */
export function parseWorkflowParts(trigger: unknown, steps: unknown): WorkflowDsl {
  return WorkflowDslSchema.parse({ version: 1, trigger, steps });
}
