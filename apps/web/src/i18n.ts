import { initI18n, detectLanguage, type SupportedLanguage } from '@tracearr/translations';

// Export the ready promise so main.tsx can await before rendering.
// detectLanguage() checks stored preference first, then browser language, then falls back to English.
export const i18nReady = detectLanguage().then((language) =>
  initI18n({ lng: language as SupportedLanguage })
);

export { i18n } from '@tracearr/translations';
