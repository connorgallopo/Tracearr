import {
  resolveSenderName,
  variantKey,
  variantServerIds,
  type NewsletterExcludedPerson,
  type NewsletterScope,
} from '@tracearr/shared';
import { createLogger } from '../../utils/logger.js';
import type { RecipientResolution, ResolvedRecipient } from './recipients.js';
import type { ServerLink } from './store.js';

const logger = createLogger('newsletter-variants');

export interface PlannedVariant {
  key: string;
  /** In the newsletter's server order. */
  serverIds: string[];
  serverNames: string[];
  recipients: ResolvedRecipient[];
}

export interface VariantPlan {
  /** The union of the newsletter's servers first, whether or not anyone is in it, then the rest by key. */
  variants: PlannedVariant[];
  /** Members with an account on none of the newsletter's servers. */
  excluded: NewsletterExcludedPerson[];
}

/** The newsletter's servers in its own order: the scope's list, or name order (loadServerLinks) when the scope names none. */
export function orderServers(
  scope: Pick<NewsletterScope, 'serverIds'>,
  servers: ServerLink[]
): ServerLink[] {
  if (scope.serverIds.length === 0) return servers;
  const rank = new Map(scope.serverIds.map((id, i) => [id, i]));
  return servers
    .filter((s) => rank.has(s.id))
    .sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
}

export function variantFor(
  servers: ServerLink[],
  serverIds: readonly string[],
  recipients: ResolvedRecipient[]
): PlannedVariant {
  const chosen = servers.filter((s) => serverIds.includes(s.id));
  return {
    key: variantKey(chosen.map((s) => s.id)),
    serverIds: chosen.map((s) => s.id),
    serverNames: chosen.map((s) => s.name),
    recipients,
  };
}

export function planVariants(servers: ServerLink[], resolution: RecipientResolution): VariantPlan {
  const all = servers.map((s) => s.id);
  const unionKey = variantKey(all);
  const byKey = new Map<string, ResolvedRecipient[]>([[unionKey, []]]);
  const excluded: NewsletterExcludedPerson[] = [];
  for (const recipient of resolution.recipients) {
    const ids = variantServerIds(recipient.userId === null ? null : recipient.serverIds, all);
    if (ids.length === 0 && all.length > 0) {
      excluded.push({
        userId: recipient.userId ?? '',
        serverUserId: recipient.serverUserId ?? '',
        name: recipient.name,
        username: recipient.username,
        serverId: recipient.serverId ?? '',
        serverName: recipient.serverName ?? '',
        thumbUrl: recipient.thumbUrl,
        serverIds: recipient.serverIds,
        reason: 'noServer',
      });
      continue;
    }
    const key = variantKey(ids);
    const list = byKey.get(key) ?? [];
    list.push(recipient);
    byKey.set(key, list);
  }
  const variants = [...byKey.entries()]
    .sort(([a], [b]) => (a === unionKey ? -1 : b === unionKey ? 1 : a.localeCompare(b)))
    .map(([key, recipients]) => variantFor(servers, key.split(','), recipients));
  return { variants, excluded };
}

/** A test send is one address on one variant: the union unless the owner picked another. */
export function testVariantPlan(
  servers: ServerLink[],
  address: string,
  key: string | undefined
): VariantPlan {
  const ids = key === undefined ? servers.map((s) => s.id) : key.split(',');
  const recipient: ResolvedRecipient = {
    address: address.trim().toLowerCase(),
    userId: null,
    serverUserId: null,
    name: null,
    suppressed: false,
    serverId: null,
    serverIds: [],
    username: null,
    serverName: null,
    thumbUrl: null,
  };
  return { variants: [variantFor(servers, ids, [recipient])], excluded: [] };
}

/** The scope one variant assembles with; null when nothing there can match: no servers at all, or none the newsletter's library pairs name. */
export function variantScope(
  scope: NewsletterScope,
  serverIds: readonly string[]
): NewsletterScope | null {
  // An empty serverIds reads as "every server" downstream, so a variant on no server has to stop here.
  if (serverIds.length === 0) return null;
  if (scope.libraries.length === 0) return { serverIds: [...serverIds], libraries: [] };
  const libraries = scope.libraries.filter((l) => serverIds.includes(l.serverId));
  return libraries.length === 0 ? null : { serverIds: [...serverIds], libraries };
}

/** The editor refuses to save a multi-server newsletter without a name, so the Tracearr fallback only fires for old rows; the log says which. */
export function variantSenderName(
  newsletter: { id: string; senderName: string | null },
  serverNames: readonly string[]
): string {
  if (!newsletter.senderName && serverNames.length > 1) {
    logger.warn(
      'Newsletter covers several servers without a sender name; the digest is signed Tracearr',
      {
        newsletterId: newsletter.id,
        servers: serverNames,
      }
    );
  }
  return resolveSenderName(newsletter.senderName, [...serverNames]);
}
