import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { LucideIcon } from 'lucide-react';
import {
  Phone, Wrench, DollarSign, BarChart3, KeyRound, Inbox, Zap, Megaphone,
  Globe, Star, Sparkles, Bot, Mic, Banknote, Camera, CalendarRange,
  GraduationCap, FlaskConical, MessageSquare, PhoneOutgoing,
} from 'lucide-react';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import { useEntitlements } from '../../../../features/marketing/hooks/useEntitlements';
import { useMarketingAuthStore } from '../../../../store/marketingAuthStore';
import { PageHeader, Card, Switch, EmptyState, Callout, toast } from '@/components/ui';

/** Toggleable modules, in display order, with a label key + icon. */
const MODULE_META: { key: string; labelKey: string; label: string; icon: LucideIcon }[] = [
  { key: 'conversationAi', labelKey: 'modules.keys.conversationAi', label: 'Conversations & Inbox', icon: Inbox },
  { key: 'sms', labelKey: 'modules.keys.sms', label: 'SMS', icon: MessageSquare },
  { key: 'campaigns', labelKey: 'modules.keys.campaigns', label: 'Campaigns', icon: Megaphone },
  { key: 'socialCampaigns', labelKey: 'modules.keys.socialCampaigns', label: 'Social campaigns', icon: CalendarRange },
  { key: 'mediaGen', labelKey: 'modules.keys.mediaGen', label: 'AI media studio', icon: Camera },
  { key: 'workflows', labelKey: 'modules.keys.workflows', label: 'Automations', icon: Zap },
  { key: 'agentStudio', labelKey: 'modules.keys.agentStudio', label: 'AI agents', icon: Bot },
  { key: 'askAi', labelKey: 'modules.keys.askAi', label: 'Ask AI', icon: Sparkles },
  { key: 'funnels', labelKey: 'modules.keys.funnels', label: 'Sites & funnels', icon: Globe },
  { key: 'reviews', labelKey: 'modules.keys.reviews', label: 'Reviews', icon: Star },
  { key: 'memberships', labelKey: 'modules.keys.memberships', label: 'Courses', icon: GraduationCap },
  { key: 'research', labelKey: 'modules.keys.research', label: 'Research', icon: FlaskConical },
  { key: 'telephony', labelKey: 'modules.keys.telephony', label: 'Phone & calls', icon: Phone },
  { key: 'voiceAi', labelKey: 'modules.keys.voiceAi', label: 'Voice AI', icon: Mic },
  { key: 'voiceCampaigns', labelKey: 'modules.keys.voiceCampaigns', label: 'Voice campaigns', icon: PhoneOutgoing },
  { key: 'invoicing', labelKey: 'modules.keys.invoicing', label: 'Invoicing', icon: Banknote },
  { key: 'commissions', labelKey: 'modules.keys.commissions', label: 'Commissions', icon: DollarSign },
  { key: 'installations', labelKey: 'modules.keys.installations', label: 'Installations', icon: Wrench },
  { key: 'advancedReports', labelKey: 'modules.keys.advancedReports', label: 'Advanced reports', icon: BarChart3 },
  { key: 'apiAccess', labelKey: 'modules.keys.apiAccess', label: 'API access', icon: KeyRound },
];

/**
 * Feature catalog — an OWNER turns entitled modules on/off to keep the console
 * focused. Deactivating a module hides it from the nav AND blocks its API (both
 * read the same entitlements map, which the backend intersects with the
 * activation allow-list). Anything the plan doesn't entitle simply isn't listed.
 */
export default function ModulesPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const { entitledModules, features, isLoading } = useEntitlements();
  const user = useMarketingAuthStore((s) => s.user);
  const isOwner = user?.role === 'OWNER';

  const mutation = useMutation({
    mutationFn: (activatedModules: string[]) =>
      marketingApi.patch('/billing/modules', { activatedModules }).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['marketing', 'billing', 'summary'] });
      toast.success(t('modules.saved', 'Modules updated'));
    },
    onError: (err: any) =>
      toast.error(err?.response?.data?.message || t('modules.saveFailed', 'Could not update modules')),
  });

  const items = MODULE_META.filter((m) => entitledModules.includes(m.key));

  const setActive = (key: string, on: boolean) => {
    const active = new Set(entitledModules.filter((k) => (features as Record<string, boolean>)[k]));
    if (on) active.add(key);
    else active.delete(key);
    mutation.mutate([...active]);
  };

  return (
    <div className="space-y-6">
      <PageHeader title={t('modules.title', 'Modules')} description={t('modules.subtitle', 'Turn modules on or off to keep your console focused. Off modules disappear from the menu until you re-enable them.')} />

      {!isOwner && (
        <Callout tone="info" title={t('modules.ownerOnly', 'Only the workspace owner can change which modules are active.')} />
      )}

      {!isLoading && items.length === 0 ? (
        <EmptyState
          title={t('modules.emptyTitle', 'No optional modules')}
          description={t('modules.emptyDesc', 'Your current plan has no toggleable modules.')}
        />
      ) : (
        <Card className="divide-y divide-border">
          {items.map((m) => {
            const Icon = m.icon;
            const on = !!(features as Record<string, boolean>)[m.key];
            return (
              <div key={m.key} className="flex items-center gap-3 p-4">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-muted text-muted-foreground">
                  <Icon className="h-4 w-4" />
                </span>
                <span className="flex-1 text-sm font-medium text-foreground">
                  {t(m.labelKey, m.label)}
                </span>
                <Switch
                  checked={on}
                  disabled={!isOwner || mutation.isPending}
                  onCheckedChange={(v) => setActive(m.key, v)}
                  aria-label={t(m.labelKey, m.label)}
                />
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
