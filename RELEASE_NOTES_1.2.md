# Tracearr v1.2 — First Stable Release

After months of alpha and beta testing, Tracearr is officially stable. Thanks to everyone who's been running the prereleases, reporting bugs, and helping shape this thing.

## What is Tracearr?

Tracearr answers one question: **Who's actually using your media server, and are they sharing their login?**

It's not just another stats dashboard. Tracearr is built specifically to detect account abuse across Plex, Jellyfin, and Emby servers — impossible travel, simultaneous locations, device velocity, you name it.

---

## Highlights

### All-in-One Docker Image

The new `supervised` image bundles everything you need — TimescaleDB, Redis, and Tracearr — in a single container. No external database setup required. Secrets are auto-generated on first run.

```bash
docker pull ghcr.io/connorgallopo/tracearr:supervised
```

Available on [Unraid Community Apps](https://github.com/connorgallopo/tracearr-unraid-template) too.

### Mobile App

iOS and Android companion app with:

- Real-time session monitoring
- Push notifications with quiet hours
- Interactive stream map
- QR code pairing (no manual URL entry)

### Plex Server-Sent Events

Plex sessions appear instantly via SSE — no more polling delays. Fallback to polling if your server doesn't support it.

### Multi-Server Support

Connect all your Plex, Jellyfin, and Emby servers to one install. See everything in one place.

### Dark & Light Mode

Full theme support — switch between dark and light mode based on your preference or system settings.

### Custom Date Filtering

Filter stats and activity by custom date ranges. Pick any start and end date, not just the preset week/month/year options.

---

## Features

### Sharing Detection

- **Impossible Travel** — Same account in NYC then London 30 minutes later? Flagged.
- **Simultaneous Locations** — Streaming from two cities at once? Caught.
- **Device Velocity** — Too many unique IPs in a short window? Suspicious.
- **Concurrent Streams** — Set per-user limits.
- **Geo Restrictions** — Block specific countries entirely.

### Session Tracking

- Full watch history with geolocation
- Device and player info
- Pause duration tracking
- Progress estimation via Plex SSE

### Trust Scores

- Users earn (or lose) trust based on behavior
- Violations automatically drop scores
- Visual trust indicators in the dashboard

### Notifications

- Discord webhooks
- Custom webhook endpoints
- Push notifications to mobile app
- Per-channel routing
- Quiet hours and rate limiting

### Import & Migration

- Tautulli history import — don't start from scratch
- Bring your existing watch data

### Stream Map

- Interactive world map showing stream origins
- Filter by user, server, or time period
- Spot geographic anomalies at a glance

---

## Docker Tags

| Tag                | Description                                 |
| ------------------ | ------------------------------------------- |
| `latest`           | Stable release (requires external DB/Redis) |
| `supervised`       | **All-in-one stable** — just works          |
| `1.2.0`            | This specific version                       |
| `supervised-1.2.0` | This specific version (all-in-one)          |

---

## What's New Since Beta

- **Supervised image improvements** — non-root user, log rotation, timezone support, boot loop fixes
- **Better Unraid support** — auto-creates directories, handles corrupt data gracefully
- **Removed dead code** — cleaned up unused TimescaleDB aggregates
- **Mobile navigation** — proper tab navigation after first-time pairing

---

## What's Next

- Stream termination (kill suspicious sessions remotely)
- Account suspension automation
- Email and Telegram notifications
- Multi-admin support

---

## Links

- [Documentation](https://github.com/connorgallopo/Tracearr#readme)
- [Discord](https://discord.gg/a7n3sFd2Yw)
- [Report Issues](https://github.com/connorgallopo/Tracearr/issues)
- Mobile apps coming to App Store and Play Store

---

Built because sharing is caring — but not when it's your server bill.
