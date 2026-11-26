import type { PostRow } from '@/api/postsPage';

/**
 * One line of the table: the rows of one content (the production area the server builds them
 * from, `PostRow.area_id`, the same relation its `siblings` and "Aynı içerikten" name), or a row
 * of no content on its own (a request of the çekim listesi, a post whose content is gone).
 *
 * The rows are those the read returned, in the server's order (§3.2.6: what waits for the owner
 * first), so a group stands where its first row stood and `lead` is its most pressing row; a
 * filter's group holds only the rows that filter returned, so every chip is a counted post.
 */
export interface PostGroup {
  key: string;
  /** The first row of the group in the server's order: its title, its dots. */
  lead: PostRow;
  /** Every row of the group the read returned, in the server's order. */
  members: PostRow[];
}

/** The group a row belongs to: its content's area, else the row itself. */
export const groupKey = (row: Pick<PostRow, 'id' | 'area_id'>): string => (row.area_id ? `area:${row.area_id}` : row.id);

/** `rows` as table lines, one per content, in the order their first row came. */
export function groupRows(rows: readonly PostRow[]): PostGroup[] {
  const groups = new Map<string, PostGroup>();
  for (const row of rows) {
    const key = groupKey(row);
    const group = groups.get(key);
    if (group) group.members.push(row);
    else groups.set(key, { key, lead: row, members: [row] });
  }
  return [...groups.values()];
}

/** The picture of a group: its lead's cover, else the first member's that has one. */
export function groupCover(group: PostGroup): PostRow {
  return group.lead.cover ? group.lead : group.members.find((m) => m.cover) ?? group.lead;
}

/**
 * Every version of `row`'s content the panel shows, `row` among them: its id and its siblings',
 * in the list's order where the list holds them, the rest after in the server's sibling order.
 */
export function versionIds(row: PostRow, listed: readonly PostRow[]): string[] {
  const ids = [row.id, ...row.siblings.map((s) => s.row_id).filter((id) => id !== row.id)];
  const unique = [...new Set(ids)];
  const at = new Map(listed.map((r, i) => [r.id, i]));
  const index = (id: string) => at.get(id) ?? Number.MAX_SAFE_INTEGER;
  return unique
    .map((id, i) => ({ id, i }))
    .sort((a, b) => index(a.id) - index(b.id) || a.i - b.i)
    .map((x) => x.id);
}
