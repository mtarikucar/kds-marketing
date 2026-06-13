import { withTimeout } from './with-timeout';

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve(42), 100)).resolves.toBe(42);
  });

  it('rejects with a timeout error when the promise is too slow', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 1000));
    await expect(withTimeout(slow, 20, 'slow op')).rejects.toThrow(
      /slow op timed out after 20ms/,
    );
  });

  it('propagates the original rejection', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('boom')), 100),
    ).rejects.toThrow('boom');
  });
});
