import type { PosterRef } from '../../db/schema.js';
import {
  LOGO_ROUTE,
  UNSUBSCRIBE_PLACEHOLDER,
  VIEW_PLACEHOLDER,
  substitutePosterRefs,
} from './render.js';

function paragraphHolding(placeholder: string): RegExp {
  const literal = placeholder.replace(/[{}]/g, '\\$&');
  return new RegExp(`<p\\b[^>]*>(?:(?!<\\/p>)[\\s\\S])*${literal}(?:(?!<\\/p>)[\\s\\S])*<\\/p>`);
}

const VIEW_LINE = paragraphHolding(VIEW_PLACEHOLDER);
const UNSUBSCRIBE_LINE = paragraphHolding(UNSUBSCRIBE_PLACEHOLDER);
const INERT_UNSUBSCRIBE =
  '<p style="font-size:12px;line-height:18px;color:#8b93a1;margin:0 0 8px">Unsubscribe links are only in the email itself.</p>';

/** A rendered digest as a browser page: relative image urls and no link that could act for a recipient. */
export function digestForBrowser(html: string, posters: Record<string, PosterRef>): string {
  return substitutePosterRefs(html, posters, 'hosted', '')
    .replaceAll('src="cid:logo"', `src="${LOGO_ROUTE}"`)
    .replace(VIEW_LINE, '')
    .replace(UNSUBSCRIBE_LINE, INERT_UNSUBSCRIBE)
    .replaceAll(VIEW_PLACEHOLDER, '#')
    .replaceAll(UNSUBSCRIBE_PLACEHOLDER, '#');
}
