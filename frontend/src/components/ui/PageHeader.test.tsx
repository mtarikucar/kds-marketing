import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  it('renders the title', () => {
    render(<PageHeader title="Dashboard" />);
    expect(screen.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
  });

  it('renders actions', () => {
    render(
      <PageHeader
        title="Dashboard"
        actions={<button>Create</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Create' })).toBeInTheDocument();
  });

  it('renders description when provided', () => {
    render(<PageHeader title="Dashboard" description="Overview of everything" />);
    expect(screen.getByText('Overview of everything')).toBeInTheDocument();
  });

  it('renders breadcrumbs when provided', () => {
    render(
      <PageHeader
        title="Detail"
        breadcrumbs={[{ label: 'Home', href: '/' }, { label: 'Detail' }]}
      />,
    );
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('does not render breadcrumbs nav when not provided', () => {
    render(<PageHeader title="Simple" />);
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
});

/**
 * EMBEDDED MODE — a page that is a TAB inside another one.
 *
 * Six settings pages became tabs on 2026-09-03. The pattern that preceded this
 * prop was for the shell to wrap the child's whole header in `{!embedded && …}`,
 * which also threw away the primary action and the description. On a page whose
 * empty state carries its own create button, that is invisible until the first
 * row exists — and then there is no way to add a second.
 */
describe('PageHeader — embedded', () => {
  it('drops the heading, because the page around it already has one', () => {
    render(<PageHeader embedded title="Roles" description="What each role may do." />);
    expect(screen.queryByRole('heading', { name: 'Roles' })).not.toBeInTheDocument();
  });

  it('keeps the primary action, which is the whole point', () => {
    render(<PageHeader embedded title="Segments" actions={<button type="button">New segment</button>} />);
    expect(screen.getByRole('button', { name: 'New segment' })).toBeInTheDocument();
  });

  it('keeps the description, which carries the fact the page depends on', () => {
    render(<PageHeader embedded title="Webhooks" description="Each delivery is signed." />);
    expect(screen.getByText('Each delivery is signed.')).toBeInTheDocument();
  });

  it('renders nothing at all when there is neither', () => {
    const { container } = render(<PageHeader embedded title="Just a title" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is unchanged when not embedded', () => {
    render(<PageHeader title="Team" description="Members and access." />);
    expect(screen.getByRole('heading', { name: 'Team' })).toBeInTheDocument();
  });
});

/**
 * A LONG ACTION ROW — the title must survive it.
 *
 * The lead detail header carries up to a dozen controls beside the lead's name.
 * With the actions `shrink-0` and the title `flex-1 min-w-0`, a row wider than
 * the page kept its full width and left the <h1> zero pixels: in the DOM, not
 * on screen, and e2e/leads.spec.ts failed on exactly that ("exists but is not
 * visible"). jsdom does no layout, so the contract is pinned on the classes
 * that produce it, and the e2e spec pins the outcome in a real browser.
 */
describe('PageHeader — a long action row', () => {
  const renderLong = () =>
    render(
      <PageHeader
        title="Kahve Durağı"
        actions={
          <>
            {Array.from({ length: 12 }, (_, i) => (
              <button key={i} type="button">{`Action ${i}`}</button>
            ))}
          </>
        }
      />,
    );

  it('gives the title column a floor it cannot be squeezed below', () => {
    renderLong();
    const titleColumn = screen.getByRole('heading', { level: 1 }).parentElement!;
    expect(titleColumn).toHaveClass('flex-1', 'sm:min-w-64');
  });

  it('lets the row wrap, so the actions drop beneath the title instead of eating it', () => {
    renderLong();
    const row = screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!;
    expect(row).toHaveClass('sm:flex-row', 'sm:flex-wrap');
  });

  it('lets the action group shrink and fold onto several lines rather than overflow', () => {
    renderLong();
    const group = screen.getByRole('button', { name: 'Action 0' }).parentElement!;
    expect(group).toHaveClass('flex-wrap', 'min-w-0', 'max-w-full');
    expect(group).not.toHaveClass('shrink-0');
  });
});
