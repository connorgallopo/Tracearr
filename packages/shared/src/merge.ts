export interface MergeRankInput {
  userId: string;
  loginCapable: boolean;
  /** Every server account the identity has is removed. */
  removed: boolean;
  lastActivityAt: string | null;
  sessionCount: number;
}

const RANK_KEYS: ((identity: MergeRankInput) => number)[] = [
  (identity) => (identity.loginCapable ? 1 : 0),
  (identity) => (identity.removed ? 0 : 1),
  (identity) => (identity.lastActivityAt ? Date.parse(identity.lastActivityAt) : 0),
  (identity) => identity.sessionCount,
];

/** The identity a merge keeps: one that can log in, then one with a live account, then the most recent activity, then more sessions. A full tie keeps the first. */
export function rankMergeTarget(first: MergeRankInput, second: MergeRankInput): string {
  for (const key of RANK_KEYS) {
    const diff = key(first) - key(second);
    if (diff !== 0) return diff > 0 ? first.userId : second.userId;
  }
  return first.userId;
}
