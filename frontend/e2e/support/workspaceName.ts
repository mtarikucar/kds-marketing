/**
 * Names for the per-test fixture workspace.
 *
 * The `workspace` fixture used to name its workspace `E2E ${testInfo.title}`,
 * which is DETERMINISTIC: the same spec produced the same name on every run,
 * forever. The backend derives the workspace slug from that name and resolves
 * collisions by linear probing —
 * `marketing-auth.service.ts#createWorkspaceRow`:
 *
 *     const base = slugify(dto.workspaceName);   // ← .slice(0, 40)
 *     let slug = base;
 *     for (let i = 2; ; i++) {
 *       const taken = await tx.workspace.findUnique({ where: { slug } });
 *       if (!taken) break;
 *       if (i > 50) throw new ConflictException('Could not allocate a workspace slug');
 *       slug = `${base}-${i}`;
 *     }
 *
 * So the Nth run of a given spec cost N SEQUENTIAL round trips inside an
 * interactive transaction just to pick a slug, and the 51st run of that spec
 * failed outright with a 409. Against a long-lived E2E database this is a
 * clock that only ever ticks one way: specs get slower every run until they
 * blow the 10s `expect` budget (chrome renders, the page body never arrives),
 * and then they stop working altogether. Because the counter advances with
 * every run, the decay tracks RUN ORDER — which reads exactly like "the branch
 * I just checked out broke it".
 *
 * The fix is to stop manufacturing the collision: give every fixture workspace
 * a name whose slug has never been used before.
 *
 * WHY THE TOKEN GOES FIRST — this is the whole subtlety. `slugify` keeps only
 * the FIRST 40 CHARACTERS. Every E2E title is longer than that, so a token
 * appended to the end is sliced straight back off and the slug is byte-for-byte
 * the deterministic one again — a fix that looks right, changes the name, and
 * fixes nothing. The token has to sit inside the first 40 characters, i.e.
 * immediately after the `E2E ` marker. `workspaceName.test.ts` asserts exactly
 * that, against a copy of the backend's slugify, so the trailing-suffix version
 * of this fix cannot pass.
 *
 * The full title still rides along after the token: the NAME is stored whole
 * (110 chars), so a leftover row is still traceable to the spec that made it,
 * which is what the original comment was protecting.
 */

/** Longest workspace name the fixture will send. Matches the previous cap. */
const MAX_NAME = 110;

/**
 * How many characters of `slugify`'s 40-char window the backend keeps.
 * Mirrored here only so the test can prove the token survives the cut.
 */
export const SLUG_WINDOW = 40;

let counter = 0;

/**
 * A token that is unique across parallel workers AND across runs, in 10-12
 * base36 characters:
 *   - `Date.now()` orders rows by run and is unique between runs;
 *   - a per-process random pair separates workers that start in the same ms
 *     (Playwright runs each worker in its own process, so a module-level
 *     counter alone would NOT be unique across workers);
 *   - a module-level counter separates two workspaces made by one worker
 *     inside the same millisecond.
 */
function uniqueToken(): string {
  const ms = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 4);
  const seq = (counter++).toString(36);
  return `${ms}${rand}${seq}`;
}

/**
 * The workspace name for a test, e.g.
 * `E2E mkq3x8f2a0 the pricing page offers exactly one plan`.
 *
 * `token` is injectable so the unit test can assert the SHAPE deterministically
 * instead of asserting on a clock.
 */
export function workspaceNameFor(title: string, token: string = uniqueToken()): string {
  return `E2E ${token} ${title}`.slice(0, MAX_NAME);
}
