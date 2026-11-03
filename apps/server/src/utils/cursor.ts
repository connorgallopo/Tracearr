export function encodeCursor(startedAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ t: startedAt.toISOString(), id }), 'utf8').toString(
    'base64url'
  );
}

export function decodeCursor(raw: string): { startedAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      t?: unknown;
      id?: unknown;
    };
    if (typeof parsed.t !== 'string' || typeof parsed.id !== 'string') return null;
    const startedAt = new Date(parsed.t);
    if (Number.isNaN(startedAt.getTime())) return null;
    return { startedAt, id: parsed.id };
  } catch {
    return null;
  }
}

export function encodeRankCursor(value: number, id: string): string {
  return Buffer.from(JSON.stringify({ v: value, id }), 'utf8').toString('base64url');
}

export function decodeRankCursor(raw: string): { value: number; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as {
      v?: unknown;
      id?: unknown;
    };
    if (typeof parsed.v !== 'number' || !Number.isSafeInteger(parsed.v)) return null;
    if (typeof parsed.id !== 'string') return null;
    return { value: parsed.v, id: parsed.id };
  } catch {
    return null;
  }
}
