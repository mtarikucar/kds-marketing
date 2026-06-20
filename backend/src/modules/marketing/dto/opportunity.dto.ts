import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsInt,
  IsBoolean,
  IsNumber,
  IsArray,
  IsIn,
  Min,
  Max,
  MaxLength,
  ValidateNested,
  ArrayMaxSize,
} from 'class-validator';
import { Type } from 'class-transformer';

/** A stage as supplied inline when creating a pipeline. */
export class StageInputDto {
  @IsString() @IsNotEmpty() @MaxLength(60) name: string;
  @IsOptional() @IsInt() @Min(0) position?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) probability?: number;
  @IsOptional() @IsBoolean() isWon?: boolean;
  @IsOptional() @IsBoolean() isLost?: boolean;
}

export class CreatePipelineDto {
  @IsString() @IsNotEmpty() @MaxLength(80) name: string;
  @IsOptional() @IsInt() @Min(0) position?: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @ValidateNested({ each: true })
  @Type(() => StageInputDto)
  stages?: StageInputDto[];
}

export class UpdatePipelineDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(80) name?: string;
  @IsOptional() @IsInt() @Min(0) position?: number;
  @IsOptional() @IsBoolean() isDefault?: boolean;
  @IsOptional() @IsBoolean() archived?: boolean;
}

export class CreateStageDto {
  @IsString() @IsNotEmpty() @MaxLength(60) name: string;
  @IsOptional() @IsInt() @Min(0) position?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) probability?: number;
  @IsOptional() @IsBoolean() isWon?: boolean;
  @IsOptional() @IsBoolean() isLost?: boolean;
}

export class UpdateStageDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(60) name?: string;
  @IsOptional() @IsInt() @Min(0) position?: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) probability?: number;
  @IsOptional() @IsBoolean() isWon?: boolean;
  @IsOptional() @IsBoolean() isLost?: boolean;
}

export class ReorderStagesDto {
  @IsArray() @ArrayMaxSize(30) @IsString({ each: true }) stageIds: string[];
}

export class CreateOpportunityDto {
  @IsString() @IsNotEmpty() @MaxLength(160) name: string;
  @IsOptional() @IsString() pipelineId?: string;
  @IsOptional() @IsString() stageId?: string;
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() assignedToId?: string;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsString() @IsIn(['TRY', 'USD', 'EUR']) currency?: string;
  @IsOptional() @IsString() @MaxLength(40) source?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
}

export class UpdateOpportunityDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(160) name?: string;
  @IsOptional() @IsNumber() @Min(0) value?: number;
  @IsOptional() @IsString() @IsIn(['TRY', 'USD', 'EUR']) currency?: string;
  @IsOptional() @IsString() @MaxLength(40) source?: string;
  @IsOptional() @IsString() @MaxLength(4000) notes?: string;
  @IsOptional() @IsString() assignedToId?: string;
  @IsOptional() @IsString() leadId?: string;
}

export class MoveOpportunityDto {
  @IsString() @IsNotEmpty() stageId: string;
  @IsOptional() @IsInt() @Min(0) position?: number;
}

export class LoseOpportunityDto {
  @IsOptional() @IsString() @MaxLength(400) reason?: string;
}

export class OpportunityFilterDto {
  @IsOptional() @IsString() pipelineId?: string;
  @IsOptional() @IsString() stageId?: string;
  @IsOptional() @IsString() @IsIn(['OPEN', 'WON', 'LOST', 'ABANDONED']) status?: string;
  @IsOptional() @IsString() assignedToId?: string;
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() @MaxLength(120) search?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
