import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

/**
 * THE SIX PAGES THAT ABSORBED ANOTHER.
 *
 * Six pairs of settings entries were one job each, split in two: Team and the
 * roles its members carry, Segments and Tags, the two Domains, the two Webhook
 * directions, API keys and the Claude connector, the voice greeting and the
 * phone tree. Each pair is now one page with tabs.
 *
 * What is asserted here is the SHELL — that both halves are present and that
 * `?tab=` names them. The halves keep their own tests; the thing that did not
 * exist before, and could silently render an empty page, is the wrapper.
 *
 * Every child is stubbed. These shells exist to place two components on one
 * page, and loading the real ones would test their data-fetching instead.
 */

const stub = (name: string) => ({ default: () => <div>{name}-stub</div> });

vi.mock('./SendingDomainsPage', () => stub('sending'));
vi.mock('./CustomDomainsPage', () => stub('custom'));
vi.mock('./webhooks/WebhooksPage', () => stub('outgoing-hooks'));
vi.mock('./inboundWebhooks', () => stub('inbound-hooks'));
vi.mock('./apiKeys/ApiKeysPage', () => stub('api-keys'));
vi.mock('./mcpConsole/McpConsolePage', () => stub('connector'));
vi.mock('../users', () => stub('members'));
vi.mock('./roles/RolesPage', () => stub('roles'));
vi.mock('../crm/segments/SegmentsPage', () => stub('segments'));
vi.mock('../crm/tags/TagsPage', () => stub('tags'));
vi.mock('../VoicePage', () => stub('assistant'));
vi.mock('../voice/ivr/IvrMenusPage', () => stub('phone-tree'));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string } | string) =>
      (typeof o === 'string' ? o : o?.defaultValue) ?? k,
    i18n: { language: 'en' },
  }),
}));

import DomainsPage from './DomainsPage';
import WebhooksHubPage from './WebhooksHubPage';
import ApiAccessPage from './ApiAccessPage';
import TeamPage from '../TeamPage';
import AudiencePage from '../crm/AudiencePage';
import VoiceHubPage from '../VoiceHubPage';

type Shell = {
  name: string;
  Page: () => JSX.Element;
  title: string;
  first: string;
  second: string;
  secondTab: string;
};

const SHELLS: Shell[] = [
  { name: 'Domains', Page: DomainsPage, title: 'Domains', first: 'sending-stub', second: 'custom-stub', secondTab: 'custom' },
  { name: 'Webhooks', Page: WebhooksHubPage, title: 'Webhooks', first: 'outgoing-hooks-stub', second: 'inbound-hooks-stub', secondTab: 'inbound' },
  { name: 'API access', Page: ApiAccessPage, title: 'API access', first: 'api-keys-stub', second: 'connector-stub', secondTab: 'connector' },
  { name: 'Team', Page: TeamPage, title: 'Team', first: 'members-stub', second: 'roles-stub', secondTab: 'roles' },
  { name: 'Audience', Page: AudiencePage, title: 'Segments & tags', first: 'segments-stub', second: 'tags-stub', secondTab: 'tags' },
  { name: 'Voice', Page: VoiceHubPage, title: 'Voice', first: 'assistant-stub', second: 'phone-tree-stub', secondTab: 'ivr' },
];

function renderAt({ Page }: Shell, search = '') {
  return render(
    <MemoryRouter initialEntries={[`/x${search}`]}>
      <Page />
    </MemoryRouter>,
  );
}

describe.each(SHELLS)('$name — one page, two halves', (shell) => {
  it('names the page once, at the top', async () => {
    renderAt(shell);
    expect(await screen.findByRole('heading', { name: shell.title })).toBeInTheDocument();
  });

  it('opens on the first half by default', async () => {
    renderAt(shell);
    expect(await screen.findByText(shell.first)).toBeInTheDocument();
  });

  it('opens the second half straight from the URL', async () => {
    // This is what every redirected old path relies on. If `?tab=` did not
    // select, a bookmark to the absorbed page would land on the wrong half —
    // which reads as "the page I wanted is gone".
    renderAt(shell, `?tab=${shell.secondTab}`);
    expect(await screen.findByText(shell.second)).toBeInTheDocument();
  });

  it('falls back to the first half on a tab name that is not one of its own', async () => {
    renderAt(shell, '?tab=nonsense');
    expect(await screen.findByText(shell.first)).toBeInTheDocument();
  });

  it('swaps the half when the other tab is clicked', async () => {
    const user = userEvent.setup();
    renderAt(shell);
    await screen.findByText(shell.first);

    await user.click(screen.getByRole('tab', { selected: false }));

    expect(await screen.findByText(shell.second)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(shell.first)).not.toBeInTheDocument());
  });
});
