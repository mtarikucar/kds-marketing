import { IsArray, IsIn, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, ArrayMaxSize, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class AnalysisSocialHandleDto {
  @IsIn(['INSTAGRAM', 'FACEBOOK', 'LINKEDIN']) network: 'INSTAGRAM' | 'FACEBOOK' | 'LINKEDIN';
  @IsString() @MaxLength(120) handle: string;
}

export class StartAnalysisDto {
  @IsOptional() @IsString() @MaxLength(500) websiteUrl?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => AnalysisSocialHandleDto)
  socialHandles?: AnalysisSocialHandleDto[];
  @IsOptional() @IsString() @MaxLength(300) gbpQuery?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(300, { each: true }) uploadKeys?: string[];
}

export class ApplyDto {
  @IsString() @IsNotEmpty() runId: string;
  // The edited draft — large nested object; validated loosely (the service normalizes it).
  @IsOptional() @IsObject() draft?: Record<string, any>;
}
