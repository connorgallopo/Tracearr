/**
 * Mobile i18n config — statically imports all locales for Metro compatibility.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { _registerLocaleLoader } from './language.js';

// ============================================================================
// English (base language)
// ============================================================================
import commonEn from './locales/en/common.json' with { type: 'json' };
import notificationsEn from './locales/en/notifications.json' with { type: 'json' };
import settingsEn from './locales/en/settings.json' with { type: 'json' };
import navEn from './locales/en/nav.json' with { type: 'json' };
import pagesEn from './locales/en/pages.json' with { type: 'json' };
import mobileEn from './locales/en/mobile.json' with { type: 'json' };

// ============================================================================
// All other locales (statically imported for Metro compatibility)
// ============================================================================

// af-ZA
import afZA_common from './locales/af-ZA/common.json' with { type: 'json' };
import afZA_notifications from './locales/af-ZA/notifications.json' with { type: 'json' };
import afZA_settings from './locales/af-ZA/settings.json' with { type: 'json' };
import afZA_nav from './locales/af-ZA/nav.json' with { type: 'json' };
import afZA_pages from './locales/af-ZA/pages.json' with { type: 'json' };
import afZA_mobile from './locales/af-ZA/mobile.json' with { type: 'json' };

// ar-SA
import arSA_common from './locales/ar-SA/common.json' with { type: 'json' };
import arSA_notifications from './locales/ar-SA/notifications.json' with { type: 'json' };
import arSA_settings from './locales/ar-SA/settings.json' with { type: 'json' };
import arSA_nav from './locales/ar-SA/nav.json' with { type: 'json' };
import arSA_pages from './locales/ar-SA/pages.json' with { type: 'json' };
import arSA_mobile from './locales/ar-SA/mobile.json' with { type: 'json' };

// ca-ES
import caES_common from './locales/ca-ES/common.json' with { type: 'json' };
import caES_notifications from './locales/ca-ES/notifications.json' with { type: 'json' };
import caES_settings from './locales/ca-ES/settings.json' with { type: 'json' };
import caES_nav from './locales/ca-ES/nav.json' with { type: 'json' };
import caES_pages from './locales/ca-ES/pages.json' with { type: 'json' };
import caES_mobile from './locales/ca-ES/mobile.json' with { type: 'json' };

// cs-CZ
import csCZ_common from './locales/cs-CZ/common.json' with { type: 'json' };
import csCZ_notifications from './locales/cs-CZ/notifications.json' with { type: 'json' };
import csCZ_settings from './locales/cs-CZ/settings.json' with { type: 'json' };
import csCZ_nav from './locales/cs-CZ/nav.json' with { type: 'json' };
import csCZ_pages from './locales/cs-CZ/pages.json' with { type: 'json' };
import csCZ_mobile from './locales/cs-CZ/mobile.json' with { type: 'json' };

// da-DK
import daDK_common from './locales/da-DK/common.json' with { type: 'json' };
import daDK_notifications from './locales/da-DK/notifications.json' with { type: 'json' };
import daDK_settings from './locales/da-DK/settings.json' with { type: 'json' };
import daDK_nav from './locales/da-DK/nav.json' with { type: 'json' };
import daDK_pages from './locales/da-DK/pages.json' with { type: 'json' };
import daDK_mobile from './locales/da-DK/mobile.json' with { type: 'json' };

// de-DE
import deDE_common from './locales/de-DE/common.json' with { type: 'json' };
import deDE_notifications from './locales/de-DE/notifications.json' with { type: 'json' };
import deDE_settings from './locales/de-DE/settings.json' with { type: 'json' };
import deDE_nav from './locales/de-DE/nav.json' with { type: 'json' };
import deDE_pages from './locales/de-DE/pages.json' with { type: 'json' };
import deDE_mobile from './locales/de-DE/mobile.json' with { type: 'json' };

// el-GR
import elGR_common from './locales/el-GR/common.json' with { type: 'json' };
import elGR_notifications from './locales/el-GR/notifications.json' with { type: 'json' };
import elGR_settings from './locales/el-GR/settings.json' with { type: 'json' };
import elGR_nav from './locales/el-GR/nav.json' with { type: 'json' };
import elGR_pages from './locales/el-GR/pages.json' with { type: 'json' };
import elGR_mobile from './locales/el-GR/mobile.json' with { type: 'json' };

// es-ES
import esES_common from './locales/es-ES/common.json' with { type: 'json' };
import esES_notifications from './locales/es-ES/notifications.json' with { type: 'json' };
import esES_settings from './locales/es-ES/settings.json' with { type: 'json' };
import esES_nav from './locales/es-ES/nav.json' with { type: 'json' };
import esES_pages from './locales/es-ES/pages.json' with { type: 'json' };
import esES_mobile from './locales/es-ES/mobile.json' with { type: 'json' };

// fi-FI
import fiFI_common from './locales/fi-FI/common.json' with { type: 'json' };
import fiFI_notifications from './locales/fi-FI/notifications.json' with { type: 'json' };
import fiFI_settings from './locales/fi-FI/settings.json' with { type: 'json' };
import fiFI_nav from './locales/fi-FI/nav.json' with { type: 'json' };
import fiFI_pages from './locales/fi-FI/pages.json' with { type: 'json' };
import fiFI_mobile from './locales/fi-FI/mobile.json' with { type: 'json' };

// fr-FR
import frFR_common from './locales/fr-FR/common.json' with { type: 'json' };
import frFR_notifications from './locales/fr-FR/notifications.json' with { type: 'json' };
import frFR_settings from './locales/fr-FR/settings.json' with { type: 'json' };
import frFR_nav from './locales/fr-FR/nav.json' with { type: 'json' };
import frFR_pages from './locales/fr-FR/pages.json' with { type: 'json' };
import frFR_mobile from './locales/fr-FR/mobile.json' with { type: 'json' };

// he-IL
import heIL_common from './locales/he-IL/common.json' with { type: 'json' };
import heIL_notifications from './locales/he-IL/notifications.json' with { type: 'json' };
import heIL_settings from './locales/he-IL/settings.json' with { type: 'json' };
import heIL_nav from './locales/he-IL/nav.json' with { type: 'json' };
import heIL_pages from './locales/he-IL/pages.json' with { type: 'json' };
import heIL_mobile from './locales/he-IL/mobile.json' with { type: 'json' };

// hu-HU
import huHU_common from './locales/hu-HU/common.json' with { type: 'json' };
import huHU_notifications from './locales/hu-HU/notifications.json' with { type: 'json' };
import huHU_settings from './locales/hu-HU/settings.json' with { type: 'json' };
import huHU_nav from './locales/hu-HU/nav.json' with { type: 'json' };
import huHU_pages from './locales/hu-HU/pages.json' with { type: 'json' };
import huHU_mobile from './locales/hu-HU/mobile.json' with { type: 'json' };

// it-IT
import itIT_common from './locales/it-IT/common.json' with { type: 'json' };
import itIT_notifications from './locales/it-IT/notifications.json' with { type: 'json' };
import itIT_settings from './locales/it-IT/settings.json' with { type: 'json' };
import itIT_nav from './locales/it-IT/nav.json' with { type: 'json' };
import itIT_pages from './locales/it-IT/pages.json' with { type: 'json' };
import itIT_mobile from './locales/it-IT/mobile.json' with { type: 'json' };

// ja-JP
import jaJP_common from './locales/ja-JP/common.json' with { type: 'json' };
import jaJP_notifications from './locales/ja-JP/notifications.json' with { type: 'json' };
import jaJP_settings from './locales/ja-JP/settings.json' with { type: 'json' };
import jaJP_nav from './locales/ja-JP/nav.json' with { type: 'json' };
import jaJP_pages from './locales/ja-JP/pages.json' with { type: 'json' };
import jaJP_mobile from './locales/ja-JP/mobile.json' with { type: 'json' };

// ko-KR
import koKR_common from './locales/ko-KR/common.json' with { type: 'json' };
import koKR_notifications from './locales/ko-KR/notifications.json' with { type: 'json' };
import koKR_settings from './locales/ko-KR/settings.json' with { type: 'json' };
import koKR_nav from './locales/ko-KR/nav.json' with { type: 'json' };
import koKR_pages from './locales/ko-KR/pages.json' with { type: 'json' };
import koKR_mobile from './locales/ko-KR/mobile.json' with { type: 'json' };

// nl-NL
import nlNL_common from './locales/nl-NL/common.json' with { type: 'json' };
import nlNL_notifications from './locales/nl-NL/notifications.json' with { type: 'json' };
import nlNL_settings from './locales/nl-NL/settings.json' with { type: 'json' };
import nlNL_nav from './locales/nl-NL/nav.json' with { type: 'json' };
import nlNL_pages from './locales/nl-NL/pages.json' with { type: 'json' };
import nlNL_mobile from './locales/nl-NL/mobile.json' with { type: 'json' };

// no-NO
import noNO_common from './locales/no-NO/common.json' with { type: 'json' };
import noNO_notifications from './locales/no-NO/notifications.json' with { type: 'json' };
import noNO_settings from './locales/no-NO/settings.json' with { type: 'json' };
import noNO_nav from './locales/no-NO/nav.json' with { type: 'json' };
import noNO_pages from './locales/no-NO/pages.json' with { type: 'json' };
import noNO_mobile from './locales/no-NO/mobile.json' with { type: 'json' };

// pl-PL
import plPL_common from './locales/pl-PL/common.json' with { type: 'json' };
import plPL_notifications from './locales/pl-PL/notifications.json' with { type: 'json' };
import plPL_settings from './locales/pl-PL/settings.json' with { type: 'json' };
import plPL_nav from './locales/pl-PL/nav.json' with { type: 'json' };
import plPL_pages from './locales/pl-PL/pages.json' with { type: 'json' };
import plPL_mobile from './locales/pl-PL/mobile.json' with { type: 'json' };

// pt-BR
import ptBR_common from './locales/pt-BR/common.json' with { type: 'json' };
import ptBR_notifications from './locales/pt-BR/notifications.json' with { type: 'json' };
import ptBR_settings from './locales/pt-BR/settings.json' with { type: 'json' };
import ptBR_nav from './locales/pt-BR/nav.json' with { type: 'json' };
import ptBR_pages from './locales/pt-BR/pages.json' with { type: 'json' };
import ptBR_mobile from './locales/pt-BR/mobile.json' with { type: 'json' };

// pt-PT
import ptPT_common from './locales/pt-PT/common.json' with { type: 'json' };
import ptPT_notifications from './locales/pt-PT/notifications.json' with { type: 'json' };
import ptPT_settings from './locales/pt-PT/settings.json' with { type: 'json' };
import ptPT_nav from './locales/pt-PT/nav.json' with { type: 'json' };
import ptPT_pages from './locales/pt-PT/pages.json' with { type: 'json' };
import ptPT_mobile from './locales/pt-PT/mobile.json' with { type: 'json' };

// ro-RO
import roRO_common from './locales/ro-RO/common.json' with { type: 'json' };
import roRO_notifications from './locales/ro-RO/notifications.json' with { type: 'json' };
import roRO_settings from './locales/ro-RO/settings.json' with { type: 'json' };
import roRO_nav from './locales/ro-RO/nav.json' with { type: 'json' };
import roRO_pages from './locales/ro-RO/pages.json' with { type: 'json' };
import roRO_mobile from './locales/ro-RO/mobile.json' with { type: 'json' };

// ru-RU
import ruRU_common from './locales/ru-RU/common.json' with { type: 'json' };
import ruRU_notifications from './locales/ru-RU/notifications.json' with { type: 'json' };
import ruRU_settings from './locales/ru-RU/settings.json' with { type: 'json' };
import ruRU_nav from './locales/ru-RU/nav.json' with { type: 'json' };
import ruRU_pages from './locales/ru-RU/pages.json' with { type: 'json' };
import ruRU_mobile from './locales/ru-RU/mobile.json' with { type: 'json' };

// sr-SP
import srSP_common from './locales/sr-SP/common.json' with { type: 'json' };
import srSP_notifications from './locales/sr-SP/notifications.json' with { type: 'json' };
import srSP_settings from './locales/sr-SP/settings.json' with { type: 'json' };
import srSP_nav from './locales/sr-SP/nav.json' with { type: 'json' };
import srSP_pages from './locales/sr-SP/pages.json' with { type: 'json' };
import srSP_mobile from './locales/sr-SP/mobile.json' with { type: 'json' };

// sv-SE
import svSE_common from './locales/sv-SE/common.json' with { type: 'json' };
import svSE_notifications from './locales/sv-SE/notifications.json' with { type: 'json' };
import svSE_settings from './locales/sv-SE/settings.json' with { type: 'json' };
import svSE_nav from './locales/sv-SE/nav.json' with { type: 'json' };
import svSE_pages from './locales/sv-SE/pages.json' with { type: 'json' };
import svSE_mobile from './locales/sv-SE/mobile.json' with { type: 'json' };

// tr-TR
import trTR_common from './locales/tr-TR/common.json' with { type: 'json' };
import trTR_notifications from './locales/tr-TR/notifications.json' with { type: 'json' };
import trTR_settings from './locales/tr-TR/settings.json' with { type: 'json' };
import trTR_nav from './locales/tr-TR/nav.json' with { type: 'json' };
import trTR_pages from './locales/tr-TR/pages.json' with { type: 'json' };
import trTR_mobile from './locales/tr-TR/mobile.json' with { type: 'json' };

// uk-UA
import ukUA_common from './locales/uk-UA/common.json' with { type: 'json' };
import ukUA_notifications from './locales/uk-UA/notifications.json' with { type: 'json' };
import ukUA_settings from './locales/uk-UA/settings.json' with { type: 'json' };
import ukUA_nav from './locales/uk-UA/nav.json' with { type: 'json' };
import ukUA_pages from './locales/uk-UA/pages.json' with { type: 'json' };
import ukUA_mobile from './locales/uk-UA/mobile.json' with { type: 'json' };

// vi-VN
import viVN_common from './locales/vi-VN/common.json' with { type: 'json' };
import viVN_notifications from './locales/vi-VN/notifications.json' with { type: 'json' };
import viVN_settings from './locales/vi-VN/settings.json' with { type: 'json' };
import viVN_nav from './locales/vi-VN/nav.json' with { type: 'json' };
import viVN_pages from './locales/vi-VN/pages.json' with { type: 'json' };
import viVN_mobile from './locales/vi-VN/mobile.json' with { type: 'json' };

// zh-CN
import zhCN_common from './locales/zh-CN/common.json' with { type: 'json' };
import zhCN_notifications from './locales/zh-CN/notifications.json' with { type: 'json' };
import zhCN_settings from './locales/zh-CN/settings.json' with { type: 'json' };
import zhCN_nav from './locales/zh-CN/nav.json' with { type: 'json' };
import zhCN_pages from './locales/zh-CN/pages.json' with { type: 'json' };
import zhCN_mobile from './locales/zh-CN/mobile.json' with { type: 'json' };

// zh-TW
import zhTW_common from './locales/zh-TW/common.json' with { type: 'json' };
import zhTW_notifications from './locales/zh-TW/notifications.json' with { type: 'json' };
import zhTW_settings from './locales/zh-TW/settings.json' with { type: 'json' };
import zhTW_nav from './locales/zh-TW/nav.json' with { type: 'json' };
import zhTW_pages from './locales/zh-TW/pages.json' with { type: 'json' };
import zhTW_mobile from './locales/zh-TW/mobile.json' with { type: 'json' };

// ============================================================================
// Shared constants (mirrors config.ts)
// ============================================================================

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

// ============================================================================
// All locale resources (pre-built for mobile — no lazy loading needed)
// ============================================================================

type LocaleResources = Record<string, Record<string, unknown>>;

const allLocaleResources: Record<string, LocaleResources> = {
  'af-ZA': {
    common: afZA_common,
    notifications: afZA_notifications,
    settings: afZA_settings,
    nav: afZA_nav,
    pages: afZA_pages,
    mobile: afZA_mobile,
  },
  'ar-SA': {
    common: arSA_common,
    notifications: arSA_notifications,
    settings: arSA_settings,
    nav: arSA_nav,
    pages: arSA_pages,
    mobile: arSA_mobile,
  },
  'ca-ES': {
    common: caES_common,
    notifications: caES_notifications,
    settings: caES_settings,
    nav: caES_nav,
    pages: caES_pages,
    mobile: caES_mobile,
  },
  'cs-CZ': {
    common: csCZ_common,
    notifications: csCZ_notifications,
    settings: csCZ_settings,
    nav: csCZ_nav,
    pages: csCZ_pages,
    mobile: csCZ_mobile,
  },
  'da-DK': {
    common: daDK_common,
    notifications: daDK_notifications,
    settings: daDK_settings,
    nav: daDK_nav,
    pages: daDK_pages,
    mobile: daDK_mobile,
  },
  'de-DE': {
    common: deDE_common,
    notifications: deDE_notifications,
    settings: deDE_settings,
    nav: deDE_nav,
    pages: deDE_pages,
    mobile: deDE_mobile,
  },
  'el-GR': {
    common: elGR_common,
    notifications: elGR_notifications,
    settings: elGR_settings,
    nav: elGR_nav,
    pages: elGR_pages,
    mobile: elGR_mobile,
  },
  'es-ES': {
    common: esES_common,
    notifications: esES_notifications,
    settings: esES_settings,
    nav: esES_nav,
    pages: esES_pages,
    mobile: esES_mobile,
  },
  'fi-FI': {
    common: fiFI_common,
    notifications: fiFI_notifications,
    settings: fiFI_settings,
    nav: fiFI_nav,
    pages: fiFI_pages,
    mobile: fiFI_mobile,
  },
  'fr-FR': {
    common: frFR_common,
    notifications: frFR_notifications,
    settings: frFR_settings,
    nav: frFR_nav,
    pages: frFR_pages,
    mobile: frFR_mobile,
  },
  'he-IL': {
    common: heIL_common,
    notifications: heIL_notifications,
    settings: heIL_settings,
    nav: heIL_nav,
    pages: heIL_pages,
    mobile: heIL_mobile,
  },
  'hu-HU': {
    common: huHU_common,
    notifications: huHU_notifications,
    settings: huHU_settings,
    nav: huHU_nav,
    pages: huHU_pages,
    mobile: huHU_mobile,
  },
  'it-IT': {
    common: itIT_common,
    notifications: itIT_notifications,
    settings: itIT_settings,
    nav: itIT_nav,
    pages: itIT_pages,
    mobile: itIT_mobile,
  },
  'ja-JP': {
    common: jaJP_common,
    notifications: jaJP_notifications,
    settings: jaJP_settings,
    nav: jaJP_nav,
    pages: jaJP_pages,
    mobile: jaJP_mobile,
  },
  'ko-KR': {
    common: koKR_common,
    notifications: koKR_notifications,
    settings: koKR_settings,
    nav: koKR_nav,
    pages: koKR_pages,
    mobile: koKR_mobile,
  },
  'nl-NL': {
    common: nlNL_common,
    notifications: nlNL_notifications,
    settings: nlNL_settings,
    nav: nlNL_nav,
    pages: nlNL_pages,
    mobile: nlNL_mobile,
  },
  'no-NO': {
    common: noNO_common,
    notifications: noNO_notifications,
    settings: noNO_settings,
    nav: noNO_nav,
    pages: noNO_pages,
    mobile: noNO_mobile,
  },
  'pl-PL': {
    common: plPL_common,
    notifications: plPL_notifications,
    settings: plPL_settings,
    nav: plPL_nav,
    pages: plPL_pages,
    mobile: plPL_mobile,
  },
  'pt-BR': {
    common: ptBR_common,
    notifications: ptBR_notifications,
    settings: ptBR_settings,
    nav: ptBR_nav,
    pages: ptBR_pages,
    mobile: ptBR_mobile,
  },
  'pt-PT': {
    common: ptPT_common,
    notifications: ptPT_notifications,
    settings: ptPT_settings,
    nav: ptPT_nav,
    pages: ptPT_pages,
    mobile: ptPT_mobile,
  },
  'ro-RO': {
    common: roRO_common,
    notifications: roRO_notifications,
    settings: roRO_settings,
    nav: roRO_nav,
    pages: roRO_pages,
    mobile: roRO_mobile,
  },
  'ru-RU': {
    common: ruRU_common,
    notifications: ruRU_notifications,
    settings: ruRU_settings,
    nav: ruRU_nav,
    pages: ruRU_pages,
    mobile: ruRU_mobile,
  },
  'sr-SP': {
    common: srSP_common,
    notifications: srSP_notifications,
    settings: srSP_settings,
    nav: srSP_nav,
    pages: srSP_pages,
    mobile: srSP_mobile,
  },
  'sv-SE': {
    common: svSE_common,
    notifications: svSE_notifications,
    settings: svSE_settings,
    nav: svSE_nav,
    pages: svSE_pages,
    mobile: svSE_mobile,
  },
  'tr-TR': {
    common: trTR_common,
    notifications: trTR_notifications,
    settings: trTR_settings,
    nav: trTR_nav,
    pages: trTR_pages,
    mobile: trTR_mobile,
  },
  'uk-UA': {
    common: ukUA_common,
    notifications: ukUA_notifications,
    settings: ukUA_settings,
    nav: ukUA_nav,
    pages: ukUA_pages,
    mobile: ukUA_mobile,
  },
  'vi-VN': {
    common: viVN_common,
    notifications: viVN_notifications,
    settings: viVN_settings,
    nav: viVN_nav,
    pages: viVN_pages,
    mobile: viVN_mobile,
  },
  'zh-CN': {
    common: zhCN_common,
    notifications: zhCN_notifications,
    settings: zhCN_settings,
    nav: zhCN_nav,
    pages: zhCN_pages,
    mobile: zhCN_mobile,
  },
  'zh-TW': {
    common: zhTW_common,
    notifications: zhTW_notifications,
    settings: zhTW_settings,
    nav: zhTW_nav,
    pages: zhTW_pages,
    mobile: zhTW_mobile,
  },
};

// ============================================================================
// Locale Loading (synchronous — all data already imported)
// ============================================================================

const loadedLocales = new Set<string>(['en']);

/**
 * Register a locale's translation data with i18next.
 * Since all data is statically imported, this just calls addResourceBundle
 * for each namespace (no async fetch needed).
 */
export async function loadLocale(lang: string): Promise<void> {
  if (loadedLocales.has(lang)) return;

  const bundles = allLocaleResources[lang];
  if (!bundles) return;

  for (const [ns, data] of Object.entries(bundles)) {
    i18n.addResourceBundle(lang, ns, data, true, true);
  }
  loadedLocales.add(lang);
}

// Register the mobile locale loader with language.ts
_registerLocaleLoader(loadLocale);

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
    escapeValue: false,
  },
  returnNull: false,
  returnEmptyString: false,
} as const;

let initPromise: Promise<typeof i18n> | null = null;

export interface InitI18nOptions {
  lng?: SupportedLanguage;
}

/**
 * Initialize i18next for mobile. Registers only the requested language at
 * startup for fast boot. Other locales are loaded on-demand when the user
 * changes language — since all data is statically imported, this is instant.
 */
export async function initI18n(options?: InitI18nOptions): Promise<typeof i18n> {
  if (i18n.isInitialized) {
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
      // Only load the requested language at boot — others loaded on demand
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
