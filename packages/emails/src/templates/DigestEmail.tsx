import { Img, Link, Text } from '@react-email/components';
import { Cell } from '../components/Cell.js';
import { Columns } from '../components/Columns.js';
import { Layout } from '../components/Layout.js';
import { RichText } from '../components/RichText.js';
import { card, colors, heading, link, muted, paragraph } from '../styles.js';
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

/** The inbox preview: what was added, so it does not repeat the subject; the subject when nothing was. */
function preheader(input: DigestInput): string {
  const albums = input.artists.reduce((n, a) => n + a.albums.length, 0) + input.moreAlbums;
  const parts = (
    [
      [input.movies.length + input.moreMovies, 'movie'],
      [input.shows.length + input.moreShows, 'show'],
      [albums, 'album'],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, noun]) => plural(count, noun));
  if (parts.length === 0) return input.subject;
  return `${listNames(parts)} added between ${input.windowStart} and ${input.windowEnd}`;
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
                ? ', all episodes'
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

export function DigestEmail({ input, branding }: { input: DigestInput; branding: EmailBranding }) {
  const accent = branding.accentColor;
  const empty =
    input.movies.length === 0 &&
    input.shows.length === 0 &&
    input.artists.length === 0 &&
    input.mostWatched.length === 0;

  const footer = (
    <>
      {input.viewUrl && (
        <Text style={muted}>
          <Link href={input.viewUrl} style={link(accent)}>
            View in browser
          </Link>
        </Text>
      )}
      {input.serverNames.length > 0 && (
        <Text style={muted}>
          You get this because you are a member of {listNames(input.serverNames)}.
        </Text>
      )}
      <Text style={muted}>
        {input.unsubscribeUrl ? (
          <Link href={input.unsubscribeUrl} style={link(accent)}>
            Unsubscribe
          </Link>
        ) : (
          'Reply to this email to unsubscribe.'
        )}
      </Text>
    </>
  );

  return (
    <Layout preview={preheader(input)} branding={branding} logoRef={input.logoRef} footer={footer}>
      <Cell style={card}>
        <Text style={heading(accent)}>{input.subject}</Text>
        <Text style={muted}>
          {input.windowStart} to {input.windowEnd}
        </Text>
        {input.intro && <RichText doc={input.intro} accent={accent} />}
        {empty && <Text style={paragraph}>Nothing new this period.</Text>}
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
        <Cell style={{ paddingTop: '8px' }}>
          <RichText doc={input.outro} accent={accent} />
        </Cell>
      )}
    </Layout>
  );
}
