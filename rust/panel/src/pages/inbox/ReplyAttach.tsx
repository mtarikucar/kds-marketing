import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ImagePlus, X } from 'lucide-react';
import * as m from '@/api/materials';
import type { Material } from '@/api/materials';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconButton,
} from '@/components/ui';

/** The image a reply carries: a file from the computer (uploaded on send) or a library material. */
export type ReplyImage =
  | { kind: 'file'; file: File; preview: string }
  | { kind: 'material'; material: Material };

/** The types WhatsApp sends as images, and the largest one the server takes. */
const TYPES = ['image/jpeg', 'image/png'];
const MAX_BYTES = 5 * 1024 * 1024;

/** A library material the server would send: live, shared, a JPEG or PNG. */
const sendable = (x: Material) =>
  !x.erased_at && TYPES.includes(x.mime) && !!x.share && x.share.permission !== 'not_shareable';

/**
 * The reply box's one attach control: an image from the computer, or one of the library's
 * materials. Shows the chosen image small, with a way to drop it.
 */
export function ReplyAttach({
  value,
  onChange,
  disabled,
}: {
  value: ReplyImage | null;
  onChange: (image: ReplyImage | null) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [library, setLibrary] = useState(false);
  const [tooBig, setTooBig] = useState(false);
  return (
    <div className="flex items-center gap-2">
      <input
        ref={input}
        type="file"
        accept={TYPES.join(',')}
        className="hidden"
        data-testid="reply-image-file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          const fits = TYPES.includes(file.type) && file.size <= MAX_BYTES;
          setTooBig(!fits);
          if (fits) onChange({ kind: 'file', file, preview: URL.createObjectURL(file) });
        }}
      />
      {value ? (
        <span className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-1.5 py-1">
          {value.kind === 'file' ? (
            <img src={value.preview} alt={t('inbox.media.attached')} className="h-10 w-10 rounded object-cover" />
          ) : (
            <MaterialThumb material={value.material} className="h-10 w-10" />
          )}
          <IconButton
            type="button"
            size="sm"
            variant="ghost"
            aria-label={t('inbox.media.remove')}
            onClick={() => onChange(null)}
            disabled={disabled}
          >
            <X className="h-4 w-4" />
          </IconButton>
        </span>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton type="button" size="sm" variant="ghost" aria-label={t('inbox.media.attach')} disabled={disabled}>
              <ImagePlus className="h-4 w-4" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => input.current?.click()}>{t('inbox.media.fromComputer')}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setLibrary(true)}>{t('inbox.media.fromLibrary')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {tooBig && <span className="text-xs text-danger">{t('inbox.media.refused.image_too_large')}</span>}
      <Dialog open={library} onOpenChange={setLibrary}>
        <DialogContent className="max-w-2xl">
          <DialogTitle>{t('inbox.media.fromLibrary')}</DialogTitle>
          {library && (
            <LibraryPicker
              onPick={(material) => {
                onChange({ kind: 'material', material });
                setLibrary(false);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function LibraryPicker({ onPick }: { onPick: (material: Material) => void }) {
  const { t } = useTranslation();
  const list = useQuery({ queryKey: ['inbox-attach-materials'], queryFn: () => m.materialsList() });
  const items = (list.data ?? []).filter(sendable).slice(0, 60);
  if (list.isPending) return <p className="text-sm text-muted-foreground">…</p>;
  if (!items.length) return <p className="text-sm text-muted-foreground">{t('inbox.media.noMaterials')}</p>;
  return (
    <ul className="grid max-h-[60dvh] grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-4">
      {items.map((x) => (
        <li key={x.id}>
          <button
            type="button"
            onClick={() => onPick(x)}
            aria-label={x.title || t('inbox.media.photo')}
            className="block w-full overflow-hidden rounded-md border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <MaterialThumb material={x} className="h-24 w-full" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function MaterialThumb({ material, className }: { material: Material; className: string }) {
  const { t } = useTranslation();
  const preview = useQuery({
    queryKey: ['inbox-attach-preview', material.id],
    queryFn: () => m.materialPreview(material.id),
    staleTime: 5 * 60_000,
    retry: false,
  });
  return preview.data?.url ? (
    <img src={preview.data.url} alt={material.title || t('inbox.media.photo')} className={`${className} rounded object-cover`} />
  ) : (
    <span className={`${className} block rounded bg-surface-muted`} aria-hidden="true" />
  );
}
