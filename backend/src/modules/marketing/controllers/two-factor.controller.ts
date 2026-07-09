import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { FeatureGuard, RequiresFeature } from '../guards/feature.guard';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { TwoFactorService } from '../services/two-factor.service';
import { TwoFactorCodeDto } from '../dto/two-factor.dto';

/**
 * Epic F — 2FA self-management for the signed-in marketing user. The login-time
 * challenge/verify lives on MarketingAuthController (/auth/2fa/verify).
 *
 * FeatureGuard is a no-op for every route without a method-level
 * @RequiresFeature (see feature.guard.ts) — wired here only for the SMS-factor
 * routes below (gated on the `smsOtp` add-on, same as the lead verify-phone
 * routes on MarketingLeadsController). TOTP enroll/enable/disable/status carry
 * no entitlement and stay reachable by every workspace.
 */
@Controller('marketing/auth/2fa')
@UseGuards(MarketingGuard, FeatureGuard)
export class TwoFactorController {
  constructor(private readonly svc: TwoFactorService) {}

  @Get('status')
  status(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.status(u.id);
  }

  @Post('enroll')
  @Audit({ action: '2fa.enroll', resourceType: 'user' })
  enroll(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.beginEnroll(u.id);
  }

  @Post('enable')
  @Audit({ action: '2fa.enable', resourceType: 'user' })
  enable(@Body() dto: TwoFactorCodeDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.enable(u.id, dto.code);
  }

  // SMS factor — NetGSM SMS v2 Task 12. Two-step, mirroring the TOTP
  // enroll→enable shape: `sms/send` texts a fresh code (also doubles as the
  // reauth step before `disable` when the active factor is already SMS),
  // `sms/enable` verifies it and arms the factor.
  @Post('sms/send')
  @RequiresFeature('smsOtp')
  @Audit({ action: '2fa.sms.send', resourceType: 'user' })
  sendSmsCode(@CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.sendSmsCode(u.id);
  }

  @Post('sms/enable')
  @RequiresFeature('smsOtp')
  @Audit({ action: '2fa.sms.enable', resourceType: 'user' })
  enableSms(@Body() dto: TwoFactorCodeDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.enableSms(u.id, dto.code);
  }

  @Post('disable')
  @Audit({ action: '2fa.disable', resourceType: 'user' })
  disable(@Body() dto: TwoFactorCodeDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.disable(u.id, dto.code);
  }
}
