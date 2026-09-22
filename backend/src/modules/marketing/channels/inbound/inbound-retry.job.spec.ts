import { INBOUND_RETRY_KIND } from './inbound-item.service';
import { InboundRetryJob } from './inbound-retry.job';

/**
 * The retry job is the half of "never lose mail" that runs after the poller has
 * moved on. Its whole contract: fetch back exactly the one item that failed,
 * never a different one, and when it cannot, make sure the item ends up parked
 * where a human can see it instead of quietly stopping.
 */
describe('InboundRetryJob', () => {
  function build(over: { get?: any; replayer?: any } = {}) {
    const items: any = {
      get: over.get ?? jest.fn().mockResolvedValue({
        id: 'it-1',
        workspaceId: 'ws-1',
        channelId: 'ch-1',
        source: 'imap',
        itemKey: '42:1001',
        state: 'FAILED',
        attempts: 1,
      }),
      replayerFor: jest.fn().mockReturnValue(over.replayer),
      quarantine: jest.fn().mockResolvedValue(undefined),
    };
    const runner: any = { registerHandler: jest.fn() };
    const job = new InboundRetryJob(items, runner);
    return { items, runner, job };
  }

  const claimed = (payload: any) => ({
    id: 'job-1',
    workspaceId: 'ws-1',
    kind: INBOUND_RETRY_KIND,
    payload,
    attempts: 0,
  });

  it('registers the handler and its exhaustion hook under the documented kind', () => {
    const { runner, job } = build();
    job.onModuleInit();
    expect(runner.registerHandler).toHaveBeenCalledTimes(1);
    const [kind, handler, onExhausted] = runner.registerHandler.mock.calls[0];
    expect(kind).toBe(INBOUND_RETRY_KIND);
    expect(typeof handler).toBe('function');
    expect(typeof onExhausted).toBe('function');
  });

  it('replays exactly the item the row names, not the payload', async () => {
    const replayer = jest.fn().mockResolvedValue(undefined);
    const { items, job } = build({ replayer });
    // The payload deliberately carries a stale source; the row is the truth.
    await job.handle(claimed({ itemId: 'it-1', workspaceId: 'ws-1', source: 'webhook' }));
    expect(items.get).toHaveBeenCalledWith('ws-1', 'it-1');
    expect(items.replayerFor).toHaveBeenCalledWith('imap');
    expect(replayer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'it-1', channelId: 'ch-1', itemKey: '42:1001' }),
    );
  });

  it('scopes the ledger read to the job row, not to the payload', async () => {
    const replayer = jest.fn().mockResolvedValue(undefined);
    const { items, job } = build({ replayer });
    // A payload naming another tenant must not redirect the read: a mail
    // landing in the wrong workspace's inbox has no recovery.
    await job.handle({
      id: 'job-1',
      workspaceId: 'ws-1',
      kind: INBOUND_RETRY_KIND,
      payload: { itemId: 'it-1', workspaceId: 'ws-victim' },
      attempts: 0,
    });
    expect(items.get).toHaveBeenCalledWith('ws-1', 'it-1');
  });

  it('does not replay an item a later poll already ingested', async () => {
    const replayer = jest.fn();
    const get = jest.fn().mockResolvedValue({
      id: 'it-1',
      workspaceId: 'ws-1',
      channelId: 'ch-1',
      source: 'imap',
      itemKey: '42:1001',
      state: 'DONE',
      attempts: 1,
    });
    const { job } = build({ get, replayer });
    await expect(job.handle(claimed({ itemId: 'it-1', workspaceId: 'ws-1' }))).resolves.toBeUndefined();
    expect(replayer).not.toHaveBeenCalled();
  });

  it('throws when no source can replay it, so the runner parks it instead of reporting success', async () => {
    const { job } = build({ replayer: undefined });
    await expect(job.handle(claimed({ itemId: 'it-1', workspaceId: 'ws-1' }))).rejects.toThrow(
      /replayer/i,
    );
  });

  it('gives up quietly on a payload that names no item — there is nothing to park', async () => {
    const { items, job } = build();
    await expect(job.handle(claimed({}))).resolves.toBeUndefined();
    expect(items.get).not.toHaveBeenCalled();
  });

  it('quarantines the item when the runner has spent every attempt', async () => {
    const { items, runner, job } = build();
    job.onModuleInit();
    // Go through the hook the runner actually holds, not the method name.
    const onExhausted = runner.registerHandler.mock.calls[0][2];
    await onExhausted(claimed({ itemId: 'it-1', workspaceId: 'ws-1' }), 'connection reset');
    expect(items.quarantine).toHaveBeenCalledWith('ws-1', 'it-1', 'connection reset');
  });

  it('survives a payload the exhaustion hook cannot address', async () => {
    const { items, job } = build();
    await expect(job.exhausted(claimed({}), 'connection reset')).resolves.toBeUndefined();
    expect(items.quarantine).not.toHaveBeenCalled();
  });
});
