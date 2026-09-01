import { lazy, Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/Card';
import { RouteFallback } from '../../../components/RouteFallback';
import { AutopilotStatusBar } from './AutopilotStatusBar';
import { StudioToolsDrawer, type StudioTool } from './StudioToolsDrawer';
import { StudioToolsMenu } from './StudioToolsMenu';

// Each panel is a route-sized amount of code and only one of them is ever the
// reason someone opened this page, so they load on demand rather than as one
// bundle.
const AccountStatsPanel = lazy(() => import('./AccountStatsPanel'));
const IdeasPanel = lazy(() => import('./IdeasPanel'));
const TodayQueuePanel = lazy(() => import('./TodayQueuePanel'));

const TOOLS: StudioTool[] = ['autopilot', 'calendar', 'create', 'connections'];

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
 *   RIGHT   what goes out today, with the buttons that change it
 *   LEFT/TOP how the connected accounts are actually doing
 *   LEFT/BOT what to try next, and what approving it will really do
 *
 * The arrangement is an argument, not a grid. The right rail is the day's work
 * and never moves. The left column is why: the numbers on top, the proposals
 * underneath, so a decision about what to publish is taken next to the evidence
 * for it rather than three clicks away from it.
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

  // `?tool=` rather than component state: a drawer you can link to is a drawer
  // the rest of the app (and the old ?view=tools deep links) can open, and one
  // the back button closes.
  const raw = params.get('tool');
  const tool = (TOOLS as string[]).includes(raw ?? '') ? (raw as StudioTool) : null;

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

  return (
    // `lg:h-full`, never a 100vh calc: MarketingLayout's scroll container has
    // already subtracted the header and its own padding, so the columns fill
    // exactly what is left. Below `lg` the height is dropped entirely and the
    // three regions stack — a two-column split on a phone is two unusable
    // slivers, and a viewport-locked panel there would trap the queue in a
    // couple of hundred pixels of scroll.
    <div className="flex flex-col gap-4 lg:h-full lg:min-h-0">
      {/*
        The status bar and the tools menu sit on one row, but they are
        deliberately two components. The bar renders from live queries and has
        error and loading branches of its own; the menu renders from nothing but
        the router. Folding the menu into the bar would make every destination
        behind it disappear whenever a budget poll failed — which is how the old
        surface lost its only door in the first place.
      */}
      <div className="flex shrink-0 items-start gap-2">
        <AutopilotStatusBar className="min-w-0 flex-1" onOpenConsole={() => openTool('autopilot')} />
        <StudioToolsMenu className="shrink-0" />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-4 lg:flex-row">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
          <section data-testid="studio-stats" className="min-h-0 lg:flex-[3]">
            <Card className="h-full">
              <CardContent className="h-full min-h-0 pt-4">
                <Lazy>
                  <AccountStatsPanel />
                </Lazy>
              </CardContent>
            </Card>
          </section>

          <section data-testid="studio-ideas" className="min-h-0 lg:flex-[2]">
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
          className="min-h-0 lg:w-[380px] lg:shrink-0"
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
    </div>
  );
}
