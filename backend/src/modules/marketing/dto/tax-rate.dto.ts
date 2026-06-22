import { IsString, IsNotEmpty, IsOptional, IsBoolean, IsNumber, Min, Max, MaxLength } from 'class-validator';

export class CreateTaxRateDto {
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  /** Percent, 0–100 (e.g. 20 for KDV %20). */
  @IsNumber() @Min(0) @Max(100) rate: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}

export class UpdateTaxRateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) name?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) rate?: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;
}
