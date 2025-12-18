# Credentials

This folder contains sensitive credentials for app store submissions.

## Required Files

### Google Play Store

- `google-service-account.json` - Google Cloud service account key for Play Store submissions

To create:

1. Go to Google Cloud Console
2. Create a service account with Google Play Developer API access
3. Download the JSON key file
4. Save it here as `google-service-account.json`

### Apple App Store

Apple credentials are configured in `eas.json` and authenticated via `eas login`.

## Security

These files are gitignored and should NEVER be committed to version control.
