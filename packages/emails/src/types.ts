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
