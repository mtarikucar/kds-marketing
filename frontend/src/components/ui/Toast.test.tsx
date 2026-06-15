import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { toast, Toaster } from './Toast';

describe('Toast', () => {
  it('re-exports toast as a callable function', () => {
    expect(typeof toast).toBe('function');
  });

  it('exposes the common toast variants', () => {
    expect(typeof toast.success).toBe('function');
    expect(typeof toast.error).toBe('function');
  });

  it('renders the Toaster preset without throwing', () => {
    expect(() => render(<Toaster />)).not.toThrow();
  });
});
