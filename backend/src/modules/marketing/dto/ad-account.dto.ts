import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  MaxLength,
  IsDateString,
  IsInt,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Connect (or re-connect / rotate the token of) a workspace's own Meta/TikTok
 * ad account. `accessToken` is a long-lived provider token; it is SEALED at rest
 * and NEVER echoed back. `externalAdId` is the provider account id (Meta act_id
 * or TikTok advertiser_id). Re-connecting the same (provider, externalAdId)
 * rotates the stored token.
 */
export class ConnectAdAccountDto {
  @IsString() @IsIn(['META', 'TIKTOK', 'LINKEDIN']) provider: string;
  @IsString() @IsNotEmpty() @MaxLength(120) externalAdId: string;
  @IsOptional() @IsString() @MaxLength(160) displayName?: string;
  @IsString() @IsNotEmpty() @MaxLength(4000) accessToken: string;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  // Meta Conversions API (CAPI) destination. pixelId is the dataset id we feed
  // server-side conversions to; capiToken is an optional dedicated System-User
  // token (SEALED at rest) — when omitted the accessToken is reused for CAPI.
  @IsOptional() @IsString() @MaxLength(64) pixelId?: string;
  @IsOptional() @IsString() @MaxLength(4000) capiToken?: string;
}

/** Date-range + optional provider filter for the aggregated metrics read. */
export class AdMetricsQueryDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsString() @IsIn(['META', 'TIKTOK', 'LINKEDIN']) provider?: string;
}

/** Optional trailing-day window for a manual pull (default 7, bounded). */
export class PullAdAccountDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days?: number;
}
