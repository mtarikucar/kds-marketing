import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsUUID,
  IsIn,
  IsDateString,
  IsInt,
  Min,
  Max,
  MaxLength,
} from 'class-validator';
import { EmptyStringToNumber } from '../../../../common/dto/transforms';

export const INSTALL_WINDOWS = ['MORNING', 'AFTERNOON', 'FULL_DAY'] as const;
export const INSTALL_STATUSES = [
  'REQUESTED',
  'SCHEDULED',
  'IN_PROGRESS',
  'DONE',
  'CANCELLED',
  'NO_SHOW',
] as const;
/** Statuses an operator may set directly via the status endpoint. */
export const INSTALL_TRANSITIONS = ['IN_PROGRESS', 'DONE', 'CANCELLED', 'NO_SHOW'] as const;

export class CreateJobDto {
  /** Soft reference to the converted tenant (core tenant id is a UUID). */
  @IsUUID()
  tenantId!: string;

  @IsOptional()
  @IsUUID()
  leadId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  siteAddress?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  siteCity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class ScheduleJobDto {
  @IsUUID()
  crewId!: string;

  @IsDateString()
  scheduledDate!: string;

  @IsOptional()
  @IsIn(INSTALL_WINDOWS)
  scheduledWindow?: (typeof INSTALL_WINDOWS)[number];
}

export class UpdateJobStatusDto {
  @IsIn(INSTALL_TRANSITIONS)
  status!: (typeof INSTALL_TRANSITIONS)[number];
}

export class CreateInstallTaskDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @EmptyStringToNumber()
  @IsOptional()
  @IsInt()
  @Min(0)
  position?: number;
}

export class JobFilterDto {
  @EmptyStringToNumber()
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @EmptyStringToNumber()
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;

  @IsOptional()
  @IsIn(INSTALL_STATUSES)
  status?: (typeof INSTALL_STATUSES)[number];

  @IsOptional()
  @IsUUID()
  crewId?: string;

  @IsOptional()
  @IsDateString()
  scheduledFrom?: string;

  @IsOptional()
  @IsDateString()
  scheduledTo?: string;
}
