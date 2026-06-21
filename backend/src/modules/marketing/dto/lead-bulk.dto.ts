import { IsArray, ArrayNotEmpty, ArrayMaxSize, IsString, IsNotEmpty, MaxLength } from 'class-validator';

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
