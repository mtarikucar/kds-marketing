import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

const RULE_TYPES = ['POINTS', 'LESSONS', 'COURSES'];

export class CreateBadgeDto {
  @IsString() @IsNotEmpty() @MaxLength(60)
  key: string;

  @IsString() @IsNotEmpty() @MaxLength(120)
  name: string;

  @IsIn(RULE_TYPES)
  ruleType: string;

  @IsInt() @Min(0) @Max(1_000_000)
  threshold: number;

  @IsOptional() @IsString() @MaxLength(2000)
  iconUrl?: string;
}

export class UpdateBadgeDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
  name?: string;

  @IsOptional() @IsIn(RULE_TYPES)
  ruleType?: string;

  @IsOptional() @IsInt() @Min(0) @Max(1_000_000)
  threshold?: number;

  @IsOptional() @IsString() @MaxLength(2000)
  iconUrl?: string;
}
