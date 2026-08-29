import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LeadContextPane } from './LeadContextPane';
import type { Lead } from '../../../features/marketing/types';

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

const renderCard = (props: Partial<React.ComponentProps<typeof LeadContextPane>> = {}) =>
  render(
    <MemoryRouter>
      <LeadContextPane lead={person()} {...props} />
    </MemoryRouter>,
  );

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

  it('names the owner, and says so when there is not one', () => {
    renderCard({
      lead: person({
        assignedTo: { id: 'u1', firstName: 'Mehmet', lastName: 'Kaya' } as Lead['assignedTo'],
      }),
    });
    expect(screen.getByTestId('record-owner')).toHaveTextContent('Mehmet Kaya');

    // Unowned is a fact worth reading, not a blank line — it is the whole
    // point of the Atanmamış queue one column over.
    renderCard({ lead: person({ assignedTo: undefined }) });
    expect(screen.getAllByTestId('record-owner')[1]).toHaveTextContent('Atanmamış');
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

  // Below lg the three columns cannot coexist, so the card arrives as a sheet.
  // It has to be dismissible or it traps the person who opened it.
  it('closes when the sheet is dismissed', async () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <LeadContextPane lead={person()} asSheet onClose={onClose} />
      </MemoryRouter>,
    );

    screen.getByRole('button', { name: 'Kapat' }).click();
    expect(onClose).toHaveBeenCalled();
  });
});
