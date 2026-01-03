# Tracearr Mobile App

## Local Android Build (Bypassing EAS)

When EAS build quotas are exhausted or you need a quick local build:

### Prerequisites

1. **Java 17**

   ```bash
   sudo apt install openjdk-17-jdk
   ```

2. **Android SDK** (install to ~/android-sdk or similar)

   ```bash
   # Download command line tools from https://developer.android.com/studio#command-line-tools-only
   # Extract and install required components:
   sdkmanager "platforms;android-36" "build-tools;36.0.0" "build-tools;35.0.0" "ndk;27.1.12297006"
   sdkmanager --licenses
   ```

3. **local.properties** in `android/` directory:

   ```properties
   sdk.dir=/home/cgallopo/android-sdk
   ```

4. **EAS Keystore** (for release signing):
   ```bash
   cd apps/mobile
   eas credentials -p android
   # Select: Download credentials from EAS to credentials.json
   # This creates:
   #   - credentials.json (contains passwords and alias)
   #   - credentials/android/keystore.jks
   ```

### Build Commands

```bash
cd apps/mobile/android

# Release AAB (for Play Store)
./gradlew bundleRelease --no-daemon

# Output: app/build/outputs/bundle/release/app-release.aab
```

### Verify Signing

```bash
keytool -printcert -jarfile app/build/outputs/bundle/release/app-release.aab
```

Expected SHA1 fingerprint for Play Store: `D2:31:BD:E6:87:95:C7:72:33:91:16:47:6E:BE:52:F1:EC:B1:51:7F`

### Signing Configuration

The `android/app/build.gradle` has a release signing config that:

- Looks for keystore at `credentials/android/keystore.jks`
- Falls back to environment variables: `KEYSTORE_PASSWORD`, `KEY_ALIAS`, `KEY_PASSWORD`
- Falls back to hardcoded values from EAS credentials (for local dev only)

### Version Management

Update version in `android/app/build.gradle`:

- `versionCode` - increment for each Play Store upload
- `versionName` - semantic version string

## Google Maps API Key

Android requires a Google Maps API key configured in:

- `app.config.js` - injects from `GOOGLE_MAPS_API_KEY` env var
- GitHub secrets for CI builds

API key restrictions in Google Cloud Console:

- Package name: `com.tracearr.app`
- SHA-1 fingerprint: `D2:31:BD:E6:87:95:C7:72:33:91:16:47:6E:BE:52:F1:EC:B1:51:7F`

## Common Issues

### Build fails with missing SDK components

Run `sdkmanager` to install missing components listed in error message.

### Wrong signing key error from Play Store

Ensure EAS keystore is downloaded and `credentials/android/keystore.jks` exists.

### ANDROID_HOME not found

Create `android/local.properties` with `sdk.dir=/path/to/android-sdk`
