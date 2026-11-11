import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { createKey } from '@/api/apiKeys';
import type { KeyOut, Permission } from '@/api/types';
import { CopyField } from '@/components/CopyField';
import { ErrorCallout } from '@/components/ErrorCallout';
import { PermissionPicker } from '@/components/PermissionPicker';
import {
  Button,
  Callout,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
} from '@/components/ui';

/** Every API key list query key starts with this. */
export const KEYS_KEY = ['api-keys'] as const;

/**
 * Issues a key, holding its plaintext only in this hook's state: never in the query cache (no
 * mutation keeps the result), so it lives as long as the one-time dialog that shows it, and
 * `reset` (the dialog closing) drops it. A second `create` while one runs is ignored. The answer
 * to a request made before the last `reset`, or after the component is gone, is dropped: the
 * dialogs stay mounted while closed, and a key issued after its dialog was closed must not show
 * the next time it opens. Such a key exists all the same, so the key list is read again after
 * every answer, and the key can be revoked there.
 */
export function useCreateKey() {
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<KeyOut | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mounted = useRef(false);
  /** Counts requests and resets: an answer whose number is no longer the last one is dropped. */
  const latest = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  async function create(input: { name: string; scopes: Permission[] }) {
    if (creating) return;
    const request = ++latest.current;
    const current = () => mounted.current && latest.current === request;
    setCreating(true); setError(null);
    try {
      const key = await createKey(input);
      void queryClient.invalidateQueries({ queryKey: KEYS_KEY });
      if (current()) setCreated(key);
    } catch (e) { if (current()) setError(e); }
    finally { if (current()) setCreating(false); }
  }
  const reset = () => {
    latest.current += 1;
    setCreated(null);
    setError(null);
    setCreating(false);
  };
  return { created, creating, error, create, reset };
}

/**
 * Connecting an agent is issuing its key: the dialog names the agent, narrows what it may do, and
 * then shows the key's plaintext exactly once ({@link useCreateKey}) with the ready command; the
 * plaintext is dropped when the dialog closes. While it is shown, only the explicit Close button
 * closes the dialog: not Escape, not a click outside, so the key is not lost by accident.
 */
export function ConnectAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Permission[]>([]);
  const { created, creating, error: createError, create, reset } = useCreateKey();

  const close = (next: boolean) => {
    if (!next) {
      setName('');
      setScopes([]);
      reset();
    }
    onOpenChange(next);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void create({ name: name.trim(), scopes });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent dismissible={created == null}>
        <DialogHeader>
          <DialogTitle>{created ? t('apiKeys.dialog.plaintextTitle') : t('agents.dialog.title')}</DialogTitle>
          <DialogDescription>{created ? t('apiKeys.dialog.plaintextDescription') : t('agents.dialog.description')}</DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="flex flex-col gap-4">
            <Callout tone="warning" title={t('apiKeys.dialog.plaintextTitle')}>
              {t('apiKeys.dialog.plaintextWarning')}
            </Callout>
            <CopyField label={t('apiKeys.dialog.plaintextTitle')} value={created.plaintext} />
            <ConnectAgent plaintext={created.plaintext} />
            <DialogFooter>
              <Button onClick={() => close(false)}>{t('common.close')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            <ErrorCallout error={createError} />
            <Field label={t('agents.dialog.name')} hint={t('agents.dialog.nameHint')} required>
              {(ids) => (
                <Input id={ids.id} required autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} />
              )}
            </Field>
            <PermissionPicker
              legend={t('agents.dialog.permissions')}
              hint={t('apiKeys.dialog.scopesHint')}
              value={scopes}
              onChange={setScopes}
            />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" loading={creating}>
                {t('agents.dialog.submit')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** This deployment's MCP endpoint: the panel, its API and /mcp share one origin. */
function mcpUrl(): string {
  return `${window.location.origin}/mcp`;
}

/**
 * How an agent reaches this workspace: the endpoint, and with a fresh key the ready-to-paste
 * Claude Code command. The plaintext appears only while its one-time dialog is open; without it
 * the text says how to get a key (`missingKey` for a key that exists but is no longer shown).
 */
export function ConnectAgent({ plaintext, showTitle = true, missingKey }: { plaintext?: string; showTitle?: boolean; missingKey?: string }) {
  const { t } = useTranslation();
  const url = mcpUrl();
  return (
    <div className="flex flex-col gap-2 text-sm">
      {showTitle && <p className="font-medium text-foreground">{t('apiKeys.connect.title')}</p>}
      <CopyField label={t('apiKeys.connect.url')} value={url} />
      {plaintext ? (
        <>
          <p className="text-muted-foreground">{t('apiKeys.connect.claudeCode')}</p>
          <CopyField
            label={t('apiKeys.connect.command')}
            value={`claude mcp add --transport http jeeta ${url} --header "Authorization: Bearer ${plaintext}"`}
          />
        </>
      ) : (
        <p className="text-muted-foreground">{missingKey ?? t('apiKeys.connect.needKey')}</p>
      )}
      <p className="text-caption text-muted-foreground">{t('apiKeys.connect.otherClients')}</p>
    </div>
  );
}
