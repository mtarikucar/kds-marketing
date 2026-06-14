import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RoutineTokenGuard } from './routine-token.guard';
import { SubmitContentDraftsDto } from './content-drafts.dto';

const DUE_AFTER_DAYS = 6;
const COUNT_MAX = { social: 10, email: 5, sms: 5 } as const;

/**
 * The content-pack routine's surface:
 *
 *   GET  /api/internal/content/jobs
 *     One job per ACTIVE workspace × ACTIVE, weekly-DUE ContentProfile (lastRunAt
 *     null or older than DUE_AFTER_DAYS). counts are clamped to per-channel maxes.
 *
 *   POST /api/internal/content/jobs/:workspaceId/drafts
 *     Insert the generated drafts (DRAFT status) and stamp the profile's
 *     lastRunAt/lastRunStats — the stamp is what drops the profile out of
 *     "weekly-due", making the run idempotent.
 *
 * Guarded by ROUTINE_TOKEN (x-routine-token). The routine WRITES the copy; we
 * only serve jobs and persist drafts. No campaign creation, no sending, no credits.
 */
@Controller('internal/content')
@UseGuards(RoutineTokenGuard)
export class InternalContentController {
  constructor(private readonly prisma: PrismaService) {}

  private clampCounts(raw: unknown): { social: number; email: number; sms: number } {
    const c = (raw ?? {}) as Record<string, unknown>;
    const one = (v: unknown, max: number) => {
      const n = Math.floor(Number(v));
      return Number.isFinite(n) && n > 0 ? Math.min(n, max) : 0;
    };
    return {
      social: one(c.social, COUNT_MAX.social),
      email: one(c.email, COUNT_MAX.email),
      sms: one(c.sms, COUNT_MAX.sms),
    };
  }

  @Get('jobs')
  async jobs() {
    const cutoff = new Date(Date.now() - DUE_AFTER_DAYS * 24 * 60 * 60 * 1000);
    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, slug: true, productName: true, productDescription: true, defaultLanguage: true },
    });

    const jobs: unknown[] = [];
    for (const ws of workspaces) {
      const profiles = await this.prisma.contentProfile.findMany({
        where: {
          workspaceId: ws.id,
          status: 'ACTIVE',
          OR: [{ lastRunAt: null }, { lastRunAt: { lt: cutoff } }],
        },
        select: { id: true, name: true, themes: true, voice: true, language: true, counts: true },
      });
      for (const p of profiles) {
        const counts = this.clampCounts(p.counts);
        if (counts.social + counts.email + counts.sms === 0) continue;
        jobs.push({
          workspaceId: ws.id,
          workspaceSlug: ws.slug,
          productName: ws.productName,
          productDescription: ws.productDescription,
          defaultLanguage: ws.defaultLanguage,
          profile: {
            id: p.id,
            name: p.name,
            themes: p.themes,
            voice: p.voice,
            language: p.language,
            counts,
          },
        });
      }
    }

    return { generatedAt: new Date().toISOString(), jobs };
  }

  @Post('jobs/:workspaceId/drafts')
  @HttpCode(200)
  async submit(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: SubmitContentDraftsDto,
  ): Promise<{ created: number }> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, status: true },
    });
    if (!workspace || workspace.status !== 'ACTIVE') {
      throw new NotFoundException('Workspace not found');
    }

    const profile = await this.prisma.contentProfile.findFirst({
      where: { id: dto.profileId, workspaceId },
      select: { id: true },
    });
    if (!profile) {
      throw new NotFoundException('Content profile not found');
    }

    const result = await this.prisma.contentDraft.createMany({
      data: dto.drafts.map((d) => ({
        workspaceId,
        contentProfileId: dto.profileId,
        channel: d.channel,
        subject: d.subject ?? null,
        body: d.body,
      })),
    });

    // Best-effort stamp; never fail the submission over it. Scoped by
    // {id, workspaceId} so a routine can never stamp another tenant's profile.
    const byChannel = dto.drafts.reduce<Record<string, number>>((acc, d) => {
      acc[d.channel] = (acc[d.channel] ?? 0) + 1;
      return acc;
    }, {});
    await this.prisma.contentProfile
      .updateMany({
        where: { id: dto.profileId, workspaceId },
        data: {
          lastRunAt: new Date(),
          lastRunStats: { ...byChannel, at: new Date().toISOString() } as Prisma.InputJsonValue,
        },
      })
      .catch(() => undefined);

    return { created: result.count };
  }
}
