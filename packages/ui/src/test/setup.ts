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

// Mock ResizeObserver (not supported in jsdom)
global.ResizeObserver = class ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(_target: Element): void {}
  unobserve(_target: Element): void {}
  disconnect(): void {}
};

// @pierre/diffs web component relies on Constructable Stylesheets + adoptedStyleSheets.
// JSDOM does not fully implement these APIs, so provide minimal stubs for tests.
if (typeof (globalThis as any).CSSStyleSheet === 'undefined') {
  (globalThis as any).CSSStyleSheet = class CSSStyleSheet {
    replaceSync(_cssText: string) {}
  };
}

if (typeof (globalThis as any).customElements === 'undefined') {
  (globalThis as any).customElements = {
    get(_name: string) {
      return undefined;
    },
    define(_name: string, _ctor: any) {},
  };
}

if (typeof (globalThis as any).ShadowRoot !== 'undefined' && !('adoptedStyleSheets' in (globalThis as any).ShadowRoot.prototype)) {
  Object.defineProperty((globalThis as any).ShadowRoot.prototype, 'adoptedStyleSheets', {
    configurable: true,
    get() {
      return [];
    },
    set(_sheets: any) {},
  });
}

// Export expect for tests
export { expect };
