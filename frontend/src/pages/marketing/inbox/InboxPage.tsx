import { lazy, Suspense, useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ChevronLeft, List, Settings, Table2, Users } from 'lucide-react';
import {
  PageHeader,
  Button,
  IconButton,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import { useEntitlements } from '../../../features/marketing/hooks/useEntitlements';
import { API_URL } from '../../../lib/env';
import { RouteFallback } from '../../../components/RouteFallback';
import type { Lead } from '../../../features/marketing/types';
import { PeopleList } from './PeopleList';
import { PersonPane } from './PersonPane';
import { LeadContextPane } from './LeadContextPane';

// Lazy so a config surface's code only loads when opened — the daily surface
// must never pay for the config pages' bundles, and the leads TABLE is a
// deliberate second view that most sessions never open.
const ChannelsSettingsPage = lazy(() => import('../ChannelsSettingsPage'));
const SnippetsPage = lazy(() => import('../settings/snippets'));
const AgentStudioPage = lazy(() => import('../AgentStudioPage'));
const KnowledgeBasePage = lazy(() => import('../KnowledgeBasePage'));
const LeadsPage = lazy(() => import('../leads/LeadsPage'));

/** The conversation-domain config surfaces, reachable at `?tab=`. */
const CONFIG_TABS = ['channels', 'snippets', 'agents', 'knowledge'] as const;
type ConfigTab = (typeof CONFIG_TABS)[number];
const isConfigTab = (v: string | null): v is ConfigTab =>
  (CONFIG_TABS as readonly string[]).includes(v ?? '');

function Lazy({ children }: { children: ReactNode }) {
  return <Suspense fallback={<RouteFallback />}>{children}</Suspense>;
}

/**
 * The person-primary surface. `/inbox` and `/leads` both render it, identically.
 *
 * ## What this replaces, and why
 *
 * v2.283.0 put the inbox and the lead list on one page as two tabs. Clicking a
 * person in the Kişiler tab still went to `/leads/:id`, so the conversation list
 * and the contact list stayed two objects with two behaviours. The owner's
 * verdict was that the tab had merely been moved. It had.
 *
 * There is one object here: the **person**. A conversation is a field of theirs.
 * Three columns — list (~34%) · stream · record card (~26%) — and selecting a
 * row selects. The single navigation on the page is the record card's link into
 * `/leads/:id`, where the four-tab detail does the deep work.
 *
 * ## What this component owns, and what it does not
 *
 * It owns exactly three things: WHO is selected, the live stream that keeps the
 * three columns fresh, and the chrome (one header, the gear menu, the small-
 * screen collapse). The list owns its queue and filters, the middle column owns
 * writing back, the card owns the one link. That split is why a broken column
 * cannot blank its neighbours — nobody is holding anybody else's data.
 *
 * `key={selected.id}` on the middle column is load-bearing, not tidy. Every
 * piece of that component's state is per-person (the reply draft, the note
 * draft, which thread is in hand) and this branch has already shipped the other
 * outcome once: a header kept lead A's phone number and dialled it under lead
 * B's id. Keying is the whole mechanism — there is no second reset-on-change
 * effect, because two mechanisms means one of them can rot unnoticed.
 *
 * ## Two URL parameters survive from the surface this replaces
 *
 * `?tab=channels|snippets|agents|knowledge` still opens the four conversation-
 * domain config surfaces behind the gear (manager-only, and gated on
 * `conversationAi` because every one of them configures that domain).
 *
 * `?view=table` opens the leads TABLE — filters, bulk assign, bulk delete, bulk
 * enrol, CSV export. This is a deliberate deviation from "one list, no tabs" and
 * it is recorded rather than smuggled: those are manager tools that exist
 * nowhere else in the product, the brief forbade rebuilding them onto the new
 * list, and deleting a manager's bulk-assign to satisfy a layout would be a
 * worse answer than a second VIEW of the same set of people. It is a view, not a
 * second object: same people, same queues, no default that lands anyone there.
 *
 * Its ENTRY POINT is the gear, beside the four config surfaces, and not a
 * button in the header. As page chrome — full-weight, always visible, offered
 * to reps — it read as a peer VIEW of the surface, which is the second list the
 * owner objected to under another name. Its whole justification is manager
 * tooling (`LeadsPage` gates the checkbox column and the bulk toolbar on
 * `isManager`), so it belongs where the other manager-only surfaces already are.
 *
 * The two parameters are guarded DIFFERENTLY, on purpose. `?tab=` opens pages
 * that CONFIGURE the workspace, so a rep's deep link is bounced to the surface.
 * `?view=table` shows the same people a rep already sees in the left column,
 * with the manager tools gated inside `LeadsPage` itself — so the link keeps
 * working for anyone who is handed one, and only the affordance is manager-only.
 * And the table item does NOT ride on `conversationAi` the way the config items
 * do: `/leads` carries no entitlement, and folding it into the same condition
 * would delete a manager's bulk assign for every workspace that never bought
 * the conversation add-on.
 */
export default function InboxPage() {
  const { t } = useTranslation('marketing');
  const queryClient = useQueryClient();
  const { accessToken, user } = useMarketingAuthStore();
  const isManager = user?.role === 'MANAGER' || user?.role === 'OWNER';
  const { has, isLoading: entitlementsLoading } = useEntitlements();

  // A RESOLVED yes before anything is FETCHED: `GET /conversations` and the SSE
  // endpoint are both @RequiresFeature('conversationAi'), and `/leads` — which
  // lands here too — carries no entitlement at all.
  const canConverse = has('conversationAi');
  // The gear is chrome, not a request. `useEntitlements` fails closed while
  // /billing/summary is in flight, which would blink the menu (and bounce a
  // `?tab=` deep link off its own page) for one render.
  const offersConfig = isManager && (canConverse || entitlementsLoading);
  // The gear itself. The TABLE item alone earns it: that one is manager-only
  // but not conversation-gated, so a manager on a workspace without the add-on
  // must still have a way in. See the file docstring.
  const offersGear = isManager;

  const [params, setParams] = useSearchParams();
  const requestedTab = params.get('tab');
  // Guard the RENDER, not just the menu: a deep link to a config surface a rep
  // may not open has to land on the surface rather than on a blank panel.
  const configTab: ConfigTab | null =
    isConfigTab(requestedTab) && offersConfig ? requestedTab : null;
  const tableView = params.get('view') === 'table';

  const setTab = (v: string) =>
    setParams(
      (p) => {
        p.set('tab', v);
        return p;
      },
      { replace: true },
    );

  const setView = (v: 'list' | 'table') =>
    setParams(
      (p) => {
        if (v === 'table') p.set('view', 'table');
        else p.delete('view');
        return p;
      },
      { replace: true },
    );

  // The whole row, not just the id: the middle and right columns read this
  // person's fields, and re-fetching a record the list already returned would
  // be a third source of truth about who this is.
  const [selected, setSelected] = useState<Lead | null>(null);
  // The SAME answer, in a form the live-stream effect can read without being
  // torn down and rebuilt for it. See the effect below: `selected` in its
  // dependency array reconnected the SSE socket on every click.
  const selectedRef = useRef<Lead | null>(null);
  /** The one place selection changes, so the ref cannot drift from the state. */
  const select = (person: Lead | null) => {
    selectedRef.current = person;
    setSelected(person);
  };
  // Below lg the record card cannot sit beside the other two, so it arrives as
  // a sheet on request.
  const [cardOpen, setCardOpen] = useState(false);

  // ── The live stream ────────────────────────────────────────────────────────
  //
  // Kept verbatim from the Inbox, including why it is fetch() and not
  // EventSource: the native API cannot set request headers, so authenticating
  // it means putting the access token in the query string and leaking a bearer
  // token into logs and history. An AbortController tears it down; a 3s timer
  // reconnects, matching EventSource's own behaviour.
  //
  // What changed is what a frame REFRESHES. Previously it invalidated the
  // conversation list and the open thread. The middle column is no longer a
  // thread — it is `LeadStream`, keyed under ['marketing','lead',id,'stream'] —
  // so on the old wiring an inbound message landed in the database and nothing
  // on screen moved until a reload. Three keys now:
  //
  //   1. the conversation prefix (thread lists, the pane's channel picker)
  //   2. the people LIST, so the row's preview, unread and position update
  //   3. the selected person's STREAM, so the message itself appears
  //
  // (3) fires for every workspace event rather than only this person's, because
  // ConversationStreamEvent carries `conversationId` and no `leadId` — the
  // client cannot tell whose it is. One extra timeline fetch per event is the
  // honest price; the cheaper fix is a `leadId` on the event, which is a backend
  // contract change and is deliberately not smuggled into this commit.
  //
  // The chip COUNTS are excluded by predicate. They sit under the same
  // ['marketing','leads'] prefix, and the three of them are the only queries
  // there whose answer a single inbound message cannot change in a way anyone
  // needs within the second — so refetching them per frame would turn one
  // message into six requests for two numbers that did not move. `PersonPane`'s
  // WRITES invalidate ['marketing','leads'] wholesale on purpose, and that is
  // not an inconsistency: a reply, a close or a reopen is exactly the kind of
  // event that moves "Bekleyen", it happens once per human action rather than
  // once per frame, and the person who caused it is the person looking at the
  // chip. Frames are cheap-and-many; writes are rare-and-consequential.
  //
  // WHO is selected is read from `selectedRef`, not from `selected`, and the
  // dependency array is why. This effect owns a live SSE socket; listing the
  // selected row in its deps meant every click aborted the fetch and opened a
  // new connection, and `ConversationStreamService` is a plain per-workspace
  // RxJS Subject with NO replay — so every frame the server pushed during that
  // teardown window was gone for good, precisely while a rep was moving
  // through their queue. One connection for the surface's lifetime; the ref is
  // how the handler still knows whose stream to refresh.
  useEffect(() => {
    if (!accessToken || !canConverse) return;

    const controller = new AbortController();
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const handleFrame = (frame: string) => {
      const dataLines = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length === 0) return;
      try {
        const data = JSON.parse(dataLines.join('\n'));
        if (data?.kind === 'heartbeat') return;
        queryClient.invalidateQueries({ queryKey: ['marketing', 'conversations'] });
        queryClient.invalidateQueries({
          predicate: (q) =>
            q.queryKey[0] === 'marketing' &&
            q.queryKey[1] === 'leads' &&
            q.queryKey[2] !== 'queue-count',
        });
        const open = selectedRef.current;
        if (open) queryClient.invalidateQueries({ queryKey: ['marketing', 'lead', open.id] });
      } catch {
        /* ignore malformed frame */
      }
    };

    const connect = async () => {
      try {
        const res = await fetch(`${API_URL}/marketing/conversations/stream`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        // eslint-disable-next-line no-constant-condition
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          // Normalize CRLF -> LF so the `\n\n` frame split works whichever
          // boundary the server emits.
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            if (frame.trim()) handleFrame(frame);
          }
        }
        if (!closed) scheduleReconnect();
      } catch {
        if (!closed) scheduleReconnect();
      }
    };

    const scheduleReconnect = () => {
      if (closed) return;
      reconnectTimer = setTimeout(connect, 3000);
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      controller.abort();
    };
  }, [accessToken, canConverse, queryClient]);

  const onSelect = (person: Lead) => {
    select(person);
    setCardOpen(false);
  };

  return (
    <div className="flex h-full flex-col gap-4">
      {/* ONE header. Both halves of the old surface rendered their own and
          nesting them stacked two <h1>s. */}
      <PageHeader
        title={t('surface.title', 'Kişiler')}
        description={t('surface.subtitle', 'Herkes tek listede — konuşanı da, sessizi de.')}
        actions={
          offersGear ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Settings className="h-4 w-4" aria-hidden="true" />
                  {t('inbox.settings', 'Inbox settings')}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {/* The leads table, as a VIEW of the same people. See the file
                    docstring: it is where bulk assign, bulk delete, bulk enrol
                    and CSV export live, and they exist nowhere else. */}
                <DropdownMenuItem onClick={() => setView(tableView ? 'list' : 'table')}>
                  {tableView ? (
                    <List className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Table2 className="h-4 w-4" aria-hidden="true" />
                  )}
                  {tableView
                    ? t('surface.view.list', 'Liste')
                    : t('surface.view.table', 'Tablo')}
                </DropdownMenuItem>

                {offersConfig && (
                  <>
                    <DropdownMenuItem onClick={() => setTab('channels')}>
                      {t('inbox.tab.channels', 'Channels')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setTab('snippets')}>
                      {t('inbox.tab.snippets', 'Canned Responses')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setTab('agents')}>
                      {t('inbox.tab.agents', 'AI Agents')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setTab('knowledge')}>
                      {t('inbox.tab.knowledge', 'Knowledge')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null
        }
      />

      {configTab ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <div className="shrink-0">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setParams(
                  (p) => {
                    p.delete('tab');
                    return p;
                  },
                  { replace: true },
                )
              }
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              {t('inbox.backToInbox', 'Back to inbox')}
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Lazy>
              {configTab === 'channels' ? (
                <ChannelsSettingsPage embedded />
              ) : configTab === 'snippets' ? (
                <SnippetsPage embedded />
              ) : configTab === 'agents' ? (
                <AgentStudioPage embedded />
              ) : (
                <KnowledgeBasePage embedded />
              )}
            </Lazy>
          </div>
        </div>
      ) : tableView ? (
        <div data-testid="surface-table" className="min-h-0 flex-1 overflow-y-auto">
          <Lazy>
            <LeadsPage embedded />
          </Lazy>
        </div>
      ) : (
        <div data-testid="person-surface" className="flex min-h-0 flex-1 gap-0 md:gap-4">
          {/* Left — people. Full width until someone is picked on a phone;
              the existing inbox's own answer to the same problem. */}
          <div
            data-testid="surface-list"
            className={`${
              selected ? 'hidden md:flex' : 'flex w-full'
            } min-h-0 md:w-[34%] md:max-w-sm md:shrink-0`}
          >
            <PeopleList
              selectedId={selected?.id ?? null}
              onSelect={onSelect}
              className="w-full"
            />
          </div>

          {/* Middle — the person's stream and the composer. */}
          <div
            data-testid="surface-pane"
            className={`${
              selected ? 'flex' : 'hidden md:flex'
            } min-h-0 w-full min-w-0 flex-1 flex-col gap-2`}
          >
            {/* Below lg the other two columns are not both on screen; these are
                the way back to the list and forward to the record. */}
            {selected && (
              <div className="flex shrink-0 items-center justify-between lg:hidden">
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={t('inbox.back', 'Geri')}
                  onClick={() => select(null)}
                  className="md:hidden"
                >
                  <ChevronLeft className="h-5 w-5" />
                </IconButton>
                <IconButton
                  variant="ghost"
                  size="sm"
                  aria-label={t('surface.card.title', 'Kayıt')}
                  onClick={() => setCardOpen(true)}
                  className="ms-auto"
                >
                  <Users className="h-5 w-5" />
                </IconButton>
              </div>
            )}
            {/* `key` is the ONE reset mechanism for per-person state. See the
                file docstring — this branch has already dialled the wrong
                number once by leaving it out. */}
            <PersonPane
              key={selected?.id ?? 'none'}
              person={selected}
              className="min-h-0 flex-1"
            />
          </div>

          {/* Right — the record card, inline at lg+ only. */}
          <div
            data-testid="surface-card"
            className="hidden min-h-0 lg:flex lg:w-[26%] lg:max-w-xs lg:shrink-0"
          >
            <LeadContextPane lead={selected} className="w-full" />
          </div>
          {cardOpen && (
            <LeadContextPane lead={selected} asSheet onClose={() => setCardOpen(false)} />
          )}
        </div>
      )}
    </div>
  );
}
