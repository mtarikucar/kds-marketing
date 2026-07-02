import { useEffect, useMemo, useRef, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui';
import { useCommandPaletteStore } from '../../../store/commandPaletteStore';
import { useNavCommands } from '../hooks/useNavCommands';
import { QUICK_ACTIONS } from '../quickActions';

interface PaletteOption {
  key: string;
  label: string;
  /** Secondary label (owning hub, or the "Create" tag for quick actions). */
  hint: string | null;
  icon?: LucideIcon;
  to: string;
}

/**
 * Global command palette (Cmd/Ctrl+K). A keyboard-first escape hatch over the
 * whole console: type a page or action name and jump to it, instead of hunting
 * through the hub nav. Destinations come from the SAME role/plan/agency-gated
 * navigation the sidebar renders (via useNavCommands), so it never routes a
 * user somewhere they can't go. Built on the Radix dialog primitive (no extra
 * dependency); the open-state lives in a tiny store so the header search button
 * and the global key listener both drive it.
 */
export default function CommandPalette() {
  const { t } = useTranslation('marketing');
  const navigate = useNavigate();
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);
  const navCommands = useNavCommands();

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const q = query.trim().toLowerCase();

  const actionOptions = useMemo<PaletteOption[]>(
    () =>
      QUICK_ACTIONS.map((a) => ({
        key: `action:${a.id}`,
        label: t(a.labelKey, a.label),
        hint: t('commandPalette.actionHint', 'Create'),
        icon: a.icon,
        to: a.to,
      })).filter((o) => !q || o.label.toLowerCase().includes(q)),
    [q, t],
  );

  const navOptions = useMemo<PaletteOption[]>(
    () =>
      navCommands
        .map((c) => ({
          key: `nav:${c.path}`,
          label: c.label,
          hint: c.hubLabel,
          icon: c.icon,
          to: c.path,
        }))
        .filter(
          (o) =>
            !q ||
            o.label.toLowerCase().includes(q) ||
            (o.hint ? o.hint.toLowerCase().includes(q) : false),
        ),
    [q, navCommands],
  );

  const options = useMemo(
    () => [...actionOptions, ...navOptions],
    [actionOptions, navOptions],
  );

  // Fresh query + selection each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  // Any filter change re-anchors the selection to the top of the new list.
  useEffect(() => {
    setActive(0);
  }, [q]);

  // Keep the highlighted row visible as the user arrows through.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const select = (opt?: PaletteOption) => {
    if (!opt) return;
    setOpen(false);
    navigate(opt.to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      select(options[active]);
    }
  };

  const renderOption = (opt: PaletteOption, index: number) => {
    const Icon = opt.icon;
    const isActive = index === active;
    return (
      <button
        key={opt.key}
        type="button"
        role="option"
        id={`cmdk-opt-${index}`}
        data-index={index}
        aria-selected={isActive}
        onMouseEnter={() => setActive(index)}
        onClick={() => select(opt)}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-start text-sm transition-colors',
          isActive ? 'bg-primary/10' : 'hover:bg-surface-muted',
        )}
      >
        {Icon && (
          <Icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-primary' : 'text-muted-foreground')} />
        )}
        <span className="flex-1 truncate text-foreground">{opt.label}</span>
        {opt.hint && <span className="shrink-0 truncate text-xs text-muted-foreground">{opt.hint}</span>}
      </button>
    );
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          onKeyDown={onKeyDown}
          className={cn(
            'fixed left-1/2 top-[12vh] z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden',
            'rounded-xl border border-border bg-surface-raised shadow-xl',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          )}
        >
          <DialogPrimitive.Title className="sr-only">
            {t('commandPalette.title', 'Command menu')}
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            {t('commandPalette.description', 'Search for a page or a quick action')}
          </DialogPrimitive.Description>

          <div className="flex items-center gap-2 border-b border-border px-4">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('commandPalette.placeholder', 'Search pages and actions…')}
              role="combobox"
              aria-expanded
              aria-controls="cmdk-list"
              aria-activedescendant={options[active] ? `cmdk-opt-${active}` : undefined}
              className="h-12 w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div id="cmdk-list" role="listbox" ref={listRef} className="max-h-[60vh] overflow-y-auto p-2">
            {options.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">
                {t('commandPalette.empty', 'No results')}
              </p>
            ) : (
              <>
                {actionOptions.length > 0 && (
                  <div role="group" aria-label={t('commandPalette.quickActions', 'Quick actions')}>
                    <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                      {t('commandPalette.quickActions', 'Quick actions')}
                    </p>
                    {actionOptions.map((opt, i) => renderOption(opt, i))}
                  </div>
                )}
                {navOptions.length > 0 && (
                  <div role="group" aria-label={t('commandPalette.goTo', 'Go to')}>
                    <p className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
                      {t('commandPalette.goTo', 'Go to')}
                    </p>
                    {navOptions.map((opt, i) => renderOption(opt, actionOptions.length + i))}
                  </div>
                )}
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
