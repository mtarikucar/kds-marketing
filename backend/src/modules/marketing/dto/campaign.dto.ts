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

  @IsOptional() @IsArray()
  audienceFilter?: unknown[];

  @IsOptional() @IsDateString()
  scheduledAt?: string;
}
