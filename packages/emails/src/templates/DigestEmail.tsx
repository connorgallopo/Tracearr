import { Column, Img, Link, Row, Text } from '@react-email/components';
import { Cell } from '../components/Cell.js';
import { Layout } from '../components/Layout.js';
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

const cardCell = { backgroundColor: colors.card, color: colors.text } as const;
const posterColumn = {
  ...cardCell,
  width: '80px',
  verticalAlign: 'top',
  paddingRight: '12px',
} as const;
const bodyColumn = { ...cardCell, verticalAlign: 'top' } as const;
const titleStyle = { ...paragraph, fontWeight: 600, margin: '0 0 2px' } as const;
const lineStyle = { ...paragraph, margin: '0 0 2px' } as const;
const rowGap = { ...card, padding: '10px', marginBottom: '8px' } as const;

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

function withYear(title: string, year: number | null): string {
  return year === null ? title : `${title} (${year})`;
}

function SectionHeading({ text, accent }: { text: string; accent: string }) {
  return <Text style={{ ...heading(accent), fontSize: '16px', margin: '16px 0 8px' }}>{text}</Text>;
}

function MovieCard({ item, accent }: { item: DigestMovie; accent: string }) {
  return (
    <Cell style={rowGap}>
      <Row>
        <Column style={posterColumn}>
          <Poster src={item.posterRef} alt={item.title} />
        </Column>
        <Column style={bodyColumn}>
          <Text style={titleStyle}>{withYear(item.title, item.year)}</Text>
          <Links links={item.links} accent={accent} />
        </Column>
      </Row>
    </Cell>
  );
}

function ShowCard({ item, accent }: { item: DigestShow; accent: string }) {
  return (
    <Cell style={rowGap}>
      <Row>
        <Column style={posterColumn}>
          <Poster src={item.posterRef} alt={item.title} />
        </Column>
        <Column style={bodyColumn}>
          <Text style={titleStyle}>{withYear(item.title, item.year)}</Text>
          {item.seasons.map((s) => (
            <Text key={`${s.number ?? 'x'}-${s.title}`} style={lineStyle}>
              {s.title}
              {s.episodeRange && ` · ${s.episodeRange}`}
              {s.episodeCount > 0 &&
                ` (${s.episodeCount} ${s.episodeCount === 1 ? 'episode' : 'episodes'})`}
            </Text>
          ))}
          {item.moreSeasons > 0 && <Text style={muted}>+{item.moreSeasons} more seasons</Text>}
          <Links links={item.links} accent={accent} />
        </Column>
      </Row>
    </Cell>
  );
}

function ArtistCard({ item, accent }: { item: DigestArtist; accent: string }) {
  return (
    <Cell style={rowGap}>
      <Text style={titleStyle}>{item.name}</Text>
      {item.albums.map((a) => (
        <Text key={a.id} style={lineStyle}>
          {withYear(a.title, a.year)} ·{' '}
          {`${a.trackCount} ${a.trackCount === 1 ? 'track' : 'tracks'}`}
        </Text>
      ))}
      <Links links={item.links} accent={accent} />
    </Cell>
  );
}

function WatchedRow({ item }: { item: DigestWatched }) {
  return (
    <Text style={lineStyle}>
      {withYear(item.title, item.year)} · {`${item.plays} ${item.plays === 1 ? 'play' : 'plays'}`}
    </Text>
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
    <Layout preview={input.subject} branding={branding} logoRef={input.logoRef} footer={footer}>
      <Cell style={card}>
        <Text style={heading(accent)}>{input.subject}</Text>
        <Text style={muted}>
          {input.windowStart} to {input.windowEnd}
        </Text>
        {input.intro && <Text style={paragraph}>{input.intro}</Text>}
        {empty && <Text style={paragraph}>Nothing new this period.</Text>}
      </Cell>
      {input.movies.length > 0 && (
        <>
          <SectionHeading text="Movies" accent={accent} />
          {input.movies.map((m) => (
            <MovieCard key={m.id} item={m} accent={accent} />
          ))}
        </>
      )}
      {input.shows.length > 0 && (
        <>
          <SectionHeading text="TV" accent={accent} />
          {input.shows.map((s) => (
            <ShowCard key={s.id} item={s} accent={accent} />
          ))}
        </>
      )}
      {input.artists.length > 0 && (
        <>
          <SectionHeading text="Music" accent={accent} />
          {input.artists.map((a) => (
            <ArtistCard key={a.id} item={a} accent={accent} />
          ))}
        </>
      )}
      {input.mostWatched.length > 0 && (
        <>
          <SectionHeading text="Most watched" accent={accent} />
          <Cell style={rowGap}>
            {input.mostWatched.map((w) => (
              <WatchedRow key={w.id} item={w} />
            ))}
          </Cell>
        </>
      )}
      {input.outro && (
        <Cell style={{ paddingTop: '8px' }}>
          <Text style={paragraph}>{input.outro}</Text>
        </Cell>
      )}
    </Layout>
  );
}
