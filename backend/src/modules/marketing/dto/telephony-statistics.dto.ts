import { IsOptional, IsDateString } from 'class-validator';

/** GET /marketing/telephony/statistics query (NetGSM Phase 4 Task 5). Both bounds
 * optional — the service defaults to the trailing 7 days and clamps a wider span. */
export class TelephonyStatisticsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
