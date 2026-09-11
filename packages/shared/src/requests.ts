import { z } from 'zod';
import { uuidSchema } from './schemas.js';
import type { WatchedState } from './types.js';

export const REQUEST_SERVICE_TYPES = ['seerr'] as const;
export type RequestServiceType = (typeof REQUEST_SERVICE_TYPES)[number];

export const MEDIA_REQUEST_STATUSES = [
  'pending',
  'approved',
  'declined',
  'failed',
  'completed',
] as const;
export type MediaRequestStatus = (typeof MEDIA_REQUEST_STATUSES)[number];

export type MediaRequestMediaType = 'movie' | 'show';

export interface RequestSeason {
  seasonNumber: number;
  status: MediaRequestStatus;
}

/** Body of Seerr's GET /request/count, stored to skip unchanged runs. */
export interface RequestCounts {
  total: number;
  movie: number;
  tv: number;
  pending: number;
  approved: number;
  declined: number;
  processing: number;
  available: number;
  completed: number;
}

export interface RequestService {
  id: string;
  serverId: string;
  type: RequestServiceType;
  name: string;
  url: string;
  enabled: boolean;
  configStatus: 'ok' | 'reencrypt';
  remoteServerId: string;
  version: string | null;
  lastSyncAt: string | null;
  lastFullSyncAt: string | null;
  lastSyncError: string | null;
  counts: { requests: number; unmatchedMedia: number; unmatchedUsers: number };
  createdAt: string;
  updatedAt: string;
}

export interface RequestServiceProbeResult {
  applicationTitle: string;
  version: string;
  mediaServerType: 'plex' | 'jellyfin' | 'emby';
  remoteServerId: string;
  matchedServerId: string | null;
}

export interface RequestRequester {
  serverUserId: string | null;
  userId: string | null;
  serverId: string;
  username: string | null;
  identityName: string | null;
  thumb: string | null;
}

interface RequestEntryBase {
  id: string;
  serverId: string;
  status: MediaRequestStatus;
  requestedAt: string;
  availableAt: string | null;
  waitMs: number | null;
  deletedAt: string | null;
  seasons: RequestSeason[] | null;
  is4k: boolean;
  isAutoRequest: boolean;
  watchedState: WatchedState;
}

export interface MediaRequestEntry extends RequestEntryBase {
  requester: RequestRequester;
}

export interface UserRequestEntry extends RequestEntryBase {
  media: {
    mediaId: string | null;
    title: string | null;
    year: number | null;
    mediaType: MediaRequestMediaType;
  };
}

export interface UserRequestsSummary {
  total: number;
  approvalRate: number | null;
  completed: number;
  neverWatched: number;
  medianWaitMs: number | null;
}

export interface UserRequestsResponse {
  data: UserRequestEntry[];
  total: number;
  page: number;
  pageSize: number;
  summary: UserRequestsSummary;
}

const urlField = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .transform((value) => value.replace(/\/+$/, ''));
const apiKeyField = z.string().trim().min(1).max(500);

export const testRequestServiceSchema = z.strictObject({
  url: urlField,
  apiKey: apiKeyField,
});

export const createRequestServiceSchema = z.strictObject({
  serverId: uuidSchema,
  url: urlField,
  apiKey: apiKeyField,
  name: z.string().trim().min(1).max(100).optional(),
});

/** apiKey omitted keeps the stored key; a string replaces it. */
export const updateRequestServiceSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  url: urlField.optional(),
  apiKey: apiKeyField.optional(),
  enabled: z.boolean().optional(),
});

export const userRequestsQuerySchema = z.object({
  scope: z.enum(['identity']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(5),
});

export type TestRequestServiceInput = z.infer<typeof testRequestServiceSchema>;
export type CreateRequestServiceInput = z.infer<typeof createRequestServiceSchema>;
export type UpdateRequestServiceInput = z.infer<typeof updateRequestServiceSchema>;
export type UserRequestsQuery = z.infer<typeof userRequestsQuerySchema>;
