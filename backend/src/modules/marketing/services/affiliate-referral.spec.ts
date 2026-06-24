import { AffiliateService } from './affiliate.service';
import { PublicReferralController, readCookie, AFF_REF_COOKIE } from '../controllers/public-referral.controller';

describe('Affiliate referral loop (A8)', () => {
  const WS = 'ws-1';
  let prisma: any;
  let svc: AffiliateService;

  beforeEach(() => {
    prisma = {
      affiliate: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockImplementation(async ({ data }: any) => ({ id: 'aff-new', ...data })),
      },
      affiliateReferral: { create: jest.fn().mockResolvedValue({ id: 'ref-1' }) },
    };
    svc = new AffiliateService(prisma as any);
  });

  describe('ensureReferralSlug', () => {
    it('returns the existing slug without minting a new one', async () => {
      prisma.affiliate.findFirst.mockResolvedValue({ referralSlug: 'rABC' });
      expect(await svc.ensureReferralSlug(WS, 'aff-1')).toBe('rABC');
      expect(prisma.affiliate.update).not.toHaveBeenCalled();
    });
    it('mints a slug when none exists', async () => {
      prisma.affiliate.findFirst.mockResolvedValue({ referralSlug: null });
      const slug = await svc.ensureReferralSlug(WS, 'aff-1');
      expect(slug).toMatch(/^r[A-Za-z0-9_-]+$/);
      expect(prisma.affiliate.update.mock.calls[0][0].data.referralSlug).toBe(slug);
    });
  });

  describe('attributeReferral', () => {
    it('credits a new lead to an ACTIVE same-workspace affiliate', async () => {
      prisma.affiliate.findUnique.mockResolvedValue({ id: 'aff-1', workspaceId: WS, status: 'ACTIVE' });
      const ok = await svc.attributeReferral(WS, 'rXYZ', 'lead-9');
      expect(ok).toBe(true);
      expect(prisma.affiliateReferral.create.mock.calls[0][0].data).toMatchObject({ workspaceId: WS, affiliateId: 'aff-1', referredLeadId: 'lead-9', status: 'PENDING' });
    });
    it('does NOT cross-attribute a lead to an affiliate in a different workspace', async () => {
      prisma.affiliate.findUnique.mockResolvedValue({ id: 'aff-1', workspaceId: 'ws-other', status: 'ACTIVE' });
      expect(await svc.attributeReferral(WS, 'rXYZ', 'lead-9')).toBe(false);
      expect(prisma.affiliateReferral.create).not.toHaveBeenCalled();
    });
    it('ignores a PENDING (unapproved) affiliate and a missing cookie', async () => {
      prisma.affiliate.findUnique.mockResolvedValue({ id: 'aff-1', workspaceId: WS, status: 'PENDING' });
      expect(await svc.attributeReferral(WS, 'rXYZ', 'lead-9')).toBe(false);
      expect(await svc.attributeReferral(WS, null, 'lead-9')).toBe(false);
    });
  });

  it('selfSignup creates a PENDING affiliate for the referrer workspace', async () => {
    const out = await svc.selfSignup(WS, { name: 'Jane', email: 'jane@x.com' });
    expect(prisma.affiliate.create.mock.calls[0][0].data).toMatchObject({ workspaceId: WS, name: 'Jane', status: 'PENDING' });
    expect(out.status).toBe('PENDING');
  });

  describe('PublicReferralController', () => {
    let affiliates: any;
    let config: { get: jest.Mock };
    let ctrl: PublicReferralController;
    const res = () => ({ cookie: jest.fn().mockReturnThis(), redirect: jest.fn().mockReturnThis(), status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }) as any;
    const req = (cookie?: string) => ({ headers: cookie ? { cookie } : {} }) as any;

    beforeEach(() => {
      affiliates = { resolveReferralSlug: jest.fn(), selfSignup: jest.fn().mockResolvedValue({ id: 'x' }) };
      config = { get: jest.fn().mockReturnValue('https://app.example') };
      ctrl = new PublicReferralController(affiliates as any, config as any);
    });

    it('sets the aff_ref cookie + 302s same-origin for an ACTIVE affiliate', async () => {
      affiliates.resolveReferralSlug.mockResolvedValue({ id: 'a', workspaceId: WS, status: 'ACTIVE' });
      const r = res();
      await ctrl.redirect('rXYZ', '/pricing', req(), r);
      expect(r.cookie).toHaveBeenCalledWith(AFF_REF_COOKIE, 'rXYZ', expect.objectContaining({ httpOnly: true, sameSite: 'lax' }));
      expect(r.redirect).toHaveBeenCalledWith(302, 'https://app.example/pricing');
    });

    it('ignores an absolute-URL "to" (no open redirect) and still redirects same-origin', async () => {
      affiliates.resolveReferralSlug.mockResolvedValue({ id: 'a', workspaceId: WS, status: 'ACTIVE' });
      const r = res();
      await ctrl.redirect('rXYZ', 'https://evil.com', req(), r);
      expect(r.redirect).toHaveBeenCalledWith(302, 'https://app.example/');
    });

    it('redirects WITHOUT a cookie for an unknown/inactive slug', async () => {
      affiliates.resolveReferralSlug.mockResolvedValue(null);
      const r = res();
      await ctrl.redirect('nope', undefined as any, req(), r);
      expect(r.cookie).not.toHaveBeenCalled();
      expect(r.redirect).toHaveBeenCalledWith(302, 'https://app.example/');
    });

    it('self-signup 404s for an unknown slug, else creates PENDING for the referrer workspace', async () => {
      affiliates.resolveReferralSlug.mockResolvedValueOnce(null);
      const r1 = res();
      await ctrl.signup('nope', { name: 'J', email: 'j@x.com' } as any, r1);
      expect(r1.status).toHaveBeenCalledWith(404);
      affiliates.resolveReferralSlug.mockResolvedValueOnce({ id: 'a', workspaceId: 'ws-7', status: 'ACTIVE' });
      const r2 = res();
      await ctrl.signup('rXYZ', { name: 'J', email: 'j@x.com' } as any, r2);
      expect(affiliates.selfSignup).toHaveBeenCalledWith('ws-7', { name: 'J', email: 'j@x.com' });
      expect(r2.status).toHaveBeenCalledWith(201);
    });
  });

  it('readCookie parses a value from the raw header', () => {
    expect(readCookie({ headers: { cookie: 'a=1; aff_ref=rXYZ; b=2' } } as any, AFF_REF_COOKIE)).toBe('rXYZ');
    expect(readCookie({ headers: {} } as any, AFF_REF_COOKIE)).toBeUndefined();
  });
});
