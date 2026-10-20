import { commerceIngestEnabled, commerceRevenueEnabled } from './commerce-ingest.flag';

describe('commerce ingest flags (contract §9): off unless 1 | true | on', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it.each([
    [undefined, false],
    ['', false],
    ['0', false],
    ['false', false],
    ['yes', false],
    ['1', true],
    ['true', true],
    [' TRUE ', true],
    ['on', true],
  ])('%p → %p', (value, expected) => {
    for (const [name, fn] of [
      ['COMMERCE_INGEST_ENABLED', commerceIngestEnabled],
      ['COMMERCE_REVENUE_IN_ROAS', commerceRevenueEnabled],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
      expect(fn()).toBe(expected);
    }
  });

  it('the two flags are independent', () => {
    process.env.COMMERCE_INGEST_ENABLED = 'true';
    delete process.env.COMMERCE_REVENUE_IN_ROAS;
    expect(commerceIngestEnabled()).toBe(true);
    expect(commerceRevenueEnabled()).toBe(false);
  });
});
