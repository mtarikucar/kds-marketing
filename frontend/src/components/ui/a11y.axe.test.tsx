/**
 * Axe accessibility smoke test.
 *
 * Renders a representative sample of UI primitives and runs axe-core against
 * the mounted container, asserting no serious or critical violations.
 *
 * Notes:
 * - `color-contrast` is disabled because jsdom has no layout engine and cannot
 *   compute computed colours, so axe always reports false positives for it.
 *   Colour-contrast is verified visually / in Storybook / in E2E instead.
 * - The test exercises structural rules (ARIA, roles, labels, landmark usage).
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import axe from 'axe-core';
import type { ColumnDef } from '@tanstack/react-table';
import { Button } from './Button';
import { Badge } from './Badge';
import { Card, CardHeader, CardTitle, CardContent } from './Card';
import { Field } from './Field';
import { Input } from './Input';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from './Dialog';
import { DataTable } from './DataTable';

// ---------------------------------------------------------------------------
// Sample data for DataTable
// ---------------------------------------------------------------------------
interface Row {
  id: number;
  name: string;
  role: string;
}

const TABLE_DATA: Row[] = [
  { id: 1, name: 'Alice', role: 'Admin' },
  { id: 2, name: 'Bob', role: 'User' },
];

const TABLE_COLUMNS: ColumnDef<Row, unknown>[] = [
  { accessorKey: 'name', header: 'Name' },
  { accessorKey: 'role', header: 'Role' },
];

// ---------------------------------------------------------------------------
// axe helper
// ---------------------------------------------------------------------------
const AXE_OPTIONS: axe.RunOptions = {
  rules: {
    // jsdom has no layout engine — colour contrast checks always false-positive.
    'color-contrast': { enabled: false },
  },
  resultTypes: ['violations'],
};

async function runAxe(container: HTMLElement) {
  const results = await axe.run(container, AXE_OPTIONS);
  return results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function ButtonFixture() {
  return (
    <section aria-label="Buttons">
      <Button>Primary</Button>
      <Button variant="outline">Outline</Button>
      <Button variant="destructive">Delete</Button>
    </section>
  );
}

function FieldInputFixture() {
  return (
    <form aria-label="Sample form">
      <Field label="Email" required>
        {({ id, describedBy, invalid }) => (
          <Input
            id={id}
            type="email"
            aria-describedby={describedBy}
            aria-invalid={invalid}
            placeholder="you@example.com"
          />
        )}
      </Field>
      <Field label="Name" hint="Your full name">
        {({ id, describedBy }) => (
          <Input id={id} aria-describedby={describedBy} placeholder="Jane Doe" />
        )}
      </Field>
    </form>
  );
}

function BadgeFixture() {
  return (
    <section aria-label="Badges">
      <Badge tone="success">Active</Badge>
      <Badge tone="warning">Pending</Badge>
      <Badge tone="danger">Error</Badge>
    </section>
  );
}

function CardFixture() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Sample card</CardTitle>
      </CardHeader>
      <CardContent>
        <p>Card body content here.</p>
      </CardContent>
    </Card>
  );
}

function DialogFixture() {
  return (
    <Dialog defaultOpen>
      <DialogTrigger>Open</DialogTrigger>
      <DialogContent>
        <DialogTitle>Accessibility test dialog</DialogTitle>
        <DialogDescription>
          This dialog verifies that the modal overlay meets ARIA requirements.
        </DialogDescription>
        <p>Dialog body content.</p>
      </DialogContent>
    </Dialog>
  );
}

function DataTableFixture() {
  return (
    <section aria-label="Users table">
      <DataTable columns={TABLE_COLUMNS} data={TABLE_DATA} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Axe accessibility smoke', () => {
  it('Button — no serious/critical violations', async () => {
    const { container } = render(<ButtonFixture />);
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  it('Field + Input — no serious/critical violations', async () => {
    const { container } = render(<FieldInputFixture />);
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  it('Badge — no serious/critical violations', async () => {
    const { container } = render(<BadgeFixture />);
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  it('Card — no serious/critical violations', async () => {
    const { container } = render(<CardFixture />);
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  it('Dialog (open) — no serious/critical violations', async () => {
    const { container } = render(<DialogFixture />);
    // Wait for Radix to mount the portal content into document.body
    await screen.findByRole('dialog');
    // Run axe against the full document body since Dialog portals outside container
    const violations = await runAxe(document.body);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });

  it('DataTable — no serious/critical violations', async () => {
    const { container } = render(<DataTableFixture />);
    const violations = await runAxe(container);
    expect(violations, formatViolations(violations)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Error formatting helper (surfaces violation details on failure)
// ---------------------------------------------------------------------------
function formatViolations(violations: axe.Result[]): string {
  if (violations.length === 0) return '';
  return violations
    .map(
      (v) =>
        `[${v.impact?.toUpperCase()}] ${v.id}: ${v.description}\n  Nodes: ${v.nodes
          .slice(0, 3)
          .map((n) => n.html)
          .join(', ')}`,
    )
    .join('\n');
}
