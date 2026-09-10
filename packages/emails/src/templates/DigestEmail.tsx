import { Heading, Hr, Img, Link, Text } from '@react-email/components';
import type { CSSProperties } from 'react';
import { Cell } from '../components/Cell.js';
import { Columns } from '../components/Columns.js';
import { Document } from '../components/Document.js';
import { RichText } from '../components/RichText.js';
import { colors, heading, link, muted, paragraph } from '../styles.js';
import type {
  DigestArtist,
  DigestInput,
  DigestMovie,
  DigestShow,
  DigestWatched,
  EmailBranding,
  EmailLink,
} from '../types.js';

const titleStyle = { ...paragraph, fontWeight: 600, margin: '0 0 2px' } as const;
const lineStyle = { ...paragraph, margin: '0 0 2px' } as const;
const posterBodyTable = {
  border: `1px solid ${colors.border}`,
  borderRadius: '6px',
  marginBottom: '8px',
} as const;
const posterCell = { width: '80px', padding: '10px 12px 10px 10px' } as const;
const bodyCell = { padding: '10px 10px 10px 0' } as const;

const h1: CSSProperties = {
  color: colors.text,
  fontSize: '26px',
  lineHeight: '32px',
  fontWeight: 600,
  marginTop: 0,
  marginBottom: '8px',
};
const eyebrow: CSSProperties = {
  color: colors.muted,
  fontSize: '11px',
  lineHeight: '16px',
  letterSpacing: '0.09em',
  textTransform: 'uppercase',
  marginTop: 0,
  marginBottom: '10px',
};
const summary: CSSProperties = {
  color: colors.soft,
  fontSize: '13px',
  lineHeight: '20px',
  marginTop: 0,
  marginBottom: '14px',
};
const footNote: CSSProperties = {
  color: colors.muted,
  fontSize: '12px',
  lineHeight: '18px',
  marginTop: 0,
  marginBottom: '6px',
};

function Poster({ src, alt }: { src: string | null; alt: string }) {
  if (!src) return null;
  return (
    <Img
      src={src}
      alt={alt}
      width="80"
      height="120"
      style={{ display: 'block', borderRadius: '4px' }}
    />
  );
}

function Links({ links, accent }: { links: EmailLink[]; accent: string }) {
  if (links.length === 0) return null;
  return (
    <Text style={{ ...muted, marginTop: '4px' }}>
      {links.map((l, i) => (
        <span key={l.url}>
          {i > 0 && ' · '}
          <Link href={l.url} style={link(accent)}>
            {l.label}
          </Link>
        </span>
      ))}
    </Text>
  );
}

function More({ count, noun }: { count: number; noun: string }) {
  if (count <= 0) return null;
  return <Text style={muted}>{`+${count} more ${count === 1 ? noun : `${noun}s`}`}</Text>;
}

function withYear(title: string, year: number | null): string {
  return year === null ? title : `${title} (${year})`;
}

function SectionHeading({ text, accent }: { text: string; accent: string }) {
  return <Text style={{ ...heading(accent), fontSize: '16px', margin: '16px 0 8px' }}>{text}</Text>;
}

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const plural = (count: number, noun: string): string =>
  `${count} ${count === 1 ? noun : `${noun}s`}`;

interface Tally {
  movies: number;
  shows: number;
  albums: number;
}

/** Window totals: the cards shown plus what the caps and the fit loop held back. */
function tally(input: DigestInput): Tally {
  return {
    movies: input.movies.length + input.moreMovies,
    shows: input.shows.length + input.moreShows,
    albums: input.artists.reduce((n, a) => n + a.albums.length, 0) + input.moreAlbums,
  };
}

/** The inbox preview: what was added, so it does not repeat the subject; the subject when nothing was. */
function preheader(input: DigestInput, counts: Tally): string {
  const parts = (
    [
      [counts.movies, 'movie'],
      [counts.shows, 'show'],
      [counts.albums, 'album'],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, noun]) => plural(count, noun));
  if (parts.length === 0) return input.subject;
  return `${listNames(parts)} added between ${input.windowStart} and ${input.windowEnd}`;
}

function summaryLine(input: DigestInput, counts: Tally): string {
  return [
    counts.movies > 0 ? plural(counts.movies, 'movie') : null,
    counts.shows > 0 ? plural(counts.shows, 'show') : null,
    input.episodes > 0 ? plural(input.episodes, 'episode') : null,
    counts.albums > 0 ? plural(counts.albums, 'album') : null,
  ]
    .filter((p): p is string => p !== null)
    .join(' · ');
}

function Meta({ parts }: { parts: (string | null)[] }) {
  const shown = parts.filter((p): p is string => p !== null && p !== '');
  if (shown.length === 0) return null;
  return <Text style={{ ...muted, margin: '0 0 2px' }}>{shown.join(' · ')}</Text>;
}

function MovieCard({
  item,
  accent,
  multiServer,
}: {
  item: DigestMovie;
  accent: string;
  multiServer: boolean;
}) {
  return (
    <Columns
      tableStyle={posterBodyTable}
      leftStyle={posterCell}
      rightStyle={bodyCell}
      left={<Poster src={item.posterRef} alt={item.title} />}
      right={
        <>
          <Text style={titleStyle}>{withYear(item.title, item.year)}</Text>
          <Meta
            parts={[multiServer ? item.serverName : null, item.genres.slice(0, 3).join(', ')]}
          />
          <Links links={item.links} accent={accent} />
        </>
      }
    />
  );
}

function ShowCard({
  item,
  accent,
  multiServer,
}: {
  item: DigestShow;
  accent: string;
  multiServer: boolean;
}) {
  return (
    <Columns
      tableStyle={posterBodyTable}
      leftStyle={posterCell}
      rightStyle={bodyCell}
      left={<Poster src={item.posterRef} alt={item.title} />}
      right={
        <>
          <Text style={titleStyle}>{withYear(item.title, item.year)}</Text>
          <Meta parts={[multiServer ? item.serverName : null]} />
          {item.seasons.map((s) => (
            <Text key={`${s.number ?? 'x'}-${s.title}`} style={lineStyle}>
              {s.title}
              {s.whole
                ? s.episodeCount > 0
                  ? `, all ${plural(s.episodeCount, 'episode')}`
                  : ', all episodes'
                : `${s.episodeRange ? ` · ${s.episodeRange}` : ''}${
                    s.episodeCount > 0 ? ` (${plural(s.episodeCount, 'episode')})` : ''
                  }`}
            </Text>
          ))}
          <More count={item.moreSeasons} noun="season" />
          <Links links={item.links} accent={accent} />
        </>
      }
    />
  );
}

function ArtistCard({
  item,
  accent,
  multiServer,
}: {
  item: DigestArtist;
  accent: string;
  multiServer: boolean;
}) {
  return (
    <Columns
      tableStyle={posterBodyTable}
      leftStyle={posterCell}
      rightStyle={bodyCell}
      left={<Poster src={item.posterRef} alt={item.name} />}
      right={
        <>
          <Text style={titleStyle}>{item.name}</Text>
          <Meta parts={[multiServer ? item.serverName : null]} />
          {item.albums.map((a) => (
            <Text key={a.id} style={lineStyle}>
              {withYear(a.title, a.year)} · {plural(a.trackCount, 'track')}
            </Text>
          ))}
          <Links links={item.links} accent={accent} />
        </>
      }
    />
  );
}

function WatchedRow({
  item,
  accent,
  multiServer,
}: {
  item: DigestWatched;
  accent: string;
  multiServer: boolean;
}) {
  return (
    <Columns
      tableStyle={posterBodyTable}
      leftStyle={posterCell}
      rightStyle={bodyCell}
      left={<Poster src={item.posterRef} alt={item.title} />}
      right={
        <>
          <Text style={titleStyle}>
            {withYear(item.title, item.year)} · {plural(item.plays, 'play')}
          </Text>
          <Meta parts={[multiServer ? item.serverName : null]} />
          <Links links={item.links} accent={accent} />
        </>
      }
    />
  );
}

function Masthead({
  senderName,
  logoRef,
  viewUrl,
  accent,
}: {
  senderName: string;
  logoRef: string | null;
  viewUrl: string | null;
  accent: string;
}) {
  return (
    <>
      {viewUrl && (
        <Cell style={{ paddingBottom: '10px', textAlign: 'center' }}>
          <Text style={{ ...footNote, marginBottom: 0 }}>
            <Link href={viewUrl} style={link(accent)}>
              View in browser
            </Link>
          </Text>
        </Cell>
      )}
      <Cell
        tableStyle={{ marginBottom: '22px' }}
        style={{
          borderBottom: `1px solid ${colors.border}`,
          padding: '18px 0',
          textAlign: 'center',
        }}
      >
        {logoRef && (
          <Img
            src={logoRef}
            alt=""
            width="48"
            height="48"
            style={{
              display: 'inline-block',
              backgroundColor: colors.raised,
            }}
          />
        )}
        <Text
          style={{
            color: colors.text,
            fontSize: logoRef ? '20px' : '22px',
            lineHeight: logoRef ? '26px' : '28px',
            fontWeight: 600,
            textAlign: 'center',
            marginTop: logoRef ? '8px' : 0,
            marginBottom: 0,
          }}
        >
          {senderName}
        </Text>
      </Cell>
    </>
  );
}

export function DigestEmail({ input, branding }: { input: DigestInput; branding: EmailBranding }) {
  const accent = branding.accentColor;
  const counts = tally(input);
  const totals = summaryLine(input, counts);
  const empty =
    input.movies.length === 0 &&
    input.shows.length === 0 &&
    input.artists.length === 0 &&
    input.mostWatched.length === 0;

  return (
    <Document preview={preheader(input, counts)}>
      <Masthead
        senderName={branding.senderName}
        logoRef={input.logoRef}
        viewUrl={input.viewUrl}
        accent={accent}
      />
      <Cell style={{ padding: '0 2px' }}>
        <Text style={eyebrow}>
          {input.windowStart} to {input.windowEnd}
        </Text>
        <Heading as="h1" style={h1}>
          {input.subject}
        </Heading>
        {totals && <Text style={summary}>{totals}</Text>}
        {input.intro && <RichText doc={input.intro} accent={accent} />}
        {empty && (
          <Text style={{ ...summary, color: colors.muted }}>
            Nothing was added to {listNames(input.serverNames) || branding.senderName} between{' '}
            {input.windowStart} and {input.windowEnd}.
          </Text>
        )}
      </Cell>
      {input.movies.length > 0 && (
        <>
          <SectionHeading text="Movies" accent={accent} />
          {input.movies.map((m) => (
            <MovieCard key={m.id} item={m} accent={accent} multiServer={input.multiServer} />
          ))}
          <More count={input.moreMovies} noun="movie" />
        </>
      )}
      {input.shows.length > 0 && (
        <>
          <SectionHeading text="TV" accent={accent} />
          {input.shows.map((s) => (
            <ShowCard key={s.id} item={s} accent={accent} multiServer={input.multiServer} />
          ))}
          <More count={input.moreShows} noun="show" />
        </>
      )}
      {input.artists.length > 0 && (
        <>
          <SectionHeading text="Music" accent={accent} />
          {input.artists.map((a) => (
            <ArtistCard key={a.id} item={a} accent={accent} multiServer={input.multiServer} />
          ))}
          <More count={input.moreAlbums} noun="album" />
        </>
      )}
      {input.mostWatched.length > 0 && (
        <>
          <SectionHeading text="Most watched" accent={accent} />
          {input.mostWatched.map((w) => (
            <WatchedRow key={w.id} item={w} accent={accent} multiServer={input.multiServer} />
          ))}
          <More count={input.moreWatched} noun="title" />
        </>
      )}
      {input.outro && (
        <Cell style={{ padding: '18px 2px 0' }}>
          <RichText doc={input.outro} accent={accent} />
        </Cell>
      )}
      <Hr style={{ borderColor: colors.border, marginTop: '24px', marginBottom: '14px' }} />
      <Cell style={{ padding: '0 2px' }}>
        {input.memberSend && input.serverNames.length > 0 && (
          <Text style={footNote}>
            You get this because you are a member of {listNames(input.serverNames)}.
          </Text>
        )}
        <Text style={footNote}>
          {input.unsubscribeUrl ? (
            <Link href={input.unsubscribeUrl} style={link(accent)}>
              Unsubscribe
            </Link>
          ) : (
            'Reply to this email to unsubscribe.'
          )}
        </Text>
        {branding.footerText && <Text style={footNote}>{branding.footerText}</Text>}
        {branding.postalAddress && <Text style={footNote}>{branding.postalAddress}</Text>}
        <Text style={{ ...footNote, marginBottom: 0 }}>
          Sent by Tracearr for {branding.senderName}.
        </Text>
      </Cell>
    </Document>
  );
}
