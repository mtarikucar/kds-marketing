import { CommerceSourcesService } from './commerce-sources.service';
import { openSecret } from '../../../common/crypto/secret-box.helper';

const WS = 'ws-1';
const KEY = Buffer.alloc(32, 7).toString('base64'); // test-only master key

function fakePrisma() {
  const rows: any[] = [];
  let seq = 0;
  const match = (r: any, where: any) => Object.entries(where).every(([k, v]) => r[k] === v);
  return {
    rows,
    db: {
      commerceSource: {
        findMany: jest.fn(async ({ where, select }: any) =>
          rows.filter((r) => match(r, where)).map((r) => pick(r, select)),
        ),
        findFirst: jest.fn(async ({ where }: any) => rows.find((r) => match(r, where)) ?? null),
        create: jest.fn(async ({ data }: any) => {
          if (rows.some((r) => r.workspaceId === data.workspaceId && r.slug === data.slug)) {
            const { Prisma } = jest.requireActual('@prisma/client');
            throw new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x' });
          }
          const row = {
            id: `src-${++seq}`,
            status: 'ACTIVE',
            previousSecret: null,
            previousSecretExpiresAt: null,
            lastEventAt: null,
            createdAt: new Date(),
            revokedAt: null,
            ...data,
          };
          rows.push(row);
          return row;
        }),
        update: jest.fn(async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id), data)),
      },
    } as any,
  };
}

function pick(row: any, select?: Record<string, boolean>) {
  if (!select) return row;
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
}

describe('CommerceSourcesService (contract §1.7, A11)', () => {
  const saved = process.env.MARKETING_SECRET_KEY;
  beforeEach(() => {
    process.env.MARKETING_SECRET_KEY = KEY;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.MARKETING_SECRET_KEY;
    else process.env.MARKETING_SECRET_KEY = saved;
  });

  it('creates a source and shows the secret exactly once; the DB holds it sealed', async () => {
    const { db, rows } = fakePrisma();
    const svc = new CommerceSourcesService(db);
    const created = await svc.create(WS, { slug: 'shop', kind: 'CUSTOM' });
    expect(created.signingSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(created).toMatchObject({ slug: 'shop', kind: 'CUSTOM', status: 'ACTIVE' });
    expect(rows[0].signingSecret).toMatch(/^v1:/);
    expect(rows[0].signingSecret).not.toContain(created.signingSecret);
    expect(openSecret(rows[0].signingSecret)).toBe(created.signingSecret);

    const listed = await svc.list(WS);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain('whsec_');
    expect(listed[0]).not.toHaveProperty('signingSecret');
    expect(listed[0]).not.toHaveProperty('previousSecret');
  });

  it('refuses a bad slug and an unknown kind', async () => {
    const svc = new CommerceSourcesService(fakePrisma().db);
    await expect(svc.create(WS, { slug: 'Shop!', kind: 'CUSTOM' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.create(WS, { slug: 'x', kind: 'CUSTOM' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.create(WS, { slug: 'shop', kind: 'MAGENTO' as never })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a duplicate slug in the same workspace with 409', async () => {
    const svc = new CommerceSourcesService(fakePrisma().db);
    await svc.create(WS, { slug: 'shop', kind: 'CUSTOM' });
    await expect(svc.create(WS, { slug: 'shop', kind: 'SHOPIFY' })).rejects.toMatchObject({ status: 409 });
  });

  it('refuses to create a source when the secret box is not configured (409 SECRET_BOX_NOT_CONFIGURED)', async () => {
    delete process.env.MARKETING_SECRET_KEY;
    // The helper caches the key once read, so load a fresh copy of both.
    let Fresh!: typeof CommerceSourcesService;
    jest.isolateModules(() => {
      Fresh = require('./commerce-sources.service').CommerceSourcesService;
    });
    const svc = new Fresh(fakePrisma().db);
    await expect(svc.create(WS, { slug: 'shop', kind: 'CUSTOM' })).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: 'SECRET_BOX_NOT_CONFIGURED' }),
    });
  });

  it('rotates: new secret once, the old one keeps verifying for 24 h, then stops', async () => {
    const { db } = fakePrisma();
    const svc = new CommerceSourcesService(db);
    const { id, signingSecret: oldSecret } = await svc.create(WS, { slug: 'shop', kind: 'CUSTOM' });
    const now = new Date('2026-10-21T10:00:00Z');
    const rotated = await svc.rotate(WS, id, now);
    expect(rotated.signingSecret).toMatch(/^whsec_/);
    expect(rotated.signingSecret).not.toBe(oldSecret);

    const during = await svc.resolveForVerification(WS, 'shop', new Date(now.getTime() + 23 * 3600_000));
    expect(during!.secrets).toEqual([rotated.signingSecret, oldSecret]);
    const after = await svc.resolveForVerification(WS, 'shop', new Date(now.getTime() + 24 * 3600_000 + 1));
    expect(after!.secrets).toEqual([rotated.signingSecret]);
  });

  it('revokes without deleting: the source stops resolving, the row stays', async () => {
    const { db, rows } = fakePrisma();
    const svc = new CommerceSourcesService(db);
    const { id } = await svc.create(WS, { slug: 'shop', kind: 'CUSTOM' });
    await svc.revoke(WS, id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('REVOKED');
    expect(rows[0].revokedAt).toBeInstanceOf(Date);
    expect(await svc.resolveForVerification(WS, 'shop')).toBeNull();
  });

  it('never reaches another workspace: resolve, rotate and revoke are workspace-scoped', async () => {
    const { db } = fakePrisma();
    const svc = new CommerceSourcesService(db);
    const { id } = await svc.create(WS, { slug: 'shop', kind: 'CUSTOM' });
    expect(await svc.resolveForVerification('ws-other', 'shop')).toBeNull();
    await expect(svc.rotate('ws-other', id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.revoke('ws-other', id)).rejects.toMatchObject({ status: 404 });
    expect(await svc.list('ws-other')).toEqual([]);
  });
});
