import { IsString, IsNotEmpty, IsOptional, IsArray, IsObject, MaxLength, ArrayMaxSize } from 'class-validator';

export class CreateEmailTemplateDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) blocks?: unknown[];
  @IsOptional() @IsObject() theme?: Record<string, unknown>;
}

export class UpdateEmailTemplateDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) name?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(100) blocks?: unknown[];
  @IsOptional() @IsObject() theme?: Record<string, unknown>;
}
