import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FlaskConical, PauseCircle, PlayCircle, Plus, Pencil, Trash2 } from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Progress } from '@/components/ui/Progress';
import {
  ResearchProfileForm,
  RESEARCH_PROFILE_DEFAULTS,
  type ResearchProfileFormValues,
} from './ResearchProfileForm';
import { IngestTokensCard } from './IngestTokensCard';
import { buildResearchPayload } from './researchProfilePayload';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ResearchProfile {
  id: string;
  name: string;
  status: 'ACTIVE' | 'PAUSED';
  icpDescription: string;
  productPitch?: string | null;
  geo?: { country?: string; cities?: string[] } | null;
  language: string;
  exclusions?: string | null;
  lastRunAt?: string | null;
  lastRunStats?: {
    posted: number;
    created: number;
    skipped: number;
    clipped: number;
    at: string;
  } | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * Research settings: the customer-authored briefs the nightly AI routine
 * researches against, the daily lead-quota meter, and ingest-token
 * management. Manager+ surface.
 */
export default function ResearchSettingsPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();

  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<ResearchProfileFormValues>(RESEARCH_PROFILE_DEFAULTS);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: usage } = useQuery({
    queryKey: ['marketing', 'research', 'usage'],
    queryFn: () => marketingApi.get('/research/usage').then((r) => r.data),
    refetchInterval: 60_000,
  });

  const { data: profiles } = useQuery<ResearchProfile[]>({
    queryKey: ['marketing', 'research', 'profiles'],
    queryFn: () => marketingApi.get('/research/profiles').then((r) => r.data),
  });

  const invalidateProfiles = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'research', 'profiles'] });

  // ── Mutations ──────────────────────────────────────────────────────────────

  const saveProfile = useMutation({
    mutationFn: (values: ResearchProfileFormValues) =>
      editingId
        ? marketingApi.patch(`/research/profiles/${editingId}`, buildResearchPayload(values))
        : marketingApi.post('/research/profiles', buildResearchPayload(values)),
    onSuccess: () => {
      invalidateProfiles();
      setFormOpen(false);
      setEditingId(null);
      setFormValues(RESEARCH_PROFILE_DEFAULTS);
      toast.success(t('research.saved', 'Research profile saved'));
    },
    onError: (e: any) =>
      toast.error(e.response?.data?.message ?? t('research.saveFailed', 'Save failed')),
  });

  const toggleProfile = useMutation({
    mutationFn: (p: ResearchProfile) =>
      marketingApi.patch(`/research/profiles/${p.id}`, {
        status: p.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE',
      }),
    onSuccess: invalidateProfiles,
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('research.toggleFailed', 'Could not update the profile')),
  });

  const deleteProfile = useMutation({
    mutationFn: (id: string) => marketingApi.delete(`/research/profiles/${id}`),
    onSuccess: () => {
      invalidateProfiles();
      setDeleteTarget(null);
    },
    onError: (e: any) => toast.error(e.response?.data?.message ?? t('research.deleteProfileFailed', 'Could not delete the profile')),
  });

  // ── Helpers ────────────────────────────────────────────────────────────────

  const openCreate = () => {
    setEditingId(null);
    setFormValues(RESEARCH_PROFILE_DEFAULTS);
    setFormOpen(true);
  };

  const openEdit = (p: ResearchProfile) => {
    setEditingId(p.id);
    setFormValues({
      name: p.name,
      icpDescription: p.icpDescription,
      productPitch: p.productPitch ?? '',
      language: p.language,
      country: p.geo?.country ?? '',
      cities: (p.geo?.cities ?? []).join(', '),
      exclusions: p.exclusions ?? '',
    });
    setFormOpen(true);
  };

  const quotaPct =
    usage && usage.limit > 0
      ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
      : 0;

  const quotaTone = quotaPct >= 100 ? 'warning' : 'primary';

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('research.title', 'AI Research')}
        description={t(
          'research.subtitle',
          'Tell the nightly research agent who to find — it fills your pipeline up to your daily quota.',
        )}
        actions={
          <Button onClick={openCreate} size="md">
            <Plus className="h-4 w-4" />
            {t('research.newProfile', 'New research profile')}
          </Button>
        }
      />

      {/* Quota meter */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <h2 className="font-display text-h3 text-foreground">
              {t('research.quotaToday', "Today's lead quota")}
            </h2>
            <span className="text-sm text-muted-foreground">
              {usage
                ? usage.limit === -1
                  ? `${usage.used} / ∞`
                  : `${usage.used} / ${usage.limit}`
                : '…'}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          <Progress
            value={usage?.limit === -1 ? 8 : quotaPct}
            tone={quotaTone}
          />
          <p className="text-xs text-muted-foreground mt-2">
            {t(
              'research.quotaHint',
              'Resets at midnight UTC. Upgrade your package to raise the daily limit.',
            )}
          </p>
        </CardContent>
      </Card>

      {/* Research profiles */}
      <div className="space-y-3">
        {(profiles ?? []).map((p) => (
          <Card key={p.id}>
            <CardContent className="pt-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <FlaskConical className="h-5 w-5 text-primary shrink-0" />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-foreground truncate">{p.name}</span>
                      <Badge tone={p.status === 'ACTIVE' ? 'success' : 'neutral'} size="sm">
                        {p.status === 'ACTIVE'
                          ? t('research.active', 'Active')
                          : t('research.paused', 'Paused')}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                      {p.icpDescription}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={p.status === 'ACTIVE' ? 'Pause profile' : 'Activate profile'}
                    onClick={() => toggleProfile.mutate(p)}
                  >
                    {p.status === 'ACTIVE' ? (
                      <PauseCircle className="h-5 w-5" />
                    ) : (
                      <PlayCircle className="h-5 w-5" />
                    )}
                  </IconButton>
                  <Button variant="outline" size="sm" onClick={() => openEdit(p)}>
                    <Pencil className="h-3.5 w-3.5" />
                    {t('common.edit', 'Edit')}
                  </Button>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label="Delete profile"
                    className="text-danger hover:bg-danger-subtle"
                    onClick={() => setDeleteTarget(p.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </div>
              </div>

              {p.lastRunStats && (
                <div className="mt-3 pt-3 border-t border-border text-xs text-muted-foreground flex gap-4 flex-wrap">
                  <span>
                    {t('research.lastRun', 'Last run')}:{' '}
                    {p.lastRunAt ? new Date(p.lastRunAt).toLocaleString() : '—'}
                  </span>
                  <span>
                    {t('research.created', 'created')}:{' '}
                    <strong className="text-success">{p.lastRunStats.created}</strong>
                  </span>
                  <span>
                    {t('research.skippedDupes', 'dupes')}: {p.lastRunStats.skipped}
                  </span>
                  <span>
                    {t('research.clipped', 'over quota')}: {p.lastRunStats.clipped}
                  </span>
                </div>
              )}
            </CardContent>
          </Card>
        ))}

        {(profiles ?? []).length === 0 && (
          <EmptyState
            icon={<FlaskConical className="h-10 w-10" />}
            title={t('research.empty', 'No research profiles yet')}
            description={t(
              'research.emptyDesc',
              'Create one and the nightly agent starts hunting.',
            )}
            action={
              <Button onClick={openCreate} size="md">
                <Plus className="h-4 w-4" />
                {t('research.newProfile', 'New research profile')}
              </Button>
            }
          />
        )}
      </div>

      {/* Ingest tokens */}
      <IngestTokensCard />

      {/* Create / Edit Dialog */}
      <ResearchProfileForm
        open={formOpen}
        onOpenChange={(v) => {
          if (!v) {
            setFormOpen(false);
            setEditingId(null);
          }
        }}
        isEditing={!!editingId}
        defaultValues={formValues}
        isPending={saveProfile.isPending}
        onSubmit={(values) => saveProfile.mutate(values)}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(v) => {
          if (!v) setDeleteTarget(null);
        }}
        title={t('research.deleteTitle', 'Delete research profile?')}
        description={t('research.deleteDesc', 'This cannot be undone.')}
        confirmLabel={t('common.delete', 'Delete')}
        tone="danger"
        loading={deleteProfile.isPending}
        onConfirm={() => deleteTarget && deleteProfile.mutate(deleteTarget)}
      />
    </div>
  );
}
