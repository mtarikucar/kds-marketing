import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateCommunityDto {
  @IsString() @IsNotEmpty() @MaxLength(120)
  name: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string;
}

export class UpdateCommunityDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string;

  @IsOptional() @IsIn(['ACTIVE', 'ARCHIVED'])
  status?: string;
}

export class JoinCommunityDto {
  @IsString() @IsNotEmpty()
  leadId: string;

  @IsOptional() @IsIn(['MEMBER', 'MODERATOR'])
  role?: string;
}

export class LeaveCommunityDto {
  @IsString() @IsNotEmpty()
  leadId: string;
}

export class CreatePostDto {
  @IsOptional() @IsString() @MaxLength(200)
  title?: string;

  @IsString() @IsNotEmpty() @MaxLength(20000)
  body: string;
}

export class CommentDto {
  @IsString() @IsNotEmpty() @MaxLength(10000)
  body: string;
}

export class PinPostDto {
  @IsBoolean()
  pinned: boolean;
}
