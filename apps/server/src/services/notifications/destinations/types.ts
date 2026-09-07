import type { DestinationKind, NotificationEventType } from '@tracearr/shared';
import type { NotificationEvent, NotificationSource } from '../events.js';

export interface RenderContext {
  destination: { id: string; name: string };
  source: NotificationSource;
}

export interface DeliverContext {
  destination: { id: string; name: string };
  signal: AbortSignal;
}

/** A kind that picks the address itself says where the test went. */
export interface TestReport {
  sentTo?: string;
}

export interface DestinationType<C, R> {
  kind: DestinationKind;
  events: readonly NotificationEventType[];
  /** Replaces the queue's default deliver timeout. Nominal for kinds whose deliver ignores the signal; their transport's own timeouts bound the call. */
  deliverTimeoutMs?: number;
  render(event: NotificationEvent, config: C, ctx: RenderContext): Promise<R> | R;
  /** Throws on any failure; the queue's retries and DLQ depend on that. */
  deliver(rendered: R, config: C, ctx: DeliverContext): Promise<void>;
  test(config: C, ctx: DeliverContext): Promise<TestReport | void>;
}
