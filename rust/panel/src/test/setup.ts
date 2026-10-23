import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import i18n from '@/i18n/config';

beforeEach(async () => {
  try {
    window.localStorage.clear();
  } catch {
    // Storage may be unavailable; the panel works without it.
  }
  await i18n.changeLanguage('tr');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// jsdom lacks matchMedia and the ResizeObserver / pointer-capture bits Radix needs.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof NoopResizeObserver }).ResizeObserver =
  NoopResizeObserver;
const proto = Element.prototype as unknown as Record<string, unknown>;
if (!proto.hasPointerCapture) {
  proto.hasPointerCapture = () => false;
  proto.setPointerCapture = () => {};
  proto.releasePointerCapture = () => {};
}
if (!proto.scrollIntoView) {
  proto.scrollIntoView = () => {};
}

// The data router builds a `Request` with jsdom's AbortSignal on every navigation, which Node's
// own `Request` refuses ("Expected signal to be an instance of AbortSignal"). Browsers have one
// AbortSignal, so only tests need this: navigations here are never aborted.
const NodeRequest = globalThis.Request;
class TestRequest extends NodeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    const { signal: _signal, ...rest } = init ?? {};
    super(input, rest);
  }
}
globalThis.Request = TestRequest as typeof Request;
