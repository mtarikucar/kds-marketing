import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsArray,
  IsDateString,
  MaxLength,
} from 'class-validator';

export class CreateCampaignDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name: string;

  @IsIn(['EMAIL', 'SMS', 'WHATSAPP'])
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
}
