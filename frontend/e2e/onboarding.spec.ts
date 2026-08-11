/**
 * Onboarding — what a brand-new workspace is actually told to do.
 *
 * The product owner's complaint was "I open the system and don't know what to
 * do". The checklist existed and worked; it was just outranked on the page by
 * a louder CTA telling people to type in a lead by hand. These tests pin the
 * order, because ordering regressions are invisible to unit tests.
 */
import {
  test,
  expect,
  E2E_PRODUCT_URL,
  E2E_PRODUCT_DESCRIPTION,
} from './support/fixtures';

test('a new workspace is shown the setup guide before anything else', async ({ app }) => {
  await app.goto('/dashboard');

  const checklist = app.getByTestId('getting-started');
  await expect(checklist).toBeVisible();

  await expect(app.getByTestId('dashboard-hero')).toBeVisible();

  // Order, not just presence — that is the whole point of the change, and it
  // is exactly what a unit test cannot see. compareDocumentPosition returns
  // FOLLOWING when the hero comes after the checklist.
  const heroFollowsChecklist = await app.evaluate(() => {
    const list = document.querySelector('[data-testid="getting-started"]');
    const hero = document.querySelector('[data-testid="dashboard-hero"]');
    if (!list || !hero) return null;
    // eslint-disable-next-line no-bitwise
    return (list.compareDocumentPosition(hero) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  });
  expect(heroFollowsChecklist, 'the setup guide must precede the hero CTA').toBe(true);
});

test('the first outstanding step is called out and leads to the strategy wizard', async ({ app }) => {
  await app.goto('/dashboard');

  const next = app.getByTestId('onboarding-next-step');
  await expect(next).toBeVisible();
  await expect(next).toContainText(/buradan başla/i);
  // The strategy is the brain that drives the rest of the product, so it is
  // step one — not a manual lead entry.
  await expect(next).toHaveAttribute('href', '/onboarding/strategy');

  await next.click();
  await expect(app).toHaveURL(/\/onboarding\/strategy/);
  await expect(
    app.getByRole('heading', { name: /pazarlama stratejini oluştur/i }),
  ).toBeVisible();
});

test('dismissing the guide sticks to the workspace, not the browser', async ({ app, workspace }) => {
  await app.goto('/dashboard');
  const checklist = app.getByTestId('getting-started');
  await expect(checklist).toBeVisible();

  // Scope the dismiss button to the card. A page-wide role lookup can match
  // any other close affordance that happens to be mounted.
  const write = app.waitForResponse(
    (r) => r.url().includes('/marketing/onboarding') && r.request().method() === 'PATCH',
  );
  await checklist.getByRole('button', { name: /kapat|dismiss/i }).click();
  await expect(checklist).toBeHidden();

  // Wait for the write to land before reloading — otherwise the reload races
  // the optimistic update and the test, not the product, is what's flaky.
  await write;

  // A reload proves it reached the server. Dismissal used to live only in
  // localStorage, so it was a per-device opinion: put the guide away on a
  // laptop and it was still waiting on a phone, and clearing site data nagged
  // a fully configured workspace all over again.
  await app.reload();
  await expect(app.getByRole('navigation').first()).toBeVisible();
  await expect(app.getByTestId('getting-started')).toBeHidden();

  // Same workspace, brand-new browser context — the state is on the workspace.
  expect(workspace.id).toMatch(/^[0-9a-f-]{36}$/);
});

test('the strategy wizard is pre-filled from what signup already collected', async ({ app }) => {
  await app.goto('/onboarding/strategy');

  // Signup asks for the website and a one-liner and tells the user the AI will
  // use them — then the wizard asked for exactly the same two things again,
  // which reads as "nothing you typed was kept".
  await expect(app.locator(`input[value="${E2E_PRODUCT_URL}"]`)).toBeVisible();
  await expect(app.getByText(E2E_PRODUCT_DESCRIPTION, { exact: false })).toBeVisible();
});

test('the checklist demands three human steps, not eight chores', async ({ app }) => {
  await app.goto('/dashboard');

  const checklist = app.getByTestId('getting-started');
  await expect(checklist).toBeVisible();

  // Down from eight: agent, knowledge, brand brain, first lead and site are
  // now BYPRODUCTS of the strategy (intake starts the Brand Brain with
  // autoApply, synthesis provisions the default agent, research generates
  // leads). Listing them as steps was asking the user to do the system's job.
  await expect(checklist.getByRole('link')).toHaveCount(3);
  await expect(checklist.getByText('3 adımdan 0 tamamlandı')).toBeVisible();

  // What remains is what only a human can do.
  await expect(checklist.getByText('Büyüme stratejini oluştur')).toBeVisible();
  await expect(checklist.getByText('Kanal bağla')).toBeVisible();
  await expect(checklist.getByText('Ekibini davet et')).toBeVisible();

  // The old chores are gone from the list (they live in their own pages).
  await expect(checklist.getByText(/İlk AI temsilcini oluştur/)).toHaveCount(0);
  await expect(checklist.getByText(/Bilgi ekle/)).toHaveCount(0);
  await expect(checklist.getByText(/Marka Beynini oluştur/)).toHaveCount(0);
});
