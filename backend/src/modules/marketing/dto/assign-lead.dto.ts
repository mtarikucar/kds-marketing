import { IsOptional, IsString } from 'class-validator';

export class AssignLeadDto {
  // Empty/null/missing → unassign (clears the current owner). A real id
  // → manager moves the lead to that rep. Validation lives in the
  // service (target must be REP + ACTIVE) since "no one" is also
  // valid here.
  @IsOptional()
  @IsString()
  assignedToId?: string | null;
}
