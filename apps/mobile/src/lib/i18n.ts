import { initI18n, detectLanguage, type SupportedLanguage } from '@tracearr/translations/mobile';
import AsyncStorage from '@react-native-async-storage/async-storage';

// AsyncStorage adapter for the translations package's language detection/persistence
const asyncStorageAdapter = {
  getItem: (key: string) => AsyncStorage.getItem(key),
  setItem: (key: string, value: string) => AsyncStorage.setItem(key, value),
};

// Detect language (stored pref → device locale → English) and init i18next
export const i18nReady = detectLanguage(asyncStorageAdapter)
  .then((language) => initI18n({ lng: language as SupportedLanguage }))
  .catch((error) => {
    console.error('[i18n] Failed to initialize, falling back to English:', error);
    return initI18n({ lng: 'en' });
  });

export { asyncStorageAdapter };
