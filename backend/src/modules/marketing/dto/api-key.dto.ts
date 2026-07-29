import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { PERMISSIONS } from '../roles/permissions';

/**
 * `read`/`write` are legacy shorthands `expandScopes` (mcp-scopes.ts) expands
 * into a fixed bundle of granular read/write scopes at token-verify time —
 * kept here so existing integrations that mint coarse keys keep working. The
 * granular vocabulary itself is `PERMISSIONS` (roles/permissions.ts) — the
 * SAME catalog the human role/permission system uses, not a parallel MCP-only
 * list — so an operator can mint a key that reaches any tool, including ones
 * scoped to permissions (e.g. `settings.manage`) that the legacy `write`
 * bundle deliberately does not expand into.
 */
const ALLOWED_SCOPES: string[] = ['read', 'write', ...PERMISSIONS];

export class CreateApiKeyDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(ALLOWED_SCOPES, { each: true })
  scopes?: string[];
}
