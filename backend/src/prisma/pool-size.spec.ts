import { availableParallelism } from 'os';
import { poolSizeFor } from './pool-size';

describe('poolSizeFor', () => {
  const prismaDefault = availableParallelism() * 2 + 1;

  it('reads connection_limit from the URL', () => {
    expect(
      poolSizeFor(
        'postgresql://marketing:secret@postgres:5432/marketing?schema=public&connection_limit=40&pool_timeout=20',
      ),
    ).toBe(40);
  });

  it("falls back to Prisma's own default when the URL does not set one", () => {
    expect(poolSizeFor('postgresql://marketing:marketing@localhost:5432/marketing?schema=public')).toBe(
      prismaDefault,
    );
  });

  it.each(['0', '-3', 'ten', '2.5', ''])('ignores connection_limit=%p, which Prisma would not use either', (raw) => {
    expect(poolSizeFor(`postgresql://u:p@h:5432/db?connection_limit=${raw}`)).toBe(prismaDefault);
  });

  it('falls back when there is no URL, or one that does not parse', () => {
    expect(poolSizeFor(undefined)).toBe(prismaDefault);
    expect(poolSizeFor('not a url')).toBe(prismaDefault);
  });
});
