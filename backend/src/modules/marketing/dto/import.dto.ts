import {
  IsEnum,
  IsNotEmpty,
  IsObject,
  IsString,
  MaxLength,
} from 'class-validator';

export class UploadImportDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  // Raw CSV text. ~10MB cap; large enterprise imports can move to multipart later.
  @IsString()
  @IsNotEmpty()
  @MaxLength(10_000_000)
  content: string;
}

export enum ImportDedupePolicy {
  SKIP = 'SKIP',
  UPDATE = 'UPDATE',
  CREATE = 'CREATE',
}

export class CommitImportDto {
  // { csvHeader -> field } where field is a native column, "cf:<key>", "tags", or "__skip".
  @IsObject()
  mapping: Record<string, string>;

  @IsEnum(ImportDedupePolicy)
  dedupePolicy: ImportDedupePolicy;
}
