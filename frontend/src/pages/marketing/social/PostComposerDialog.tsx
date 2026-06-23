import { useEffect, useState } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2, Image as ImageIcon, CalendarClock } from 'lucide-react';
import { postSchema, type PostFormValues } from './socialSchemas';
import type { SocialAccount, SocialPost, TikTokPostOptions } from './types';
import { NETWORK_META } from './networks';
import { getTiktokCreatorInfo } from '../../../features/marketing/api/social-planner.service';
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
import { Switch } from '@/components/ui/Switch';
import { EmptyState } from '@/components/ui/EmptyState';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';

export interface PostComposerSubmit {
  content: string;
  mediaUrls: string[];
  targetAccountIds: string[];
  /** ISO string when the user picked a schedule, else undefined (publish-later draft). */
  scheduledAt?: string;
  /** Per-post publish options (populated when a TikTok account is selected). */
  options?: { tiktok?: TikTokPostOptions };
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

/** Privacy-level label map (shown in the select dropdown). */
const PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: 'Public to everyone',
  MUTUAL_FOLLOW_FRIENDS: 'Mutual follow friends',
  FOLLOWER_OF_CREATOR: 'Followers of creator',
  SELF_ONLY: 'Only me',
};

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

  // ── TikTok-specific local state ──────────────────────────────────────────────
  const [tiktokOpts, setTiktokOpts] = useState<TikTokPostOptions>({});

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
      // Restore saved TikTok options when editing
      setTiktokOpts(post.options?.tiktok ?? {});
    } else {
      form.reset({ content: '', mediaUrls: [], targetAccountIds: [], scheduledAt: '' });
      setTiktokOpts({});
    }
  }, [open, post, form]);

  const fieldErr = (msg?: string) =>
    msg ? t([`validation.${msg}`, msg], { defaultValue: msg }) : undefined;

  const errors = form.formState.errors;
  const content = form.watch('content') ?? '';
  const selected = form.watch('targetAccountIds') ?? [];

  // ── TikTok target detection ────────────────────────────────────────────────
  // If any selected account is TikTok, pick the first one to fetch creator-info.
  const selectedAccounts = accounts.filter((a) => selected.includes(a.id));
  const tiktokAccount = selectedAccounts.find((a) => a.network === 'TIKTOK') ?? null;

  const { data: creatorInfo, isLoading: creatorInfoLoading } = useQuery({
    queryKey: ['marketing', 'social', 'tiktok-creator-info', tiktokAccount?.id],
    queryFn: () => getTiktokCreatorInfo(tiktokAccount!.id),
    enabled: !!tiktokAccount,
    staleTime: 5 * 60 * 1000,
  });

  // When creator-info first loads, initialise the privacy level to the first
  // allowed option if not already set (or if the previously set level is no
  // longer available for this account).
  useEffect(() => {
    if (!creatorInfo) return;
    const options = creatorInfo.privacyLevelOptions;
    if (!options.length) return;
    setTiktokOpts((prev) => {
      const current = prev.privacyLevel;
      const valid = current && options.includes(current) ? current : options[0];
      if (valid === current) return prev;
      return { ...prev, privacyLevel: valid };
    });
  }, [creatorInfo]);

  const handleSubmit: SubmitHandler<PostFormValues> = (values) => {
    const cleanMedia = (values.mediaUrls ?? []).map((u) => u.trim()).filter(Boolean);
    // Only include TikTok options when a TikTok target is selected.
    const options = tiktokAccount
      ? { tiktok: tiktokOpts }
      : undefined;
    onSubmit({
      content: values.content.trim(),
      mediaUrls: cleanMedia,
      targetAccountIds: values.targetAccountIds,
      scheduledAt: values.scheduledAt ? new Date(values.scheduledAt).toISOString() : undefined,
      options,
    });
  };

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

          {/* TikTok-specific controls — shown only when a TikTok account is selected */}
          {tiktokAccount && (
            <TiktokControls
              creatorInfo={creatorInfo ?? null}
              isLoading={creatorInfoLoading}
              value={tiktokOpts}
              onChange={setTiktokOpts}
              mediaUrls={form.watch('mediaUrls') ?? []}
            />
          )}

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

// ── TikTok controls panel ─────────────────────────────────────────────────────

interface TiktokCreatorInfo {
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
}

interface TiktokControlsProps {
  creatorInfo: TiktokCreatorInfo | null;
  isLoading: boolean;
  value: TikTokPostOptions;
  onChange: (next: TikTokPostOptions) => void;
  mediaUrls: string[];
}

function TiktokControls({ creatorInfo, isLoading, value, onChange, mediaUrls }: TiktokControlsProps) {
  const { t } = useTranslation('marketing');

  const set = <K extends keyof TikTokPostOptions>(key: K, val: TikTokPostOptions[K]) =>
    onChange({ ...value, [key]: val });

  const privacyOptions = creatorInfo?.privacyLevelOptions ?? [];
  const isPhoto = value.mediaType === 'PHOTO';

  return (
    <div
      className="rounded-lg border border-border bg-surface-muted p-4 space-y-4"
      data-testid="tiktok-controls"
    >
      <p className="text-sm font-semibold text-foreground">
        {t('social.composer.tiktok.title', { defaultValue: 'TikTok settings' })}
      </p>

      {isLoading && (
        <p className="text-sm text-muted-foreground animate-pulse">
          {t('social.composer.tiktok.loading', { defaultValue: 'Loading TikTok options…' })}
        </p>
      )}

      {/* Privacy level */}
      {!isLoading && privacyOptions.length > 0 && (
        <Field label={t('social.composer.tiktok.privacy', { defaultValue: 'Privacy' })}>
          {({ id }) => (
            <Select
              value={value.privacyLevel ?? privacyOptions[0]}
              onValueChange={(v) => set('privacyLevel', v)}
            >
              <SelectTrigger id={id} aria-label={t('social.composer.tiktok.privacy', { defaultValue: 'Privacy' })}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {privacyOptions.map((opt) => (
                  <SelectItem key={opt} value={opt}>
                    {PRIVACY_LABELS[opt] ?? opt}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      )}

      {/* Media type switch — video / photo */}
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm text-foreground">
          {t('social.composer.tiktok.mediaType', { defaultValue: 'Post type' })}
        </span>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{t('social.composer.tiktok.video', { defaultValue: 'Video' })}</span>
          <Switch
            aria-label={t('social.composer.tiktok.photoMode', { defaultValue: 'Switch to photo / carousel' })}
            checked={isPhoto}
            onCheckedChange={(v) => set('mediaType', v ? 'PHOTO' : 'VIDEO')}
          />
          <span>{t('social.composer.tiktok.photo', { defaultValue: 'Photo' })}</span>
        </div>
      </div>

      {/* Cover index (only relevant for photo/carousel) */}
      {isPhoto && mediaUrls.length > 1 && (
        <Field
          label={t('social.composer.tiktok.coverIndex', { defaultValue: 'Cover image index (0-based)' })}
          hint={t('social.composer.tiktok.coverIndexHint', {
            defaultValue: `0 – ${mediaUrls.length - 1}`,
          })}
        >
          {({ id }) => (
            <Input
              id={id}
              type="number"
              min={0}
              max={mediaUrls.length - 1}
              value={value.coverIndex ?? 0}
              onChange={(e) => {
                const n = Math.max(0, Math.min(mediaUrls.length - 1, Number(e.target.value)));
                set('coverIndex', n);
              }}
            />
          )}
        </Field>
      )}

      {/* Interaction toggles */}
      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {t('social.composer.tiktok.interactions', { defaultValue: 'Interactions' })}
        </p>

        <ToggleRow
          label={t('social.composer.tiktok.disableComment', { defaultValue: 'Disable comments' })}
          checked={value.disableComment ?? (creatorInfo?.commentDisabled ?? false)}
          disabled={creatorInfo?.commentDisabled ?? false}
          onChange={(v) => set('disableComment', v)}
        />
        <ToggleRow
          label={t('social.composer.tiktok.disableDuet', { defaultValue: 'Disable duet' })}
          checked={value.disableDuet ?? (creatorInfo?.duetDisabled ?? false)}
          disabled={creatorInfo?.duetDisabled ?? false}
          onChange={(v) => set('disableDuet', v)}
        />
        <ToggleRow
          label={t('social.composer.tiktok.disableStitch', { defaultValue: 'Disable stitch' })}
          checked={value.disableStitch ?? (creatorInfo?.stitchDisabled ?? false)}
          disabled={creatorInfo?.stitchDisabled ?? false}
          onChange={(v) => set('disableStitch', v)}
        />
      </div>
    </div>
  );
}

interface ToggleRowProps {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}

function ToggleRow({ label, checked, disabled, onChange }: ToggleRowProps) {
  return (
    <div className="flex items-center justify-between gap-4">
      <label className="text-sm text-foreground select-none">{label}</label>
      <Switch
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={label}
      />
    </div>
  );
}

/** Convert an ISO timestamp into the value a <input type="datetime-local"> expects. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
