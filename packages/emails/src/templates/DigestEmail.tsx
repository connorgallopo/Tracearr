import { Heading, Hr, Img, Link, Text } from '@react-email/components';
import type { CSSProperties, ReactNode } from 'react';
import { Cell } from '../components/Cell.js';
import { Columns } from '../components/Columns.js';
import { Document } from '../components/Document.js';
import { RichText } from '../components/RichText.js';
import { colors, link } from '../styles.js';
import type {
  DigestArtist,
  DigestInput,
  DigestMovie,
  DigestSeason,
  DigestShow,
  DigestWatched,
  EmailBranding,
  EmailLink,
} from '../types.js';

const cardTable: CSSProperties = {
  border: `1px solid ${colors.edge}`,
  borderRadius: '10px',
  marginBottom: '10px',
};
const posterCell: CSSProperties = { width: '112px', padding: '12px 0 12px 12px' };
const bodyCell: CSSProperties = { padding: '12px 14px', verticalAlign: 'middle' };
const soloCell: CSSProperties = {
  ...bodyCell,
  backgroundColor: colors.card,
  borderRadius: '10px',
};

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
  lineHeight: '19px',
  marginTop: 0,
  marginBottom: '14px',
};
const title: CSSProperties = {
  color: colors.text,
  fontSize: '17px',
  lineHeight: '22px',
  fontWeight: 600,
  marginTop: 0,
  marginBottom: '3px',
};
const yearMark: CSSProperties = { color: colors.muted, fontWeight: 400 };
const meta: CSSProperties = {
  color: colors.muted,
  fontSize: '12px',
  lineHeight: '18px',
  marginTop: 0,
  marginBottom: '2px',
};
const listLine: CSSProperties = {
  color: colors.soft,
  fontSize: '13px',
  lineHeight: '19px',
  marginTop: 0,
  marginBottom: '2px',
};
const groupTable: CSSProperties = { marginTop: '8px' };
const groupCell: CSSProperties = {
  backgroundColor: colors.raised,
  borderRadius: '6px',
  padding: '8px 10px',
};
const footNote: CSSProperties = {
  color: colors.muted,
  fontSize: '12px',
  lineHeight: '18px',
  marginTop: 0,
  marginBottom: '6px',
};

const sectionLabel = (accent: string): CSSProperties => ({
  color: accent,
  fontSize: '12px',
  lineHeight: '16px',
  fontWeight: 600,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  marginTop: 0,
  marginBottom: 0,
});

const plural = (count: number, noun: string): string =>
  `${count} ${count === 1 ? noun : `${noun}s`}`;

/** "A", "A and B", "A, B and C". */
function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

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

/** 2:3 at the given width; the raised background is what a blocked-images client shows in its place. */
function Poster({ src, alt, width }: { src: string; alt: string; width: number }) {
  return (
    <Img
      src={src}
      alt={alt}
      width={String(width)}
      height={String(width * 1.5)}
      style={{ display: 'block', borderRadius: '6px', backgroundColor: colors.raised }}
    />
  );
}

function Year({ year }: { year: number | null }) {
  if (year === null) return null;
  return <span style={yearMark}>{` (${year})`}</span>;
}

function Meta({ parts }: { parts: (string | null)[] }) {
  const shown = parts.filter((p): p is string => p !== null && p !== '');
  if (shown.length === 0) return null;
  return <Text style={meta}>{shown.join(' · ')}</Text>;
}

function Links({ links, accent }: { links: EmailLink[]; accent: string }) {
  if (links.length === 0) return null;
  return (
    <Text style={{ ...meta, marginTop: '6px' }}>
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
  return <Text style={{ ...footNote, marginBottom: '4px' }}>{`+${plural(count, noun)}`}</Text>;
}

/** Fixed 55/45 so the accent rule is the same length in every section. */
function SectionHead({ label, count, accent }: { label: string; count: string; accent: string }) {
  return (
    <Columns
      tableStyle={{ marginTop: '26px', marginBottom: '10px' }}
      leftStyle={{
        backgroundColor: colors.page,
        borderTop: `2px solid ${accent}`,
        padding: '10px 0 0',
        width: '55%',
      }}
      rightStyle={{
        backgroundColor: colors.page,
        borderTop: `1px solid ${colors.border}`,
        padding: '10px 0 0',
        textAlign: 'right',
        width: '45%',
      }}
      left={
        <Heading as="h2" style={sectionLabel(accent)}>
          {label}
        </Heading>
      }
      right={<Text style={{ ...meta, marginBottom: 0 }}>{count}</Text>}
    />
  );
}

/** A card body next to its poster, or across the full width when there is no poster to show. */
function Card({
  posterRef,
  alt,
  children,
}: {
  posterRef: string | null;
  alt: string;
  children: ReactNode;
}) {
  if (!posterRef) {
    return (
      <Cell tableStyle={cardTable} style={soloCell}>
        {children}
      </Cell>
    );
  }
  return (
    <Columns
      tableStyle={cardTable}
      leftStyle={posterCell}
      rightStyle={bodyCell}
      left={<Poster src={posterRef} alt={alt} width={100} />}
      right={children}
    />
  );
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
    <Card posterRef={item.posterRef} alt={item.title}>
      <Text style={title}>
        {item.title}
        <Year year={item.year} />
      </Text>
      <Meta parts={[multiServer ? item.serverName : null, item.genres.slice(0, 3).join(' · ')]} />
      <Links links={item.links} accent={accent} />
    </Card>
  );
}

/** A season-level add event carries no episode count; an episode-by-episode one does. */
function seasonLine(s: DigestSeason): string {
  if (s.whole) {
    return s.episodeCount > 0
      ? `${s.title}, all ${plural(s.episodeCount, 'episode')}`
      : `${s.title}, all episodes`;
  }
  const range = s.episodeRange ? ` · ${s.episodeRange}` : '';
  const count = s.episodeCount > 0 ? ` (${plural(s.episodeCount, 'episode')})` : '';
  return `${s.title}${range}${count}`;
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
    <Card posterRef={item.posterRef} alt={item.title}>
      <Text style={title}>
        {item.title}
        <Year year={item.year} />
      </Text>
      <Meta
        parts={[
          multiServer ? item.serverName : null,
          item.episodeCount > 0 ? plural(item.episodeCount, 'new episode') : null,
        ]}
      />
      {(item.seasons.length > 0 || item.moreSeasons > 0) && (
        <Cell tableStyle={groupTable} style={groupCell}>
          {item.seasons.map((s) => (
            <Text key={`${s.number ?? 'x'}-${s.title}`} style={listLine}>
              {seasonLine(s)}
            </Text>
          ))}
          <More count={item.moreSeasons} noun="more season" />
        </Cell>
      )}
      <Links links={item.links} accent={accent} />
    </Card>
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
    <Card posterRef={item.posterRef} alt={item.name}>
      <Text style={title}>{item.name}</Text>
      <Meta parts={[multiServer ? item.serverName : null]} />
      {item.albums.map((a) => (
        <Text key={a.id} style={listLine}>
          {`${a.title}${a.year === null ? '' : ` (${a.year})`} · ${plural(a.trackCount, 'track')}`}
        </Text>
      ))}
      <Links links={item.links} accent={accent} />
    </Card>
  );
}

function WatchedRow({
  item,
  rank,
  accent,
  multiServer,
  first,
}: {
  item: DigestWatched;
  rank: number;
  accent: string;
  multiServer: boolean;
  first: boolean;
}) {
  const divider: CSSProperties = first ? {} : { borderTop: `1px solid ${colors.border}` };
  const bodyStyle: CSSProperties = { ...divider, padding: '10px 14px 10px 10px' };
  const line = (
    <>
      <Text style={{ ...title, fontSize: '15px', lineHeight: '20px' }}>
        <span style={{ color: accent }}>{rank}</span> {item.title}
        <Year year={item.year} />
      </Text>
      <Text style={{ ...meta, marginBottom: 0 }}>
        <span style={{ color: colors.soft, fontWeight: 600 }}>{plural(item.plays, 'play')}</span>
        {multiServer && item.serverName ? ` · ${item.serverName}` : ''}
        {item.links.map((l) => (
          <span key={l.url}>
            {' · '}
            <Link href={l.url} style={link(accent)}>
              {l.label}
            </Link>
          </span>
        ))}
      </Text>
    </>
  );
  if (!item.posterRef) {
    return <Cell style={{ ...bodyStyle, backgroundColor: colors.card }}>{line}</Cell>;
  }
  return (
    <Columns
      leftStyle={{ ...divider, width: '58px', padding: '10px 0 10px 10px' }}
      rightStyle={bodyStyle}
      left={<Poster src={item.posterRef} alt={item.title} width={44} />}
      right={line}
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
        <Cell style={{ textAlign: 'center' }}>
          <Text style={{ ...footNote, marginBottom: '10px' }}>
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
  const empty = !totals && input.artists.length === 0 && input.mostWatched.length === 0;

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
          <SectionHead label="Movies" count={`${counts.movies} new`} accent={accent} />
          {input.movies.map((m) => (
            <MovieCard key={m.id} item={m} accent={accent} multiServer={input.multiServer} />
          ))}
          <More count={input.moreMovies} noun="more movie" />
        </>
      )}
      {input.shows.length > 0 && (
        <>
          <SectionHead label="TV" count={`${counts.shows} new`} accent={accent} />
          {input.shows.map((s) => (
            <ShowCard key={s.id} item={s} accent={accent} multiServer={input.multiServer} />
          ))}
          <More count={input.moreShows} noun="more show" />
        </>
      )}
      {input.artists.length > 0 && (
        <>
          <SectionHead label="Music" count={`${counts.albums} new`} accent={accent} />
          {input.artists.map((a) => (
            <ArtistCard key={a.id} item={a} accent={accent} multiServer={input.multiServer} />
          ))}
          <More count={input.moreAlbums} noun="more album" />
        </>
      )}
      {input.mostWatched.length > 0 && (
        <>
          <SectionHead
            label="Most watched"
            count={`top ${input.mostWatched.length}`}
            accent={accent}
          />
          <Cell tableStyle={cardTable} style={{ backgroundColor: colors.card, padding: 0 }}>
            {input.mostWatched.map((w, i) => (
              <WatchedRow
                key={w.id}
                item={w}
                rank={i + 1}
                accent={accent}
                multiServer={input.multiServer}
                first={i === 0}
              />
            ))}
          </Cell>
          <More count={input.moreWatched} noun="more title" />
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
