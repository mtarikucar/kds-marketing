import { ArrayMaxSize, IsArray, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/** One per-day calling window — passed through to AutocallClient as-is. */
export class AutocallTimeWindowDto {
  @IsOptional() @IsString() @MaxLength(20)
  day?: string;

  @IsString() @MaxLength(5)
  start!: string;

  @IsString() @MaxLength(5)
  end!: string;
}

/**
 * Start a parallel autocall session — an audience filter (mirrors
 * CreateDialSessionDto) PLUS the NetGSM list settings the preview dialer
 * doesn't need. `queueName` names a Netsantral queue with logged-in agents
 * that must already exist in the NetGSM panel (never created by this app —
 * same operator-precondition contract as NetsantralClient.dynamicRedirect's
 * named queue/IVR objects).
 */
export class StartAutocallSessionDto {
  // ── audience filter (mirrors CreateDialSessionDto) ──────────────────────
  @IsOptional() @IsString() @MaxLength(40) status?: string;
  @IsOptional() @IsString() @MaxLength(64) assignedToId?: string;
  @IsOptional() @IsString() @MaxLength(60) businessType?: string;
  @IsOptional() @IsString() @MaxLength(40) source?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) search?: string;

  // ── NetGSM list settings ────────────────────────────────────────────────
  @IsString() @MaxLength(120)
  queueName!: string;

  @IsOptional() @IsString() @MaxLength(120)
  listName?: string;

  /** TICARI (commercial) requires the İYS ARAMA preflight; anything else is
   *  treated as BİLGİLENDİRME (informational, no consent check). Defaults to
   *  TICARI — a sales power-dialer is commercial calling by default. */
  @IsOptional() @IsIn(['TICARI', 'BILGILENDIRME'])
  iysMessageType?: string;

  @IsOptional() @IsInt() @Min(0) @Max(10)
  retryCount?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(14) @ValidateNested({ each: true }) @Type(() => AutocallTimeWindowDto)
  timeWindows?: AutocallTimeWindowDto[];
}

export class StopAutocallSessionDto {
  @IsString() @MaxLength(64)
  sessionId!: string;
}

