import { z } from 'zod';
import { assertSafeProbeUrl } from '../../utils/ssrf.js';

const REQUEST_TIMEOUT_MS = 15_000;

const seerrUserSchema = z.object({
  id: z.number().int(),
  displayName: z.string(),
  plexId: z.number().int().nullish(),
  jellyfinUserId: z.string().nullish(),
});

const seerrMediaSchema = z.object({
  id: z.number().int(),
  mediaType: z.enum(['movie', 'tv']),
  tmdbId: z.number().int().nullish(),
  tvdbId: z.number().int().nullish(),
  imdbId: z.string().nullish(),
  status: z.number().int(),
  mediaAddedAt: z.string().nullish(),
  ratingKey: z.string().nullish(),
  jellyfinMediaId: z.string().nullish(),
});

const seerrSeasonSchema = z.object({
  seasonNumber: z.number().int(),
  status: z.number().int(),
});

export const seerrRequestSchema = z.object({
  id: z.number().int(),
  status: z.number().int(),
  type: z.enum(['movie', 'tv']),
  is4k: z.boolean().default(false),
  isAutoRequest: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
  seasons: z.array(seerrSeasonSchema).default([]),
  media: seerrMediaSchema,
  requestedBy: seerrUserSchema,
});

const pageInfoSchema = z.object({
  page: z.number().int(),
  pages: z.number().int(),
  results: z.number().int(),
  pageSize: z.number().int(),
});

export const seerrRequestsPageSchema = z.object({
  pageInfo: pageInfoSchema,
  results: z.array(seerrRequestSchema),
});

export const seerrCountSchema = z.object({
  total: z.number().int(),
  movie: z.number().int(),
  tv: z.number().int(),
  pending: z.number().int(),
  approved: z.number().int(),
  declined: z.number().int(),
  processing: z.number().int(),
  available: z.number().int(),
  completed: z.number().int(),
});

const statusSchema = z.object({ version: z.string(), commitTag: z.string().optional() });
const mainSettingsSchema = z.object({
  applicationTitle: z.string(),
  mediaServerType: z.number().int(),
});
const plexSettingsSchema = z.object({ name: z.string(), machineId: z.string() });
const jellyfinSettingsSchema = z.object({ name: z.string(), serverId: z.string() });
const movieLookupSchema = z.object({ title: z.string(), releaseDate: z.string().nullish() });
const tvLookupSchema = z.object({ name: z.string(), firstAirDate: z.string().nullish() });

export type SeerrRequest = z.infer<typeof seerrRequestSchema>;
export type SeerrRequestsPage = z.infer<typeof seerrRequestsPageSchema>;
export type SeerrCounts = z.infer<typeof seerrCountSchema>;
export interface SeerrTitleLookup {
  title: string;
  year: number | null;
}

export class SeerrApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'SeerrApiError';
  }
}

function yearOf(date: string | null | undefined): number | null {
  if (!date) return null;
  const year = Number(date.slice(0, 4));
  return Number.isInteger(year) ? year : null;
}

export class SeerrClient {
  private readonly apiBase: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string
  ) {
    const trimmed = baseUrl.replace(/\/+$/, '');
    assertSafeProbeUrl(trimmed);
    this.apiBase = `${trimmed}/api/v1`;
  }

  private redact(text: string): string {
    return this.apiKey ? text.split(this.apiKey).join('[redacted]') : text;
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.apiBase}${path}`, {
        headers: { 'X-Api-Key': this.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'request failed';
      throw new SeerrApiError(this.redact(message), 0);
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 200);
      throw new SeerrApiError(
        this.redact(`Seerr responded ${response.status} for ${path}: ${body}`),
        response.status
      );
    }
    const json: unknown = await response.json();
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new SeerrApiError(`Unexpected Seerr response for ${path}`, response.status);
    }
    return parsed.data;
  }

  status() {
    return this.get('/status', statusSchema);
  }

  mainSettings() {
    return this.get('/settings/main', mainSettingsSchema);
  }

  plexSettings() {
    return this.get('/settings/plex', plexSettingsSchema);
  }

  jellyfinSettings() {
    return this.get('/settings/jellyfin', jellyfinSettingsSchema);
  }

  requestCount(): Promise<SeerrCounts> {
    return this.get('/request/count', seerrCountSchema);
  }

  requestsPage(skip: number, take: number): Promise<SeerrRequestsPage> {
    const params = new URLSearchParams({
      take: String(take),
      skip: String(skip),
      sort: 'modified',
      sortDirection: 'desc',
    });
    return this.get(`/request?${params.toString()}`, seerrRequestsPageSchema);
  }

  async movie(tmdbId: number): Promise<SeerrTitleLookup> {
    const row = await this.get(`/movie/${tmdbId}`, movieLookupSchema);
    return { title: row.title, year: yearOf(row.releaseDate) };
  }

  async tv(tmdbId: number): Promise<SeerrTitleLookup> {
    const row = await this.get(`/tv/${tmdbId}`, tvLookupSchema);
    return { title: row.name, year: yearOf(row.firstAirDate) };
  }
}
