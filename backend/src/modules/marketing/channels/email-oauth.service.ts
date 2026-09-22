import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { isSecretBoxConfigured, openSecret } from '../../../common/crypto/secret-box.helper';
import { MailboxHealthService } from './mailbox-health.service';
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
    private readonly health: MailboxHealthService,
  ) {}

  /**
   * Which connect buttons this deployment can actually show — and what each one
   * does NOT do.
   *
   * `receive`/`receiveReason` ride along because consent is send-only for both
   * providers (Gmail read is a RESTRICTED scope; Graph `Mail.Read` is not asked
   * for yet), and a mailbox that sends but never receives is the outcome an
   * owner is most likely to be surprised by. The dialog turns these into words;
   * the backend's job is to stop them being a secret.
   */
  providers(): Array<{
    provider: EmailOAuthProvider;
    label: string;
    receive: 'NONE';
    receiveReason: string;
  }> {
    return configuredEmailOAuthProviders().map((p) => ({
      provider: p,
      label: EMAIL_OAUTH[p].label,
      receive: EMAIL_OAUTH[p].receive,
      receiveReason: EMAIL_OAUTH[p].receiveReason,
    }));
  }

  /**
   * What server this address sends through, read from its domain's MX record.
   * Null means "we do not recognise it" — the form then asks, rather than
   * pre-filling a wrong host that fails later on a customer's send.
   */
  async suggestSmtpFor(address: string): Promise<SmtpSuggestion | null> {
    return suggestSmtp(address);
  }

  /**
   * Step 1: the provider's consent URL, bound to this workspace by signed state.
   *
   * The `state` comes back out with it because the signature proves only that
   * this server minted the link — not that it minted it for the person about to
   * consent. The controller binds this exact value to the calling browser; it
   * cannot do that if it never sees it. Nothing above the controller returns it
   * to the client.
   */
  start(workspaceId: string, provider: string): { authorizeUrl: string; state: string } {
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
    return { authorizeUrl: buildEmailAuthorizeUrl(provider, state), state };
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

    // Both spellings of "this workspace already has this mailbox". An address
    // that was never PROVEN is parked in `configPublic.pendingAddress` with a
    // null `externalId` (`resolveEmailClaim`), so matching only on `externalId`
    // misses exactly the row a first SMTP connect leaves behind — and sends the
    // reconnect down the create path instead of the update one.
    const existing = await this.prisma.channel.findFirst({
      where: {
        workspaceId: parsed.workspaceId,
        type: 'EMAIL',
        OR: [
          { externalId: address },
          { externalId: null, configPublic: { path: ['pendingAddress'], equals: address } },
        ],
      },
    });

    if (existing) {
      // Reconnecting the same mailbox updates the channel it already has,
      // rather than colliding with its own externalId and failing the way a
      // stranger's would. Consent replaces the SEND half of the old custom-SMTP
      // config — and only what is dead once it does (see `deadSmtpKeys`).
      //
      // `oauthError` goes with them. Secrets MERGE, and the refresh sweep's
      // record of a revoked consent is what WorkspaceMailboxService refuses a
      // mailbox on — left standing, the owner reconnects successfully and the
      // sender still will not use the mailbox.
      await this.channels.update(parsed.workspaceId, existing.id, {
        secrets,
        clearSecretKeys: [...deadSmtpKeys(this.sealedSecrets(existing)), 'oauthError'],
        status: 'ACTIVE',
        // Consent at the provider IS the proof of the address. `/me` is the
        // provider answering which mailbox the owner just signed into, which
        // is the one thing about an email channel nobody can self-assert — so
        // it promotes a parked address into a real claim.
        externalId: address,
        addressProof: 'oauth',
      });
      // The same news outside the box, where the channel card reads it. Waiting
      // for the next successful sweep would leave a freshly reconnected mailbox
      // asking to be reconnected.
      await this.health
        .clearOAuthReauthRequired({ id: existing.id, workspaceId: parsed.workspaceId })
        .catch(() => undefined);
      return { channelId: existing.id, address };
    }

    const created = await this.channels.create(parsed.workspaceId, {
      type: 'EMAIL',
      name: address,
      externalId: address,
      addressProof: 'oauth',
      secrets,
    });
    return { channelId: created.id, address };
  }

  /**
   * What this channel already holds, so the reconnect can tell a dead send
   * password from a live receive one.
   *
   * Never throws: an unreadable box is replaced wholesale by
   * `ChannelsService.update` anyway, so the worst an empty answer costs is the
   * old, wider clear — and a throw here would fail a connect the owner just
   * completed at the provider.
   */
  private sealedSecrets(row: { configSealed?: string | null }): Record<string, string | undefined> {
    if (!row.configSealed || !isSecretBoxConfigured()) return {};
    try {
      return JSON.parse(openSecret(row.configSealed)) as Record<string, string | undefined>;
    } catch {
      return {};
    }
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

/** Written by the custom-SMTP form. Consent makes the SEND half of these
 *  unusable — `EmailAdapter` checks `oauthProvider` first and never looks at
 *  them again. */
const SMTP_KEYS = ['smtpHost', 'smtpPort', 'smtpSecure', 'smtpUser', 'smtpPass'];

/**
 * Which of those keys a consent connect may actually delete.
 *
 * It used to be all of them, on the reasoning that a password sealed beside a
 * live token is a credential nobody is watching. That is true of a SEND
 * password — and `smtpUser`/`smtpPass` are not only that. The IMAP services log
 * in with exactly this pair (`imap-target.ts`), and `smtpHost` is what the IMAP
 * host is discovered from when nobody typed one, so wiping the block turned a
 * working two-way mailbox one-way at the first reconnect: the owner re-granted
 * consent, the connect reported success, and their customers' replies simply
 * stopped arriving, with nothing anywhere saying why.
 *
 * So: the block goes only when nothing on the receive side is using it —
 * either because there is no usable password at all, or because the mailbox has
 * since been given its own `imapUser`/`imapPass`, which consent must never
 * touch in any case. Keeping the pair costs nothing on the send side, because
 * that path cannot reach it while a token exists.
 */
export function deadSmtpKeys(existing: Record<string, string | undefined>): string[] {
  const dedicatedInbound = !!existing.imapUser?.trim() && !!existing.imapPass;
  const receivesWithSmtpPair = !!existing.smtpUser?.trim() && !!existing.smtpPass;
  return receivesWithSmtpPair && !dedicatedInbound ? [] : SMTP_KEYS;
}
