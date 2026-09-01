/**
 * The person surface's LEFT COLUMN, and its four arrangements of the same
 * people: Liste · Hat · Takvim · Görevler (2026-09-01 design, stage 2).
 *
 * ## Why this spec exists
 *
 * Stage 1's reviewer noted that nothing in the browser suite touched the record
 * card or the surface's columns at all — the whole three-column layout was
 * covered only by jsdom, where every embedded page is a `vi.mock` and the CSS
 * that decides which column is on screen does not exist. Stage 2 adds three
 * LAZY chunks to that column, and a lazy chunk is precisely the thing unit
 * tests cannot vouch for: a wrong import path, a bad default export or a
 * circular import compiles, passes vitest against the mock, and fails only in a
 * browser.
 *
 * So this is deliberately thin on assertions about what each view CONTAINS —
 * opportunities.spec.ts already owns the board, and each page owns its own unit
 * tests — and thick on the two things only a browser can answer:
 *
 *   1. each arrangement really MOUNTS from the surface, at 1440px, in the left
 *      column, with the other two columns still standing;
 *   2. **the selected person survives a view switch**, which is the design's
 *      own sentence for what the switcher is FOR ("hattan birine tıklayıp aynı
 *      ekranda yazışmasını okursun; seçili kişi görünüm değişince korunur").
 *
 * ## Notes on the assertions
 *
 * The tab strip is a real `role="tablist"`, so the tabs are located by role and
 * accessible name rather than by test id. Every Turkish string asserted here is
 * in src/i18n/locales/tr/marketing.json (locale is pinned tr-TR):
 * `surface.view.list|board|calendar|tasks`, `surface.title`,
 * `surface.card.idle`, `surface.card.owner`, `surface.people.empty.title`.
 *
 * The three frozen routes these views borrow are asserted to still resolve on
 * their own, because the whole bargain of stage 2 is that the menu collapses
 * and the URLs do not.
 *
 * If this fails: either a view's chunk does not load in a browser, or the
 * switcher has become a navigation — which is the one thing this surface exists
 * to have stopped doing.
 */
import { test, expect } from './support/fixtures';
import { apiUrl } from './support/config';

/** The lazy view chunks pay a Vite on-demand transform on first mount. */
const LAZY = { timeout: 20_000 };

const stamp = () => `${Date.now()}-${Math.floor(Math.random() * 1000)}`;

test('the left column switches between four arrangements without disturbing the other two', async ({
  app,
}) => {
  await app.goto('/inbox');
  await expect(app.getByRole('heading', { level: 1, name: 'Kişiler' })).toBeVisible();

  const tabs = app.getByRole('tablist', { name: 'Görünüm' });
  await expect(tabs).toBeVisible();
  await expect(tabs.getByRole('tab')).toHaveCount(4);
  // Liste is where a session starts — the daily arrangement.
  await expect(tabs.getByRole('tab', { name: 'Liste' })).toHaveAttribute('aria-selected', 'true');

  // Hat — the kanban, seeded by PipelinesService for a fresh workspace. Located
  // by the "Hatta değil" column's test id rather than its heading: the record
  // card's SATIŞ section says "Bu kişi hatta değil.", and Playwright's text
  // matching is a case-insensitive SUBSTRING, so the heading alone would be
  // ambiguous the moment somebody is selected.
  await tabs.getByRole('tab', { name: 'Hat' }).click();
  await expect(app).toHaveURL(/left=board/);
  await expect(app.getByTestId('column-not-in-pipeline')).toBeVisible(LAZY);
  // The middle column never went anywhere: with nobody selected it still says
  // so, rather than being replaced by the board.
  await expect(app.getByText('Soldan bir kişi seç.').first()).toBeVisible();

  // Takvim — the month of tasks.
  //
  // NOT anchored on "Bugün". That button lives in the month-navigation Card
  // ABOVE the agenda, so it is visible whether or not the month itself
  // rendered — which is exactly how this view shipped broken and green: the
  // agenda was `display:none` at every width >= 768px (CalendarPage passed
  // `undefined`, CalendarAgenda's `?? 'md:hidden'` read that as "hide me"), so
  // the Takvim column was a nav bar over empty space and every test in the
  // repo still passed. jsdom cannot see it either — `findByTestId` matches a
  // display:none node happily, and Tailwind's classes are never applied there.
  // The agenda's own BOX is the only witness. `calendar-has-a-task` below goes
  // one further and puts a real task chip in it.
  await tabs.getByRole('tab', { name: 'Takvim' }).click();
  await expect(app).toHaveURL(/left=calendar/);
  await expect(app.getByTestId('calendar-agenda')).toBeVisible(LAZY);
  await expect(app.getByTestId('column-not-in-pipeline')).toHaveCount(0);

  // Görevler — the task list, empty on a fresh workspace and SAYING so.
  await tabs.getByRole('tab', { name: 'Görevler' }).click();
  await expect(app).toHaveURL(/left=tasks/);
  await expect(app.getByText('Burada görev yok.')).toBeVisible(LAZY);

  // …and back to the list, which drops the parameter rather than spelling the
  // default out.
  await tabs.getByRole('tab', { name: 'Liste' }).click();
  await expect(app).not.toHaveURL(/left=/);
  await expect(app.getByText('Bu kuyrukta kimse yok')).toBeVisible();
});

test('the person selected in the list is still open after the column changes shape', async ({
  app,
  api,
  workspace,
}) => {
  const suffix = stamp();
  const businessName = `Kahve Durağı ${suffix}`;
  const contactPerson = `Ayşe Yılmaz ${suffix}`;

  // Seeded out of band: the creation flow is leads.spec.ts's job, and what is
  // under test here is what happens to a SELECTION.
  const created = await api.post(apiUrl('/marketing/leads'), {
    headers: { Authorization: `Bearer ${workspace.session.accessToken}` },
    data: {
      businessName,
      contactPerson,
      businessType: 'OTHER',
      source: 'WEBSITE',
      city: 'İzmir',
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  await app.goto('/inbox');

  // Nobody is open yet — the record card says so by name.
  await expect(app.getByText('Soldan bir kişi seç.').first()).toBeVisible();

  await app.getByRole('button', { name: new RegExp(contactPerson) }).click();

  // Selected: the record card is now this person's, and it is NOT a navigation.
  await expect(app.getByText('Sahibi')).toBeVisible();
  await expect(app.getByRole('link', { name: /Kaydı aç/ })).toBeVisible();
  await expect(app).toHaveURL(/\/inbox(\?|$)/);

  const tabs = app.getByRole('tablist', { name: 'Görünüm' });

  // The switch the whole stage is for. The left column becomes a kanban and the
  // person stays open beside it.
  await tabs.getByRole('tab', { name: 'Hat' }).click();
  await expect(app.getByTestId('column-not-in-pipeline')).toBeVisible(LAZY);
  await expect(app.getByRole('link', { name: /Kaydı aç/ })).toBeVisible();
  await expect(app.getByText('Soldan bir kişi seç.')).toHaveCount(0);

  // …and through two more arrangements, then back to the list, still open.
  await tabs.getByRole('tab', { name: 'Görevler' }).click();
  await expect(app.getByText('Burada görev yok.')).toBeVisible(LAZY);
  await expect(app.getByRole('link', { name: /Kaydı aç/ })).toBeVisible();

  await tabs.getByRole('tab', { name: 'Liste' }).click();
  await expect(app.getByRole('link', { name: /Kaydı aç/ })).toBeVisible();
  // The row itself still reports the selection, which is what keeps the three
  // columns agreeing about who is open.
  await expect(app.getByRole('button', { name: new RegExp(contactPerson) })).toHaveAttribute(
    'aria-current',
    'true',
  );
});

test('every page the left column borrows still resolves at its own URL', async ({ app }) => {
  // The bargain of the one-screen work: the menu collapses, the routes do not.
  // navigation.test.ts freezes the path SET; only a browser proves each one
  // still mounts a page rather than a blank shell.
  await app.goto('/opportunities');
  await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(app.getByTestId('column-not-in-pipeline')).toBeVisible(LAZY);

  await app.goto('/calendar');
  await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(app.getByRole('button', { name: 'Bugün' })).toBeVisible(LAZY);

  await app.goto('/tasks');
  await expect(app.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(app.getByText('Burada görev yok.')).toBeVisible(LAZY);
});


/**
 * The Takvim view shows a task, at a desktop width, INSIDE the agenda.
 *
 * The regression this exists for was not "the calendar is missing" — it was
 * "the calendar is present, mounted, in the DOM, and 0px tall". Only a real
 * browser can tell those apart: Tailwind's `md:hidden` is a stylesheet rule,
 * jsdom applies no stylesheet, and `getByTestId` resolves a `display:none`
 * node like any other. So the whole unit suite was green against a view a user
 * could not see.
 *
 * Asserting on the CHIP rather than on the agenda container is what makes this
 * hard to fool. A container can be visible and empty; a chip is visible only
 * if the agenda painted, the month resolved the task onto the right day, and
 * nothing above it collapsed the column. It is scoped `within` the agenda so
 * a title rendered anywhere else on the surface cannot stand in for it.
 *
 * Two widths, because the bug was width-dependent in one direction: `md:` is a
 * min-width rule, so the broken build was correct below 768px and wrong above
 * it. A test that only ran narrow would have passed on the broken code.
 */
test('the Takvim view shows a real task chip inside the agenda, at desktop width', async ({
  app,
  api,
  workspace,
}) => {
  // Mid-month at noon, so no timezone or month-boundary rounding can move the
  // task into a month the view is not showing. The page opens on the current
  // month and the agenda lists only current-month days.
  const now = new Date();
  const due = new Date(now.getFullYear(), now.getMonth(), 15, 12, 0, 0);
  const title = `Takvim görevi ${stamp()}`;

  const created = await api.post(apiUrl('/marketing/tasks'), {
    headers: { Authorization: `Bearer ${workspace.session.accessToken}` },
    data: { title, type: 'CALL', priority: 'HIGH', dueDate: due.toISOString() },
  });
  expect(created.status(), await created.text()).toBe(201);

  for (const width of [1440, 900]) {
    await app.setViewportSize({ width, height: 900 });
    await app.goto('/inbox?left=calendar');

    const agenda = app.getByTestId('calendar-agenda');
    await expect(agenda, `agenda must have a box at ${width}px`).toBeVisible(LAZY);

    // The chip itself, scoped to the agenda. `toBeVisible` fails on an empty
    // bounding box, which is what a `display:none` ancestor produces — the
    // exact shape of the bug.
    const chip = agenda.getByText(title, { exact: true });
    await expect(chip, `task chip must be visible at ${width}px`).toBeVisible(LAZY);

    // …and really INSIDE it, rather than merely matching the same string
    // somewhere the locator happened to reach.
    const outer = await agenda.boundingBox();
    const inner = await chip.boundingBox();
    expect(outer, `agenda box at ${width}px`).not.toBeNull();
    expect(inner, `chip box at ${width}px`).not.toBeNull();
    expect(outer!.height).toBeGreaterThan(inner!.height);
    expect(inner!.y).toBeGreaterThanOrEqual(outer!.y);
    expect(inner!.y + inner!.height).toBeLessThanOrEqual(outer!.y + outer!.height + 1);
  }
});

/**
 * The left column is ONE width, and the board scrolls instead of the
 * conversation shrinking.
 *
 * The three non-list views briefly had a wider column so the kanban would show
 * more than one stage. Measured, that cost the message stream 93px at 1440 and
 * 78px at 1280 and bought a third of a column — see InboxPage's comment for
 * the table. This pins the outcome of that trade in the only place it is real:
 * layout, in a browser.
 *
 * The scroll assertion is the other half. Narrow columns are only acceptable
 * because an off-screen stage is reachable — if `overflow-x-auto` were ever
 * dropped from `board-columns`, dragging a deal to a stage you cannot see
 * would become impossible rather than awkward, and nothing else would notice.
 */
test('the left column keeps one width across views, and the board scrolls instead', async ({
  app,
}) => {
  await app.setViewportSize({ width: 1440, height: 900 });

  await app.goto('/inbox');
  await expect(app.getByTestId('surface-list')).toBeVisible(LAZY);
  const listWidth = (await app.getByTestId('surface-list').boundingBox())!.width;
  const listStream = (await app.getByTestId('surface-pane').boundingBox())!.width;

  await app.goto('/inbox?left=board');
  await expect(app.getByTestId('column-not-in-pipeline')).toBeVisible(LAZY);
  const boardWidth = (await app.getByTestId('surface-list').boundingBox())!.width;
  const boardStream = (await app.getByTestId('surface-pane').boundingBox())!.width;

  // Same column, whichever way the people are arranged.
  expect(Math.abs(boardWidth - listWidth)).toBeLessThan(1);
  expect(Math.abs(boardStream - listStream)).toBeLessThan(1);
  // And the conversation is not squeezed below a width you can read a thread
  // in. 280.3px was what the wide column left at 1280; this is the floor that
  // says never again.
  expect(boardStream).toBeGreaterThan(400);

  // The board overflows its column — as it must, with seven stages — and can
  // be scrolled to reach the ones off screen.
  const scrolled = await app.evaluate(() => {
    const el = document.querySelector('[data-testid="board-columns"]') as HTMLElement | null;
    if (!el) return null;
    el.scrollLeft = 600;
    return { client: el.clientWidth, scroll: el.scrollWidth, left: el.scrollLeft };
  });
  expect(scrolled).not.toBeNull();
  expect(scrolled!.scroll).toBeGreaterThan(scrolled!.client);
  expect(scrolled!.left).toBeGreaterThan(0);
});

/**
 * Stage 3: `Grupla: Şirkete göre`, against the real backend sort.
 *
 * `Şirketler` left the menu to become this control, so the two things it has to
 * be true about are the two this test asserts, in a browser, on CONTENT:
 *
 *   1. **it really groups** — the order is the SERVER's (`sortBy=company`,
 *      settled across the whole filtered set) and not a client-side shuffle of
 *      whatever landed on the page, so a company's people are contiguous and
 *      the blocks arrive in name order rather than in companyId order;
 *   2. **nobody is dropped** — a person with no company gets a named block of
 *      their own and stays selectable. That is the failure this whole line of
 *      work exists to prevent, and it is invisible to a test that only checks
 *      the grouped people are grouped.
 *
 * The names are seeded so the two orders DISAGREE: the company created first
 * (and therefore holding the lexicographically smaller uuid, roughly) is the
 * one named "ZZZ…". An implementation keyed on companyId gets a different
 * answer, and a client-side sort of the page would get the right one for the
 * wrong reason — hence the third person, created LAST, who must nonetheless
 * come last.
 */
test('the people list groups by company, and the ones without a company keep a block', async ({
  app,
  api,
  workspace,
}) => {
  const suffix = stamp();
  const auth = { Authorization: `Bearer ${workspace.session.accessToken}` };

  const company = async (name: string) => {
    const res = await api.post(apiUrl('/marketing/companies'), { headers: auth, data: { name } });
    expect(res.status(), await res.text()).toBe(201);
    return (await res.json()).id as string;
  };
  const lead = async (contactPerson: string, companyId?: string) => {
    const res = await api.post(apiUrl('/marketing/leads'), {
      headers: auth,
      data: {
        businessName: `Firma ${contactPerson}`,
        contactPerson,
        businessType: 'OTHER',
        source: 'WEBSITE',
        ...(companyId ? { companyId } : {}),
      },
    });
    expect(res.status(), await res.text()).toBe(201);
  };

  const zeta = await company(`ZZZ Şirket ${suffix}`);
  const acme = await company(`AAA Şirket ${suffix}`);
  const inZeta = `Zeynep ${suffix}`;
  const inAcme = `Ahmet ${suffix}`;
  const noCompany = `Yalnız ${suffix}`;
  await lead(inZeta, zeta);
  await lead(inAcme, acme);
  await lead(noCompany);

  await app.goto('/inbox');
  // Ungrouped to begin with: the owner's activity sort, no headers.
  await expect(app.getByRole('button', { name: new RegExp(noCompany) })).toBeVisible();
  await expect(app.getByText('Şirketsiz', { exact: true })).toHaveCount(0);

  const toggle = app.getByTestId('group-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();

  await expect(app).toHaveURL(/group=company/);
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  // Every header, and the trailing one by name. `Şirketsiz` is the assertion
  // that matters most: it is the block for the majority of most workspaces.
  await expect(app.getByText(`AAA Şirket ${suffix}`, { exact: true })).toBeVisible();
  await expect(app.getByText(`ZZZ Şirket ${suffix}`, { exact: true })).toBeVisible();
  await expect(app.getByText('Şirketsiz', { exact: true })).toBeVisible();

  // ORDER, in the DOM, which is the only place "it grouped" is distinguishable
  // from "it rendered three headers". Read off the rendered column rather than
  // from three separate locators, so a header in the wrong block fails here.
  const order = await app.evaluate(() =>
    Array.from(document.querySelectorAll('[data-testid="surface-list"] li')).map(
      (li) => (li.textContent ?? '').trim(),
    ),
  );
  const at = (needle: string) => order.findIndex((line) => line.includes(needle));
  expect(at(`AAA Şirket ${suffix}`)).toBeGreaterThanOrEqual(0);
  expect(at(inAcme)).toBeGreaterThan(at(`AAA Şirket ${suffix}`));
  expect(at(`ZZZ Şirket ${suffix}`)).toBeGreaterThan(at(inAcme));
  expect(at(inZeta)).toBeGreaterThan(at(`ZZZ Şirket ${suffix}`));
  // Last, though they were created last and would sort FIRST by activity.
  expect(at('Şirketsiz')).toBeGreaterThan(at(inZeta));
  expect(at(noCompany)).toBeGreaterThan(at('Şirketsiz'));

  // A grouping is not a filter, and it is not a navigation either: the person
  // with no company is still selectable, and the record card opens beside them.
  await app.getByRole('button', { name: new RegExp(noCompany) }).click();
  await expect(app.getByRole('link', { name: /Kaydı aç/ })).toBeVisible();
  await expect(app).toHaveURL(/group=company/);
});

/**
 * Stage 4 takes /opportunities, /calendar and /tasks out of the menu, and the
 * three views that embed them keep a door back to the full page.
 *
 * The one capability that genuinely lives only at the full route is the
 * calendar's seven-column month GRID: `CalendarPage` renders the agenda when
 * embedded because Tailwind v3 has no container queries, so the grid's `md:`
 * breakpoints read the VIEWPORT and its cells collapse to ~85px inside this
 * column. So the link is followed here and the grid asserted on the other side
 * — a door proved by walking through it, not by reading its `href`.
 */
test('each embedded view offers a link to its own full page, and the calendar grid is behind it', async ({
  app,
}) => {
  await app.setViewportSize({ width: 1440, height: 900 });

  await app.goto('/inbox');
  // Not on Liste: that view IS this page.
  await expect(app.getByRole('link', { name: /Tam sayfa aç/ })).toHaveCount(0);

  await app.goto('/inbox?left=calendar');
  await expect(app.getByTestId('calendar-agenda')).toBeVisible(LAZY);
  // Embedded, the grid is not rendered at all — which is what the link is for.
  await expect(app.getByTestId('calendar-grid')).toHaveCount(0);

  await app.getByRole('link', { name: /Tam sayfa aç/ }).click();
  await expect(app).toHaveURL(/\/calendar/);
  await expect(app.getByTestId('calendar-grid')).toBeVisible(LAZY);

  for (const [left, url] of [
    ['board', /\/opportunities/],
    ['tasks', /\/tasks/],
  ] as const) {
    await app.goto(`/inbox?left=${left}`);
    await app.getByRole('link', { name: /Tam sayfa aç/ }).click();
    await expect(app).toHaveURL(url);
    await expect(app.getByRole('heading', { level: 1 })).toBeVisible(LAZY);
  }
});

/**
 * The record card, in a browser — the right column, at desktop width.
 *
 * Until now this was the one stage-1 surface with NO browser assertion at all.
 * That is exactly the gap this branch has already fallen into once: stage 2
 * shipped a Takvim view that rendered nothing while 126 jsdom tests stayed
 * green, because jsdom applies no stylesheet and `getByTestId` resolves a
 * `display:none` node like any other. The card is five sections stacked in a
 * `lg:max-w-xs` column — 320px — which is precisely the kind of layout where
 * "mounted" and "legible" come apart.
 *
 * So every assertion here anchors on content INSIDE a section, never on the
 * heading above it. A heading is chrome that survives its own body collapsing;
 * that is how the Takvim bug hid ("Bugün" lived in the nav Card above the
 * agenda and stayed visible while the agenda was 0px tall). `offers-empty` /
 * `tasks-empty` / `estimates-empty` / `appointments-empty` are each the
 * SETTLED, successful answer of their own section, so seeing one means the
 * section's read resolved AND its body painted.
 *
 * The two disclosures are opened, which nothing had ever done in a browser:
 * they are `open && children`, so a closed one has no body at all, and the
 * assertion pair (absent → click → visible) is what tells "the toggle works"
 * apart from "the body was always there".
 */
test('the record card renders its sections inside the 320px column, and both disclosures open', async ({
  app,
  api,
  workspace,
}) => {
  await app.setViewportSize({ width: 1440, height: 900 });

  const suffix = stamp();
  const contactPerson = `Kayıt Kişisi ${suffix}`;
  const created = await api.post(apiUrl('/marketing/leads'), {
    headers: { Authorization: `Bearer ${workspace.session.accessToken}` },
    data: {
      businessName: `Kayıt Firma ${suffix}`,
      contactPerson,
      businessType: 'OTHER',
      source: 'WEBSITE',
    },
  });
  expect(created.status(), await created.text()).toBe(201);

  await app.goto('/inbox');
  await app.getByRole('button', { name: new RegExp(contactPerson) }).click();

  const card = app.getByTestId('record-card');
  await expect(card).toBeVisible(LAZY);

  // The column really is the narrow one the design asks for. If this ever
  // widens, the legibility assertions below stop meaning what they say.
  const cardBox = (await card.boundingBox())!;
  expect(cardBox.width).toBeLessThanOrEqual(320);

  /** A section is legible when its own body has a box, inside the card's. */
  const bodyFitsTheColumn = async (sectionId: string, bodyId: string) => {
    const section = card.getByTestId(sectionId);
    await expect(section, `${sectionId} must be on screen`).toBeVisible(LAZY);
    const body = section.getByTestId(bodyId);
    await expect(body, `${bodyId} must be visible inside ${sectionId}`).toBeVisible(LAZY);

    const box = (await body.boundingBox())!;
    expect(box.width, `${bodyId} must have a width`).toBeGreaterThan(0);
    expect(box.height, `${bodyId} must have a height`).toBeGreaterThan(0);
    // …and inside the column rather than spilling out of it, which is the
    // failure a 320px column produces and a full-width jsdom never can.
    expect(box.x).toBeGreaterThanOrEqual(cardBox.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(cardBox.x + cardBox.width + 1);
  };

  // The two EAGER sections, both riding on one `GET /leads/:id`. A fresh
  // person has neither an offer nor a task, so each renders its own empty
  // sentence — a settled answer, not a failure and not a blank.
  await expect(card.getByRole('heading', { name: 'Teklifler' })).toBeVisible(LAZY);
  await expect(card.getByRole('heading', { name: 'Görevler' })).toBeVisible();
  await bodyFitsTheColumn('record-offers', 'offers-empty');
  await bodyFitsTheColumn('record-tasks', 'tasks-empty');

  // TAHMİNİ FİYAT — a disclosure, so there is nothing behind it until it is
  // opened. Both halves asserted: the body is absent first.
  const estimates = card.getByTestId('record-estimates');
  await expect(estimates).toBeVisible();
  await expect(estimates.getByTestId('estimates-empty')).toHaveCount(0);
  await estimates.getByRole('button').click();
  await bodyFitsTheColumn('record-estimates', 'estimates-empty');

  // RANDEVULAR — the same, one gate further in. The e2e owner is a MANAGER on
  // a plan that includes `funnels`, so this is the ungated branch: the
  // disclosure itself, not the plan notice that stands in for it.
  const appointments = card.getByTestId('record-appointments');
  await expect(appointments).toBeVisible();
  await expect(appointments.getByTestId('appointments-empty')).toHaveCount(0);
  await appointments.getByRole('button').click();
  await bodyFitsTheColumn('record-appointments', 'appointments-empty');

  // Still exactly one door off the surface, with all five sections open.
  await expect(card.getByRole('link')).toHaveCount(1);
  await expect(card.getByRole('link', { name: /Kaydı aç/ })).toBeVisible();
});
