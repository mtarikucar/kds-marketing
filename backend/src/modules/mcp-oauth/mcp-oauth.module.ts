import { Module } from '@nestjs/common';
import { MarketingModule } from '../marketing/marketing.module';
import { CimdClientService } from './cimd-client.service';
import { McpOAuthAuthorizeController } from './mcp-oauth-authorize.controller';
import { McpOAuthCodeService } from './mcp-oauth-code.service';
import { McpOAuthMetadataController } from './mcp-oauth-metadata.controller';
import { McpOAuthTokenController } from './mcp-oauth-token.controller';

/**
 * The MCP OAuth 2.1 authorization server (Faz 3): discovery metadata, the
 * authorize endpoint (PKCE + consent) and the token endpoint.
 *
 * **On the dependency direction.** This module imports `MarketingModule`;
 * `MarketingModule` must never import this one. The authorize endpoints need
 * `MarketingGuard`, `MembershipService` and `RolesService`, all of which are
 * marketing's; the only thing pointing the other way is
 * `McpTokenVerifierService`'s use of `McpOAuthTokenService`, and that is
 * satisfied by a FILE import of the service class, registered flat inside
 * `MarketingModule` — not by importing this module. One-way, so no cycle.
 *
 * **On why `McpOAuthTokenService` is not re-declared here.** Faz 1-2 learned
 * this the hard way: a second Nest module that re-lists a provider gets its own
 * INSTANCE, and `AgentRunService`'s named `@Cron` then registers twice and boot
 * fails. `McpOAuthTokenService` is declared once (in `MarketingModule`) and
 * exported; this module consumes that single instance for the token endpoint.
 * The same rule applies to anything else added here later: import it, never
 * re-provide it.
 *
 * `CimdClientService` and `McpOAuthCodeService` ARE declared here, because
 * nothing outside this module constructs them.
 *
 * Note the metadata controller's routes are served at the ROOT, not under the
 * `api` prefix — see `MCP_OAUTH_WELL_KNOWN_EXCLUSIONS` in `mcp-oauth.config.ts`
 * and the exclusion `app.config.ts` applies with it.
 */
@Module({
  imports: [MarketingModule],
  controllers: [
    McpOAuthMetadataController,
    McpOAuthAuthorizeController,
    McpOAuthTokenController,
  ],
  providers: [CimdClientService, McpOAuthCodeService],
})
export class McpOAuthModule {}
