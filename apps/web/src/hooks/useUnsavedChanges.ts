import { useCallback, useEffect } from 'react';
import { useBlocker, type BlockerFunction } from 'react-router';

// Holds the user on the page while dirty: the returned blocker drives the confirm
// UI for in-app navigation, beforeunload covers closing the tab.
export function useUnsavedChanges(isDirty: boolean) {
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      isDirty && currentLocation.pathname !== nextLocation.pathname,
    [isDirty]
  );
  const blocker = useBlocker(shouldBlock);

  // A save while the blocker is holding a navigation would otherwise leave it stuck
  // blocked, and react-router ignores every navigation after that.
  useEffect(() => {
    if (blocker.state === 'blocked' && !isDirty) blocker.reset();
  }, [blocker, isDirty]);

  useEffect(() => {
    if (!isDirty) return;

    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Older Chromium ignores preventDefault on its own.
      // oxlint-disable-next-line typescript/no-deprecated
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [isDirty]);

  return blocker;
}
