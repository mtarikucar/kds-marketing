/** Trigger event types the workflow engine recognises.
 *
 *  Source of truth: `backend/src/modules/marketing/workflows/workflow-dsl.schema.ts`.
 *  Keep the order and the comments aligned with it — a type the backend accepts
 *  but this array omits makes the workflow UNEDITABLE here (the Select has no
 *  matching item, so it renders blank and a save rewrites the trigger), which
 *  is exactly how `link.clicked`, `webhook.received` and `certificate.issued`
 *  became invisible. `constants.test.ts` fails on the next drift. */
export const TRIGGER_TYPES = [
  'lead.created',
  'lead.status_changed',
  'conversation.message.received',
  'form.submitted',
  'booking.created',
  'review.received',
  'task.completed',
  'tag.added',
  'opportunity.created',
  'opportunity.stage_changed',
  'opportunity.won',
  'opportunity.lost',
  // Standalone trigger link clicked (GHL parity). Filter on trigger.triggerLinkId,
  // e.g. [{"field":"trigger.triggerLinkId","op":"eq","value":"<triggerLink.id>"}].
  // Never filter on trigger.slug — it is in the payload but is editable.
  'link.clicked',
  // Inbound webhook received (GHL parity). An external system POSTs to the
  // workspace's public hook URL; filter on trigger.body.<field> (the posted
  // JSON is carried under trigger.body) or trigger.webhookId.
  'webhook.received',
  // Course-completion certificate issued (memberships). Filter on trigger.courseId.
  'certificate.issued',
  // NetGSM Phase 5 — press-1 on a VOICE campaign call. Filter (JSON below)
  // on trigger.key for a specific digit, e.g. [{"field":"trigger.key","op":"eq","value":"1"}].
  'voice_keypress',
  // Campaign email engagement. Only hits that survive the machine-hit filter
  // fire these, so a mail-security scanner sweeping the links cannot start an
  // automation. `email.clicked` carries the destination: filter on trigger.url,
  // e.g. [{"field":"trigger.url","op":"contains","value":"/pricing"}].
  // `email.bounced` is deliberately absent — no writer emits it yet, and a
  // trigger that can never fire is worse than none.
  'email.opened',
  'email.clicked',
  'email.unsubscribed',
] as const;

/** Step palette groups for the builder rail. Each `type` must be a key in
 *  `NEW_STEP` (stepOps) so appending it yields a valid default-configured step. */
export const STEP_PALETTE: { group: string; types: string[] }[] = [
  { group: 'Send', types: ['send_email', 'send_sms', 'send_whatsapp'] },
  { group: 'AI', types: ['ai_generate', 'ai_classify'] },
  { group: 'Flow', types: ['wait', 'branch', 'stop_workflow'] },
  {
    group: 'Action',
    types: [
      'create_task', 'assign_lead', 'update_lead',
      'add_tag', 'remove_tag', 'notify_user', 'http_webhook_out', 'send_review_request',
    ],
  },
];

/** Status values + the list filter chip set. */
export const WORKFLOW_STATUSES = ['ALL', 'ACTIVE', 'PAUSED', 'DRAFT'] as const;
