import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { PrismaService } from '../../../prisma/prisma.service';
import { EntitlementsService } from '../../billing/entitlements.service';
import { AnthropicService } from '../ai/anthropic.service';
import { AiCreditsService } from '../ai/ai-credits.service';
import { creditCost, tierFor } from '../ai/ai-credit-costs';
import {
  parseWorkflowParts,
  TRIGGER_TYPES,
  FILTER_OPS,
  WorkflowDsl,
} from './workflow-dsl.schema';
import { listWorkflowTemplates } from './workflow-templates';

const DSL_GUIDE = `You design marketing automations as STRICT JSON for this DSL. Output ONLY a JSON object, no prose, no markdown fences.
Shape: { "trigger": { "type": <triggerType>, "filters": [Filter...] }, "steps": [Step...] }
triggerType ∈ ${TRIGGER_TYPES.map((t) => `"${t}"`).join(', ')}
Filter: { "field": "lead.<x>" | "trigger.<x>" | "context.<x>", "op": ${FILTER_OPS.map((o) => `"${o}"`).join('|')}, "value": <any?> }
Step types (each is an object with "type"):
 - send_email|send_sms|send_whatsapp|send_webchat: { "body": string, "subject"?: string }  // {{lead.contactPerson}} tokens allowed
 - ai_generate: { "prompt": string, "saveAs"?: string }
 - ai_classify: { "prompt": string, "categories": [string,...], "routes"?: { category: stepIndex } }
 - branch: { "filters": [Filter...], "elseGoto"?: stepIndex }
 - wait: { "mode": "duration"|"until_reply", "seconds"?: number, "timeoutSeconds"?: number }
 - create_task: { "title": string, "dueInHours"?: number }
 - assign_lead: { "strategy": "auto"|"user", "userId"?: string }
 - update_lead: { "set": { field: value } }
 - notify_user: { "message": string }
 - http_webhook_out: { "url": string, "payload"?: any }
 - stop_workflow: {}
Max 100 steps. Keep it minimal and correct.`;

/**
 * Workflow CRUD + the NL→DSL draft. Every write validates the DSL with the Zod
 * schema (a ZodError surfaces as 400, never a malformed row). Create enforces
 * the per-plan maxWorkflows cap; an edit bumps `version` so in-flight runs keep
 * the definition they started on.
 */
@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
    private readonly anthropic: AnthropicService,
    private readonly credits: AiCreditsService,
  ) {}

  /** Static starter-automation catalog ("Start from template"). Not tenant
   *  state — the same recipes for everyone; the picker pre-fills create(). */
  templates() {
    return listWorkflowTemplates();
  }

  async list(workspaceId: string) {
    return this.prisma.workflow.findMany({
      where: { workspaceId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, name: true, status: true, description: true, trigger: true, goal: true, version: true, stats: true, updatedAt: true },
    });
  }

  async get(workspaceId: string, id: string) {
    const wf = await this.prisma.workflow.findFirst({ where: { id, workspaceId } });
    if (!wf) throw new NotFoundException('Workflow not found');
    return wf;
  }

  async create(workspaceId: string, dto: { name: string; description?: string; trigger: unknown; steps: unknown; goal?: unknown }) {
    const dsl = this.validate(dto.trigger, dto.steps, dto.goal);
    const effective = await this.entitlements.getEffective(workspaceId);
    const limit = effective.limits.maxWorkflows;
    if (limit !== -1) {
      const count = await this.prisma.workflow.count({ where: { workspaceId } });
      if (count >= limit) {
        throw new BadRequestException(`Workflow limit reached (${limit}) — upgrade your package`);
      }
    }
    return this.prisma.workflow.create({
      data: {
        workspaceId,
        name: dto.name,
        description: dto.description ?? null,
        trigger: dsl.trigger as any,
        steps: dsl.steps as any,
        goal: (dsl.goal ?? null) as any,
        status: 'DRAFT',
      },
    });
  }

  async update(
    workspaceId: string,
    id: string,
    dto: { name?: string; description?: string; trigger?: unknown; steps?: unknown; goal?: unknown },
  ) {
    const existing = await this.prisma.workflow.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundException('Workflow not found');
    const data: any = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    // Any DSL-touching field re-validates the WHOLE definition (a goto goal's
    // bounds depend on steps.length, so shrinking steps must re-check the goal)
    // and bumps version so in-flight runs keep the definition they started on.
    if (dto.trigger !== undefined || dto.steps !== undefined || dto.goal !== undefined) {
      // undefined = keep existing goal; null = clear it; object = replace it.
      const effectiveGoal = dto.goal === undefined ? existing.goal : dto.goal;
      const dsl = this.validate(dto.trigger ?? existing.trigger, dto.steps ?? existing.steps, effectiveGoal);
      data.trigger = dsl.trigger;
      data.steps = dsl.steps;
      data.goal = (dsl.goal ?? null) as any;
      data.version = { increment: 1 };
    }
    return this.prisma.workflow.update({ where: { id: existing.id }, data });
  }

  async setStatus(workspaceId: string, id: string, status: 'ACTIVE' | 'PAUSED' | 'DRAFT') {
    const existing = await this.prisma.workflow.findFirst({ where: { id, workspaceId }, select: { id: true, trigger: true, steps: true, goal: true } });
    if (!existing) throw new NotFoundException('Workflow not found');
    if (status === 'ACTIVE') this.validate(existing.trigger, existing.steps, existing.goal); // can't activate an invalid DSL
    return this.prisma.workflow.update({ where: { id: existing.id }, data: { status } });
  }

  async remove(workspaceId: string, id: string) {
    const res = await this.prisma.workflow.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Workflow not found');
    return { message: 'Workflow deleted' };
  }

  async runs(workspaceId: string, id: string) {
    return this.prisma.workflowRun.findMany({
      where: { workspaceId, workflowId: id },
      orderBy: { startedAt: 'desc' },
      take: 50,
      select: { id: true, status: true, leadId: true, startedAt: true, completedAt: true, lastError: true },
    });
  }

  /** NL → DSL. Reserves 2 credits; refunds on a model/parse failure. */
  async draft(workspaceId: string, prompt: string): Promise<WorkflowDsl> {
    if (!this.anthropic.isEnabled()) throw new ServiceUnavailableException('AI is not configured');
    await this.credits.reserve(workspaceId, creditCost('workflow.draft'));
    try {
      const res = await this.anthropic.complete({
        system: DSL_GUIDE,
        messages: [{ role: 'user', content: prompt.slice(0, 2000) }],
        maxTokens: 1500,
        tier: tierFor('workflow.draft'),
      });
      const json = this.extractJson(res.text);
      return parseWorkflowParts(json.trigger, json.steps); // throws → caught below
    } catch (e) {
      await this.credits.refund(workspaceId, creditCost('workflow.draft'));
      if (e instanceof ZodError) {
        throw new BadRequestException('The AI draft did not match the workflow format — try rephrasing.');
      }
      throw e;
    }
  }

  private validate(trigger: unknown, steps: unknown, goal?: unknown): WorkflowDsl {
    try {
      return parseWorkflowParts(trigger, steps, goal);
    } catch (e) {
      if (e instanceof ZodError) {
        const first = e.issues[0];
        throw new BadRequestException(`Invalid workflow: ${first?.path?.join('.')} — ${first?.message}`);
      }
      throw e;
    }
  }

  private extractJson(text: string): any {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) throw new BadRequestException('AI returned no JSON');
    return JSON.parse(text.slice(start, end + 1));
  }
}
