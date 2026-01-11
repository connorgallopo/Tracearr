/**
 * Language detection and management utilities.
 *
 * Works in both web (browser) and mobile (React Native/Expo) environments.
 */

import { i18n } from './config.js';

// Storage key for persisted language preference
const LANGUAGE_STORAGE_KEY = 'tracearr_language';

/**
 * Supported languages with display names.
 * Add new languages here when adding translations.
 */
export const languageNames = {
  en: 'English',
  de: 'Deutsch',
  pt: 'Português (Portugal)',
  // Add new languages here:
  // es: 'Español',
  // fr: 'Français',
  // ja: '日本語',
  // zh: '中文',
} as const;

export type LanguageCode = keyof typeof languageNames;

/**
 * Get the list of supported language codes.
 */
export function getSupportedLanguages(): string[] {
  return Object.keys(languageNames);
}

/**
 * Check if a language code is supported.
 */
export function isLanguageSupported(lang: string): boolean {
  if (!lang || typeof lang !== 'string') return false;
  const baseLang = lang.split('-')[0] || lang;
  return baseLang in languageNames;
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
    if (stored && isLanguageSupported(stored)) {
      return stored;
    }
  } catch (error) {
    console.warn('[i18n] Failed to get stored language:', error);
  }

  // 2. Check browser/device language
  const detected = detectSystemLanguage();
  if (detected && isLanguageSupported(detected)) {
    return detected;
  }

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
    const baseLang = lang.split('-')[0];
    if (baseLang && isLanguageSupported(baseLang)) {
      return baseLang;
    }
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
 * @param lang - Language code (e.g., 'en', 'es', 'fr')
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

  const sanitized = lang.trim().toLowerCase();

  if (!sanitized) {
    throw new Error('Language code cannot be empty');
  }

  if (!isLanguageSupported(sanitized)) {
    throw new Error(
      `Language '${sanitized}' is not supported. Available: ${getSupportedLanguages().join(', ')}`
    );
  }

  await i18n.changeLanguage(sanitized);
  await setStoredLanguage(sanitized, storage);
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
