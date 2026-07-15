import { Prisma } from '@prisma/client';
import { MediaGenService } from './media-gen.service';
import { DEFAULT_IMAGE_MODEL } from './media-models.config';

const WS = 'ws-1';
const FLAG = 'GROWTH_AUTOPILOT_AUTONOMY';

// Default image model = $0.03 (media-models.config priceUsd)
const IMG_USD = 0.03;

function makeSvc(opts: { budget?: unknown; walletEntry?: unknown; asset?: unknown } = {}) {
  const prisma: any = {
    generatedAsset: {
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({ id: 'asset-1' }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(opts.asset ?? null),
      findFirst: jest.fn().mockResolvedValue(opts.asset ?? null),
      delete: jest.fn().mockResolvedValue({}),
    },
    growthBudget: { findFirst: jest.fn().mockResolvedValue(opts.budget ?? null) },
    growthWalletLedgerEntry: { findUnique: jest.fn().mockResolvedValue(opts.walletEntry ?? null) },
  };
  const credits = { reserve: jest.fn().mockResolvedValue(undefined), refund: jest.fn().mockResolvedValue(undefined), chargeOverage: jest.fn().mockResolvedValue(undefined) };
  const provider = { name: 'fal', isConfigured: jest.fn().mockReturnValue(true), submit: jest.fn().mockResolvedValue({ providerRequestId: 'req-9' }), getResult: jest.fn() };
  const jobs = { schedule: jest.fn().mockResolvedValue('job-1') };
  const r2 = { isConfigured: jest.fn().mockReturnValue(true), upload: jest.fn(), deleteKeys: jest.fn().mockResolvedValue(undefined) };
  const runner = { registerHandler: jest.fn() };
  const wallet = {
    debit: jest.fn().mockResolvedValue({ wallet: {}, replayed: false }),
    credit: jest.fn().mockResolvedValue({ wallet: {}, replayed: false }),
  };
  const svc = new MediaGenService(prisma, credits as any, provider as any, jobs as any, r2 as any, runner as any, wallet as any);
  return { svc, prisma, credits, provider, jobs, wallet };
}

const ENGINE_DTO = { type: 'IMAGE' as const, prompt: 'a cat', createdById: 'u1', socialCampaignId: 'c1', campaignItemId: 'ci-1' };

describe('MediaGenService engine wallet drawdown (Growth Autopilot D4)', () => {
  let prevFlag: string | undefined;
  beforeEach(() => { prevFlag = process.env[FLAG]; process.env[FLAG] = '1'; });
  afterEach(() => {
    if (prevFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prevFlag;
  });

  describe('requestGeneration pre-debit', () => {
    it('pre-debits the wallet (ENGINE_SPEND, mediagen:{assetId}) BEFORE the provider submit', async () => {
      const { svc, provider, wallet } = makeSvc({ budget: { id: 'b1' } });
      await svc.requestGeneration(WS, ENGINE_DTO);
      expect(wallet.debit).toHaveBeenCalledWith(WS, expect.objectContaining({
        kind: 'ENGINE_SPEND', ref: 'mediagen:asset-1', amount: IMG_USD,
      }));
      expect(wallet.debit.mock.invocationCallOrder[0]).toBeLessThan(provider.submit.mock.invocationCallOrder[0]);
    });

    it('resolves the current-period ACTIVE armed-AUTONOMOUS budget workspace-scoped', async () => {
      const { svc, prisma } = makeSvc({ budget: { id: 'b1' } });
      await svc.requestGeneration(WS, ENGINE_DTO);
      expect(prisma.growthBudget.findFirst).toHaveBeenCalledWith({
        where: {
          workspaceId: WS,
          periodKey: new Date().toISOString().slice(0, 7),
          status: 'ACTIVE',
          autonomyLevel: 'AUTONOMOUS',
        },
        select: { id: true },
      });
    });

    it('rejects the ENGINE generation fail-closed when the wallet is insufficient (no submit, credits refunded, no phantom wallet refund)', async () => {
      const { svc, prisma, credits, provider, wallet } = makeSvc({ budget: { id: 'b1' } });
      wallet.debit.mockRejectedValue(new Error('Insufficient growth credit'));
      await expect(svc.requestGeneration(WS, ENGINE_DTO)).rejects.toThrow('Insufficient growth credit');
      expect(provider.submit).not.toHaveBeenCalled();
      // terminalized + credit reservation refunded via the conditional claim
      expect(prisma.generatedAsset.updateMany).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }));
      expect(credits.refund).toHaveBeenCalledWith(WS, 3);
      // the failed debit wrote NO wallet ledger entry → no refund credit
      expect(wallet.credit).not.toHaveBeenCalled();
    });

    it('refunds the wallet pre-debit when provider.submit throws after a successful debit', async () => {
      const { svc, provider, wallet } = makeSvc({
        budget: { id: 'b1' },
        walletEntry: { workspaceId: WS, delta: new Prisma.Decimal('-0.03') },
      });
      provider.submit.mockRejectedValue(new Error('fal 500'));
      await expect(svc.requestGeneration(WS, ENGINE_DTO)).rejects.toThrow('fal 500');
      expect(wallet.credit).toHaveBeenCalledTimes(1);
      const [ws, movement] = wallet.credit.mock.calls[0];
      expect(ws).toBe(WS);
      expect(movement.kind).toBe('REFUND');
      expect(movement.ref).toBe('mediagen-refund:asset-1');
      expect(movement.amount.toString()).toBe('0.03');
    });

    it('does NOT query the budget or debit the wallet for a manual generation (no campaignItemId)', async () => {
      const { svc, prisma, provider, wallet } = makeSvc({ budget: { id: 'b1' } });
      await svc.requestGeneration(WS, { type: 'IMAGE', prompt: 'a cat', createdById: 'u1' });
      expect(prisma.growthBudget.findFirst).not.toHaveBeenCalled();
      expect(wallet.debit).not.toHaveBeenCalled();
      expect(provider.submit).toHaveBeenCalled();
    });

    it('does NOT debit the wallet when no armed-AUTONOMOUS budget exists (engine dto, budget null)', async () => {
      const { svc, provider, wallet } = makeSvc({ budget: null });
      await svc.requestGeneration(WS, ENGINE_DTO);
      expect(wallet.debit).not.toHaveBeenCalled();
      expect(provider.submit).toHaveBeenCalled();
    });

    it('does NOT query the budget when the env flag is off', async () => {
      delete process.env[FLAG];
      const { svc, prisma, wallet } = makeSvc({ budget: { id: 'b1' } });
      await svc.requestGeneration(WS, ENGINE_DTO);
      expect(prisma.growthBudget.findFirst).not.toHaveBeenCalled();
      expect(wallet.debit).not.toHaveBeenCalled();
    });
  });

  describe('finalize refunds', () => {
    const ENGINE_ASSET = {
      id: 'asset-1', workspaceId: WS, status: 'GENERATING', model: DEFAULT_IMAGE_MODEL,
      costCreditsReserved: 3, params: { campaignItemId: 'ci-1' }, type: 'IMAGE',
    };

    it('FAILED → refunds the wallet pre-debit (kind REFUND, ref mediagen-refund:{assetId}) even with the flag off', async () => {
      delete process.env[FLAG]; // a debit already taken must refund regardless of current arming
      const { svc, credits, wallet } = makeSvc({
        asset: ENGINE_ASSET,
        walletEntry: { workspaceId: WS, delta: new Prisma.Decimal('-0.03') },
      });
      await svc.finalizeAsset('asset-1', { status: 'FAILED', error: 'boom' });
      expect(credits.refund).toHaveBeenCalledWith(WS, 3);
      expect(wallet.credit).toHaveBeenCalledWith(WS, expect.objectContaining({
        kind: 'REFUND', ref: 'mediagen-refund:asset-1',
      }));
      expect(wallet.credit.mock.calls[0][1].amount.toString()).toBe('0.03');
    });

    it('BLOCKED → refunds the wallet pre-debit', async () => {
      const { svc, wallet } = makeSvc({
        asset: ENGINE_ASSET,
        walletEntry: { workspaceId: WS, delta: new Prisma.Decimal('-0.03') },
      });
      await svc.finalizeAsset('asset-1', { status: 'BLOCKED', error: 'NSFW' });
      expect(wallet.credit).toHaveBeenCalledWith(WS, expect.objectContaining({ ref: 'mediagen-refund:asset-1' }));
    });

    it('FAILED engine asset with NO wallet debit entry → no wallet refund', async () => {
      const { svc, credits, wallet } = makeSvc({ asset: ENGINE_ASSET, walletEntry: null });
      await svc.finalizeAsset('asset-1', { status: 'FAILED', error: 'boom' });
      expect(credits.refund).toHaveBeenCalled();
      expect(wallet.credit).not.toHaveBeenCalled();
    });

    it('FAILED manual asset (no campaignItemId) → never looks up or credits the wallet', async () => {
      const { svc, prisma, wallet } = makeSvc({ asset: { ...ENGINE_ASSET, params: {} } });
      await svc.finalizeAsset('asset-1', { status: 'FAILED', error: 'boom' });
      expect(prisma.growthWalletLedgerEntry.findUnique).not.toHaveBeenCalled();
      expect(wallet.credit).not.toHaveBeenCalled();
    });

    it('does not refund the wallet when the terminal claim is lost (count 0)', async () => {
      const { svc, prisma, wallet } = makeSvc({
        asset: ENGINE_ASSET,
        walletEntry: { workspaceId: WS, delta: new Prisma.Decimal('-0.03') },
      });
      prisma.generatedAsset.updateMany.mockResolvedValue({ count: 0 });
      await svc.finalizeAsset('asset-1', { status: 'FAILED', error: 'boom' });
      expect(wallet.credit).not.toHaveBeenCalled();
    });

    it('ignores a wallet ledger entry from another workspace', async () => {
      const { svc, wallet } = makeSvc({
        asset: ENGINE_ASSET,
        walletEntry: { workspaceId: 'ws-OTHER', delta: new Prisma.Decimal('-0.03') },
      });
      await svc.finalizeAsset('asset-1', { status: 'FAILED', error: 'boom' });
      expect(wallet.credit).not.toHaveBeenCalled();
    });

    // The wallet pre-debit is on the REQUESTED duration; a shorter clip must
    // credit back the unused USD (else the real-cash wallet is overcharged even
    // though the credit meter is trued up).
    it('COMPLETED shorter-than-requested video → credits back the unused wallet USD (mediagen-reconcile)', async () => {
      const VIDEO_ASSET = {
        id: 'asset-1', workspaceId: WS, status: 'GENERATING',
        model: 'fal-ai/veo3/fast', // $0.25/sec
        costCreditsReserved: 250, params: { campaignItemId: 'ci-1' }, type: 'VIDEO', durationSec: 10,
      };
      const { svc, prisma, wallet } = makeSvc({
        asset: VIDEO_ASSET,
        walletEntry: { workspaceId: WS, delta: new Prisma.Decimal('-2.5') }, // reserved 10s = $2.50
      });
      (svc as any).download = jest.fn().mockResolvedValue({ buffer: Buffer.from('x'), size: 1 });
      (prisma as any).generatedAsset.updateMany.mockResolvedValue({ count: 1 });
      const r2up = (svc as any).r2.upload as jest.Mock;
      r2up.mockResolvedValue({ url: 'https://r2/v.mp4', key: 'social/ws-1/v.mp4', mime: 'video/mp4' });

      // Provider returns a 4s clip (< the requested 10s).
      await svc.finalizeAsset('asset-1', { status: 'COMPLETED', outputs: [{ url: 'https://fal/v.mp4', mime: 'video/mp4', durationSec: 4 }] });

      // reserved $2.50 − actual (4s × $0.25 = $1.00) = $1.50 credited back.
      expect(wallet.credit).toHaveBeenCalledWith(WS, expect.objectContaining({ ref: 'mediagen-reconcile:asset-1', kind: 'REFUND' }));
      expect(wallet.credit.mock.calls[0][1].amount.toString()).toBe('1.5');
    });

    it('COMPLETED at the EXACT requested duration → no wallet reconcile (nothing unused)', async () => {
      const VIDEO_ASSET = {
        id: 'asset-1', workspaceId: WS, status: 'GENERATING', model: 'fal-ai/veo3/fast',
        costCreditsReserved: 250, params: { campaignItemId: 'ci-1' }, type: 'VIDEO', durationSec: 10,
      };
      const { svc, prisma, wallet } = makeSvc({
        asset: VIDEO_ASSET,
        walletEntry: { workspaceId: WS, delta: new Prisma.Decimal('-2.5') },
      });
      (svc as any).download = jest.fn().mockResolvedValue({ buffer: Buffer.from('x'), size: 1 });
      (prisma as any).generatedAsset.updateMany.mockResolvedValue({ count: 1 });
      ((svc as any).r2.upload as jest.Mock).mockResolvedValue({ url: 'u', key: 'k', mime: 'video/mp4' });
      await svc.finalizeAsset('asset-1', { status: 'COMPLETED', outputs: [{ url: 'u', mime: 'video/mp4', durationSec: 10 }] });
      expect(wallet.credit).not.toHaveBeenCalled();
    });
  });

  describe('deleteAsset refund', () => {
    it('refunds the wallet pre-debit when a non-terminal engine asset is deleted', async () => {
      const asset = {
        id: 'asset-1', workspaceId: WS, status: 'GENERATING', model: DEFAULT_IMAGE_MODEL,
        costCreditsReserved: 3, params: { campaignItemId: 'ci-1' }, r2Key: null, thumbnailR2Key: null,
      };
      const { svc, wallet } = makeSvc({
        asset,
        walletEntry: { workspaceId: WS, delta: new Prisma.Decimal('-0.03') },
      });
      await svc.deleteAsset(WS, 'asset-1');
      expect(wallet.credit).toHaveBeenCalledWith(WS, expect.objectContaining({ ref: 'mediagen-refund:asset-1' }));
    });

    // A concurrent finalize can write r2Key AFTER getAsset's stale snapshot read
    // it as null — deleting the STALE keys would orphan the freshly-stored blob.
    it('deletes the R2 keys off the CURRENT (deleted) row, not the stale pre-claim snapshot', async () => {
      const staleAsset = {
        id: 'asset-1', workspaceId: WS, status: 'GENERATING', model: DEFAULT_IMAGE_MODEL,
        costCreditsReserved: 3, params: {}, r2Key: null, thumbnailR2Key: null, // stale: r2Key not yet written
      };
      const { svc, prisma } = makeSvc({ asset: staleAsset });
      // The delete claim lost to a concurrent finalize (row already terminal)…
      prisma.generatedAsset.updateMany.mockResolvedValue({ count: 0 });
      // …but delete() returns the row's CURRENT keys (the finalize stored keyA).
      prisma.generatedAsset.delete.mockResolvedValue({ r2Key: 'social/ws-1/keyA.png', thumbnailR2Key: null });
      const r2 = (svc as any).r2;

      await svc.deleteAsset(WS, 'asset-1');

      // The freshly-stored blob is deleted (not the stale null snapshot → no orphan).
      expect(r2.deleteKeys).toHaveBeenCalledWith(['social/ws-1/keyA.png']);
    });
  });

  // Audit B5: the orphan sweep reaps abandoned generations and refunds AI
  // credits — but its findMany omitted `params`, so refundEngineWalletDebit
  // saw undefined, judged the asset non-engine, and the real-cash ENGINE_SPEND
  // pre-debit was silently kept (permanent money loss: the row goes terminal,
  // so no later path can refund it either).
  describe('sweepOrphanAssets engine refund (audit B5)', () => {
    it('reaping an abandoned engine generation refunds the wallet pre-debit too', async () => {
      const stuck = {
        id: 'asset-1', workspaceId: WS, status: 'GENERATING',
        costCreditsReserved: 3, params: { campaignItemId: 'ci-1' },
      };
      const { svc, prisma, credits, wallet } = makeSvc({
        walletEntry: { workspaceId: WS, delta: new Prisma.Decimal('-0.03') },
      });
      prisma.generatedAsset.findMany = jest.fn(async ({ where }: any) =>
        where.status?.in ? [stuck] : []); // stuck pass sees the orphan; retention pass sees none

      await svc.sweepOrphanAssets();

      expect(credits.refund).toHaveBeenCalledWith(WS, 3);
      expect(wallet.credit).toHaveBeenCalledWith(WS, expect.objectContaining({
        kind: 'REFUND', ref: 'mediagen-refund:asset-1',
      }));
    });

    it('reaping an abandoned MANUAL generation never touches the wallet', async () => {
      const stuck = {
        id: 'asset-2', workspaceId: WS, status: 'QUEUED',
        costCreditsReserved: 3, params: {},
      };
      const { svc, prisma, wallet } = makeSvc({});
      prisma.generatedAsset.findMany = jest.fn(async ({ where }: any) =>
        where.status?.in ? [stuck] : []);

      await svc.sweepOrphanAssets();

      expect(wallet.credit).not.toHaveBeenCalled();
      expect(prisma.growthWalletLedgerEntry.findUnique).not.toHaveBeenCalled();
    });
  });
});
