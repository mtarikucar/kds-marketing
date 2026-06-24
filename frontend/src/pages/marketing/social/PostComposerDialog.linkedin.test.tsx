import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PostComposerDialog } from './PostComposerDialog';
import type { SocialAccount } from './types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_k: string, o?: any) => o?.defaultValue ?? _k }),
}));

const liAccount: SocialAccount = {
  id: 'li-1',
  network: 'LINKEDIN',
  externalId: 'ORG1',
  displayName: 'My Page',
  accessToken: '••••',
  tokenExpiresAt: null,
  enabled: true,
  createdAt: new Date().toISOString(),
  accountType: 'LI_ORG',
  connectedVia: 'OAUTH',
  lastError: null,
};

describe('PostComposerDialog — LinkedinControls', () => {
  it('persists visibility=CONNECTIONS into submit.options.linkedin', async () => {
    const onSubmit = vi.fn();
    render(
      <PostComposerDialog
        open
        onOpenChange={() => {}}
        accounts={[liAccount]}
        onSubmit={onSubmit}
        isPending={false}
      />,
    );
    // type content
    fireEvent.change(screen.getByPlaceholderText('What do you want to share?'), {
      target: { value: 'hello' },
    });
    // select the LinkedIn account
    fireEvent.click(screen.getByRole('checkbox'));
    // the LinkedIn visibility select appears; switch to CONNECTIONS
    const select = await screen.findByLabelText('LinkedIn visibility');
    fireEvent.change(select, { target: { value: 'CONNECTIONS' } });
    // submit
    fireEvent.click(screen.getByText('Create post'));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].options.linkedin).toEqual({ visibility: 'CONNECTIONS' });
  });

  it('defaults visibility to PUBLIC when a LinkedIn account is selected', async () => {
    const onSubmit = vi.fn();
    render(
      <PostComposerDialog
        open
        onOpenChange={() => {}}
        accounts={[liAccount]}
        onSubmit={onSubmit}
        isPending={false}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText('What do you want to share?'), {
      target: { value: 'hello' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByText('Create post'));
    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0][0].options.linkedin).toEqual({ visibility: 'PUBLIC' });
  });
});
