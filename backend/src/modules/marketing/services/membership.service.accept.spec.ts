import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { MembershipService } from './membership.service';
import { mockPrismaClient, MockPrismaClient } from '../../../common/test/prisma-mock.service';

/**
 * Phase 2 Task 12 — MembershipService.accept(): the atomic INVITED→ACTIVE
 * claim, the new-identity password set (same $transaction as the claim),
 * the existing-identity password no-op, the already-accepted 409, the
 * cross-account 403, and verifyInviteToken()'s token validation.
 *
 * A real JwtService is used (not a jest.fn() stub) so verifyInviteToken can
 * be exercised against genuinely signed/expired/mistyped tokens, mirroring
 * membership.service.invite.spec.ts.
 */
function makeSvc() {
  const prisma = mockPrismaClient();
  // accept() runs its claim (+ optional password write) in one $transaction;
  // execute the callback against the same mocked client.
  (prisma.$transaction as any).mockImplementation(async (fn: any) => fn(prisma));
  const jwt = new JwtService();
  const config = {
    get: jest.fn((key: string) => (key === 'MARKETING_JWT_SECRET' ? 'invite-secret' : undefined)),
  };
  const svc = new MembershipService(prisma as any, jwt, config as any);
  return { prisma, svc, jwt };
}

// A real bcrypt hash is always 60 chars — that's what distinguishes an
// already-real password from Task 11's pending-identity sentinel.
const REAL_HASH = '$2a$12$' + 'a'.repeat(53); // 60 chars total
const SENTINEL = 'not-a-hash-just-a-random-sentinel-string';

const MEMBERSHIP_ID = 'mem-1';
const WORKSPACE_ID = 'ws-1';

describe('MembershipService.accept', () => {
  it('token-path new-identity accept sets a real password + flips INVITED→ACTIVE', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findUnique as jest.Mock).mockResolvedValue({
      id: MEMBERSHIP_ID,
      userId: 'u-new',
      workspaceId: WORKSPACE_ID,
      status: 'INVITED',
      user: { id: 'u-new', password: SENTINEL },
    });
    (prisma.workspaceMembership.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
    (prisma.marketingUser.update as jest.Mock).mockResolvedValue({ id: 'u-new' });

    const out = await svc.accept(MEMBERSHIP_ID, { password: 'Str0ngPass1' });

    expect(out).toEqual({ status: 'ACTIVE', workspaceId: WORKSPACE_ID });
    expect(prisma.workspaceMembership.updateMany).toHaveBeenCalledWith({
      where: { id: MEMBERSHIP_ID, workspaceId: WORKSPACE_ID, status: 'INVITED' },
      data: { status: 'ACTIVE', acceptedAt: expect.any(Date) },
    });
    expect(prisma.marketingUser.update).toHaveBeenCalledTimes(1);
    const updateCall = (prisma.marketingUser.update as jest.Mock).mock.calls[0][0];
    expect(updateCall.where).toEqual({ id: 'u-new' });
    expect(typeof updateCall.data.password).toBe('string');
    expect(updateCall.data.password.length).toBe(60); // a real bcrypt hash
    await expect(bcrypt.compare('Str0ngPass1', updateCall.data.password)).resolves.toBe(true);
  });

  it('existing-identity accept flips ACTIVE and never touches the password, even if one is sent', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findUnique as jest.Mock).mockResolvedValue({
      id: MEMBERSHIP_ID,
      userId: 'u-existing',
      workspaceId: WORKSPACE_ID,
      status: 'INVITED',
      user: { id: 'u-existing', password: REAL_HASH },
    });
    (prisma.workspaceMembership.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

    const out = await svc.accept(MEMBERSHIP_ID, { userId: 'u-existing', password: 'ignored123' });

    expect(out).toEqual({ status: 'ACTIVE', workspaceId: WORKSPACE_ID });
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });

  it('already-accepted (claim count 0) → 409, no password write even for a new identity', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findUnique as jest.Mock).mockResolvedValue({
      id: MEMBERSHIP_ID,
      userId: 'u-new',
      workspaceId: WORKSPACE_ID,
      status: 'ACTIVE', // already flipped by a concurrent accept
      user: { id: 'u-new', password: SENTINEL },
    });
    (prisma.workspaceMembership.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

    await expect(svc.accept(MEMBERSHIP_ID, { password: 'Str0ngPass1' })).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.marketingUser.update).not.toHaveBeenCalled();
  });

  it('logged-in accept of someone else\'s invite → 403, no claim attempted', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findUnique as jest.Mock).mockResolvedValue({
      id: MEMBERSHIP_ID,
      userId: 'u-owner',
      workspaceId: WORKSPACE_ID,
      status: 'INVITED',
      user: { id: 'u-owner', password: REAL_HASH },
    });

    await expect(
      svc.accept(MEMBERSHIP_ID, { userId: 'u-someone-else' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.workspaceMembership.updateMany).not.toHaveBeenCalled();
  });

  it('new-identity accept with no password → 400, no claim attempted', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findUnique as jest.Mock).mockResolvedValue({
      id: MEMBERSHIP_ID,
      userId: 'u-new',
      workspaceId: WORKSPACE_ID,
      status: 'INVITED',
      user: { id: 'u-new', password: SENTINEL },
    });

    await expect(svc.accept(MEMBERSHIP_ID, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.workspaceMembership.updateMany).not.toHaveBeenCalled();
  });

  it('membership not found → 404', async () => {
    const { prisma, svc } = makeSvc();
    (prisma.workspaceMembership.findUnique as jest.Mock).mockResolvedValue(null);

    await expect(svc.accept('mem-missing', {})).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('MembershipService.verifyInviteToken', () => {
  it('accepts a token minted with the invite typ and returns its membershipId', async () => {
    const { svc, jwt } = makeSvc();
    const token = jwt.sign(
      { membershipId: MEMBERSHIP_ID, typ: 'marketing-invite' },
      { secret: 'invite-secret', algorithm: 'HS256' },
    );
    await expect(svc.verifyInviteToken(token)).resolves.toBe(MEMBERSHIP_ID);
  });

  it('a garbage/invalid token → 401', async () => {
    const { svc } = makeSvc();
    await expect(svc.verifyInviteToken('not-a-real-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('a token signed with the wrong secret → 401', async () => {
    const { svc, jwt } = makeSvc();
    const token = jwt.sign(
      { membershipId: MEMBERSHIP_ID, typ: 'marketing-invite' },
      { secret: 'some-other-secret', algorithm: 'HS256' },
    );
    await expect(svc.verifyInviteToken(token)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('a real marketing SESSION token (typ absent, type: "marketing") → 401', async () => {
    const { svc, jwt } = makeSvc();
    // Mirrors what generateTokens() actually signs — proves an active
    // session's access token can never be replayed as an invite accept.
    const sessionToken = jwt.sign(
      { sub: 'u1', email: 'a@b.co', role: 'OWNER', wsp: WORKSPACE_ID, type: 'marketing' },
      { secret: 'invite-secret', algorithm: 'HS256' },
    );
    await expect(svc.verifyInviteToken(sessionToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
