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
import { MarketingLoginDto } from '../dto/login.dto';
import { Verify2faDto, ResendTwoFactorSmsDto } from '../dto/two-factor.dto';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { UpdateProfileDto } from '../dto/update-profile.dto';
import { RefreshTokenDto } from '../dto/refresh-token.dto';
import { RegisterWorkspaceDto } from '../dto/register-workspace.dto';
import { MarketingUserPayload } from '../types';
import { getClientIp } from '../../../common/helpers/client-ip.helper';

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
  constructor(private readonly authService: MarketingAuthService) {}

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

  @Post('logout')
  logout(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.authService.logout(user.id);
  }

  @Get('profile')
  getProfile(@CurrentMarketingUser() user: MarketingUserPayload) {
    return this.authService.getProfile(user.id);
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
