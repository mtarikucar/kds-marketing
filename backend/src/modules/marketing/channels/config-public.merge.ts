import { Prisma } from '@prisma/client';

/**
 * The one way to write part of `Channel.configPublic`.
 *
 * ## Why a raw statement
 *
 * `configPublic` is ONE jsonb column with five independent writers: the INBOX
 * poller's cursor (`imapLastUid` + its poison-pill counters), the Sent
 * reconciler's own cursor, the mailbox `health` block written after every send
 * and every sweep, the NetGSM MO recovery stamp, and the tenant's settings
 * save. None of them is serialized against the others — the pollers hold three
 * DIFFERENT advisory locks, `pollOne()` (the IDLE debounce) holds none, and a
 * health write holds none ever.
 *
 * Each writer used to read the blob, patch its own keys and write the WHOLE
 * object back. Re-reading immediately before the write narrows that window to
 * a few milliseconds; it does not close it, and the two outcomes are both
 * silent. A health write landing on a stale copy restores an old
 * `imapLastUid`, so the next tick re-fetches the same fifty messages (ingest
 * dedupes, so nobody sees it — the mailbox just pays for it, every tick). A
 * cursor write landing on a copy read before the OAuth sweep erases the
 * `oauthReauthRequiredAt` the owner's account-center card exists to show, so
 * the card goes quiet about a mailbox that is in fact dead.
 *
 * `jsonb || jsonb` is a shallow merge the DATABASE performs against the row as
 * it is at write time, so a writer can only ever touch the keys it named.
 *
 * ## What this does NOT fix
 *
 * Two writers patching the SAME key still lose each other: `health.send`'s
 * `since` and the backoff's `consecutiveFailures + 1` are computed in JS from
 * a read. This closes CROSS-key clobbering — health versus cursor, cursor
 * versus settings — which is the damage that crosses feature boundaries.
 *
 * ## Shallow, and that is the point
 *
 * `||` replaces a top-level key outright rather than merging into it, so
 * `{ health: … }` replaces the whole health block exactly as the old spread
 * did. A caller that means to keep a sibling key inside its own block still
 * has to carry it in the patch.
 */

/** A channel write is workspace-scoped or it is not a channel write. */
export interface ChannelConfigRef {
  id: string;
  workspaceId: string;
}

/** `PrismaService`, or a transaction client when the merge rides with other writes. */
type RawExecutor = { $executeRaw: (q: Prisma.Sql) => Promise<number> };

/**
 * Merge `patch` onto this channel's `configPublic`, optionally removing
 * top-level keys first.
 *
 * Returns the number of rows written: `0` means the channel is gone (or is not
 * this workspace's), which every caller treats as a silent no-op — a channel
 * that no longer exists has nothing to describe, and re-creating it would be
 * worse than saying nothing.
 *
 * `dropKeys` is applied BEFORE the merge, so a key named in both survives with
 * the patch's value. It exists for the one key a caller genuinely has to
 * delete (`pendingAddress`); everything else is written, never removed.
 */
export function mergeConfigPublic(
  db: RawExecutor,
  ref: ChannelConfigRef,
  patch: Record<string, unknown>,
  dropKeys: string[] = [],
): Promise<number> {
  const base = dropKeys.reduce<Prisma.Sql>(
    (sql, key) => Prisma.sql`${sql} - ${key}::text`,
    Prisma.sql`COALESCE("configPublic", '{}'::jsonb)`,
  );
  return db.$executeRaw(Prisma.sql`
    UPDATE "channels"
       SET "configPublic" = (${base}) || ${JSON.stringify(patch)}::jsonb
     WHERE "id" = ${ref.id}
       AND "workspaceId" = ${ref.workspaceId}
  `);
}
