import * as fs from 'fs';
import * as path from 'path';

/**
 * Drift tripwire for the 20260901110000 de-dup migration's keep-rule.
 *
 * That migration deletes the second `social_post_targets` row of every
 * (post, account) pair, and a window function decides which one lives. It used
 * to carry that ORDER BY twice — once to move the losers' metrics, once to
 * delete them — with a comment asking the next editor to keep the copies in
 * step. Two copies of a rule that MUST agree is a bug waiting for a hurried
 * afternoon: the moment they disagree, the row whose metrics were salvaged is
 * not the row that survives, and (once the archive was added) the keeper the
 * archive names is not the keeper that was kept.
 *
 * There is now exactly one copy, materialised into a temp table the other
 * statements read. This spec is what stops a well-meant "inline the CTE again"
 * from quietly restoring the hazard — and it pins the direction of the rule
 * that was wrong on the way in, which no behavioural test can express as
 * cheaply: PENDING must beat any other row that never reached the network,
 * because `publishDuePost` publishes PENDING targets and nothing else.
 *
 * The behaviour itself is covered against real Postgres in
 * test/e2e/social-post-target-dedup-migration.realdb.e2e-spec.ts.
 */
describe('social_post_targets de-dup migration — keep-rule drift tripwire', () => {
  const sql = fs.readFileSync(
    path.resolve(
      __dirname,
      '../../../../prisma/migrations/20260901110000_social_post_target_account_unique/migration.sql',
    ),
    'utf8',
  );

  it('ranks the duplicates in exactly one place', () => {
    const rankings = sql.match(/PARTITION BY "postId", "socialAccountId"/g) ?? [];
    expect(rankings).toHaveLength(1);
  });

  it('prefers a PENDING row over any other row that never reached the network', () => {
    // Rules 1 and 2 (PUBLISHED, then anything holding an externalPostId) run
    // first and are untouched by this; rule 3 only ever chooses between two rows
    // the network has never seen, and there the queued one has to win.
    expect(sql).toContain(`("status" = 'PENDING') DESC`);

    // The shipped-and-backwards form. Keeping the FAILED half of a
    // (FAILED, PENDING) pair drops that network from a post that is still queued
    // to go out, and attachTargets will not let the composer re-attach it.
    expect(sql).not.toContain(`("status" <> 'PENDING')`);
  });
});
