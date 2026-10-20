import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Globe } from 'lucide-react';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ConfirmDialog, Input, Label } from '@/components/ui';
import { isNotOffered, useSiteKeyMutations, useSiteKeys, type SiteKey } from './ga4Hooks';
import { apiError } from './util';

/**
 * The jeeta.js site snippet: mint a key, copy the `<script>` tag into the
 * store's pages, revoke it. Renders nothing when the server does not offer
 * site tracking (SITE_TRACKING_ENABLED off → 404).
 */
export function SiteTrackingCard() {
  const { t } = useTranslation('marketing');
  const keys = useSiteKeys();
  const { create, revoke } = useSiteKeyMutations();
  const [hosts, setHosts] = useState('');
  const [label, setLabel] = useState('');
  const [target, setTarget] = useState<SiteKey | null>(null);

  if (keys.isError && isNotOffered(keys.error)) return null;
  if (!keys.data) return null;
  const active = keys.data.filter((k) => k.status === 'ACTIVE');

  const submit = () =>
    create.mutate(
      {
        label: label.trim() || undefined,
        allowedHosts: hosts
          .split(/[\s,]+/)
          .map((h) => h.trim())
          .filter(Boolean),
      },
      {
        onSuccess: () => {
          setHosts('');
          setLabel('');
          toast.success(t('connections.site.created', { defaultValue: 'Snippet key created. Paste the tag into your site.' }));
        },
        onError: (e) => toast.error(apiError(e, t('connections.site.createError', { defaultValue: 'Could not create the key.' }))),
      },
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-4 w-4" />
          {t('connections.site.title', { defaultValue: 'Website snippet (jeeta.js)' })}
        </CardTitle>
        <CardDescription>
          {t('connections.site.desc', {
            defaultValue:
              'Counts page views and keeps where each visitor came from (UTM, ad click ids) in a first-party cookie for 90 days. Put it behind your cookie consent.',
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {active.map((k) => (
          <div key={k.id} className="space-y-1 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-foreground">{k.label ?? k.key.slice(0, 12)}</span>
              <Button size="sm" variant="ghost" onClick={() => setTarget(k)}>
                {t('connections.site.revoke', { defaultValue: 'Revoke' })}
              </Button>
            </div>
            <code className="block break-all rounded bg-surface-muted p-2 text-caption">{k.snippet}</code>
            <div className="flex flex-wrap gap-1 text-caption text-muted-foreground">
              {k.allowedHosts.length
                ? k.allowedHosts.map((h) => <span key={h}>{h}</span>)
                : t('connections.site.anyHost', { defaultValue: 'Any host' })}
            </div>
          </div>
        ))}

        <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
          <div className="space-y-1">
            <Label htmlFor="site-key-label">{t('connections.site.label', { defaultValue: 'Label' })}</Label>
            <Input id="site-key-label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Store" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="site-key-hosts">{t('connections.site.hosts', { defaultValue: 'Allowed hosts' })}</Label>
            <Input
              id="site-key-hosts"
              value={hosts}
              onChange={(e) => setHosts(e.target.value)}
              placeholder="shop.example.com, www.shop.example.com"
            />
          </div>
          <Button onClick={submit} disabled={create.isPending}>
            {t('connections.site.create', { defaultValue: 'Create snippet key' })}
          </Button>
        </div>
      </CardContent>
      <ConfirmDialog
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
        title={t('connections.site.revokeTitle', { defaultValue: 'Revoke this snippet key?' })}
        description={t('connections.site.revokeDesc', {
          defaultValue: 'Pages carrying this key stop being counted. Views already counted stay.',
        })}
        confirmLabel={t('connections.site.revokeConfirm', { defaultValue: 'Revoke key' })}
        tone="danger"
        loading={revoke.isPending}
        onConfirm={() => target && revoke.mutate(target.id, { onSettled: () => setTarget(null) })}
      />
    </Card>
  );
}
