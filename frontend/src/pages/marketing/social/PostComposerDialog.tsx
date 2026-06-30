import { useEffect, useRef, useState } from 'react';
import { useForm, Controller, type SubmitHandler } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Trash2, Image as ImageIcon, Film, Upload, CalendarClock, Sparkles } from 'lucide-react';
import {
  postSchema,
  POST_FORMATS,
  type PostFormValues,
  type PostFormat,
  type MediaItemValue,
} from './socialSchemas';
import type { SocialAccount, SocialPost, TikTokPostOptions } from './types';
import { NETWORK_META } from './networks';
import marketingApi from '../../../features/marketing/api/marketingApi';
import { getTiktokCreatorInfo, type TiktokCreatorInfo } from '../../../features/marketing/api/social-planner.service';

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
import { Sheet, SheetContent, SheetTitle, SheetDescription } from '@/components/ui/Sheet';
import {
  generateMedia,
  getGeneration,
  isTerminal,
  type GeneratedAssetType,
} from '../../../features/marketing/api/media.service';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';

export interface PostComposerSubmit {
  content: string;
  media: MediaItemValue[];
  /** Per-account format map (FB/IG only): { [socialAccountId]: FEED|REEL|STORY }. */
  formats: Record<string, PostFormat>;
  targetAccountIds: string[];
  /** ISO string when the user picked a schedule, else undefined (publish-later draft). */
  scheduledAt?: string;
  /** Per-network publish options — LinkedIn visibility and/or TikTok controls,
   *  populated when a LINKEDIN/TikTok target is selected. */
  options?: { linkedin?: { visibility: 'PUBLIC' | 'CONNECTIONS' }; tiktok?: TikTokPostOptions };
}

interface PostComposerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: SocialAccount[];
  /** When editing an existing DRAFT post; otherwise create. */
  post?: SocialPost | null;
  onSubmit: (values: PostComposerSubmit) => void;
  isPending: boolean;
  /** Media to pre-load into a NEW post (e.g. an asset handed off from AI Studio). */
  seedMedia?: MediaItemValue[];
}

const MAX_CONTENT = 5000;
/** Networks that support Reels/Stories — the rest always publish as a feed post. */
const FORMAT_NETWORKS = new Set(['FACEBOOK', 'INSTAGRAM']);

const LINKEDIN_VISIBILITIES = ['PUBLIC', 'CONNECTIONS'] as const;
type LinkedinVisibility = (typeof LINKEDIN_VISIBILITIES)[number];

const isVideoItem = (m: MediaItemValue) =>
  (m.mime?.startsWith('video/') ?? false) || /\.(mp4|mov|m4v|webm)(?:[?#]|$)/i.test(m.url);

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
  seedMedia,
}: PostComposerDialogProps) {
  const { t } = useTranslation('marketing');
  const isEdit = !!post;
  const [uploading, setUploading] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [linkedinVisibility, setLinkedinVisibility] = useState<LinkedinVisibility>('PUBLIC');

  const form = useForm<PostFormValues>({
    resolver: zodResolver(postSchema),
    mode: 'onBlur',
    defaultValues: { content: '', media: [], formats: {}, targetAccountIds: [], scheduledAt: '' },
  });

  // ── TikTok-specific local state ──────────────────────────────────────────────
  const [tiktokOpts, setTiktokOpts] = useState<TikTokPostOptions>({});

  // Populate when (re)opening
  useEffect(() => {
    if (!open) return;
    if (post) {
      const media: MediaItemValue[] =
        post.options?.media && post.options.media.length
          ? post.options.media.map((m) => ({ url: m.url, key: m.key, mime: m.mime }))
          : (post.mediaUrls ?? []).map((url) => ({ url }));
      form.reset({
        content: post.content,
        media,
        formats: (post.options?.formats as Record<string, PostFormat>) ?? {},
        targetAccountIds: post.targets.map((tg) => tg.socialAccountId),
        scheduledAt: post.scheduledAt ? toLocalInput(post.scheduledAt) : '',
      });
      setLinkedinVisibility(
        (post.options?.linkedin?.visibility as LinkedinVisibility) ?? 'PUBLIC',
      );
      // Restore saved TikTok options when editing
      setTiktokOpts(post.options?.tiktok ?? {});
    } else {
      form.reset({ content: '', media: seedMedia ?? [], formats: {}, targetAccountIds: [], scheduledAt: '' });
      setLinkedinVisibility('PUBLIC');
      setTiktokOpts({});
    }
  }, [open, post, form, seedMedia]);

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
    const media = (values.media ?? [])
      .map((m) => ({ ...m, url: m.url.trim() }))
      .filter((m) => m.url);
    // Keep only formats for currently-selected format-capable accounts.
    const formats: Record<string, PostFormat> = {};
    for (const accId of values.targetAccountIds) {
      const acc = accounts.find((a) => a.id === accId);
      if (acc && FORMAT_NETWORKS.has(acc.network)) {
        formats[accId] = (values.formats?.[accId] as PostFormat) ?? 'FEED';
      }
    }
    // Include per-network options only when a relevant target is selected.
    const options: { linkedin?: { visibility: LinkedinVisibility }; tiktok?: TikTokPostOptions } = {};
    if (linkedinAccounts.length > 0) options.linkedin = { visibility: linkedinVisibility };
    if (tiktokAccount) options.tiktok = tiktokOpts;
    onSubmit({
      content: values.content.trim(),
      media,
      formats,
      targetAccountIds: values.targetAccountIds,
      scheduledAt: values.scheduledAt ? new Date(values.scheduledAt).toISOString() : undefined,
      options,
    });
  };

  const formats = form.watch('formats') ?? {};

  const uploadFiles = async (files: FileList | null, current: MediaItemValue[], onChange: (m: MediaItemValue[]) => void) => {
    if (!files || files.length === 0) return;
    const room = 10 - current.length;
    const picked = Array.from(files).slice(0, Math.max(0, room));
    if (picked.length === 0) return;
    setUploading(true);
    try {
      const uploaded: MediaItemValue[] = [];
      for (const f of picked) {
        const fd = new FormData();
        fd.append('file', f);
        const res = await marketingApi.post('/social-planner/media', fd, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
        uploaded.push({ url: res.data.url, key: res.data.key, mime: res.data.mime });
      }
      onChange([...current, ...uploaded]);
    } catch (e: any) {
      toast.error(e.response?.data?.message ?? t('social.composer.uploadFailed', { defaultValue: 'Upload failed' }));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const formatAccounts = accounts.filter(
    (a) => selected.includes(a.id) && FORMAT_NETWORKS.has(a.network),
  );

  const linkedinAccounts = accounts.filter(
    (a) => selected.includes(a.id) && a.network === 'LINKEDIN',
  );

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

          {/* Media — upload to R2 or paste public URLs */}
          <Controller
            control={form.control}
            name="media"
            render={({ field }) => {
              const items = field.value ?? [];
              const setUrlAt = (idx: number, url: string) =>
                field.onChange(items.map((m, i) => (i === idx ? { ...m, url } : m)));
              const removeAt = (idx: number) => field.onChange(items.filter((_, i) => i !== idx));
              return (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-foreground">
                      {t('social.composer.media', { defaultValue: 'Media' })}
                    </span>
                    <div className="flex gap-2">
                      <input
                        ref={fileRef}
                        type="file"
                        accept="image/*,video/*"
                        multiple
                        hidden
                        onChange={(e) => uploadFiles(e.target.files, items, field.onChange)}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        loading={uploading}
                        disabled={items.length >= 10}
                        onClick={() => fileRef.current?.click()}
                      >
                        <Upload className="h-4 w-4" aria-hidden="true" />
                        {t('social.composer.uploadMedia', { defaultValue: 'Upload' })}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={items.length >= 10}
                        onClick={() => field.onChange([...items, { url: '' }])}
                      >
                        <Plus className="h-4 w-4" aria-hidden="true" />
                        {t('social.composer.addMedia', { defaultValue: 'Add URL' })}
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={items.length >= 10}
                        onClick={() => setAiOpen(true)}
                      >
                        <Sparkles className="h-4 w-4" aria-hidden="true" />
                        {t('social.composer.aiGenerate', { defaultValue: 'AI ile Üret' })}
                      </Button>
                    </div>
                  </div>
                  <AiGeneratePanel
                    open={aiOpen}
                    onOpenChange={setAiOpen}
                    onAdd={(media) => field.onChange([...(field.value ?? []), media])}
                  />
                  {items.length === 0 ? (
                    <p className="text-caption text-muted-foreground">
                      {t('social.composer.noMedia', {
                        defaultValue: 'No media. Upload up to 10 images/videos, or paste public URLs.',
                      })}
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {items.map((m, idx) => {
                        const Icon = isVideoItem(m) ? Film : ImageIcon;
                        return (
                          <div key={idx} className="flex items-start gap-2">
                            <div className="flex-1">
                              {m.key ? (
                                // Uploaded asset — read-only display.
                                <div className="flex items-center gap-2 rounded-md border border-border bg-surface-muted px-2.5 py-2">
                                  <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                                  <span className="text-sm text-foreground truncate" title={m.url}>
                                    {m.url.split('/').pop()}
                                  </span>
                                </div>
                              ) : (
                                <Field error={fieldErr((errors.media as any)?.[idx]?.url?.message)}>
                                  {({ id, describedBy, invalid }) => (
                                    <div className="relative flex items-center">
                                      <Icon
                                        className="absolute start-2.5 h-4 w-4 text-muted-foreground pointer-events-none"
                                        aria-hidden="true"
                                      />
                                      <Input
                                        id={id}
                                        aria-describedby={describedBy}
                                        aria-invalid={invalid}
                                        className="ps-8"
                                        placeholder="https://…"
                                        value={m.url}
                                        onChange={(e) => setUrlAt(idx, e.target.value)}
                                      />
                                    </div>
                                  )}
                                </Field>
                              )}
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
                        );
                      })}
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

          {/* Per-account format (Facebook / Instagram) */}
          {formatAccounts.length > 0 && (
            <Controller
              control={form.control}
              name="formats"
              render={({ field }) => (
                <div className="space-y-2">
                  <span className="text-sm font-medium text-foreground">
                    {t('social.composer.format', { defaultValue: 'Format' })}
                  </span>
                  <div className="space-y-1.5 rounded-lg border border-border p-2">
                    {formatAccounts.map((acc) => {
                      const meta = NETWORK_META[acc.network];
                      const Icon = meta.icon;
                      const value = (field.value?.[acc.id] as PostFormat) ?? 'FEED';
                      return (
                        <div key={acc.id} className="flex items-center gap-2">
                          <Icon className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                          <span className="text-sm text-foreground truncate">{acc.displayName}</span>
                          <select
                            className="ms-auto rounded-md border border-border bg-surface px-2 py-1 text-sm text-foreground"
                            value={value}
                            onChange={(e) =>
                              field.onChange({ ...(field.value ?? {}), [acc.id]: e.target.value })
                            }
                          >
                            {POST_FORMATS.map((f) => (
                              <option key={f} value={f}>
                                {t(`social.composer.format_${f}`, {
                                  defaultValue: f === 'FEED' ? 'Feed' : f === 'REEL' ? 'Reel' : 'Story',
                                })}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                  <p className="text-caption text-muted-foreground">
                    {t('social.composer.formatHint', {
                      defaultValue: 'Reels and Stories need a video (Stories also accept an image).',
                    })}
                  </p>
                </div>
              )}
            />
          )}

          {/* LinkedIn visibility (organic feed posts) */}
          {linkedinAccounts.length > 0 && (
            <div className="space-y-2">
              <label
                htmlFor="linkedin-visibility"
                className="text-sm font-medium text-foreground"
              >
                {t('social.composer.linkedinVisibility', { defaultValue: 'LinkedIn visibility' })}
              </label>
              <select
                id="linkedin-visibility"
                aria-label={t('social.composer.linkedinVisibility', {
                  defaultValue: 'LinkedIn visibility',
                })}
                className="block w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm text-foreground"
                value={linkedinVisibility}
                onChange={(e) => setLinkedinVisibility(e.target.value as LinkedinVisibility)}
              >
                {LINKEDIN_VISIBILITIES.map((v) => (
                  <option key={v} value={v}>
                    {t(`social.composer.linkedinVisibility_${v}`, {
                      defaultValue: v === 'PUBLIC' ? 'Anyone (public)' : 'Connections only',
                    })}
                  </option>
                ))}
              </select>
              <p className="text-caption text-muted-foreground">
                {t('social.composer.linkedinVisibilityHint', {
                  defaultValue: 'Controls who can see this post on LinkedIn.',
                })}
              </p>
            </div>
          )}

          {/* TikTok-specific controls — shown only when a TikTok account is selected */}
          {tiktokAccount && (
            <TiktokControls
              creatorInfo={creatorInfo ?? null}
              isLoading={creatorInfoLoading}
              value={tiktokOpts}
              onChange={setTiktokOpts}
              mediaUrls={(form.watch('media') ?? []).map((m) => m.url)}
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

      {/* Max video duration — informational, only when the cap is known */}
      {!isLoading && (creatorInfo?.maxVideoPostDurationSec ?? 0) > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="tiktok-max-duration">
          {t('social.composer.tiktok.maxDuration', { defaultValue: 'Max video length:' })}{' '}
          <span data-testid="tiktok-max-duration-value">{creatorInfo!.maxVideoPostDurationSec}s</span>{' '}
          {t('social.composer.tiktok.maxDurationContext', { defaultValue: 'for this account' })}
        </p>
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

interface AiGeneratePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (media: MediaItemValue) => void;
}

/**
 * Inline "Generate with AI" drawer for the composer: kicks off a generation,
 * polls until terminal (the composer is short-lived, so the wait is capped),
 * then drops the READY asset straight into the post's media list.
 */
function AiGeneratePanel({ open, onOpenChange, onAdd }: AiGeneratePanelProps) {
  const { t } = useTranslation('marketing');
  const [type, setType] = useState<GeneratedAssetType>('IMAGE');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async () => {
    const text = prompt.trim();
    if (!text) return;
    setBusy(true);
    try {
      const { assetId } = await generateMedia({ type, prompt: text });
      // Poll until terminal (composer is short-lived; cap the wait).
      for (let i = 0; i < 60; i += 1) {
        const a = await getGeneration(assetId);
        if (isTerminal(a.status)) {
          if (a.status === 'READY' && a.url) {
            onAdd({ url: a.url, key: a.r2Key ?? undefined, mime: a.mime ?? undefined });
            toast.success(t('social.composer.aiAdded', { defaultValue: 'Added to post' }));
            onOpenChange(false);
          } else {
            toast.error(t('social.composer.aiFailed', { defaultValue: 'Generation failed' }));
          }
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      toast.error(t('social.composer.aiTimeout', { defaultValue: 'Still generating — check the Studio' }));
    } catch {
      toast.error(t('social.composer.aiFailed', { defaultValue: 'Generation failed' }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-96 max-w-[90vw] space-y-4 p-6">
        <SheetTitle>{t('social.composer.aiTitle', { defaultValue: 'Generate with AI' })}</SheetTitle>
        <SheetDescription className="sr-only">
          {t('social.composer.aiTitle', { defaultValue: 'Generate with AI' })}
        </SheetDescription>
        <div className="flex gap-2">
          <Button type="button" variant={type === 'IMAGE' ? 'primary' : 'outline'} size="sm" onClick={() => setType('IMAGE')}>
            {t('social.composer.aiImage', { defaultValue: 'Image' })}
          </Button>
          <Button type="button" variant={type === 'VIDEO' ? 'primary' : 'outline'} size="sm" onClick={() => setType('VIDEO')}>
            {t('social.composer.aiVideo', { defaultValue: 'Video' })}
          </Button>
        </div>
        <Field label={t('social.composer.aiPrompt', { defaultValue: 'Prompt' })}>
          {({ id }) => (
            <Textarea
              id={id}
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('social.composer.aiPromptPlaceholder', { defaultValue: 'Describe the media…' })}
            />
          )}
        </Field>
        <Button type="button" onClick={run} loading={busy} disabled={!prompt.trim()}>
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          {t('social.composer.aiRun', { defaultValue: 'Generate' })}
        </Button>
      </SheetContent>
    </Sheet>
  );
}
