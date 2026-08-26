import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AiUsageStatsService } from '../ai/ai-usage-stats.service';

export interface DigestSection {
  title: string;
  /** Checklist lines. Empty means the section is skipped entirely. */
  items: string[];
}

export interface WorkspaceDigest {
  workspaceId: string;
  workspaceName: string;
  /** Local date the digest covers (yesterday). */
  forDate: string;
  didHappen: DigestSection;
  needsYou: DigestSection;
  today: DigestSection;
  /** True when nothing at all is worth sending. */
  empty: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The morning brief: what the machine did overnight, what it cannot do without
 * you, and what today asks for.
 *
 * The product already nudges per-lead (`marketing-followup-reminder` notifies
 * an assignee that one lead is due), but nobody ever received the workspace's
 * whole picture in one place. So "is this thing working?" could only be
 * answered by opening the panel and going looking — which is the opposite of a
 * system that runs itself.
 *
 * Deliberately built from what is already recorded rather than a new tracking
 * table: leads, conversations, approvals, tasks, research candidates and
 * AiUsageLog. A digest that needs its own bookkeeping is a digest that drifts
 * from what actually happened.
 */
@Injectable()
export class DailyDigestService {
  private readonly logger = new Logger(DailyDigestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly usage: AiUsageStatsService,
  ) {}

  async build(workspaceId: string, now = new Date()): Promise<WorkspaceDigest | null> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true },
    });
    if (!workspace) return null;

    const since = new Date(now.getTime() - DAY_MS);
    const soon = new Date(now.getTime() + DAY_MS);

    const [
      newLeads,
      inboundMsgs,
      wonLeads,
      approvals,
      candidates,
      overdueTasks,
      dueTasks,
      dueFollowUps,
      unassigned,
      waitingReplies,
      spend,
    ] = await Promise.all([
      this.prisma.lead.count({
        where: { workspaceId, createdAt: { gte: since }, deletedAt: null, mergedIntoId: null },
      }),
      this.prisma.message.count({
        where: { workspaceId, direction: 'INBOUND', createdAt: { gte: since } },
      }),
      this.prisma.lead.count({
        where: { workspaceId, status: 'WON', updatedAt: { gte: since }, deletedAt: null },
      }),
      this.prisma.approvalRequest.count({ where: { workspaceId, status: 'PENDING' } }),
      this.prisma.researchCandidate.count({ where: { workspaceId, status: 'PENDING' } }),
      this.prisma.marketingTask.count({
        where: { workspaceId, status: { in: ['PENDING', 'IN_PROGRESS'] }, dueDate: { lt: now } },
      }),
      this.prisma.marketingTask.count({
        where: {
          workspaceId,
          status: { in: ['PENDING', 'IN_PROGRESS'] },
          dueDate: { gte: now, lte: soon },
        },
      }),
      this.prisma.lead.count({
        where: {
          workspaceId,
          deletedAt: null,
          mergedIntoId: null,
          nextFollowUp: { gte: now, lte: soon },
          status: { notIn: ['WON', 'LOST'] },
        },
      }),
      this.prisma.lead.count({
        where: {
          workspaceId,
          assignedToId: null,
          status: 'NEW',
          deletedAt: null,
          mergedIntoId: null,
        },
      }),
      // Open conversations whose LAST message came from the customer.
      //
      // The brief covered approvals, candidates, tasks and leads but never
      // conversations — the word appears once in this file, in the docstring
      // listing what it covers. So the most time-sensitive item in the inbox
      // was the one thing it could not tell you about: on this workspace a
      // WhatsApp thread sat on "bilgi almak için dört gözle bekliyorum" for 46
      // days with nothing anywhere reporting it.
      //
      // Raw SQL because the test is a COLUMN COMPARISON, which Prisma's where
      // cannot express. Both columns are maintained on every write: ingress
      // stamps lastInboundAt (and lastMessageAt), an outbound send moves only
      // lastMessageAt — so lastInboundAt >= lastMessageAt is exactly "nobody
      // has replied since they wrote".
      this.prisma
        .$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(*)::bigint AS count
          FROM "conversations"
          WHERE "workspaceId" = ${workspaceId}
            AND "status" = 'OPEN'
            AND "lastInboundAt" IS NOT NULL
            AND ("lastMessageAt" IS NULL OR "lastInboundAt" >= "lastMessageAt")
        `
        .then((r) => Number(r[0]?.count ?? 0))
        .catch(() => 0),
      this.usage.breakdown(workspaceId, 1).catch(() => null),
    ]);

    const didHappen: string[] = [];
    if (newLeads) didHappen.push(`${newLeads} yeni lead bulundu`);
    if (inboundMsgs) didHappen.push(`${inboundMsgs} gelen mesaj alındı`);
    if (wonLeads) didHappen.push(`${wonLeads} lead kazanıldı`);
    // Cost is CONTEXT on the night's work, not work in itself. It rides along
    // when there is something to report and never triggers a send on its own —
    // a daily email whose only content is "$0.02 spent" is one that gets
    // filtered, taking the mornings that matter with it. Spend with nothing to
    // show for it still surfaces, as a $ line next to an otherwise short list.
    const substantive = didHappen.length;
    if (spend?.total.usd) didHappen.push(`AI harcaması: $${spend.total.usd.toFixed(2)}`);

    // "Needs you" is the section that justifies the email. Anything here is
    // work the machine started and cannot finish on its own.
    const needsYou: string[] = [];
    if (approvals) needsYou.push(`${approvals} onay bekliyor — onaylanmadan hiçbiri uygulanmaz`);
    if (candidates) needsYou.push(`${candidates} araştırma adayı incelenmeyi bekliyor`);
    if (overdueTasks) needsYou.push(`${overdueTasks} görev gecikmiş`);
    if (unassigned) needsYou.push(`${unassigned} yeni lead kimseye atanmamış`);
    // First in the list once rendered would be nicer still, but order here
    // follows the section's existing convention; what matters is that a waiting
    // customer now appears at all.
    if (waitingReplies)
      needsYou.push(`${waitingReplies} konuşma yanıt bekliyor — müşteri en son yazan taraf`);

    const today: string[] = [];
    if (dueTasks) today.push(`${dueTasks} görevin süresi bugün doluyor`);
    if (dueFollowUps) today.push(`${dueFollowUps} lead için takip zamanı`);

    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      forDate: since.toISOString().slice(0, 10),
      didHappen: { title: 'Dün ne oldu', items: didHappen },
      needsYou: { title: 'Sensiz ilerlemiyor', items: needsYou },
      today: { title: 'Bugün', items: today },
      // A digest with nothing in any section is noise. Sending "hiçbir şey
      // olmadı" every morning is how a daily email becomes one nobody opens.
      empty: substantive + needsYou.length + today.length === 0,
    };
  }

  /** Plain-text body. Sections with no items are omitted, not shown empty. */
  render(digest: WorkspaceDigest): string {
    const lines: string[] = [`${digest.workspaceName} — ${digest.forDate}`, ''];
    for (const section of [digest.didHappen, digest.needsYou, digest.today]) {
      if (!section.items.length) continue;
      lines.push(`${section.title}:`);
      for (const item of section.items) lines.push(`  [ ] ${item}`);
      lines.push('');
    }
    lines.push('Ayrıntı ve onaylar: ana ekran (/home)');
    return lines.join('\n');
  }

  /** OWNER + MANAGER of the workspace — the people who can act on the list. */
  async recipients(workspaceId: string): Promise<string[]> {
    const memberships = await this.prisma.workspaceMembership.findMany({
      where: { workspaceId, status: 'ACTIVE', role: { in: ['OWNER', 'MANAGER'] } },
      select: { userId: true },
    });
    if (!memberships.length) return [];
    const users = await this.prisma.marketingUser.findMany({
      where: {
        id: { in: memberships.map((m) => m.userId) },
        status: 'ACTIVE',
        // The research sentinel is a SYSTEM row that owns records, never a
        // mailbox — it would bounce every morning.
        role: { not: 'SYSTEM' },
      },
      select: { email: true },
    });
    return users.map((u) => u.email).filter(Boolean);
  }
}
