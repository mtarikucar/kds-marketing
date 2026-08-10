/**
 * Onboarding — what a brand-new workspace is actually told to do.
 *
 * The product owner's complaint was "I open the system and don't know what to
 * do". The checklist existed and worked; it was just outranked on the page by
 * a louder CTA telling people to type in a lead by hand. These tests pin the
 * order, because ordering regressions are invisible to unit tests.
 */
import { test, expect } from './support/fixtures';

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
