import { lazy, Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plug, RefreshCw, Unplug } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { QueryStateBoundary } from '@/components/ui';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { RouteFallback } from '../../../components/RouteFallback';
import { useConnections, useDisconnect, connectionsKey } from './hooks';
import type { Capability, ConnectionGroup, Health, Provider, ProviderBlock, SourceRef } from './types';
import { useSocialConnect } from '../social/useSocialConnect';
import { AccountSelectDialog } from '../social/AccountSelectDialog';
import type { SocialNetwork } from '../social/socialSchemas';
import { startLinkedinAdsOAuth, startTiktokAdsOAuth } from '../../../features/marketing/api/ads.service';
import { navigateExternal } from '../../../lib/navigateExternal';
import { ManualChannelDialog } from './ManualChannelDialog';
import { EmailChannelDialog } from './EmailChannelDialog';
import { WebchatChannelDialog } from './WebchatChannelDialog';
import { TelephonyCard } from './TelephonyCard';
import { VoiceAiCard } from './VoiceAiCard';
import { NetgsmOnboardingCard } from './NetgsmOnboardingCard';
import { WhatsappSignupButton } from '../WhatsappSignupButton';
import { ProviderLogo, providerBrand } from './ProviderLogo';
import { cn } from '@/components/ui/cn';
import { CopyField } from './CopyField';
import { FeatureGate } from '@/components/ui/access-gates';
// Company (workspace-level) identity + notifications — reused from the (now
// personal-only) Settings › Connections page.
import { SsoTab } from '../settings/connections/SsoTab';
import { SlackTab } from '../settings/connections/SlackTab';
import type { ChannelType } from '../channels/channelFields';

// Personal Google/Outlook calendar connections, absorbed here as the
// Integrations tab. Lazy so its code loads only when the tab is opened.
const ConnectionsPage = lazy(() => import('../settings/connections/ConnectionsPage'));

const TABS = ['accounts', 'integrations'] as const;
type AccountsTab = (typeof TABS)[number];

/** OAuth providers map to a social-connect network; manual ones are added on the
 *  Channels page (SMS/Email/Web chat) or Voice hub. */
const PROVIDER_NETWORK: Partial<Record<Provider, SocialNetwork>> = {
  META: 'FACEBOOK',
  LINKEDIN: 'LINKEDIN',
  TIKTOK: 'TIKTOK',
  TWITTER: 'TWITTER',
  PINTEREST: 'PINTEREST',
  GOOGLE: 'GMB',
};
/** Manual providers map 1:1 to a channel type set up inline (SMS/EMAIL/WEBCHAT/VOICE). */
const MANUAL_CHANNEL: Partial<Record<Provider, ChannelType>> = {
  SMS: 'SMS',
  EMAIL: 'EMAIL',
  WEBCHAT: 'WEBCHAT',
  VOICE: 'VOICE',
};

const CAP_TONE: Record<Capability, 'info' | 'success' | 'warning' | 'neutral'> = {
  PUBLISH: 'info',
  INBOX: 'success',
  WHATSAPP: 'success',
  ADS: 'warning',
  CALLS: 'neutral',
};

const HEALTH_TONE: Record<Health, 'success' | 'danger' | 'neutral' | 'warning'> = {
  HEALTHY: 'success',
  REAUTH_REQUIRED: 'danger',
  DISABLED: 'neutral',
  PARTIAL: 'warning',
};

/**
 * Account Center (hesap merkezi) — one place to see + connect every external
 * account the workspace uses: social publishing, messaging inbox, WhatsApp and
 * ads. A single OAuth grant provisions across all relevant surfaces (the pick
 * dialog offers every capability), so connecting here affects both marketing and
 * channels at once.
 */
export default function AccountCenterPage({ embedded }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useConnections();
  const { startConnect } = useSocialConnect();

  const [searchParams, setSearchParams] = useSearchParams();
  // URL-synced top tab (`?tab=`): deep-linkable + refresh/back-safe.
  const rawTab = searchParams.get('tab');
  const tab: AccountsTab = (TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as AccountsTab) : 'accounts';
  const setTab = (v: string) =>
    setSearchParams(
      (p) => {
        p.set('tab', v);
        return p;
      },
      { replace: true },
    );
  const [pendingConnectId, setPendingConnectId] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<ConnectionGroup | null>(null);
  const [manualType, setManualType] = useState<ChannelType | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [webchatOpen, setWebchatOpen] = useState(false);
  const disconnect = useDisconnect();

  // The OAuth callback returns to /accounts?connect=<pendingId> (origin=account-center).
  useEffect(() => {
    const connectId = searchParams.get('connect');
    const connectErr = searchParams.get('connect_error');
    // The mailbox consent flow comes back here too. It has nothing to pick, so
    // it lands with a flag rather than a pending id — and deliberately without
    // the address, which is personal data and has no business in a URL every
    // proxy on the way writes to a log.
    const emailConnected = searchParams.get('email_connected');
    if (emailConnected) {
      toast.success(t('accounts.email.connected', { defaultValue: 'Mailbox connected.' }));
      searchParams.delete('email_connected');
      setSearchParams(searchParams, { replace: true });
    } else if (connectId) {
      setPendingConnectId(connectId);
      searchParams.delete('connect');
      setSearchParams(searchParams, { replace: true });
    } else if (connectErr) {
      toast.error(
        t('social.oauth.callbackError', {
          defaultValue: 'Connection failed or was cancelled. Please try again.',
        }),
      );
      searchParams.delete('connect_error');
      setSearchParams(searchParams, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // NetGSM guided setup deep-link: ?tab=accounts&focus=telephony scrolls the
  // TelephonyCard into view with a short highlight ring once the connections
  // query has resolved (the card only exists after loading), then clears the
  // param so refresh/back doesn't re-scroll.
  const focus = searchParams.get('focus');
  useEffect(() => {
    if (tab !== 'accounts' || focus !== 'telephony' || isLoading) return;
    const el = document.getElementById('telephony-card');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('ring-2', 'ring-primary', 'rounded-xl');
    // NO effect cleanup on purpose: deleting the param below re-runs the
    // effect immediately, and a cleanup would cancel this timer before it
    // ever removed the highlight (a permanently-stuck ring). Letting the
    // timer fire late is harmless — removing classes from a (possibly
    // detached) node is a no-op.
    window.setTimeout(() => el.classList.remove('ring-2', 'ring-primary', 'rounded-xl'), 2400);
    setSearchParams(
      (p) => {
        p.delete('focus');
        return p;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, focus, isLoading]);

  const onConnected = () => {
    qc.invalidateQueries({ queryKey: connectionsKey });
    qc.invalidateQueries({ queryKey: ['marketing', 'channels'] });
    qc.invalidateQueries({ queryKey: ['marketing', 'social', 'accounts'] });
  };

  // Reconnect must follow the capability, not just the provider bucket: a
  // LinkedIn/TikTok ad account uses a SEPARATE ads-OAuth app, so an ads-only
  // identity there must re-auth via that flow (the social grant wouldn't rotate
  // the ad token). Meta + any identity with a publishing account uses social OAuth
  // (Meta's grant also re-provisions ad accounts).
  const reconnect = async (provider: Provider, g: ConnectionGroup) => {
    const hasSocial = g.sources.some((s) => s.model === 'SocialAccount');
    if (!hasSocial && (provider === 'LINKEDIN' || provider === 'TIKTOK')) {
      try {
        const { authorizeUrl } =
          provider === 'LINKEDIN' ? await startLinkedinAdsOAuth() : await startTiktokAdsOAuth();
        navigateExternal(authorizeUrl);
      } catch {
        toast.error(t('accounts.reconnectFailed', 'Could not start reconnect — check server config.'));
      }
      return;
    }
    const network = PROVIDER_NETWORK[provider];
    if (network) startConnect(network, { origin: 'account-center' });
  };

  /**
   * What connecting this actually buys you, for a provider that is not yet
   * connected.
   *
   * "Not connected" answers a question nobody asked. The one somebody arrives
   * with is "do I need this?", and a row that cannot answer it is a row they
   * skip past — which is how a workspace ends up publishing to one network
   * because that is the card they happened to recognise.
   */
  const WHAT_IT_DOES: Partial<Record<Provider, string>> = {
    META: t('accounts.does.META', 'Publish to Facebook and Instagram, answer their DMs here, and run ads.'),
    LINKEDIN: t('accounts.does.LINKEDIN', 'Publish to your LinkedIn page and run ads.'),
    TIKTOK: t('accounts.does.TIKTOK', 'Publish to TikTok and answer its DMs here.'),
    TWITTER: t('accounts.does.TWITTER', 'Publish to X.'),
    PINTEREST: t('accounts.does.PINTEREST', 'Publish pins.'),
    GOOGLE: t('accounts.does.GOOGLE', 'Run Google ads and read their results.'),
    SMS: t('accounts.does.SMS', 'Send and receive SMS — the fastest way to reach a lead who left a phone number.'),
    EMAIL: t('accounts.does.EMAIL', 'Send from your own mailbox and get the replies in this inbox.'),
    WEBCHAT: t('accounts.does.WEBCHAT', 'Put a chat bubble on your site; visitors land in this inbox.'),
    VOICE: t('accounts.does.VOICE', 'Answer calls with an AI voice assistant.'),
  };

  const capLabel = (c: Capability) =>
    t(`accounts.cap.${c}`, {
      defaultValue: { PUBLISH: 'Publishing', INBOX: 'Inbox', ADS: 'Ads', WHATSAPP: 'WhatsApp', CALLS: 'Calls' }[c],
    });

  const embedFor = (widgetKey: string) =>
    `<script src="${window.location.origin}/widget.js" data-widget-key="${widgetKey}" async></script>`;

  const SETUP_LABEL: Record<NonNullable<SourceRef['setupKind']>, string> = {
    META_WEBHOOK: t('accounts.setup.metaWebhook', 'Meta webhook URL — paste into the Meta App dashboard'),
    SMS_CALLBACK: t('accounts.setup.smsCallback', 'NetGSM inbound (MO) URL — paste into İnteraktif SMS'),
    EMAIL_WEBHOOK: t('accounts.setup.emailWebhook', 'Inbound email webhook URL'),
    TIKTOK_WEBHOOK: t('accounts.setup.tiktokWebhook', 'TikTok webhook URL — paste into the TikTok for Business app'),
  };

  const renderGroup = (provider: Provider, g: ConnectionGroup) => {
    // "Paste this to finish connecting" URLs (Meta webhook / NetGSM inbound / email
    // inbound / web-chat embed) live here now, not on the channels page.
    const setups = g.sources.filter((s) => s.setupUrl || s.widgetKey);
    return (
      <div key={g.identityKey} className="space-y-2 rounded-lg border border-border px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{g.displayName}</span>
          {g.capabilities.map((c) => (
            <Badge key={c} tone={CAP_TONE[c]} size="sm">
              {capLabel(c)}
            </Badge>
          ))}
          {g.health !== 'HEALTHY' && (
            <Badge tone={HEALTH_TONE[g.health]} size="sm">
              {t(`accounts.health.${g.health}`, {
                defaultValue: {
                  REAUTH_REQUIRED: 'Reconnect needed',
                  DISABLED: 'Disabled',
                  PARTIAL: 'Partial',
                  HEALTHY: '',
                }[g.health],
              })}
            </Badge>
          )}
          {g.health === 'REAUTH_REQUIRED' && PROVIDER_NETWORK[provider] && (
            <Button variant="outline" size="sm" onClick={() => reconnect(provider, g)}>
              <RefreshCw className="h-3.5 w-3.5" />
              {t('accounts.reconnect', 'Reconnect')}
            </Button>
          )}
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={t('accounts.disconnect', 'Disconnect')}
            onClick={() => setDisconnectTarget(g)}
          >
            <Unplug className="h-4 w-4 text-danger" aria-hidden="true" />
          </IconButton>
        </div>
        {setups.length > 0 && (
          <div className="space-y-1.5 border-t border-border pt-2">
            {setups.map((s) =>
              s.setupUrl ? (
                <CopyField key={s.id} label={s.setupKind ? SETUP_LABEL[s.setupKind] : undefined} value={s.setupUrl} />
              ) : s.widgetKey ? (
                <CopyField
                  key={s.id}
                  label={t('accounts.webchat.embedLabel', 'Paste this just before </body> on every page')}
                  value={embedFor(s.widgetKey)}
                  multiline
                />
              ) : null,
            )}
          </div>
        )}
      </div>
    );
  };

  /**
   * The three states a provider can be in, from the reader's side.
   *
   * `attention` first and deliberately: a connection whose session has expired
   * still LOOKS connected everywhere else in the product, and the posts it drops
   * fail quietly. It is the one thing on this page that is costing something
   * right now.
   */
  const providers = data?.providers ?? [];
  const attention = providers.filter((p) => p.connections.some((g) => g.health !== 'HEALTHY'));
  const working = providers.filter(
    (p) => p.connections.length > 0 && p.connections.every((g) => g.health === 'HEALTHY'),
  );
  const available = providers.filter((p) => p.connections.length === 0);
  const connectedCount = providers.reduce((n, p) => n + p.connections.length, 0);
  const brokenCount = providers.reduce(
    (n, p) => n + p.connections.filter((g) => g.health !== 'HEALTHY').length,
    0,
  );

  const renderProvider = (p: ProviderBlock) => {
    const network = PROVIDER_NETWORK[p.provider];
    const manualChannel = MANUAL_CHANNEL[p.provider];
    return (
      <Card key={p.provider}>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-3">
              <span
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-muted"
                style={{ color: providerBrand(p.provider) }}
              >
                <ProviderLogo provider={p.provider} className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="font-medium text-foreground">{p.displayName}</p>
                <p className="text-caption text-muted-foreground">
                  {p.connections.length > 0
                    ? t('accounts.connectedCount', {
                        count: p.connections.length,
                        defaultValue: '{{count}} connected',
                      })
                    : (WHAT_IT_DOES[p.provider] ?? t('accounts.notConnected', 'Not connected'))}
                </p>
                {/* A disabled Connect button that does not say why reads as
                    broken. The reason used to live only in a `title` tooltip —
                    invisible on touch, to a keyboard user, and to anyone who
                    does not hover a dead control. */}
                {p.connectMethod === 'OAUTH' && network && !p.configured && (
                  <p className="text-micro text-muted-foreground">
                    {t('accounts.notConfigured', {
                      defaultValue: 'An admin must add this provider’s app credentials first',
                    })}
                  </p>
                )}
              </div>
            </div>
            {p.connectMethod === 'OAUTH' && network ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!p.configured}
                title={
                  p.configured
                    ? undefined
                    : t('accounts.notConfigured', {
                        defaultValue: 'An admin must add this provider’s app credentials first',
                      })
                }
                onClick={() => startConnect(network, { origin: 'account-center' })}
              >
                <Plug className="h-4 w-4" />
                {p.connections.length > 0
                  ? t('accounts.connectAnother', 'Connect another')
                  : t('accounts.connect', 'Connect')}
              </Button>
            ) : (
              manualChannel && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    manualChannel === 'EMAIL'
                      ? setEmailOpen(true)
                      : manualChannel === 'WEBCHAT'
                        ? setWebchatOpen(true)
                        : setManualType(manualChannel)
                  }
                >
                  <Plug className="h-4 w-4" />
                  {t('accounts.setUp', 'Set up')}
                </Button>
              )
            )}
          </div>
          {p.connections.length > 0 && (
            <div className="space-y-1.5">{p.connections.map((g) => renderGroup(p.provider, g))}</div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-6">
      {/*
        `embedded` suppresses only the page header, the same contract every other
        embeddable page in this app uses. The Growth Studio's tools drawer mounts
        this inside a Sheet that already carries its own title and description,
        and two stacked headings inside one panel read as a rendering mistake.
      */}
      {!embedded && (
        <PageHeader
          title={t('accounts.title', 'Account Center')}
          description={t(
            'accounts.subtitle',
            'Connect and manage every account in one place — publishing, inbox, WhatsApp and ads. One connection can power marketing and channels at once.',
          )}
        />
      )}

      <AccountSelectDialog
        context="account-center"
        pendingId={pendingConnectId}
        onOpenChange={(open) => {
          if (!open) setPendingConnectId(null);
        }}
        onConnected={onConnected}
      />

      <ManualChannelDialog
        type={manualType}
        onOpenChange={(open) => {
          if (!open) setManualType(null);
        }}
        onCreated={onConnected}
      />

      <EmailChannelDialog open={emailOpen} onOpenChange={setEmailOpen} onCreated={onConnected} />
      <WebchatChannelDialog open={webchatOpen} onOpenChange={setWebchatOpen} onCreated={onConnected} />

      <ConfirmDialog
        open={!!disconnectTarget}
        onOpenChange={(open) => {
          if (!open) setDisconnectTarget(null);
        }}
        title={t('accounts.disconnectTitle', 'Disconnect account')}
        description={t('accounts.disconnectDesc', {
          name: disconnectTarget?.displayName ?? '',
          surfaces: (disconnectTarget?.capabilities ?? []).map(capLabel).join(', '),
          defaultValue: 'This removes “{{name}}” from: {{surfaces}}. You can reconnect it any time.',
        })}
        confirmLabel={t('accounts.disconnect', 'Disconnect')}
        cancelLabel={t('common.cancel', 'Cancel')}
        tone="danger"
        loading={disconnect.isPending}
        onConfirm={() => {
          if (!disconnectTarget) return;
          disconnect.mutate(
            { identityKey: disconnectTarget.identityKey },
            {
              onSuccess: (res) => {
                // The backend never throws on a per-source failure, so inspect the
                // summary: nothing removed = a real failure (keep the dialog open).
                if (res.removed.length === 0 && res.skipped.length > 0) {
                  toast.error(t('accounts.disconnectFailed', 'Could not disconnect'));
                  return;
                }
                setDisconnectTarget(null);
                if (res.skipped.length > 0) {
                  toast.warning(
                    t('accounts.disconnectPartial', 'Partly disconnected — some surfaces could not be removed'),
                  );
                } else {
                  toast.success(t('accounts.disconnected', 'Account disconnected'));
                }
              },
              onError: () => toast.error(t('accounts.disconnectFailed', 'Could not disconnect')),
            },
          );
        }}
      />

      {/*
        The one line this page was missing.
 
        Everything below it is a card you have to read. This says, before any of
        them, whether anything is wrong — which is the question somebody opening
        a connections page is usually here to answer, and the one a grid of
        identical cards makes you do by hand.
      */}
      {!isLoading && !isError && connectedCount > 0 && (
        <p
          className={cn(
            'rounded-lg border px-3 py-2 text-sm',
            brokenCount > 0
              ? 'border-danger/30 bg-danger/5 text-foreground'
              : 'border-border bg-surface-muted text-muted-foreground',
          )}
        >
          {brokenCount > 0
            ? t('accounts.summaryBroken', {
                count: brokenCount,
                total: connectedCount,
                defaultValue:
                  '{{count}} of your {{total}} connected accounts is not working. Until it is reconnected, anything sent through it is lost.',
              })
            : t('accounts.summaryOk', {
                count: connectedCount,
                defaultValue: 'All {{count}} connected accounts are working.',
              })}
        </p>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="accounts">{t('accounts.tab.accounts', 'Accounts')}</TabsTrigger>
          <TabsTrigger value="integrations">{t('accounts.tab.integrations', 'Integrations')}</TabsTrigger>
        </TabsList>

        {/* Social / messaging / ads OAuth + manual channels + telephony. */}
        <TabsContent value="accounts" className="pt-2">
          <QueryStateBoundary
            isLoading={isLoading}
            isError={isError}
            onRetry={() => refetch()}
            errorMessage={t('accounts.loadError', 'Could not load your connections.')}
          >
            {/*
              ARRANGED BY WHAT THE READER NEEDS, not by vendor.
 
              This was one flat grid of every provider, connected and not, in a
              fixed order. Two things it could not tell you, and both are the
              reason somebody opens this page: whether anything is BROKEN, and
              what you would gain by connecting the rest. An account whose
              session had been invalidated — the exact state that silently loses
              posts — looked identical to a working one until you read every
              card.
 
              So: what needs you first, then what is working, then what is
              available. The rows themselves are unchanged; it is the order and
              the headings that answer the question.
            */}
            {attention.length > 0 && (
              <section className="space-y-3">
                <div>
                  <h2 className="text-base font-semibold text-danger">
                    {t('accounts.section.attention', 'Needs your attention')}
                  </h2>
                  <p className="text-caption text-muted-foreground">
                    {t(
                      'accounts.section.attentionDesc',
                      'These are connected but not working. Anything sent through them is being lost.',
                    )}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">{attention.map(renderProvider)}</div>
              </section>
            )}

            {working.length > 0 && (
              <section className="space-y-3">
                <div>
                  <h2 className="text-base font-semibold text-foreground">
                    {t('accounts.section.working', 'Connected and working')}
                  </h2>
                  <p className="text-caption text-muted-foreground">
                    {t('accounts.section.workingDesc', 'The badges say what each one lets this product do.')}
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">{working.map(renderProvider)}</div>
              </section>
            )}

            <section className="space-y-3">
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {t('accounts.section.available', 'Not connected yet')}
                </h2>
                <p className="text-caption text-muted-foreground">
                  {t('accounts.section.availableDesc', 'What each one would add.')}
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
              {available.map(renderProvider)}
              {/* id anchors the guided-setup deep-link (?focus=telephony). */}
              <div id="telephony-card">
                <TelephonyCard />
              </div>
              <VoiceAiCard />
              {/* WhatsApp Business. Embedded Signup is the ONLY path that puts a
                  REAL number on Cloud API: this button was fully built but
                  imported by nothing, so the flow was unreachable and a
                  workspace stayed stuck on the app's Meta test number. Gated on
                  `conversationAi` to match the controller; the button renders
                  inert when the platform lacks META_APP_ID / CONFIG_ID. */}
              <FeatureGate feature="conversationAi">
                <Card>
                  <CardContent className="space-y-3 p-4">
                    <div>
                      <p className="font-medium text-foreground">
                        {t('accounts.waTitle', 'WhatsApp Business')}
                      </p>
                      <p className="text-caption text-muted-foreground">
                        {t(
                          'accounts.waSubtitle',
                          'Connect your own business number through Meta. A Meta test number can only message a few pre-approved contacts — it cannot be used with real customers.',
                        )}
                      </p>
                    </div>
                    <WhatsappSignupButton />
                  </CardContent>
                </Card>
              </FeatureGate>
              </div>
            </section>
          </QueryStateBoundary>
        </TabsContent>

        {/*
          SORTED BY WHO IT AFFECTS, which is the distinction this tab was
          hiding in parentheses.
 
          Three unrelated things lived here under one word: YOUR own calendar,
          the workspace's TELEPHONE setup, and single sign-on and Slack for the
          WHOLE TEAM. Getting that wrong is not a cosmetic mistake — one of them
          changes how everybody signs in. The heading says whose it is, before
          the control does anything.
        */}
        <TabsContent value="integrations" className="space-y-6 pt-2">
          <section className="space-y-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                {t('accounts.onlyYou', 'Only you')}
              </h2>
              <p className="text-caption text-muted-foreground">
                {t(
                  'accounts.onlyYouDesc',
                  'Your own calendar, so bookings land in it. Nobody else in the workspace is affected.',
                )}
              </p>
            </div>
            <Suspense fallback={<RouteFallback />}>
              <ConnectionsPage embedded />
            </Suspense>
          </section>

          {/* The workspace's telephone line — shared, but a setup checklist
              rather than a control, so it gets its own heading rather than
              sitting under "whole team" beside single sign-on. */}
          <FeatureGate feature="telephony">
            <section className="space-y-3">
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {t('accounts.phoneSetup', 'Your phone line')}
                </h2>
                <p className="text-caption text-muted-foreground">
                  {t('accounts.phoneSetupDesc', 'What is left to finish before calls and SMS work.')}
                </p>
              </div>
              <NetgsmOnboardingCard />
            </section>
          </FeatureGate>

          {/* Company (workspace-level) identity + notifications. */}
          <section className="space-y-3">
            <div>
              <h2 className="text-base font-semibold text-foreground">
                {t('accounts.wholeTeam', 'Everyone in this workspace')}
              </h2>
              <p className="text-caption text-muted-foreground">
                {t(
                  'accounts.wholeTeamDesc',
                  'How your team signs in, and where the workspace posts its notifications. Changing these changes it for everybody.',
                )}
              </p>
            </div>
            <SsoTab />
            <SlackTab />
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}
