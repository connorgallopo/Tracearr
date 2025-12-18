/**
 * Pairing screen - QR code scanner or manual entry
 * Supports both initial pairing and adding additional servers
 */
import { useState, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { ChevronLeft } from 'lucide-react-native';
import { useAuthStore } from '@/lib/authStore';
import { colors, spacing, borderRadius, typography } from '@/lib/theme';

interface QRPairingPayload {
  url: string;
  token: string;
}

export default function PairScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [manualMode, setManualMode] = useState(false);
  const [serverUrl, setServerUrl] = useState('');
  const [token, setToken] = useState('');
  const [scanned, setScanned] = useState(false);
  const scanLockRef = useRef(false); // Synchronous lock to prevent race conditions

  const { addServer, isAuthenticated, servers, isLoading, error, clearError } = useAuthStore();

  // Check if this is adding an additional server vs first-time pairing
  const isAddingServer = isAuthenticated && servers.length > 0;

  const handleBarCodeScanned = async ({ data }: { data: string }) => {
    // Use ref for synchronous check - state updates are async and cause race conditions
    if (scanLockRef.current || isLoading) return;
    scanLockRef.current = true; // Immediate synchronous lock
    setScanned(true);

    try {
      // Parse tracearr://pair?data=<base64>
      // First check if it even looks like our URL format
      if (!data.startsWith('tracearr://pair')) {
        // Silently ignore non-Tracearr QR codes (don't spam alerts)
        setTimeout(() => {
          scanLockRef.current = false;
          setScanned(false);
        }, 2000);
        return;
      }

      const url = new URL(data);
      const base64Data = url.searchParams.get('data');
      if (!base64Data) {
        throw new Error('Invalid QR code: missing pairing data');
      }

      // Decode and parse payload with proper error handling
      let payload: QRPairingPayload;
      try {
        const decoded = atob(base64Data);
        payload = JSON.parse(decoded) as QRPairingPayload;
      } catch {
        throw new Error('Invalid QR code format. Please generate a new code.');
      }

      // Validate payload has required fields
      if (!payload.url || typeof payload.url !== 'string') {
        throw new Error('Invalid QR code: missing server URL');
      }
      if (!payload.token || typeof payload.token !== 'string') {
        throw new Error('Invalid QR code: missing pairing token');
      }

      // Validate URL format
      if (!payload.url.startsWith('http://') && !payload.url.startsWith('https://')) {
        throw new Error('Invalid server URL in QR code');
      }

      await addServer(payload.url, payload.token);

      // Navigate to tabs after successful pairing
      router.replace('/(tabs)');
    } catch (err) {
      Alert.alert('Pairing Failed', err instanceof Error ? err.message : 'Invalid QR code');
      // Add cooldown before allowing another scan
      setTimeout(() => {
        scanLockRef.current = false;
        setScanned(false);
      }, 3000);
    }
  };

  const handleManualPair = async () => {
    if (!serverUrl.trim() || !token.trim()) {
      Alert.alert('Missing Fields', 'Please enter both server URL and token');
      return;
    }

    const trimmedUrl = serverUrl.trim();

    // Validate URL format
    if (!trimmedUrl.startsWith('http://') && !trimmedUrl.startsWith('https://')) {
      Alert.alert('Invalid URL', 'Server URL must start with http:// or https://');
      return;
    }

    // Validate URL is well-formed
    try {
      new URL(trimmedUrl);
    } catch {
      Alert.alert('Invalid URL', 'Please enter a valid server URL');
      return;
    }

    clearError();
    try {
      await addServer(trimmedUrl, token.trim());

      // Navigate to tabs after successful pairing
      router.replace('/(tabs)');
    } catch {
      // Error is handled by the store
    }
  };

  const handleBack = () => {
    router.back();
  };

  if (manualMode) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.keyboardView}
        >
          <ScrollView contentContainerStyle={styles.scrollContent}>
            {/* Back button for adding servers */}
            {isAddingServer && (
              <Pressable style={styles.backButton} onPress={handleBack}>
                <ChevronLeft size={24} color={colors.text.primary.dark} />
                <Text style={styles.backText}>Back</Text>
              </Pressable>
            )}

            <View style={styles.header}>
              <Text style={styles.title}>
                {isAddingServer ? 'Add Server' : 'Connect to Server'}
              </Text>
              <Text style={styles.subtitle}>
                Enter your Tracearr server URL and mobile access token
              </Text>
            </View>

            <View style={styles.form}>
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Server URL</Text>
                <TextInput
                  style={styles.input}
                  value={serverUrl}
                  onChangeText={setServerUrl}
                  placeholder="https://tracearr.example.com"
                  placeholderTextColor={colors.text.muted.dark}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  editable={!isLoading}
                />
              </View>

              <View style={styles.inputGroup}>
                <Text style={styles.label}>Access Token</Text>
                <TextInput
                  style={styles.input}
                  value={token}
                  onChangeText={setToken}
                  placeholder="trr_mob_..."
                  placeholderTextColor={colors.text.muted.dark}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  editable={!isLoading}
                />
              </View>

              {error && <Text style={styles.errorText}>{error}</Text>}

              <Pressable
                style={[styles.button, isLoading && styles.buttonDisabled]}
                onPress={handleManualPair}
                disabled={isLoading}
              >
                <Text style={styles.buttonText}>{isLoading ? 'Connecting...' : 'Connect'}</Text>
              </Pressable>

              <Pressable
                style={styles.linkButton}
                onPress={() => setManualMode(false)}
                disabled={isLoading}
              >
                <Text style={styles.linkText}>Scan QR Code Instead</Text>
              </Pressable>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Back button for adding servers */}
      {isAddingServer && (
        <Pressable style={styles.backButton} onPress={handleBack}>
          <ChevronLeft size={24} color={colors.text.primary.dark} />
          <Text style={styles.backText}>Back</Text>
        </Pressable>
      )}

      <View style={styles.header}>
        <Text style={styles.title}>{isAddingServer ? 'Add Server' : 'Welcome to Tracearr'}</Text>
        <Text style={styles.subtitle}>
          Open Settings → Mobile App in your Tracearr dashboard and scan the QR code
        </Text>
      </View>

      <View style={styles.cameraContainer}>
        {permission?.granted ? (
          <CameraView
            style={styles.camera}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
          >
            <View style={styles.overlay}>
              <View style={styles.scanFrame} />
            </View>
          </CameraView>
        ) : (
          <View style={styles.permissionContainer}>
            <Text style={styles.permissionText}>
              Camera permission is required to scan QR codes
            </Text>
            <Pressable style={styles.button} onPress={requestPermission}>
              <Text style={styles.buttonText}>Grant Permission</Text>
            </Pressable>
          </View>
        )}
      </View>

      <View style={styles.footer}>
        <Pressable style={styles.linkButton} onPress={() => setManualMode(true)}>
          <Text style={styles.linkText}>Enter URL and Token Manually</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background.dark,
  },
  keyboardView: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    padding: spacing.lg,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    marginTop: spacing.sm,
  },
  backText: {
    fontSize: typography.fontSize.base,
    color: colors.text.primary.dark,
    marginLeft: spacing.xs,
  },
  header: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xl,
    paddingBottom: spacing.lg,
    alignItems: 'center',
  },
  title: {
    fontSize: typography.fontSize['2xl'],
    fontWeight: 'bold',
    color: colors.text.primary.dark,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: typography.fontSize.base,
    color: colors.text.secondary.dark,
    textAlign: 'center',
    lineHeight: 22,
  },
  cameraContainer: {
    flex: 1,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.lg,
    borderRadius: borderRadius.xl,
    overflow: 'hidden',
    backgroundColor: colors.card.dark,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  scanFrame: {
    width: 250,
    height: 250,
    borderWidth: 2,
    borderColor: colors.cyan.core,
    borderRadius: borderRadius.lg,
    backgroundColor: 'transparent',
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  permissionText: {
    fontSize: typography.fontSize.base,
    color: colors.text.secondary.dark,
    textAlign: 'center',
    marginBottom: spacing.lg,
  },
  footer: {
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    alignItems: 'center',
  },
  form: {
    flex: 1,
    gap: spacing.md,
  },
  inputGroup: {
    gap: spacing.xs,
  },
  label: {
    fontSize: typography.fontSize.sm,
    fontWeight: '500',
    color: colors.text.secondary.dark,
  },
  input: {
    backgroundColor: colors.card.dark,
    borderWidth: 1,
    borderColor: colors.border.dark,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    fontSize: typography.fontSize.base,
    color: colors.text.primary.dark,
  },
  button: {
    backgroundColor: colors.cyan.core,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: borderRadius.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: typography.fontSize.base,
    fontWeight: '600',
    color: colors.blue.core,
  },
  linkButton: {
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  linkText: {
    fontSize: typography.fontSize.base,
    color: colors.cyan.core,
  },
  errorText: {
    fontSize: typography.fontSize.sm,
    color: colors.error,
    textAlign: 'center',
  },
});
