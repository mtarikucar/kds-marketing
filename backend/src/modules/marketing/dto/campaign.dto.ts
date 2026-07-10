import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsArray,
  IsBoolean,
  IsInt,
  IsDateString,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * NetGSM Phase 5 (voice campaigns) — TTS/audio blast config for a VOICE
 * campaign. Exactly one of `msg`/`audioid` is required; that cross-field rule
 * isn't expressible with a single class-validator decorator, so it's enforced
 * in CampaignsService.create/update (mirrors the `channel === 'SMS'`
 * feature-entitlement check there, which is also business logic rather than
 * shape validation).
 */
export class VoiceConfigDto {
  /** Built-in Turkish TTS text — one of msg/audioid must be set. */
  @IsOptional() @IsString() @MaxLength(2000)
  msg?: string;

  /** An `audioid` returned by the voicesms upload endpoint (Task 4). */
  @IsOptional() @IsString() @MaxLength(64)
  audioid?: string;

  /** DTMF digits (press-1 style) the callee may press for a branch capture —
   *  Task 3 wires the keypress → workflow trigger. */
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(4, { each: true })
  keys?: string[];
}

export class CreateCampaignDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name: string;

  @IsIn(['EMAIL', 'SMS', 'WHATSAPP', 'VOICE'])
  channel: string;

  @IsOptional() @IsString() @MaxLength(200)
  subject?: string;

  @IsString() @IsNotEmpty() @MaxLength(20000)
  body: string;

  /** Rendered HTML body (email block builder). Larger cap — compiled HTML. */
  @IsOptional() @IsString() @MaxLength(200000)
  bodyHtml?: string;

  /** Soft ref to the EmailTemplate the HTML was built from (display only). */
  @IsOptional() @IsString() @MaxLength(64)
  emailTemplateId?: string;

  /** Lead-filter DSL (lead.* fields), same op vocabulary as workflows. */
  @IsOptional() @IsArray()
  audienceFilter?: unknown[];

  @IsOptional() @IsDateString()
  scheduledAt?: string;

  /** İYS (İleti Yönetim Sistemi) message classification — SMS/VOICE campaigns
   *  only. TICARI = commercial (requires İYS consent, hard-blocked pre-send
   *  when unconfirmed); BILGILENDIRME = informational/transactional
   *  (İYS-exempt). Defaults to BILGILENDIRME in the service when omitted. */
  @IsOptional() @IsIn(['TICARI', 'BILGILENDIRME'])
  iysMessageType?: string;

  /** Required (msg or audioid) for a VOICE campaign — see VoiceConfigDto. */
  @IsOptional() @ValidateNested() @Type(() => VoiceConfigDto)
  voiceConfig?: VoiceConfigDto;
}

export class UpdateCampaignDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(200)
  subject?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(20000)
  body?: string;

  @IsOptional() @IsString() @MaxLength(200000)
  bodyHtml?: string;

  @IsOptional() @IsString() @MaxLength(64)
  emailTemplateId?: string;

  @IsOptional() @IsArray()
  audienceFilter?: unknown[];

  @IsOptional() @IsDateString()
  scheduledAt?: string;

  /** See CreateCampaignDto.iysMessageType. */
  @IsOptional() @IsIn(['TICARI', 'BILGILENDIRME'])
  iysMessageType?: string;

  /** See CreateCampaignDto.voiceConfig. */
  @IsOptional() @ValidateNested() @Type(() => VoiceConfigDto)
  voiceConfig?: VoiceConfigDto;
}

export class CampaignVariantDto {
  @IsString() @IsNotEmpty() @MaxLength(8) key: string;
  @IsOptional() @IsInt() @Min(1) @Max(1000) weight?: number;
  @IsOptional() @IsString() @MaxLength(200) subject?: string;
  @IsString() @IsNotEmpty() @MaxLength(20000) body: string;
  @IsOptional() @IsString() @MaxLength(200000) bodyHtml?: string;
  @IsOptional() @IsString() @MaxLength(64) emailTemplateId?: string;
}

export class SetVariantsDto {
  @IsOptional() @IsBoolean() abEnabled?: boolean;
  @IsOptional() @IsIn(['SPLIT', 'WINNER']) abMode?: 'SPLIT' | 'WINNER';
  @IsOptional() @IsInt() @Min(5) @Max(50) abTestPercent?: number;
  @IsOptional() @IsIn(['OPEN', 'CLICK']) abWinnerMetric?: 'OPEN' | 'CLICK';
  @IsArray() @ArrayMaxSize(6) @ValidateNested({ each: true }) @Type(() => CampaignVariantDto)
  variants: CampaignVariantDto[];
}
