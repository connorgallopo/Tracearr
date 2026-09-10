<p align="center">
  <img src="apps/web/public/images/og_image.png" alt="Tracearr" width="600" />
</p>

<p align="center">
  <strong>Real-time monitoring for Plex, Jellyfin, and Emby. One dashboard for all your servers.</strong>
</p>

<p align="center">
  <a href="https://github.com/connorgallopo/Tracearr/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/connorgallopo/Tracearr/ci.yml?branch=main&style=flat-square&label=CI" alt="CI Status" /></a>
  <a href="https://github.com/connorgallopo/Tracearr/actions/workflows/nightly.yml"><img src="https://img.shields.io/github/actions/workflow/status/connorgallopo/Tracearr/nightly.yml?style=flat-square&label=Nightly" alt="Nightly Build" /></a>
  <a href="https://snyk.io/test/github/connorgallopo/Tracearr"><img src="https://snyk.io/test/github/connorgallopo/Tracearr/badge.svg" alt="Snyk Security" /></a>
  <a href="https://github.com/connorgallopo/Tracearr/releases"><img src="https://img.shields.io/github/v/release/connorgallopo/Tracearr?style=flat-square&color=18D1E7" alt="Latest Release" /></a>
  <a href="https://ghcr.io/connorgallopo/tracearr"><img src="https://img.shields.io/badge/ghcr.io-tracearr-blue?style=flat-square&logo=docker&logoColor=white" alt="Docker" /></a>
  <a href="https://github.com/connorgallopo/Tracearr/blob/main/LICENSE"><img src="https://img.shields.io/github/license/connorgallopo/Tracearr?style=flat-square" alt="License" /></a>
  <a title="Crowdin" target="_blank" href="https://crowdin.com/project/tracearr"><img src="https://badges.crowdin.net/tracearr/localized.svg"></a>
  <a href="https://docs.tracearr.com"><img src="https://img.shields.io/badge/docs-tracearr.com-18D1E7?style=flat-square" alt="Documentation" /></a>
  <a href="https://discord.gg/a7n3sFd2Yw"><img src="https://img.shields.io/discord/1444393247978946684?style=flat-square&logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord" /></a>
  <a href="https://ko-fi.com/E1E21QRI1L"><img src="https://img.shields.io/badge/Ko--fi-Support-FF5E5B?style=flat-square&logo=kofi&logoColor=white" alt="Ko-Fi" /></a>
</p>

---

Tracearr is a monitoring platform for **Plex**, **Jellyfin**, and **Emby**. Track streams in real-time, dig into playback analytics, browse one catalog across every server, and spot account sharing before it gets out of hand.

Screenshots and the feature tour are at [tracearr.com](https://tracearr.com), the manual at [docs.tracearr.com](https://docs.tracearr.com). Both are updated with every release. This file is the short version.

## What It Does

**Multi-Server Dashboard** - Connect Plex, Jellyfin, and Emby to a single interface. Active streams, server health, and per-server CPU, memory, and bandwidth charts sit on one page. Plex reports its own numbers; Jellyfin and Emby report theirs through the [Tracearr SSE plugin](https://github.com/Tracearr/Media-Server-SSE).

**Session Tracking** - Complete session history: who watched what, when, where, and on what device. Every stream includes geolocation data with ASN, continent, and postal code.

**Stream Analytics** - See what's transcoding vs direct playing, track bandwidth usage, and see what people watch. Codec breakdowns, resolution stats, device compatibility scores.

**One Person, Many Accounts** - Someone with a Plex login and a Jellyfin login is one identity here. Merge duplicates by hand or take the suggestions, and split them again if you get it wrong. An identity's trust score is the worst of its active accounts, so merging never hides a problem.

**Media Catalog** - One record per title, matched across servers by IMDb, TMDB, or TVDB id, with each server's copies attached. Six pages sit under Media:

- **Overview** - Library stat cards, growth over time, recently added and most popular shelves, and a Dead Weight list of never-watched titles.
- **Browse** - A poster grid over the whole catalog, filtered by type, server, library, genre, resolution, dynamic range, watched state, year, or file size.
- **Genres** - Plays and watch time by genre, across every server in view.
- **Quality** - Resolution and codec distribution. Track how your 4K vs 1080p ratio changes.
- **Storage** - Usage predictions, duplicate detection across servers, stale content, and ROI analysis (watch hours per GB).
- **Watch** - Engagement metrics, completion rates, viewing patterns by hour and month, binge detection.

**Live TV & Music** - Track live TV sessions and music playback alongside movies and shows.

**Stream Map** - Where your streams come from, on a world map you host yourself. The vector basemap ships inside the container, so there are no tile keys and no requests to a third-party tile service.

**Automations** - A trigger fires, conditions decide whether it matters, actions run. Eighteen triggers cover sessions, accounts, library changes, server health, update availability, and newsletter results. Actions send a notification, adjust trust, message the client, or stop the stream, and an `if` action branches on conditions. Twenty-two templates ship built in, among them impossible travel, too many streams at once, simultaneous locations, device velocity, geo restrictions, account inactivity, no 4K transcodes, and stop paused streams. Any automation exports to a share code another instance can paste in.

**Trust Scores** - Every account starts at 100. Violations lower it, an automation can adjust, set, or reset it, and an identity's score is the lowest of its active accounts.

**Destinations** - Discord, generic JSON webhook, ntfy, Gotify, Apprise, Pushover, email over SMTP, mobile push, and a toast in the web UI.

**Newsletters** - Mail your members what was added: movies, shows with their new seasons, albums, and optionally what got watched most. Per server, on a daily, weekly, monthly, or cron schedule, with a window that picks up where the last email stopped. Addresses come from a contact email you set, their Tracearr login, or their Plex account. Every email carries an unsubscribe link and a view-in-browser link, and each send lands in a history tab with per-recipient status and retry.

**Public API** - Key-authenticated REST API for third-party integrations, v1 and v2. Generate a key under Settings, then read the [API reference](https://docs.tracearr.com/api) or the interactive Scalar page at `/api-docs` on your own instance.

**Bulk Actions** - Multi-select operations across tables. Acknowledge or dismiss violations in bulk, reset trust scores, delete session history.

**Data Import** - Bring history with you: Tautulli, a Jellystat backup file, or the Playback Reporting plugin read straight from Jellyfin or Emby.

## Why Tracearr?

Tautulli only works with Plex. Jellystat only works with Jellyfin and Emby. If you run multiple servers, you're stuck with multiple dashboards.

Tracearr handles all three. One install, one interface.

|                                | Tautulli | Jellystat | Tracearr |
| ------------------------------ | -------- | --------- | -------- |
| Watch history                  | ✅       | ✅        | ✅       |
| Statistics & graphs            | ✅       | ✅        | ✅       |
| Session monitoring             | ✅       | ✅        | ✅       |
| Transcode analytics            | ✅       | ✅        | ✅       |
| Live TV & Music                | ✅       | ✅        | ✅       |
| Account sharing detection      | ❌       | ❌        | ✅       |
| Impossible travel alerts       | ❌       | ❌        | ✅       |
| Trust scoring                  | ❌       | ❌        | ✅       |
| Plex support                   | ✅       | ❌        | ✅       |
| Jellyfin support               | ❌       | ✅        | ✅       |
| Emby support                   | ❌       | ✅        | ✅       |
| Multi-server dashboard         | ❌       | ❌        | ✅       |
| Cross-server user identities   | ❌       | ❌        | ✅       |
| Cross-server media catalog     | ❌       | ❌        | ✅       |
| Cross-server duplicate finding | ❌       | ❌        | ✅       |
| IP geolocation                 | ✅       | ✅        | ✅       |
| Library analytics              | ✅       | ✅        | ✅       |
| Public API                     | ✅       | ✅        | ✅       |
| Newsletters                    | ✅       | ❌        | ✅       |
| Import from Tautulli           | -        | ❌        | ✅       |
| Import from Jellystat          | ❌       | -         | ✅       |

## Quick Start

```bash
# Download compose file
curl -O https://raw.githubusercontent.com/connorgallopo/Tracearr/main/docker/examples/docker-compose.pg18.yml

# Generate secrets
echo "JWT_SECRET=$(openssl rand -hex 32)" > .env
echo "COOKIE_SECRET=$(openssl rand -hex 32)" >> .env

# Deploy
docker compose -f docker-compose.pg18.yml up -d
```

Open `http://localhost:3000` and connect your Plex, Jellyfin, or Emby server.

**Unraid users:** The supervised image bundles the app, TimescaleDB, and Redis in one container and generates its own secrets on first boot. See [docker/examples](docker/examples/README.md) for details.

For Portainer deployment, alternative configurations, or detailed requirements, see the [Docker deployment guide](docker/examples/README.md). For full documentation, visit [docs.tracearr.com](https://docs.tracearr.com).

### Docker Tags

| Tag                  | Description                                        |
| -------------------- | -------------------------------------------------- |
| `latest`             | Stable release (requires external DB/Redis)        |
| `supervised`         | All-in-one stable release                          |
| `next`               | Latest prerelease (requires external DB/Redis)     |
| `supervised-next`    | All-in-one prerelease                              |
| `nightly`            | Bleeding edge nightly (requires external DB/Redis) |
| `supervised-nightly` | All-in-one nightly build                           |

```bash
# All-in-one (easiest)
docker pull ghcr.io/connorgallopo/tracearr:supervised

# Stable (requires external services)
docker pull ghcr.io/connorgallopo/tracearr:latest

# Living on the edge
docker pull ghcr.io/connorgallopo/tracearr:nightly
```

### Viewing Logs

**Standard Docker** - Each service runs in its own container:

```bash
docker logs tracearr          # Application logs
docker logs tracearr-postgres # Database logs
docker logs tracearr-redis    # Cache logs
```

**Supervised Docker** - All services run in one container. View logs in the web UI at `/debug` (Log Explorer section), or via CLI:

```bash
docker exec tracearr cat /var/log/supervisor/tracearr-error.log
```

Available log files: `tracearr.log`, `tracearr-error.log`, `postgres.log`, `postgres-error.log`, `redis.log`, `redis-error.log`, `supervisord.log`

Set `LOG_LEVEL=debug` for verbose output.

**Proxmox VE LXC** - Each service runs as a systemd unit:

```bash
journalctl -u tracearr   # Application logs
journalctl -u postgresql # Database logs
journalctl -u redis      # Cache logs
```

### Development Setup

```bash
# Install dependencies (requires pnpm 12+, Node.js 22.22.2+)
pnpm install

# Start database services
docker compose -f docker/docker-compose.dev.yml up -d
# Includes Mailpit for email testing: SMTP on 1025, inbox at http://localhost:8025

# Copy and configure environment
cp .env.example .env

# Run migrations
pnpm --filter @tracearr/server db:migrate

# Start dev servers
pnpm dev
```

Frontend runs at `localhost:5173`, API at `localhost:3000`.

## Stack

| Layer      | Tech                                                      |
| ---------- | --------------------------------------------------------- |
| Frontend   | React 19, TypeScript 7, Vite 8, Tailwind CSS 4, shadcn/ui |
| Data layer | TanStack Query, TanStack Table                            |
| Charts     | Highcharts 13                                             |
| Maps       | MapLibre GL 6 over self-hosted PMTiles                    |
| Backend    | Node.js 22, Fastify 5                                     |
| Database   | TimescaleDB (PostgreSQL extension), Drizzle ORM           |
| Jobs       | Redis and BullMQ                                          |
| Real-time  | Socket.io                                                 |
| Email      | React Email, SMTP through Nodemailer                      |
| Monorepo   | pnpm 12, Turborepo, oxlint, Vitest                        |

**TimescaleDB** handles session history. Regular Postgres works for a few months, but long query histories kill performance. TimescaleDB is built for time-series data, so dashboard stats stay fast: they're pre-computed, not recalculated every page load.

**Fastify** over Express because it's measurably faster and schema validation catches bad requests before they hit handlers.

**MapLibre with a bundled PMTiles basemap** replaces the old raster tiles. The archive ships in the image, so the map works on an instance with no outbound internet access.

**SSE for instant sessions** - Plex streams session updates in real-time via Server-Sent Events, so streams appear the moment they start. Jellyfin and Emby get the same through the [Tracearr SSE plugin](https://github.com/Tracearr/Media-Server-SSE); without it they fall back to polling.

## Project Structure

```
tracearr/
├── apps/
│   ├── e2e/          # End-to-end suite
│   ├── server/       # Fastify API, BullMQ workers, Drizzle/TimescaleDB
│   └── web/          # React dashboard
├── packages/
│   ├── emails/       # React Email templates rendered by the server
│   ├── shared/       # Types, Zod schemas, constants
│   ├── test-utils/   # Factories, mocks, custom matchers
│   └── translations/ # i18n strings
├── docker/           # Compose files and images
└── docs/             # Documentation
```

The Expo app is not in this repo. It lives at [Tracearr/Mobile-App](https://github.com/Tracearr/Mobile-App) and consumes `@tracearr/shared` and `@tracearr/translations` as published packages.

## Community

Got questions? Found a bug? Want to contribute? Check [docs.tracearr.com](https://docs.tracearr.com) first, then:

[![Discord](https://img.shields.io/badge/Discord-Join%20the%20server-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/a7n3sFd2Yw)

Or [open an issue](https://github.com/connorgallopo/Tracearr/issues) on GitHub.

## Contributing

Every change starts as an issue or a [Discussion](https://github.com/connorgallopo/Tracearr/discussions) before any code is written. A maintainer labels it `planned` or `help wanted`, vouches for your account with `!vouch`, and only then does a pull request stay open. A PR with no agreed issue behind it is closed regardless of the code, and so is one from an unvouched account. Documentation-only fixes are the one exception to the discussion step.

AI tools are fine to use; you still have to be able to explain and change every line, and significant AI usage goes in the PR template. Submissions from autonomous agents are closed. [CONTRIBUTING.md](CONTRIBUTING.md) has the full rules, the PR checklist, and the testing commands.

### Development with VS Code

Use the included `.vscode/launch.json` to debug both server and web apps directly from VS Code.

Run `pnpm dev` in a terminal to start both apps, then use the "Debug All" configuration to attach the debugger.

## Roadmap

**Shipped**

- [x] Multi-server Plex, Jellyfin, and Emby support
- [x] Session tracking with full history
- [x] Automations: triggers, conditions, actions, and 22 built-in templates
- [x] Share codes for exporting and importing an automation
- [x] Nine destination kinds, including email over SMTP and mobile push
- [x] Newsletters with schedules, per-recipient send history, and unsubscribe
- [x] Cross-server identities with merge, split, and worst-account trust
- [x] Media catalog: overview, browse, genres, quality, storage, watch
- [x] Real-time WebSocket updates
- [x] SSE for instant session detection (Plex built-in, Jellyfin/Emby via plugin)
- [x] Live server CPU, memory, and bandwidth charts
- [x] Self-hosted stream map (MapLibre + PMTiles, no tile keys)
- [x] Trust scores
- [x] Tautulli, Jellystat, and Playback Reporting history import
- [x] Transcode analytics & device compatibility
- [x] Live TV & music tracking
- [x] Stream quality metrics (codec, resolution, bitrate)
- [x] Stream termination
- [x] Public REST API v1 and v2 with an interactive Scalar reference
- [x] Bulk actions for violations, users, and sessions
- [x] Enhanced IP geolocation (ASN, continent, postal code)
- [x] Mobile app - [iOS](https://apps.apple.com/us/app/tracearr/id6755941553) and [Android](https://play.google.com/store/apps/details?id=com.tracearr.mobile)

**Coming soon**

- [ ] Tiered access controls

## Project Statistics

<p align="center">
  <img
    src="https://repobeats.axiom.co/api/embed/4632d7f3bb419e78c5525af0905a488d9f72a753.svg"
    alt="Repobeats analytics"
  />
</p>

## Star History

<a href="https://www.star-history.com/?repos=connorgallopo%2FTracearr&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=connorgallopo/Tracearr&type=date&theme=dark&legend=top-left&sealed_token=gqNERdnUn6ObeSY81Y6zP40vLBLudEzd1HRVmVfMCjaDrF-MPIll0_KXFkm0b36agZvr6RxkGRX_2xeM81kTqylKJN4i8IpTj9RIq9oLT7AxiBYGK0Zrr2IZR0sQpGHAvmnQP0KtQaN03rFdvuUf6ce-MVOZ7XQ7tpf3UGbabcegW5GUP97_aQso0cq3" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=connorgallopo/Tracearr&type=date&legend=top-left&sealed_token=gqNERdnUn6ObeSY81Y6zP40vLBLudEzd1HRVmVfMCjaDrF-MPIll0_KXFkm0b36agZvr6RxkGRX_2xeM81kTqylKJN4i8IpTj9RIq9oLT7AxiBYGK0Zrr2IZR0sQpGHAvmnQP0KtQaN03rFdvuUf6ce-MVOZ7XQ7tpf3UGbabcegW5GUP97_aQso0cq3" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=connorgallopo/Tracearr&type=date&legend=top-left&sealed_token=gqNERdnUn6ObeSY81Y6zP40vLBLudEzd1HRVmVfMCjaDrF-MPIll0_KXFkm0b36agZvr6RxkGRX_2xeM81kTqylKJN4i8IpTj9RIq9oLT7AxiBYGK0Zrr2IZR0sQpGHAvmnQP0KtQaN03rFdvuUf6ce-MVOZ7XQ7tpf3UGbabcegW5GUP97_aQso0cq3" />
 </picture>
</a>

## License

[AGPL-3.0](LICENSE) - Open source with copyleft protection. If you modify Tracearr and offer it as a service, you share your changes.

This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com.

---

<p align="center">
  <sub>For Plex, Jellyfin, and Emby admins who want to see what's actually happening.</sub>
</p>

This project is tested with BrowserStack.
