import { PlatformAiSpendCron } from './platform-ai-spend.cron';

/**
 * Cost used to be discoverable only by going to look, and nothing pointed
 * anyone at it — so the first signal that the balance was emptying was the
 * balance being empty.
 */
describe('PlatformAiSpendCron', () => {
  const make = (state: string, extra: Record<string, unknown> = {}) => {
    const spend = {
      status: jest.fn().mockResolvedValue({
        state,
        period: '2026-08',
        spentUsd: 60,
        capUsd: 100,
        ratio: 0.6,
        backgroundBlocked: state === 'EXCEEDED',
        ...extra,
      }),
    };
    const cron = new PlatformAiSpendCron(spend as any);
    const error = jest.spyOn((cron as any).logger, 'error').mockImplementation(() => undefined);
    const warn = jest.spyOn((cron as any).logger, 'warn').mockImplementation(() => undefined);
    return { cron, error, warn };
  };

  it('says nothing while spend is comfortable', async () => {
    const { cron, error, warn } = make('OK');
    await cron.watch();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns ONCE at WARN — hourly repetition would train people to ignore it', async () => {
    const { cron, warn } = make('WARN');
    await cron.watch();
    await cron.watch();
    await cron.watch();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('$60 of $100');
  });

  it('re-announces EXCEEDED every tick — it is a state someone must decide about', async () => {
    const { cron, error } = make('EXCEEDED');
    await cron.watch();
    await cron.watch();
    expect(error).toHaveBeenCalledTimes(2);
    expect(String(error.mock.calls[0][0])).toContain('unattended AI suspended');
  });

  it('escalates CRITICAL to error, not warn', async () => {
    const { cron, error, warn } = make('CRITICAL');
    await cron.watch();
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when no cap is configured', async () => {
    const { cron, error, warn } = make('DISABLED');
    await cron.watch();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never throws out of a cron tick', async () => {
    const spend = { status: jest.fn().mockRejectedValue(new Error('boom')) };
    const cron = new PlatformAiSpendCron(spend as any);
    jest.spyOn((cron as any).logger, 'warn').mockImplementation(() => undefined);
    await expect(cron.watch()).resolves.toBeUndefined();
  });
});
