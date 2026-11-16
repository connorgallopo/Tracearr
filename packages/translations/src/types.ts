/**
 * Type-safe translation key definitions.
 */

import type { resources, defaultNS, Namespace } from './config.js';

// ============================================================================
// Core Type Definitions
// ============================================================================

/**
 * All translation resources keyed by language code.
 */
export type AllResources = typeof resources;

/**
 * Translation resources for a single language.
 */
export type TranslationResources = AllResources['en'];

/**
 * Available namespace names.
 * @deprecated Use `Namespace` from config.js instead
 */
export type TranslationNamespace = Namespace;

// ============================================================================
// i18next Module Augmentation
// ============================================================================

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: typeof defaultNS;
    resources: TranslationResources;
    strictInterpolationChecks: false;
  }
}

// ============================================================================
// Individual Namespace Types
// ============================================================================

export type CommonTranslations = TranslationResources['common'];
export type NotificationsTranslations = TranslationResources['notifications'];
export type SettingsTranslations = TranslationResources['settings'];
export type NavTranslations = TranslationResources['nav'];
export type PagesTranslations = TranslationResources['pages'];
export type MobileTranslations = TranslationResources['mobile'];

// ============================================================================
// Utility Types for Translation Keys
// ============================================================================

/**
 * Generates dot-notation key paths for nested objects.
 *
 * @example
 * type CommonKeys = NestedKeyOf<CommonTranslations>;
 * // "actions.save" | "actions.cancel" | "states.loading" | ...
 */
export type NestedKeyOf<T> = T extends object
  ? {
      [K in keyof T & string]: T[K] extends object ? `${K}` | `${K}.${NestedKeyOf<T[K]>}` : `${K}`;
    }[keyof T & string]
  : never;

/**
 * Get the value type at a nested key path.
 *
 * @example
 * type SaveLabel = TranslationValue<CommonTranslations, 'actions.save'>;
 * // string
 */
export type TranslationValue<T, K extends string> = K extends `${infer First}.${infer Rest}`
  ? First extends keyof T
    ? TranslationValue<T[First], Rest>
    : never
  : K extends keyof T
    ? T[K]
    : never;

export type CommonKey = NestedKeyOf<CommonTranslations>;
export type NotificationsKey = NestedKeyOf<NotificationsTranslations>;
export type SettingsKey = NestedKeyOf<SettingsTranslations>;
export type NavKey = NestedKeyOf<NavTranslations>;
export type PagesKey = NestedKeyOf<PagesTranslations>;
export type MobileKey = NestedKeyOf<MobileTranslations>;
