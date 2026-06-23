import { IsArray, ArrayNotEmpty, ArrayMaxSize, IsString, IsNotEmpty, IsOptional, IsBoolean, MaxLength } from 'class-validator';

/** A set of lead ids for a bulk action (delete / enroll). */
export class BulkLeadIdsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  leadIds: string[];
}

/** Manually enroll a set of leads into a workflow. */
export class BulkEnrollLeadsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  leadIds: string[];

  @IsString() @IsNotEmpty() @MaxLength(64)
  workflowId: string;
}

/** Bulk-enroll every lead matching an audience filter into a workflow (drip). */
export class EnrollByFilterDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  workflowId: string;

  @IsOptional() @IsString() @MaxLength(40) status?: string;
  @IsOptional() @IsString() @MaxLength(64) assignedToId?: string;
  @IsOptional() @IsString() @MaxLength(60) businessType?: string;
  @IsOptional() @IsString() @MaxLength(40) source?: string;
  @IsOptional() @IsString() @MaxLength(120) city?: string;
  @IsOptional() @IsString() @MaxLength(120) search?: string;

  /** Required to enroll the WHOLE list when no filter is set (blast-radius gate). */
  @IsOptional() @IsBoolean() enrollAll?: boolean;
}
