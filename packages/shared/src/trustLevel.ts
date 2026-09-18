export type TrustLevel = 'trusted' | 'caution' | 'untrusted';

export const TRUST_LEVEL_THRESHOLDS = {
  trusted: 80,
  caution: 50,
} as const satisfies Record<Exclude<TrustLevel, 'untrusted'>, number>;

/** Keys in the `common` translation namespace, without the namespace prefix. */
export const TRUST_LEVEL_LABEL_KEYS = {
  trusted: 'trust.trusted',
  caution: 'trust.caution',
  untrusted: 'trust.untrusted',
} as const satisfies Record<TrustLevel, string>;

export function trustLevel(score: number): TrustLevel {
  if (score >= TRUST_LEVEL_THRESHOLDS.trusted) return 'trusted';
  if (score >= TRUST_LEVEL_THRESHOLDS.caution) return 'caution';
  return 'untrusted';
}
