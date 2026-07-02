import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plug, ArrowRight, RefreshCw, Unplug } from 'lucide-react';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Card, CardContent } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { QueryStateBoundary } from '@/components/ui';
import { useConnections, useDisconnect, connectionsKey } from './hooks';
import type { Capability, ConnectionGroup, Health, Provider, ProviderBlock } from './types';
import { useSocialConnect } from '../social/useSocialConnect';
import { AccountSelectDialog } from '../social/AccountSelectDialog';
import type { SocialNetwork } from '../social/socialSchemas';

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
/** Where a manual provider's connect lives. */
const MANUAL_ROUTE: Partial<Record<Provider, string>> = {
  SMS: '/channels',
  EMAIL: '/channels',
  WEBCHAT: '/channels',
  VOICE: '/voice',
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
export default function AccountCenterPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const { data, isLoading, isError, refetch } = useConnections();
  const { startConnect } = useSocialConnect();

  const [searchParams, setSearchParams] = useSearchParams();
  const [pendingConnectId, setPendingConnectId] = useState<string | null>(null);
  const [disconnectTarget, setDisconnectTarget] = useState<ConnectionGroup | null>(null);
  const disconnect = useDisconnect();

  // The OAuth callback returns to /accounts?connect=<pendingId> (origin=account-center).
  useEffect(() => {
    const connectId = searchParams.get('connect');
    const connectErr = searchParams.get('connect_error');
    if (connectId) {
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

  const onConnected = () => {
    qc.invalidateQueries({ queryKey: connectionsKey });
    qc.invalidateQueries({ queryKey: ['marketing', 'channels'] });
    qc.invalidateQueries({ queryKey: ['marketing', 'social', 'accounts'] });
  };

  const capLabel = (c: Capability) =>
    t(`accounts.cap.${c}`, {
      defaultValue: { PUBLISH: 'Publishing', INBOX: 'Inbox', ADS: 'Ads', WHATSAPP: 'WhatsApp', CALLS: 'Calls' }[c],
    });

  const renderGroup = (provider: Provider, g: ConnectionGroup) => (
    <div
      key={g.identityKey}
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-3 py-2"
    >
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
        <Button
          variant="outline"
          size="sm"
          onClick={() => startConnect(PROVIDER_NETWORK[provider]!, { origin: 'account-center' })}
        >
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
  );

  const renderProvider = (p: ProviderBlock) => {
    const network = PROVIDER_NETWORK[p.provider];
    const manualRoute = MANUAL_ROUTE[p.provider];
    return (
      <Card key={p.provider}>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="font-medium text-foreground">{p.displayName}</p>
              <p className="text-caption text-muted-foreground">
                {p.connections.length > 0
                  ? t('accounts.connectedCount', {
                      count: p.connections.length,
                      defaultValue: '{{count}} connected',
                    })
                  : t('accounts.notConnected', 'Not connected')}
              </p>
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
              manualRoute && (
                <Button asChild size="sm" variant="outline">
                  <Link to={manualRoute}>
                    {t('accounts.setUp', 'Set up')}
                    <ArrowRight className="h-4 w-4" />
                  </Link>
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
      <PageHeader
        title={t('accounts.title', 'Account Center')}
        description={t(
          'accounts.subtitle',
          'Connect and manage every account in one place — publishing, inbox, WhatsApp and ads. One connection can power marketing and channels at once.',
        )}
        actions={
          <Button asChild variant="outline" size="md">
            <Link to="/settings/connections">
              {t('accounts.identityCalendar', 'Identity, calendar & Slack')}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
        }
      />

      <AccountSelectDialog
        context="account-center"
        pendingId={pendingConnectId}
        onOpenChange={(open) => {
          if (!open) setPendingConnectId(null);
        }}
        onConnected={onConnected}
      />

      <ConfirmDialog
        open={!!disconnectTarget}
        onOpenChange={(open) => {
          if (!open) setDisconnectTarget(null);
        }}
        title={t('accounts.disconnectTitle', 'Disconnect account')}
        description={t('accounts.disconnectDesc', {
          name: disconnectTarget?.displayName ?? '',
          defaultValue:
            'This removes “{{name}}” from every surface it powers here (publishing, inbox, ads). You can reconnect it any time.',
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
              onSuccess: () => {
                setDisconnectTarget(null);
                toast.success(t('accounts.disconnected', 'Account disconnected'));
              },
              onError: () => toast.error(t('accounts.disconnectFailed', 'Could not disconnect')),
            },
          );
        }}
      />

      <QueryStateBoundary
        isLoading={isLoading}
        isError={isError}
        onRetry={() => refetch()}
        errorMessage={t('accounts.loadError', 'Could not load your connections.')}
      >
        <div className="grid gap-3 md:grid-cols-2">{(data?.providers ?? []).map(renderProvider)}</div>
      </QueryStateBoundary>
    </div>
  );
}
