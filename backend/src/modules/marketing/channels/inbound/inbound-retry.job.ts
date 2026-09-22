import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  ClaimedJob,
  ScheduledJobRunnerService,
} from '../../scheduling/scheduled-job-runner.service';
import { INBOUND_RETRY_KIND, InboundItemService } from './inbound-item.service';

/**
 * The second half of "never lose mail": fetch back exactly the one item that
 * failed to ingest, after the poller has moved on.
 *
 * The poller cannot be the retry mechanism on its own. Its cursor may not
 * advance past a failed item, so a single poison mail would otherwise hold the
 * whole mailbox — the head-of-line risk that makes "stop on error" worse than
 * "log and skip". This job is what lets the cursor move: the item is recorded,
 * queued by id, and re-fetched on the runner's own backoff.
 *
 * Three properties are load-bearing:
 *
 *  - **It re-reads the row.** The payload carries only `{itemId, workspaceId}`.
 *    A job that carried the channel and the uid could replay a uid the row no
 *    longer names (a `uidValidity` change repoints every uid in the mailbox),
 *    which is the one way a retry lands the WRONG mail in a tenant's inbox.
 *  - **It throws on failure.** The runner's backoff is the retry schedule, and
 *    its DLQ is the deadline. Returning quietly would report success for mail
 *    that never arrived.
 *  - **Exhaustion parks the item.** `onExhausted` quarantines it and the
 *    ledger tells the owner, so the end of the retries is an event somebody
 *    sees rather than a `FAILED` row in a queue nobody reads.
 */
@Injectable()
export class InboundRetryJob implements OnModuleInit {
  private readonly logger = new Logger(InboundRetryJob.name);

  constructor(
    private readonly items: InboundItemService,
    private readonly runner: ScheduledJobRunnerService,
  ) {}

  onModuleInit(): void {
    this.runner.registerHandler(
      INBOUND_RETRY_KIND,
      (job) => this.handle(job),
      (job, error) => this.exhausted(job, error),
    );
  }

  async handle(job: ClaimedJob): Promise<void> {
    const target = address(job);
    if (!target) {
      // Nothing addressable: there is no row to park and no uid to fetch, so
      // retrying would only repeat the same malformed payload until the runner
      // gave up. A loud log is the whole remedy — this shape is a code
      // regression, not a transient failure.
      this.logger.error(`inbound retry: job ${job.id} carries no itemId — nothing to replay`);
      return;
    }
    const row = await this.items.get(target.workspaceId, target.itemId);
    // The item was erased (KVKK) or belongs to a workspace this job no longer
    // names. Either way there is nothing to fetch and nothing was lost.
    if (!row) return;
    // A later poll pass got there first. Replaying would create a second copy
    // of a mail that is already in the inbox.
    if (row.state === 'DONE' || row.state === 'SKIPPED') return;

    const replay = this.items.replayerFor(row.source);
    if (!replay) {
      // Deliberately a throw: a source with no replayer is a wiring defect, and
      // the runner turning that into a DLQ + quarantine is exactly the visible
      // parking this package promises.
      throw new Error(`inbound retry: no replayer registered for source "${row.source}"`);
    }
    await replay({
      id: row.id,
      workspaceId: row.workspaceId,
      channelId: row.channelId,
      source: row.source,
      itemKey: row.itemKey,
    });
  }

  /** The runner spent every attempt — park the item where a human can see it. */
  async exhausted(job: ClaimedJob, error: string): Promise<void> {
    const target = address(job);
    if (!target) return;
    await this.items.quarantine(target.workspaceId, target.itemId, error);
  }
}

/**
 * Who this job is allowed to read.
 *
 * The workspace comes from the job ROW's own column, not from the payload —
 * `payload` is free-form JSON that a later writer could get wrong, while
 * `scheduled_jobs.workspaceId` is the column the runner claims on and the one
 * every other feature scopes by. Scoping the ledger read to the payload would
 * make "which tenant's mailbox does this retry touch" a caller-supplied
 * answer, and a mail landing in the wrong workspace's inbox is the one inbound
 * failure with no recovery. The payload is the fallback only for a row written
 * before the column was set.
 */
function address(job: ClaimedJob): { itemId: string; workspaceId: string } | null {
  const p = job.payload as { itemId?: unknown; workspaceId?: unknown } | null;
  const itemId = typeof p?.itemId === 'string' ? p.itemId : '';
  const fromPayload = typeof p?.workspaceId === 'string' ? p.workspaceId : '';
  const workspaceId = job.workspaceId || fromPayload;
  return itemId && workspaceId ? { itemId, workspaceId } : null;
}
