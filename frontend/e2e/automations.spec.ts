/**
 * Automations — the list at /automations and the full-page builder at
 * /automations/new (frontend/src/pages/marketing/automations/*).
 *
 * What these protect, and why they have to run in a browser:
 *
 *  - The builder's canvas is React Flow. The component unit test
 *    (AutomationBuilderPage.test.tsx) explicitly `vi.mock`s WorkflowCanvas away
 *    — "the React Flow canvas needs a real layout engine" — so NOTHING below
 *    the palette is covered until here. If the graph stopped rendering, or the
 *    palette stopped feeding it, every unit test would still pass.
 *  - The round trip. A minimal automation is genuinely minimal: a non-empty
 *    name + at least one step (workflow-dsl.schema.ts requires
 *    `steps.min(1)`), and every palette entry seeds a DSL-valid default
 *    (stepOps.ts NEW_STEP). So "type a name, click one palette button, Save"
 *    must produce a row — it crosses the builder, toSavePayload, the Zod DSL,
 *    the maxWorkflows cap and the list query in one go.
 *  - The Save guard. Trigger-filters are edited as raw JSON; on a parse failure
 *    the builder deliberately keeps the LAST GOOD value in state, so a Save
 *    that got through would persist stale filters under a "saved" toast. Save
 *    is disabled instead — that disabled state is the only thing standing
 *    between a typo and a silently wrong automation.
 *
 * Copy note: the assertions use Turkish (verified in
 * i18n/locales/tr/marketing.json), EXCEPT the step-palette labels. Those come
 * from STEP_META in workflowGraph.ts, which is a hardcoded English map with no
 * i18n — "Wait"/"Create task" is what the Turkish UI actually renders today.
 *
 * No data-testid was added to any production component for this spec.
 */
import { test, expect } from './support/fixtures';

test('a new workspace has no automations and is offered the two ways to make one', async ({ app }) => {
  await app.goto('/automations');

  await expect(app.getByRole('heading', { level: 1, name: 'Otomasyonlar' })).toBeVisible();

  // The real empty state, not just "no rows".
  await expect(app.getByText('Henüz otomasyon yok', { exact: true })).toBeVisible();
  await expect(app.getByText(/birini anlat, AI taslaklasın/)).toBeVisible();
  await expect(app.getByRole('button', { name: 'Şablondan başla' })).toBeVisible();

  // Every workflow row carries an Edit button, so its absence is the proof that
  // this workspace sees no other test's automations.
  await expect(app.getByRole('button', { name: 'Düzenle' })).toHaveCount(0);
});

test('the blank-automation builder draws the trigger and the palette feeds the canvas', async ({ app }) => {
  await app.goto('/automations');

  // Through the UI, not a deep link: the "New automation" menu is how a blank
  // build is reached.
  await app.getByRole('button', { name: 'Yeni otomasyon' }).first().click();
  await app.getByRole('menuitem', { name: 'Boş otomasyon' }).click();
  await expect(app).toHaveURL(/\/automations\/new$/);

  // A blank builder is one node: the trigger, defaulted to lead.created.
  // (Scoped to the canvas — 'lead.created' also renders in the rail's trigger
  // Select.)
  const nodes = app.locator('.react-flow__node');
  await expect(nodes).toHaveCount(1);
  await expect(nodes.first()).toContainText('lead.created');

  // Nothing selected yet, so the property panel shows its hint.
  await expect(app.getByText(/Düzenlemek için bir adıma tıkla/)).toBeVisible();

  // Palette → canvas. This is the whole builder loop in one click.
  await app.getByRole('button', { name: 'Wait', exact: true }).click();
  await expect(nodes).toHaveCount(2);
  // Step nodes are numbered 1-based in the graph.
  await expect(nodes.nth(1)).toContainText('1. Wait');

  // Adding a step also selects it, so the panel switches to that step's editor —
  // a wait/duration step exposes its seconds field.
  await expect(app.getByText(/^Saniye \(60/)).toBeVisible();
});

test('a named automation with one step saves and appears in the list as a draft', async ({ app }) => {
  await app.goto('/automations/new');

  await app.getByRole('textbox', { name: 'Ad', exact: true }).fill('E2E takip otomasyonu');
  await app.getByRole('button', { name: 'Create task', exact: true }).click();

  await app.getByRole('button', { name: 'Kaydet', exact: true }).click();

  // A successful save leaves the builder for the list.
  await expect(app).toHaveURL(/\/automations$/);
  await expect(app.getByText('E2E takip otomasyonu')).toBeVisible();
  // The row shows what fires it — proof the trigger survived the round trip and
  // was not dropped on the way to the DSL.
  await expect(app.getByText('lead.created')).toBeVisible();

  // Saving does NOT arm the automation: WorkflowsService.create pins status to
  // DRAFT, so the row offers "Activate" rather than "Pause". Somebody making
  // save imply live would start sending messages nobody approved.
  await expect(app.getByRole('button', { name: 'Aktifleştir', exact: true })).toBeVisible();
  await expect(app.getByText('Henüz otomasyon yok', { exact: true })).toHaveCount(0);
});

test('Save is blocked while the trigger filters are not a JSON array', async ({ app }) => {
  await app.goto('/automations/new');

  const save = app.getByRole('button', { name: 'Kaydet', exact: true });
  const filters = app.getByRole('textbox', {
    name: 'Tetikleyici filtreleri (JSON, opsiyonel)',
    exact: true,
  });

  await expect(save).toBeEnabled();

  // Valid JSON, wrong shape — the subtle case. The builder keeps the last good
  // filters in state, so an enabled Save here would write `[]` while the author
  // believes they saved an object.
  await filters.fill('{"field":"lead.status"}');
  await expect(app.getByText('Filtreler bir JSON dizisi olmalı.')).toBeVisible();
  await expect(save).toBeDisabled();

  // Not a dead end: fixing the JSON re-enables it.
  await filters.fill('[]');
  await expect(app.getByText('Filtreler bir JSON dizisi olmalı.')).toHaveCount(0);
  await expect(save).toBeEnabled();
});
