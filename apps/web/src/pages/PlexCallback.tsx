/**
 * Plex OAuth Callback Page
 *
 * This page is loaded in the popup after Plex auth completes.
 * It closes itself since it's now on our domain (same-origin).
 */

import { useEffect } from 'react';

export function PlexCallback() {
  useEffect(() => {
    // Close this popup window - works because we're same-origin now
    window.close();
  }, []);

  return (
    <div className="bg-background flex min-h-screen items-center justify-center">
      <div className="text-center">
        <div className="mb-2 text-2xl">&#10003;</div>
        <p className="text-muted-foreground">Authentication complete</p>
        <p className="text-muted-foreground mt-1 text-sm">
          This window will close automatically...
        </p>
      </div>
    </div>
  );
}
