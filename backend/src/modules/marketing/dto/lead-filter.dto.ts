import {
  IsOptional,
  IsString,
  IsInt,
  IsDateString,
  Min,
  Max,
  IsIn,
  IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EmptyStringToUndefined, StringToBoolean } from '../../../common/dto/transforms';

export class LeadFilterDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  city?: string;

  @IsOptional()
  @IsString()
  region?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  businessType?: string;

  @IsOptional()
  @IsString()
  assignedToId?: string;

  // Coarse-grained assignment filter used by the "Atanmamış / Atanmış /
  // Bana atanmış" pills in the leads list. Lives alongside the
  // fine-grained `assignedToId` filter: a manager can stack them
  // (e.g., "mine" + a specific date range). Reps see only their own
  // leads regardless of this filter — enforced in the service.
  @IsOptional()
  @IsIn(['unassigned', 'assigned', 'mine'])
  assignmentStatus?: 'unassigned' | 'assigned' | 'mine';

  // "Bekleyen" work-queue chip on the merged Kişiler tab: only the leads whose
  // OPEN conversation is waiting on US (the customer wrote last). Stacks with
  // assignmentStatus rather than replacing it. See waiting-reply-leads.ts for
  // the predicate, and for why it is not `unreadCount > 0`.
  @StringToBoolean()
  @IsOptional()
  @IsBoolean()
  waitingReply?: boolean;

  @IsOptional()
  @IsString()
  priority?: string;

  @EmptyStringToUndefined()
  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @EmptyStringToUndefined()
  @IsOptional()
  @IsDateString()
  dateTo?: string;

  @IsOptional()
  @IsString()
  sortBy?: string;

  @IsOptional()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
