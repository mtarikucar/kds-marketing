import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Plus,
  Pencil,
  Trash2,
  Send,
  Megaphone,
  Link2,
  Unlink,
  AlertTriangle,
} from 'lucide-react';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { fmtDateTime } from '../../../features/marketing/utils/format';
import type { SocialAccount, SocialPost, NetworkStatus } from './types';
import {
  NETWORK_META,
  POST_STATUS_TONE,
  TARGET_STATUS_TONE,
} from './networks';
import { PostComposerDialog, type PostComposerSubmit } from './PostComposerDialog';
import { ConnectAccountDialog } from './ConnectAccountDialog';
import { OAuthConnectButtons } from './OAuthConnectButtons';
import { AccountSelectDialog } from './AccountSelectDialog';
import { useSocialConnect } from './useSocialConnect';
import type { ConnectAccountFormValues } from './socialSchemas';
import { PageHeader } from '@/components/ui/PageHeader';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { EmptyState } from '@/components/ui/EmptyState';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';

type View = 'posts' | 'accounts';

export default function SocialPlannerPage() {
  const queryClient = useQueryClient();
  const { t } = useTranslation('marketing');
  const { startConnect } = useSocialConnect();

  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState<View>('posts');
  const [pendingConnectId, setPendingConnectId] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [editingPost, setEditingPost] = useState<SocialPost | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [deletePost, setDeletePost] = useState<SocialPost | null>(null);
  const [disconnectAccount, setDisconnectAccount] = useState<SocialAccount | null>(null);
  // post pending a schedule confirmation (carries the picked ISO time)
  const [publishTarget, setPublishTarget] = useState<SocialPost | null>(null);

  // ── OAuth return handling ────────────────────────────────────────────────────
  // The OAuth callback redirects back to /social?connect=<pendingId> (success)
  // or ?connect_error=1 (failure). Pick up the param once, open the account
  // selector, and strip it from the URL.
  useEffect(() => {
    const connectId = searchParams.get('connect');
    const connectErr = searchParams.get('connect_error');
    if (connectId) {
      setPendingConnectId(connectId);
      setView('accounts');
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

  // ── Queries ────────────────────────────────────────────────────────────────

  const { data: status } = useQuery({
    queryKey: ['marketing', 'social', 'status'],
    queryFn: () =>
      marketingApi.get('/social-planner/status').then((r) => r.data as NetworkStatus),
  });

  const { data: accountsData, isLoading: accountsLoading } = useQuery({
    queryKey: ['marketing', 'social', 'accounts'],
    queryFn: () =>
      marketingApi.get('/social-planner/accounts').then((r) => r.data as SocialAccount[]),
  });

  const { data: postsData, isLoading: postsLoading } = useQuery({
    queryKey: ['marketing', 'social', 'posts'],
    queryFn: () => marketingApi.get('/social-planner/posts').then((r) => r.data as SocialPost[]),
  });

  const accounts: SocialAccount[] = Array.isArray(accountsData) ? accountsData : [];
  const posts: SocialPost[] = Array.isArray(postsData) ? postsData : [];

  // ── Mutations ────────────────────────────────────────────────────────────────

  const invalidatePosts = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'social', 'posts'] });
  const invalidateAccounts = () =>
    queryClient.invalidateQueries({ queryKey: ['marketing', 'social', 'accounts'] });

  const connectMutation = useMutation({
    mutationFn: (payload: ConnectAccountFormValues) =>
      marketingApi.post('/social-planner/accounts', payload),
    onSuccess: () => {
      invalidateAccounts();
      setConnectOpen(false);
      toast.success(t('social.toast.connected', { defaultValue: 'Account connected' }));
    },
    onError: () => {
      toast.error(t('social.toast.connectFailed', { defaultValue: 'Failed to connect account' }));
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: (accountId: string) =>
      marketingApi.delete(`/social-planner/accounts/${accountId}`),
    onSuccess: () => {
      invalidateAccounts();
      setDisconnectAccount(null);
      toast.success(t('social.toast.disconnected', { defaultValue: 'Account disconnected' }));
    },
    onError: () => {
      toast.error(
        t('social.toast.disconnectFailed', { defaultValue: 'Failed to disconnect account' }),
      );
    },
  });

  // Composer save: create (then optionally schedule) or update an existing draft.
  const composerMutation = useMutation({
    mutationFn: async (values: PostComposerSubmit) => {
      if (editingPost) {
        await marketingApi.patch(`/social-planner/posts/${editingPost.id}`, {
          content: values.content,
          mediaUrls: values.mediaUrls,
          options: values.options,
        });
        if (values.scheduledAt) {
          await marketingApi.post(`/social-planner/posts/${editingPost.id}/schedule`, {
            scheduledAt: values.scheduledAt,
            targetAccountIds: values.targetAccountIds,
          });
        }
        return;
      }
      const created = await marketingApi.post('/social-planner/posts', {
        content: values.content,
        mediaUrls: values.mediaUrls,
        targetAccountIds: values.targetAccountIds,
        options: values.options,
      });
      const postId: string = created.data?.id;
      if (values.scheduledAt && postId) {
        await marketingApi.post(`/social-planner/posts/${postId}/schedule`, {
          scheduledAt: values.scheduledAt,
          targetAccountIds: values.targetAccountIds,
        });
      }
    },
    onSuccess: () => {
      invalidatePosts();
      setComposerOpen(false);
      setEditingPost(null);
      toast.success(
        editingPost
          ? t('social.toast.postUpdated', { defaultValue: 'Post updated' })
          : t('social.toast.postCreated', { defaultValue: 'Post created' }),
      );
    },
    onError: () => {
      toast.error(t('social.toast.postFailed', { defaultValue: 'Failed to save post' }));
    },
  });

  const publishNowMutation = useMutation({
    mutationFn: (postId: string) =>
      marketingApi.post(`/social-planner/posts/${postId}/publish-now`),
    onSuccess: () => {
      invalidatePosts();
      setPublishTarget(null);
      toast.success(t('social.toast.published', { defaultValue: 'Publishing started' }));
    },
    onError: () => {
      toast.error(t('social.toast.publishFailed', { defaultValue: 'Failed to publish post' }));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (postId: string) => marketingApi.delete(`/social-planner/posts/${postId}`),
    onSuccess: () => {
      invalidatePosts();
      setDeletePost(null);
      toast.success(t('social.toast.postDeleted', { defaultValue: 'Post deleted' }));
    },
    onError: () => {
      toast.error(t('social.toast.deleteFailed', { defaultValue: 'Failed to delete post' }));
    },
  });

  // ── Handlers ────────────────────────────────────────────────────────────────

  const openCreate = () => {
    setEditingPost(null);
    setComposerOpen(true);
  };

  const openEdit = (post: SocialPost) => {
    setEditingPost(post);
    setComposerOpen(true);
  };

  const handleComposerClose = (open: boolean) => {
    setComposerOpen(open);
    if (!open) setEditingPost(null);
  };

  // ── Post columns ────────────────────────────────────────────────────────────

  const postColumns: ColumnDef<SocialPost, unknown>[] = [
    {
      accessorKey: 'content',
      header: t('social.table.content', { defaultValue: 'Content' }),
      cell: ({ row }) => {
        const post = row.original;
        return (
          <div className="max-w-md">
            <p className="text-sm text-foreground line-clamp-2">{post.content}</p>
            {post.mediaUrls.length > 0 && (
              <p className="mt-0.5 text-micro text-muted-foreground">
                {t('social.table.mediaCount', {
                  defaultValue: '{{count}} media',
                  count: post.mediaUrls.length,
                })}
              </p>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: 'status',
      header: t('social.table.status', { defaultValue: 'Status' }),
      cell: ({ getValue }) => {
        const val = getValue<string>();
        return (
          <Badge tone={POST_STATUS_TONE[val] ?? 'neutral'} size="sm">
            {t(`social.postStatus.${val}`, { defaultValue: val })}
          </Badge>
        );
      },
    },
    {
      id: 'targets',
      header: t('social.table.targets', { defaultValue: 'Targets' }),
      cell: ({ row }) => {
        const targets = row.original.targets;
        if (targets.length === 0) {
          return <span className="text-sm text-muted-foreground">—</span>;
        }
        return (
          <div className="flex flex-wrap gap-1">
            {targets.map((tg) => {
              const meta = NETWORK_META[tg.network];
              const Icon = meta.icon;
              return (
                <Badge key={tg.id} tone={TARGET_STATUS_TONE[tg.status] ?? 'neutral'} size="sm">
                  <Icon className="h-3 w-3" aria-hidden="true" />
                  {t(`social.targetStatus.${tg.status}`, { defaultValue: tg.status })}
                </Badge>
              );
            })}
          </div>
        );
      },
    },
    {
      accessorKey: 'scheduledAt',
      header: t('social.table.scheduledAt', { defaultValue: 'Scheduled' }),
      cell: ({ row }) => {
        const post = row.original;
        const ts = post.publishedAt ?? post.scheduledAt;
        if (!ts) return <span className="text-sm text-muted-foreground">—</span>;
        return <span className="text-sm text-muted-foreground">{fmtDateTime(ts)}</span>;
      },
    },
    {
      id: 'actions',
      header: '',
      size: 48,
      cell: ({ row }) => {
        const post = row.original;
        const canEdit = post.status === 'DRAFT';
        const canPublish = post.status === 'DRAFT' || post.status === 'SCHEDULED';
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton aria-label={t('common.actions', { defaultValue: 'Actions' })} size="sm" variant="ghost">
                <span className="text-lg leading-none" aria-hidden="true">⋯</span>
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canEdit && (
                <DropdownMenuItem onClick={() => openEdit(post)}>
                  <Pencil className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('common.edit', { defaultValue: 'Edit' })}
                </DropdownMenuItem>
              )}
              {canPublish && (
                <DropdownMenuItem onClick={() => setPublishTarget(post)}>
                  <Send className="mr-2 h-4 w-4" aria-hidden="true" />
                  {t('social.action.publishNow', { defaultValue: 'Publish now' })}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-danger focus:text-danger"
                onClick={() => setDeletePost(post)}
              >
                <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                {t('common.delete', { defaultValue: 'Delete' })}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  // ── Render ──────────────────────────────────────────────────────────────────

  const noAccounts = !accountsLoading && accounts.length === 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('social.title', { defaultValue: 'Social Planner' })}
        description={t('social.subtitle', {
          defaultValue: 'Compose, schedule and publish posts across your social networks.',
        })}
        actions={
          view === 'posts' ? (
            <Button onClick={openCreate} disabled={noAccounts}>
              <Plus className="h-4 w-4" aria-hidden="true" />
              {t('social.newPost', { defaultValue: 'New post' })}
            </Button>
          ) : (
            <Button
              onClick={() => setConnectOpen(true)}
              disabled={status ? !status.secretBoxConfigured : false}
            >
              <Link2 className="h-4 w-4" aria-hidden="true" />
              {t('social.connectAccount', { defaultValue: 'Connect account' })}
            </Button>
          )
        }
      />

      <SegmentedControl<View>
        aria-label={t('social.viewToggle', { defaultValue: 'Social planner view' })}
        value={view}
        onChange={setView}
        options={[
          { value: 'posts', label: t('social.tabs.posts', { defaultValue: 'Posts' }) },
          { value: 'accounts', label: t('social.tabs.accounts', { defaultValue: 'Accounts' }) },
        ]}
      />

      {view === 'posts' ? (
        <DataTable
          columns={postColumns}
          data={posts}
          isLoading={postsLoading}
          loadingRowCount={5}
          emptyState={
            <EmptyState
              icon={<Megaphone className="h-10 w-10" />}
              title={t('social.empty.title', { defaultValue: 'No posts yet' })}
              description={
                noAccounts
                  ? t('social.empty.connectFirst', {
                      defaultValue: 'Connect a social account, then compose your first post.',
                    })
                  : t('social.empty.hint', { defaultValue: 'Compose your first social post.' })
              }
              action={
                <Button onClick={openCreate} variant="outline" disabled={noAccounts}>
                  <Plus className="h-4 w-4" aria-hidden="true" />
                  {t('social.newPost', { defaultValue: 'New post' })}
                </Button>
              }
            />
          }
        />
      ) : (
        <div className="space-y-4">
          {/* One-click OAuth connect — primary path; the manual dialog stays as fallback. */}
          <OAuthConnectButtons status={status} />
          <AccountsView
            accounts={accounts}
            isLoading={accountsLoading}
            onConnect={() => setConnectOpen(true)}
            onDisconnect={setDisconnectAccount}
            onReconnect={(acc) => startConnect(acc.network)}
            canConnect={status ? status.secretBoxConfigured : true}
          />
        </div>
      )}

      {/* Composer */}
      <PostComposerDialog
        open={composerOpen}
        onOpenChange={handleComposerClose}
        accounts={accounts}
        post={editingPost}
        onSubmit={(values) => composerMutation.mutate(values)}
        isPending={composerMutation.isPending}
      />

      {/* OAuth account selection (after the provider callback returns) */}
      <AccountSelectDialog
        pendingId={pendingConnectId}
        onOpenChange={(open) => { if (!open) setPendingConnectId(null); }}
      />

      {/* Connect account (manual fallback) */}
      <ConnectAccountDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onSubmit={(values) => connectMutation.mutate(values)}
        isPending={connectMutation.isPending}
        secretBoxConfigured={status ? status.secretBoxConfigured : true}
      />

      {/* Publish-now confirm */}
      <ConfirmDialog
        open={!!publishTarget}
        onOpenChange={(open) => { if (!open) setPublishTarget(null); }}
        title={t('social.action.publishNow', { defaultValue: 'Publish now' })}
        description={t('social.confirm.publish', {
          defaultValue: 'This publishes the post to all its pending targets immediately.',
        })}
        confirmLabel={t('social.action.publishNow', { defaultValue: 'Publish now' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        onConfirm={() => publishTarget && publishNowMutation.mutate(publishTarget.id)}
        loading={publishNowMutation.isPending}
      />

      {/* Delete post confirm */}
      <ConfirmDialog
        open={!!deletePost}
        onOpenChange={(open) => { if (!open) setDeletePost(null); }}
        title={t('social.confirm.deleteTitle', { defaultValue: 'Delete post' })}
        description={t('social.confirm.deleteBody', {
          defaultValue: 'This permanently removes the post and its targets. This cannot be undone.',
        })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => deletePost && deleteMutation.mutate(deletePost.id)}
        loading={deleteMutation.isPending}
      />

      {/* Disconnect account confirm */}
      <ConfirmDialog
        open={!!disconnectAccount}
        onOpenChange={(open) => { if (!open) setDisconnectAccount(null); }}
        title={t('social.confirm.disconnectTitle', { defaultValue: 'Disconnect account' })}
        description={t('social.confirm.disconnectBody', {
          defaultValue: 'The planner will no longer be able to publish to this account.',
        })}
        confirmLabel={t('social.action.disconnect', { defaultValue: 'Disconnect' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        onConfirm={() => disconnectAccount && disconnectMutation.mutate(disconnectAccount.id)}
        loading={disconnectMutation.isPending}
      />
    </div>
  );
}

// ── Accounts view ─────────────────────────────────────────────────────────────

interface AccountsViewProps {
  accounts: SocialAccount[];
  isLoading: boolean;
  onConnect: () => void;
  onDisconnect: (account: SocialAccount) => void;
  onReconnect: (account: SocialAccount) => void;
  canConnect: boolean;
}

function AccountsView({ accounts, isLoading, onConnect, onDisconnect, onReconnect, canConnect }: AccountsViewProps) {
  const { t } = useTranslation('marketing');

  if (isLoading) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <Card key={i} className="h-24 animate-pulse bg-surface-muted" />
        ))}
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <EmptyState
        icon={<Link2 className="h-10 w-10" />}
        title={t('social.accounts.empty', { defaultValue: 'No connected accounts' })}
        description={t('social.accounts.emptyHint', {
          defaultValue: 'Connect a Facebook, Instagram or LinkedIn account to start publishing.',
        })}
        action={
          <Button onClick={onConnect} variant="outline" disabled={!canConnect}>
            <Link2 className="h-4 w-4" aria-hidden="true" />
            {t('social.connectAccount', { defaultValue: 'Connect account' })}
          </Button>
        }
      />
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {accounts.map((acc) => {
        const meta = NETWORK_META[acc.network];
        const Icon = meta.icon;
        const needsReauth = acc.lastError === 'reauth_required';
        const expired = (acc.tokenExpiresAt && new Date(acc.tokenExpiresAt) < new Date()) || needsReauth;
        return (
          <Card key={acc.id} className="flex items-start gap-3 p-4">
            <span className="rounded-lg bg-surface-muted p-2 text-muted-foreground" aria-hidden="true">
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">{acc.displayName}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <Badge tone={meta.tone} size="sm">{meta.label}</Badge>
                {!acc.enabled && (
                  <Badge tone="neutral" size="sm">
                    {t('social.accounts.disabled', { defaultValue: 'Disabled' })}
                  </Badge>
                )}
                {expired && (
                  <Badge tone="danger" size="sm">
                    <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                    {t('social.accounts.expired', { defaultValue: 'Token expired' })}
                  </Badge>
                )}
              </div>
              {/* Token is already masked by the backend — display verbatim, never raw. */}
              <p className="mt-1.5 font-mono text-micro text-muted-foreground">{acc.accessToken}</p>
              {needsReauth && (
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => onReconnect(acc)}
                >
                  <Link2 className="h-4 w-4" aria-hidden="true" />
                  {t('social.action.reconnect', { defaultValue: 'Reconnect' })}
                </Button>
              )}
            </div>
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={t('social.action.disconnect', { defaultValue: 'Disconnect' })}
              onClick={() => onDisconnect(acc)}
            >
              <Unlink className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </Card>
        );
      })}
    </div>
  );
}
