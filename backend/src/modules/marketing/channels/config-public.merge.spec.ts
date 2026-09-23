import { mergeConfigPublic } from './config-public.merge';

/**
 * The statement itself is the contract here: everything this file protects
 * lives in the SQL, not in the JavaScript around it. A mock cannot prove
 * Postgres' `||` semantics, so what these pin is that the write is ONE
 * statement, that it names only the keys the caller passed, that it is scoped
 * by workspace, and that the key-removal path is spelled the way the operator
 * requires.
 */
describe('mergeConfigPublic', () => {
  const REF = { id: 'ch-1', workspaceId: 'ws-1' };

  function db() {
    return { $executeRaw: jest.fn().mockResolvedValue(1) };
  }

  /** The statement's text, with each parameter collapsed to `?`. */
  function sqlOf(exec: ReturnType<typeof db>): string {
    return exec.$executeRaw.mock.calls[0][0].strings.join('?').replace(/\s+/g, ' ').trim();
  }

  function valuesOf(exec: ReturnType<typeof db>): any[] {
    return exec.$executeRaw.mock.calls[0][0].values;
  }

  it('merges in the database rather than writing a blob back', async () => {
    const exec = db();
    await mergeConfigPublic(exec, REF, { imapLastUid: 500 });

    expect(exec.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = sqlOf(exec);
    // `||` is the shallow merge Postgres applies to the row AS IT IS, which is
    // the whole point: a writer can only touch the keys it named.
    expect(sql).toContain('"configPublic" = (COALESCE("configPublic", \'{}\'::jsonb)) || ?::jsonb');
    expect(sql).toContain('UPDATE "channels"');
    expect(valuesOf(exec)[0]).toBe('{"imapLastUid":500}');
  });

  it('is workspace-scoped, like every other channel write', async () => {
    const exec = db();
    await mergeConfigPublic(exec, REF, { a: 1 });
    expect(sqlOf(exec)).toContain('WHERE "id" = ? AND "workspaceId" = ?');
    expect(valuesOf(exec).slice(1)).toEqual(['ch-1', 'ws-1']);
  });

  it('removes a key before merging, so a patch may both drop and set', async () => {
    const exec = db();
    await mergeConfigPublic(exec, REF, { externalId: 'x' }, ['pendingAddress']);
    // `jsonb - text` is key removal; the cast is what makes the operator
    // resolve against a bound parameter.
    expect(sqlOf(exec)).toContain("(COALESCE(\"configPublic\", '{}'::jsonb) - ?::text) || ?::jsonb");
    expect(valuesOf(exec)[0]).toBe('pendingAddress');
    expect(valuesOf(exec)[1]).toBe('{"externalId":"x"}');
  });

  it('keeps an explicit null as a null, never as a deleted key', async () => {
    // The pollers clear their poison-pill counters by writing null on purpose:
    // a cleared counter has to be visible in the row instead of looking like a
    // key nobody ever wrote.
    const exec = db();
    await mergeConfigPublic(exec, REF, { imapFailUid: null });
    expect(valuesOf(exec)[0]).toBe('{"imapFailUid":null}');
  });

  it('reports how many rows it touched, so a deleted channel is a no-op', async () => {
    const exec = db();
    exec.$executeRaw.mockResolvedValue(0);
    await expect(mergeConfigPublic(exec, REF, { a: 1 })).resolves.toBe(0);
  });
});
