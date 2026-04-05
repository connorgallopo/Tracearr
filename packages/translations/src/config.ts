/// <reference types="vite/client" />
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

// ============================================================================
// English Translations (Base Language — always bundled)
// ============================================================================
import commonEn from './locales/en/common.json' with { type: 'json' };
import notificationsEn from './locales/en/notifications.json' with { type: 'json' };
import settingsEn from './locales/en/settings.json' with { type: 'json' };
import navEn from './locales/en/nav.json' with { type: 'json' };
import pagesEn from './locales/en/pages.json' with { type: 'json' };
import mobileEn from './locales/en/mobile.json' with { type: 'json' };

export const defaultNS = 'common';
export const namespaces = [
  'common',
  'notifications',
  'settings',
  'nav',
  'pages',
  'mobile',
] as const;
export type Namespace = (typeof namespaces)[number];

// English is always available statically
export const resources = {
  en: {
    common: commonEn,
    notifications: notificationsEn,
    settings: settingsEn,
    nav: navEn,
    pages: pagesEn,
    mobile: mobileEn,
  },
} as const;

export const supportedLanguages = [
  'en',
  'af-ZA',
  'ar-SA',
  'ca-ES',
  'cs-CZ',
  'da-DK',
  'de-DE',
  'el-GR',
  'es-ES',
  'fi-FI',
  'fr-FR',
  'he-IL',
  'hu-HU',
  'it-IT',
  'ja-JP',
  'ko-KR',
  'nl-NL',
  'no-NO',
  'pl-PL',
  'pt-BR',
  'pt-PT',
  'ro-RO',
  'ru-RU',
  'sr-SP',
  'sv-SE',
  'tr-TR',
  'uk-UA',
  'vi-VN',
  'zh-CN',
  'zh-TW',
] as const;
export type SupportedLanguage = (typeof supportedLanguages)[number];

// ============================================================================
// Lazy Locale Loaders
// Vite discovers all locale JSON files at build time via import.meta.glob and
// creates separate chunks for each. Only the active language is downloaded.
// The *-* pattern matches locale-format dirs (af-ZA, zh-CN) but skips en/.
// ============================================================================

type LocaleData = Record<string, Record<string, unknown>>;
type LocaleLoader = () => Promise<LocaleData>;

const localeModules = import.meta.glob<{ default: Record<string, unknown> }>(
  './locales/*-*/*.json'
);

const localeLoaders: Record<string, LocaleLoader> = Object.fromEntries(
  supportedLanguages
    .filter((l) => l !== 'en')
    .map((locale) => [
      locale,
      async () => {
        const bundles: Record<string, Record<string, unknown>> = {};
        await Promise.all(
          namespaces.map(async (ns) => {
            const path = `./locales/${locale}/${ns}.json`;
            const loader = localeModules[path];
            if (loader) {
              const mod = await loader();
              bundles[ns] = mod.default;
            }
          })
        );
        return bundles;
      },
    ])
);

// ============================================================================
// Locale Loading
// ============================================================================

const loadedLocales = new Set<string>(['en']);

/**
 * Load a locale's translation data on-demand.
 * English is always available (statically bundled). Other locales are fetched
 * as separate chunks and registered with i18next via addResourceBundle.
 */
export async function loadLocale(lang: string): Promise<void> {
  if (loadedLocales.has(lang)) return;

  const loader = localeLoaders[lang];
  if (!loader) return;
  try {
    const bundles = await loader();
    for (const [ns, data] of Object.entries(bundles)) {
      i18n.addResourceBundle(lang, ns, data, true, true);
    }
    loadedLocales.add(lang);
  } catch (err) {
    console.error(`[i18n] Failed to load locale "${lang}", falling back to English`, err);
  }
}

// ============================================================================
// i18next Configuration
// ============================================================================

export const defaultI18nConfig = {
  lng: 'en',
  fallbackLng: 'en',
  defaultNS,
  ns: namespaces,
  resources,
  interpolation: {
    escapeValue: false, // React already escapes values
  },
  // Returning the key is better than empty string for debugging
  returnNull: false,
  returnEmptyString: false,
} as const;

// Prevents race conditions when initI18n is called concurrently
let initPromise: Promise<typeof i18n> | null = null;

/**
 * Initialize i18next. Call once at app startup before rendering.
 * Safe to call concurrently - multiple calls share the same initialization.
 *
 * For non-English languages, the locale is loaded on-demand after init
 * so only the active language's translations are downloaded.
 */
export interface InitI18nOptions {
  lng?: SupportedLanguage;
}

export async function initI18n(options?: InitI18nOptions): Promise<typeof i18n> {
  if (i18n.isInitialized) {
    // If already initialized but a different locale is requested, load it
    const targetLng = options?.lng || 'en';
    if (targetLng !== 'en') {
      await loadLocale(targetLng);
    }
    return i18n;
  }

  if (initPromise) {
    return initPromise;
  }

  const targetLng = options?.lng || 'en';

  initPromise = i18n
    .use(initReactI18next)
    .init({
      ...defaultI18nConfig,
      ...options,
    })
    .then(async () => {
      // Load non-English locale data after init
      if (targetLng !== 'en') {
        await loadLocale(targetLng);
      }
      initPromise = null;
      return i18n;
    })
    .catch((error: unknown) => {
      initPromise = null;
      throw error;
    });

  return initPromise;
}

export { i18n };
