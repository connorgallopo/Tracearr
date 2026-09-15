import { useMemo, useState } from 'react';
import { isPrerelease, WHATS_NEW_LEGACY } from '@tracearr/shared';
import { useDismissWhatsNew, useVersion, useWhatsNew } from '@/hooks/queries';
import { RELEASE_NOTES, selectAutoOpen } from '@/lib/releaseNotes';
import { WhatsNewDialog } from './WhatsNewDialog';

export function WhatsNewAutoOpen() {
  const { data: state } = useWhatsNew();
  const { data: version } = useVersion();
  const dismiss = useDismissWhatsNew();
  const [closed, setClosed] = useState(false);

  const sections = useMemo(
    () =>
      state ? selectAutoOpen(RELEASE_NOTES, state.runningVersion, state.lastSeenVersion) : null,
    [state]
  );

  if (!state || !sections || closed) return null;

  const since =
    !isPrerelease(state.runningVersion) &&
    state.lastSeenVersion &&
    state.lastSeenVersion !== WHATS_NEW_LEGACY
      ? state.lastSeenVersion
      : null;

  return (
    <WhatsNewDialog
      open
      onOpenChange={(open) => {
        if (open) return;
        setClosed(true);
        dismiss.mutate();
      }}
      mode="auto"
      sections={sections}
      runningVersion={state.runningVersion}
      sinceVersion={since}
      latestVersion={version?.upstream.latest?.version ?? null}
    />
  );
}
