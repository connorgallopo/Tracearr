/**
 * Settings Index Screen
 * Main settings page with links to sub-settings, external links, and disconnect option
 */
import { View, Pressable, Alert, ScrollView, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import {
  Bell,
  ChevronRight,
  LogOut,
  Info,
  Server,
  MessageCircle,
  Code2,
  BookOpen,
  Globe,
  Heart,
} from 'lucide-react-native';
import * as Application from 'expo-application';
import { Text } from '@/components/ui/text';
import { useAuthStateStore } from '@/lib/authStateStore';
import { colors } from '@/lib/theme';

const DISCORD_URL = 'https://discord.gg/a7n3sFd2Yw';
const DOCS_URL = 'https://docs.tracearr.com/';
const WEBSITE_URL = 'https://tracearr.com';
const GITHUB_URL = 'https://github.com/connorgallopo/Tracearr';
const SPONSOR_URL = 'https://github.com/sponsors/connorgallopo';

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View className="mb-6">
      <Text className="text-muted-foreground mb-2 ml-1 text-[11px] font-semibold tracking-wider uppercase">
        {title}
      </Text>
      <View className="bg-card overflow-hidden rounded-xl">{children}</View>
    </View>
  );
}

function SettingsRow({
  icon,
  label,
  description,
  onPress,
  showChevron = true,
  destructive = false,
  external = false,
}: {
  icon: React.ReactNode;
  label: string;
  description?: string;
  onPress: () => void;
  showChevron?: boolean;
  destructive?: boolean;
  external?: boolean;
}) {
  return (
    <Pressable onPress={onPress} className="flex-row items-center justify-between px-4 py-3.5">
      <View className="flex-1 flex-row items-center gap-4">
        {icon}
        <View className="flex-1">
          <Text className={`text-[15px] font-medium ${destructive ? 'text-destructive' : ''}`}>
            {label}
          </Text>
          {description && (
            <Text className="text-muted-foreground mt-0.5 text-xs">{description}</Text>
          )}
        </View>
      </View>
      {showChevron && !external && <ChevronRight size={20} color={colors.icon.default} />}
    </Pressable>
  );
}

export default function SettingsScreen() {
  const router = useRouter();
  const server = useAuthStateStore((s) => s.server);
  const unpairServer = useAuthStateStore((s) => s.unpairServer);
  const appVersion = Application.nativeApplicationVersion ?? '1.0.0';
  const buildNumber = Application.nativeBuildVersion ?? 'dev';

  const handleDisconnect = () => {
    Alert.alert(
      'Disconnect Server',
      server
        ? `Are you sure you want to disconnect from "${server.name}"? You will need to pair again to use the app.`
        : 'Are you sure you want to disconnect? You will need to pair again to use the app.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await unpairServer();
              router.replace('/(auth)/pair');
            })();
          },
        },
      ]
    );
  };

  const handleDiscordPress = () => {
    void Linking.openURL(DISCORD_URL);
  };

  const handleDocsPress = () => {
    void Linking.openURL(DOCS_URL);
  };

  const handleWebsitePress = () => {
    void Linking.openURL(WEBSITE_URL);
  };

  const handleGithubPress = () => {
    void Linking.openURL(GITHUB_URL);
  };

  const handleSponsorPress = () => {
    void Linking.openURL(SPONSOR_URL);
  };

  return (
    <SafeAreaView
      style={{ flex: 1, backgroundColor: '#09090B' }}
      edges={['left', 'right', 'bottom']}
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1, padding: 16 }}>
        {/* Notifications */}
        <SettingsSection title="Preferences">
          <SettingsRow
            icon={<Bell size={20} color={colors.icon.default} />}
            label="Notifications"
            description="Configure push notification preferences"
            onPress={() => router.push('/settings/notifications')}
          />
        </SettingsSection>

        {/* Links */}
        <SettingsSection title="Community">
          <SettingsRow
            icon={<MessageCircle size={20} color="#5865F2" />}
            label="Discord"
            description="Join the community"
            onPress={handleDiscordPress}
            showChevron={false}
            external
          />
          <View className="bg-border ml-14 h-px" />
          <SettingsRow
            icon={<BookOpen size={20} color={colors.icon.default} />}
            label="Docs"
            description="Read the documentation"
            onPress={handleDocsPress}
            showChevron={false}
            external
          />
          <View className="bg-border ml-14 h-px" />
          <SettingsRow
            icon={<Globe size={20} color={colors.icon.default} />}
            label="Website"
            description="Visit tracearr.com"
            onPress={handleWebsitePress}
            showChevron={false}
            external
          />
          <View className="bg-border ml-14 h-px" />
          <SettingsRow
            icon={<Code2 size={20} color={colors.icon.default} />}
            label="GitHub"
            description="View source code"
            onPress={handleGithubPress}
            showChevron={false}
            external
          />
          <View className="bg-border ml-14 h-px" />
          <SettingsRow
            icon={<Heart size={20} color="#DB61A2" />}
            label="Sponsor"
            description="Support development"
            onPress={handleSponsorPress}
            showChevron={false}
            external
          />
        </SettingsSection>

        {/* Account */}
        <SettingsSection title="Account">
          <SettingsRow
            icon={<LogOut size={20} color={colors.icon.danger} />}
            label="Disconnect"
            description={server ? `Currently connected to ${server.name}` : undefined}
            onPress={handleDisconnect}
            showChevron={false}
            destructive
          />
        </SettingsSection>

        {/* Spacer to push About to bottom */}
        <View className="min-h-8 flex-1" />

        {/* About - at very bottom */}
        <View className="items-center gap-1 py-6">
          <View className="flex-row items-center gap-2">
            <Info size={16} color={colors.icon.default} />
            <Text className="text-muted-foreground text-xs">Version {appVersion}</Text>
          </View>
          <View className="flex-row items-center gap-2">
            <Server size={16} color={colors.icon.default} />
            <Text className="text-muted-foreground text-xs">Build {buildNumber}</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
