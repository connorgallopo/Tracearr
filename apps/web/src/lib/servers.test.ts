import { describe, it, expect } from 'vitest';
import {
  allSelectedNeedLibraryEmptyState,
  librarySyncEnabled,
  serverNeedsLibrarySetup,
} from './servers';

describe('librarySyncEnabled', () => {
  it('defaults to on when the field is missing', () => {
    expect(librarySyncEnabled({})).toBe(true);
  });

  it('is off only when the flag is false', () => {
    expect(librarySyncEnabled({ librarySyncEnabled: false })).toBe(false);
    expect(librarySyncEnabled({ librarySyncEnabled: true })).toBe(true);
  });
});

describe('serverNeedsLibrarySetup', () => {
  const unsynced = { isSynced: false, needsBackfill: false, isBackfillRunning: false };
  const ready = { isSynced: true, needsBackfill: false, isBackfillRunning: false };
  const backfill = { isSynced: true, needsBackfill: true, isBackfillRunning: false };

  it('ignores unsynced servers whose library sync is disabled', () => {
    expect(serverNeedsLibrarySetup({ librarySyncEnabled: false }, unsynced)).toBe(false);
  });

  it('flags an unsynced server that still syncs its catalog', () => {
    expect(serverNeedsLibrarySetup({ librarySyncEnabled: true }, unsynced)).toBe(true);
    expect(serverNeedsLibrarySetup({}, unsynced)).toBe(true);
  });

  it('flags backfill on a sync-enabled server and skips it when sync is off', () => {
    expect(serverNeedsLibrarySetup({}, backfill)).toBe(true);
    expect(serverNeedsLibrarySetup({ librarySyncEnabled: false }, backfill)).toBe(false);
  });

  it('is quiet when the catalog is ready or status has not loaded', () => {
    expect(serverNeedsLibrarySetup({}, ready)).toBe(false);
    expect(serverNeedsLibrarySetup({}, undefined)).toBe(false);
  });
});

describe('allSelectedNeedLibraryEmptyState', () => {
  const plex = { id: 'plex', librarySyncEnabled: true };
  const ether = { id: 'ether', librarySyncEnabled: false };
  const unsynced = { data: { isSynced: false, needsBackfill: false, isBackfillRunning: false } };
  const ready = { data: { isSynced: true, needsBackfill: false, isBackfillRunning: false } };

  it('is quiet while status is loading or nothing is selected', () => {
    expect(allSelectedNeedLibraryEmptyState([plex], new Map(), true)).toBe(false);
    expect(allSelectedNeedLibraryEmptyState([], new Map([[plex.id, unsynced]]), false)).toBe(false);
  });

  it('shows empty state when every selected server is session-only', () => {
    expect(allSelectedNeedLibraryEmptyState([ether], new Map([[ether.id, unsynced]]), false)).toBe(
      true
    );
  });

  it('ignores a session-only server next to a ready catalog', () => {
    const status = new Map([
      [plex.id, ready],
      [ether.id, unsynced],
    ]);
    expect(allSelectedNeedLibraryEmptyState([plex, ether], status, false)).toBe(false);
  });

  it('shows empty state when every sync-enabled server still needs setup', () => {
    const status = new Map([
      [plex.id, unsynced],
      [ether.id, unsynced],
    ]);
    expect(allSelectedNeedLibraryEmptyState([plex, ether], status, false)).toBe(true);
  });
});
