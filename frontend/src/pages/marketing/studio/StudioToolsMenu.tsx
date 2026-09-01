import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronDown, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';

/**
 * The way out of the one screen — and the reason it is allowed to be one screen.
 *
 * Collapsing Growth Studio meant taking away a "Manual tools" button that opened
 * a five-tab surface. Several of those tabs host genuine full pages (blast
 * campaigns, the social planner's table, the trends browser) that do not fit in
 * a panel or a drawer, and none of them has a menu entry of its own. So the
 * screen owes them a door, and that door has to be PERMANENT: an affordance that
 * appears only when some other panel's query happens to have resolved is not a
 * door, it is a coincidence.
 *
 * That is why this is its own component mounted directly by the screen rather
 * than a menu inside the tools drawer. It renders from nothing but the router —
 * no query, no entitlement, no role — so a failed poll, a loading skeleton or a
 * workspace that never set up a budget cannot make seven destinations vanish.
 *
 * The first three entries open the drawer through the URL (`?tool=`), which is
 * also what gives those drawer branches an entry point at all; the last is the
 * legacy full-page surface, whose own tabs carry the rest.
 */

/** Drawer tools, opened by writing `?tool=` — see StudioOneScreen. */
const TOOL_LINKS = [
  { to: '/studio?tool=calendar', key: 'studio.toolsMenu.calendar', label: 'İçerik takvimi' },
  { to: '/studio?tool=create', key: 'studio.toolsMenu.create', label: 'AI stüdyo' },
  { to: '/studio?tool=connections', key: 'studio.toolsMenu.connections', label: 'Bağlı hesaplar' },
] as const;

export function StudioToolsMenu({ className }: { className?: string }) {
  const { t } = useTranslation('marketing');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="secondary" size="sm" className={className}>
          <Wrench className="h-4 w-4" aria-hidden="true" />
          {t('studio.toolsMenu.trigger', 'Araçlar')}
          <ChevronDown className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {TOOL_LINKS.map((l) => (
          <DropdownMenuItem key={l.to} asChild>
            <Link to={l.to}>{t(l.key, l.label)}</Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {/*
          The full-page surface. Kept as ONE entry rather than exploded into its
          seven tabs: those are destinations you go to deliberately and rarely,
          and listing them all here would rebuild, in a dropdown, exactly the
          inventory this screen exists to replace.
        */}
        <DropdownMenuItem asChild>
          <Link to="/studio?view=tools">{t('studio.toolsMenu.all', 'Tüm araçlar')}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
