import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsObject,
  IsArray,
  IsIn,
  MaxLength,
} from 'class-validator';

// The trigger/steps shape is validated by the Zod DSL in WorkflowsService; the
// DTO only enforces coarse types so a malformed request fails fast + cheap.
export class CreateWorkflowDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsObject()
  trigger: Record<string, unknown>;

  @IsArray()
  steps: unknown[];
}

export class UpdateWorkflowDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsOptional() @IsObject()
  trigger?: Record<string, unknown>;

  @IsOptional() @IsArray()
  steps?: unknown[];
}

export class SetWorkflowStatusDto {
  @IsIn(['ACTIVE', 'PAUSED', 'DRAFT'])
  status: 'ACTIVE' | 'PAUSED' | 'DRAFT';
}

export class DraftWorkflowDto {
  @IsString() @IsNotEmpty() @MaxLength(2000)
  prompt: string;
}
