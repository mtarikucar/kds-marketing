import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Slider } from './Slider';

describe('Slider', () => {
  it('renders with role="slider"', () => {
    render(<Slider defaultValue={[50]} min={0} max={100} aria-label="Volume" />);
    expect(screen.getByRole('slider')).toBeInTheDocument();
  });

  it('has correct aria-valuenow on the thumb', () => {
    render(<Slider defaultValue={[30]} min={0} max={100} aria-label="Volume" />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuenow', '30');
  });

  it('has correct aria-valuemin and aria-valuemax', () => {
    render(<Slider defaultValue={[0]} min={10} max={90} aria-label="Range" />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('aria-valuemin', '10');
    expect(slider).toHaveAttribute('aria-valuemax', '90');
  });

  it('renders two thumbs for a range (two values)', () => {
    render(
      <Slider defaultValue={[20, 80]} min={0} max={100} aria-label="Price range" />,
    );
    const sliders = screen.getAllByRole('slider');
    expect(sliders).toHaveLength(2);
    expect(sliders[0]).toHaveAttribute('aria-valuenow', '20');
    expect(sliders[1]).toHaveAttribute('aria-valuenow', '80');
  });

  it('merges custom className onto the root', () => {
    const { container } = render(
      <Slider defaultValue={[0]} aria-label="Test" className="my-custom-class" />,
    );
    expect(container.firstChild).toHaveClass('my-custom-class');
  });
});
