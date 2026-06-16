import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Pin, PinOff, Trash2, MessageSquare, Send } from 'lucide-react';
import {
  Card,
  CardContent,
  Button,
  IconButton,
  Badge,
  Textarea,
  Skeleton,
} from '@/components/ui';
import { useCommunityMutations, usePostComments } from '../hooks';
import type { CommunityPost } from '../types';
import { apiError } from '../util';

interface Props {
  communityId: string;
  post: CommunityPost;
  onDelete: (post: CommunityPost) => void;
}

export function PostCard({ communityId, post, onDelete }: Props) {
  const { t } = useTranslation('marketing');
  const { pinPost, addComment } = useCommunityMutations(communityId);
  const [showComments, setShowComments] = useState(false);
  const [commentBody, setCommentBody] = useState('');
  const { data: comments, isLoading } = usePostComments(showComments ? post.id : undefined);

  const commentCount = post._count?.comments ?? 0;

  const submitComment = () => {
    const body = commentBody.trim();
    if (!body) return;
    addComment.mutate(
      { postId: post.id, body },
      {
        onSuccess: () => setCommentBody(''),
        onError: (e) => toast.error(apiError(e, 'Failed to comment')),
      },
    );
  };

  return (
    <Card className={post.pinned ? 'border-primary' : undefined}>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {post.pinned && (
                <Badge tone="info" size="sm">
                  <Pin className="mr-1 h-3 w-3" aria-hidden="true" />
                  {t('memberships.posts.pinned', { defaultValue: 'Pinned' })}
                </Badge>
              )}
              {post.title && <p className="truncate text-sm font-semibold text-foreground">{post.title}</p>}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{post.body}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={
                post.pinned
                  ? t('memberships.posts.unpin', { defaultValue: 'Unpin' })
                  : t('memberships.posts.pin', { defaultValue: 'Pin' })
              }
              onClick={() =>
                pinPost.mutate(
                  { postId: post.id, pinned: !post.pinned },
                  { onError: (e) => toast.error(apiError(e, 'Failed to pin')) },
                )
              }
            >
              {post.pinned ? <PinOff className="h-4 w-4" aria-hidden="true" /> : <Pin className="h-4 w-4" aria-hidden="true" />}
            </IconButton>
            <IconButton
              size="sm"
              variant="ghost"
              aria-label={t('common.delete', { defaultValue: 'Delete' })}
              onClick={() => onDelete(post)}
            >
              <Trash2 className="h-4 w-4" aria-hidden="true" />
            </IconButton>
          </div>
        </div>

        <Button variant="ghost" size="sm" className="px-0" onClick={() => setShowComments((s) => !s)}>
          <MessageSquare className="h-4 w-4" aria-hidden="true" />
          {t('memberships.posts.comments', { defaultValue: '{{count}} comments', count: commentCount })}
        </Button>

        {showComments && (
          <div className="space-y-3 border-t border-border pt-3">
            {isLoading ? (
              <Skeleton className="h-12 w-full" />
            ) : (comments ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('memberships.posts.noComments', { defaultValue: 'No comments yet.' })}
              </p>
            ) : (
              <ul className="space-y-2">
                {(comments ?? []).map((c) => (
                  <li key={c.id} className="rounded-md bg-surface-muted/40 px-3 py-2 text-sm text-foreground">
                    {c.body}
                  </li>
                ))}
              </ul>
            )}

            <div className="flex items-start gap-2">
              <Textarea
                rows={1}
                value={commentBody}
                onChange={(e) => setCommentBody(e.target.value)}
                placeholder={t('memberships.posts.commentPlaceholder', { defaultValue: 'Write a comment…' })}
                aria-label={t('memberships.posts.comment', { defaultValue: 'Comment' })}
              />
              <Button onClick={submitComment} loading={addComment.isPending} disabled={!commentBody.trim()}>
                <Send className="h-4 w-4" aria-hidden="true" />
                {t('memberships.posts.send', { defaultValue: 'Send' })}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
