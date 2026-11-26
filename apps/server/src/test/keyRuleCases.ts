/**
 * Cases for the rules that decide whether an imported play keeps the library item its rating
 * key names. The TS rules and their SQL forms are both tested against these rows; importOnly
 * rows read the play's guid or legacy ids, which only the import has.
 */

import type {
  KeyedItem,
  KeyedPlay,
  LinkedMedia,
  RepairClause,
} from '../services/import/libraryKeyMatch.js';

function episodeItem(fields: Partial<KeyedItem>): KeyedItem {
  return {
    mediaType: 'episode',
    title: null,
    year: null,
    showTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    plexGuid: null,
    showTvdbId: null,
    showTmdbId: null,
    imdbId: null,
    tmdbId: null,
    ...fields,
  };
}

function movieItem(fields: Partial<KeyedItem>): KeyedItem {
  return episodeItem({ mediaType: 'movie', ...fields });
}

function episodePlay(fields: Partial<KeyedPlay>): KeyedPlay {
  return {
    mediaType: 'episode',
    title: null,
    year: null,
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    guid: null,
    ...fields,
  };
}

function moviePlay(fields: Partial<KeyedPlay>): KeyedPlay {
  return episodePlay({ mediaType: 'movie', ...fields });
}

function episodeLink(fields: Partial<LinkedMedia>): LinkedMedia {
  return { mediaType: 'episode', title: null, year: null, showTitle: null, numbers: [], ...fields };
}

const SPONGEBOB_S12E3 = episodePlay({
  grandparentTitle: 'SpongeBob SquarePants',
  seasonNumber: 12,
  episodeNumber: 3,
  title: 'The Krusty Slammer',
  year: 2019,
});
const FORGED_IN_FIRE_S7E17 = episodePlay({
  grandparentTitle: 'Forged in Fire',
  seasonNumber: 7,
  episodeNumber: 17,
  title: 'The Zweihander',
  year: 2020,
});
const SPONGEBOB_S12E22 = episodePlay({
  grandparentTitle: 'SpongeBob SquarePants',
  seasonNumber: 12,
  episodeNumber: 22,
  title: 'Big Bad Bubble Bass',
  year: null,
});
const PLURIBUS_S1E1 = episodePlay({
  grandparentTitle: 'Pluribus',
  seasonNumber: 1,
  episodeNumber: 1,
  title: 'Episode 1',
  year: 2025,
});

const BLACKLIST_S3E8 = {
  showTitle: 'The Blacklist',
  title: 'Kings of the Highway',
  year: 2015,
};
const BLACKLIST_S7E9 = { showTitle: 'The Blacklist', title: 'Les Fleurs du Mal', year: 2019 };
const BLACKLIST_S2E15 = { showTitle: 'The Blacklist', title: 'The Major', year: 2015 };
const PLUR1BUS_S1E1 = { showTitle: 'PLUR1BUS', title: 'We Is Us', year: 2025 };

export const AGREEMENT_CASES: Array<{
  name: string;
  item: KeyedItem;
  play: KeyedPlay;
  agrees: boolean;
  importOnly?: boolean;
}> = [
  {
    name: 'numbers differ under another show',
    item: episodeItem({ ...BLACKLIST_S3E8, seasonNumber: 3, episodeNumber: 8 }),
    play: SPONGEBOB_S12E3,
    agrees: false,
  },
  {
    name: 'year off by one with numbers differing',
    item: episodeItem({ ...BLACKLIST_S7E9, seasonNumber: 7, episodeNumber: 9 }),
    play: FORGED_IN_FIRE_S7E17,
    agrees: false,
  },
  {
    name: 'numbers differ with a null year',
    item: episodeItem({ ...BLACKLIST_S2E15, seasonNumber: 2, episodeNumber: 15 }),
    play: SPONGEBOB_S12E22,
    agrees: false,
  },
  {
    name: 'rename with equal numbers and year',
    item: episodeItem({ ...PLUR1BUS_S1E1, seasonNumber: 1, episodeNumber: 1 }),
    play: PLURIBUS_S1E1,
    agrees: true,
  },
  {
    name: 'rename with equal numbers, no year',
    item: episodeItem({ ...PLUR1BUS_S1E1, seasonNumber: 1, episodeNumber: 1 }),
    play: { ...PLURIBUS_S1E1, year: null },
    agrees: false,
  },
  {
    name: 'trailing year suffix',
    item: episodeItem({
      showTitle: 'Snowfall',
      title: 'Comrades',
      year: 2023,
      seasonNumber: 6,
      episodeNumber: 1,
    }),
    play: episodePlay({
      grandparentTitle: 'Snowfall (2017)',
      title: 'Episode 1',
      seasonNumber: 6,
      episodeNumber: 1,
    }),
    agrees: true,
  },
  {
    name: 'placeholder episode title, numbers equal',
    item: episodeItem({
      showTitle: 'Severance',
      title: 'Hello, Ms. Cobel',
      year: 2025,
      seasonNumber: 2,
      episodeNumber: 1,
    }),
    play: episodePlay({
      grandparentTitle: 'Severance',
      title: 'Episode 1',
      seasonNumber: 2,
      episodeNumber: 1,
    }),
    agrees: true,
  },
  {
    name: 'numbers unknown, same episode title',
    item: episodeItem({ showTitle: 'The Bear', title: 'Fishes' }),
    play: episodePlay({
      grandparentTitle: 'The Bear',
      title: 'Fishes',
      seasonNumber: 2,
      episodeNumber: 6,
    }),
    agrees: true,
  },
  {
    name: 'numbers unknown, nothing agrees',
    item: episodeItem(BLACKLIST_S2E15),
    play: { ...SPONGEBOB_S12E22, year: 2019 },
    agrees: false,
  },
  {
    name: 'equal plex guid',
    item: episodeItem({
      showTitle: 'One Piece (Japanese)',
      title: 'Real Title',
      seasonNumber: 7,
      episodeNumber: 5,
      plexGuid: 'plex://episode/5e8338265161b50041c98783',
    }),
    play: episodePlay({
      grandparentTitle: 'One Piece',
      title: 'Episode 150',
      seasonNumber: 1,
      episodeNumber: 150,
      guid: 'plex://episode/5e8338265161b50041c98783',
    }),
    agrees: true,
    importOnly: true,
  },
  {
    name: 'different plex guid, show and numbers agree',
    item: episodeItem({
      showTitle: 'Snowfall',
      title: 'Comrades',
      seasonNumber: 6,
      episodeNumber: 1,
      plexGuid: 'plex://episode/5e8338265161b50041c98783',
    }),
    play: episodePlay({
      grandparentTitle: 'Snowfall',
      title: 'Episode 1',
      seasonNumber: 6,
      episodeNumber: 1,
      guid: 'plex://episode/61a8c3d2e4b0a1001e2f3a4b',
    }),
    agrees: true,
    importOnly: true,
  },
  {
    name: 'different plex guid',
    item: episodeItem({
      ...PLUR1BUS_S1E1,
      seasonNumber: 1,
      episodeNumber: 1,
      plexGuid: 'plex://episode/5e8338265161b50041c98783',
    }),
    play: { ...PLURIBUS_S1E1, guid: 'plex://episode/61a8c3d2e4b0a1001e2f3a4b?lang=en' },
    agrees: false,
    importOnly: true,
  },
  {
    name: 'legacy thetvdb series id matches show',
    item: episodeItem({
      showTitle: 'Le Trône de fer',
      title: 'Les Pluies de Castamere',
      seasonNumber: 3,
      episodeNumber: 9,
      showTvdbId: 121361,
    }),
    play: episodePlay({
      grandparentTitle: 'Game of Thrones',
      title: 'The Rains of Castamere',
      seasonNumber: 3,
      episodeNumber: 9,
      guid: 'com.plexapp.agents.thetvdb://121361/3/9?lang=en',
    }),
    agrees: true,
    importOnly: true,
  },
  {
    name: 'movie same guid',
    item: movieItem({
      title: 'Harbor Gone',
      year: 2001,
      plexGuid: 'plex://movie/5d7768324de0ee001fccac77',
    }),
    play: moviePlay({
      title: 'Other Film',
      year: 1990,
      guid: 'plex://movie/5d7768324de0ee001fccac77',
    }),
    agrees: true,
    importOnly: true,
  },
  {
    name: 'movie legacy imdb id differs',
    item: movieItem({ title: 'Harbor Gone', year: 2001, imdbId: 'tt0322259' }),
    play: moviePlay({
      title: 'Harbor Gone',
      year: 2001,
      guid: 'com.plexapp.agents.imdb://tt0111161?lang=en',
    }),
    agrees: false,
    importOnly: true,
  },
  {
    name: 'movie renamed same year',
    item: movieItem({ title: 'Harbor Gone', year: 2001 }),
    play: moviePlay({ title: "Harbor Gone: Director's Cut", year: 2001 }),
    agrees: true,
  },
  {
    name: 'movie different title years apart',
    item: movieItem({ title: 'Harbor Gone', year: 2001 }),
    play: moviePlay({ title: 'Other Film', year: 1990 }),
    agrees: false,
  },
];

export const REPAIR_CASES: Array<{
  name: string;
  link: LinkedMedia;
  play: KeyedPlay;
  clause: RepairClause | null;
}> = [
  {
    name: 'numbers differ under another show',
    link: episodeLink({ ...BLACKLIST_S3E8, numbers: [[3, 8]] }),
    play: SPONGEBOB_S12E3,
    clause: 'numbers',
  },
  {
    name: 'year off by one with numbers differing',
    link: episodeLink({ ...BLACKLIST_S7E9, numbers: [[7, 9]] }),
    play: FORGED_IN_FIRE_S7E17,
    clause: 'numbers',
  },
  {
    name: 'numbers differ with a null year',
    link: episodeLink({ ...BLACKLIST_S2E15, numbers: [[2, 15]] }),
    play: SPONGEBOB_S12E22,
    clause: 'numbers',
  },
  {
    name: 're-paired item',
    link: episodeLink({ showTitle: 'The Blacklist', title: 'Gina Zanetakos', numbers: [[1, 19]] }),
    play: episodePlay({
      grandparentTitle: 'Drawn Together',
      title: 'Lost in Parking Space',
      seasonNumber: 3,
      episodeNumber: 8,
      year: 2007,
    }),
    clause: 'numbers',
  },
  {
    name: 'renumbered show with changed titles',
    link: episodeLink({ showTitle: 'One Piece', title: 'Real Title', numbers: [[7, 5]] }),
    play: episodePlay({
      grandparentTitle: 'One Piece',
      title: 'Episode 150',
      seasonNumber: 1,
      episodeNumber: 150,
    }),
    clause: null,
  },
  {
    name: 'rename with equal numbers',
    link: episodeLink({ ...PLUR1BUS_S1E1, numbers: [[1, 1]] }),
    play: PLURIBUS_S1E1,
    clause: null,
  },
  {
    name: 'placeholder title, no library numbers',
    link: episodeLink(PLUR1BUS_S1E1),
    play: PLURIBUS_S1E1,
    clause: null,
  },
  {
    name: 'numbers match one of several items',
    link: episodeLink({
      showTitle: "Ramsay's Kitchen Nightmares",
      title: 'Bonapartes',
      year: 2005,
      numbers: [
        [1, 1],
        [2, 1],
      ],
    }),
    play: episodePlay({
      grandparentTitle: 'Kitchen Nightmares',
      title: 'Episode 1',
      seasonNumber: 2,
      episodeNumber: 1,
      year: 2005,
    }),
    clause: null,
  },
  {
    name: 'show, title and year all differ, no numbers',
    link: episodeLink(BLACKLIST_S3E8),
    play: SPONGEBOB_S12E3,
    clause: 'titles',
  },
  {
    name: 'movie different title years apart',
    link: { mediaType: 'movie', title: 'Harbor Gone', year: 2001, showTitle: null, numbers: [] },
    play: moviePlay({ title: 'Other Film', year: 1990 }),
    clause: 'movie',
  },
  {
    name: 'movie renamed same year',
    link: { mediaType: 'movie', title: 'Harbor Gone', year: 2001, showTitle: null, numbers: [] },
    play: moviePlay({ title: "Harbor Gone: Director's Cut", year: 2001 }),
    clause: null,
  },
];

export const NORMALIZATION_CASES: Array<{ raw: string; normalized: string }> = [
  { raw: 'Help Wanted', normalized: 'helpwanted' },
  { raw: "Sermon on the 'Mount", normalized: 'sermononthemount' },
  { raw: "Mexican't Buy Me Love", normalized: 'mexicantbuymelove' },
  { raw: 'Pokémon', normalized: 'pokémon' },
  { raw: '進撃の巨人', normalized: '進撃の巨人' },
  { raw: '○△□', normalized: '' },
  { raw: 'PLUR1BUS', normalized: 'plur1bus' },
  { raw: 'Men in Black³', normalized: 'meninblack3' },
];
