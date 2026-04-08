/**
 * @tracearr/translations/mobile
 *
 * Mobile entry point — uses static locale imports instead of Vite's import.meta.glob.
 */

// Core i18n exports
export {
  i18n,
  initI18n,
  loadLocale,
  defaultI18nConfig,
  defaultNS,
  namespaces,
  resources,
  supportedLanguages,
  type SupportedLanguage,
  type Namespace,
} from './config.mobile.js';

// Language detection and management (shared — no bundler-specific code)
export {
  languageNames,
  getSupportedLanguages,
  isLanguageSupported,
  resolveLocale,
  detectLanguage,
  detectSystemLanguage,
  changeLanguage,
  getCurrentLanguage,
  getLanguageDisplayName,
} from './language.js';

// Type exports for type-safe translations
export type {
  AllResources,
  TranslationResources,
  CommonTranslations,
  NotificationsTranslations,
  SettingsTranslations,
  NavTranslations,
  PagesTranslations,
  MobileTranslations,
  NestedKeyOf,
  TranslationValue,
  CommonKey,
  NotificationsKey,
  SettingsKey,
  NavKey,
  PagesKey,
  MobileKey,
} from './types.js';

// Formatting utilities
export {
  formatDate,
  formatTime,
  formatDateTime,
  formatRelativeTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatBytes,
  formatBitrate,
  type DateFormatStyle,
} from './formatting.js';

// Re-export react-i18next hooks
export { useTranslation, Trans, I18nextProvider } from 'react-i18next';
