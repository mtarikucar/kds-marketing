import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useForm } from 'react-hook-form';
import { useBreadcrumbLabel } from '@/features/marketing/hooks/useBreadcrumbLabel';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import { ArrowLeft, Plus, UserPlus, UserMinus, Users, Send } from 'lucide-react';
import {
  PageHeader,
  Button,
  IconButton,
  Badge,
  Card,
  CardContent,
  Field,
  Input,
  Textarea,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  Skeleton,
  EmptyState,
  ConfirmDialog,
} from '@/components/ui';
import {
  useCommunity,
  useCommunityMutations,
  useCommunityPosts,
  useCommunityMembers,
} from '../hooks';
import { postSchema, type PostFormValues } from '../schemas';
import type { CommunityMember, CommunityPost } from '../types';
import { apiError } from '../util';
import { PostCard } from './PostCard';
import { JoinMemberDialog } from './JoinMemberDialog';

export default function CommunityDetailPage() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const { id = '' } = useParams<{ id: string }>();

  const { data: community, isLoading } = useCommunity(id);
  const { data: posts, isLoading: postsLoading } = useCommunityPosts(id);
  const { data: members, isLoading: membersLoading } = useCommunityMembers(id);
  const m = useCommunityMutations(id);

  const [joinOpen, setJoinOpen] = useState(false);
  const [deletePost, setDeletePost] = useState<CommunityPost | null>(null);
  const [leaveTarget, setLeaveTarget] = useState<CommunityMember | null>(null);

  const postForm = useForm<PostFormValues>({
    resolver: zodResolver(postSchema),
    mode: 'onBlur',
    defaultValues: { title: '', body: '' },
  });

  useBreadcrumbLabel(community?.name);

  if (isLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!community) {
    return (
      <EmptyState
        title={t('memberships.communities.notFound', { defaultValue: 'Community not found' })}
        action={
          <Button variant="outline" onClick={() => navigate('/memberships/communities')}>
            {t('memberships.backToCommunities', { defaultValue: 'Back to communities' })}
          </Button>
        }
      />
    );
  }

  const submitPost = postForm.handleSubmit((values) => {
    m.createPost.mutate(
      { id: community.id, data: { ...(values.title ? { title: values.title } : {}), body: values.body } },
      {
        onSuccess: () => {
          postForm.reset({ title: '', body: '' });
          toast.success(t('memberships.posts.created', { defaultValue: 'Post published' }));
        },
        onError: (e) => toast.error(apiError(e, 'Failed to post')),
      },
    );
  });

  const handleJoin = (leadId: string, role: string) => {
    m.join.mutate(
      { id: community.id, leadId, role },
      {
        onSuccess: () => {
          setJoinOpen(false);
          toast.success(t('memberships.members.added', { defaultValue: 'Member added' }));
        },
        onError: (e) => toast.error(apiError(e, 'Failed to add member')),
      },
    );
  };

  const postList = posts ?? [];
  const memberList = members ?? [];
  const errors = postForm.formState.errors;

  return (
    <div className="space-y-5">
      <PageHeader
        title={community.name}
        description={community.description ?? undefined}
        actions={
          <Button variant="ghost" onClick={() => navigate('/memberships/communities')}>
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            {t('memberships.back', { defaultValue: 'Back' })}
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={community.status === 'ACTIVE' ? 'success' : 'warning'}>
          {t(`memberships.communities.statuses.${community.status}`, { defaultValue: community.status })}
        </Badge>
        <Badge tone="info" size="sm">
          <Users className="mr-1 h-3 w-3" aria-hidden="true" />
          {t('memberships.communities.memberCount', {
            defaultValue: '{{count}} members',
            count: community._count?.members ?? memberList.length,
          })}
        </Badge>
      </div>

      <Tabs defaultValue="feed">
        <TabsList>
          <TabsTrigger value="feed">{t('memberships.tabs.feed', { defaultValue: 'Feed' })}</TabsTrigger>
          <TabsTrigger value="members">{t('memberships.tabs.members', { defaultValue: 'Members' })}</TabsTrigger>
        </TabsList>

        <TabsContent value="feed" className="space-y-4 pt-4">
          <Card>
            <CardContent className="space-y-3 p-4">
              <Field label={t('memberships.posts.titleLabel', { defaultValue: 'Title (optional)' })} error={errors.title?.message}>
                {({ id }) => <Input id={id} {...postForm.register('title')} />}
              </Field>
              <Field label={t('memberships.posts.body', { defaultValue: 'Post' })} error={errors.body?.message} required>
                {({ id, describedBy, invalid }) => (
                  <Textarea
                    id={id}
                    aria-describedby={describedBy}
                    aria-invalid={invalid}
                    rows={3}
                    placeholder={t('memberships.posts.bodyPlaceholder', { defaultValue: 'Share something with members…' })}
                    {...postForm.register('body')}
                  />
                )}
              </Field>
              <div className="flex justify-end">
                <Button onClick={submitPost} loading={m.createPost.isPending}>
                  <Send className="h-4 w-4" aria-hidden="true" />
                  {t('memberships.posts.publish', { defaultValue: 'Publish' })}
                </Button>
              </div>
            </CardContent>
          </Card>

          {postsLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : postList.length === 0 ? (
            <EmptyState
              icon={<Plus className="h-10 w-10" />}
              title={t('memberships.posts.empty', { defaultValue: 'No posts yet' })}
              description={t('memberships.posts.emptyHint', { defaultValue: 'Be the first to post in this community.' })}
            />
          ) : (
            <div className="space-y-3">
              {postList.map((p) => (
                <PostCard key={p.id} communityId={community.id} post={p} onDelete={setDeletePost} />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="members" className="space-y-4 pt-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              {t('memberships.members.count', { defaultValue: '{{count}} members', count: memberList.length })}
            </p>
            <Button size="sm" onClick={() => setJoinOpen(true)}>
              <UserPlus className="h-4 w-4" aria-hidden="true" />
              {t('memberships.members.add', { defaultValue: 'Add member' })}
            </Button>
          </div>

          {membersLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : memberList.length === 0 ? (
            <EmptyState
              icon={<Users className="h-10 w-10" />}
              title={t('memberships.members.empty', { defaultValue: 'No members yet' })}
              description={t('memberships.members.emptyHint', { defaultValue: 'Add a lead to grow this community.' })}
            />
          ) : (
            <ul className="space-y-2">
              {memberList.map((mem) => (
                <li key={mem.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                  <div className="flex items-center gap-2">
                    <code className="text-xs text-muted-foreground">{mem.leadId}</code>
                    <Badge tone={mem.role === 'MODERATOR' ? 'info' : 'neutral'} size="sm">
                      {t(`memberships.members.roles.${mem.role}`, { defaultValue: mem.role })}
                    </Badge>
                  </div>
                  <IconButton
                    size="sm"
                    variant="ghost"
                    aria-label={t('memberships.members.remove', { defaultValue: 'Remove member' })}
                    onClick={() => setLeaveTarget(mem)}
                  >
                    <UserMinus className="h-4 w-4" aria-hidden="true" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
        </TabsContent>
      </Tabs>

      <JoinMemberDialog open={joinOpen} onOpenChange={setJoinOpen} onConfirm={handleJoin} isPending={m.join.isPending} />

      <ConfirmDialog
        open={!!deletePost}
        onOpenChange={(o) => {
          if (!o) setDeletePost(null);
        }}
        title={t('memberships.posts.deleteTitle', { defaultValue: 'Delete post' })}
        description={t('memberships.posts.deleteDesc', { defaultValue: 'This removes the post and its comments.' })}
        confirmLabel={t('common.delete', { defaultValue: 'Delete' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={m.removePost.isPending}
        onConfirm={() =>
          deletePost &&
          m.removePost.mutate(deletePost.id, {
            onSuccess: () => {
              setDeletePost(null);
              toast.success(t('memberships.posts.deleted', { defaultValue: 'Post deleted' }));
            },
            onError: (e) => toast.error(apiError(e, 'Failed to delete post')),
          })
        }
      />

      <ConfirmDialog
        open={!!leaveTarget}
        onOpenChange={(o) => {
          if (!o) setLeaveTarget(null);
        }}
        title={t('memberships.members.removeTitle', { defaultValue: 'Remove member' })}
        description={t('memberships.members.removeDesc', { defaultValue: 'This removes the member from the community.' })}
        confirmLabel={t('memberships.members.remove', { defaultValue: 'Remove' })}
        cancelLabel={t('common.cancel', { defaultValue: 'Cancel' })}
        tone="danger"
        loading={m.leave.isPending}
        onConfirm={() =>
          leaveTarget &&
          m.leave.mutate(
            { id: community.id, leadId: leaveTarget.leadId },
            {
              onSuccess: () => {
                setLeaveTarget(null);
                toast.success(t('memberships.members.removed', { defaultValue: 'Member removed' }));
              },
              onError: (e) => toast.error(apiError(e, 'Failed to remove member')),
            },
          )
        }
      />
    </div>
  );
}
