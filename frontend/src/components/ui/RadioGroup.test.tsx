import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { RadioGroup, RadioGroupItem } from './RadioGroup';
import { Label } from './Label';

function RadioDemo() {
  return (
    <RadioGroup defaultValue="option-a">
      <div className="flex items-center gap-2">
        <RadioGroupItem value="option-a" id="option-a" />
        <Label htmlFor="option-a">Option A</Label>
      </div>
      <div className="flex items-center gap-2">
        <RadioGroupItem value="option-b" id="option-b" />
        <Label htmlFor="option-b">Option B</Label>
      </div>
    </RadioGroup>
  );
}

describe('RadioGroup', () => {
  it('renders radio buttons', () => {
    render(<RadioDemo />);
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
  });

  it('starts with the default value checked', () => {
    render(<RadioDemo />);
    const radioA = screen.getByRole('radio', { name: 'Option A' });
    expect(radioA).toHaveAttribute('aria-checked', 'true');
  });

  it('selecting an item sets aria-checked and unsets previous', async () => {
    render(<RadioDemo />);
    const radioA = screen.getByRole('radio', { name: 'Option A' });
    const radioB = screen.getByRole('radio', { name: 'Option B' });
    expect(radioA).toHaveAttribute('aria-checked', 'true');
    expect(radioB).toHaveAttribute('aria-checked', 'false');

    await userEvent.click(radioB);
    expect(radioB).toHaveAttribute('aria-checked', 'true');
    expect(radioA).toHaveAttribute('aria-checked', 'false');
  });
});
