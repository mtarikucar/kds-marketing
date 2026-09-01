import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LineTrend } from './LineTrend';
import { StackedBars } from './StackedBars';

const DAYS = ['2026-03-01', '2026-03-02', '2026-03-03', '2026-03-04'];

describe('LineTrend', () => {
  it('publishes the same numbers as a real table, not only as a picture', () => {
    // The picture is inaccessible by construction; the table is the contract.
    render(
      <LineTrend
        labels={DAYS}
        series={[{ key: 'reach', label: 'Erişim', points: [10, 0, 30, 5] }]}
        title="Erişim"
        ariaLabel="Günlük erişim"
      />,
    );
    const table = screen.getByRole('table', { name: 'Günlük erişim' });
    expect(within(table).getByRole('row', { name: /2026-03-03/ })).toHaveTextContent('30');
    expect(within(table).getByRole('row', { name: /2026-03-02/ })).toHaveTextContent('0');
  });

  it('describes the plot to assistive tech', () => {
    render(
      <LineTrend
        labels={DAYS}
        series={[{ key: 'reach', label: 'Erişim', points: [1, 2, 3, 4] }]}
        title="Erişim"
        ariaLabel="Günlük erişim"
      />,
    );
    expect(screen.getByRole('img', { name: 'Günlük erişim' })).toBeInTheDocument();
  });

  it('shows no legend for one series and a legend for two', () => {
    // One series needs no legend box: there is a single colour and the title
    // already names what is plotted, so a lone swatch is chrome restating it.
    const { rerender } = render(
      <LineTrend
        labels={DAYS}
        series={[{ key: 'a', label: 'Erişim', points: [1, 2, 3, 4] }]}
        title="t"
        ariaLabel="a"
      />,
    );
    expect(screen.queryByRole('list')).not.toBeInTheDocument();

    rerender(
      <LineTrend
        labels={DAYS}
        series={[
          { key: 'a', label: 'Erişim', points: [1, 2, 3, 4] },
          { key: 'b', label: 'Etkileşim', points: [4, 3, 2, 1] },
        ]}
        title="t"
        ariaLabel="a"
      />,
    );
    const legend = screen.getByRole('list');
    expect(within(legend).getByText('Erişim')).toBeInTheDocument();
    expect(within(legend).getByText('Etkileşim')).toBeInTheDocument();
  });

  it('renders the empty state instead of a flat line when every value is zero', () => {
    // A zero line and "we have no data" look identical, and only one of them is
    // a fact about the business.
    render(
      <LineTrend
        labels={DAYS}
        series={[{ key: 'a', label: 'Erişim', points: [0, 0, 0, 0] }]}
        title="t"
        ariaLabel="a"
        emptyText="Henüz veri yok"
      />,
    );
    expect(screen.getByText('Henüz veri yok')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'a' })).not.toBeInTheDocument();
  });

  it('reads out a day on keyboard focus, not only on hover', async () => {
    const user = userEvent.setup();
    render(
      <LineTrend
        labels={DAYS}
        series={[{ key: 'a', label: 'Erişim', points: [10, 20, 30, 40] }]}
        title="t"
        ariaLabel="a"
      />,
    );
    await user.tab();
    await user.keyboard('{ArrowRight}');
    const tip = screen.getByRole('status');
    expect(tip).toHaveTextContent('2026-03-02');
    expect(tip).toHaveTextContent('20');

    await user.keyboard('{End}');
    expect(screen.getByRole('status')).toHaveTextContent('2026-03-04');

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('survives a single-point series without dividing by zero', () => {
    render(
      <LineTrend
        labels={['2026-03-01']}
        series={[{ key: 'a', label: 'Erişim', points: [5] }]}
        title="t"
        ariaLabel="a"
      />,
    );
    expect(screen.getByRole('img', { name: 'a' })).toBeInTheDocument();
  });

  it('formats values through the caller, so units are not invented here', () => {
    render(
      <LineTrend
        labels={DAYS}
        series={[{ key: 'a', label: 'Harcama', points: [1, 2, 3, 4] }]}
        title="t"
        ariaLabel="a"
        formatValue={(n) => `${n} ₺`}
      />,
    );
    expect(screen.getByRole('table', { name: 'a' })).toHaveTextContent('3 ₺');
  });
});

describe('StackedBars', () => {
  it('publishes a column per category in the table', () => {
    render(
      <StackedBars
        labels={DAYS}
        categories={[
          { key: 'IG', label: 'Instagram', values: [1, 0, 2, 0] },
          { key: 'LI', label: 'LinkedIn', values: [0, 1, 1, 0] },
        ]}
        title="Yayınlanan"
        ariaLabel="Ağ başına yayınlanan içerik"
      />,
    );
    const table = screen.getByRole('table', { name: 'Ağ başına yayınlanan içerik' });
    expect(within(table).getByRole('columnheader', { name: 'Instagram' })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: /2026-03-03/ })).toHaveTextContent('2');
  });

  it('is empty when nothing was published, rather than drawing a flat axis', () => {
    render(
      <StackedBars
        labels={DAYS}
        categories={[{ key: 'IG', label: 'Instagram', values: [0, 0, 0, 0] }]}
        title="t"
        ariaLabel="a"
        emptyText="Bu aralıkta yayın yok"
      />,
    );
    expect(screen.getByText('Bu aralıkta yayın yok')).toBeInTheDocument();
  });

  it('keeps a category on its own colour whatever the day', () => {
    // Colour follows the entity, never its rank on a given day — otherwise the
    // network a reader learned as orange becomes blue on its quiet days.
    const { container } = render(
      <StackedBars
        labels={['2026-03-01', '2026-03-02']}
        categories={[
          { key: 'IG', label: 'Instagram', values: [0, 5] },
          { key: 'LI', label: 'LinkedIn', values: [5, 1] },
        ]}
        title="t"
        ariaLabel="a"
      />,
    );
    const fills = Array.from(container.querySelectorAll('rect[fill], path[fill]'))
      .map((el) => el.getAttribute('fill'))
      .filter((f) => f?.startsWith('var(--chart'));
    // Instagram takes slot 1 and LinkedIn slot 2 on BOTH days, even though
    // LinkedIn is the only category present on the first.
    expect(new Set(fills)).toEqual(new Set(['var(--chart-1)', 'var(--chart-2)']));
  });

  it('shows every category present on the hovered day in one tooltip', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <StackedBars
        labels={DAYS}
        categories={[
          { key: 'IG', label: 'Instagram', values: [0, 0, 2, 0] },
          { key: 'LI', label: 'LinkedIn', values: [0, 0, 3, 0] },
        ]}
        title="t"
        ariaLabel="a"
      />,
    );
    const hitAreas = container.querySelectorAll('rect[fill="transparent"]');
    await user.hover(hitAreas[2]);
    const tip = screen.getByRole('status');
    expect(tip).toHaveTextContent('Instagram');
    expect(tip).toHaveTextContent('LinkedIn');
    expect(tip).toHaveTextContent('2');
    expect(tip).toHaveTextContent('3');
  });
});
