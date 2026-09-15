import type { RequestServiceProbeResult } from '@tracearr/shared';
import { SeerrClient } from './seerrClient.js';
import { findServerByMachineId } from './serverLookup.js';

export class SeerrProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeerrProbeError';
  }
}

const MEDIA_SERVER_TYPES: Record<number, RequestServiceProbeResult['mediaServerType']> = {
  1: 'plex',
  2: 'jellyfin',
  3: 'emby',
};

export async function probeSeerr(url: string, apiKey: string): Promise<RequestServiceProbeResult> {
  const client = new SeerrClient(url, apiKey);
  const [status, main] = await Promise.all([client.status(), client.mainSettings()]);
  const mediaServerType = MEDIA_SERVER_TYPES[main.mediaServerType];
  if (!mediaServerType) {
    throw new SeerrProbeError('This Seerr has no media server configured yet');
  }
  const remoteServerId =
    mediaServerType === 'plex'
      ? (await client.plexSettings()).machineId
      : (await client.jellyfinSettings()).serverId;
  if (!remoteServerId) {
    throw new SeerrProbeError('Seerr did not report a media server id');
  }
  const matched = await findServerByMachineId(remoteServerId);
  return {
    applicationTitle: main.applicationTitle,
    version: status.version,
    mediaServerType,
    remoteServerId,
    matchedServerId: matched?.id ?? null,
  };
}
