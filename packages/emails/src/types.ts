export interface EmailBranding {
  senderName: string;
  /** Hex color for headings and links. */
  accentColor: string;
  footerText: string | null;
  postalAddress: string | null;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface EmailLink {
  label: string;
  url: string;
}

export interface MediaCard {
  kind: 'media';
  headline: string;
  subtitle: string | null;
  year: number | null;
  qualityLines: string[];
  /** Absolute URL or `cid:` reference; the caller decides. */
  posterRef: string | null;
  links: EmailLink[];
}

export interface FactsCard {
  kind: 'facts';
  facts: { label: string; value: string }[];
}

export type EventCard = MediaCard | FactsCard;

export interface EventEmailInput {
  subject: string;
  title: string;
  message: string;
  severity: 'low' | 'warning' | 'high';
  /** ISO timestamp of the event. */
  timestamp: string;
  card: EventCard | null;
  logoRef: string | null;
  appUrl: string | null;
}

export interface TestEmailInput {
  destinationName: string;
  logoRef: string | null;
}

export interface DigestMovie {
  id: string;
  title: string;
  year: number | null;
  posterRef: string | null;
  genres: string[];
  links: EmailLink[];
}

export interface DigestSeason {
  number: number | null;
  title: string;
  /** "E01-E04, E07" or "" when the season came in whole. */
  episodeRange: string;
  episodeCount: number;
}

export interface DigestShow {
  id: string;
  title: string;
  year: number | null;
  posterRef: string | null;
  seasons: DigestSeason[];
  moreSeasons: number;
  episodeCount: number;
  links: EmailLink[];
}

export interface DigestAlbum {
  id: string;
  title: string;
  year: number | null;
  trackCount: number;
}

export interface DigestArtist {
  id: string;
  name: string;
  albums: DigestAlbum[];
  links: EmailLink[];
}

export interface DigestWatched {
  id: string;
  kind: 'movie' | 'show';
  title: string;
  year: number | null;
  plays: number;
  links: EmailLink[];
}

export interface DigestInput {
  subject: string;
  intro: RichTextDoc | null;
  outro: RichTextDoc | null;
  /** Already formatted for display in the newsletter's timezone. */
  windowStart: string;
  windowEnd: string;
  movies: DigestMovie[];
  shows: DigestShow[];
  artists: DigestArtist[];
  mostWatched: DigestWatched[];
  /** Items each section holds beyond the cards shown, from the section cap and the render-time fit loop; 0 renders no line. */
  moreMovies: number;
  moreShows: number;
  moreAlbums: number;
  moreWatched: number;
  logoRef: string | null;
  /** Emitted verbatim; null renders the reply-to-unsubscribe line instead. */
  unsubscribeUrl: string | null;
  /** Emitted verbatim; null renders no browser-view link. */
  viewUrl: string | null;
}

export type RichTextMark =
  { type: 'bold' } | { type: 'italic' } | { type: 'link'; attrs: { href: string } };

export interface RichTextText {
  type: 'text';
  text: string;
  marks?: RichTextMark[];
}

export interface RichTextHardBreak {
  type: 'hardBreak';
}

export type RichTextInline = RichTextText | RichTextHardBreak;

export interface RichTextParagraph {
  type: 'paragraph';
  content?: RichTextInline[];
}

export interface RichTextListItem {
  type: 'listItem';
  content: RichTextParagraph[];
}

export interface RichTextBulletList {
  type: 'bulletList';
  content: RichTextListItem[];
}

export type RichTextBlock = RichTextParagraph | RichTextBulletList;

/** The allowlist @tracearr/shared enforces on write; this package renders it and depends on nothing else. */
export interface RichTextDoc {
  type: 'doc';
  content: RichTextBlock[];
}
