/**
 * Mobile push switches integration tests
 *
 * A switch reads whether something sends its event to Mobile push and writes the one sender it
 * owns: the unscoped builtin template instance, or the violation subscription. Runs against a
 * real database because the writes are template rebinds and version rows.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- pushSwitches
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestUser } from '@tracearr/test-utils/factories';
import type { PushEventPreference } from '@tracearr/shared';
import { db } from '../../src/db/client.js';
import {
  automations,
  automationTemplates,
  destinations,
  mobileSessions,
  notificationPreferences,
} from '../../src/db/schema.js';
import { invalidateAutomationsCache } from '../../src/jobs/poller/database.js';
import { seedBuiltinTemplates } from '../../src/services/automations/templates/seeder.js';
import { materializeInstance } from '../../src/services/automations/templates/materialize.js';
import {
  getTemplate,
  instantiateTemplate,
} from '../../src/services/automations/templates/store.js';
import { seedBuiltinDestinations } from '../../src/services/notifications/destinationsMigration.js';
import { invalidateDestinationsCache } from '../../src/services/notifications/destinationStore.js';
import {
  getPushDelivery,
  reconcileDeviceMutes,
  setPushSwitches,
} from '../../src/services/pushDelivery.js';

let pushId: string;
let webToastId: string;

beforeEach(async () => {
  // Nothing references destinations, so the shared truncate never reaches them.
  await db.delete(destinations);
  ({ pushId, webToastId } = await seedBuiltinDestinations());
  await seedBuiltinTemplates();
  invalidateDestinationsCache();
  invalidateAutomationsCache();
});

const switchOf = async (key: PushEventPreference) => {
  invalidateDestinationsCache();
  const delivery = await getPushDelivery();
  return delivery.switches![key];
};

async function instance(slug: string, to: string[], isActive = true) {
  const [found] = await db
    .select({ id: automationTemplates.id })
    .from(automationTemplates)
    .where(eq(automationTemplates.slug, slug));
  const template = await getTemplate(found!.id);
  const inputs = { to };
  const materialized = materializeInstance(template!.version, inputs, template!.name);
  if (!materialized.ok) throw new Error(materialized.reason);
  return instantiateTemplate(
    db,
    template!,
    { definition: materialized.definition, inputs },
    {
      isActive,
    }
  );
}

const instancesOf = (templateSlug: string) =>
  db
    .select({ automation: automations })
    .from(automations)
    .innerJoin(automationTemplates, eq(automationTemplates.id, automations.templateId))
    .where(eq(automationTemplates.slug, templateSlug))
    .then((rows) => rows.map((row) => row.automation));

async function pairDevice(prefs: Partial<Record<PushEventPreference, boolean>> = {}) {
  const user = await createTestUser();
  const [session] = await db
    .insert(mobileSessions)
    .values({
      userId: user.id,
      refreshTokenHash: randomUUID().replace(/-/g, ''),
      deviceName: 'phone',
      deviceId: randomUUID(),
      platform: 'ios',
    })
    .returning();
  await db.insert(notificationPreferences).values({ mobileSessionId: session!.id, ...prefs });
}

describe('push switches', () => {
  it('creates the instance once and pauses and resumes it after that', async () => {
    expect((await switchOf('onStreamStarted')).on).toBe(false);

    await setPushSwitches({ onStreamStarted: true });
    const [created] = await instancesOf('stream-started');
    expect(created?.templateInputs).toEqual({ to: [pushId] });
    expect((await switchOf('onStreamStarted')).on).toBe(true);

    await setPushSwitches({ onStreamStarted: false });
    expect((await switchOf('onStreamStarted')).on).toBe(false);
    await setPushSwitches({ onStreamStarted: true });

    const rows = await instancesOf('stream-started');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isActive).toBe(true);
  });

  it('takes push out of a shared instance and leaves its other destination sending', async () => {
    const shared = await instance('server-down', [pushId, webToastId]);

    await setPushSwitches({ onServerDown: false });

    const [row] = await db.select().from(automations).where(eq(automations.id, shared.id));
    expect(row?.isActive).toBe(true);
    expect(row?.templateInputs).toEqual({ to: [webToastId] });
    expect((await switchOf('onServerDown')).on).toBe(false);

    await setPushSwitches({ onServerDown: true });
    const [back] = await db.select().from(automations).where(eq(automations.id, shared.id));
    expect(back?.templateInputs).toEqual({ to: [webToastId, pushId] });
  });

  it('leaves a paused instance without push paused and gives push its own', async () => {
    const paused = await instance('server-up', [webToastId], false);

    await setPushSwitches({ onServerUp: true });

    const rows = await instancesOf('server-up');
    expect(rows.find((row) => row.id === paused.id)?.isActive).toBe(false);
    expect(rows.find((row) => row.id !== paused.id)?.templateInputs).toEqual({ to: [pushId] });
  });

  it('never edits a sender built in the web and keeps reading on while it sends', async () => {
    const [custom] = await db
      .insert(automations)
      .values({
        name: 'stream started, one server',
        kind: 'notification',
        triggers: [{ id: randomUUID(), type: 'session.started', enabled: true }],
        conditions: { groups: [] },
        actions: { actions: [{ id: randomUUID(), type: 'send', to: [pushId] }] },
      })
      .returning();
    invalidateAutomationsCache();

    await setPushSwitches({ onStreamStarted: false });

    const [row] = await db.select().from(automations).where(eq(automations.id, custom!.id));
    expect(row?.actions).toEqual(custom?.actions);
    expect(await switchOf('onStreamStarted')).toEqual({ on: true, others: 1, scoped: 0 });
  });

  it('reads violations from the subscription alone', async () => {
    await setPushSwitches({ onViolationDetected: false });
    await db.insert(automations).values({
      name: 'kill paused, push',
      kind: 'policy',
      triggers: [{ id: randomUUID(), type: 'session.started', enabled: true }],
      conditions: { groups: [] },
      actions: { actions: [{ id: randomUUID(), type: 'send', to: [pushId] }] },
    });
    invalidateAutomationsCache();

    expect(await switchOf('onViolationDetected')).toEqual({ on: false, others: 1, scoped: 0 });
    await setPushSwitches({ onViolationDetected: true });
    expect((await switchOf('onViolationDetected')).on).toBe(true);
  });

  it('reads every switch off and ignores flips while Mobile push is disabled', async () => {
    await db.update(destinations).set({ enabled: false }).where(eq(destinations.id, pushId));

    await setPushSwitches({ onStreamStarted: true });

    expect(await instancesOf('stream-started')).toHaveLength(0);
    expect((await switchOf('onServerDown')).on).toBe(false);
  });

  it('moves a mute every device held onto the senders and drops one only some held', async () => {
    const serverDown = await instance('server-down', [pushId]);
    const newDevice = await instance('new-device', [pushId]);
    await pairDevice({ onServerDown: false, onNewDevice: false });
    await pairDevice({ onServerDown: false });

    await reconcileDeviceMutes();

    const [down] = await db.select().from(automations).where(eq(automations.id, serverDown.id));
    const [device] = await db.select().from(automations).where(eq(automations.id, newDevice.id));
    expect(down?.isActive).toBe(false);
    expect(device?.isActive).toBe(true);
    const prefs = await db.select().from(notificationPreferences);
    expect(prefs.every((row) => row.onServerDown && row.onNewDevice)).toBe(true);
  });
});
