import { describe, expect, it, vi } from 'vitest';
import type { AutomationActions } from '@tracearr/shared';

interface RuleRow {
  id: string;
  name: string;
  isActive: boolean;
  actions: AutomationActions | null;
}

const ruleRows: RuleRow[] = [];
const newsletterRows: { name: string; destinationId: string | null }[] = [];
vi.mock('../../db/client.js', () => ({
  db: {
    select: (columns: Record<string, unknown>) => ({
      from: () => ({
        where: async () => ('destinationId' in columns ? [...newsletterRows] : [...ruleRows]),
      }),
    }),
  },
}));

const listed: { id: string }[] = [];
vi.mock('../notifications/destinationStore.js', () => ({
  listDestinations: async () => [...listed],
}));

import {
  automationsReferencingDestinations,
  newslettersReferencingDestinations,
  unknownDestinationIds,
} from '../notifications/destinationRefs.js';

const branchSend = (id: string): AutomationActions => ({
  actions: [
    {
      type: 'if',
      conditions: { groups: [] },
      then: [{ type: 'send', to: [id] }],
      else: [],
    },
  ],
});

describe('automationsReferencingDestinations', () => {
  it('counts inactive rules and ignores non-send actions', async () => {
    ruleRows.length = 0;
    ruleRows.push(
      {
        id: 'rule-1',
        name: 'Active both',
        isActive: true,
        actions: { actions: [{ type: 'send', to: ['dest-a', 'dest-b'] }] },
      },
      {
        id: 'rule-2',
        name: 'Inactive A',
        isActive: false,
        actions: { actions: [{ type: 'send', to: ['dest-a'] }] },
      },
      {
        id: 'rule-3',
        name: 'Kill only',
        isActive: true,
        actions: { actions: [{ type: 'kill_stream' }] },
      }
    );

    const refs = await automationsReferencingDestinations();

    expect(refs.get('dest-a')).toEqual([
      { ruleId: 'rule-1', ruleName: 'Active both', isActive: true },
      { ruleId: 'rule-2', ruleName: 'Inactive A', isActive: false },
    ]);
    expect(refs.get('dest-b')).toEqual([
      { ruleId: 'rule-1', ruleName: 'Active both', isActive: true },
    ]);
    expect(refs.size).toBe(2);
  });

  it('finds a send that only exists inside a branch', async () => {
    ruleRows.length = 0;
    ruleRows.push({
      id: 'rule-4',
      name: 'Branch only',
      isActive: true,
      actions: branchSend('dest-c'),
    });

    const refs = await automationsReferencingDestinations();

    expect(refs.get('dest-c')).toEqual([
      { ruleId: 'rule-4', ruleName: 'Branch only', isActive: true },
    ]);
  });
});

describe('unknownDestinationIds', () => {
  it('names a branch destination no row backs', async () => {
    listed.length = 0;
    listed.push({ id: 'dest-a' });

    expect(await unknownDestinationIds(branchSend('dest-c'))).toEqual(['dest-c']);
    expect(await unknownDestinationIds(branchSend('dest-a'))).toEqual([]);
  });
});

describe('newslettersReferencingDestinations', () => {
  it('groups newsletter names by destination and skips rows that point at none', async () => {
    newsletterRows.length = 0;
    newsletterRows.push(
      { name: 'Weekly', destinationId: 'dest-a' },
      { name: 'Monthly', destinationId: 'dest-a' },
      { name: 'Orphan', destinationId: null }
    );

    const refs = await newslettersReferencingDestinations();

    expect(refs.get('dest-a')).toEqual(['Weekly', 'Monthly']);
    expect(refs.size).toBe(1);
  });
});
