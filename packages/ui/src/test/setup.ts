import '@testing-library/jest-dom';
import { expect, afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Cleanup after each test
afterEach(() => {
  cleanup();
});

// Mock window.electronAPI
global.window = global.window || {};
(global.window as any).electronAPI = {
  invoke: vi.fn(),
  on: vi.fn(),
  send: vi.fn(),
};

// Mock navigator.clipboard
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn(),
  },
});

// Mock Element.scrollIntoView (not supported in jsdom)
Element.prototype.scrollIntoView = vi.fn();

// Mock IntersectionObserver (not supported in jsdom)
global.IntersectionObserver = class IntersectionObserver {
  readonly root: Element | Document | null = null;
  readonly rootMargin: string = '';
  readonly thresholds: ReadonlyArray<number> = [];
  constructor(
    _callback: IntersectionObserverCallback,
    _options?: IntersectionObserverInit
  ) {}
  observe(_target: Element): void {}
  unobserve(_target: Element): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
};

// Export expect for tests
export { expect };
