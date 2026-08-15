import { IsString, MaxLength, MinLength } from 'class-validator';

export class ReopenLeadDto {
  /** Why the stage was wrong. Required — a rewind with no explanation is
   *  indistinguishable from someone quietly resetting the funnel. */
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason: string;
}
