import type {
  Action,
  Condition,
  EngineAutomation,
  GroupEvidence,
  Server,
  ServerUser,
  Session,
  TriggerNode,
} from '@tracearr/shared';
import type { Executor } from '../../db/client.js';
import type { ContextEvaluatingEvent } from './events/evaluate.js';

/** The six library_items rollup columns a media trigger compares and renders. */
export interface MediaQuality {
  resolution: string | null;
  dynamicRange: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioChannels: number | null;
  fileSize: number | null;
}

/** The signature's fields, in the order the upgrade edge key joins them. */
export const MEDIA_QUALITY_FIELDS = [
  'resolution',
  'dynamicRange',
  'videoCodec',
  'audioCodec',
  'audioChannels',
  'fileSize',
] as const satisfies readonly (keyof MediaQuality)[];

/** The library item a media trigger is about, as it stands after the sync. */
export interface MediaSubject {
  libraryItemId: string;
  ratingKey: string;
  /** Canonical media id, which is what Tracearr's own media page is keyed by. */
  mediaId: string | null;
  title: string;
  /** The show or artist an episode or track belongs to; null for anything standalone. */
  grandparentTitle: string | null;
  /** The season or album. On a season row this holds the show instead, which is what names it. */
  parentTitle: string | null;
  grandparentRatingKey: string | null;
  parentRatingKey: string | null;
  /** Season number on an episode or a season; null elsewhere. */
  parentIndex: number | null;
  /** Episode or track number; null elsewhere. */
  itemIndex: number | null;
  type: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  thumbPath: string | null;
  libraryId: string;
  libraryName: string;
  quality: MediaQuality;
  /** Set only on a season that swallowed the episodes one sync run added under it. */
  addedEpisodeCount?: number;
}

/** Rules read the server's identity, not its lifecycle; the database row carries historicalAt as a Date. */
type ContextServer = Omit<Server, 'historicalAt'>;

export interface EvaluationContext {
  /** null outside a playback session: account, media, server and install triggers. */
  session: Session | null;
  /** null for media, server and install triggers, which are about no one. */
  serverUser: ServerUser | null;
  /** null for install triggers, the only context with no server behind it. */
  server: ContextServer | null;
  /** Set only by the two media triggers; every other context leaves it null. */
  media: MediaSubject | null;
  /** What the run is about, as the recorder keys it: session id, server user id, `media:<id>`, `server:<id>` or `install`. */
  subjectKey: string;
  /** The event being evaluated; absent for kill re-verification, which runs no send. */
  trigger?: ContextEvaluatingEvent;
  /** The trigger node the event fired through, so a message can render what that node measured. */
  triggerNode?: TriggerNode;
  activeSessions: Session[];
  recentSessions: Session[];
  rule: EngineAutomation;
  /** All server_user ids belonging to the same identity as serverUser.
   *  Optional so contexts built before a lookup (or in old tests) fall back
   *  to single server_user behavior. */
  identityServerUserIds?: string[];
  /** Transaction used when a membership condition runs during session creation. */
  membershipExecutor?: Executor;
  /** Violation this match created, if any. Populated by callers that insert
   *  the violation before executing actions; kill_stream needs it to attribute
   *  the eventual queue outcome (killed/skipped/failed) back to the record. */
  violationId?: string | null;
}

export interface EvaluatorResult {
  matched: boolean;
  actual: unknown;
  relatedSessionIds?: string[];
  details?: Record<string, unknown>;
}

/** The contexts by depth: each one supplies everything its parent does and more. */
export type ServerEvaluationContext = EvaluationContext & { server: ContextServer };
export type AccountEvaluationContext = ServerEvaluationContext & { serverUser: ServerUser };
export type SessionEvaluationContext = AccountEvaluationContext & { session: Session };

/** The engine compares the field's `requires` against the context before calling any of these. */
export type ConditionEvaluator = (
  context: SessionEvaluationContext,
  condition: Condition
) => EvaluatorResult | Promise<EvaluatorResult>;

export type AccountConditionEvaluator = (
  context: AccountEvaluationContext,
  condition: Condition
) => EvaluatorResult | Promise<EvaluatorResult>;

export type ServerConditionEvaluator = (
  context: ServerEvaluationContext,
  condition: Condition
) => EvaluatorResult | Promise<EvaluatorResult>;

/** Non-void executors return which target session ids they successfully
 *  handed to a downstream queue (currently kill_stream only). queueFailure is
 *  set when there were targets to kill but none reached the queue (queue down),
 *  so the caller records the action as failed rather than queued. skipReason
 *  says the context held nothing to act on, and records the action as skipped. */
export type ActionExecutorResult = {
  enqueuedSessionIds?: string[];
  queueFailure?: boolean;
  skipReason?: string;
} | void;

export type ActionExecutor = (
  context: EvaluationContext,
  action: Action
) => ActionExecutorResult | Promise<ActionExecutorResult>;

export interface EvaluationResult {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  matchedGroups: number[];
  actions: Action[];
  evidence?: GroupEvidence[];
  /** The group that ended the walk, for the run record's summary. Set only when unmatched. */
  stoppedBy?: GroupEvidence;
}
