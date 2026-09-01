import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LeadContextPane } from './LeadContextPane';
import { useMarketingAuthStore } from '../../../store/marketingAuthStore';
import type { Lead } from '../../../features/marketing/types';

// The card carries a SATIŞ section now, which reads and writes. Mocked at the
// axios layer rather than at the service layer, so the URLs and payloads the
// card actually sends are the ones under test.
const get = vi.fn();
const post = vi.fn();
vi.mock('../../../features/marketing/api/marketingApi', () => ({
  default: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
    patch: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string | string[], opts?: { defaultValue?: string } | string) =>
      (typeof opts === 'string' ? opts : opts?.defaultValue) ??
      (Array.isArray(key) ? key[0] : key),
    i18n: { language: 'tr' },
  }),
}));

const person = (over: Partial<Lead> = {}): Lead =>
  ({
    id: 'p1',
    businessName: 'Acme Kafe',
    contactPerson: 'Ayşe Yılmaz',
    phone: '+905551112233',
    email: 'ayse@acme.test',
    city: 'Ankara',
    businessType: 'CAFE',
    source: 'WEBSITE',
    status: 'CONTACTED',
    priority: 'HIGH',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-01T00:00:00Z',
    ...over,
  }) as Lead;

const PIPELINES = [
  {
    id: 'p1',
    name: 'Satış Hattı',
    isDefault: true,
    position: 0,
    archived: false,
    stages: [
      { id: 's-new', pipelineId: 'p1', name: 'Yeni', position: 0, probability: 10, isWon: false, isLost: false },
      { id: 's-offer', pipelineId: 'p1', name: 'Teklif gönderildi', position: 1, probability: 40, isWon: false, isLost: false },
    ],
  },
];

/** One OPEN deal, forever at 's-new' on the server — the truth the card owes. */
const DEAL = {
  id: 'o1',
  pipelineId: 'p1',
  stageId: 's-new',
  leadId: 'p1',
  assignedToId: null,
  name: 'Happy Day Organizasyon',
  value: 45000,
  currency: 'TRY',
  status: 'OPEN',
  source: null,
  notes: null,
  position: 0,
  lostReason: null,
  expectedCloseDate: null,
  wonAt: null,
  lostAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

/** What `GET /leads/:id` returns — the ONE read behind both the GÖREVLER and
 *  the TEKLİFLER sections. Same payload the lead-detail page renders. */
const DETAIL_LEAD = {
  id: 'p1',
  businessName: 'Acme Kafe',
  contactPerson: 'Ayşe Yılmaz',
  status: 'CONTACTED',
  convertedTenantId: null,
  offers: [
    {
      id: 'of1',
      status: 'DRAFT',
      customPrice: 4900,
      discount: null,
      trialDays: null,
      planCurrency: 'TRY',
      validUntil: null,
      notes: 'Kurulum dahil',
      createdAt: '2026-08-20T00:00:00.000Z',
    },
  ],
  tasks: [
    {
      id: 'tk1',
      title: 'Ara onu',
      type: 'CALL',
      priority: 'HIGH',
      status: 'PENDING',
      dueDate: '2026-09-05T09:00:00.000Z',
    },
  ],
};

const ESTIMATES = [
  {
    id: 'es1',
    leadId: 'p1',
    number: 'EST-A1B2',
    items: [],
    currency: 'TRY',
    total: 1250000,
    notes: null,
    validUntil: null,
    status: 'SENT',
    convertedInvoiceId: null,
    createdAt: '2026-08-22T00:00:00.000Z',
  },
];

const BOOKINGS = [
  {
    id: 'bk1',
    calendarId: 'c1',
    leadId: 'p1',
    name: 'Demo görüşmesi',
    email: null,
    phone: null,
    notes: null,
    startAt: '2026-09-10T13:00:00.000Z',
    endAt: '2026-09-10T13:30:00.000Z',
    status: 'CONFIRMED',
    assigneeUserId: null,
    meetingUrl: null,
    conferenceProvider: null,
    attendeeTimezone: null,
    token: 'tok',
  },
];

const CONSENTS = [
  { type: 'MARKETING_EMAIL', granted: true, at: '2026-07-01T00:00:00.000Z' },
  { type: 'MARKETING_SMS', granted: false, at: '2026-07-02T00:00:00.000Z' },
];

const COURSES = [{ id: 'crs1', title: 'Satış Temelleri' }];

const ENROLLMENTS = [
  {
    id: 'en1',
    workspaceId: 'ws1',
    courseId: 'crs1',
    leadId: 'p1',
    status: 'ACTIVE',
    progressPct: 40,
    enrolledAt: '2026-08-01T00:00:00.000Z',
    completedAt: null,
  },
];

/**
 * RANDEVULAR is the one section whose read is not open to everyone: the whole
 * of `marketing/calendars` is MANAGER+ behind `funnels`, so the card gates that
 * section the same way. Every test that is not ABOUT the gate therefore runs as
 * a manager in an entitled workspace, which is the only combination that ever
 * saw the section work.
 */
function setRole(role: 'OWNER' | 'MANAGER' | 'REP' | null) {
  useMarketingAuthStore.setState({
    user: role
      ? {
          id: 'u1',
          workspaceId: 'ws1',
          email: 'manager@acme.test',
          firstName: 'Mehmet',
          lastName: 'Kaya',
          role,
        }
      : null,
    isAuthenticated: !!role,
  });
}

/** What `GET /billing/summary` says this workspace's plan includes. */
let features: Record<string, boolean> = {};

/**
 * The card's reads, as ONE map keyed by URL.
 *
 * A test that wants a single read to fail replaces that key. It used to restate
 * the whole `mockImplementation`, and the moment `/billing/summary` became the
 * answer to "may this workspace see Randevular at all" every restatement
 * silently dropped it — a test about a broken estimates read would have been
 * quietly asserting against an unentitled workspace.
 */
type Read = () => Promise<{ data: unknown }>;
let routes: Record<string, Read>;

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  post.mockResolvedValue({ data: {} });
  setRole('MANAGER');
  features = { funnels: true, memberships: true };
  routes = {
    '/compliance/leads/:id/consent': () => Promise.resolve({ data: CONSENTS }),
    '/enrollments': () => Promise.resolve({ data: ENROLLMENTS }),
    '/courses': () => Promise.resolve({ data: COURSES }),
    '/pipelines': () => Promise.resolve({ data: PIPELINES }),
    '/opportunities': () =>
      Promise.resolve({
        data: { data: [DEAL], meta: { total: 1, page: 1, limit: 20, totalPages: 1 } },
      }),
    // The singular detail read, whatever id it is asked for.
    '/leads/:id': () => Promise.resolve({ data: DETAIL_LEAD }),
    '/estimates': () => Promise.resolve({ data: ESTIMATES }),
    '/calendars/bookings': () => Promise.resolve({ data: BOOKINGS }),
    '/billing/summary': () => Promise.resolve({ data: { entitlements: { features } } }),
  };
  get.mockImplementation((url: string) => {
    const key = url.startsWith('/leads/')
      ? '/leads/:id'
      : url.startsWith('/compliance/leads/')
        ? '/compliance/leads/:id/consent'
        : url;
    const read = routes[key];
    return read ? read() : Promise.resolve({ data: {} });
  });
});

/**
 * One QueryClient per render, so no test inherits another's cache.
 *
 * `retry: false` is the default here but `useLeadRecord` overrides it with its
 * own policy, which is the point of that hook — so the detail read still runs
 * its retries in these tests. `retryDelay: 0` collapses their BACKOFF only: the
 * count is the hook's and is asserted directly in `useLeadRecord.test.tsx`,
 * while the wall clock is nobody's behaviour. Without it this file waited out a
 * real 1+2s backoff and its failure test sat ~2s from vitest's per-test cap.
 */
function wrap(node: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 }, mutations: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>
  );
}

const renderCard = (props: Partial<React.ComponentProps<typeof LeadContextPane>> = {}) =>
  render(wrap(<LeadContextPane lead={person()} {...props} />));

describe('LeadContextPane — the record card', () => {
  it('says who this is, how to reach them and where they stand', () => {
    renderCard();

    const card = screen.getByTestId('record-card');
    expect(card).toHaveTextContent('Ayşe Yılmaz');
    expect(card).toHaveTextContent('Acme Kafe');
    expect(card).toHaveTextContent('+905551112233');
    expect(card).toHaveTextContent('ayse@acme.test');
    expect(card).toHaveTextContent('CONTACTED');
  });

  /**
   * Three states, not two, and the middle one is the reason the third exists.
   *
   * A user → they own this person. NULL → nobody does, which is what
   * `GET /leads` sends (Prisma returns the missing relation as null) and is a
   * fact worth reading rather than a blank line: it is the whole point of the
   * Atanmamış queue one column over. UNDEFINED → nobody has SAID, which is what
   * the Hat / Takvim / Görevler views hand over before the person's record
   * resolves, and what a person whose record could not be read looks like
   * forever.
   *
   * Printing "Atanmamış" for the third case would put an unowned label on
   * somebody else's lead, on the one card a rep reads before deciding whether
   * to touch them.
   */
  it('names the owner', () => {
    renderCard({
      lead: person({
        assignedTo: { id: 'u1', firstName: 'Mehmet', lastName: 'Kaya' } as Lead['assignedTo'],
      }),
    });
    expect(screen.getByTestId('record-owner')).toHaveTextContent('Mehmet Kaya');
  });

  it('says Atanmamış when the record says nobody owns them', () => {
    renderCard({ lead: person({ assignedTo: null }) });
    expect(screen.getByTestId('record-owner')).toHaveTextContent('Atanmamış');
  });

  it('leaves the row out when nobody has said, rather than guessing unowned', () => {
    renderCard({ lead: person({ assignedTo: undefined }) });
    // Positive anchor first: the card IS up for this person, so the absence
    // below is a decision rather than an unrendered component.
    expect(screen.getByTestId('record-card')).toHaveTextContent('Ayşe Yılmaz');
    expect(screen.queryByTestId('record-owner')).not.toBeInTheDocument();
  });

  // The surface's ONE navigation. Everything else on the page is a selection;
  // deep work happens on the four-tab lead detail.
  it('offers exactly one way off the surface, into this person’s detail', () => {
    renderCard();

    const card = screen.getByTestId('record-card');
    const links = within(card).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/leads/p1');
  });

  it('says nobody is selected rather than rendering an empty card', () => {
    renderCard({ lead: null });

    expect(screen.getByTestId('record-card-idle')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  // The deal is a FIELD of the person now, not a place you navigate to.
  it('carries the SATIŞ section for the selected person, and asks for THEIR deals', async () => {
    renderCard();

    expect(await screen.findByTestId('record-sales')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/opportunities', { params: { leadId: 'p1' } });
  });

  it('does not go looking for deals when nobody is selected', async () => {
    renderCard({ lead: null });

    // Positive anchor: the idle card has rendered, so "no request" is a
    // settled fact rather than a race with the first paint.
    expect(screen.getByTestId('record-card-idle')).toBeInTheDocument();
    await waitFor(() => expect(get).not.toHaveBeenCalledWith('/opportunities', expect.anything()));
  });

  // Below lg the three columns cannot coexist, so the card arrives as a sheet.
  // It has to be dismissible or it traps the person who opened it.
  it('closes when the sheet is dismissed', async () => {
    const onClose = vi.fn();
    render(wrap(<LeadContextPane lead={person()} asSheet onClose={onClose} />));

    screen.getByRole('button', { name: 'Kapat' }).click();
    expect(onClose).toHaveBeenCalled();
  });
});

/**
 * The card is rendered ONCE by the surface and handed a different person as the
 * selection changes — it is not remounted by the router, because selecting is
 * not navigating. So every piece of per-person state inside it has to be reset
 * by something, and that something is `key`.
 *
 * This branch's lineage has already shipped the other outcome: a header that
 * kept lead A's phone number and dialled it under lead B's id. The stage
 * selector is the same shape of state — an optimistic value that outlives the
 * person it was set for is a control claiming a move that never happened.
 */
describe('LeadContextPane — per-person state is keyed, not carried', () => {
  it('drops a stage move that never landed when the selection changes and comes back', async () => {
    const user = userEvent.setup();
    // The move is issued and never answers: the optimistic value is live and
    // the server still says 's-new'. Exactly the window the bug lives in.
    post.mockImplementation((url: string) =>
      url.endsWith('/move') ? new Promise(() => {}) : Promise.resolve({ data: {} }),
    );

    const other = person({ id: 'p2', contactPerson: 'Başka Kişi' });
    const { rerender } = render(wrap(<LeadContextPane lead={person()} />));

    await screen.findByText('Happy Day Organizasyon');
    await user.click(screen.getByTestId('deal-stage-o1'));
    await user.click(await screen.findByRole('option', { name: 'Teklif gönderildi' }));
    // The optimistic value is showing — this is the state that must not survive.
    await waitFor(() =>
      expect(screen.getByTestId('deal-stage-o1')).toHaveTextContent('Teklif gönderildi'),
    );

    rerender(wrap(<LeadContextPane lead={other} />));
    await screen.findByText('Başka Kişi');
    rerender(wrap(<LeadContextPane lead={person()} />));

    // Back on the first person, the control must read what the SERVER says the
    // deal's stage is — not the move that is still in the air.
    const stage = await screen.findByTestId('deal-stage-o1');
    expect(stage).toHaveTextContent('Yeni');
    expect(stage).not.toHaveTextContent('Teklif gönderildi');
  });
});

/**
 * Stage 1 of fitting the inbox onto one screen: the record card gains the rest
 * of the person — their tasks, their offers, their estimates and their
 * appointments. Five sections now share one card, which is why every one of
 * these tests is about a section standing on its own.
 */
describe('LeadContextPane — the person’s remaining objects', () => {
  it('shows this person’s tasks and offers from ONE read of their record', async () => {
    renderCard();

    expect(await screen.findByText('Ara onu')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('record-offers')).getByText('Kurulum dahil'),
    ).toBeInTheDocument();

    // Both sections ride on the singular detail read — the same query key the
    // lead-detail page uses, so the two surfaces cannot disagree, and one
    // request serves two sections rather than two requests serving one each.
    const leadReads = get.mock.calls.filter(([url]) => String(url).startsWith('/leads/'));
    expect(leadReads).toHaveLength(1);
    expect(leadReads[0][0]).toBe('/leads/p1');
  });

  /**
   * TEKLİFLER reads `converted` from the FETCHED record, not from the card's
   * `lead` prop — and that is the whole point of the line.
   *
   * The prop is the row the LIST returned, which has no `convertedTenantId`.
   * Reading it from there would hide "Teklif" from nobody (`undefined` is
   * falsy) and quietly offer a new quote to a contact who is already a paying
   * tenant, on the one surface a rep spends their day on, while the lead detail
   * one click away refuses. The two tests below are a pair: the second is what
   * makes the first mean anything.
   */
  it('does not offer a new quote to a person who is already a paying tenant', async () => {
    routes['/leads/:id'] = () =>
      Promise.resolve({ data: { ...DETAIL_LEAD, convertedTenantId: 'tenant-9' } });
    renderCard();

    // The section has SETTLED — its offer row is on screen — so the missing
    // button is a decision and not a half-rendered card.
    const offers = await screen.findByTestId('record-offers');
    expect(within(offers).getByText('Kurulum dahil')).toBeInTheDocument();

    expect(within(offers).queryByRole('button', { name: 'Teklif' })).not.toBeInTheDocument();
  });

  it('offers one to a person who is not', async () => {
    renderCard();

    const offers = await screen.findByTestId('record-offers');
    expect(within(offers).getByText('Kurulum dahil')).toBeInTheDocument();

    expect(within(offers).getByRole('button', { name: 'Teklif' })).toBeInTheDocument();
  });

  // The deliberate eager/lazy split: a section whose data is already a field of
  // the person's own record costs nothing extra; a section with its own
  // endpoint waits until someone opens it. Five sections × every click is a lot
  // of requests for data most people do not have.
  it('asks for nothing on behalf of the two collapsed sections', async () => {
    renderCard();

    // Positive anchor: the eager reads have RESOLVED, so "no request" is a
    // settled fact and not a race with the first paint.
    expect(await screen.findByText('Ara onu')).toBeInTheDocument();

    expect(get).not.toHaveBeenCalledWith('/estimates', expect.anything());
    expect(get).not.toHaveBeenCalledWith('/calendars/bookings', expect.anything());
  });

  it('asks for THIS person’s estimates, and only once opened', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: /Tahmini fiyat/ }));

    expect(await screen.findByText('EST-A1B2')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/estimates', { params: { leadId: 'p1' } });
  });

  it('asks for THIS person’s appointments, and only once opened', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: /Randevular/ }));

    expect(await screen.findByText('Demo görüşmesi')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/calendars/bookings', { params: { leadId: 'p1' } });
  });

  // Still exactly one door off the surface, with four more sections on the
  // card. Selecting is not navigating.
  it('adds no second way off the surface', async () => {
    renderCard();

    await screen.findByText('Ara onu');
    const links = within(screen.getByTestId('record-card')).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/leads/p1');
  });

  /**
   * The same count with EVERY disclosure open — the assertion above only sees
   * closed sections, and a closed section renders nothing at all.
   *
   * Both new sections have an obvious link they must resist: PersonConsents
   * wants one to the compliance console, PersonCourses wants one to the course
   * editor. Either would quietly end "selecting is not navigating" on the one
   * card a rep reads before deciding whether to touch somebody.
   */
  it('adds no second way off the surface with all four disclosures open', async () => {
    const user = userEvent.setup();
    renderCard();

    for (const name of [/Tahmini fiyat/, /Randevular/, /Onaylar ve veri talepleri/, /Eğitimler/]) {
      await user.click(await screen.findByRole('button', { name }));
    }

    // Positive anchors: all four really rendered their bodies.
    expect(await screen.findByText('EST-A1B2')).toBeInTheDocument();
    expect(await screen.findByText('Demo görüşmesi')).toBeInTheDocument();
    expect(await screen.findByTestId('person-consents')).toBeInTheDocument();
    expect(await screen.findByText('Satış Temelleri')).toBeInTheDocument();

    const links = within(screen.getByTestId('record-card')).getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute('href', '/leads/p1');
  });

  it('asks for nothing on behalf of the consents and courses sections either', async () => {
    renderCard();

    // Positive anchor: the eager reads have RESOLVED, so "no request" is a
    // settled fact and not a race with the first paint.
    expect(await screen.findByText('Ara onu')).toBeInTheDocument();

    expect(get).not.toHaveBeenCalledWith(
      expect.stringContaining('/compliance/leads/'),
      expect.anything(),
    );
    expect(get).not.toHaveBeenCalledWith('/enrollments', expect.anything());
  });
});

/**
 * The two sections added on 2026-09-01, and the gates they travel with.
 *
 * Both are surfaces that used to live in the Settings area — the compliance
 * console (whose first step there is a lead search this card has already done)
 * and the person's course enrolments. Mounting them here without their gates
 * would re-host them under a weaker guard than the routes they came from.
 */
describe('LeadContextPane — the consents and courses sections', () => {
  it('reads THIS person’s consent record, and only once opened', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: /Onaylar ve veri talepleri/ }));

    expect(await screen.findByTestId('person-consents')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/compliance/leads/p1/consent');
  });

  /**
   * `ComplianceController` is class-level `@MarketingRoles('MANAGER')`. Ungated,
   * a REP opening this would collect a 403 and a permanent failure notice where
   * a permission answer belongs.
   */
  it('is not offered to a REP at all', async () => {
    setRole('REP');
    renderCard();

    // Positive anchor: the card IS up, so the absence is a decision.
    await screen.findByText('Ara onu');
    expect(screen.queryByTestId('record-consents')).not.toBeInTheDocument();
  });

  it('reads THIS person’s enrolments, and only once opened', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: /Eğitimler/ }));

    expect(await screen.findByText('Satış Temelleri')).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/enrollments', { params: { leadId: 'p1' } });
  });

  /**
   * Hidden rather than NAMED, unlike the appointments section's plan notice:
   * without `memberships` there is no course to be enrolled in at all, so there
   * is nothing behind the notice a plan line would promise.
   */
  it('is absent without the memberships entitlement', async () => {
    features = { funnels: true, memberships: false };
    renderCard();

    await screen.findByText('Ara onu');
    // Positive anchor: the other gated section is still here, so this is about
    // `memberships` and not about a card that failed to render.
    expect(await screen.findByTestId('record-appointments')).toBeInTheDocument();
    expect(screen.queryByTestId('record-courses')).not.toBeInTheDocument();
  });
});

/**
 * The card's central rule, now that five sections share it: a section that
 * cannot be read says so BY NAME, does not blank the card, and is never
 * mistaken for a section that is simply empty.
 */
describe('LeadContextPane — a broken section names itself and stands alone', () => {
  it('names Görevler and Teklifler when their shared read fails, and keeps the card', async () => {
    routes['/leads/:id'] = () => Promise.reject(new Error('boom'));
    renderCard();

    // Each section owes its OWN sentence — "something failed" on a five-section
    // card tells a rep nothing about what they are missing.
    //
    // This used to wait 8s, because `useLeadRecord` retries a non-404 twice
    // before conceding and the wait was outrunning a real 1+2s backoff. That
    // made a timing coincidence the only witness to the retry COUNT; the count
    // is now asserted directly in useLeadRecord.test.tsx and the backoff is
    // zeroed in `wrap`, so what is left here is the only thing this test was
    // ever about: which sentence the section ends up showing.
    expect(await screen.findByText('Görevler yüklenemedi.')).toBeInTheDocument();
    expect(screen.getByText('Teklifler yüklenemedi.')).toBeInTheDocument();

    // A failure is not an empty person: the words for "no tasks" must NOT be
    // on screen, or a rep reads "nothing to do" off a request that never
    // answered.
    expect(screen.queryByTestId('tasks-empty')).not.toBeInTheDocument();
    expect(screen.queryByTestId('offers-empty')).not.toBeInTheDocument();

    // ...and the rest of the card is untouched: identity, and the SATIŞ
    // section's own healthy read.
    expect(screen.getByTestId('record-card')).toHaveTextContent('Ayşe Yılmaz');
    expect(await screen.findByText('Happy Day Organizasyon')).toBeInTheDocument();
  });

  it('names Tahmini fiyat when its read fails, without touching Randevular', async () => {
    const user = userEvent.setup();
    routes['/estimates'] = () => Promise.reject(new Error('boom'));
    renderCard();

    await user.click(await screen.findByRole('button', { name: /Tahmini fiyat/ }));
    expect(await screen.findByText('Tahmini fiyatlar yüklenemedi.')).toBeInTheDocument();
    expect(screen.queryByTestId('estimates-empty')).not.toBeInTheDocument();

    // The neighbour still opens and still works.
    await user.click(screen.getByRole('button', { name: /Randevular/ }));
    expect(await screen.findByText('Demo görüşmesi')).toBeInTheDocument();
  });

  it('says a person has no estimates in words a failure never uses', async () => {
    const user = userEvent.setup();
    routes['/estimates'] = () => Promise.resolve({ data: [] });
    renderCard();

    await user.click(await screen.findByRole('button', { name: /Tahmini fiyat/ }));
    expect(await screen.findByTestId('estimates-empty')).toBeInTheDocument();
    expect(screen.queryByText('Tahmini fiyatlar yüklenemedi.')).not.toBeInTheDocument();
  });
});

/**
 * RANDEVULAR appears with its gate, or it does not appear.
 *
 * `MarketingBookingController` is `@MarketingRoles('MANAGER')` +
 * `@RequiresFeature('funnels')`, so the read behind this section 403s for a REP
 * — the role that lives on this surface — and for any workspace without the
 * add-on. Rendered ungated it produced a global error toast and a permanent
 * "Randevular yüklenemedi." with a Retry that could never succeed: a permission
 * answer dressed up as a failure.
 *
 * The two gates get DIFFERENT answers, because the person reading them can act
 * on one and not the other:
 *
 * - **Role: hidden.** A REP cannot buy their way out of their own role, and
 *   `navigation.ts` already hides `/appointments` from them (`managerOnly`).
 *   Naming it would make this card the only place a REP is told a surface they
 *   can never reach exists.
 * - **Plan: named.** This is `PersonPane`'s `conversationAi` case one column
 *   over, and the same rule LeadStream states outright — COULD NOT READ IT and
 *   YOUR PLAN DOES NOT INCLUDE IT stay two sentences, because a plan limit told
 *   as a failure sends a billing question to support.
 */
describe('LeadContextPane — RANDEVULAR appears with its gate', () => {
  it('gives a manager in an entitled workspace the section itself', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(await screen.findByRole('button', { name: /Randevular/ }));
    expect(await screen.findByText('Demo görüşmesi')).toBeInTheDocument();
  });

  it('does not show a REP a section that can only 403', async () => {
    setRole('REP');
    renderCard();

    // Positive anchor: the card's ungated sections have rendered, so the
    // absence below is a decision rather than a race with the first paint.
    expect(await screen.findByText('Ara onu')).toBeInTheDocument();

    expect(screen.queryByTestId('record-appointments')).not.toBeInTheDocument();
    expect(screen.queryByTestId('record-appointments-gated')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Randevular/ })).not.toBeInTheDocument();

    // Nothing was asked for on its behalf, so there is no 403 to report — and
    // in particular no failure sentence and no Retry that can never succeed.
    await waitFor(() =>
      expect(get).not.toHaveBeenCalledWith('/calendars/bookings', expect.anything()),
    );
    expect(screen.queryByText('Randevular yüklenemedi.')).not.toBeInTheDocument();

    // The rest of the person is untouched — a gate on one section is not a
    // gate on the card.
    expect(screen.getByTestId('record-card')).toHaveTextContent('Ayşe Yılmaz');
    expect(await screen.findByRole('button', { name: /Tahmini fiyat/ })).toBeInTheDocument();
  });

  it('tells a manager without the plan line which line is missing, not that it broke', async () => {
    features = {};
    renderCard();

    const gated = await screen.findByTestId('record-appointments-gated');
    expect(gated).toHaveTextContent('Randevular paketinde yok');
    // The section still says its own NAME, so a manager can tell WHICH part of
    // the record their plan is withholding.
    expect(gated).toHaveTextContent('Randevular');

    // Not a failure, and not an empty person either — the three stay three.
    expect(screen.queryByText('Randevular yüklenemedi.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('appointments-empty')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(get).not.toHaveBeenCalledWith('/calendars/bookings', expect.anything()),
    );

    // And no toggle: a control that opens onto a plan notice is an affordance
    // for nothing, which is the shape this whole fix exists to remove.
    expect(screen.queryByRole('button', { name: /Randevular/ })).not.toBeInTheDocument();
  });

  it('gates on the plan for an OWNER too — the role check is a floor, not an exemption', async () => {
    setRole('OWNER');
    features = {};
    renderCard();

    expect(await screen.findByTestId('record-appointments-gated')).toBeInTheDocument();
    expect(screen.queryByText('Randevular yüklenemedi.')).not.toBeInTheDocument();
  });
});

/**
 * The lazy sections hold per-person state — whether they are open — and the
 * card is handed a new person rather than remounted. Left unkeyed, "I opened
 * Randevular for Ayşe" would silently become "Randevular is open for whoever
 * is selected next", and the section would fire a request for a person nobody
 * asked about. Same mechanism, same reason, as the SATIŞ section's `key`.
 */
describe('LeadContextPane — the disclosures are keyed to the person', () => {
  it('closes an opened section when the selection changes and comes back', async () => {
    const user = userEvent.setup();
    const other = person({ id: 'p2', contactPerson: 'Başka Kişi' });
    const { rerender } = render(wrap(<LeadContextPane lead={person()} />));

    await user.click(await screen.findByRole('button', { name: /Randevular/ }));
    expect(await screen.findByText('Demo görüşmesi')).toBeInTheDocument();

    rerender(wrap(<LeadContextPane lead={other} />));
    await screen.findByText('Başka Kişi');
    rerender(wrap(<LeadContextPane lead={person()} />));

    // Positive anchor: the section is on screen and says it is CLOSED, rather
    // than an absence that would also pass against a half-rendered card.
    const toggle = await screen.findByRole('button', { name: /Randevular/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Demo görüşmesi')).not.toBeInTheDocument();
  });
});
