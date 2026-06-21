import { IsString, IsNotEmpty, IsOptional, MaxLength, Matches } from 'class-validator';

export class CreateTriggerLinkDto {
  @IsString() @IsNotEmpty() @MaxLength(120) name: string;
  @IsString() @IsNotEmpty() @MaxLength(2000) targetUrl: string;
  @IsOptional() @IsString() @MaxLength(60) @Matches(/^[a-z0-9][a-z0-9_-]*$/, { message: 'slug must be a lower-case slug' })
  slug?: string;
}

export class UpdateTriggerLinkDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) name?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(2000) targetUrl?: string;
  @IsOptional() @IsString() @MaxLength(60) @Matches(/^[a-z0-9][a-z0-9_-]*$/, { message: 'slug must be a lower-case slug' })
  slug?: string;
}
