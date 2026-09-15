import { isNotNull } from 'drizzle-orm';
import type { Action, AutomationActions, LeafAction } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { automations, newsletters } from '../../db/schema.js';
import { listDestinations } from './destinationStore.js';

/** A branch holds effects of its own, so a destination can live one level down. */
const leaves = (action: Action): LeafAction[] =>
  action.type === 'if' ? [...action.then, ...action.else] : [action];

/**
 * The destination ids a save names that no row backs. A send action storing one
 * would fail silently at match time, so the save paths reject it up front.
 */
export async function unknownDestinationIds(
  actions: AutomationActions | undefined
): Promise<string[]> {
  const sendIds = [
    ...new Set(
      actions?.actions.flatMap(leaves).flatMap((a) => (a.type === 'send' ? a.to : [])) ?? []
    ),
  ];
  if (sendIds.length === 0) return [];
  const known = new Set((await listDestinations()).map((d) => d.id));
  return sendIds.filter((id) => !known.has(id));
}

export interface DestinationRef {
  ruleId: string;
  ruleName: string;
  isActive: boolean;
}

/** Every automation, active or not; getActiveAutomations is cached and filters inactive rows, which must still block a delete. */
export async function automationsReferencingDestinations(): Promise<Map<string, DestinationRef[]>> {
  const rows = await db
    .select({
      id: automations.id,
      name: automations.name,
      isActive: automations.isActive,
      actions: automations.actions,
    })
    .from(automations)
    .where(isNotNull(automations.actions));

  const refs = new Map<string, DestinationRef[]>();
  for (const row of rows) {
    for (const action of (row.actions?.actions ?? []).flatMap(leaves)) {
      if (action.type !== 'send') continue;
      for (const id of action.to) {
        const list = refs.get(id) ?? [];
        list.push({ ruleId: row.id, ruleName: row.name, isActive: row.isActive });
        refs.set(id, list);
      }
    }
  }
  return refs;
}

/** Newsletter names per destination id; a newsletter with no destination references nothing. */
export async function newslettersReferencingDestinations(): Promise<Map<string, string[]>> {
  const rows = await db
    .select({ name: newsletters.name, destinationId: newsletters.destinationId })
    .from(newsletters)
    .where(isNotNull(newsletters.destinationId));

  const refs = new Map<string, string[]>();
  for (const row of rows) {
    if (row.destinationId === null) continue;
    refs.set(row.destinationId, [...(refs.get(row.destinationId) ?? []), row.name]);
  }
  return refs;
}
