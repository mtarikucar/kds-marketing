import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsIn,
  IsEmail,
  IsBoolean,
  MaxLength,
} from 'class-validator';

const TYPES = ['AGREEMENT', 'CONSENT', 'SERVICE_FORM'];

export class CreateDocumentDto {
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() @IsIn(TYPES) type?: string;
  @IsString() @IsNotEmpty() @MaxLength(200) title: string;
  @IsString() @IsNotEmpty() @MaxLength(100_000) body: string;
}

export class UpdateDocumentDto {
  @IsOptional() @IsString() leadId?: string;
  @IsOptional() @IsString() @IsIn(TYPES) type?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200) title?: string;
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(100_000) body?: string;
}

/**
 * Public signer-submitted body. A real DTO (not an inline type) because the
 * global ValidationPipe runs with forbidNonWhitelisted — an un-typed body would
 * be rejected. consent must be the boolean true; the service re-checks.
 */
export class PublicSignDto {
  @IsString() @IsNotEmpty() @MaxLength(200) signerName: string;
  @IsOptional() @IsEmail() @MaxLength(200) signerEmail?: string;
  @IsBoolean() consent: boolean;
}
