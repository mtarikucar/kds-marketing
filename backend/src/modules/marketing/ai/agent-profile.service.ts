import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { EntitlementsService } from '../../billing/entitlements.service';

export interface AgentProfileDto {
  name: string;
  persona: string;
  tone?: string;
  goals?: string;
  guardrails?: string;
  language?: string;
  channels?: string[];
  kbDocIds?: string[];
  captureFields?: string[];
  handoffRules?: { keywords?: string[]; outsideBusinessHours?: boolean };
  followup?: { enabled: boolean; afterHours: number; maxFollowups: number };
  bookingCalendarId?: string;
  maxRepliesPerConvoDaily?: number;
  status?: 'ACTIVE' | 'PAUSED';
}

/**
 * Agent Studio CRUD. An AgentProfile is the persona Conversation/Content/Voice
 * AI run grounded on. `findActiveForChannel` is the engine's lookup: the
 * active agent whose `channels` array contains the channel id.
 */
@Injectable()
export class AgentProfileService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: EntitlementsService,
  ) {}

  async list(workspaceId: string) {
    return this.prisma.agentProfile.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async get(workspaceId: string, id: string) {
    const agent = await this.prisma.agentProfile.findFirst({ where: { id, workspaceId } });
    if (!agent) throw new NotFoundException('Agent not found');
    return agent;
  }

  async create(workspaceId: string, dto: AgentProfileDto) {
    const effective = await this.entitlements.getEffective(workspaceId);
    const limit = effective.limits.maxAgents;
    if (limit !== -1) {
      const count = await this.prisma.agentProfile.count({ where: { workspaceId } });
      if (count >= limit) {
        throw new BadRequestException(`Agent limit reached (${limit}) — upgrade your package`);
      }
    }
    return this.prisma.agentProfile.create({ data: this.toData(workspaceId, dto) });
  }

  async update(workspaceId: string, id: string, dto: Partial<AgentProfileDto>) {
    const existing = await this.prisma.agentProfile.findFirst({
      where: { id, workspaceId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Agent not found');
    return this.prisma.agentProfile.update({
      where: { id: existing.id },
      data: this.toData(workspaceId, dto, true),
    });
  }

  async remove(workspaceId: string, id: string) {
    const res = await this.prisma.agentProfile.deleteMany({ where: { id, workspaceId } });
    if (res.count === 0) throw new NotFoundException('Agent not found');
    return { message: 'Agent deleted' };
  }

  /** The Conversation AI engine's entry point: which agent answers on a channel. */
  async findActiveForChannel(workspaceId: string, channelId: string) {
    const agents = await this.prisma.agentProfile.findMany({
      where: { workspaceId, status: 'ACTIVE' },
    });
    return (
      agents.find((a) => Array.isArray(a.channels) && (a.channels as string[]).includes(channelId)) ??
      null
    );
  }

  private toData(workspaceId: string, dto: Partial<AgentProfileDto>, partial = false) {
    const json = (v: unknown) =>
      v === undefined ? undefined : ((v as Prisma.InputJsonValue) ?? Prisma.JsonNull);
    const data: Prisma.AgentProfileUncheckedCreateInput = {
      workspaceId,
      name: dto.name as string,
      persona: dto.persona as string,
      tone: dto.tone ?? null,
      goals: dto.goals ?? null,
      guardrails: dto.guardrails ?? null,
      language: dto.language ?? 'tr',
      channels: json(dto.channels),
      kbDocIds: json(dto.kbDocIds),
      captureFields: json(dto.captureFields),
      handoffRules: json(dto.handoffRules),
      followup: json(dto.followup),
      bookingCalendarId: dto.bookingCalendarId ?? null,
      ...(dto.maxRepliesPerConvoDaily !== undefined
        ? { maxRepliesPerConvoDaily: dto.maxRepliesPerConvoDaily }
        : {}),
      ...(dto.status ? { status: dto.status } : {}),
    };
    if (partial) {
      // Drop undefined keys so a PATCH only touches provided fields.
      Object.keys(data).forEach((k) => (data as any)[k] === undefined && delete (data as any)[k]);
    }
    return data;
  }
}
