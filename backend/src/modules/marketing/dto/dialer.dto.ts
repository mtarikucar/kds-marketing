import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { SALES_CALL_OUTCOMES, SalesCallOutcome } from './log-call.dto';

/** Audience filter that seeds the preview-dial queue (callable leads only). */
export class CreateDialSessionDto {
  @IsOptional() @IsString() @MaxLength(40) status?: string;
  @IsOptional() @IsString() @MaxLength(64) assignedToId?: string;
  @IsOptional() @IsString() @MaxLength(60) businessType?: string;
  @IsOptional() @IsString() @MaxLength(40) source?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
}

export class DialOutcomeDto {
  @IsIn(SALES_CALL_OUTCOMES)
  status!: SalesCallOutcome;

  @IsOptional() @IsInt() @Min(0) @Max(86_400)
  durationSec?: number;

  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;
}
