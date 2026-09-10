// apps/web's tsconfig lib target predates ES2021, so Intl.ListFormat has no
// ambient type here even though every supported runtime implements it.
interface ListFormatLike {
  format(items: string[]): string;
}
interface IntlWithListFormat {
  ListFormat: new (
    locales: string,
    options: { style: 'long'; type: 'conjunction' }
  ) => ListFormatLike;
}

/** "A", "A and B", "A, B and C" in the viewer's language. */
export function formatList(locale: string, names: string[]): string {
  return new (Intl as unknown as IntlWithListFormat).ListFormat(locale, {
    style: 'long',
    type: 'conjunction',
  }).format(names);
}
