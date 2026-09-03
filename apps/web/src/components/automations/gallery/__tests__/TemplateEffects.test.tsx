import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import type { TemplateDefinition } from '@tracearr/shared';
import { TemplateEffects, templateEffects } from '../TemplateEffects';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const definition = (overrides: Partial<TemplateDefinition> = {}): TemplateDefinition => ({
  kind: 'notification',
  triggers: [{ id: 'trigger-1', type: 'session.started', enabled: true }],
  conditions: { groups: [] },
  actions: { actions: [] },
  scope: {},
  enforceAcrossServers: false,
  cooldownMinutes: null,
  ...overrides,
});

const lines = (
  overrides: Partial<TemplateDefinition> = {},
  scope: { serverName?: string; hasServerInput: boolean } = { hasServerInput: false }
) => templateEffects(definition(overrides), scope);

describe('templateEffects', () => {
  it('names each thing the actions do', () => {
    expect(
      lines({
        actions: {
          actions: [
            { id: 'a-1', type: 'kill_stream', enabled: true },
            { id: 'a-2', type: 'trust', enabled: true, mode: 'adjust', amount: -5 },
            { id: 'a-3', type: 'message_client', enabled: true, message: 'no' },
          ],
        },
      })
    ).toEqual(['kill', 'trust', 'message', 'everyServer']);
  });

  it('sees an action buried in a branch', () => {
    expect(
      lines({
        actions: {
          actions: [
            {
              id: 'a-1',
              type: 'if',
              enabled: true,
              conditions: { groups: [] },
              then: [{ id: 'a-2', type: 'kill_stream', enabled: true }],
              else: [{ id: 'a-3', type: 'message_client', enabled: true, message: 'no' }],
            },
          ],
        },
      })
    ).toEqual(['kill', 'message', 'everyServer']);
  });

  it('says a policy files violations', () => {
    expect(lines({ kind: 'policy' })).toEqual(['violation', 'everyServer']);
  });

  it('reassures when nothing acts on anyone', () => {
    expect(
      lines({
        actions: { actions: [{ id: 'a-1', type: 'send', enabled: true, to: ['dest-1'] }] },
      })
    ).toEqual(['tellsOnly', 'everyServer']);
  });

  it('offers the escape clause only while a server is there to pick', () => {
    expect(lines({}, { hasServerInput: true })).toEqual(['tellsOnly', 'allServers']);
    expect(lines({}, { hasServerInput: false })).toEqual(['tellsOnly', 'everyServer']);
    expect(lines({}, { hasServerInput: true, serverName: 'Beehive' })).toEqual([
      'tellsOnly',
      'oneServer',
    ]);
  });
});

describe('TemplateEffects', () => {
  it('reads the lines out, naming the server it was given', () => {
    render(
      <TemplateEffects
        definition={definition({
          kind: 'policy',
          actions: { actions: [{ id: 'a-1', type: 'kill_stream', enabled: true }] },
        })}
        hasServerInput
        serverName="Beehive"
      />
    );

    expect(screen.getByText('Can stop a stream that is playing.')).toBeInTheDocument();
    expect(screen.getByText('Records a violation against the matched person.')).toBeInTheDocument();
    expect(screen.getByText('Runs on Beehive only.')).toBeInTheDocument();
  });

  it('names its own surface, since the block has no heading', () => {
    render(<TemplateEffects definition={definition()} hasServerInput={false} />);

    expect(screen.getByRole('region', { name: 'What this will do' })).toBeInTheDocument();
  });
});
