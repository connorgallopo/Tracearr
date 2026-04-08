/**
 * Language detection and management utilities.
 *
 * Works in both web (browser) and mobile (React Native/Expo) environments.
 * Language codes use full locale format (e.g., 'fr-FR', 'zh-CN') except for
 * English which uses 'en' as the base/fallback language.
 */

import i18n from 'i18next';

// Locale loader — set by config.ts (web) or config.mobile.ts (mobile) at import time
// eslint-disable-next-line @typescript-eslint/no-empty-function
let _loadLocaleFn: (lang: string) => Promise<void> = async () => {};

/** @internal */
export function _registerLocaleLoader(fn: (lang: string) => Promise<void>): void {
  _loadLocaleFn = fn;
}

// Storage key for persisted language preference
const LANGUAGE_STORAGE_KEY = 'tracearr_language';

/**
 * Supported languages with display names.
 * Add new languages here when adding translations.
 */
export const languageNames = {
  en: 'English',
  'af-ZA': 'Afrikaans',
  'ar-SA': 'العربية',
  'ca-ES': 'Català',
  'cs-CZ': 'Čeština',
  'da-DK': 'Dansk',
  'de-DE': 'Deutsch',
  'el-GR': 'Ελληνικά',
  'es-ES': 'Español',
  'fi-FI': 'Suomi',
  'fr-FR': 'Français',
  'he-IL': 'עברית',
  'hu-HU': 'Magyar',
  'it-IT': 'Italiano',
  'ja-JP': '日本語',
  'ko-KR': '한국어',
  'nl-NL': 'Nederlands',
  'no-NO': 'Norsk',
  'pl-PL': 'Polski',
  'pt-BR': 'Português (Brasil)',
  'pt-PT': 'Português (Portugal)',
  'ro-RO': 'Română',
  'ru-RU': 'Русский',
  'sr-SP': 'Српски',
  'sv-SE': 'Svenska',
  'tr-TR': 'Türkçe',
  'uk-UA': 'Українська',
  'vi-VN': 'Tiếng Việt',
  'zh-CN': '中文 (简体)',
  'zh-TW': '中文 (繁體)',
} as const;

export type LanguageCode = keyof typeof languageNames;

/**
 * Get the list of supported language codes.
 */
export function getSupportedLanguages(): string[] {
  return Object.keys(languageNames);
}

/**
 * Check if a language code is supported (exact match).
 */
export function isLanguageSupported(lang: string): boolean {
  if (!lang || typeof lang !== 'string') return false;
  return lang in languageNames;
}

/**
 * Resolve a language code to the best matching supported locale.
 *
 * Handles exact matches, legacy two-letter codes (e.g., 'fr' → 'fr-FR'),
 * and browser locale strings (e.g., 'zh-Hant-TW' → 'zh-TW').
 *
 * Returns null if no match is found.
 */
export function resolveLocale(lang: string): string | null {
  if (!lang || typeof lang !== 'string') return null;

  // Normalize: lowercase language, uppercase region
  const normalized = normalizeLocaleCode(lang);

  // Exact match (e.g., 'zh-CN', 'en')
  if (normalized in languageNames) return normalized;

  // Try base language match (e.g., 'fr' → 'fr-FR', 'zh' → 'zh-CN')
  const baseLang = normalized.split('-')[0];
  if (!baseLang) return null;

  // 'en' is a direct match
  if (baseLang === 'en') return 'en';

  // Find first supported locale starting with the base language
  const match = Object.keys(languageNames).find((code) => code.startsWith(baseLang + '-'));
  return match ?? null;
}

/**
 * Normalize a locale code: lowercase language, uppercase region.
 * e.g., 'ZH-cn' → 'zh-CN', 'FR' → 'fr', 'pt-br' → 'pt-BR'
 */
function normalizeLocaleCode(code: string): string {
  const trimmed = code.trim();
  const [lang, region] = trimmed.split('-');
  if (!region) return trimmed.toLowerCase();
  return `${lang?.toLowerCase()}-${region.toUpperCase()}`;
}

/**
 * Detect the user's preferred language.
 *
 * Priority order:
 * 1. Stored preference (localStorage/AsyncStorage)
 * 2. Browser/device language (checks all preferred languages)
 * 3. Fallback to 'en'
 *
 * @param storage - Optional storage adapter for React Native (AsyncStorage)
 */
export async function detectLanguage(storage?: {
  getItem: (key: string) => Promise<string | null>;
}): Promise<string> {
  // 1. Check stored preference
  try {
    const stored = await getStoredLanguage(storage);
    if (stored) {
      const resolved = resolveLocale(stored);
      if (resolved) return resolved;
    }
  } catch (error) {
    console.warn('[i18n] Failed to get stored language:', error);
  }

  // 2. Check browser/device language
  const detected = detectSystemLanguage();
  if (detected) return detected;

  // 3. Fallback
  return 'en';
}

/**
 * Detect the system/browser language.
 * Checks all preferred languages in order (navigator.languages).
 * Works in both web and React Native environments.
 */
export function detectSystemLanguage(): string | null {
  if (typeof navigator === 'undefined') return null;

  // Check all preferred languages in order
  const languages = navigator.languages || (navigator.language ? [navigator.language] : []);

  for (const lang of languages) {
    if (!lang) continue;
    const resolved = resolveLocale(lang);
    if (resolved) return resolved;
  }

  return null;
}

/**
 * Get the stored language preference.
 * Safely handles localStorage exceptions (private browsing, SSR, etc.).
 */
async function getStoredLanguage(storage?: {
  getItem: (key: string) => Promise<string | null>;
}): Promise<string | null> {
  // React Native with AsyncStorage
  if (storage) {
    try {
      return await storage.getItem(LANGUAGE_STORAGE_KEY);
    } catch (error) {
      console.warn('[i18n] AsyncStorage read failed:', error);
      return null;
    }
  }

  // Browser with localStorage
  if (typeof localStorage !== 'undefined') {
    try {
      return localStorage.getItem(LANGUAGE_STORAGE_KEY);
    } catch (error) {
      // Fails in private browsing, SSR, or when storage is disabled
      console.warn('[i18n] localStorage read failed:', error);
      return null;
    }
  }

  return null;
}

/**
 * Store the language preference.
 * Safely handles localStorage exceptions.
 */
async function setStoredLanguage(
  lang: string,
  storage?: { setItem: (key: string, value: string) => Promise<void> }
): Promise<void> {
  // React Native with AsyncStorage
  if (storage) {
    try {
      await storage.setItem(LANGUAGE_STORAGE_KEY, lang);
    } catch (error) {
      console.warn('[i18n] AsyncStorage write failed:', error);
    }
    return;
  }

  // Browser with localStorage
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, lang);
    } catch (error) {
      // Fails in private browsing, SSR, or when quota exceeded
      console.warn('[i18n] localStorage write failed:', error);
    }
  }
}

/**
 * Change the current language and persist the preference.
 *
 * @param lang - Locale code (e.g., 'en', 'fr-FR', 'zh-CN')
 * @param storage - Optional storage adapter for React Native
 * @throws Error if language code is invalid or unsupported
 */
export async function changeLanguage(
  lang: string,
  storage?: { setItem: (key: string, value: string) => Promise<void> }
): Promise<void> {
  // Validate input
  if (!lang || typeof lang !== 'string') {
    throw new Error(`Invalid language code: ${String(lang)}`);
  }

  const resolved = resolveLocale(lang);

  if (!resolved) {
    throw new Error(
      `Language '${lang}' is not supported. Available: ${getSupportedLanguages().join(', ')}`
    );
  }

  await _loadLocaleFn(resolved);
  await i18n.changeLanguage(resolved);
  await setStoredLanguage(resolved, storage);
}

/**
 * Get the current language.
 */
export function getCurrentLanguage(): string {
  return i18n.language || 'en';
}

/**
 * Get the display name for a language code.
 */
export function getLanguageDisplayName(lang: string): string {
  return languageNames[lang as LanguageCode] || lang;
}
