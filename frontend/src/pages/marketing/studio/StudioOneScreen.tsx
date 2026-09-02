import { lazy, Suspense, useMemo, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/Card';
import { RouteFallback } from '../../../components/RouteFallback';
import { AutopilotStatusBar } from './AutopilotStatusBar';
import { ConnectedAccountsList } from './ConnectedAccountsList';
import { StudioToolsDrawer, type StudioTool } from './StudioToolsDrawer';
import { StudioToolsMenu } from './StudioToolsMenu';
import { trailingUtcDays } from './todayBounds';
import type { StudioRange } from './AccountStatsPanel';

// Each panel is a route-sized amount of code and only one of them is ever the
// reason someone opened this page, so they load on demand rather than as one
// bundle. `ConnectedAccountsList` is the exception and is imported eagerly: it
// is part of the top strip, which is on screen in every state this page has,
// and a strip that pops in after a chunk lands is a strip that moves the
// controls under the pointer.
const AccountStatsPanel = lazy(() => import('./AccountStatsPanel'));
const IdeasPanel = lazy(() => import('./IdeasPanel'));
const TodayQueuePanel = lazy(() => import('./TodayQueuePanel'));
const IdeaDetail = lazy(() => import('./IdeaDetail'));

// This array is what VALIDATES `?tool=`; a value missing here does not error,
// it silently falls back to the autopilot console.
const TOOLS: StudioTool[] = [
  'autopilot',
  'calendar',
  'create',
  'connections',
  'money',
  'ops',
  'audience',
];

/** The window the stats band opens on. 30 days is long enough for a weekly
 *  cadence to have a shape and short enough that a change is still recent. */
const DEFAULT_RANGE: StudioRange = 30;

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * Growth Studio, as ONE screen.
 *
 * What it replaced was a front door showing the ad-budget console and a "Manual
 * tools" button hiding five tabs, three of which hid sub-tabs of their own.
 * Everything the product could do for your marketing was in there; almost none
 * of it was where you would look. The owner's brief was blunt about the fix —
 * put it on one screen — and the shape below is theirs:
 *
 *   TOP     the autopilot's state, and every account it can publish to
 *   RIGHT   what goes out today, with the buttons that change it
 *   LEFT/TOP the three numbers worth knowing about the accounts right now
 *   LEFT/BOT what to try next, and what approving it will really do
 *
 * The arrangement is an argument, not a grid. The left column is why, the right
 * column is what: a decision about what to publish is taken next to the evidence
 * for it rather than three clicks away from it.
 *
 * HOW THE AREA IS ALLOCATED, and why it changed. The first version gave the
 * stats block the largest share of the screen (three fifths of the left column)
 * and the publishing queue a fixed 380px rail. That was area allocated by how
 * much CONTENT a region had rather than by how much it MATTERED — and the stats
 * were the emptiest region on the page, because organic insights need scopes
 * this workspace does not hold until app review clears them. So:
 *
 *   - The stats band is a DEFINED height (`lg:h-60`) and no longer flexes. It
 *     holds three slots, and three slots is all it will ever hold; a region that
 *     cannot grow cannot take the screen back by having more to say.
 *   - The ideas panel takes everything the band gave up. It is the only region
 *     whose content is genuinely open-ended — a proposal has a title, an
 *     argument and consequences — and the owner asked for exactly that
 *     ("fikirler büyüsün").
 *   - The two columns are PEERS (`lg:flex-1` each), not a column and a rail.
 *     The queue is the thing the whole screen is for; sizing it to whatever was
 *     left over after the charts is how it ended up the narrowest thing on a
 *     page built around it. Neither column is now narrower than the other, and
 *     each keeps a floor (`lg:min-w-[26rem]`) below which its rows would start
 *     truncating rather than wrapping.
 *
 * Everything that could not be folded in — a full month calendar, the media
 * generator, the connection manager, the ad-budget console — is a drawer off
 * this screen rather than a tab you have to know about. The handful of genuine
 * full pages (blast campaigns, trends, personas, the social planner's table)
 * keep their routes and are listed in the drawer's menu. Nothing became
 * unreachable; the difference is that nothing is the front door except the work.
 */
export default function StudioOneScreen() {
  const [params, setParams] = useSearchParams();

  /**
   * The window lives HERE rather than inside the stats band, because two
   * regions read it: the band's three slots and the per-account popovers in the
   * top strip. Both then key their insights query on the same `from`/`to`, which
   * is what lets React Query serve the second one out of the first one's cache
   * instead of firing a second identical request — and what stops the strip and
   * the band from ever describing two different windows.
   *
   * Computed once, from one clock reading: two components each calling
   * `trailingUtcDays` would eventually disagree across a UTC midnight and fork
   * the cache for as long as the page stayed open.
   */
  const [range, setRange] = useState<StudioRange>(DEFAULT_RANGE);
  const { from, to } = useMemo(() => trailingUtcDays(range), [range]);

  // `?tool=` rather than component state: a drawer you can link to is a drawer
  // the rest of the app (and the old ?view=tools deep links) can open, and one
  // the back button closes.
  const raw = params.get('tool');
  const tool = (TOOLS as string[]).includes(raw ?? '') ? (raw as StudioTool) : null;

  /**
   * The idea being read, by the same rule and for the same reasons as `?tool=`.
   *
   * An id cannot be validated against a list the way a tool can — the set is
   * whatever the strategist has proposed — so the only check here is that there
   * is a non-empty value, and `IdeaDetail` owns what happens when the id turns
   * out not to resolve. What matters at this level is that the detail is a URL:
   * shareable, right-clickable from the ideas panel, and closed by the back
   * button rather than by hunting for an X.
   */
  const idea = params.get('idea')?.trim() || null;

  // Everything except the autopilot console is opened by a <Link> writing
  // `?tool=` (see StudioToolsMenu) rather than by a callback drilled through two
  // lazy boundaries — a link is right-clickable, bookmarkable, and survives the
  // panel that would otherwise have had to own the button.
  const openTool = (next: StudioTool) =>
    setParams(
      (p) => {
        p.set('tool', next);
        return p;
      },
      { replace: true },
    );

  const closeTool = () =>
    setParams(
      (p) => {
        p.delete('tool');
        return p;
      },
      { replace: true },
    );

  /**
   * Closing the idea is a PUSH, not a replace.
   *
   * `?tool=` is replace because a drawer is a mode you toggle and nobody wants
   * six history entries for six tools. Reading an idea is navigation: it is
   * opened from a link in the ideas panel, so the back button has to be the way
   * out of it — and a replace here would send Back to whatever was before the
   * Studio instead.
   */
  const closeIdea = () =>
    setParams((p) => {
      p.delete('idea');
      return p;
    });

  return (
    // `lg:h-full`, never a 100vh calc: MarketingLayout's scroll container has
    // already subtracted the header and its own padding, so the columns fill
    // exactly what is left. Below `lg` the height is dropped entirely and the
    // regions stack — a two-column split on a phone is two unusable slivers,
    // and a viewport-locked panel there would trap the queue in a couple of
    // hundred pixels of scroll.
    <div className="flex flex-col gap-4 lg:h-full lg:min-h-0">
      {/*
        Three components on one row, and deliberately three. The bar renders
        from live queries and has error and loading branches of its own; the
        accounts list renders from two more; the menu renders from nothing but
        the router. Folding any of them into the others would make every
        destination behind the menu disappear whenever a budget poll failed —
        which is how the old surface lost its only door in the first place.

        `items-stretch` so the three cards share one height rather than each
        ending wherever its own content happens to.
      */}
      <div className="flex shrink-0 flex-wrap items-stretch gap-2">
        <AutopilotStatusBar className="min-w-0 flex-1" onOpenConsole={() => openTool('autopilot')} />
        <ConnectedAccountsList from={from} to={to} className="max-w-full lg:max-w-[24rem]" />
        <StudioToolsMenu className="shrink-0" />
      </div>

      {/*
        The work area. It is TAKEN OUT OF THE FLOW while an idea is open rather
        than left underneath it: `flex-1` columns beside an `h-full` sibling
        shrink to nothing, and three cards at zero height do not disappear —
        their padding keeps a border's worth of each one, which then paints down
        over the idea below. Below `lg` the failure was plainer still: with no
        container height to fight over, the idea simply landed after the whole
        screen, so tapping a row looked like it had done nothing.

        `hidden`, not unmounted: the three panels keep their React state and
        their queries, so closing the idea costs no refetch. Their inner scroll
        offsets do go back to the top, which is the one thing display:none takes
        and the cheapest thing on the list to lose.
      */}
      <div
        data-testid="studio-work"
        className={`flex min-h-0 flex-1 flex-col gap-4 lg:flex-row ${idea ? 'hidden' : ''}`}
      >
        <div className="flex min-h-0 min-w-0 flex-col gap-4 lg:flex-1 lg:basis-0 lg:min-w-[26rem]">
          <section data-testid="studio-stats" className="shrink-0 lg:h-60">
            <Card className="h-full">
              <CardContent className="h-full min-h-0 pt-4">
                <Lazy>
                  <AccountStatsPanel
                    range={range}
                    onRangeChange={setRange}
                    from={from}
                    to={to}
                  />
                </Lazy>
              </CardContent>
            </Card>
          </section>

          <section data-testid="studio-ideas" className="min-h-0 flex-1">
            <Card className="h-full">
              <CardContent className="h-full min-h-0 pt-4">
                <Lazy>
                  <IdeasPanel />
                </Lazy>
              </CardContent>
            </Card>
          </section>
        </div>

        <section
          data-testid="studio-today"
          className="min-h-0 lg:flex-1 lg:basis-0 lg:min-w-[26rem]"
        >
          <Card className="h-full">
            <CardContent className="h-full min-h-0 pt-4">
              <Lazy>
                <TodayQueuePanel />
              </Lazy>
            </CardContent>
          </Card>
        </section>
      </div>

      <StudioToolsDrawer open={tool !== null} tool={tool} onOpenChange={(o) => (o ? undefined : closeTool())} />

      {/* Mounted BESIDE the three panels, never in place of them: it takes the
          work area for as long as it is open, and closing it puts you back on
          panels that never unmounted rather than on three fresh queries. In the
          same card the rest of the screen uses, because a region that is the
          only bare block on a page of cards reads as something that has gone
          wrong rather than as somewhere you navigated to. */}
      {idea && (
        <section data-testid="studio-idea" className="min-h-0 flex-1">
          <Card className="h-full">
            <CardContent className="h-full min-h-0 pt-4">
              <Lazy>
                <IdeaDetail ideaId={idea} onClose={closeIdea} />
              </Lazy>
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}
