import { IsString, IsNotEmpty, IsOptional, IsBoolean, Matches, MaxLength } from 'class-validator';

/** A canned-response snippet. `shared` = visible to the whole workspace. */
export class CreateSnippetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  @Matches(/^[a-z0-9][a-z0-9_-]*$/, { message: 'shortcut must be lower-case slug' })
  shortcut: string;

  @IsString() @IsNotEmpty() @MaxLength(120) title: string;
  @IsString() @IsNotEmpty() @MaxLength(5000) body: string;
  @IsOptional() @IsBoolean() shared?: boolean;
}

export class UpdateSnippetDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120) title?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(5000) body?: string;
  @IsOptional() @IsBoolean() shared?: boolean;
}
