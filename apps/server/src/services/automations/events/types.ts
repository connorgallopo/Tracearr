import type {
  EngineAutomation,
  Session,
  TriggerType as CatalogTriggerType,
  ViolationSeverity,
} from '@tracearr/shared';
import type { db } from '../../../db/client.js';
import type { sessions } from '../../../db/schema.js';
import type { ActionResult } from '../executors/index.js';
import type { MediaQuality, MediaSubject } from '../types.js';
import type { ViolationInsertResult } from '../../../jobs/poller/violations.js';
import type { NewsletterSendPayload } from '../../notifications/events.js';

export type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type SessionRow = typeof sessions.$inferSelect;

/** The catalog plus the three types that only cancel wakes and are never stored on an automation. */
export type TriggerType =
  CatalogTriggerType | 'session.resumed' | 'session.media_changed' | 'session.ended';

/** What every producer already holds about the server; matches SessionCreationInput['server']. */
export interface EvaluationServer {
  id: string;
  name: string;
  type: 'plex' | 'jellyfin' | 'emby';
}

/** What every producer already holds about the account; matches SessionCreationInput['serverUser']. */
export interface EvaluationServerUser {
  id: string;
  userId: string;
  username: string;
  thumbUrl: string | null;
  identityName: string | null;
  trustScore: number;
  lastActivityAt: Date | null;
  createdAt: Date;
  identityServerUserIds: string[];
}

export interface PauseData {
  lastPausedAt: Date | null;
  pausedDurationMs: number;
}

interface BaseEvent {
  at: Date;
}

interface SessionEventBase extends BaseEvent {
  server: EvaluationServer;
  serverUser: EvaluationServerUser;
  session: Session;
}

export interface SessionStartedEvent extends SessionEventBase {
  type: 'session.started';
}

/** First sight of a new playback, before the confirmation delay persists it. */
export interface SessionFirstSeenEvent extends SessionEventBase {
  type: 'session.first_seen';
}

export interface SessionTranscodeChangedEvent extends SessionEventBase {
  type: 'session.transcode_changed';
  previous: { videoDecision: string | null; audioDecision: string | null };
  next: { videoDecision: string | null; audioDecision: string | null };
}

export interface SessionPausedEvent extends SessionEventBase {
  type: 'session.paused';
  pauseData: PauseData;
}

export interface SessionHeldForEvent extends SessionEventBase {
  type: 'session.held_for';
  pauseData: PauseData;
  heldMinutes: number;
  /** The held_for node whose crossing armed this wake; absent for a compound-rule recheck. */
  triggerNodeId?: string;
}

/** Wake cancellations carry ids and no evaluation inputs. */
interface SessionRefBase extends BaseEvent {
  sessionId: string;
  serverId: string;
}

export interface SessionResumedEvent extends SessionRefBase {
  type: 'session.resumed';
}

export interface SessionMediaChangedEvent extends SessionRefBase {
  type: 'session.media_changed';
}

/**
 * Why a row was stopped. The two continuations keep playing under a new row, so they
 * cancel the wake but end no stream.
 */
export type SessionStopReason = 'ended' | 'quality_change' | 'media_change';

/** The ref twin of session.stopped: every stop cancels wakes, so this one never pays for a context. */
export interface SessionEndedEvent extends SessionRefBase {
  type: 'session.ended';
}

export type SessionRefEvent = SessionResumedEvent | SessionMediaChangedEvent | SessionEndedEvent;

export interface SessionStoppedEvent extends SessionEventBase {
  type: 'session.stopped';
  durationMs: number;
}

export interface AccountInactiveForEvent extends BaseEvent {
  type: 'account.inactive_for';
  server: EvaluationServer;
  serverUser: EvaluationServerUser;
  session: null;
}

/** The session that announced the device is the one it fires on, so it carries every session field. */
export interface AccountNewDeviceEvent extends SessionEventBase {
  type: 'account.new_device';
  device: {
    name: string;
    platform: string | null;
    product: string | null;
    location: string | null;
  };
}

export interface AccountTrustChangedEvent extends BaseEvent {
  type: 'account.trust_changed';
  server: EvaluationServer;
  serverUser: EvaluationServerUser;
  session: null;
  previous: number;
  next: number;
  /** The automation that moved it, or how an owner did; null when the writer named none. */
  reason: string | null;
}

interface MediaEventBase extends BaseEvent {
  server: EvaluationServer;
  media: MediaSubject;
}

export interface MediaAddedEvent extends MediaEventBase {
  type: 'media.added';
}

export interface MediaUpgradedEvent extends MediaEventBase {
  type: 'media.upgraded';
  /** The signature before the sync, and the fields of it that moved. */
  from: MediaQuality;
  changed: (keyof MediaQuality)[];
}

export interface ServerDownEvent extends BaseEvent {
  type: 'server.down';
  server: EvaluationServer;
}

export interface ServerUpEvent extends BaseEvent {
  type: 'server.up';
  server: EvaluationServer;
}

export interface PluginUpdateEvent extends BaseEvent {
  type: 'plugin.update_available';
  server: EvaluationServer;
  installedVersion: string | null;
  latestVersion: string;
  downloadUrl: string;
}

export interface ServerUpdateEvent extends BaseEvent {
  type: 'server.update_available';
  server: EvaluationServer;
  installedVersion: string;
  latestVersion: string;
  releaseUrl: string;
}

export interface TracearrUpdateEvent extends BaseEvent {
  type: 'tracearr.update_available';
  current: string;
  latest: string;
  releaseUrl: string;
}

export interface NewsletterSentEvent extends BaseEvent, NewsletterSendPayload {
  type: 'newsletter.sent';
}

export interface NewsletterFailedEvent extends BaseEvent, NewsletterSendPayload {
  type: 'newsletter.failed';
}

export type RuleEvent =
  | SessionStartedEvent
  | SessionFirstSeenEvent
  | SessionTranscodeChangedEvent
  | SessionPausedEvent
  | SessionHeldForEvent
  | SessionStoppedEvent
  | SessionRefEvent
  | AccountInactiveForEvent
  | AccountNewDeviceEvent
  | AccountTrustChangedEvent
  | MediaAddedEvent
  | MediaUpgradedEvent
  | ServerDownEvent
  | ServerUpEvent
  | PluginUpdateEvent
  | ServerUpdateEvent
  | TracearrUpdateEvent
  | NewsletterSentEvent
  | NewsletterFailedEvent;

/** Distributes over the event union by member, which keeps a Subscriber<T> assignable to Subscriber<TriggerType>. */
export type EventOf<T extends TriggerType> = RuleEvent extends infer E
  ? E extends { type: TriggerType }
    ? T extends E['type']
      ? E
      : never
    : never
  : never;

/** Tick-scoped, in-process; passed alongside the event, never part of it. Arrays are by reference. */
export interface EvaluationInputs {
  activeAutomations: EngineAutomation[];
  activeSessions: Session[];
  recentSessions: Session[];
  identityServerUserIds?: string[];
}

export interface DispatchOptions {
  /** Evaluate and record inside the caller's transaction (create path). Errors propagate. */
  tx?: DbTx;
  /** Return the act step as a closure instead of running it (create path). */
  deferActions?: boolean;
}

export interface SubscriberResult {
  violations: ViolationInsertResult[];
  deferredActions?: () => Promise<ActionResult[]>;
}

export type Subscriber<T extends TriggerType> = (
  event: EventOf<T>,
  inputs: EvaluationInputs | undefined,
  opts: DispatchOptions
) => Promise<SubscriberResult | void>;

export interface SubscriberOutcome {
  subscriber: string;
  ok: boolean;
  error?: unknown;
}

export interface DispatchResult {
  violations: ViolationInsertResult[];
  deferredActions?: () => Promise<ActionResult[]>;
  outcomes: SubscriberOutcome[];
}

export type { ViolationSeverity };
