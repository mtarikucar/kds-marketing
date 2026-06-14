import { Controller, Get, Put, Post, Body, UseGuards, UseInterceptors, UploadedFile, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { MarketingGuard } from '../guards/marketing.guard';
import { MarketingRolesGuard } from '../guards/marketing-roles.guard';
import { MarketingRoute } from '../decorators/marketing-public.decorator';
import { MarketingRoles } from '../decorators/marketing-roles.decorator';
import { CurrentMarketingUser } from '../decorators/current-marketing-user.decorator';
import { MarketingUserPayload } from '../types';
import { BrandingService } from '../branding/branding.service';

class BrandingDto {
  @IsOptional() @IsString() @MaxLength(120) brandName?: string | null;
  @IsOptional() @IsString() @MaxLength(7) accentColor?: string | null;
}

/** White-label branding for the workspace's public surfaces. MANAGER+. */
@MarketingRoute()
@Controller('marketing/branding')
@UseGuards(MarketingGuard, MarketingRolesGuard)
@MarketingRoles('MANAGER')
export class MarketingBrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  get(@CurrentMarketingUser() a: MarketingUserPayload) {
    return this.branding.get(a.workspaceId);
  }

  @Put()
  set(@CurrentMarketingUser() a: MarketingUserPayload, @Body() dto: BrandingDto) {
    return this.branding.set(a.workspaceId, dto);
  }

  @Post('logo')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 1_100_000 },
      // Reject non-raster (notably image/svg+xml — stored-XSS) before buffering.
      fileFilter: (_req, file, cb) => {
        const ok = ['image/png', 'image/jpeg', 'image/webp'].includes(file.mimetype);
        cb(ok ? null : new BadRequestException('Logo must be PNG, JPEG or WEBP'), ok);
      },
    }),
  )
  uploadLogo(@CurrentMarketingUser() a: MarketingUserPayload, @UploadedFile() file: any) {
    return this.branding.saveLogo(a.workspaceId, file);
  }
}
