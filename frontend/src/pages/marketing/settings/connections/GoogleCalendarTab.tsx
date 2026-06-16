import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { CalendarDays, Link2, RefreshCw, Unplug } from 'lucide-react';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Button,
  Badge,
  Callout,
  Skeleton,
  EmptyState,
  ConfirmDialog,
} from '@/components/ui';
import { useGoogleCalendarStatus, useGoogleCalendarMutations } from './hooks';
import type { GoogleCalendarConnection } from './types';
import { apiError } from './util';

function formatDate(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

export function GoogleCalendarTab() {
  const { t } = useTranslation('marketing');
  const { data, isLoading } = useGoogleCalendarStatus();
  const { connect, sync, disconnect } = useGoogleCalendarMutations();

  const [disconnectTarget, setDisconnectTarget] = useState<GoogleCalendarConnection | null>(null);

  const configured = data?.configured ?? false;
  const connections = data?.connections ?? [];

  const handleConnect = () => {
    connect.mutate(undefined, {
      onSuccess: ({ url }) => {
        // Open Google's consent screen. The callback re-enables the connection
        // server-side; the user returns and the status query re-fetches.
        window.open(url, '_blank', 'noopener,noreferrer');
      },
      onError: (e) =>
        toast.error(apiError(e, t('connections.gcal.connectError', { defaultValue: 'Could not start Google connect' }))),
    });
  };

  const handleSync = () => {
    sync.mutate(undefined, {
      onSuccess: () => toast.success(t('connections.gcal.syncStarted', { defaultValue: 'Sync started' })),
      onError: (e) => toast.error(apiError(e, t('connections.gcal.syncError', { defaultValue: 'Sync failed' }))),
    });
  };

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <CardTitle>{t('connections.gcal.title', { defaultValue: 'Google Calendar' })}</CardTitle>
          <CardDescription>
            {t('connections.gcal.subtitle', {
              defaultValue: 'Two-way sync between your bookings and Google Calendar.',
            })}
          </CardDescription>
        </div>
        {configured && (
          <Button onClick={handleConnect} loading={connect.isPending} className="shrink-0">
            <Link2 className="h-4 w-4" aria-hidden="true" />
            {t('connections.gcal.connect', { defaultValue: 'Connect Google Calendar' })}
          </Button>
        )}
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full" />
            <Skeleton className="h-16 w-full" />
          </div>
        ) : !configured ? (
          <Callout
            tone="warning"
            title={t('connections.gcal.notConfiguredTitle', { defaultValue: 'Not configured' })}
          >
            {t('connections.gcal.notConfigured', {
              defaultValue:
                'Google Calendar is not configured on this server. Ask your operator to set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET and MARKETING_SECRET_KEY.',
            })}
          </Callout>
        ) : connections.length === 0 ? (
          <EmptyState
            icon={<CalendarDays className="h-10 w-10" />}
            title={t('connections.gcal.empty', { defaultValue: 'No calendar connected' })}
            description={t('connections.gcal.emptyHint', {
              defaultValue: 'Connect your Google Calendar to sync bookings both ways.',
            })}
            action={
              <Button onClick={handleConnect} loading={connect.isPending} variant="outline">
                <Link2 className="h-4 w-4" aria-hidden="true" />
                {t('connections.gcal.connect', { defaultValue: 'Connect Google Calendar' })}
              </Button>
            }
          />
        ) : (
          <ul className="space-y-3">
            {connections.map((c) => (
              <li
                key={c.id}
                className="flex flex-col gap-3 rounded-lg border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{c.googleCalendarId}</p>
                    {c.syncEnabled ? (
                      <Badge tone="success" size="sm">
                        {t('connections.gcal.connected', { defaultValue: 'Connected' })}
                      </Badge>
                    ) : (
                      <Badge tone="neutral" size="sm">
                        {t('connections.gcal.paused', { defaultValue: 'Paused' })}
                      </Badge>
                    )}
                    {c.pushChannelActive && (
                      <Badge tone="info" size="sm">
                        {t('connections.gcal.push', { defaultValue: 'Live push' })}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('connections.gcal.tokenExpires', {
                      defaultValue: 'Token renews around {{when}}',
                      when: formatDate(c.tokenExpiresAt),
                    })}
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-danger"
                  onClick={() => setDisconnectTarget(c)}
                >
                  <Unplug className="h-4 w-4" aria-hidden="true" />
                  {t('connections.gcal.disconnect', { defaultValue: 'Disconnect' })}
                </Button>
              </li>
            ))}
          </ul>
        )}

        {configured && connections.length > 0 && (
          <div className="flex justify-end border-t border-border pt-4">
            <Button variant="outline" size="sm" onClick={handleSync} loading={sync.isPending}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
              {t('connections.gcal.syncNow', { defaultValue: 'Sync now' })}
            </Button>
          </div>
        )}
      </CardContent>

      <ConfirmDialog
        open={!!disconnectTarget}
        onOpenChange={(o) => {
          if (!o) setDisconnectTarget(null);
        }}
        title={t('connections.gcal.disconnectTitle', { defaultValue: 'Disconnect Google Calendar' })}
        description={t('connections.gcal.disconnectDesc', {
          defaultValue: 'Bookings will stop syncing with this calendar. You can reconnect at any time.',
        })}
        confirmLabel={t('connections.gcal.disconnect', { defaultValue: 'Disconnect' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={disconnect.isPending}
        onConfirm={() =>
          disconnectTarget &&
          disconnect.mutate(disconnectTarget.id, {
            onSuccess: () => {
              setDisconnectTarget(null);
              toast.success(t('connections.gcal.disconnected', { defaultValue: 'Calendar disconnected' }));
            },
            onError: (e) =>
              toast.error(apiError(e, t('connections.gcal.disconnectError', { defaultValue: 'Failed to disconnect' }))),
          })
        }
      />
    </Card>
  );
}
