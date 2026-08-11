import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsObject,
  IsArray,
  IsIn,
  MaxLength,
} from 'class-validator';
import { Type } from 'class-transformer';

// The trigger/steps shape is validated by the Zod DSL in WorkflowsService; the
// DTO only enforces coarse types so a malformed request fails fast + cheap.
//
// WHY EVERY FREE-SHAPE ARRAY CARRIES @Type(() => Object)
// ------------------------------------------------------
// The global pipe runs with `enableImplicitConversion: true` (app.config.ts).
// For an array property whose element type reflects as `Object` — which is what
// `unknown[]` and `Record<string, unknown>[]` both produce — class-transformer
// "converts" each element and returns an EMPTY ARRAY. Measured:
//
//   plainToInstance(CreateWorkflowDto, { steps: [{ type: 'create_task', … }] },
//                   { enableImplicitConversion: true }).steps[0]  ===  []
//
// So every step object arrived at the service as `[]` and the Zod DSL rejected
// it with "steps.0 — expected object, received array". Creating an automation
// through the API could not succeed. Unit tests never saw it because they call
// WorkflowsService directly and skip the DTO layer entirely; only a request
// that goes through the pipe reproduces it.
//
// `@Type(() => Object)` pins the element type so the transformer passes the
// object through untouched. Do not remove it, and add it to any new free-shape
// array on a DTO.
export class CreateWorkflowDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsObject()
  trigger: Record<string, unknown>;

  @IsArray()
  @Type(() => Object)
  steps: unknown[];

  // Goal shape is validated by the Zod DSL in WorkflowsService; coarse-typed here.
  @IsOptional() @IsObject()
  goal?: Record<string, unknown>;
}

export class UpdateWorkflowDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsOptional() @IsObject()
  trigger?: Record<string, unknown>;

  @IsOptional() @IsArray()
  @Type(() => Object)
  steps?: unknown[];

  // null clears the goal; an object replaces it (validated by the DSL).
  @IsOptional() @IsObject()
  goal?: Record<string, unknown> | null;
}

export class SetWorkflowStatusDto {
  @IsIn(['ACTIVE', 'PAUSED', 'DRAFT'])
  status: 'ACTIVE' | 'PAUSED' | 'DRAFT';
}

export class DraftWorkflowDto {
  @IsString() @IsNotEmpty() @MaxLength(2000)
  prompt: string;
}
