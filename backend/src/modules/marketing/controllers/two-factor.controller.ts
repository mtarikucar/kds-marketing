import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { MarketingGuard } from '../guards/marketing.guard';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { Audit } from '../../audit/audit.decorator';
import { TwoFactorService } from '../services/two-factor.service';
import { TwoFactorCodeDto } from '../dto/two-factor.dto';

/**
 * Epic F — 2FA self-management for the signed-in marketing user. The login-time
 * challenge/verify lives on MarketingAuthController (/auth/2fa/verify).
 */
@Controller('marketing/auth/2fa')
@UseGuards(MarketingGuard)
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

  @Post('disable')
  @Audit({ action: '2fa.disable', resourceType: 'user' })
  disable(@Body() dto: TwoFactorCodeDto, @CurrentMarketingUser() u: MarketingUserPayload) {
    return this.svc.disable(u.id, dto.code);
  }
}
