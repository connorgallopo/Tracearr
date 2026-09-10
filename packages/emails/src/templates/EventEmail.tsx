import { Column, Img, Link, Row, Text } from '@react-email/components';
import { Cell } from '../components/Cell.js';
import { Layout } from '../components/Layout.js';
import { card, colors, heading, link, muted, paragraph } from '../styles.js';
import type { EmailBranding, EventCard, EventEmailInput } from '../types.js';

const SEVERITY_LABEL = { low: 'Info', warning: 'Warning', high: 'High' } as const;

function severityStyle(severity: EventEmailInput['severity']) {
  return {
    display: 'inline-block',
    padding: '2px 8px',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: 600,
    color: '#ffffff',
    backgroundColor: colors[severity],
    marginTop: 0,
    marginBottom: '12px',
  };
}

function MediaCardView({
  card: media,
  accent,
}: {
  card: Extract<EventCard, { kind: 'media' }>;
  accent: string;
}) {
  return (
    <Row>
      {media.posterRef && (
        <Column
          style={{
            width: '120px',
            verticalAlign: 'top',
            paddingRight: '16px',
            backgroundColor: colors.card,
            color: colors.text,
          }}
        >
          <Img
            src={media.posterRef}
            alt={media.headline}
            width="120"
            height="180"
            style={{ display: 'block', borderRadius: '4px' }}
          />
        </Column>
      )}
      <Column style={{ verticalAlign: 'top', backgroundColor: colors.card, color: colors.text }}>
        <Text style={{ ...paragraph, fontWeight: 600, marginBottom: '4px' }}>
          {media.headline}
          {media.year !== null && ` (${media.year})`}
        </Text>
        {media.subtitle && <Text style={{ ...muted, marginBottom: '8px' }}>{media.subtitle}</Text>}
        {media.qualityLines.map((line) => (
          <Text key={line} style={{ ...paragraph, marginBottom: '2px' }}>
            {line}
          </Text>
        ))}
        {media.links.length > 0 && (
          <Text style={{ ...paragraph, marginTop: '8px' }}>
            {media.links.map((l, i) => (
              <span key={l.url}>
                {i > 0 && ' · '}
                <Link href={l.url} style={link(accent)}>
                  {l.label}
                </Link>
              </span>
            ))}
          </Text>
        )}
      </Column>
    </Row>
  );
}

function FactsCardView({ card: facts }: { card: Extract<EventCard, { kind: 'facts' }> }) {
  return (
    <>
      {facts.facts.map((fact) => (
        <Text key={fact.label} style={{ ...paragraph, marginBottom: '4px' }}>
          <span style={{ color: colors.muted }}>{fact.label}: </span>
          {fact.value}
        </Text>
      ))}
    </>
  );
}

export function EventEmail({
  input,
  branding,
}: {
  input: EventEmailInput;
  branding: EmailBranding;
}) {
  const when = new Date(input.timestamp).toUTCString();
  return (
    <Layout preview={input.message} branding={branding} logoRef={input.logoRef}>
      <Cell style={card}>
        <Text style={heading(branding.accentColor)}>{input.title}</Text>
        <Text style={severityStyle(input.severity)}>{SEVERITY_LABEL[input.severity]}</Text>
        <Text style={paragraph}>{input.message}</Text>
        {input.card?.kind === 'media' && (
          <MediaCardView card={input.card} accent={branding.accentColor} />
        )}
        {input.card?.kind === 'facts' && <FactsCardView card={input.card} />}
        <Text style={{ ...muted, marginTop: '12px' }}>{when}</Text>
        {input.appUrl && (
          <Text style={{ ...paragraph, marginTop: '8px', marginBottom: 0 }}>
            <Link href={input.appUrl} style={link(branding.accentColor)}>
              Open Tracearr
            </Link>
          </Text>
        )}
      </Cell>
    </Layout>
  );
}
