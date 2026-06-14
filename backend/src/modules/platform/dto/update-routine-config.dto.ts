import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * DTO for PATCH /platform/routines/:key
 *
 * All fields are optional — only provided fields are updated.
 *
 * `triggerToken` is write-only: it is sealed before storage and never
 * returned to callers (replaced by `hasToken: boolean` in responses).
 */
export class UpdateRoutineConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /**
   * Cron expression for the backend scheduler.
   * Null clears the schedule (manual / event-only mode).
   * The controller validates the expression with the `cron` package before saving.
   */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  cron?: string | null;

  @IsOptional()
  @IsBoolean()
  onEvent?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  triggerUrl?: string | null;

  /**
   * Write-only. Sealed with MARKETING_SECRET_KEY before storage.
   * Never returned — callers see `hasToken: boolean` instead.
   */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  triggerToken?: string;
}
