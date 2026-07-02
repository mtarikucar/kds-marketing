import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Trophy, Plus, Pencil, Trash2, Medal } from 'lucide-react';
import marketingApi from '../../../../features/marketing/api/marketingApi';
import {
  PageHeader, Card, CardContent, Button, IconButton, Badge as Chip, EmptyState, Skeleton,
  ConfirmDialog, Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
  Field, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui';
import { buildBadgeBody } from './badgePayload';

interface LeaderRow { rank: number; leadId: string; name: string; points: number }
interface BadgeDef { id: string; key: string; name: string; iconUrl: string | null; ruleType: 'POINTS' | 'LESSONS' | 'COURSES'; threshold: number }

type BadgeForm = { key: string; name: string; ruleType: 'POINTS' | 'LESSONS' | 'COURSES'; threshold: string; iconUrl: string };

const RULES: BadgeDef['ruleType'][] = ['POINTS', 'LESSONS', 'COURSES'];

function apiErr(e: any, fallback: string): string {
  return e?.response?.data?.message ?? fallback;
}

/**
 * Epic 10c — membership gamification: the points leaderboard + badge rule admin.
 * Badges are earned automatically when a member crosses a rule's threshold
 * (points / lessons completed / courses completed).
 */
export default function LeaderboardPage() {
  const { t } = useTranslation('marketing');
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [badgeDialog, setBadgeDialog] = useState<{ badge: BadgeDef | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BadgeDef | null>(null);

  const { data: leaders, isLoading: loadingLeaders } = useQuery<LeaderRow[]>({
    queryKey: ['marketing', 'gamification', 'leaderboard', page],
    queryFn: () => marketingApi.get('/gamification/leaderboard', { params: { page } }).then((r) => r.data),
  });
  const { data: badges } = useQuery<BadgeDef[]>({
    queryKey: ['marketing', 'gamification', 'badges'],
    queryFn: () => marketingApi.get('/gamification/badges').then((r) => r.data),
  });

  const invalidateBadges = () => qc.invalidateQueries({ queryKey: ['marketing', 'gamification', 'badges'] });

  const form = useForm<BadgeForm>({ defaultValues: { key: '', name: '', ruleType: 'POINTS', threshold: '100', iconUrl: '' } });

  const openBadge = (badge: BadgeDef | null) => {
    form.reset(
      badge
        ? { key: badge.key, name: badge.name, ruleType: badge.ruleType, threshold: String(badge.threshold), iconUrl: badge.iconUrl ?? '' }
        : { key: '', name: '', ruleType: 'POINTS', threshold: '100', iconUrl: '' },
    );
    setBadgeDialog({ badge });
  };

  const save = useMutation({
    mutationFn: (v: BadgeForm) => {
      // buildBadgeBody sends iconUrl:null (not undefined) on EDIT so an emptied
      // icon actually CLEARS — see the helper for the undefined-skip rationale.
      const body = buildBadgeBody(v, !!badgeDialog?.badge);
      return badgeDialog?.badge
        ? marketingApi.patch(`/gamification/badges/${badgeDialog.badge.id}`, body)
        : marketingApi.post('/gamification/badges', { key: v.key, ...body });
    },
    onSuccess: () => { invalidateBadges(); setBadgeDialog(null); toast.success(t('gamification.badgeSaved', { defaultValue: 'Badge saved' })); },
    onError: (e) => toast.error(apiErr(e, 'Could not save badge')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/gamification/badges/${id}`),
    onSuccess: () => { invalidateBadges(); setDeleteTarget(null); toast.success(t('gamification.badgeDeleted', { defaultValue: 'Badge deleted' })); },
    onError: (e) => toast.error(apiErr(e, 'Could not delete badge')),
  });

  const ruleLabel = (r: BadgeDef['ruleType'], n: number) =>
    r === 'POINTS' ? t('gamification.rulePoints', { defaultValue: '{{n}} points', n })
      : r === 'LESSONS' ? t('gamification.ruleLessons', { defaultValue: '{{n}} lessons', n })
        : t('gamification.ruleCourses', { defaultValue: '{{n}} courses', n });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('gamification.title', { defaultValue: 'Leaderboard & Badges' })}
        description={t('gamification.subtitle', { defaultValue: 'Members earn points for learning activity and unlock badges at set thresholds.' })}
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Leaderboard */}
        <Card className="lg:col-span-2">
          <CardContent className="p-0">
            <div className="flex items-center gap-2 border-b border-border px-5 py-3">
              <Trophy className="h-5 w-5 text-amber-500" aria-hidden="true" />
              <h2 className="font-medium text-foreground">{t('gamification.leaderboard', { defaultValue: 'Leaderboard' })}</h2>
            </div>
            {loadingLeaders ? (
              <div className="space-y-2 p-4"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>
            ) : (leaders ?? []).length === 0 ? (
              <EmptyState icon={<Trophy className="h-10 w-10" />} title={t('gamification.empty', { defaultValue: 'No points yet' })}
                description={t('gamification.emptyHint', { defaultValue: 'Points appear as members complete lessons and courses.' })} />
            ) : (
              <ul className="divide-y divide-border">
                {(leaders ?? []).map((row) => (
                  <li key={row.leadId} className="flex items-center gap-3 px-5 py-2.5">
                    <span className={`w-7 text-center text-sm font-semibold ${row.rank <= 3 ? 'text-amber-500' : 'text-muted-foreground'}`}>
                      {row.rank <= 3 ? <Medal className="mx-auto h-4 w-4" aria-hidden="true" /> : row.rank}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.name}</span>
                    <span className="text-sm font-semibold tabular-nums text-foreground">{row.points}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between border-t border-border px-5 py-2">
              <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                {t('common.prev', { defaultValue: 'Previous' })}
              </Button>
              <span className="text-xs text-muted-foreground">{t('common.page', { defaultValue: 'Page {{n}}', n: page })}</span>
              <Button variant="ghost" size="sm" disabled={(leaders ?? []).length < 20} onClick={() => setPage((p) => p + 1)}>
                {t('common.next', { defaultValue: 'Next' })}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Badge admin */}
        <Card>
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="font-medium text-foreground">{t('gamification.badges', { defaultValue: 'Badges' })}</h2>
              <Button size="sm" onClick={() => openBadge(null)}><Plus className="h-4 w-4" />{t('gamification.newBadge', { defaultValue: 'New' })}</Button>
            </div>
            {(badges ?? []).length === 0 ? (
              <p className="px-5 py-6 text-center text-sm text-muted-foreground">{t('gamification.noBadges', { defaultValue: 'No badges defined yet.' })}</p>
            ) : (
              <ul className="divide-y divide-border">
                {(badges ?? []).map((b) => (
                  <li key={b.id} className="flex items-center gap-2 px-5 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-foreground">{b.name}</p>
                      <Chip tone="neutral" size="sm">{ruleLabel(b.ruleType, b.threshold)}</Chip>
                    </div>
                    <IconButton size="sm" variant="ghost" aria-label={t('common.edit', { defaultValue: 'Edit' })} onClick={() => openBadge(b)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                    <IconButton size="sm" variant="ghost" className="text-danger hover:bg-danger-subtle" aria-label={t('common.delete', { defaultValue: 'Delete' })} onClick={() => setDeleteTarget(b)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Badge create/edit */}
      <Dialog open={!!badgeDialog} onOpenChange={(o) => { if (!o) setBadgeDialog(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{badgeDialog?.badge ? t('gamification.editBadge', { defaultValue: 'Edit badge' }) : t('gamification.newBadge', { defaultValue: 'New badge' })}</DialogTitle>
            <DialogDescription>{t('gamification.badgeHint', { defaultValue: 'Members earn this automatically when they cross the threshold.' })}</DialogDescription>
          </DialogHeader>
          <form onSubmit={form.handleSubmit((v) => save.mutate(v))} className="space-y-3">
            {!badgeDialog?.badge && (
              <Field label={t('gamification.badgeKey', { defaultValue: 'Key (unique)' })}>
                {({ id }) => <Input id={id} placeholder="fast-learner" {...form.register('key', { required: true })} />}
              </Field>
            )}
            <Field label={t('gamification.badgeName', { defaultValue: 'Name' })}>
              {({ id }) => <Input id={id} placeholder="Fast Learner" {...form.register('name', { required: true })} />}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('gamification.rule', { defaultValue: 'Rule' })}>
                {({ id }) => (
                  <Select value={form.watch('ruleType')} onValueChange={(v) => form.setValue('ruleType', v as BadgeForm['ruleType'])}>
                    <SelectTrigger id={id}><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {RULES.map((r) => <SelectItem key={r} value={r}>{t(`gamification.rules.${r}`, { defaultValue: r })}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </Field>
              <Field label={t('gamification.threshold', { defaultValue: 'Threshold' })}>
                {({ id }) => <Input id={id} type="number" min="0" {...form.register('threshold')} />}
              </Field>
            </div>
            <Field label={t('gamification.icon', { defaultValue: 'Icon URL (optional)' })}>
              {({ id }) => <Input id={id} placeholder="https://…" {...form.register('iconUrl')} />}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setBadgeDialog(null)}>{t('common.cancel', { defaultValue: 'Cancel' })}</Button>
              <Button type="submit" loading={save.isPending}>{t('common.save', { defaultValue: 'Save' })}</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}
        title={t('gamification.deleteBadge', { defaultValue: 'Delete badge?' })}
        description={t('gamification.deleteBadgeDesc', { defaultValue: 'Members who earned it will lose it.' })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        tone="danger"
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget.id)}
      />
    </div>
  );
}
