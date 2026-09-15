// Postgres rejects 0x00 and invalid UTF-8 in TEXT/VARCHAR (SQLSTATE 22021) at
// parameter bind, which aborts the whole transaction. Music ID3 tags routinely
// carry these as padding, so we scrub at the ingest boundary.

const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function sanitizeText<T extends string | null | undefined>(value: T): T {
  if (typeof value !== 'string' || value === '') return value;
  return value.replaceAll('\u0000', '').replace(UNPAIRED_SURROGATE, '\uFFFD') as T;
}

export function sanitizeTextArray<T extends readonly unknown[]>(values: T): T {
  let changed = false;
  const out = values.map((val) => {
    if (typeof val !== 'string') return val;
    const scrubbed = sanitizeText(val);
    if (scrubbed !== val) changed = true;
    return scrubbed;
  });
  return changed ? (out as unknown as T) : values;
}

export function scrubStringFields<T extends Record<string, unknown>>(record: T): T {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const val = record[key];
    if (typeof val === 'string') {
      const scrubbed = sanitizeText(val);
      if (scrubbed !== val) changed = true;
      out[key] = scrubbed;
    } else if (Array.isArray(val)) {
      const scrubbed = sanitizeTextArray(val);
      if (scrubbed !== val) changed = true;
      out[key] = scrubbed;
    } else {
      out[key] = val;
    }
  }
  return changed ? (out as T) : record;
}
