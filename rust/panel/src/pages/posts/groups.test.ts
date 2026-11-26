import { describe, expect, it } from 'vitest';
import type { PostRow, Sibling } from '@/api/postsPage';
import { ago, postRow, rows as fixtureRows, TIKTOK } from '@/test/postsPage';
import { groupCover, groupKey, groupRows, versionIds } from './groups';

describe('groupRows', () => {
  it('makes one line of two platforms of one content, in the server order', () => {
    const ig = postRow('slot:a', { area_id: 'area-x', status: 'failed' });
    const tt = postRow('slot:b', { area_id: 'area-x', channel: TIKTOK });
    const groups = groupRows([ig, tt]);
    expect(groups).toHaveLength(1);
    expect(groups[0].lead.id).toBe('slot:a');
    expect(groups[0].members.map((m) => m.id)).toEqual(['slot:a', 'slot:b']);
  });

  it('keeps unrelated rows apart, and rows of no content each on their own', () => {
    const rows = [
      postRow('slot:a', { area_id: 'area-x' }),
      postRow('slot:b', { area_id: 'area-y' }),
      postRow('need:n1', { area_id: null }),
      postRow('need:n2', { area_id: null }),
      postRow('slot:c', { area_id: 'area-x' }),
    ];
    const groups = groupRows(rows);
    expect(groups.map((g) => g.members.map((m) => m.id))).toEqual([['slot:a', 'slot:c'], ['slot:b'], ['need:n1'], ['need:n2']]);
    // Every row the read returned is on exactly one line.
    expect(groups.flatMap((g) => g.members)).toHaveLength(rows.length);
  });

  it('stands a group where its first row stood', () => {
    const rows = [postRow('slot:a', { area_id: 'area-y' }), postRow('slot:b', { area_id: 'area-x' }), postRow('slot:c', { area_id: 'area-y' })];
    expect(groupRows(rows).map((g) => g.key)).toEqual(['area:area-y', 'area:area-x']);
    expect(groupKey(postRow('need:n', { area_id: null }))).toBe('need:n');
  });

  it('takes the picture from the first member that has one', () => {
    const cover = { material_id: 'm', mime: 'image/jpeg', preview_url: '/m.jpg', preview_expires_at: null, ai_generated: false };
    const [g] = groupRows([postRow('slot:a', { area_id: 'x' }), postRow('slot:b', { area_id: 'x', cover })]);
    expect(groupCover(g).id).toBe('slot:b');
  });
});

describe('versionIds', () => {
  it('lists the row and its siblings in the list order, the unlisted ones after', () => {
    const row = postRow('slot:b', {
      siblings: [
        { row_id: 'slot:far', channel: TIKTOK, publish_at: null, status: 'scheduled' },
        { row_id: 'slot:a', channel: TIKTOK, publish_at: null, status: 'failed' },
      ],
    });
    const listed = [postRow('slot:a'), row];
    expect(versionIds(row, listed)).toEqual(['slot:a', 'slot:b', 'slot:far']);
    expect(versionIds(postRow('slot:alone'), [])).toEqual(['slot:alone']);
  });
});

/**
 * The server builds `siblings` over the rows of one area and nothing else (`area_rows` in
 * `jt_app/src/usecases/content/posts.rs`: every listed row of an area comes from it, and each
 * row's siblings are the area's other rows, earlier packages' posts included). The table's lines
 * group by `area_id`, so a row's line and its siblings hold the same rows.
 */
function agree(listed: PostRow[]) {
  const lines = groupRows(listed);
  const ids = new Set(listed.map((r) => r.id));
  for (const row of listed) {
    const line = lines.find((g) => g.members.some((m) => m.id === row.id))!;
    const others = line.members.map((m) => m.id).filter((id) => id !== row.id).sort();
    expect(row.siblings.map((s) => s.row_id).filter((id) => ids.has(id)).sort(), row.id).toEqual(others);
  }
}

/** Rows of one area as the server gives them: each with every other as a sibling. */
function area(id: string, members: PostRow[]): PostRow[] {
  const placed = members.map((m) => ({ ...m, area_id: id }));
  const sib = (r: PostRow): Sibling => ({ row_id: r.id, channel: r.channel, publish_at: r.publish_at, status: r.status });
  return placed.map((m) => ({ ...m, siblings: placed.filter((o) => o.id !== m.id).map(sib) }));
}

describe('a line and the siblings agree', () => {
  it('on the page fixture', () => agree(fixtureRows));

  it('for a redone content: the earlier package’s published post and the content made again are one line', () => {
    const redone = area('area-r', [
      postRow('content:area-r', { kind: 'content', title: 'Yeniden hazırlanan', channel: null, status: 'revising' }),
      postRow('slot:old-ig', { title: 'İlk hali', status: 'published', published_at: ago(86_400_000) }),
    ]);
    const other = area('area-s', [postRow('slot:s1', { title: 'Başka içerik' })]);
    const listed = [...redone, ...other];
    agree(listed);
    expect(groupRows(listed).map((g) => g.members.map((m) => m.id))).toEqual([['content:area-r', 'slot:old-ig'], ['slot:s1']]);
  });
});
