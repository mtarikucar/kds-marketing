import {
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateNested,
  IsOptional,
  IsString,
} from 'class-validator';
import { Type } from 'class-transformer';
import { IngestLeadCandidateDto } from '../marketing/dto/ingest-leads.dto';

/** Body of POST /api/internal/research/jobs/:workspaceId/leads. */
export class MintResearchLeadsDto {
  /** Stamps lastRunAt/lastRunStats on the profile when provided. */
  @IsOptional() @IsString()
  profileId?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => IngestLeadCandidateDto)
  leads: IngestLeadCandidateDto[];
}
