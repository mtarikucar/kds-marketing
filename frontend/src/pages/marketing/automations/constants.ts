/** Trigger event types the workflow engine recognises (mirrors the backend). */
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
  // NetGSM Phase 5 — press-1 on a VOICE campaign call. Filter (JSON below)
  // on trigger.key for a specific digit, e.g. [{"field":"trigger.key","op":"eq","value":"1"}].
  'voice_keypress',
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
