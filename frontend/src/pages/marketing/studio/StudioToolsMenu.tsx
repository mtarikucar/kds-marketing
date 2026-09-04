import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { ChevronDown, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { hasMarketingRole, MarketingRole } from '@/features/marketing/types';
import { useMarketingAuthStore } from '@/store/marketingAuthStore';

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
 * than a menu inside the tools drawer. It renders from the router and from the
 * signed-in ROLE — no query, no entitlement — so a failed poll, a loading
 * skeleton or a workspace that never set up a budget cannot make seven
 * destinations vanish.
 *
 * The role is the one exception, and it is not a hedge: it is the correction for
 * the bug this menu shipped with. `/studio` is auth-only, `/accounts` is
 * `requiredRole=MANAGER` in App.tsx, and `?tool=connections` mounts the very
 * page behind `/accounts` inside a drawer ON `/studio`. Offering that entry to
 * everyone therefore handed a REP a one-click path around the router's own gate.
 * So the honest statement of this component's contract is: STATE-INDEPENDENT,
 * EXCEPT where the destination carries a role of its own — a menu entry may
 * never be easier to reach than the page it opens.
 *
 * The first three entries open the drawer through the URL (`?tool=`), which is
 * also what gives those drawer branches an entry point at all; the last is the
 * legacy full-page surface, whose own tabs carry the rest.
 */

/**
 * Drawer tools, opened by writing `?tool=` — see StudioOneScreen.
 *
 * `role` mirrors what the destination actually enforces, and it is only half of
 * the gate: hiding a menu row hides nothing from someone who types the URL, so
 * StudioToolsDrawer refuses the same two tools on the rendering side. Both ends,
 * always — this end is for the honest menu, that end is for the actual refusal.
 *
 * Where each role comes from:
 *  - `calendar`  → ContentCalendarPage. `GET marketing/content-calendar` is
 *    `reports.read` with NO role, so every authenticated user may read the
 *    month. Left ungated on purpose. (The tab's "generate weekly plan" CTA does
 *    need MANAGER — it POSTs a SocialCampaign — and StudioCalendarTab gates that
 *    button itself.)
 *  - `create`    → AiStudioPage. The whole `marketing/ai/media/*` controller is
 *    class-level `@MarketingRoles('MANAGER')` on top of `@RequiresFeature('mediaGen')`,
 *    so a REP's library query 403s on mount and the generate button 403s on click.
 *  - `connections` → AccountCenterPage, i.e. `/accounts`, which App.tsx puts
 *    behind `requiredRole={MarketingRole.MANAGER}`; `GET marketing/connections`
 *    is `@MarketingRoles('MANAGER')` too.
 */
interface ToolLink {
  to: string;
  key: string;
  label: string;
  /** Minimum role the DESTINATION enforces. Omitted = open to every signed-in user. */
  role?: MarketingRole;
}

const TOOL_LINKS: readonly ToolLink[] = [
  /**
   * First, and deliberately roleless.
   *
   * The Autopilot console holds the caps, the pause and the KILL SWITCH for an
   * engine that spends the workspace's money. Until this entry existed its only
   * affordance was the status bar's button — and that bar renders an error strip
   * with nothing but a Retry when the budget read fails with no cached data. So
   * on a cold load where `GET /budget` was down, an operator could not reach the
   * stop button for a running autopilot by any route at all.
   *
   * A door to a kill switch may not depend on the health of the query that
   * describes what it would stop. This one renders from the router alone, and
   * carries no role because the console's reads are `reports.read` with no
   * `@MarketingRoles` — every write inside it is gated on its own.
   */
  { to: '/studio?tool=autopilot', key: 'studio.toolsMenu.autopilot', label: 'Otomatik pilot konsolu' },
  { to: '/studio?tool=calendar', key: 'studio.toolsMenu.calendar', label: 'İçerik takvimi' },
  {
    to: '/studio?tool=create',
    key: 'studio.toolsMenu.create',
    label: 'AI stüdyo',
    role: MarketingRole.MANAGER,
  },
  {
    to: '/studio?tool=connections',
    key: 'studio.toolsMenu.connections',
    label: 'Bağlı hesaplar',
    role: MarketingRole.MANAGER,
  },
];

/**
 * The recurring half: work you come back to weekly, not work you make.
 *
 * Each opens a STACK of embedded pages rather than a page — see
 * StudioToolsDrawer. All three are MANAGER because every page in every stack is
 * `managerOnly` in navigation.ts and MANAGER-gated server-side; the drawer
 * refuses the same three at the MOUNT, which is the half that actually holds,
 * since `?tool=` is a URL and hiding a row hides nothing.
 *
 * These rows are also the strongest case for this component's
 * STATE-INDEPENDENT-EXCEPT-ROLE contract. A door to the AR ledger, to the
 * webhook delivery log, or to a pending KVKK erasure request may not depend on
 * whether a budget poll happened to resolve — the pages behind them are how an
 * operator answers "did I get paid" and "is anything overdue on me", and those
 * questions are asked most exactly when something else on the screen is broken.
 */
const RECURRING_LINKS: readonly ToolLink[] = [
  { to: '/studio?tool=money', key: 'studio.toolsMenu.money', label: 'Para', role: MarketingRole.MANAGER },
  { to: '/studio?tool=ops', key: 'studio.toolsMenu.ops', label: 'İşleyiş', role: MarketingRole.MANAGER },
  { to: '/studio?tool=audience', key: 'studio.toolsMenu.audience', label: 'Kitle', role: MarketingRole.MANAGER },
  { to: '/studio?tool=line', key: 'studio.toolsMenu.line', label: 'İçerik hattı', role: MarketingRole.MANAGER },
];

export function StudioToolsMenu({ className }: { className?: string }) {
  const { t } = useTranslation('marketing');
  const role = useMarketingAuthStore((s) => s.user?.role);
  const links = TOOL_LINKS.filter((l) => !l.role || hasMarketingRole(role, l.role));
  const recurring = RECURRING_LINKS.filter((l) => !l.role || hasMarketingRole(role, l.role));

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
        {links.map((l) => (
          <DropdownMenuItem key={l.to} asChild>
            <Link to={l.to}>{t(l.key, l.label)}</Link>
          </DropdownMenuItem>
        ))}
        {/* Two groups, not seven flat rows: what you MAKE, then what you come
            back to. A rep sees only the first group and no heading over it,
            which is why the label is rendered with the group rather than
            unconditionally. */}
        {recurring.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>
              {t('studio.toolsMenu.group.recurring', 'Her hafta dönüp bakılan işler')}
            </DropdownMenuLabel>
            {recurring.map((l) => (
              <DropdownMenuItem key={l.to} asChild>
                <Link to={l.to}>{t(l.key, l.label)}</Link>
              </DropdownMenuItem>
            ))}
          </>
        )}
        <DropdownMenuSeparator />
        {/*
          The full-page surface. Kept as ONE entry rather than exploded into its
          seven tabs: those are destinations you go to deliberately and rarely,
          and listing them all here would rebuild, in a dropdown, exactly the
          inventory this screen exists to replace.

          Not role-filtered, because the SURFACE is not the destination: it is a
          tab strip, and the five tabs whose pages are manager-only now refuse
          from inside (`ManagerTab` in GrowthStudioPage). A rep opening this door
          still gets the content calendar and the trends browser, and meets a
          plain refusal on the rest instead of a page whose every request 403s.

          The earlier version of this note claimed each tab "gates on its own",
          which was simply untrue — none of them did, and the sentence was what
          licensed the hole. Left here as a warning: if you add a tab whose page
          is manager-only, wrap it, or this comment becomes a lie again.

          This is also where the temptation lands to promote ONE surface from
          behind that door — UGC Personas was the 2026-09 candidate. The
          decision, and the reasoning, are written on that surface's row in
          StudioToolsDrawer's DEEP_LINKS: it stays behind this entry, because
          the four rows above are drawer tools and the rule that keeps this menu
          short is that a full-page destination is reached through "Tüm
          araçlar", never listed beside them. Promote one and the next reviewer
          has a precedent for the other ten.
        */}
        <DropdownMenuItem asChild>
          <Link to="/studio?view=tools">{t('studio.toolsMenu.all', 'Tüm araçlar')}</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
