import { describe, expect, it, vi } from 'vitest';
import { compareVersions, type ReleaseNotesFile } from '@tracearr/shared';
import { parseReleaseNotes, selectAutoOpen, selectReopen } from './releaseNotes';

const note = (version: string): ReleaseNotesFile => ({
  version,
  date: '2026-01-01',
  ...(/^\d+\.\d+\.0$/.test(version) ? { headline: 'Headline' } : {}),
  changes: [{ type: 'fix', text: 'a fix' }],
});

const NOTES = ['2.1.0', '2.2.0', '2.2.3', '2.3.0', '2.3.1', '2.3.2', '2.4.0', '2.5.0']
  .map(note)
  .sort((a, b) => compareVersions(b.version, a.version));

const versions = (list: ReleaseNotesFile[] | undefined) => list?.map((n) => n.version);

describe('parseReleaseNotes', () => {
  it('skips a malformed file instead of throwing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const files = {
      '../../../../release-notes/2.3.0.json': note('2.3.0'),
      '../../../../release-notes/broken.json': { version: 'not-a-version' },
    };

    const parsed = parseReleaseNotes(files);

    expect(versions(parsed)).toEqual(['2.3.0']);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });
});

describe('selectAutoOpen', () => {
  it.each([
    ['legacy', '2.3.0', ['2.3.0'], []],
    ['2.2.3', '2.3.2', ['2.3.0'], ['2.3.2', '2.3.1']],
    ['2.1.0', '2.3.0', ['2.3.0', '2.2.0'], []],
    ['2.3.0-beta.6', '2.3.0', ['2.3.0'], []],
    ['2.2.3', '2.3.0-beta.6', ['2.3.0'], []],
    ['2.3.0-beta.4', '2.3.0-beta.6', ['2.3.0'], []],
    ['legacy', '2.3.0-beta.6', ['2.3.0'], []],
    ['2.2.3', '2.2.3-beta.1', ['2.2.3'], []],
  ])('from %s to %s shows the right releases', (lastSeen, running, lead, patches) => {
    const sections = selectAutoOpen(NOTES, running, lastSeen);
    expect(versions(sections?.lead)).toEqual(lead);
    expect(versions(sections?.patches)).toEqual(patches);
    expect(sections?.earlier).toEqual([]);
  });

  it.each([
    ['2.3.0', '2.3.2'],
    ['2.5.0', '2.4.0'],
    ['2.3.0', '2.3.0'],
    ['2.3.0-beta.6', '2.3.0-beta.6'],
    ['legacy', '0.0.0'],
    ['2.4.0-beta.2', '2.3.0-beta.6'],
  ])('from %s to %s shows nothing', (lastSeen, running) => {
    expect(selectAutoOpen(NOTES, running, lastSeen)).toBeNull();
  });

  it('gives nothing when a beta build has no file for its base version', () => {
    expect(selectAutoOpen(NOTES, '2.6.0-beta.1', '2.5.0')).toBeNull();
  });

  it('shows nothing before the boot seed has run', () => {
    expect(selectAutoOpen(NOTES, '2.3.0', null)).toBeNull();
  });

  it('labels patches with their minor', () => {
    expect(selectAutoOpen(NOTES, '2.3.2', '2.2.3')?.since).toBe('2.3.0');
  });
});

describe('selectReopen', () => {
  it('shows the running minor, its patches, then earlier minors', () => {
    const sections = selectReopen(NOTES, '2.3.2');
    expect(versions(sections.lead)).toEqual(['2.3.0']);
    expect(versions(sections.patches)).toEqual(['2.3.2', '2.3.1']);
    expect(sections.since).toBe('2.3.0');
    expect(versions(sections.earlier)).toEqual(['2.2.0', '2.1.0']);
  });

  it('shows the running release plus older minors on a beta build', () => {
    const sections = selectReopen(NOTES, '2.3.0-beta.5');
    expect(versions(sections.lead)).toEqual(['2.3.0']);
    expect(sections.patches).toEqual([]);
    expect(versions(sections.earlier)).toEqual(['2.2.0', '2.1.0']);
  });

  it('is empty on a dev build', () => {
    const sections = selectReopen(NOTES, '0.0.0');
    expect([...sections.lead, ...sections.patches, ...sections.earlier]).toEqual([]);
  });
});
