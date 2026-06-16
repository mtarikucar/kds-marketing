import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Plus, MessagesSquare, ArrowRight } from 'lucide-react';
import {
  PageHeader,
  Button,
  Badge,
  Card,
  CardContent,
  EmptyState,
  Skeleton,
} from '@/components/ui';
import { useCommunities, useCommunityMutations } from '../hooks';
import type { Community } from '../types';
import { apiError } from '../util';
import { CommunityFormDialog } from './CommunityFormDialog';
import type { CommunityFormValues } from '../schemas';

export default function CommunitiesPage() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const { data, isLoading } = useCommunities();
  const { create } = useCommunityMutations();

  const [formOpen, setFormOpen] = useState(false);
  const communities: Community[] = data ?? [];

  const handleCreate = (values: CommunityFormValues) => {
    create.mutate(
      { name: values.name, ...(values.description ? { description: values.description } : {}) },
      {
        onSuccess: (c) => {
          setFormOpen(false);
          toast.success(t('memberships.communities.created', { defaultValue: 'Community created' }));
          navigate(`/memberships/communities/${c.id}`);
        },
        onError: (e) => toast.error(apiError(e, 'Failed to create community')),
      },
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('memberships.communities.title', { defaultValue: 'Communities' })}
        description={t('memberships.communities.subtitle', {
          defaultValue: 'Member spaces for posts, comments and discussion.',
        })}
        actions={
          <Button onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t('memberships.communities.createTitle', { defaultValue: 'New community' })}
          </Button>
        }
      />

      {isLoading ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : communities.length === 0 ? (
        <EmptyState
          icon={<MessagesSquare className="h-10 w-10" />}
          title={t('memberships.communities.empty', { defaultValue: 'No communities yet' })}
          description={t('memberships.communities.emptyHint', {
            defaultValue: 'Create your first community to give members a place to post.',
          })}
          action={
            <Button onClick={() => setFormOpen(true)} variant="outline">
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('memberships.communities.createTitle', { defaultValue: 'New community' })}
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {communities.map((c) => (
            <Card key={c.id} className="transition-colors hover:border-primary">
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-foreground">{c.name}</p>
                    <code className="text-xs text-muted-foreground">{c.slug}</code>
                  </div>
                  <Badge tone={c.status === 'ACTIVE' ? 'success' : 'warning'} size="sm">
                    {t(`memberships.communities.statuses.${c.status}`, { defaultValue: c.status })}
                  </Badge>
                </div>
                {c.description && (
                  <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">{c.description}</p>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3 px-0"
                  onClick={() => navigate(`/memberships/communities/${c.id}`)}
                >
                  {t('memberships.communities.open', { defaultValue: 'Open' })}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <CommunityFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        community={null}
        onSubmit={handleCreate}
        isPending={create.isPending}
      />
    </div>
  );
}
