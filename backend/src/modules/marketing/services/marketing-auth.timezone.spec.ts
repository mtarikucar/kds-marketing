import { BadRequestException } from '@nestjs/common';
import { MarketingAuthService } from './marketing-auth.service';

/**
 * The workspace's IANA zone — the persistence half of the only write path that
 * can correct an EXISTING workspace's day boundaries.
 *
 * `Workspace.timezone` shipped with the first migration carrying a 'UTC'
 * default and, until this method, had exactly one writer in the entire
 * codebase: agency.service's createLocation, a path no self-serve customer
 * walks. Meanwhile the dashboard aggregates, the tasks list, sales targets, the
 * daily-digest cron and the Growth Studio rail all read the column as if it
 * were an answer — so every Turkish workspace on the platform has been running
 * its "today" from 03:00 to 03:00. Signup now captures the browser's zone,
 * which repairs new workspaces; this is how the ones that already exist get
 * fixed, and there was no other way to change the value at all.
 *
 * The controller (MANAGER + settings.manage + audited, DTO-validated) is the
 * guarded front door; these tests cover what lands in the database.
 */
describe('MarketingAuthService — workspace timezone', () => {
  let prisma: any;
  let svc: MarketingAuthService;

  beforeEach(() => {
    prisma = {
      workspace: {
        update: jest.fn(),
        findUnique: jest.fn(),
      },
    };
    svc = new MarketingAuthService(prisma, {} as any, {} as any, {} as any, {} as any);
  });

  describe('setWorkspaceTimezone', () => {
    it('persists a real zone against the given workspace', async () => {
      prisma.workspace.update.mockResolvedValue({ timezone: 'Europe/Istanbul' });

      const res = await svc.setWorkspaceTimezone('ws-1', 'Europe/Istanbul');

      expect(prisma.workspace.update).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        data: { timezone: 'Europe/Istanbul' },
        select: { timezone: true },
      });
      expect(res).toEqual({ timezone: 'Europe/Istanbul' });
    });

    it('scopes the write to the given workspace id, never a caller-supplied one', async () => {
      prisma.workspace.update.mockResolvedValue({ timezone: 'Asia/Tokyo' });
      await svc.setWorkspaceTimezone('ws-caller-own', 'Asia/Tokyo');
      expect(prisma.workspace.update.mock.calls[0][0].where).toEqual({ id: 'ws-caller-own' });
    });

    it('rejects anything that is not a resolvable zone — and writes nothing', async () => {
      // Validation lives at the DTO too, but a bad value in this column fails
      // NOWHERE loudly: every reader wraps `Intl` in a try/catch and falls back,
      // so the only symptom is one workspace's dates being quietly wrong
      // forever, with nothing in any log. The write must not happen at all.
      for (const junk of ['Mars/Olympus_Mons', '', '   ', 'Europe']) {
        await expect(svc.setWorkspaceTimezone('ws-1', junk)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      expect(prisma.workspace.update).not.toHaveBeenCalled();
    });

    it('rejects a fixed OFFSET, which cannot answer when a day starts', async () => {
      // An offset is a fact about a moment, not about a place. Stored here it
      // freezes the business at whichever offset was in force the day it was
      // set, and no DST transition will ever move it again.
      for (const offset of ['+03:00', 'GMT+3', 'UTC+3']) {
        await expect(svc.setWorkspaceTimezone('ws-1', offset)).rejects.toBeInstanceOf(
          BadRequestException,
        );
      }
      expect(prisma.workspace.update).not.toHaveBeenCalled();
    });

    it("accepts an explicit 'UTC' — the client's migration accommodation is not the server's job", async () => {
      // The BROWSER-side `resolveZone` deliberately treats a stored 'UTC' as
      // "nobody has said" because it cannot tell an un-migrated default from a
      // choice. This endpoint is how that choice becomes sayable in the first
      // place, so it must not refuse it.
      prisma.workspace.update.mockResolvedValue({ timezone: 'UTC' });
      await expect(svc.setWorkspaceTimezone('ws-1', 'UTC')).resolves.toEqual({ timezone: 'UTC' });
    });

    it('trims incidental whitespace rather than storing a zone Intl would reject', async () => {
      prisma.workspace.update.mockResolvedValue({ timezone: 'Asia/Tokyo' });
      await svc.setWorkspaceTimezone('ws-1', '  Asia/Tokyo  ');
      expect(prisma.workspace.update.mock.calls[0][0].data).toEqual({ timezone: 'Asia/Tokyo' });
    });
  });

  describe('getWorkspaceTimezone', () => {
    it('reads the stored zone back so an operator can see what days are bucketed in', async () => {
      prisma.workspace.findUnique.mockResolvedValue({ timezone: 'Europe/Istanbul' });

      const res = await svc.getWorkspaceTimezone('ws-1');

      expect(prisma.workspace.findUnique).toHaveBeenCalledWith({
        where: { id: 'ws-1' },
        select: { timezone: true },
      });
      expect(res).toEqual({ timezone: 'Europe/Istanbul' });
    });

    it('reports the un-migrated default verbatim instead of guessing on the operator behalf', async () => {
      // The server must not substitute a friendlier answer here: the whole
      // point of the read is to show whether the column has ever been set.
      prisma.workspace.findUnique.mockResolvedValue({ timezone: 'UTC' });
      await expect(svc.getWorkspaceTimezone('ws-1')).resolves.toEqual({ timezone: 'UTC' });
    });

    it('400s on a workspace that is not there', async () => {
      prisma.workspace.findUnique.mockResolvedValue(null);
      await expect(svc.getWorkspaceTimezone('ws-gone')).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
