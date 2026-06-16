import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CornerDownRight,
  Phone,
  Voicemail,
  PhoneOff,
  Sparkles,
  ListTree,
  Hash,
} from 'lucide-react';
import { Badge } from '@/components/ui';
import { cn } from '@/components/ui/cn';
import { type IvrMenu, type IvrAction, ACTION_LABELS } from './schema';

const ACTION_ICON: Record<IvrAction, typeof Phone> = {
  SUBMENU: ListTree,
  DIAL: Phone,
  VOICEMAIL: Voicemail,
  HANGUP: PhoneOff,
  AI_RECEPTIONIST: Sparkles,
};

type BadgeTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

const ACTION_TONE: Record<IvrAction, BadgeTone> = {
  SUBMENU: 'primary',
  DIAL: 'info',
  VOICEMAIL: 'warning',
  HANGUP: 'neutral',
  AI_RECEPTIONIST: 'success',
};

interface MenuNodeProps {
  menu: IvrMenu;
  byId: Map<string, IvrMenu>;
  /** Ancestor menu ids on this path — guards against SUBMENU cycles. */
  ancestors: Set<string>;
  depth: number;
}

function MenuNode({ menu, byId, ancestors, depth }: MenuNodeProps) {
  const { t } = useTranslation('marketing');
  const nextAncestors = useMemo(() => new Set([...ancestors, menu.id]), [ancestors, menu.id]);

  return (
    <div className={cn(depth > 0 && 'ms-4 border-s border-border ps-3')}>
      <div className="flex items-center gap-2 py-1">
        <ListTree className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="text-sm font-medium text-foreground">{menu.name}</span>
        {menu.isRoot && (
          <Badge tone="primary" size="sm">
            {t('ivr.tree.root', { defaultValue: 'Root' })}
          </Badge>
        )}
        {!menu.enabled && (
          <Badge tone="neutral" size="sm">
            {t('ivr.tree.disabled', { defaultValue: 'Disabled' })}
          </Badge>
        )}
      </div>

      {menu.options.length === 0 ? (
        <p className="ms-6 py-0.5 text-xs text-muted-foreground">
          {t('ivr.tree.noOptions', { defaultValue: 'No options yet' })}
        </p>
      ) : (
        <ul className="ms-2 space-y-0.5">
          {menu.options.map((opt) => {
            const Icon = ACTION_ICON[opt.action] ?? Hash;
            const target = opt.action === 'SUBMENU' && opt.targetMenuId ? byId.get(opt.targetMenuId) : undefined;
            const isCycle = target ? nextAncestors.has(target.id) : false;
            return (
              <li key={opt.id}>
                <div className="flex items-center gap-2 py-0.5 text-sm">
                  <CornerDownRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  <Badge tone="neutral" size="sm">
                    <span className="font-mono">{opt.digit}</span>
                  </Badge>
                  <span className="text-foreground">{opt.label}</span>
                  <Badge tone={ACTION_TONE[opt.action] ?? 'neutral'} size="sm">
                    <Icon className="me-1 h-3 w-3" aria-hidden="true" />
                    {t(`ivr.actions.${opt.action}`, { defaultValue: ACTION_LABELS[opt.action] })}
                  </Badge>
                  {opt.action === 'DIAL' && opt.dialNumber && (
                    <span className="font-mono text-xs text-muted-foreground">{opt.dialNumber}</span>
                  )}
                </div>
                {/* Recurse into a submenu target, unless it would form a cycle. */}
                {target && !isCycle && (
                  <MenuNode menu={target} byId={byId} ancestors={nextAncestors} depth={depth + 1} />
                )}
                {target && isCycle && (
                  <p className="ms-6 text-xs text-warning">
                    {t('ivr.tree.cycle', {
                      defaultValue: '↳ {{name}} (already shown above)',
                      name: target.name,
                    })}
                  </p>
                )}
                {opt.action === 'SUBMENU' && !target && (
                  <p className="ms-6 text-xs text-danger">
                    {t('ivr.tree.missingTarget', { defaultValue: '↳ target menu not found' })}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface IvrTreeProps {
  menus: IvrMenu[];
}

/**
 * Visualise the phone tree. Starts from the enabled root menu (the one inbound
 * calls hit) and walks each SUBMENU edge. Menus not reachable from the root are
 * listed afterwards as "orphan" trees so nothing is hidden.
 */
export function IvrTree({ menus }: IvrTreeProps) {
  const { t } = useTranslation('marketing');
  const byId = useMemo(() => new Map(menus.map((m) => [m.id, m])), [menus]);

  const root = useMemo(
    () => menus.find((m) => m.isRoot && m.enabled) ?? menus.find((m) => m.isRoot),
    [menus],
  );

  // Menus reachable from the root via SUBMENU edges — the rest are orphans.
  const reachable = useMemo(() => {
    const seen = new Set<string>();
    const walk = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const m = byId.get(id);
      if (!m) return;
      for (const o of m.options) {
        if (o.action === 'SUBMENU' && o.targetMenuId) walk(o.targetMenuId);
      }
    };
    if (root) walk(root.id);
    return seen;
  }, [root, byId]);

  const orphans = useMemo(() => menus.filter((m) => !reachable.has(m.id)), [menus, reachable]);

  if (menus.length === 0) return null;

  return (
    <div className="space-y-3">
      {root ? (
        <MenuNode menu={root} byId={byId} ancestors={new Set()} depth={0} />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t('ivr.tree.noRoot', {
            defaultValue: 'No root menu set — inbound calls fall through to the AI receptionist.',
          })}
        </p>
      )}

      {orphans.length > 0 && (
        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t('ivr.tree.unlinked', { defaultValue: 'Not linked from root' })}
          </p>
          {orphans.map((m) => (
            <MenuNode key={m.id} menu={m} byId={byId} ancestors={new Set()} depth={0} />
          ))}
        </div>
      )}
    </div>
  );
}
