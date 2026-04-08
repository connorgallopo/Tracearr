/**
 * Language Selection Screen
 * Allows the user to pick a display language, persisted to device only.
 */
import { View, Pressable, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Check } from 'lucide-react-native';
import { Text } from '@/components/ui/text';
import { ACCENT_COLOR } from '@/lib/theme';
import { languageNames, getCurrentLanguage, changeLanguage } from '@tracearr/translations/mobile';
import { asyncStorageAdapter } from '@/lib/i18n';
import { useState } from 'react';

export default function LanguageScreen() {
  const [currentLang, setCurrentLang] = useState(getCurrentLanguage());
  const [changing, setChanging] = useState(false);

  const handleSelect = async (code: string) => {
    if (code === currentLang || changing) return;
    setChanging(true);
    try {
      await changeLanguage(code, asyncStorageAdapter);
      setCurrentLang(code);
    } catch (error) {
      console.error('[Language] Failed to change language:', error);
    } finally {
      setChanging(false);
    }
  };

  const languages = Object.entries(languageNames);

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: '#09090B' }}
      edges={['left', 'right', 'bottom']}
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
        <View className="bg-card overflow-hidden rounded-xl">
          {languages.map(([code, name], index) => (
            <View key={code}>
              {index > 0 && <View className="bg-border ml-4 h-px" />}
              <Pressable
                onPress={() => void handleSelect(code)}
                className="flex-row items-center justify-between px-4 py-3.5"
                disabled={changing}
              >
                <View className="flex-1">
                  <Text className="text-[15px] font-medium">{name}</Text>
                  {code !== 'en' && (
                    <Text className="text-muted-foreground mt-0.5 text-xs">{code}</Text>
                  )}
                </View>
                {code === currentLang && <Check size={20} color={ACCENT_COLOR} />}
              </Pressable>
            </View>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
