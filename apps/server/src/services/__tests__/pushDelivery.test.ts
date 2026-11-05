import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AutomationKind, LeafAction, TriggerNode, TriggerType } from '@tracearr/shared';
import { pushSenderCounts, pushSenders } from '../pushDelivery.js';

const PUSH = '11111111-1111-4111-8111-111111111111';
const DISCORD = '22222222-2222-4222-8222-222222222222';

const send = (to: string[], enabled?: boolean): LeafAction => ({
  type: 'send',
  to,
  ...(enabled !== undefined && { enabled }),
});

const trigger = (type: TriggerType, enabled = true) => ({ id: randomUUID(), enabled, type });

const automation = (kind: AutomationKind, triggers: TriggerType[], actions: LeafAction[]) => ({
  kind,
  triggers: triggers.map((type) => trigger(type)) as TriggerNode[],
  actions: { actions },
});

describe('pushSenderCounts', () => {
  it('counts a notification automation under the event its trigger sends', () => {
    const counts = pushSenderCounts(
      pushSenders(
        [
          automation('notification', ['session.started'], [send([PUSH])]),
          automation('notification', ['session.first_seen'], [send([PUSH, DISCORD])]),
          automation('notification', ['server.down'], [send([PUSH])]),
        ],
        PUSH
      )
    );

    expect(counts.onStreamStarted).toBe(2);
    expect(counts.onServerDown).toBe(1);
    expect(counts.onStreamStopped).toBe(0);
  });

  it('ignores a send that names another destination or is switched off', () => {
    const counts = pushSenderCounts(
      pushSenders(
        [
          automation('notification', ['session.stopped'], [send([DISCORD])]),
          automation('notification', ['session.stopped'], [send([PUSH], false)]),
        ],
        PUSH
      )
    );

    expect(counts.onStreamStopped).toBe(0);
  });

  it('ignores a trigger that is switched off', () => {
    const counts = pushSenderCounts(
      pushSenders(
        [
          {
            kind: 'notification' as const,
            triggers: [trigger('server.up', false)] as TriggerNode[],
            actions: { actions: [send([PUSH])] },
          },
        ],
        PUSH
      )
    );

    expect(counts.onServerUp).toBe(0);
  });

  it('counts a send inside a branch', () => {
    const counts = pushSenderCounts(
      pushSenders(
        [
          {
            kind: 'notification' as const,
            triggers: [trigger('account.new_device')] as TriggerNode[],
            actions: {
              actions: [
                { type: 'if', conditions: { groups: [] }, then: [], else: [send([PUSH])] } as never,
              ],
            },
          },
        ],
        PUSH
      )
    );

    expect(counts.onNewDevice).toBe(1);
  });

  it('counts a policy automation as a violation whatever its trigger', () => {
    const counts = pushSenderCounts(
      pushSenders([automation('policy', ['session.started'], [send([PUSH])])], PUSH)
    );

    expect(counts.onViolationDetected).toBe(1);
    expect(counts.onStreamStarted).toBe(0);
  });

  it('ignores a policy automation with no trigger switched on', () => {
    const counts = pushSenderCounts(
      pushSenders(
        [
          { kind: 'policy' as const, triggers: [], actions: { actions: [send([PUSH])] } },
          {
            kind: 'policy' as const,
            triggers: [trigger('session.started', false)] as TriggerNode[],
            actions: { actions: [send([PUSH])] },
          },
        ],
        PUSH
      )
    );

    expect(counts.onViolationDetected).toBe(0);
  });

  it('counts a trigger with no event of its own as a violation', () => {
    const counts = pushSenderCounts(
      pushSenders([automation('notification', ['session.paused'], [send([PUSH])])], PUSH)
    );

    expect(counts.onViolationDetected).toBe(1);
  });

  it('counts an automation once per event', () => {
    const counts = pushSenderCounts(
      pushSenders(
        [
          automation(
            'notification',
            ['session.started', 'session.first_seen'],
            [send([PUSH]), send([PUSH])]
          ),
        ],
        PUSH
      )
    );

    expect(counts.onStreamStarted).toBe(1);
  });

  it('leaves out events no device toggle covers', () => {
    const counts = pushSenderCounts(
      pushSenders([automation('notification', ['media.added'], [send([PUSH])])], PUSH)
    );

    expect(Object.values(counts).every((n) => n === 0)).toBe(true);
  });
});
