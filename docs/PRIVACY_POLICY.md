# Privacy Policy

**Effective Date: September 2026**

## Introduction

Tracearr is a mobile application designed to help you monitor and manage access to your self-hosted media servers (Plex, Jellyfin, and Emby). We take your privacy seriously and believe in being transparent about how the app works.

**The Short Version:**

- Tracearr connects to YOUR self-hosted backend server
- We never see your media server data, and we don't sell data about you
- All data flows through infrastructure YOU control
- We use a few third-party services: push notifications, crash and performance reports, and product analytics
- No advertising, no ad identifiers, and nothing tied to your name or account

## How Tracearr Works

Tracearr is fundamentally different from most apps because it connects directly to a backend server that **you** host and control. The app acts as a client that:

1. Communicates with your self-hosted Tracearr backend
2. Retrieves data from your media servers through your backend
3. Displays information and sends commands back to your infrastructure

Because you control the backend, you control the data. We never have access to your media server information, user data, or streaming activity.

## Information Collection and Use

### 1. Data Retrieved From Your Self-Hosted Backend

When you use Tracearr, the app retrieves the following information from your self-hosted backend server:

- **Streaming Activity**: Active sessions, usernames, media titles, playback state, progress, and timestamps
- **User Information**: Usernames, profile pictures, trust scores, and user-defined tags
- **Device Information**: Player applications, device types, IP addresses, and platform details
- **Geographic Data**: Location information derived from IP addresses (calculated by your backend)
- **Media Details**: Titles, posters, artwork, and metadata from your media libraries
- **Statistics**: Playback counts, watch time, streaming quality metrics, and historical data
- **Rule Violations**: Detected policy violations such as impossible travel, concurrent streams, and shared account indicators

**Important**: All of this data exists on and is controlled by YOUR self-hosted infrastructure. Tracearr (the app developers) never receives, stores, or has access to any of this information.

### 2. Data Stored Locally on Your Device

The following information is stored locally on your device using platform-standard secure storage:

- **Authentication Tokens**: Access tokens and refresh tokens for your backend (stored in iOS Keychain or Android Keystore)
- **Server Configuration**: Your backend server URL, server name, and server type
- **Device Identifier**: A unique identifier for your device used for push notifications
- **Push Notification Token**: Token used by Expo Push Notification Service to deliver notifications to your device
- **App Preferences**: Your notification preferences, display settings, and app configuration

All credentials and tokens are encrypted using your device's secure storage mechanisms (iOS Keychain on iOS, Android Keystore on Android).

### 3. Device Permissions

Tracearr requests the following permissions for specific functionality:

- **Camera Access**: Used exclusively for scanning QR codes to pair with your backend server. No photos or videos are captured, stored, or transmitted.
- **Local Network Access**: Required to discover and connect to self-hosted servers on your local network.
- **Push Notifications**: Used to receive alerts about streaming activity and rule violations from your backend.
- **Background Refresh**: Allows the app to periodically check for updates when running in the background.

You can revoke these permissions at any time through your device settings. The app will continue to function with limited capabilities if permissions are denied.

## How We Use Information

### Information Used Locally

All data retrieved from your backend is used solely within the app to:

- Display real-time streaming activity and statistics
- Show user profiles and trust scores
- Present rule violations and policy alerts
- Generate charts and analytics visualizations
- Send local notifications based on your configured rules

This information is processed on your device and is never transmitted to Tracearr developers or any third parties.

### Information Sent to Your Backend

The app sends the following information back to YOUR backend server:

- Authentication requests (login, token refresh)
- API requests for data retrieval
- Commands you initiate (e.g., terminating streams, updating user trust scores)
- Your push notification token (so your backend can send you notifications)

## Third-Party Services

Tracearr uses a small number of third-party services:

### Expo Push Notification Service

**Purpose**: Delivers push notifications from your backend to your device
**Data Shared**: Your device's push notification token and the notification content sent by YOUR backend
**Privacy Policy**: [https://expo.dev/privacy](https://expo.dev/privacy)

When your backend triggers a notification, it sends the notification content to Expo's service, which delivers it to your device. Expo may temporarily store notification data for delivery purposes.

### EAS Observe

**Purpose**: Crash and performance reports, so we can find and fix problems in the app
**Data Shared**: App startup and screen load times, screen names with server-side IDs removed, crash and error details, app version, device model and OS version, battery, memory and network conditions, and network request counts and timings, which can include the hostname of your backend. Reports are tied to a random identifier for the app installation, not to your name, account, or media server data.
**Privacy Policy**: [https://expo.dev/privacy](https://expo.dev/privacy)

### PostHog

**Purpose**: Product analytics and error reports, so we can see which parts of the app get used and fix what breaks
**Data Shared**: Screen paths with route parameters stripped out, app lifecycle events (opened, backgrounded), uncaught errors, unhandled promise rejections, and messages the app logs at error level, plus app version and build number, device model, OS version, locale, timezone, and screen size. Reports are tied to a random identifier generated on your device for the app installation. We never call PostHog's identify API, so nothing connects this to a person, an account, or your media server data.
**Region**: United States
**Privacy Policy**: [https://posthog.com/privacy](https://posthog.com/privacy)

### Services We DO NOT Use

Tracearr explicitly does **NOT** use:

- Advertising networks
- Advertising identifiers (no IDFA, no Google Advertising ID)
- Social media SDKs
- Cross-app or cross-site tracking, and no data brokers

## Data Storage and Security

### Local Storage Security

- All authentication credentials are stored using platform-standard secure storage (iOS Keychain, Android Keystore)
- Tokens are encrypted at rest using your device's hardware-backed encryption
- No sensitive data is stored in plain text
- App data is protected by your device's passcode/biometric authentication

### Data Transmission Security

- All communication between the app and your backend uses HTTPS encryption (when properly configured)
- We strongly recommend using valid SSL/TLS certificates on your backend
- Authentication tokens are transmitted securely and expire periodically

### Your Responsibility

Because Tracearr connects to infrastructure YOU control, the security of your data ultimately depends on:

- How you configure and secure your self-hosted backend
- The security practices of your hosting environment
- The strength of your authentication credentials
- Your network security configuration

We provide the tools; you control the security posture.

## Data Sharing and Disclosure

### We Do Not Share Your Data

Your media server data is never shared with anyone, because we never receive it in the first place. The app usage and error reports described above go only to Expo and PostHog, who process them on our behalf and do not use them for their own purposes.

### Exceptions

The only scenario where your data might be disclosed is if:

1. **You choose to share it**: You voluntarily provide information when contacting support
2. **Legal requirement**: If legally required to comply with valid legal processes (though we would have no data to provide)

### Your Backend's Data Practices

Your self-hosted Tracearr backend may have its own data practices depending on how you configure it. Consult your backend's documentation for information about:

- Data retention policies
- Backup and storage practices
- Access controls and logging
- Integration with your media servers

## Children's Privacy

Tracearr is not directed at children under the age of 13, and we do not knowingly collect personal information from children under 13. The app is designed for server administrators and media library managers.

If you believe a child under 13 has provided information through the app, please contact us at contact@tracearr.com. We hold no account or profile data that could identify them.

## Your Rights and Choices

### Data Access and Deletion

Because all your data is stored on infrastructure you control, you have complete authority to:

- Access all data stored by your backend
- Modify or delete any information
- Export your data in any format you choose
- Terminate your use of the service at any time

To delete data from your device:

- Uninstall the Tracearr app to remove all locally stored data
- Delete data from your backend server according to its procedures

### Opt-Out Options

You can:

- Disable push notifications in app settings or device settings
- Revoke camera or local network permissions through device settings
- Disconnect from your backend at any time
- Use the app in a limited capacity without granting certain permissions

## Data Retention

### On Your Device

- Data is retained locally until you log out, uninstall the app, or clear app data
- Authentication tokens expire based on your backend's configuration
- Cache data may be cleared automatically to free up storage

### On Your Backend

Data retention on your self-hosted backend is entirely under your control. Consult your backend's configuration and documentation for retention policies.

## International Data Transfers

Because Tracearr connects to YOUR infrastructure, data location is determined by where you choose to host your backend server. If you host your backend in a specific country, your data remains in that jurisdiction.

The app itself does not transfer data internationally, except for:

- Push notifications routed through Expo's infrastructure (which may involve international data transfer)
- Crash and performance reports sent to EAS Observe
- Product analytics and error reports sent to PostHog, which we use in its United States region

## Changes to This Privacy Policy

We may update this Privacy Policy from time to time to reflect:

- Changes in app functionality
- Changes in legal requirements
- Changes in third-party services we use

When we make changes:

- The "Effective Date" at the top will be updated
- Significant changes will be announced in app release notes
- Continued use of the app after changes constitutes acceptance

We encourage you to review this policy periodically.

## California Privacy Rights (CCPA)

Under the California Consumer Privacy Act (CCPA), California residents have specific rights regarding their personal information.

For clarity:

- We do not sell or share personal information
- We never receive your media server data, account details, or anything that identifies you by name
- The app usage and error data described above is tied to a random per-installation identifier, not to you
- All data from your media servers stays on infrastructure you control

## European Privacy Rights (GDPR)

Under the General Data Protection Regulation (GDPR), European users have specific rights. Tracearr sits on both sides of this, so the two cases are worth separating:

- **Your media server data**: YOU are the data controller. It is processed by your backend, on infrastructure you control, and never reaches us.
- **App usage and error data**: we are the controller for the limited data described above, and Expo and PostHog process it on our behalf. It is tied to a random per-installation identifier, not to you.
- **Legal basis**: our legitimate interest in keeping the app working and fixing what breaks.

To have the app usage and error data for your installation deleted, email contact@tracearr.com. For questions about data on your backend, you should consult your own data practices and legal obligations as the data controller.

## Security Practices

While we implement reasonable security measures in the app's design, we cannot guarantee absolute security. You acknowledge that:

- Internet transmission is never completely secure
- Your backend security depends on your configuration
- You are responsible for protecting your authentication credentials
- You should use strong passwords and enable two-factor authentication if supported

If you discover a security vulnerability in the Tracearr app, please report it to security@tracearr.com.

## Open Source Transparency

Tracearr is committed to transparency. You can:

- Review the app's source code (if open source)
- Audit network requests the app makes
- Inspect the app's behavior using development tools
- Verify that the app operates as described in this policy

## Contact Information

If you have questions, concerns, or requests regarding this Privacy Policy or Tracearr's privacy practices:

**Email**: contact@tracearr.com

**Response Time**: We aim to respond to privacy inquiries within 30 days.

Please note: we hold nothing that identifies you by name, so for most requests there is little for us to look up. We can delete the app usage and error data for your installation on request. For questions about data stored on your self-hosted backend, please consult your backend's documentation.

## Acknowledgment

By using Tracearr, you acknowledge that:

1. You have read and understood this Privacy Policy
2. You understand that Tracearr connects to infrastructure YOU control
3. You are responsible for the security and privacy practices of your self-hosted backend
4. Tracearr developers do not have access to your data
5. You consent to the minimal data practices described in this policy (push notification tokens, crash and performance reports, product analytics and error reports, local storage)

---

**Last Updated**: September 2026

This privacy policy is designed to be transparent and comprehensive. If you have suggestions for improving clarity or addressing additional privacy concerns, please contact us at contact@tracearr.com.
