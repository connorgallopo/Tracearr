import { templateEnvelopeSchema, type TemplateEnvelope } from '@tracearr/shared';
import accountInactivity from './account-inactivity.json' with { type: 'json' };
import concurrentStreams from './concurrent-streams.json' with { type: 'json' };
import deviceVelocity from './device-velocity.json' with { type: 'json' };
import geoRestriction from './geo-restriction.json' with { type: 'json' };
import impossibleTravel from './impossible-travel.json' with { type: 'json' };
import killPausedStreams from './kill-paused-streams.json' with { type: 'json' };
import mediaAdded from './media-added.json' with { type: 'json' };
import mediaUpgraded from './media-upgraded.json' with { type: 'json' };
import newDevice from './new-device.json' with { type: 'json' };
import newsletterFailed from './newsletter-failed.json' with { type: 'json' };
import no4kTranscodes from './no-4k-transcodes.json' with { type: 'json' };
import pausedTooLong from './paused-too-long.json' with { type: 'json' };
import pluginUpdate from './plugin-update.json' with { type: 'json' };
import serverDown from './server-down.json' with { type: 'json' };
import serverUp from './server-up.json' with { type: 'json' };
import serverUpdate from './server-update.json' with { type: 'json' };
import simultaneousLocations from './simultaneous-locations.json' with { type: 'json' };
import streamEnded from './stream-ended.json' with { type: 'json' };
import streamStarted from './stream-started.json' with { type: 'json' };
import tracearrUpdate from './tracearr-update.json' with { type: 'json' };
import transcodeStarted from './transcode-started.json' with { type: 'json' };
import trustScoreChanged from './trust-score-changed.json' with { type: 'json' };

/**
 * The bundled envelopes, parsed at import: a malformed one is a build mistake,
 * and boot should say so rather than seed half a catalog.
 */
export const BUILTIN_ENVELOPES: TemplateEnvelope[] = [
  streamStarted,
  streamEnded,
  transcodeStarted,
  pausedTooLong,
  mediaAdded,
  mediaUpgraded,
  newDevice,
  trustScoreChanged,
  newsletterFailed,
  serverDown,
  serverUp,
  pluginUpdate,
  serverUpdate,
  tracearrUpdate,
  concurrentStreams,
  impossibleTravel,
  simultaneousLocations,
  deviceVelocity,
  geoRestriction,
  accountInactivity,
  no4kTranscodes,
  killPausedStreams,
].map((envelope) => templateEnvelopeSchema.parse(envelope));
