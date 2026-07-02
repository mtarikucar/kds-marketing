import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryStateBoundary } from './QueryStateBoundary';

describe('QueryStateBoundary', () => {
  it('renders children when settled and healthy', () => {
    render(
      <QueryStateBoundary>
        <div>content</div>
      </QueryStateBoundary>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
  });

  it('hides children while loading', () => {
    render(
      <QueryStateBoundary isLoading>
        <div>content</div>
      </QueryStateBoundary>,
    );
    expect(screen.queryByText('content')).not.toBeInTheDocument();
  });

  it('shows the error message + a working retry, and hides children', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <QueryStateBoundary isError onRetry={onRetry} errorMessage="Boom" retryLabel="Retry">
        <div>content</div>
      </QueryStateBoundary>,
    );
    expect(screen.getByText('Boom')).toBeInTheDocument();
    expect(screen.queryByText('content')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalled();
  });
});
