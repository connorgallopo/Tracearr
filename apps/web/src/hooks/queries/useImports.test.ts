import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import type { LatestImportStatus } from '@tracearr/shared';
import { importPhase, latestImportProgress, type ImportPhase } from './useImports';

const t = ((key: string, opts?: Record<string, unknown>) =>
  opts === undefined ? key : [key, ...Object.values(opts)].join(' ')) as TFunction<'settings'>;

type Progress = { status: string; message: string };
type Result = { message: string };

const shape = {
  blank: (status: string, message: string): Progress => ({ status, message }),
  fromResult: (result: Result): Progress => ({ status: 'complete', message: result.message }),
};

const running = { status: 'processing', message: 'Processing: 50 plays' };

describe('latestImportProgress', () => {
  it.each<[string, LatestImportStatus<Progress, Result> | null, Progress | null, ImportPhase]>([
    ['no import', null, null, 'none'],
    [
      'waiting for the library sync',
      { state: 'waitingForLibrarySync', librarySync: { state: 'running', progress: 40 } },
      { status: 'waiting', message: 'import.waitingForLibrarySyncPercent 40' },
      'pending',
    ],
    [
      'queued',
      { state: 'queued' },
      { status: 'waiting', message: 'import.importQueued' },
      'pending',
    ],
    ['running', { state: 'running', progress: running }, running, 'importing'],
    [
      'running before its first progress',
      { state: 'running', progress: null },
      { status: 'processing', message: 'import.importInProgressGeneric' },
      'importing',
    ],
    [
      'retrying',
      { state: 'retrying', attempt: 1, attempts: 3, reason: "Couldn't reach Tautulli." },
      { status: 'retrying', message: "import.importRetrying Couldn't reach Tautulli 2 3" },
      'pending',
    ],
    [
      'failed',
      { state: 'failed', reason: 'key rejected' },
      { status: 'error', message: 'import.importFailedReason key rejected' },
      'failed',
    ],
    [
      'failed without a reason',
      { state: 'failed', reason: null },
      { status: 'error', message: 'import.importFailed' },
      'failed',
    ],
    [
      'complete',
      { state: 'complete', result: { message: 'Done' }, finishedAt: null },
      { status: 'complete', message: 'Done' },
      'complete',
    ],
  ])('shows an import that is %s', (_name, latest, expected, phase) => {
    const progress = latestImportProgress(latest, shape, t);

    expect(progress).toEqual(expected);
    expect(importPhase(progress)).toBe(phase);
  });
});
