import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createKey } from '@/api/apiKeys';
import { PERMISSIONS, type KeyOut, type Permission } from '@/api/types';
import { useSession } from '@/auth/useSession';
import { CopyField } from '@/components/CopyField';
import { ErrorCallout } from '@/components/ErrorCallout';
import { PermissionPicker } from '@/components/PermissionPicker';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  cn,
} from '@/components/ui';
import { currentMembership } from '@/lib/roles';
import { useAgentCopy, type AgentCopyKey } from './copy';

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


/** The longest key name the server takes (`jt_app::usecases::api_keys::NAME_MAX`). */
const NAME_MAX = 64;

type Preset = { id: string; label: AgentCopyKey; permissions: Permission[] | 'all' };

/** What an agent may be connected to do, as a few plain choices; each also reads the workspace. */
export const PRESETS: Preset[] = [
  { id: 'content', label: 'presetContent', permissions: ['content.work', 'materials.work'] },
  { id: 'social', label: 'presetSocial', permissions: ['social.work'] },
  { id: 'research', label: 'presetResearch', permissions: ['prospects.work'] },
  { id: 'inbox', label: 'presetInbox', permissions: ['inbox.work'] },
  { id: 'ads', label: 'presetAds', permissions: ['ads.work'] },
  { id: 'all', label: 'presetAll', permissions: 'all' },
];
/** Every preset gives this too: an agent checks in and reads the strategy with it. */
const BASE: Permission[] = ['workspace.read'];

const ordered = (set: Set<Permission>) => PERMISSIONS.filter((p) => set.has(p));

/**
 * Connecting an agent is issuing its key: a name and what it will do (a few presets, which add
 * up; the exact permissions behind "Ayrıntı", where every permission can be chosen), then the
 * key's plaintext exactly once ({@link useCreateKey}) with where it goes. While the key is shown
 * only the explicit Close button closes the dialog: not Escape, not a click outside.
 */
export function ConnectAgentDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const copy = useAgentCopy();
  const session = useSession();
  const held = new Set(currentMembership(session.data)?.permissions ?? []);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Permission[]>([]);
  const [problem, setProblem] = useState<{ name?: boolean; scopes?: boolean }>({});
  const { created, creating, error: createError, create, reset } = useCreateKey();

  const close = (next: boolean) => {
    if (!next) {
      setName('');
      setScopes([]);
      setProblem({});
      reset();
    }
    onOpenChange(next);
  };

  const presetPermissions = (preset: Preset): Permission[] =>
    preset.permissions === 'all' ? PERMISSIONS.filter((p) => held.has(p)) : preset.permissions;
  const isOn = (preset: Preset) => {
    const perms = presetPermissions(preset);
    return perms.length > 0 && perms.every((p) => scopes.includes(p));
  };
  const toggle = (preset: Preset) => {
    const perms = presetPermissions(preset);
    const next = new Set(scopes);
    if (isOn(preset)) {
      if (preset.permissions === 'all') next.clear();
      for (const p of perms) next.delete(p);
      // The base goes with the last work it was given for.
      if (![...next].some((p) => !BASE.includes(p))) next.clear();
    } else {
      for (const p of [...BASE, ...perms]) if (held.has(p)) next.add(p);
    }
    setScopes(ordered(next));
    setProblem((v) => ({ ...v, scopes: false }));
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    const found = { name: !trimmed || trimmed.length > NAME_MAX, scopes: scopes.length === 0 };
    setProblem(found);
    if (found.name || found.scopes) return;
    void create({ name: trimmed, scopes });
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent dismissible={created == null}>
        <DialogHeader>
          <DialogTitle>{created ? copy('readyTitle', { name: created.name }) : copy('dialogTitle')}</DialogTitle>
          <DialogDescription>{created ? copy('readyBody') : copy('dialogDescription')}</DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="flex min-w-0 flex-col gap-3">
            <CopyField label={copy('keyLabel')} value={created.plaintext} />
            <ConnectAgent plaintext={created.plaintext} />
            <DialogFooter>
              <Button onClick={() => close(false)}>{copy('close')}</Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="flex min-w-0 flex-col gap-4" onSubmit={onSubmit} noValidate autoComplete="off">
            <ErrorCallout error={createError} />
            <Field label={copy('name')} error={problem.name ? copy('eName') : undefined}>
              {(ids) => (
                <Input
                  id={ids.id}
                  aria-describedby={ids.describedBy}
                  aria-invalid={ids.invalid || undefined}
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  maxLength={NAME_MAX}
                  placeholder={copy('namePlaceholder')}
                  value={name}
                  onChange={(e) => { setName(e.target.value); setProblem((v) => ({ ...v, name: false })); }}
                />
              )}
            </Field>
            <fieldset className="flex min-w-0 flex-col gap-2" aria-describedby={problem.scopes ? 'connect-scopes-error' : undefined}>
              <legend className="mb-1 text-sm font-medium text-foreground">{copy('doesLegend')}</legend>
              <div className="flex flex-wrap gap-1.5">
                {PRESETS.map((preset) => {
                  const perms = presetPermissions(preset);
                  const allowed = perms.length > 0 && perms.every((p) => held.has(p));
                  const on = isOn(preset);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      aria-pressed={on}
                      disabled={!allowed}
                      title={allowed ? undefined : copy('presetNotHeld')}
                      onClick={() => toggle(preset)}
                      className={cn(
                        'rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
                        on ? 'border-primary bg-primary-50 font-medium text-foreground dark:bg-primary-950/60' : 'border-border text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {copy(preset.label)}
                    </button>
                  );
                })}
              </div>
              {problem.scopes && <p id="connect-scopes-error" role="alert" className="text-caption text-danger">{copy('eScopes')}</p>}
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{copy('details', { n: scopes.length })}</summary>
                <div className="mt-2">
                  <PermissionPicker legend={copy('permissions')} value={scopes} onChange={(next) => { setScopes(next); setProblem((v) => ({ ...v, scopes: false })); }} />
                </div>
              </details>
            </fieldset>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>{copy('cancel')}</Button>
              <Button type="submit" loading={creating}>{copy('submit')}</Button>
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
 * How an agent reaches this workspace: with a fresh key the ready Claude Code command, and the
 * endpoint for another client folded under it. The plaintext appears only while its one-time
 * dialog is open; without it, the endpoint and `missingKey`, how to get a key.
 */
export function ConnectAgent({ plaintext, missingKey }: { plaintext?: string; missingKey?: string }) {
  const copy = useAgentCopy();
  const url = mcpUrl();
  const other = (
    <>
      <CopyField label={copy('mcpUrl')} value={url} />
      <p className="text-caption text-muted-foreground">{copy('otherClients')}</p>
    </>
  );
  return (
    <div className="flex min-w-0 flex-col gap-2 text-sm">
      {plaintext ? (
        <>
          <p className="text-muted-foreground">{copy('claudeCode')}</p>
          <CopyField label={copy('command')} value={`claude mcp add --transport http jeeta ${url} --header "Authorization: Bearer ${plaintext}"`} />
          <details>
            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">{copy('otherClient')}</summary>
            <div className="mt-2 flex flex-col gap-2">{other}</div>
          </details>
        </>
      ) : (
        <>
          {other}
          {missingKey && <p className="text-muted-foreground">{missingKey}</p>}
        </>
      )}
    </div>
  );
}
