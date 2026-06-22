import type { WorkflowGoal, WorkflowStep, WorkflowTriggerType, WorkflowFilter } from './workflow-dsl.schema';

/**
 * A starter-automation catalog (GoHighLevel "recipes" parity). Each entry is a
 * COMPLETE, valid DSL definition (trigger + steps + optional goal) the front-end
 * pre-fills into the create form via "Start from template". The catalog is
 * static code — no DB, no per-tenant state — and every entry is validated
 * against the Zod DSL in workflow-templates.spec.ts so a malformed recipe can
 * never ship. Bodies use the same {{lead.*}} interpolation tokens as authored
 * workflows; the operator edits freely before saving.
 */
export interface WorkflowTemplate {
  /** Stable identifier (kebab-case), safe to reference from the UI. */
  key: string;
  name: string;
  description: string;
  /** Grouping label for the picker. */
  category: 'Nurture' | 'Speed to lead' | 'Reviews' | 'Appointments' | 'Sales';
  trigger: { type: WorkflowTriggerType; filters: WorkflowFilter[] };
  steps: WorkflowStep[];
  goal?: WorkflowGoal;
}

const ONE_DAY = 86_400;
const TWO_DAYS = 172_800;
const THREE_DAYS = 259_200;

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    key: 'welcome-nurture',
    name: 'Welcome nurture (5-touch)',
    description:
      'Greets every new lead, then drips value over a few days across email and WhatsApp. Exits automatically once the lead is marked WON.',
    category: 'Nurture',
    trigger: { type: 'lead.created', filters: [] },
    steps: [
      { type: 'send_email', subject: 'Welcome to {{lead.businessName}} 👋', body: 'Hi {{lead.contactPerson}},\n\nThanks for your interest — we’re glad you’re here. Over the next few days we’ll share a few things that help you get the most out of working with us.\n\nTalk soon!' },
      { type: 'wait', mode: 'duration', seconds: ONE_DAY },
      { type: 'send_email', subject: 'Getting started', body: 'Hi {{lead.contactPerson}}, here’s the one thing most customers do first. Reply to this email if you have any questions.' },
      { type: 'wait', mode: 'duration', seconds: TWO_DAYS },
      { type: 'send_whatsapp', body: 'Hi {{lead.contactPerson}} 👋 just checking in — is there anything I can help you with?' },
      { type: 'create_task', title: 'Personal follow-up with {{lead.contactPerson}}', dueInHours: 24 },
    ],
    goal: { filters: [{ field: 'lead.status', op: 'eq', value: 'WON' }], onMet: 'exit' },
  },
  {
    key: 'speed-to-lead',
    name: 'Speed to lead (instant reply)',
    description:
      'Replies to a brand-new lead by SMS within seconds, then waits for a reply (up to a day) and pings a rep if they go quiet.',
    category: 'Speed to lead',
    trigger: { type: 'lead.created', filters: [] },
    steps: [
      { type: 'send_sms', body: 'Hi {{lead.contactPerson}}, thanks for reaching out to {{lead.businessName}}! A team member will be in touch shortly. Reply here any time.' },
      { type: 'wait', mode: 'until_reply', timeoutSeconds: ONE_DAY },
      { type: 'notify_user', message: 'New lead {{lead.contactPerson}} has not replied in 24h — follow up.' },
      { type: 'create_task', title: 'Call {{lead.contactPerson}} ({{lead.businessName}})', dueInHours: 4 },
    ],
  },
  {
    key: 'review-request',
    name: 'Review request',
    description:
      'After a job is marked complete, waits a day, asks for a review, and sends a gentle email reminder a few days later.',
    category: 'Reviews',
    trigger: { type: 'task.completed', filters: [] },
    steps: [
      { type: 'wait', mode: 'duration', seconds: ONE_DAY },
      { type: 'send_review_request' },
      { type: 'wait', mode: 'duration', seconds: THREE_DAYS },
      { type: 'send_email', subject: 'We’d love your feedback', body: 'Hi {{lead.contactPerson}}, if you have a moment we’d really appreciate a quick review — it helps a lot. Thank you!' },
    ],
  },
  {
    key: 'appointment-reminder',
    name: 'Appointment confirmation + reminder',
    description:
      'Confirms a new booking on WhatsApp, then sends an SMS reminder the next day so no-shows drop.',
    category: 'Appointments',
    trigger: { type: 'booking.created', filters: [] },
    steps: [
      { type: 'send_whatsapp', body: 'Hi {{lead.contactPerson}}, your appointment is booked ✅ See you soon!' },
      { type: 'wait', mode: 'duration', seconds: ONE_DAY },
      { type: 'send_sms', body: 'Reminder: your appointment with {{lead.businessName}} is coming up. Reply here if you need to reschedule.' },
    ],
  },
  {
    key: 'won-onboarding',
    name: 'New customer onboarding',
    description:
      'Fires when a deal is won: tags the contact as a customer, sends a welcome email, and opens an onboarding task for the team.',
    category: 'Sales',
    trigger: { type: 'opportunity.won', filters: [] },
    steps: [
      { type: 'add_tag', tag: 'customer' },
      { type: 'send_email', subject: 'Welcome aboard 🎉', body: 'Hi {{lead.contactPerson}}, welcome to {{lead.businessName}}! Here’s what happens next…' },
      { type: 'create_task', title: 'Onboard {{lead.contactPerson}}', dueInHours: 48 },
    ],
  },
];

/** Public, summary-shaped catalog (full definitions are inlined by the picker). */
export function listWorkflowTemplates(): WorkflowTemplate[] {
  return WORKFLOW_TEMPLATES;
}
