import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FolderOpen, Link2, Upload, X } from 'lucide-react';
import {
  Button, IconButton, Input, Spinner, EmptyState,
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui';
import {
  listGenerations, uploadSourceMedia, type GeneratedAsset, type GeneratedAssetType,
} from '../../../features/marketing/api/media.service';

/** What the planner's upload endpoint will actually take, per media type. An
 *  audio file is not in that list — see `uploadSourceMedia` — so the AUDIO slot
 *  offers the library and a link instead of an upload button that would 400. */
const UPLOAD_ACCEPT: Partial<Record<GeneratedAssetType, string>> = {
  IMAGE: 'image/png,image/jpeg,image/webp,image/gif',
  VIDEO: 'video/mp4,video/quicktime,video/webm',
};

/** A link the backend DTO will accept (@IsUrl). Rejecting it here keeps a typo
 *  from being spent as a 400 after the user has already picked everything else. */
function isUsableUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface MediaSourcePickerProps {
  /** The slot's plain-language name; also the group's accessible name. */
  label: string;
  hint?: string;
  mediaType: GeneratedAssetType;
  required?: boolean;
  /** Array slots (`image_urls`) take several; every other slot takes exactly one. */
  multiple?: boolean;
  maxCount?: number;
  value: string[];
  onChange: (urls: string[]) => void;
  disabled?: boolean;
}

/**
 * Source media for the techniques that transform something that already exists.
 *
 * Three ways in, in the order they are actually used: something this workspace
 * already generated, a file from the machine, or a link. The library path is
 * first because the studio's own output is the most common input — a voiceover
 * generated here is what a lip-sync is driven by.
 */
export function MediaSourcePicker({
  label, hint, mediaType, required, multiple, maxCount = 1, value, onChange,
  disabled,
}: MediaSourcePickerProps) {
  const { t } = useTranslation('marketing');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [link, setLink] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const cap = multiple ? maxCount : 1;
  const full = value.length >= cap;

  // Same query key shape as the page's library list, so picking a source reuses
  // whatever is already cached for that type instead of a second round trip.
  const library = useQuery({
    queryKey: ['marketing', 'aiStudio', 'generations', mediaType],
    queryFn: () => listGenerations({ type: mediaType }),
    enabled: libraryOpen,
  });
  const usable = (library.data ?? []).filter((a) => a.status === 'READY' && a.url);

  const add = (url: string) => {
    // A single-value slot REPLACES rather than appends: picking a second image
    // for "opening frame" plainly means "no, that one".
    onChange(multiple ? [...value, url].slice(0, cap) : [url]);
  };

  const pickFromLibrary = (a: GeneratedAsset) => {
    add(a.url!);
    if (!multiple) setLibraryOpen(false);
  };

  const addLink = () => {
    const raw = link.trim();
    if (!isUsableUrl(raw)) {
      toast.error(t('aiStudio.source.badLink', 'That does not look like a link'));
      return;
    }
    add(raw);
    setLink('');
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try {
      const up = await uploadSourceMedia(file);
      add(up.url);
    } catch (e: any) {
      toast.error(e?.response?.data?.message ?? t('aiStudio.source.uploadFailed', 'Upload failed'));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const accept = UPLOAD_ACCEPT[mediaType];

  return (
    <fieldset className="rounded-lg border border-border p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-medium text-foreground">
        {label}
        {required && <span className="ms-0.5 text-danger" aria-hidden="true">*</span>}
      </legend>
      {hint && <p className="mb-2 text-caption text-muted-foreground">{hint}</p>}

      {value.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-2">
          {value.map((url, i) => (
            <li key={`${url}-${i}`} className="relative">
              <SourceThumb url={url} mediaType={mediaType} />
              <IconButton
                size="sm"
                variant="ghost"
                className="absolute -end-2 -top-2 bg-surface-raised"
                aria-label={t('aiStudio.source.remove', 'Remove')}
                onClick={() => onChange(value.filter((_, j) => j !== i))}
              >
                <X className="h-3 w-3" aria-hidden="true" />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={full} onClick={() => setLibraryOpen(true)}>
          <FolderOpen className="h-4 w-4" aria-hidden="true" />
          {t('aiStudio.source.fromLibrary', 'From library')}
        </Button>

        {accept && (
          <>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={full}
              loading={uploading}
              onClick={() => fileRef.current?.click()}
            >
              <Upload className="h-4 w-4" aria-hidden="true" />
              {t('aiStudio.source.upload', 'Upload')}
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept={accept}
              className="hidden"
              aria-hidden="true"
              tabIndex={-1}
              onChange={(e) => void upload(e.target.files?.[0])}
            />
          </>
        )}

        <div className="flex min-w-[14rem] flex-1 items-center gap-1">
          <Input
            value={link}
            disabled={full}
            aria-label={t('aiStudio.source.link', 'Paste a link')}
            placeholder="https://…"
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              // Enter inside a panel that has its own Generate button must add the
              // link, not submit the panel.
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (!full && link.trim()) addLink();
            }}
          />
          <IconButton
            type="button"
            size="sm"
            variant="ghost"
            disabled={full || !link.trim()}
            aria-label={t('aiStudio.source.addLink', 'Add link')}
            onClick={addLink}
          >
            <Link2 className="h-4 w-4" aria-hidden="true" />
          </IconButton>
        </div>
      </div>

      <Dialog open={libraryOpen} onOpenChange={setLibraryOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('aiStudio.source.libraryTitle', 'Pick from your library')}</DialogTitle>
            <DialogDescription>
              {t('aiStudio.source.libraryDesc', 'Everything this workspace has already generated.')}
            </DialogDescription>
          </DialogHeader>
          {library.isLoading ? (
            <Spinner />
          ) : usable.length === 0 ? (
            <EmptyState
              title={t('aiStudio.source.libraryEmpty.title', 'Nothing to pick yet')}
              description={t(
                'aiStudio.source.libraryEmpty.desc',
                'Generate something of this kind first, or upload a file.',
              )}
            />
          ) : (
            <ul className="grid max-h-[50vh] grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-4">
              {usable.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    className="w-full rounded-lg border border-border p-1 text-start hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    onClick={() => pickFromLibrary(a)}
                  >
                    <SourceThumb url={a.url!} mediaType={a.type} />
                    <span className="line-clamp-2 px-1 text-caption text-muted-foreground">
                      {a.prompt}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </fieldset>
  );
}

/** An audio source has no frame to show, so it gets a player — an <img> pointed
 *  at an mp3 is a broken-image icon. */
function SourceThumb({ url, mediaType }: { url: string; mediaType: GeneratedAssetType }) {
  if (mediaType === 'AUDIO') {
    return <audio src={url} controls className="h-10 w-40" data-testid="source-audio" />;
  }
  if (mediaType === 'VIDEO') {
    return <video src={url} className="h-16 w-16 rounded-md object-cover" muted data-testid="source-video" />;
  }
  return <img src={url} alt="" className="h-16 w-16 rounded-md object-cover" data-testid="source-image" />;
}
