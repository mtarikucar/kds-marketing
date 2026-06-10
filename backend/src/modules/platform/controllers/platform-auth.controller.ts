import { Controller, Post, Get, Body, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { PlatformAuthService } from '../services/platform-auth.service';
import { PlatformLoginDto } from '../dto/platform.dto';
import { PlatformGuard, PlatformOperatorPayload } from '../guards/platform.guard';
import { CurrentOperator } from '../decorators/current-operator.decorator';
import { getClientIp } from '../../../common/helpers/client-ip.helper';

const LOGIN_THROTTLE = { default: { limit: 5, ttl: 60_000 } };

@Controller('platform/auth')
export class PlatformAuthController {
  constructor(private readonly authService: PlatformAuthService) {}

  @Post('login')
  @Throttle(LOGIN_THROTTLE)
  login(@Body() dto: PlatformLoginDto, @Req() req: Request) {
    return this.authService.login(dto, getClientIp(req));
  }

  @Post('logout')
  @UseGuards(PlatformGuard)
  logout(@CurrentOperator() operator: PlatformOperatorPayload) {
    return this.authService.logout(operator.id);
  }

  @Get('profile')
  @UseGuards(PlatformGuard)
  profile(@CurrentOperator() operator: PlatformOperatorPayload) {
    return operator;
  }
}
