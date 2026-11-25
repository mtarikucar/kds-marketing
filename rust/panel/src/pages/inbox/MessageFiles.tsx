import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { FileText, ImageOff } from 'lucide-react';
import * as api from '@/api/inbox';
import type { InboxAttachment, InboxMessage } from '@/api/types';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui';

/** The stored text of a chat image or document: its marker line, then the caption. */
const MARKER = /^\[(image|document)[^\]\n]*\]\n?/;

/**
 * A message's text as the thread shows it: an image's or a document's marker line is left out
 * when the file itself is shown below it.
 */
export function shownBody(message: InboxMessage): string {
  if (!message.attachments?.length) return message.body;
  return message.body.replace(MARKER, '');
}

/** Whether the file is there to open. */
const kept = (file: InboxAttachment) =>
  file.file_id !== null && (file.state === 'stored' || file.state === 'attached' || file.state === 'staged');

/**
 * The files a message carries, at its place in the thread: an image small (it opens larger on
 * click), anything else as its name to download, and a file that is not there as a plain line
 * saying why. Each address is asked for when it is shown and lives a few minutes.
 */
export function MessageFiles({ message }: { message: InboxMessage }) {
  const files = message.attachments ?? [];
  if (!files.length) return null;
  return (
    <div className="my-1.5 flex flex-wrap gap-2">
      {files.map((file) =>
        !kept(file) ? (
          <Unavailable key={file.index} file={file} />
        ) : file.kind === 'image' ? (
          <Photo key={file.index} messageId={message.id} file={file} />
        ) : (
          <Download key={file.index} messageId={message.id} file={file} />
        ),
      )}
    </div>
  );
}

function Photo({ messageId, file }: { messageId: string; file: InboxAttachment }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  const media = useQuery({
    queryKey: ['inbox-media', messageId, file.index],
    queryFn: () => api.messageMedia(messageId, file.index),
    // The address lives ten minutes: asked again before it ends.
    staleTime: 5 * 60_000,
    gcTime: 8 * 60_000,
    retry: false,
  });
  const url = media.data?.url;
  if (media.isError || broken) return <Unavailable file={file} />;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={!url}
        aria-label={t('inbox.media.enlarge')}
        className="block overflow-hidden rounded-md border border-border bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {url ? (
          <img
            src={url}
            alt={t('inbox.media.photo')}
            width={file.width ?? undefined}
            height={file.height ?? undefined}
            onError={() => setBroken(true)}
            className="h-32 w-auto max-w-[12rem] object-cover"
          />
        ) : (
          <span className="block h-32 w-32" aria-hidden="true" />
        )}
      </button>
      {url && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-3xl">
            <DialogTitle className="sr-only">{t('inbox.media.photo')}</DialogTitle>
            <img src={url} alt={t('inbox.media.photo')} className="max-h-[80dvh] w-full rounded-md object-contain" />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function Download({ messageId, file }: { messageId: string; file: InboxAttachment }) {
  const { t } = useTranslation();
  const name = file.filename || t('inbox.media.file');
  // Asked for on click only: the address is a download of its own, served as one.
  const open = useMutation({
    mutationFn: () => api.messageMedia(messageId, file.index),
    onSuccess: (out) => {
      if (out.url) window.location.assign(out.url);
    },
  });
  if (open.isError) return <Unavailable file={file} />;
  return (
    <button
      type="button"
      onClick={() => open.mutate()}
      disabled={open.isPending}
      aria-label={t('inbox.media.download', { name })}
      className="flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs hover:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate">{name}</span>
    </button>
  );
}

function Unavailable({ file }: { file: InboxAttachment }) {
  const { t } = useTranslation();
  const why =
    file.state === 'pending'
      ? t('inbox.media.pending')
      : t(`inbox.media.reason.${file.reason ?? 'unavailable'}`, { defaultValue: t('inbox.media.unavailable') });
  return (
    <span className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0" aria-hidden="true" />
      {file.filename ? `${file.filename} · ${why}` : why}
    </span>
  );
}
