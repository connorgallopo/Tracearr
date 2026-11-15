import { useRef } from 'react';

/**
 * Focus handlers for a Radix dialog opened by state rather than by its own Trigger. Radix hands
 * focus back to that Trigger on close, so without one it lands on the body; these return it to
 * whatever had focus when the dialog opened, while that element is still in the page.
 */
export function useRestoreFocus() {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    },
    onCloseAutoFocus: (event: Event) => {
      const element = opener.current;
      opener.current = null;
      if (!element?.isConnected) return;
      event.preventDefault();
      element.focus();
    },
  };
}
