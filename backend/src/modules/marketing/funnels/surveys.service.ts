import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

interface SurveyInput {
  name: string;
  questions?: unknown[];
  redirectUrl?: string;
}

/**
 * Epic E — workspace-authored surveys (richer than lead-capture forms).
 * Management is workspace-scoped; public submit looks the survey up by its
 * unguessable id (like form submits) and records a SurveyResponse.
 */
@Injectable()
export class SurveysService {
  constructor(private prisma: PrismaService) {}

  list(workspaceId: string) {
    return this.prisma.survey.findMany({
      where: { workspaceId },
      orderBy: { createdAt: 'desc' },
    });
  }

  create(workspaceId: string, dto: SurveyInput) {
    return this.prisma.survey.create({
      data: {
        workspaceId,
        name: dto.name,
        questions: (dto.questions ?? []) as unknown as Prisma.InputJsonValue,
        redirectUrl: dto.redirectUrl,
      },
    });
  }

  private async owned(workspaceId: string, id: string) {
    const s = await this.prisma.survey.findFirst({ where: { id, workspaceId } });
    if (!s) throw new NotFoundException('Survey not found');
    return s;
  }

  get(workspaceId: string, id: string) {
    return this.owned(workspaceId, id);
  }

  async update(workspaceId: string, id: string, dto: Partial<SurveyInput> & { status?: string }) {
    await this.owned(workspaceId, id);
    return this.prisma.survey.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.questions !== undefined && {
          questions: dto.questions as unknown as Prisma.InputJsonValue,
        }),
        ...(dto.redirectUrl !== undefined && { redirectUrl: dto.redirectUrl }),
        ...(dto.status !== undefined && { status: dto.status }),
      },
    });
  }

  async remove(workspaceId: string, id: string) {
    await this.owned(workspaceId, id);
    await this.prisma.survey.delete({ where: { id } });
    return { id };
  }

  async listResponses(workspaceId: string, surveyId: string) {
    await this.owned(workspaceId, surveyId);
    return this.prisma.surveyResponse.findMany({
      where: { surveyId, workspaceId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
  }

  /** Public — record a response if the survey is published. */
  async submit(surveyId: string, answers: Record<string, unknown>, leadId?: string) {
    const survey = await this.prisma.survey.findUnique({ where: { id: surveyId } });
    if (!survey || survey.status !== 'PUBLISHED') {
      throw new NotFoundException('Survey not available');
    }
    await this.prisma.surveyResponse.create({
      data: {
        surveyId,
        workspaceId: survey.workspaceId,
        leadId: leadId ?? null,
        answers: answers as Prisma.InputJsonValue,
      },
    });
    return { redirectUrl: survey.redirectUrl ?? null };
  }
}
