import { ForbiddenException } from '@nestjs/common';
import { assertFeature } from './mcp-feature-gate';

const entitlementsWith = (features: Record<string, boolean>) => ({
  getEffective: jest.fn().mockResolvedValue({ features }),
}) as never;

describe('assertFeature (MCP entitlement gate)', () => {
  it('passes when the workspace package includes the feature', async () => {
    const ents = entitlementsWith({ mediaGen: true });
    await expect(assertFeature(ents, 'ws1', 'mediaGen')).resolves.toBeUndefined();
    expect((ents as any).getEffective).toHaveBeenCalledWith('ws1');
  });

  it('refuses cleanly (403 + FEATURE_NOT_IN_PACKAGE) instead of crashing when it does not', async () => {
    // A workspace on a package without mediaGen must get an answer the agent
    // can relay to a human ("upgrade your plan"), not a 500 from a service
    // that assumed the feature existed.
    const err = await assertFeature(entitlementsWith({ mediaGen: false }), 'ws1', 'mediaGen').catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({ code: 'FEATURE_NOT_IN_PACKAGE', feature: 'mediaGen' }),
    );
  });

  it('treats a missing key as not-entitled (deny by default)', async () => {
    await expect(assertFeature(entitlementsWith({}), 'ws1', 'socialCampaigns')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('names the feature in the message so the model can tell the user what to buy', async () => {
    const err = await assertFeature(
      entitlementsWith({ socialCampaigns: false }),
      'ws1',
      'socialCampaigns',
    ).catch((e) => e);
    expect(String((err.getResponse() as { message: string }).message)).toContain('socialCampaigns');
  });

  it('reads entitlements for the CALLER workspace only', async () => {
    const ents = entitlementsWith({ mediaGen: true });
    await assertFeature(ents, 'ws-a', 'mediaGen');
    expect((ents as any).getEffective).toHaveBeenCalledTimes(1);
    expect((ents as any).getEffective.mock.calls[0][0]).toBe('ws-a');
  });
});
