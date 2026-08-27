import { z } from 'zod';
import { EntitlementsService } from '../../../billing/entitlements.service';
import { MarketingUsersService } from '../../services/marketing-users.service';
import { ScheduledJobService } from '../../scheduling/scheduled-job.service';
import { EmailService } from '../../../../common/services/email.service';
import { McpToolRegistry } from '../mcp-tool-registry';

export interface WorkspaceToolDeps {
  entitlements: EntitlementsService;
  users: MarketingUsersService;
  jobs: ScheduledJobService;
  email: EmailService;
}

/**
 * Workspace info is a pure read over the workspace's effective plan
 * entitlements (package, subscription status, quotas/limits, enabled
 * features) — `EntitlementsService.getEffective` is an existing,
 * already-computed read path (used by every `@RequiresFeature` gate), so
 * this tool reuses it rather than adding a new service method.
 */
export function registerWorkspaceTools(registry: McpToolRegistry, deps: WorkspaceToolDeps): void {
  registry.register({
    name: 'jeeta.get_workspace_info',
    description:
      'Get this workspace\'s effective plan info: package, subscription status, quotas/limits and which features are enabled. Read-only.',
    domain: 'workspace',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async (ctx) => deps.entitlements.getEffective(ctx.workspaceId),
  });

  /**
   * The id-resolution tool the assignment surface was missing.
   *
   * Four tools take an `assignedToId` — create_task (REQUIRED on an API-key
   * session, which has no human caller to default to), assign_lead,
   * assign_conversation, create_opportunity — and nothing in the catalogue
   * returned a user id. So a connected agent could be told "assignedToId is
   * required" and have no way to satisfy it: creating a task was impossible,
   * not merely awkward. Found by running the real flow on a customer lead.
   *
   * Read-only and deliberately narrow: ids, names, role and status of this
   * workspace's members. `findAll` already excludes SYSTEM memberships (the
   * research/automation principals), so those never leak into an assignment
   * picker. Phones/emails come from the same existing read the panel uses —
   * this is teammate directory data, not customer PII.
   */
  registry.register({
    name: 'jeeta.list_team',
    description:
      "List this workspace's team members with their user ids, names, role and status. Use it to resolve an " +
      'assignedToId before calling jeeta.create_task (which requires one), jeeta.assign_lead, ' +
      'jeeta.assign_conversation or jeeta.create_opportunity. Read-only.',
    domain: 'workspace',
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      activeOnly: z
        .boolean()
        .optional()
        .describe('Only members whose membership is ACTIVE — the ones an assignment will actually accept. Defaults to true.'),
    }),
    handler: async (ctx, args) => {
      const all = await deps.users.findAll(ctx.workspaceId);
      const activeOnly = args.activeOnly !== false;
      return all
        .filter((u) => (activeOnly ? u.status === 'ACTIVE' : true))
        .map((u) => ({
          id: u.id,
          name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
          email: u.email,
          role: u.role,
          status: u.status,
        }));
    },
  });

  /**
   * The queue was unreadable, and that is what kept a broken feature broken.
   *
   * Every deferred thing in this product is a `scheduled_jobs` row — AI
   * replies, follow-ups, campaign batches, lead imports, booking reminders —
   * and each row records the error of its last attempt in `lastError`. Nothing
   * anywhere returned it: no API route, no panel screen, no tool. A job could
   * burn all five attempts, land in FAILED, and the only evidence was a log
   * line on the box.
   *
   * The cost of that was concrete. The conversation engine catches a failed
   * live reply and schedules a retry job precisely so the reason survives — and
   * the reason did survive, in a column with no reader, while the AI answered
   * nobody for weeks and every surface reported that it was working.
   *
   * Read-only and deferred: this is what you reach for when something should
   * have happened and didn't, not part of the per-turn surface.
   */
  registry.register({
    name: 'jeeta.list_background_jobs',
    description:
      "List this workspace's background jobs — AI replies, follow-ups, campaign batches, imports, " +
      'reminders — with their status, attempt count and the error from the last attempt. This is the ' +
      'place to look when something was supposed to happen and did not: a FAILED or repeatedly-retried ' +
      'job here names the actual reason. Read-only.',
    domain: 'workspace',
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({
      kind: z
        .string()
        .optional()
        .describe(
          "Filter to one job kind, e.g. 'conversation.ai_reply', 'conversation.followup', " +
            "'campaign.batch', 'import.batch', 'booking.reminder'.",
        ),
      status: z
        .enum(['PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'])
        .optional()
        .describe('Filter by status. Omit to see every state, newest first.'),
      limit: z.number().int().min(1).max(100).optional().describe('Rows to return. Defaults to 20.'),
    }),
    // The registry hands every handler `Record<string, unknown>`; the zod schema
    // above has already validated these three, so the casts are safe.
    handler: async (ctx, args) =>
      deps.jobs.list(ctx.workspaceId, {
        kind: args.kind as string | undefined,
        status: args.status as string | undefined,
        limit: args.limit as number | undefined,
      }),
  });

  /**
   * Did the scheduled work run at all?
   *
   * The tool above reads one-off jobs. This reads the SCHEDULES, and it exists
   * because that layer was the last one nothing could see. Everything recurring
   * in this product — the morning brief, the job runner itself, ad pulls,
   * review sync, calendar sync, every NetGSM poller, the sweeps — passes
   * through one advisory-lock helper, and none of them recorded that they had
   * run. A cron that silently stopped firing looked exactly like a cron with
   * nothing to do.
   *
   * Read-only and deferred. Platform-level by nature: a cron belongs to the
   * deployment, not to a workspace, and the rows carry job names, timestamps
   * and error strings — no customer data.
   */
  registry.register({
    name: 'jeeta.list_scheduled_runs',
    description:
      "List the platform's recurring jobs. Returns TWO lists. `registered` is every cron the scheduler " +
      'actually has, with `nextAt`, the next time it is due — a populated nextAt proves the schedule is ' +
      'armed. `recorded` is the durable per-job history: last run, last SUCCESS, run and failure counts, ' +
      'and `failing` — a lastRunAt well ahead of lastOkAt means the job is firing and failing, while ' +
      'both being stale means it is not firing at all. For that second case use `ageMinutes` (computed ' +
      "against the deployment's own clock, echoed as `now`) rather than comparing timestamps to your " +
      'own — but note that hourly and DAILY jobs sit in the same list, so a large age is only a problem ' +
      'for a job you know runs often. The failure TEXT is deliberately not returned ' +
      '(see below); read it from the deployment logs. IMPORTANT: the two lists use DIFFERENT naming ' +
      'conventions (the cron `call-cdr-sync` records as `telephony:cdr-sync`), so never conclude a job ' +
      'is uninstrumented just because its name is missing from the other list. Read-only.',
    domain: 'workspace',
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    // `lastError` is stripped here, and the reason is the one thing this tool
    // cannot check: these rows are PLATFORM-level — a cron belongs to the
    // deployment, not to a workspace — while the caller is a single tenant. Any
    // cron may put tenant data in its error text, and one did: the morning brief
    // recorded `<workspaceId> → <owner email>: 535 ...`, so every workspace's
    // agent could read every other workspace's owner and manager addresses
    // through a READ tool that needs no approval. That cron no longer names
    // anyone, but the shape stays dangerous for the NEXT one (an SMS failure
    // carrying a phone number, a bounce carrying an address), and sanitising
    // arbitrary error text is not something to be confident about.
    //
    // What survives is what the tool was built to answer: is it firing, is it
    // succeeding, how often has it failed. `failing` states the comparison the
    // description explains, so the answer does not depend on reading two
    // timestamps correctly. The text stays in the row and in the logs, where the
    // operator — who is allowed to see every tenant — can still reach it.
    handler: async () => {
      const { registered, recorded } = await deps.jobs.listCronHeartbeats();
      // `now` and `ageMinutes` are here because the two failures this tool
      // reports are opposite and only ONE of them was answerable: `failing`
      // covers "it runs and errors", while "it stopped running" has to be read
      // out of a timestamp — against a clock the caller does not share. Reading
      // these rows from UTC+3 near midnight makes every daily job look hours
      // overdue, which is a false alarm the tool was handing out.
      //
      // Deliberately NOT a staleness verdict: a job's expected period is not in
      // these rows (hourly and daily jobs sit side by side), so any threshold
      // here would be a guess, and a guessed alarm is worse than none. This
      // gives the reader the reference point and nothing more.
      const now = Date.now();
      return {
        now: new Date(now).toISOString(),
        registered,
        recorded: recorded.map(({ lastError, ...row }) => ({
          ...row,
          failing: lastError !== null && lastError !== undefined,
          ageMinutes: row.lastRunAt
            ? Math.round((now - new Date(row.lastRunAt).getTime()) / 60000)
            : null,
        })),
      };
    },
  });

  /**
   * Can this deployment send email at all?
   *
   * The transporter is verified once at boot and the answer goes to the logger,
   * so it exists for a moment and is then unreachable. That left exactly one
   * way to find out whether mail works: wait for something to try to send.
   *
   * Live, that meant waiting for the 07:00 brief — which failed, and which by
   * its nature could not announce its own failure by email. Between one morning
   * and the next there was no way to ask the question, let alone check a fix.
   *
   * Platform-level and read-only: one live handshake with the mail host, no
   * message sent, no credentials returned — only whether it worked and, if not,
   * the provider's own words.
   */
  registry.register({
    name: 'jeeta.verify_email_transport',
    description:
      'Check whether this deployment can actually send email: a handshake with the configured SMTP host. ' +
      'Returns whether a mailer is configured at all, whether the connection and credentials were ' +
      'accepted, and the provider error when they were not. Nothing is sent. The handshake AUTHENTICATES, ' +
      'so the answer is cached for 60 seconds and `cached: true` with `checkedAt` tells you when it was ' +
      'actually taken — calling this in a loop would be a login flood, and a mailbox under one starts ' +
      'answering 535, which is the very fault this reports. After changing mail settings, wait out the ' +
      'minute rather than retrying. Read-only.',
    domain: 'workspace',
    defer: true,
    scopes: ['reports.read'],
    risk: 'READ',
    requiresApproval: false,
    inputSchema: z.object({}),
    handler: async () => deps.email.verifyTransport(),
  });
}
