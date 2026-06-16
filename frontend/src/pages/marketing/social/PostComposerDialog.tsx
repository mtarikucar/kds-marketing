import { useEffect } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { Plus, Trash2, Image as ImageIcon, CalendarClock } from 'lucide-react';
import { postSchema, type PostFormValues } from './socialSchemas';
import type { SocialAccount, SocialPost } from './types';
import { NETWORK_META } from './networks';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Field } from '@/components/ui/Field';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Checkbox } from '@/components/ui/Checkbox';
import { EmptyState } from '@/components/ui/EmptyState';

export interface PostComposerSubmit {
  content: string;
  mediaUrls: string[];
  targetAccountIds: string[];
  /** ISO string when the user picked a schedule, else undefined (publish-later draft). */
  scheduledAt?: string;
}

interface PostComposerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: SocialAccount[];
  /** When editing an existing DRAFT post; otherwise create. */
  post?: SocialPost | null;
  onSubmit: (values: PostComposerSubmit) => void;
  isPending: boolean;
}

const MAX_CONTENT = 5000;

export function PostComposerDialog({
  open,
  onOpenChange,
  accounts,
  post,
  onSubmit,
  isPending,
}: PostComposerDialogProps) {
  const { t } = useTranslation('marketing');
  const isEdit = !!post;

  const form = useForm<PostFormValues>({
    resolver: zodResolver(postSchema),
    mode: 'onBlur',
    defaultValues: {
      content: '',
      mediaUrls: [],
      targetAccountIds: [],
      scheduledAt: '',
    },
  });

  // Populate when (re)opening
  useEffect(() => {
    if (!open) return;
    if (post) {
      form.reset({
        content: post.content,
        mediaUrls: post.mediaUrls ?? [],
        targetAccountIds: post.targets.map((tg) => tg.socialAccountId),
        scheduledAt: post.scheduledAt ? toLocalInput(post.scheduledAt) : '',
      });
    } else {
      form.reset({ content: '', mediaUrls: [], targetAccountIds: [], scheduledAt: '' });
    }
  }, [open, post, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const handleSubmit: SubmitHandler<PostFormValues> = (values) => {
    const cleanMedia = (values.mediaUrls ?? []).map((u) => u.trim()).filter(Boolean);
    onSubmit({
      content: values.content.trim(),
      mediaUrls: cleanMedia,
      targetAccountIds: values.targetAccountIds,
      scheduledAt: values.scheduledAt ? new Date(values.scheduledAt).toISOString() : undefined,
    });
  };

  const errors = form.formState.errors;
  const content = form.watch('content') ?? '';
  const selected = form.watch('targetAccountIds') ?? [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit
              ? t('social.composer.editTitle', { defaultValue: 'Edit post' })
              : t('social.composer.createTitle', { defaultValue: 'New post' })}
          </DialogTitle>
          <DialogDescription>
            {t('social.composer.subtitle', {
              defaultValue: 'Compose once and publish across your connected networks.',
            })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
          {/* Content */}
          <Field
            label={t('social.composer.content', { defaultValue: 'Content' })}
            error={fieldErr(errors.content?.message)}
            hint={`${content.length} / ${MAX_CONTENT}`}
            required
          >
            {({ id, describedBy, invalid }) => (
              <Textarea
                id={id}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                rows={5}
                maxLength={MAX_CONTENT}
                placeholder={t('social.composer.contentPlaceholder', {
                  defaultValue: 'What do you want to share?',
                })}
                {...form.register('content')}
              />
            )}
          </Field>

          {/* Media URLs — a small controlled string-array editor */}
          <Controller
            control={form.control}
            name="mediaUrls"
            render={({ field }) => {
              const urls = field.value ?? [];
              const setAt = (idx: number, val: string) =>
                field.onChange(urls.map((u, i) => (i === idx ? val : u)));
              const removeAt = (idx: number) =>
                field.onChange(urls.filter((_, i) => i !== idx));
              return (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-foreground">
                      {t('social.composer.media', { defaultValue: 'Media URLs' })}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={urls.length >= 10}
                      onClick={() => field.onChange([...urls, ''])}
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" />
                      {t('social.composer.addMedia', { defaultValue: 'Add URL' })}
                    </Button>
                  </div>
                  {urls.length === 0 ? (
                    <p className="text-caption text-muted-foreground">
                      {t('social.composer.noMedia', {
                        defaultValue: 'No media attached. Add up to 10 image or video URLs.',
                      })}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {urls.map((url, idx) => (
                        <div key={idx} className="flex items-start gap-2">
                          <div className="flex-1">
                            <Field error={fieldErr(errors.mediaUrls?.[idx]?.message)}>
                              {({ id, describedBy, invalid }) => (
                                <div className="relative flex items-center">
                                  <ImageIcon
                                    className="absolute start-2.5 h-4 w-4 text-muted-foreground pointer-events-none"
                                    aria-hidden="true"
                                  />
                                  <Input
                                    id={id}
                                    aria-describedby={describedBy}
                                    aria-invalid={invalid}
                                    className="ps-8"
                                    placeholder="https://…"
                                    value={url}
                                    onChange={(e) => setAt(idx, e.target.value)}
                                  />
                                </div>
                              )}
                            </Field>
                          </div>
                          <IconButton
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-label={t('common.delete', { defaultValue: 'Delete' })}
                            onClick={() => removeAt(idx)}
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
                          </IconButton>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            }}
          />

          {/* Target accounts (multi-select) */}
          <Field
            label={t('social.composer.accounts', { defaultValue: 'Publish to' })}
            error={fieldErr((errors.targetAccountIds as { message?: string } | undefined)?.message)}
          >
            {() => (
              <Controller
                control={form.control}
                name="targetAccountIds"
                render={({ field }) =>
                  accounts.length === 0 ? (
                    <EmptyState
                      title={t('social.composer.noAccounts', {
                        defaultValue: 'No connected accounts',
                      })}
                      description={t('social.composer.noAccountsHint', {
                        defaultValue: 'Connect a social account first to choose where to publish.',
                      })}
                    />
                  ) : (
                    <div className="grid gap-1.5 rounded-lg border border-border p-2 sm:grid-cols-2">
                      {accounts.map((acc) => {
                        const meta = NETWORK_META[acc.network];
                        const Icon = meta.icon;
                        const checked = field.value.includes(acc.id);
                        return (
                          <label
                            key={acc.id}
                            className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-muted"
                          >
                            <Checkbox
                              checked={checked}
                              disabled={!acc.enabled}
                              onCheckedChange={(v) => {
                                if (v) field.onChange([...field.value, acc.id]);
                                else field.onChange(field.value.filter((id) => id !== acc.id));
                              }}
                            />
                            <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                            <span className="text-sm text-foreground truncate">
                              {acc.displayName}
                            </span>
                            <span className="ms-auto text-micro text-muted-foreground">
                              {meta.label}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  )
                }
              />
            )}
          </Field>

          {/* Schedule */}
          <Field
            label={t('social.composer.schedule', { defaultValue: 'Schedule (optional)' })}
            hint={t('social.composer.scheduleHint', {
              defaultValue: 'Leave empty to keep as draft; the post publishes at this time when set.',
            })}
          >
            {({ id }) => (
              <div className="relative flex items-center">
                <CalendarClock
                  className="absolute start-2.5 h-4 w-4 text-muted-foreground pointer-events-none"
                  aria-hidden="true"
                />
                <Input
                  id={id}
                  type="datetime-local"
                  className="ps-8"
                  {...form.register('scheduledAt')}
                />
              </div>
            )}
          </Field>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </Button>
            <Button type="submit" loading={isPending} disabled={selected.length === 0 && !isEdit}>
              {isEdit
                ? t('common.save', { defaultValue: 'Save' })
                : t('social.composer.create', { defaultValue: 'Create post' })}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Convert an ISO timestamp into the value a <input type="datetime-local"> expects. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
