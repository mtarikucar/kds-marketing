import { Logger } from '@nestjs/common';
import { UnpricedSpendWarner } from './unpriced-spend.warner';

describe('UnpricedSpendWarner', () => {
  let logger: { warn: jest.Mock };
  let clock: number;
  let warner: UnpricedSpendWarner;

  beforeEach(() => {
    logger = { warn: jest.fn() };
    clock = 1_000_000;
    warner = new UnpricedSpendWarner(logger as unknown as Logger, () => clock);
  });

  it('warns the first time and suppresses repeats within the hour', () => {
    for (let i = 0; i < 50; i++) warner.warn('ws1', 'SMS_SEGMENT', 'no tariff');
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('warns again once the window has passed', () => {
    warner.warn('ws1', 'SMS_SEGMENT', 'no tariff');
    clock += 59 * 60 * 1000;
    warner.warn('ws1', 'SMS_SEGMENT', 'no tariff');
    expect(logger.warn).toHaveBeenCalledTimes(1);

    clock += 2 * 60 * 1000;
    warner.warn('ws1', 'SMS_SEGMENT', 'no tariff');
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('keeps workspaces and units independent', () => {
    // One noisy tenant must never mask another tenant's unmetered spend.
    warner.warn('ws1', 'SMS_SEGMENT', 'a');
    warner.warn('ws2', 'SMS_SEGMENT', 'b');
    warner.warn('ws1', 'APIFY_RUN', 'c');
    expect(logger.warn).toHaveBeenCalledTimes(3);
  });

  it('says what to do about it', () => {
    warner.warn('ws1', 'FIRECRAWL_PAGE', 'no RESEARCH tariff (qty 12)');
    const msg = String(logger.warn.mock.calls[0][0]);
    expect(msg).toContain('UNPRICED SPEND');
    expect(msg).toContain('qty 12');
    expect(msg).toContain('ChannelTariff');
  });
});
