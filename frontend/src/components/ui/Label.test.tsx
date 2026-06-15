import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { Label } from './Label';

describe('Label', () => {
  it('clicking label focuses the associated input via htmlFor', async () => {
    render(
      <div>
        <Label htmlFor="test-input">Username</Label>
        <input id="test-input" />
      </div>,
    );
    const label = screen.getByText('Username');
    await userEvent.click(label);
    expect(screen.getByRole('textbox')).toHaveFocus();
  });
});
