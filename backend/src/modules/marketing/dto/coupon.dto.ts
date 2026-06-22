import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsInt,
  IsIn,
  Min,
  Max,
  MaxLength,
  IsDateString,
  Matches,
} from 'class-validator';

export class CreateCouponDto {
  @IsString() @IsNotEmpty() @MaxLength(40) @Matches(/^[A-Za-z0-9_-]+$/, { message: 'code must be alphanumeric' })
  code: string;

  @IsIn(['PERCENT', 'FIXED']) kind: string;
  /** PERCENT: 1–100; FIXED: minor units. */
  @IsInt() @Min(1) @Max(100_000_000) value: number;

  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsInt() @Min(0) minSubtotal?: number;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() expiresAt?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UpdateCouponDto {
  @IsOptional() @IsIn(['PERCENT', 'FIXED']) kind?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100_000_000) value?: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsOptional() @IsInt() @Min(0) minSubtotal?: number;
  @IsOptional() @IsInt() @Min(1) maxRedemptions?: number;
  @IsOptional() @IsDateString() startsAt?: string;
  @IsOptional() @IsDateString() expiresAt?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}
