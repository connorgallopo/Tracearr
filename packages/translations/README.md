# @tracearr/translations

Shared i18n for Tracearr web and mobile apps. Built on [i18next](https://www.i18next.com/).

This package is published so Tracearr's own apps can consume it outside the monorepo. It is not a stable public API.

## Entry points

- `@tracearr/translations` loads locales lazily through Vite's `import.meta.glob`, so it only works in a Vite build (the web app).
- `@tracearr/translations/mobile` statically imports every locale for Metro. Its `react-native` export condition resolves to TypeScript source, which Metro compiles itself; that is why the package ships `src/` alongside `dist/`.

## Quick start

```tsx
import { initI18n, useTranslation } from '@tracearr/translations';

// Initialize once at app startup
await initI18n();

// Use in components
function SaveButton() {
  const { t } = useTranslation();
  return <button>{t('common.actions.save')}</button>;
}
```

## Namespaces

| Namespace       | What's in it                        |
| --------------- | ----------------------------------- |
| `common`        | Buttons, states, errors, validation |
| `notifications` | Toasts and alerts                   |
| `settings`      | Settings page UI                    |
| `nav`           | Navigation menu                     |
| `pages`         | Page-level UI text                  |
| `mobile`        | Mobile app UI text                  |

Switch namespaces with the hook:

```tsx
const { t } = useTranslation('pages');
```

## Pluralization

Use `count` for plurals:

```tsx
t('common.count.user', { count: 1 }); // "1 user"
t('common.count.user', { count: 5 }); // "5 users"
```

Available: `user`, `session`, `stream`, `server`, `rule`, `violation`, `item`, `result`, `selected`.

## Formatting

Locale-aware formatting utilities:

```tsx
import { formatDate, formatRelativeTime, formatBytes } from '@tracearr/translations';

formatDate(new Date(), 'long'); // "January 2, 2026"
formatRelativeTime(Date.now() - 3600000); // "1 hour ago"
formatBytes(1536000); // "1.5 MB"
```

Also: `formatTime`, `formatDateTime`, `formatDuration`, `formatNumber`, `formatPercent`, `formatBitrate`.

## Language detection

Detects user language automatically:

1. Stored preference (localStorage on web, an AsyncStorage adapter on mobile)
2. Browser/device language
3. Falls back to English

```tsx
import { detectLanguage, changeLanguage, languageNames } from '@tracearr/translations';

const lang = await detectLanguage();
await changeLanguage('es-ES');

// Build a language picker
Object.entries(languageNames).map(([code, name]) => ({ code, name }));
```

## Adding or updating translations

Translations are managed in Crowdin. The English files under `src/locales/en/` are the source of truth; new keys go into `en` only. The check script (`pnpm check --fix`) backfills every other locale with an empty string for each new key, never with the English text. i18next runs with `returnEmptyString: false` and `fallbackLng: 'en'`, so an empty value renders current English until Crowdin supplies a real translation. Do not hand-edit non-English locale JSON, and never copy English into another locale's file.

## Type safety

Typos in translation keys show up as build errors:

```tsx
t('common.actions.svae'); // Error: typo caught at build time
```

## Files

```
src/
├── config.ts         # i18next setup (web, Vite)
├── config.mobile.ts  # i18next setup (mobile, Metro)
├── language.ts       # Detection and switching
├── formatting.ts     # Date/number utilities
├── types.ts          # TypeScript definitions
├── index.ts          # Web entry
├── mobile.ts         # Mobile entry
└── locales/
    ├── en/           # English (source of truth)
    ├── <locale>/     # Crowdin-managed translations
    └── _template/    # Reference layout for a locale folder
```

Licensed under AGPL-3.0-only. Source lives in the [Tracearr monorepo](https://github.com/connorgallopo/Tracearr) under `packages/translations`.
