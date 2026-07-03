import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { MarketingLeadsIngestService } from '../services/marketing-leads-ingest.service';

export interface ResearchProfileBrief {
  id: string;
  name: string;
  icpDescription: string;
  productPitch: string | null;
  geo: unknown;
  language: string;
  businessTypes: unknown;
  exclusions: string | null;
  lastRunAt: Date | null;
}

export interface ResearchJob {
  workspaceId: string;
  workspaceSlug: string;
  productName: string | null;
  productUrl: string | null;
  productDescription: string | null;
  defaultLanguage: string;
  profile: ResearchProfileBrief;
  /** Workspace daily lead quota left (shared across the workspace's profiles); -1 = unlimited. */
  remainingToday: number;
  maxBatchSize: number;
}

const PROFILE_SELECT = {
  id: true, name: true, icpDescription: true, productPitch: true,
  geo: true, language: true, businessTypes: true, exclusions: true, lastRunAt: true,
} as const;

/**
 * Assembles the research work-list: one job per ACTIVE ResearchProfile of every
 * ACTIVE, quota-remaining workspace. This is the SAME job shape the (now legacy)
 * external routine consumed via InternalResearchController — extracted here so
 * the native in-process ResearchWorkerService and the nightly cron drive off it
 * directly, no HTTP/token hop.
 */
@Injectable()
export class ResearchJobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ingest: MarketingLeadsIngestService,
  ) {}

  async buildJobs(): Promise<ResearchJob[]> {
    const workspaces = await this.prisma.workspace.findMany({
      where: { status: 'ACTIVE' },
      select: { id: true, slug: true, productName: true, productUrl: true, productDescription: true, defaultLanguage: true },
    });
    const jobs: ResearchJob[] = [];
    for (const ws of workspaces) {
      const remainingToday = (await this.ingest.usageToday(ws.id)).remaining;
      if (remainingToday === 0) continue; // exhausted / quota-0 / suspended
      const profiles = await this.prisma.researchProfile.findMany({
        where: { workspaceId: ws.id, status: 'ACTIVE' },
        select: PROFILE_SELECT,
      });
      for (const profile of profiles) jobs.push(this.toJob(ws, profile, remainingToday));
    }
    return jobs;
  }

  /** Single-profile job for an on-demand "Run now". Returns null if not eligible. */
  async buildJob(workspaceId: string, profileId: string): Promise<ResearchJob | null> {
    const ws = await this.prisma.workspace.findFirst({
      where: { id: workspaceId, status: 'ACTIVE' },
      select: { id: true, slug: true, productName: true, productUrl: true, productDescription: true, defaultLanguage: true },
    });
    if (!ws) return null;
    const remainingToday = (await this.ingest.usageToday(ws.id)).remaining;
    if (remainingToday === 0) return null;
    const profile = await this.prisma.researchProfile.findFirst({
      where: { id: profileId, workspaceId, status: 'ACTIVE' },
      select: PROFILE_SELECT,
    });
    if (!profile) return null;
    return this.toJob(ws, profile, remainingToday);
  }

  private toJob(
    ws: { id: string; slug: string; productName: string | null; productUrl: string | null; productDescription: string | null; defaultLanguage: string },
    profile: ResearchProfileBrief,
    remainingToday: number,
  ): ResearchJob {
    return {
      workspaceId: ws.id,
      workspaceSlug: ws.slug,
      productName: ws.productName,
      productUrl: ws.productUrl,
      productDescription: ws.productDescription,
      defaultLanguage: ws.defaultLanguage,
      profile,
      remainingToday,
      maxBatchSize: 50,
    };
  }
}
