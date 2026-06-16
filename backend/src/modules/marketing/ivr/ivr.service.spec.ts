import { BadRequestException, NotFoundException } from '@nestjs/common';
import { IvrService } from './ivr.service';

/**
 * IVR / phone-tree service: renderMenuTwiml emits a <Gather numDigits="1"> with
 * each option, handleDigit routes SUBMENU→nested gather / DIAL→<Dial>E.164 /
 * VOICEMAIL→<Record> / HANGUP→<Hangup> / AI_RECEPTIONIST→handoff signal, an
 * invalid digit re-prompts, option targets are validated same-workspace, and
 * cross-workspace menus are invisible to other workspaces.
 */
describe('IvrService', () => {
  const WS = 'ws-1';
  let prisma: any;
  let svc: IvrService;

  beforeEach(() => {
    prisma = {
      ivrMenu: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'm-new', ...data })),
        update: jest.fn().mockImplementation(({ where, data }: any) => Promise.resolve({ id: where.id, ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        delete: jest.fn().mockResolvedValue({}),
      },
      ivrOption: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'o-new', ...data })),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    const config = { get: jest.fn().mockReturnValue('https://m.example') };
    svc = new IvrService(prisma as any, config as any);
  });

  // ─── renderMenuTwiml ─────────────────────────────────────────────────────

  describe('renderMenuTwiml', () => {
    it('emits a <Gather numDigits="1"> with the greeting and each option', async () => {
      prisma.ivrMenu.findFirst.mockResolvedValue({ id: 'm1', workspaceId: WS, greeting: 'Welcome to Acme!' });
      prisma.ivrOption.findMany.mockResolvedValue([
        { digit: '1', label: 'Sales' },
        { digit: '2', label: 'Support' },
      ]);

      const twiml = await svc.renderMenuTwiml(WS, 'm1');

      expect(twiml).toContain('<Gather numDigits="1"');
      expect(twiml).toContain('action="https://m.example/api/public/channels/twilio/ivr/m1"');
      expect(twiml).toContain('Welcome to Acme!');
      expect(twiml).toContain('For Sales, press 1.');
      expect(twiml).toContain('For Support, press 2.');
      // greeting is plain text → <Say>, not <Play>
      expect(twiml).toContain('<Say>Welcome to Acme!</Say>');
      expect(twiml).not.toContain('<Play>');
    });

    it('plays an audio-URL greeting via <Play>', async () => {
      prisma.ivrMenu.findFirst.mockResolvedValue({ id: 'm1', workspaceId: WS, greeting: 'https://cdn.example/greet.mp3' });
      const twiml = await svc.renderMenuTwiml(WS, 'm1');
      expect(twiml).toContain('<Play>https://cdn.example/greet.mp3</Play>');
    });

    it('throws when the menu is not in the workspace', async () => {
      prisma.ivrMenu.findFirst.mockResolvedValue(null);
      await expect(svc.renderMenuTwiml(WS, 'm1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ─── handleDigit ─────────────────────────────────────────────────────────

  describe('handleDigit', () => {
    beforeEach(() => {
      prisma.ivrMenu.findFirst.mockResolvedValue({ id: 'm1', workspaceId: WS, greeting: 'Hi' });
    });

    it('SUBMENU → renders the nested menu gather', async () => {
      prisma.ivrOption.findFirst.mockResolvedValue({ action: 'SUBMENU', targetMenuId: 'm2' });
      // the nested render re-reads the target menu
      prisma.ivrMenu.findFirst
        .mockResolvedValueOnce({ id: 'm1', workspaceId: WS, greeting: 'Hi' }) // option's menu
        .mockResolvedValueOnce({ id: 'm2', workspaceId: WS, greeting: 'Submenu' }); // target
      prisma.ivrOption.findMany.mockResolvedValue([{ digit: '1', label: 'Billing' }]);

      const out = await svc.handleDigit(WS, 'm1', '3');

      expect(out.aiHandoff).toBeUndefined();
      expect(out.twiml).toContain('<Gather numDigits="1"');
      expect(out.twiml).toContain('action="https://m.example/api/public/channels/twilio/ivr/m2"');
      expect(out.twiml).toContain('Submenu');
    });

    it('DIAL → <Dial> the E.164 number', async () => {
      prisma.ivrOption.findFirst.mockResolvedValue({ action: 'DIAL', dialNumber: '+15551234567' });
      const out = await svc.handleDigit(WS, 'm1', '1');
      expect(out.twiml).toContain('<Dial>+15551234567</Dial>');
    });

    it('VOICEMAIL → <Record>', async () => {
      prisma.ivrOption.findFirst.mockResolvedValue({ action: 'VOICEMAIL' });
      const out = await svc.handleDigit(WS, 'm1', '4');
      expect(out.twiml).toContain('<Record');
    });

    it('HANGUP → <Hangup>', async () => {
      prisma.ivrOption.findFirst.mockResolvedValue({ action: 'HANGUP' });
      const out = await svc.handleDigit(WS, 'm1', '9');
      expect(out.twiml).toContain('<Hangup/>');
      expect(out.twiml).not.toContain('<Gather');
    });

    it('AI_RECEPTIONIST → signals handoff to the existing voice flow (no twiml)', async () => {
      prisma.ivrOption.findFirst.mockResolvedValue({ action: 'AI_RECEPTIONIST' });
      const out = await svc.handleDigit(WS, 'm1', '0');
      expect(out.aiHandoff).toBe(true);
      expect(out.twiml).toBeUndefined();
    });

    it('invalid / unmapped digit → re-prompts by replaying the menu', async () => {
      prisma.ivrOption.findFirst.mockResolvedValue(null); // no option for this digit
      prisma.ivrOption.findMany.mockResolvedValue([{ digit: '1', label: 'Sales' }]);
      const out = await svc.handleDigit(WS, 'm1', '7');
      expect(out.twiml).toContain('<Gather numDigits="1"');
      expect(out.twiml).toContain('For Sales, press 1.');
    });
  });

  // ─── option target validation (same-workspace) ───────────────────────────

  describe('addOption validation', () => {
    beforeEach(() => {
      prisma.ivrMenu.findFirst.mockResolvedValue({ id: 'm1', workspaceId: WS, greeting: 'Hi' });
    });

    it('rejects a SUBMENU whose target is in ANOTHER workspace (findFirst returns null)', async () => {
      // target lookup is workspace-scoped → a foreign menu resolves to null
      prisma.ivrMenu.findFirst
        .mockResolvedValueOnce({ id: 'm1', workspaceId: WS, greeting: 'Hi' }) // assertMenu
        .mockResolvedValueOnce(null); // target not in WS
      await expect(
        svc.addOption(WS, 'm1', { digit: '1', label: 'x', action: 'SUBMENU', targetMenuId: 'foreign' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a DIAL without an E.164 number', async () => {
      await expect(
        svc.addOption(WS, 'm1', { digit: '1', label: 'x', action: 'DIAL', dialNumber: '5551234' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an invalid digit', async () => {
      await expect(
        svc.addOption(WS, 'm1', { digit: 'A', label: 'x', action: 'HANGUP' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a duplicate digit on the same menu', async () => {
      prisma.ivrOption.findFirst.mockResolvedValue({ id: 'existing', digit: '1' });
      await expect(
        svc.addOption(WS, 'm1', { digit: '1', label: 'x', action: 'HANGUP' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('creates a valid SUBMENU option (target in same workspace) and strips dialNumber', async () => {
      prisma.ivrMenu.findFirst
        .mockResolvedValueOnce({ id: 'm1', workspaceId: WS, greeting: 'Hi' }) // assertMenu
        .mockResolvedValueOnce({ id: 'm2', workspaceId: WS, greeting: 'Sub' }); // target in WS
      prisma.ivrOption.findFirst.mockResolvedValue(null); // no dupe
      const row = await svc.addOption(WS, 'm1', { digit: '2', label: 'More', action: 'SUBMENU', targetMenuId: 'm2', dialNumber: '+1555' as any });
      expect(prisma.ivrOption.create).toHaveBeenCalled();
      expect(row.targetMenuId).toBe('m2');
      expect(row.dialNumber).toBeNull();
    });
  });

  // ─── cross-workspace isolation + fall-through ────────────────────────────

  it('cross-workspace: ws-A menu is invisible to ws-B (scoped findFirst → null → 404)', async () => {
    // ws-B asks for a menu that only exists in ws-A: the scoped read returns null.
    prisma.ivrMenu.findFirst.mockResolvedValue(null);
    await expect(svc.getMenu('ws-B', 'menu-of-ws-A')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.ivrMenu.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'menu-of-ws-A', workspaceId: 'ws-B' }) }),
    );
  });

  it('getEnabledRootMenu returns null when no enabled root menu exists (→ webhook falls through to AI)', async () => {
    prisma.ivrMenu.findFirst.mockResolvedValue(null);
    const root = await svc.getEnabledRootMenu(WS);
    expect(root).toBeNull();
    expect(prisma.ivrMenu.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, isRoot: true, enabled: true }) }),
    );
  });

  it('createMenu demotes other roots when creating an enabled root menu', async () => {
    await svc.createMenu(WS, { name: 'Main', greeting: 'Hi', isRoot: true, enabled: true });
    expect(prisma.ivrMenu.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ workspaceId: WS, isRoot: true }), data: { isRoot: false } }),
    );
  });

  it('deleteMenu blocks deleting a menu still referenced as a SUBMENU target', async () => {
    prisma.ivrMenu.findFirst.mockResolvedValue({ id: 'm2', workspaceId: WS });
    prisma.ivrOption.findFirst.mockResolvedValue({ id: 'o1', targetMenuId: 'm2' });
    await expect(svc.deleteMenu(WS, 'm2')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.ivrMenu.delete).not.toHaveBeenCalled();
  });
});
