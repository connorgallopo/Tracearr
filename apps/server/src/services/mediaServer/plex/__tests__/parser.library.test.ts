import { describe, it, expect } from 'vitest';
import { parseLibraryItemsResponse, parseRatingKeys } from '../parser.js';

function musicResponse(items: Array<Record<string, unknown>>) {
  return { MediaContainer: { Metadata: items } };
}

describe('parseLibraryItemsResponse - music', () => {
  it('extracts musicBrainzId from a mbid:// Guid entry', () => {
    const [item] = parseLibraryItemsResponse(
      musicResponse([
        {
          ratingKey: '100',
          title: 'Intro',
          type: 'track',
          addedAt: 1700000000,
          Guid: [{ id: 'mbid://f3e5c1a0-track' }],
          grandparentTitle: 'Boards of Canada',
          grandparentRatingKey: '10',
          parentTitle: 'Music Has the Right to Children',
          parentRatingKey: '20',
        },
      ])
    );

    expect(item!.musicBrainzId).toBe('f3e5c1a0-track');
    expect(item!.grandparentTitle).toBe('Boards of Canada');
    expect(item!.parentTitle).toBe('Music Has the Right to Children');
  });

  it('leaves musicBrainzId undefined when the Guid array has no mbid entry', () => {
    const [item] = parseLibraryItemsResponse(
      musicResponse([
        {
          ratingKey: '101',
          title: 'Untagged',
          type: 'track',
          addedAt: 1700000000,
          Guid: [],
        },
      ])
    );

    expect(item!.musicBrainzId).toBeUndefined();
  });

  it('carries the artist as parentTitle/parentRatingKey for an album item', () => {
    const [item] = parseLibraryItemsResponse(
      musicResponse([
        {
          ratingKey: '20',
          title: 'Music Has the Right to Children',
          type: 'album',
          addedAt: 1700000000,
          Guid: [{ id: 'mbid://album-mbid' }],
          parentTitle: 'Boards of Canada',
          parentRatingKey: '10',
        },
      ])
    );

    expect(item!.musicBrainzId).toBe('album-mbid');
    expect(item!.parentTitle).toBe('Boards of Canada');
    expect(item!.parentRatingKey).toBe('10');
  });
});

describe('parseRatingKeys', () => {
  it('lists the rating keys a batched metadata lookup returned for the section', () => {
    expect(
      parseRatingKeys(
        musicResponse([
          { ratingKey: '100', librarySectionID: 3 },
          { ratingKey: 200, librarySectionID: 3 },
          { ratingKey: '300' },
          {},
        ]),
        '3'
      )
    ).toEqual(['100', '200', '300']);
  });

  it('leaves out trashed items and items that moved to another section', () => {
    expect(
      parseRatingKeys(
        musicResponse([
          { ratingKey: '100', librarySectionID: 3, deletedAt: 1700000000 },
          { ratingKey: '200', librarySectionID: 4 },
        ]),
        '3'
      )
    ).toEqual([]);
  });

  it('is empty for a container without metadata', () => {
    expect(parseRatingKeys({ MediaContainer: {} }, '3')).toEqual([]);
  });
});
