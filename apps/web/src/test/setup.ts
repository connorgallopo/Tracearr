import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// jsdom doesn't implement ResizeObserver or scrollIntoView, both of which
// cmdk (Command) relies on for its list sizing and keyboard navigation.
// Only components using cmdk-based pickers need these.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {
      // no-op: jsdom has no layout, so there's nothing to observe
    }
    unobserve() {
      // no-op
    }
    disconnect() {
      // no-op
    }
  };
}
if (typeof Element.prototype.scrollIntoView === 'undefined') {
  Element.prototype.scrollIntoView = () => {
    // no-op: jsdom has no layout, so there's nothing to scroll
  };
}

// jsdom has no Pointer Events implementation; radix Select's pointer-down
// handling calls these directly, so any test that opens a Select throws
// without them.
if (typeof Element.prototype.hasPointerCapture === 'undefined') {
  Element.prototype.hasPointerCapture = () => false;
}
if (typeof Element.prototype.setPointerCapture === 'undefined') {
  Element.prototype.setPointerCapture = () => {
    // no-op
  };
}
if (typeof Element.prototype.releasePointerCapture === 'undefined') {
  Element.prototype.releasePointerCapture = () => {
    // no-op
  };
}

// jsdom has no media-query engine; the sidebar's useIsMobile hook calls this
// on mount, so anything rendering a Sidebar throws without it.
const noop = () => {
  // no-op: nothing subscribes to media-query changes under test
};

if (typeof window.matchMedia === 'undefined') {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: noop,
      removeListener: noop,
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom has no WebGL; without this the map's support probe short-circuits every
// test that mounts a map into the "WebGL disabled" panel.
const realGetContext = HTMLCanvasElement.prototype.getContext;
HTMLCanvasElement.prototype.getContext = function (
  this: HTMLCanvasElement,
  id: string,
  ...rest: unknown[]
) {
  if (id === 'webgl2') return { getExtension: () => null };
  return (realGetContext as (...a: unknown[]) => unknown).call(this, id, ...rest);
} as typeof HTMLCanvasElement.prototype.getContext;

afterEach(() => {
  cleanup();
});
