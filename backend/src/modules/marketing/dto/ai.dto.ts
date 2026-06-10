import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsArray,
  IsBoolean,
  IsInt,
  Min,
  Max,
  MaxLength,
  MinLength,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateKnowledgeDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  title: string;

  @IsString() @IsNotEmpty() @MaxLength(50000)
  content: string;

  @IsOptional() @IsIn(['tr', 'en', 'ru', 'uz', 'ar'])
  language?: string;

  @IsOptional() @IsIn(['MANUAL', 'URL'])
  source?: string;

  @IsOptional() @IsString() @MaxLength(500)
  sourceRef?: string;
}

export class UpdateKnowledgeDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  title?: string;

  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(50000)
  content?: string;

  @IsOptional() @IsIn(['tr', 'en', 'ru', 'uz', 'ar'])
  language?: string;

  @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: string;
}

class HandoffRulesDto {
  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(50)
  keywords?: string[];

  @IsOptional() @IsBoolean()
  outsideBusinessHours?: boolean;
}

class FollowupDto {
  @IsBoolean() enabled: boolean;
  @IsInt() @Min(1) @Max(168) afterHours: number;
  @IsInt() @Min(0) @Max(5) maxFollowups: number;
}

export class CreateAgentDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name: string;

  @IsString() @MinLength(10) @MaxLength(4000)
  persona: string;

  @IsOptional() @IsString() @MaxLength(200)
  tone?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  goals?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  guardrails?: string;

  @IsOptional() @IsIn(['tr', 'en', 'ru', 'uz', 'ar'])
  language?: string;

  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20)
  channels?: string[];

  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(100)
  kbDocIds?: string[];

  @IsOptional() @IsArray() @IsString({ each: true }) @ArrayMaxSize(20)
  captureFields?: string[];

  @IsOptional() @ValidateNested() @Type(() => HandoffRulesDto)
  handoffRules?: HandoffRulesDto;

  @IsOptional() @ValidateNested() @Type(() => FollowupDto)
  followup?: FollowupDto;

  @IsOptional() @IsString()
  bookingCalendarId?: string;

  @IsOptional() @IsInt() @Min(1) @Max(500)
  maxRepliesPerConvoDaily?: number;

  @IsOptional() @IsIn(['ACTIVE', 'PAUSED'])
  status?: 'ACTIVE' | 'PAUSED';
}

export class UpdateAgentDto extends CreateAgentDto {
  @IsOptional()
  declare name: string;

  @IsOptional()
  declare persona: string;
}

export class AskAiDto {
  @IsString() @IsNotEmpty() @MaxLength(1500)
  question: string;
}

export class ComposeContentDto {
  @IsIn(['email', 'sms', 'social'])
  kind: 'email' | 'sms' | 'social';

  @IsOptional() @IsString() @MaxLength(200)
  tone?: string;

  @IsString() @IsNotEmpty() @MaxLength(1000)
  goal: string;

  @IsOptional() @IsString() @MaxLength(500)
  audience?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  context?: string;

  @IsOptional() @IsInt() @Min(1) @Max(3)
  variants?: number;
}
