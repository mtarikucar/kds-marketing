import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './Tabs';

describe('Tabs', () => {
  function renderTabs() {
    return render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab One</TabsTrigger>
          <TabsTrigger value="tab2">Tab Two</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Panel One</TabsContent>
        <TabsContent value="tab2">Panel Two</TabsContent>
      </Tabs>,
    );
  }

  it('shows the default tab panel on mount', () => {
    renderTabs();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel One');
  });

  it('clicking a tab shows its tabpanel', async () => {
    const user = userEvent.setup();
    renderTabs();
    await user.click(screen.getByRole('tab', { name: 'Tab Two' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel Two');
  });

  it('active tab trigger has aria-selected=true', async () => {
    const user = userEvent.setup();
    renderTabs();
    await user.click(screen.getByRole('tab', { name: 'Tab Two' }));
    expect(screen.getByRole('tab', { name: 'Tab Two' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Tab One' })).toHaveAttribute('aria-selected', 'false');
  });
});
