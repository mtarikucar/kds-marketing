import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { AiUsageStatsService } from '../ai/ai-usage-stats.service';
import { PlatformAiSpendService } from '../ai/platform-ai-spend.service';
import {
  SKIP_KILL_SWITCH,
  SKIP_NO_EXECUTOR,
  SKIP_PREFIX,
  SKIP_RUN_CAP,
} from '../strategy/orchestrator/skip-reasons';

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
  /** The strategy autopilot's own report: what it did, and what it did NOT do
   *  and why. Empty (and omitted) unless the workspace armed the AUTONOMOUS
   *  lane. */
  autopilot: DigestSection;
  needsYou: DigestSection;
  today: DigestSection;
  /** True when nothing at all is worth sending. */
  empty: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The columns of a StrategyAction the autopilot report is built from. */
interface PlanActionRow {
  kind: string;
  title: string;
  status: string;
  resultRef: string | null;
  updatedAt: Date;
}

/**
 * Owner-facing wording for each machine skip reason the orchestrator stamps.
 *
 * The reason codes are written for the row; this is written for the person
 * paying for the machine. Each one names what happened AND what changes it,
 * because "yapılmadı" without a cause is indistinguishable from a broken
 * product, and that is the reading a self-running system can least afford.
 */
const SKIP_TEXT: Record<string, string> = {
  [SKIP_KILL_SWITCH]:
    'harcama/yayın anahtarı kapalı — o anahtar açılana kadar bu türden eylemler beklemede kalır',
  [SKIP_RUN_CAP]:
    'tek turda uygulanan eylem sınırına ulaşıldı — bunlar bir sonraki günün turunda ele alınır',
  [SKIP_NO_EXECUTOR]:
    'bu türü çalıştıracak bir yürütücü henüz yok — yalnızca elle yapılabilir',
};

/** A plan is a handful of rows; this bounds the read against a pathological one. */
const PLAN_READ_LIMIT = 100;

/**
 * The blocked half gets its OWN bounded read, and this is why.
 *
 * The plan read is `orderBy updatedAt desc take 100`, and the skip stamps are
 * deliberately CONDITIONAL - a reason that has not changed is not rewritten, so
 * a blocked action's `updatedAt` stays where it was while every action that
 * ran, failed or was re-stamped floats above it. Past a hundred lifetime
 * actions the rows that sink out of that window first are precisely the ones
 * that have been sitting blocked the longest, which is the half of the report
 * that exists BECAUSE nothing else in the product can reconstruct it: a DONE
 * action leaves a post, a lead, a campaign; a blocked one leaves a string in a
 * column and a line in this brief.
 */
const SKIP_READ_LIMIT = 100;

/**
 * Statuses a `skipped:` stamp still means something on.
 *
 * The stamp is never cleared - DONE/FAILED overwrite `resultRef` with their own
 * value, but a DISMISSED action keeps the last reason it was given forever. The
 * owner declining an action is exactly the gesture that should make its line
 * disappear, so reading the reasons back without this filter would report a
 * dismissed action as still waiting, permanently, with no way to clear it.
 */
const BLOCKED_STATUSES = ['PROPOSED', 'APPROVED'];

/** UTC weekday the once-a-week autopilot lines ride on (1 = Monday). */
const WEEKLY_REPORT_DAY = 1;

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
    private readonly spend: PlatformAiSpendService,
  ) {}

  async build(workspaceId: string, now = new Date()): Promise<WorkspaceDigest | null> {
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true },
    });
    if (!workspace) return null;

    const since = new Date(now.getTime() - DAY_MS);
    // Signals that could not be read, by name.
    //
    // Every fallible query below used to end in `.catch(() => 0)`, which turns a
    // broken signal into a reassuring one: "0 conversations waiting" and "could
    // not check" render identically, and the second is the one that matters. A
    // whole class of failure on this codebase has been exactly that shape, and
    // this brief is the single surface through which any of it reaches anyone —
    // so a silent zero here hides the very thing the brief exists to surface.
    //
    // Not rethrown: one broken sub-query must not cost the owner all eighteen
    // signals. The brief still goes out with what it has and says what it could
    // not read, which is the honest version of both options.
    const unread: string[] = [];
    const soft =
      <T,>(label: string, fallback: T) =>
      (e: unknown): T => {
        unread.push(label);
        this.logger.warn(
          `digest signal "${label}" failed for ${workspaceId}: ${e instanceof Error ? e.message : e}`,
        );
        return fallback;
      };
    const soon = new Date(now.getTime() + DAY_MS);
    // A week is the window for "renew this before it stops working": long
    // enough that a reconnect can wait for a working day, short enough that the
    // line does not sit there for a month training people to ignore it.
    const soon7 = new Date(now.getTime() + 7 * DAY_MS);

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
      brokenAccounts,
      deadJobs,
      vendorRefused,
      agentlessWaiting,
      overdueDrafts,
      expiringSoon,
      stalePeriodBudget,
      distribution,
      aiBudget,
      spend,
      strategyLane,
      planActions,
      blockedActions,
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
        .catch(soft('yanıt bekleyen konuşmalar', 0)),
      // Connected accounts that are supposed to be working and are not.
      //
      // Deliberately NARROWER than social.tools.ts's `needsReconnect`, which
      // also folds in `enabled: false`. An account the owner disconnected on
      // purpose — disconnectAccount writes lastError 'disconnected', and the
      // mis-tagged-Page repair disabled its rows — is not a problem, and
      // reporting it every morning forever is how a section trains people to
      // stop reading it.
      //
      // So: 'reauth_required' (the refresher gave up, or a provider rejected
      // the token) or a live account whose token has run out. Both mean
      // something the owner switched ON has stopped working.
      //
      // Ad accounts count too, and did not before. `TOKEN_EXPIRED` is written by
      // our own code the moment a Meta/TikTok call comes back with an auth
      // error, so it is never ambiguous and never accidental — and while it
      // stands, insights stop syncing, spend reporting quietly goes stale and
      // the budget autopilot cannot act. On the live workspace one of the three
      // ad accounts has been sitting in that state with nothing reporting it.
      Promise.all([
        this.prisma.socialAccount.count({
          where: {
            workspaceId,
            OR: [
              { lastError: 'reauth_required' },
              { enabled: true, tokenExpiresAt: { lt: new Date() } },
            ],
          },
        }),
        this.prisma.adAccount.count({ where: { workspaceId, status: 'TOKEN_EXPIRED' } }),
      ])
        .then(([a, b]) => a + b)
        .catch(soft('kopmuş bağlantılar', 0)),
      // Background jobs that gave up.
      //
      // A FAILED row means the queue exhausted every attempt — there is no
      // interpretation of that which is fine, which is what makes it safe to
      // report unconditionally (unlike a disabled account or an unattached
      // agent, both of which can be deliberate).
      //
      // This is the line that would have ended a month of guessing. AI replies
      // were dying on a 400 from the vendor — "Your credit balance is too low"
      // — and the reason was written to scheduled_jobs.lastError on every
      // attempt. Nothing read that column, so the only observable was silence:
      // the inbox looked normal, the panel looked normal, and customers waited.
      //
      // Windowed to the digest period so a fixed problem stops being reported.
      this.prisma.scheduledJob.count({
        where: { workspaceId, status: 'FAILED', completedAt: { gte: since } },
      }),
      // The vendor refusing us outright, which is a different thing from us
      // overspending — and the only one of the two nothing could report.
      //
      // PlatformAiSpendCron exists to "say something BEFORE the money is gone",
      // but it compares our own RECORDED spend against our own cap. When the
      // vendor account runs dry the calls fail and bill nothing, so recorded
      // spend stays LOW and the watcher reads OK. It is structurally incapable
      // of seeing an empty balance; it can only see us spending too much. And
      // it announces to a log, which its own comment calls the same as no alert.
      //
      // Read-side detection instead: the vendor's refusal is already written to
      // scheduled_jobs.lastError on every attempt. No new table, no new write,
      // nothing added to the AI hot path.
      //
      // Matching the message is a bounded risk: if the wording changes this
      // stops matching and the generic "jobs gave up" line above still fires,
      // so a miss degrades to yesterday's behaviour rather than to silence.
      this.prisma.scheduledJob
        .count({
          where: {
            workspaceId,
            lastError: { contains: 'credit balance', mode: 'insensitive' },
            updatedAt: { gte: since },
          },
        })
        .catch(soft('tedarikçi reddi', 0)),
      // Conversations waiting on a channel that has NO AI agent attached.
      //
      // Deliberately not "channels without an agent" — plenty of channels are
      // meant to be answered by people, and a line that fires every morning
      // regardless of whether anything is wrong is how a section teaches people
      // to skip it. The pairing is what makes it actionable: someone is waiting
      // AND the AI structurally cannot pick it up, so it is on a human or
      // nobody.
      //
      // This is the other half of the same month of silence. Every customer
      // conversation still open from June and July sits on Instagram,
      // Messenger or WhatsApp, and none of those three has ever had an agent
      // attached — so the reply engine declined at that gate every single time,
      // correctly and invisibly.
      this.prisma
        .$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(DISTINCT c."channelId")::bigint AS count
          FROM "conversations" c
          JOIN "channels" ch ON ch."id" = c."channelId"
          WHERE c."workspaceId" = ${workspaceId}
            AND c."status" = 'OPEN'
            AND c."aiPaused" = false
            AND c."lastInboundAt" IS NOT NULL
            AND (c."lastMessageAt" IS NULL OR c."lastInboundAt" >= c."lastMessageAt")
            AND ch."status" = 'ACTIVE'
            AND ch."agentProfileId" IS NULL
        `
        .then((r) => Number(r[0]?.count ?? 0))
        .catch(soft('ajansız kanallar', 0)),
      // Campaigns whose moment has arrived while they are still drafts.
      //
      // Anchored on the date the owner themselves set, which is what keeps this
      // from becoming noise: a draft with no date is just a draft and is never
      // counted, and the moment someone either launches it or moves the date,
      // the line clears itself.
      //
      // Found by sweeping the workspace: the one HummyTummy social campaign was
      // a seasonal push dated 18 Aug - 30 Sep, sitting in DRAFT with eight days
      // of its own window already spent. A season does not wait, and nothing
      // anywhere said a word about it.
      Promise.all([
        this.prisma.socialCampaign.count({
          where: { workspaceId, status: 'DRAFT', startDate: { lte: now } },
        }),
        this.prisma.campaign.count({
          where: { workspaceId, status: 'DRAFT', scheduledAt: { lte: now } },
        }),
      ])
        .then(([a, b]) => a + b)
        .catch(soft('vakti geçmiş taslaklar', 0)),
      // Tokens with an expiry date that is nearly here.
      //
      // The line above reports a connection that has ALREADY broken, which is
      // the wrong moment: nobody can reconnect an account retroactively, so by
      // then the posts that did not go out have not gone out. An expiry is one
      // of the few failures that announces itself in advance, and the only
      // reason it ever surprises anyone is that nothing was reading the date.
      //
      // Seven days, and only for connections that are currently live — an
      // account already disabled or already expired belongs to the line above,
      // not this one, and counting it in both would say the same thing twice.
      Promise.all([
        this.prisma.socialAccount.count({
          where: { workspaceId, enabled: true, tokenExpiresAt: { gt: now, lte: soon7 } },
        }),
        this.prisma.adAccount.count({
          where: { workspaceId, status: 'ACTIVE', tokenExpiresAt: { gt: now, lte: soon7 } },
        }),
      ])
        .then(([a, b]) => a + b)
        .catch(soft('süresi dolan bağlantılar', 0)),
      // An ad budget still pointing at a month that has ended.
      //
      // The period lock in BudgetAutopilotService is deliberate and correct: a
      // stale-period budget must not independently commit the workspace-shared
      // wallet, so it drops to the ASSISTED human gate. What nothing says is
      // that it HAPPENED. The panel goes on showing AUTONOMOUS while the engine
      // quietly stopped acting on its own and started queueing every step for
      // approval — two very different products, and the owner is told neither.
      //
      // Self-clearing by construction: rolling the budget to the current month
      // silences it, which is also the fix.
      this.prisma.growthBudget
        .findFirst({
          where: {
            workspaceId,
            status: 'ACTIVE',
            autonomyLevel: 'AUTONOMOUS',
            periodKey: { not: now.toISOString().slice(0, 7) },
          },
          select: { periodKey: true },
          orderBy: { periodKey: 'desc' },
        })
        .catch(soft('dönemi geçmiş bütçe', null)),
      // How new leads get an owner — read to PAIR with the unassigned count.
      //
      // The count alone is a number; what makes it a decision is why nobody has
      // one. LeadAutoAssignerService.pickAssignee runs at INGRESS only
      // (conversation ingress, Meta lead-gen, voice) and the model's own
      // docstring says "newly-created leads", so switching the strategy on does
      // NOT reach a lead that is already sitting there — and leads created by
      // research acceptance, import or the API never pass through it at all.
      // An owner who turns distribution on and expects the backlog to clear
      // would be waiting for something that cannot happen.
      this.prisma.marketingDistributionConfig
        .findUnique({ where: { workspaceId }, select: { strategy: true } })
        .catch(soft('lead dağıtımı', null)),
      // The workspace's own monthly AI budget. Hitting it SUSPENDS unattended
      // work — nightly research stops finding leads — and a stop nobody
      // announced is the failure this brief exists to prevent.
      this.spend.workspaceStatus(workspaceId, now).catch(soft('AI bütçesi', null)),
      this.usage.breakdown(workspaceId, 1).catch(soft('AI harcaması', null)),
      // The strategy autopilot's lane. Read even when it turns out to be
      // ASSISTED: the block below is skipped for every lane but AUTONOMOUS, so
      // the ordinary workspace's brief is byte-for-byte what it was.
      this.prisma.marketingStrategy
        .findUnique({ where: { workspaceId }, select: { autonomyLevel: true } })
        .catch(soft('otopilot şeridi', null)),
      // What the autopilot RAN, most recent first: DONE/FAILED inside the
      // window, plus whatever is still PROPOSED.
      this.prisma.strategyAction
        .findMany({
          where: { workspaceId },
          select: { kind: true, title: true, status: true, resultRef: true, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
          take: PLAN_READ_LIMIT,
        })
        .catch(soft('otopilot eylemleri', [] as PlanActionRow[])),
      // The blocked half, read on its own predicate rather than hoped for
      // inside the hundred freshest rows. See SKIP_READ_LIMIT: the conditional
      // stamping that keeps the weekly re-synthesis from firing also keeps
      // these rows' updatedAt down, so they are the first to fall out of a
      // recency window - the one half of the report nothing else can rebuild.
      this.prisma.strategyAction
        .findMany({
          where: {
            workspaceId,
            status: { in: BLOCKED_STATUSES },
            resultRef: { startsWith: SKIP_PREFIX },
          },
          select: { kind: true, title: true, status: true, resultRef: true, updatedAt: true },
          orderBy: { updatedAt: 'desc' },
          take: SKIP_READ_LIMIT,
        })
        .catch(soft('otopilotun yapmadıkları', [] as PlanActionRow[])),
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
    // Deliberately FIRST: it qualifies every count under it.
    if (unread.length)
      needsYou.push(
        `Brifingin ${unread.length} sinyali okunamadı (${unread.join(', ')}) — bu başlıklardaki sayılar eksik, "sorun yok" demek değil`,
      );
    if (overdueTasks) needsYou.push(`${overdueTasks} görev gecikmiş`);
    if (unassigned) {
      const off = !distribution || distribution.strategy === 'DISABLED';
      needsYou.push(
        off
          ? `${unassigned} yeni lead kimseye atanmamış — otomatik dağıtım KAPALI; açmak yalnızca bundan sonra gelenleri atar, bekleyenleri elle dağıtmak gerekir`
          : `${unassigned} yeni lead kimseye atanmamış — dağıtım açık (${distribution.strategy}), demek ki bunlar otomatik atamanın geçmediği bir yoldan geldi (araştırma, içe aktarma veya API)`,
      );
    }
    // First in the list once rendered would be nicer still, but order here
    // follows the section's existing convention; what matters is that a waiting
    // customer now appears at all.
    if (waitingReplies)
      needsYou.push(`${waitingReplies} konuşma yanıt bekliyor — müşteri en son yazan taraf`);
    if (stalePeriodBudget)
      needsYou.push(
        `Reklam bütçesi hâlâ ${stalePeriodBudget.periodKey} dönemine ait — motor AUTONOMOUS görünüyor ama bu ay kendi başına uygulamıyor, her adım onaya düşüyor`,
      );
    if (brokenAccounts)
      needsYou.push(
        `${brokenAccounts} bağlı hesabın yetkisi düşmüş — yeniden bağlanana kadar o kanaldan yayın/mesaj gitmez`,
      );
    if (agentlessWaiting)
      needsYou.push(
        `${agentlessWaiting} kanalda müşteri bekliyor ama AI ajanı bağlı değil — oraya yalnızca bir insan yanıt verebilir`,
      );
    // Over-cap first: it has a real consequence right now (research stopped),
    // and reporting both states would say the same thing twice.
    if (aiBudget?.overCap) {
      needsYou.push(
        `AI aylık bütçesi doldu ($${aiBudget.spentUsd} / $${aiBudget.capUsd}) — gece araştırması durdu, ay dönene kadar yeni lead gelmez`,
      );
    } else if (aiBudget && aiBudget.ratio !== null && aiBudget.ratio >= 0.8) {
      needsYou.push(
        `AI aylık bütçesinin %${Math.round(aiBudget.ratio * 100)}'i harcandı ($${aiBudget.spentUsd} / $${aiBudget.capUsd}) — dolunca gece araştırması durur`,
      );
    }
    if (vendorRefused)
      needsYou.push(
        `AI sağlayıcısı çağrıları reddediyor: hesabın kredisi bitmiş — ${vendorRefused} iş bu yüzden düştü, yüklenene kadar AI kimseye yanıt veremez`,
      );
    // The vendor-refusal line above already accounts for its own jobs, so this
    // one reports only what it does NOT explain. Live, all six dead jobs were
    // the same six credit refusals, and the brief listed them as two separate
    // problems — the effect above its own cause. Double-counting one incident
    // is not a cosmetic flaw: a reader who notices it has to start doubting
    // every other number in the section, which is the whole section's value.
    //
    // Clamped rather than subtracted outright: vendorRefused matches on
    // lastError at ANY status, so a job still retrying counts there while it is
    // not yet dead here, and a naive subtraction would go negative.
    const unexplainedDeadJobs = Math.max(0, deadJobs - vendorRefused);
    if (unexplainedDeadJobs)
      needsYou.push(
        `${unexplainedDeadJobs} arka plan işi tüm denemelerini tüketip başarısız oldu — sebebi işin kaydında yazıyor`,
      );
    if (expiringSoon)
      needsYou.push(
        `${expiringSoon} bağlı hesabın yetkisi bir hafta içinde doluyor — şimdi yenilenmezse o kanal sessizce durur`,
      );
    if (overdueDrafts)
      needsYou.push(
        `${overdueDrafts} kampanyanın başlama zamanı geçmiş ama hâlâ taslakta — ya başlat ya tarihini ileri al`,
      );

    const today: string[] = [];
    if (dueTasks) today.push(`${dueTasks} görevin süresi bugün doluyor`);
    if (dueFollowUps) today.push(`${dueFollowUps} lead için takip zamanı`);

    const autopilot = this.autopilotLines(
      strategyLane?.autonomyLevel ?? null, planActions, blockedActions, since, now,
    );

    return {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      forDate: since.toISOString().slice(0, 10),
      didHappen: { title: 'Dün ne oldu', items: didHappen },
      autopilot: { title: 'Otopilot', items: autopilot },
      needsYou: { title: 'Sensiz ilerlemiyor', items: needsYou },
      today: { title: 'Bugün', items: today },
      // A digest with nothing in any section is noise. Sending "hiçbir şey
      // olmadı" every morning is how a daily email becomes one nobody opens.
      //
      // The autopilot section is the ONE inversion of that rule, and it earns
      // it: for a workspace that armed the autonomous lane, a day on which the
      // machine did nothing is itself the finding. Staying quiet about it is
      // precisely how a plan sat frozen at nine PROPOSED actions for weeks with
      // nothing anywhere saying a word. So its lines count as substance, and
      // `autopilotLines` always produces at least one for an armed lane.
      empty: substantive + autopilot.length + needsYou.length + today.length === 0,
    };
  }

  /**
   * The autopilot's own report: what it did, and what it did NOT do and why.
   *
   * Both halves, always, for an armed lane. A report that lists only successes
   * is how a machine acting on someone's behalf loses their trust — and it is
   * also unfalsifiable, because "nothing to report" and "everything is blocked"
   * render identically. The owner asked never to DEAL with marketing; they did
   * not ask never to KNOW.
   *
   * Silent for SHADOW/ASSISTED: those lanes are approval-gated on purpose and
   * already have a surface (the approvals queue). A daily "your autopilot is
   * off" is the kind of line that can never reach zero, which is how a section
   * teaches people to skip the section.
   */
  private autopilotLines(
    lane: string | null,
    actions: PlanActionRow[],
    /** The blocked half, from its own bounded read - see SKIP_READ_LIMIT. */
    blockedActions: PlanActionRow[],
    since: Date,
    now: Date,
  ): string[] {
    if (lane !== 'AUTONOMOUS') return [];
    const lines: string[] = [];
    const inWindow = (a: { updatedAt: Date }) => new Date(a.updatedAt).getTime() >= since.getTime();
    const names = (items: Array<{ title: string }>) => {
      const shown = items.slice(0, 3).map((a) => `"${a.title}"`).join(', ');
      return items.length > 3 ? `${shown} (+${items.length - 3})` : shown;
    };

    // DONE does NOT mean "produced something". Three of the four executors
    // degrade to `{ resultRef: undefined }` on a real, common condition and the
    // orchestrator still records DONE: the content and community executors when
    // the Content AI is unconfigured, the ad executor when no connected Meta ad
    // account exists. Counting those as work applied is the loudest possible
    // version of the failure this whole section exists to prevent - the brief
    // reporting a success for an action that did nothing at all, on precisely
    // the setups where nothing CAN happen. The row already carries the signal:
    // a DONE action with no `resultRef` produced no entity.
    const done = actions.filter((a) => a.status === 'DONE' && inWindow(a));
    const produced = done.filter((a) => !!a.resultRef);
    const hollow = done.filter((a) => !a.resultRef);
    if (produced.length) lines.push(`${produced.length} eylem uygulandı: ${names(produced)}`);
    if (hollow.length) {
      lines.push(
        `${hollow.length} eylem çalıştı ama ortada bir sonuç yok — yürütücü elinde araç olmadan döndü ` +
          `(genellikle AI anahtarı tanımlı değil ya da bağlı bir reklam/sosyal hesap yok): ${names(hollow)}`,
      );
    }

    const failed = actions.filter((a) => a.status === 'FAILED' && inWindow(a));
    for (const f of failed.slice(0, 3)) {
      // `execute` records the executor's own message as `error:<why>` — the
      // reason the platform gave, not our paraphrase of it.
      const why = (f.resultRef ?? '').startsWith('error:')
        ? f.resultRef!.slice('error:'.length)
        : 'sebebi kaydedilmemiş';
      lines.push(`"${f.title}" yapılamadı: ${why}`);
    }
    if (failed.length > 3) lines.push(`ve ${failed.length - 3} eylem daha başarısız oldu`);

    // The half nothing could report before: actions the machine DECIDED not to
    // run, grouped by the reason it stamped on them. Read separately from the
    // rows above precisely so it cannot be crowded out by them.
    const blocked = new Map<string, PlanActionRow[]>();
    for (const a of blockedActions) {
      const ref = a.resultRef ?? '';
      if (!ref.startsWith(SKIP_PREFIX)) continue;
      const bucket = blocked.get(ref) ?? [];
      bucket.push(a);
      blocked.set(ref, bucket);
    }
    for (const [reason, items] of blocked) {
      // NOT IN THE DAILY BLOCK. `no-executor` is a fact about the PRODUCT, not
      // about last night: CHANNEL_SETUP has no executor, so this line would
      // repeat every single morning, identical, for as long as the action
      // exists - and this file already names that shape as the thing that
      // teaches people to skip a section. But it must not vanish either: an
      // action parked in an armed plan forever is worth knowing about once.
      // So it reports WEEKLY, on Mondays, and says the two things that clear
      // it - which is what makes it a line that can reach zero.
      if (reason === SKIP_NO_EXECUTOR) {
        if (now.getUTCDay() !== WEEKLY_REPORT_DAY) continue;
        lines.push(
          `Haftalık: ${items.length} eylem otomatik çalışmıyor — ${SKIP_TEXT[reason]}. ` +
            `Elle yapıp ya da plandan çıkarıp (reddet) bu satırı kapatabilirsin: ${names(items)}`,
        );
        continue;
      }
      // An unknown code still reports, carrying the raw reason: a brief that
      // silently drops what it does not recognise is back to reporting silence.
      const text = SKIP_TEXT[reason] ?? reason.slice(SKIP_PREFIX.length);
      lines.push(`${items.length} eylem yapılmadı — ${text}: ${names(items)}`);
    }

    if (!lines.length) {
      const pending = actions.filter((a) => a.status === 'PROPOSED').length;
      lines.push(
        pending
          ? `Otopilot açık ama dün hiçbir eylem uygulanmadı; ${pending} eylem hâlâ bekliyor — bir sonraki tur bunları ele alacak`
          : 'Otopilot açık ama planda uygulanacak eylem kalmadı — strateji yenilenmeden yeni iş çıkmaz',
      );
    }
    return lines;
  }

  /** Plain-text body. Sections with no items are omitted, not shown empty. */
  render(digest: WorkspaceDigest): string {
    const lines: string[] = [`${digest.workspaceName} — ${digest.forDate}`, ''];
    for (const section of [digest.didHappen, digest.autopilot, digest.needsYou, digest.today]) {
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
