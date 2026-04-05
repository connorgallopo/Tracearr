/**
 * @tracearr/translations
 *
 * Shared i18n translations package for Tracearr web and mobile apps.
 * Provides type-safe translation keys with IDE autocomplete.
 *
 * @example
 * ```tsx
 * import { initI18n, useTranslation } from '@tracearr/translations';
 *
 * // Initialize once at app startup
 * await initI18n();
 *
 * // Use in components
 * function MyComponent() {
 *   const { t } = useTranslation();
 *   return <button>{t('common.actions.save')}</button>;
 * }
 *
 * // With namespaces
 * function RulesComponent() {
 *   const { t } = useTranslation('pages');
 *   return <span>{t('rules.impossibleTravel')}</span>;
 * }
 * ```
 *
 * @example Language detection
 * ```tsx
 * import { detectLanguage, changeLanguage, languageNames } from '@tracearr/translations';
 *
 * // Detect user's preferred language
 * const lang = await detectLanguage();
 *
 * // Change language
 * await changeLanguage('es-ES');
 *
 * // Get available languages with display names
 * Object.entries(languageNames).map(([code, name]) => ({ code, name }));
 * ```
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
} from './config.js';

// Language detection and management
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
  // Utility types for custom type-safe operations
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

// Re-export react-i18next hooks for convenience
export { useTranslation, Trans, I18nextProvider } from 'react-i18next';
