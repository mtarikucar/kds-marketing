import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { isSecretBoxConfigured } from '../../../common/crypto/secret-box.helper';
import { signState, verifyState } from '../social-planner/oauth/social-oauth-state.util';
import {
  EMAIL_OAUTH,
  EmailOAuthProvider,
  buildEmailAuthorizeUrl,
  configuredEmailOAuthProviders,
  emailOAuthRedirectUri,
  emailStateNetwork,
  isEmailOAuthConfigured,
  isEmailOAuthProvider,
} from './email-oauth.config';
import { exchangeCodeForTokens, fetchConnectedAddress } from './email-oauth.sender';
import { SmtpSuggestion, suggestSmtp } from './smtp-autodiscover';
import { ChannelsService } from './channels.service';

/**
 * Connecting a mailbox by consent.
 *
 * The shape is deliberately shorter than the ads OAuth trio next door: those
 * flows end in a picker because one Google account can reach many ad accounts,
 * so the callback parks a pending row and the owner chooses. A mailbox is not
 * like that — the account someone signs in with IS the mailbox — so there is
 * nothing to choose and the callback finishes the connection outright. A picker
 * here would be a screen with one option on it.
 *
 * Inert until an app registration exists (GOOGLE_MAIL_* / MICROSOFT_MAIL_*):
 * `providers()` returns an empty list and the UI offers custom SMTP alone,
 * rather than offering a button that dead-ends at the provider.
 */
@Injectable()
export class EmailOAuthService {
  private readonly logger = new Logger(EmailOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly channels: ChannelsService,
  ) {}

  /** Which connect buttons this deployment can actually show. */
  providers(): Array<{ provider: EmailOAuthProvider; label: string }> {
    return configuredEmailOAuthProviders().map((p) => ({ provider: p, label: EMAIL_OAUTH[p].label }));
  }

  /**
   * What server this address sends through, read from its domain's MX record.
   * Null means "we do not recognise it" — the form then asks, rather than
   * pre-filling a wrong host that fails later on a customer's send.
   */
  async suggestSmtpFor(address: string): Promise<SmtpSuggestion | null> {
    return suggestSmtp(address);
  }

  /** Step 1: the provider's consent URL, bound to this workspace by signed state. */
  start(workspaceId: string, provider: string): { authorizeUrl: string } {
    if (!isEmailOAuthProvider(provider)) {
      throw new BadRequestException('Unknown mail provider');
    }
    if (!isSecretBoxConfigured()) {
      throw new BadRequestException('Secret storage is not configured (MARKETING_SECRET_KEY)');
    }
    if (!isEmailOAuthConfigured(provider)) {
      throw new BadRequestException(`${EMAIL_OAUTH[provider].label} mail app is not configured on this platform`);
    }
    const state = signState({ workspaceId, network: emailStateNetwork(provider) });
    return { authorizeUrl: buildEmailAuthorizeUrl(provider, state) };
  }

  /**
   * Step 2: the provider redirects here. Verify the state, trade the code, ask
   * which mailbox it was, and seal the result onto a channel.
   */
  async handleCallback(code: string, state: string): Promise<{ channelId: string; address: string }> {
    const parsed = verifyState(state);
    const provider = parsed && this.providerFromNetwork(parsed.network);
    if (!parsed || !provider) {
      throw new BadRequestException('Invalid or expired OAuth state');
    }

    const tokens = await exchangeCodeForTokens(provider, code, emailOAuthRedirectUri());
    if (tokens.error) {
      throw new BadRequestException(tokens.error);
    }

    const address = await fetchConnectedAddress(provider, tokens.accessToken);
    if (!address) {
      // Without the address there is no `From`, and no way to tell which channel
      // this consent belongs to. Connecting anyway would produce a channel that
      // cannot address its own mail.
      throw new BadRequestException('Could not read the address of the connected mailbox');
    }

    const secrets: Record<string, string> = {
      oauthProvider: provider,
      oauthAccessToken: tokens.accessToken,
      oauthRefreshToken: tokens.refreshToken,
      oauthExpiresAt: String(tokens.expiresAt),
      fromEmail: address,
    };

    const existing = await this.prisma.channel.findFirst({
      where: { workspaceId: parsed.workspaceId, type: 'EMAIL', externalId: address },
    });

    if (existing) {
      // Reconnecting the same mailbox updates the channel it already has,
      // rather than colliding with its own externalId and failing the way a
      // stranger's would. SMTP credentials are cleared in the same write: the
      // owner has chosen consent, and a password left sealed beside a live
      // token is a credential nobody is watching any more.
      await this.channels.update(parsed.workspaceId, existing.id, {
        secrets,
        clearSecretKeys: SMTP_KEYS,
        status: 'ACTIVE',
      });
      return { channelId: existing.id, address };
    }

    const created = await this.channels.create(parsed.workspaceId, {
      type: 'EMAIL',
      name: address,
      externalId: address,
      secrets,
    });
    return { channelId: created.id, address };
  }

  /** The state's `network` tag back to a provider — and null for a social tag,
   *  so a state minted for one flow cannot be spent on the other. */
  private providerFromNetwork(network: string): EmailOAuthProvider | null {
    for (const p of Object.keys(EMAIL_OAUTH) as EmailOAuthProvider[]) {
      if (emailStateNetwork(p) === network) return p;
    }
    return null;
  }
}

/** Written by the custom-SMTP form; meaningless once a token is in place. */
const SMTP_KEYS = ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPass'];
