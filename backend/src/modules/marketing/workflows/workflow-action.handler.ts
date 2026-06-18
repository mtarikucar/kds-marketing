import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { EmailService } from '../../../common/services/email.service';
import { AnthropicService } from '../ai/anthropic.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { creditCost, tierFor } from '../ai/ai-credit-costs';
import { LeadAutoAssignerService } from '../services/lead-auto-assigner.service';
import { MarketingNotificationsService } from '../services/marketing-notifications.service';
import { MessageSenderService } from '../channels/message-sender.service';
import { ReviewsService } from '../reviews/reviews.service';
import { safeFetch, SsrfBlockedError } from '../../../common/util/safe-fetch';
import { WorkflowFilter, WorkflowStep, FILTER_OPS } from './workflow-dsl.schema';
import { ALLOWED_TRANSITIONS } from '../services/marketing-leads.service';

export interface WorkflowContext {
  workspaceId: string;
  lead: any | null;
  trigger: Record<string, any>;
  context: Record<string, any>;
}

/** Control signal a step can return to the executor. */
export interface StepOutcome {
  goto?: number;
  stop?: boolean;
  wait?: { seconds?: number; untilReply?: boolean; timeoutSeconds?: number };
  startWorkflowId?: string;
  output?: Record<string, unknown>;
}

const LEAD_WRITABLE = new Set([
  'status', 'priority', 'notes', 'nextFollowUp', 'businessName', 'contactPerson', 'city', 'region',
]);

/**
 * Executes a single leaf step against the run context and returns a control
 * signal (continue / goto / wait / stop / start). Leaf side-effects (send,
 * task, assign, update, notify, webhook, AI) happen here; the executor owns the
 * cursor + wait/stop/start orchestration. Token interpolation is a safe
 * whitelist replace ({{lead.x}} / {{trigger.x}} / {{context.x}}) — never eval.
 */
@Injectable()
export class WorkflowActionHandler {
  private readonly logger = new Logger(WorkflowActionHandler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
    private readonly autoAssigner: LeadAutoAssignerService,
    private readonly notifications: MarketingNotificationsService,
    private readonly sender: MessageSenderService,
    private readonly reviews: ReviewsService,
  ) {}

  async execute(step: WorkflowStep, ctx: WorkflowContext): Promise<StepOutcome> {
    switch (step.type) {
      case 'send_email':
      case 'send_sms':
      case 'send_whatsapp':
      case 'send_webchat':
        return { output: { result: await this.send(step.type, step, ctx) } };
      case 'ai_generate':
        return this.aiGenerate(step, ctx);
      case 'ai_classify':
        return this.aiClassify(step, ctx);
      case 'branch':
        return this.branch(step, ctx);
      case 'create_task':
        return { output: { result: await this.createTask(step, ctx) } };
      case 'assign_lead':
        return { output: { result: await this.assignLead(step, ctx) } };
      case 'update_lead':
        return { output: { result: await this.updateLead(step, ctx) } };
      case 'notify_user':
        return { output: { result: await this.notify(step, ctx) } };
      case 'http_webhook_out':
        return { output: { result: await this.webhook(step, ctx) } };
      case 'wait':
        return { wait: { seconds: step.seconds, untilReply: step.mode === 'until_reply', timeoutSeconds: step.timeoutSeconds } };
      case 'stop_workflow':
        return { stop: true };
      case 'start_workflow':
        return { startWorkflowId: step.workflowId };
      case 'send_review_request':
        return { output: { result: await this.reviewRequest(ctx) } };
      default:
        return { output: { result: 'unknown step' } };
    }
  }

  // ---- leaf actions ----

  private async send(type: string, step: any, ctx: WorkflowContext): Promise<string> {
    const body = this.interpolate(step.body, ctx);
    const subject = step.subject ? this.interpolate(step.subject, ctx) : undefined;
    const lead = ctx.lead;
    if (type === 'send_email') {
      if (!lead?.email) return 'skipped (no lead email)';
      await this.email.sendPlainEmail(lead.email, subject ?? 'Message', body);
      return 'email sent';
    }
    const channelType = type === 'send_sms' ? 'SMS' : type === 'send_whatsapp' ? 'WHATSAPP' : 'WEBCHAT';
    const channel = await this.prisma.channel.findFirst({
      where: { workspaceId: ctx.workspaceId, type: channelType, status: 'ACTIVE' },
    });
    if (!channel) return `skipped (no active ${channelType} channel)`;

    let conversationId: string | null = null;
    if (channelType === 'WEBCHAT') {
      const convo = await this.prisma.conversation.findFirst({
        where: { workspaceId: ctx.workspaceId, channelId: channel.id, leadId: lead?.id, status: 'OPEN' },
        orderBy: { createdAt: 'desc' },
      });
      conversationId = convo?.id ?? null;
      if (!conversationId) return 'skipped (no open web-chat session)';
    } else {
      const value = channelType === 'WHATSAPP' ? lead?.whatsapp || lead?.phone : lead?.phone;
      if (!value) return `skipped (lead has no ${channelType === 'WHATSAPP' ? 'whatsapp/phone' : 'phone'})`;
      conversationId = await this.ensureConversation(
        ctx.workspaceId, channel.id, channelType === 'WHATSAPP' ? 'WA' : 'PHONE', value, lead.id,
      );
    }
    await this.sender.send({ workspaceId: ctx.workspaceId, conversationId, text: body, authorType: 'SYSTEM' });
    return `${channelType} sent`;
  }

  private async ensureConversation(
    workspaceId: string, channelId: string, kind: string, value: string, leadId: string,
  ): Promise<string> {
    let identity = await this.prisma.contactIdentity.findUnique({
      where: { channelId_value: { channelId, value } },
    });
    if (!identity) {
      identity = await this.prisma.contactIdentity.create({
        data: { workspaceId, channelId, kind, value, leadId },
      });
    }
    let convo = await this.prisma.conversation.findFirst({
      where: { workspaceId, channelId, contactIdentityId: identity.id, status: 'OPEN' },
      orderBy: { createdAt: 'desc' },
    });
    if (!convo) {
      convo = await this.prisma.conversation.create({
        data: { workspaceId, channelId, leadId: identity.leadId, contactIdentityId: identity.id, status: 'OPEN' },
      });
    }
    return convo.id;
  }

  private async aiGenerate(step: any, ctx: WorkflowContext): Promise<StepOutcome> {
    if (!this.anthropic.isEnabled()) return { output: { result: 'skipped (AI off)' } };
    await this.credits.reserve(ctx.workspaceId, creditCost('workflow.ai_generate'));
    try {
      const res = await this.anthropic.complete({
        system: `You generate short marketing copy for an automation. Context: ${this.leadBlurb(ctx)}`,
        messages: [{ role: 'user', content: this.interpolate(step.prompt, ctx) }],
        maxTokens: 800,
        tier: tierFor('workflow.ai_generate'),
      });
      ctx.context[step.saveAs ?? 'ai_output'] = res.text;
      return { output: { [step.saveAs ?? 'ai_output']: res.text } };
    } catch (e) {
      await this.credits.refund(ctx.workspaceId, creditCost('workflow.ai_generate'));
      throw e;
    }
  }

  private async aiClassify(step: any, ctx: WorkflowContext): Promise<StepOutcome> {
    if (!this.anthropic.isEnabled() || !step.routes) return {};
    await this.credits.reserve(ctx.workspaceId, creditCost('workflow.ai_classify'));
    try {
      const cats = (step.categories as string[]).join(', ');
      const res = await this.anthropic.complete({
        system: `Classify the input into EXACTLY ONE of: ${cats}. Reply with only the category word. Context: ${this.leadBlurb(ctx)}`,
        messages: [{ role: 'user', content: this.interpolate(step.prompt, ctx) }],
        maxTokens: 16,
        tier: tierFor('workflow.ai_classify'),
      });
      const picked = (step.categories as string[]).find((c) =>
        res.text.toLowerCase().includes(c.toLowerCase()),
      );
      const goto = picked ? step.routes[picked] : undefined;
      return { goto, output: { category: picked ?? null } };
    } catch (e) {
      await this.credits.refund(ctx.workspaceId, creditCost('workflow.ai_classify'));
      throw e;
    }
  }

  private branch(step: any, ctx: WorkflowContext): StepOutcome {
    const matched = (step.filters as WorkflowFilter[]).every((f) => this.evalFilter(f, ctx));
    return matched ? {} : { goto: step.elseGoto ?? Number.MAX_SAFE_INTEGER };
  }

  private async createTask(step: any, ctx: WorkflowContext): Promise<string> {
    const assignee = ctx.lead?.assignedToId ?? (await this.autoAssigner.pickAssignee(ctx.workspaceId));
    if (!assignee) return 'skipped (no assignee for task)';
    const due = new Date(Date.now() + (step.dueInHours ?? 24) * 3600_000);
    await this.prisma.marketingTask.create({
      data: {
        workspaceId: ctx.workspaceId,
        title: this.interpolate(step.title, ctx).slice(0, 200),
        type: 'FOLLOW_UP',
        dueDate: due,
        assignedToId: assignee,
        leadId: ctx.lead?.id ?? null,
      },
    });
    return 'task created';
  }

  private async assignLead(step: any, ctx: WorkflowContext): Promise<string> {
    if (!ctx.lead?.id) return 'skipped (no lead)';
    const to = step.strategy === 'user' && step.userId
      ? step.userId
      : await this.autoAssigner.pickAssignee(ctx.workspaceId);
    if (!to) return 'skipped (no assignee)';
    await this.prisma.lead.updateMany({ where: { id: ctx.lead.id, workspaceId: ctx.workspaceId }, data: { assignedToId: to } });
    ctx.lead.assignedToId = to;
    return 'lead assigned';
  }

  private async updateLead(step: any, ctx: WorkflowContext): Promise<string> {
    if (!ctx.lead?.id) return 'skipped (no lead)';
    const data: Record<string, any> = {};
    for (const [k, v] of Object.entries(step.set ?? {})) {
      if (LEAD_WRITABLE.has(k)) data[k] = typeof v === 'string' ? this.interpolate(v, ctx) : v;
    }
    // A workflow must NEVER drive a lead into WON (that path is owned by
    // convert(), which provisions a tenant + mints a commission) or make an
    // illegal status jump that bypasses the state machine. Drop an unsafe
    // status write but keep the rest of the fields. Fails safe: if the current
    // status is unknown, the transition isn't in the map and status is dropped.
    if (data.status !== undefined) {
      const current = (ctx.lead as { status?: string }).status ?? '';
      const legal =
        data.status !== 'WON' &&
        (ALLOWED_TRANSITIONS[current] ?? []).includes(data.status as string);
      if (!legal) {
        this.logger.warn(
          `workflow update_lead: dropped illegal status ${current}→${data.status} for lead ${ctx.lead.id}`,
        );
        delete data.status;
      }
    }
    if (Object.keys(data).length === 0) return 'skipped (no writable fields)';
    await this.prisma.lead.updateMany({ where: { id: ctx.lead.id, workspaceId: ctx.workspaceId }, data });
    Object.assign(ctx.lead, data);
    return 'lead updated';
  }

  private async notify(step: any, ctx: WorkflowContext): Promise<string> {
    const userId = ctx.lead?.assignedToId;
    if (!userId) return 'skipped (no user to notify)';
    await this.notifications.create({
      workspaceId: ctx.workspaceId,
      userId,
      type: 'WORKFLOW',
      title: 'Automation',
      message: this.interpolate(step.message, ctx).slice(0, 500),
    });
    return 'notified';
  }

  /** Mint a review request + stash the gate link in context as {{context.reviewLink}}. */
  private async reviewRequest(ctx: WorkflowContext): Promise<string> {
    if (!ctx.lead?.id) return 'skipped (no lead)';
    const { gateUrl } = await this.reviews.requestReview(ctx.workspaceId, ctx.lead.id);
    ctx.context.reviewLink = gateUrl;
    return 'review request created';
  }

  private async webhook(step: any, ctx: WorkflowContext): Promise<string> {
    // step.url is operator-controlled, so route the call through the SSRF guard
    // (scheme allow-list + private/metadata-IP rejection + redirect re-validation).
    try {
      const res = await safeFetch(step.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: step.payload ?? null, lead: ctx.lead, trigger: ctx.trigger }),
        timeoutMs: 10_000,
      });
      return `webhook ${res.status}`;
    } catch (e: any) {
      if (e instanceof SsrfBlockedError) {
        this.logger.warn(`webhook blocked for workspace=${ctx.workspaceId}: ${e.message}`);
        return `webhook blocked: ${e.message.slice(0, 120)}`;
      }
      return `webhook failed: ${(e?.message ?? e).toString().slice(0, 120)}`;
    }
  }

  // ---- helpers ----

  private leadBlurb(ctx: WorkflowContext): string {
    const l = ctx.lead;
    if (!l) return 'no lead';
    return [l.businessName, l.contactPerson, l.city].filter(Boolean).join(', ');
  }

  resolveField(field: string, ctx: WorkflowContext): unknown {
    const [root, ...rest] = field.split('.');
    let cur: any = (ctx as any)[root];
    for (const k of rest) {
      if (cur == null) return undefined;
      cur = cur[k];
    }
    return cur;
  }

  /** Public: does every filter match? Shared by the branch step + the trigger
   *  service (a trigger's filters use the same evaluator). Empty = match all. */
  matchesAll(filters: WorkflowFilter[], ctx: WorkflowContext): boolean {
    return (filters ?? []).every((f) => this.evalFilter(f, ctx));
  }

  private evalFilter(f: WorkflowFilter, ctx: WorkflowContext): boolean {
    const actual = this.resolveField(f.field, ctx);
    switch (f.op as (typeof FILTER_OPS)[number]) {
      case 'eq': return actual === f.value;
      case 'neq': return actual !== f.value;
      case 'in': return Array.isArray(f.value) && f.value.includes(actual);
      case 'contains': return typeof actual === 'string' && actual.toLowerCase().includes(String(f.value).toLowerCase());
      case 'gte': return actual != null && Number(actual) >= Number(f.value);
      case 'lte': return actual != null && Number(actual) <= Number(f.value);
      case 'exists': return (actual != null && actual !== '') === Boolean(f.value);
      default: return false;
    }
  }

  /**
   * Safe token replace. {{lead.contactPerson}} → raw value.
   *
   * Escaping must match the sink. Every consumer of interpolate() is a
   * PLAIN-TEXT channel — sendPlainEmail's `text:` body, and SMS / WhatsApp /
   * webchat message bodies — none of which are HTML, so HTML-escaping here only
   * corrupts legitimate content (e.g. "Ben & Jerry's" → "Ben &amp; Jerry&#39;s").
   * The whitelist token replace (resolveField only resolves lead/trigger/context
   * roots, never arbitrary code) is the injection-safe part and stays.
   */
  private interpolate(template: string, ctx: WorkflowContext): string {
    return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, field) => {
      const v = this.resolveField(field, ctx);
      return v == null ? '' : String(v);
    });
  }
}
