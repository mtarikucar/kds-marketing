import { IsString, IsNotEmpty, IsOptional, IsBoolean, MaxLength } from 'class-validator';

export class CreateInboundWebhookDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name: string;
}

export class UpdateInboundWebhookDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
  name?: string;

  @IsOptional() @IsBoolean()
  enabled?: boolean;
}
