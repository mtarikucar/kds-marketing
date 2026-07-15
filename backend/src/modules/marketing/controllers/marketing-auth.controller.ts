import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingPublic, MarketingRoute } from '../decorators/marketing-public.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingAuthService } from '../services/marketing-auth.service';
import { MembershipService } from '../services/membership.service';
import { MarketingLoginDto } from '../dto/login.dto';
import { Verify2faDto, ResendTwoFactorSmsDto } from '../dto/two-factor.dto';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { RegisterWorkspaceDto } from '../dto/register-workspace.dto';
import { SwitchWorkspaceDto } from '../dto/switch-workspace.dto';
import { AcceptInviteDto } from '../dto/accept-invite.dto';
import { MarketingUserPayload } from '../types';
import { getClientIp } from '../../../common/helpers/client-ip.helper';
import { Audit } from '../../audit/audit.decorator';

// Marketing realm carries platform-wide sales data; treating its auth
// surface as tightly as the superadmin realm is appropriate.
// blockDuration extends the lockout past the ttl window once the limit trips,
// so a burst attacker is cooled down rather than resuming each fresh window.
const LOGIN_THROTTLE = { default: { limit: 5, ttl: 60_000, blockDuration: 5 * 60_000 } };
const REFRESH_THROTTLE = { default: { limit: 30, ttl: 60_000, blockDuration: 60_000 } };
// Workspace creation is heavier than a login (4 inserts + bcrypt) and is
// the platform's public front door — keep it slow.
const REGISTER_THROTTLE = { default: { limit: 3, ttl: 60_000, blockDuration: 10 * 60_000 } };

@Controller('marketing/auth')
@UseGuards(MarketingGuard)
@MarketingRoute()
export class MarketingAuthController {
  constructor(
    private readonly authService: MarketingAuthService,
    private readonly membershipService: MembershipService,
  ) {}

  @Post('login')
  @MarketingPublic()
  @Throttle(LOGIN_THROTTLE)
  login(@Body() dto: MarketingLoginDto, @Req() req: Request) {
    const ip = getClientIp(req);
    return this.authService.login(dto, ip);
  }

  // Epic F — complete a 2FA login (public: the password step already passed).
  @Post('2fa/verify')
  @MarketingPublic()
  @Throttle(LOGIN_THROTTLE)
  verify2fa(@Body() dto: Verify2faDto) {
    return this.authService.verify2fa(dto.challengeToken, dto.code);
  }

  // NetGSM SMS v2 Task 12 — re-send the SMS challenge code for a pending 2FA
  // login (public, same as 2fa/verify: the password step already passed).
  // Same throttle envelope as login/verify — this is still an unauthenticated,
  // brute-forceable surface.
  @Post('2fa/resend')
  @MarketingPublic()
  @Throttle(LOGIN_THROTTLE)
  resendTwoFactorSms(@Body() dto: ResendTwoFactorSmsDto) {
    return this.authService.resendTwoFactorSms(dto.challengeToken);
  }

  @Post('register-workspace')
  @MarketingPublic()
  @Throttle(REGISTER_THROTTLE)
  registerWorkspace(@Body() dto: RegisterWorkspaceDto, @Req() req: Request) {
    const ip = getClientIp(req);
    return this.authService.registerWorkspace(dto, ip);
  }

  @Post('refresh')
  @MarketingPublic()
  @Throttle(REFRESH_THROTTLE)
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.refreshToken(dto.refreshToken);
  }

  // Multi-workspace membership Phase 2 Task 12 — the invitee may not have a
  // session yet (a brand-new identity, or an existing one on a different
  // device), so this is public and the invite TOKEN is the only credential.
  // Same throttle envelope as login: a token, like a password, must not be
  // brute-forceable at speed. The logged-in counterpart lives at
  // POST /marketing/memberships/:id/accept (MarketingMembershipsController).
  @Post('accept-invite')
  @MarketingPublic()
  @Throttle(LOGIN_THROTTLE)
  async acceptInvite(@Body() dto: AcceptInviteDto) {
    const membershipId = await this.membershipService.verifyInviteToken(dto.token);
    return this.membershipService.accept(membershipId, { password: dto.password });
  }

  @Post('logout')
  logout(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.authService.logout(user.id);
  }

  // Multi-workspace membership Phase 1 Task 7 — re-mint the session for a
  // different workspace the caller is an ACTIVE member of. Authenticated
  // (no @MarketingPublic()): only an already-logged-in session may switch.
  @Post('switch-workspace')
  @Audit({ action: 'auth.switch-workspace', resourceType: 'workspace' })
  switchWorkspace(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Body() dto: SwitchWorkspaceDto,
  ) {
    return this.authService.switchWorkspace(user.id, dto.workspaceId);
  }

  // `user.workspaceId` here is the ACTIVE membership's workspace (the guard
  // stamps it from the JWT's `wsp` claim), so profile() reads/returns the
  // workspace the caller is currently scoped to, not necessarily their home.
  @Get('profile')
  getProfile(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.authService.profile(user.id, user.workspaceId);
  }

  @Patch('profile')
  updateProfile(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Body() dto: UpdateProfileDto,
  ) {
    return this.authService.updateProfile(user.id, dto);
  }

  @Post('change-password')
  changePassword(
    @CurrentMarketingUser() user: MarketingUserPayload,
    @Body() dto: ChangePasswordDto,
  ) {
    return this.authService.changePassword(
      user.id,
      dto.currentPassword,
      dto.newPassword,
    );
  }
}
