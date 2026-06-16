import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from './Accordion';

describe('Accordion', () => {
  function renderAccordion(type: 'single' | 'multiple' = 'single') {
    return render(
      <Accordion type={type} collapsible={type === 'single' ? true : undefined}>
        <AccordionItem value="item-1">
          <AccordionTrigger>Question One</AccordionTrigger>
          <AccordionContent>Answer One</AccordionContent>
        </AccordionItem>
        <AccordionItem value="item-2">
          <AccordionTrigger>Question Two</AccordionTrigger>
          <AccordionContent>Answer Two</AccordionContent>
        </AccordionItem>
      </Accordion>,
    );
  }

  it('renders accordion triggers', () => {
    renderAccordion();
    expect(screen.getByRole('button', { name: /Question One/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Question Two/i })).toBeInTheDocument();
  });

  it('clicking a trigger expands its content', async () => {
    const user = userEvent.setup();
    renderAccordion();
    await user.click(screen.getByRole('button', { name: /Question One/i }));
    // After clicking, the content should be visible
    expect(screen.getByText('Answer One')).toBeInTheDocument();
  });

  it('trigger has aria-expanded=true when open', async () => {
    const user = userEvent.setup();
    renderAccordion();
    const trigger = screen.getByRole('button', { name: /Question One/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('single type collapses on second click', async () => {
    const user = userEvent.setup();
    renderAccordion('single');
    const trigger = screen.getByRole('button', { name: /Question One/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('multiple type can open several items at once', async () => {
    const user = userEvent.setup();
    renderAccordion('multiple');
    await user.click(screen.getByRole('button', { name: /Question One/i }));
    await user.click(screen.getByRole('button', { name: /Question Two/i }));
    expect(screen.getByRole('button', { name: /Question One/i })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /Question Two/i })).toHaveAttribute('aria-expanded', 'true');
  });
});
