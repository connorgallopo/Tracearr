<p align="center">
  <img src="apps/web/public/images/banner.png" alt="Tracearr" width="600" />
</p>

<p align="center">
  <strong>Know who's streaming. Catch account sharers. Take back control.</strong>
</p>

<p align="center">
  <a href="https://github.com/connorgallopo/Tracearr/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/connorgallopo/Tracearr/ci.yml?branch=main&style=flat-square&label=CI" alt="CI Status" /></a>
  <a href="https://github.com/connorgallopo/Tracearr/actions/workflows/nightly.yml"><img src="https://img.shields.io/github/actions/workflow/status/connorgallopo/Tracearr/nightly.yml?style=flat-square&label=Nightly" alt="Nightly Build" /></a>
  <a href="https://github.com/connorgallopo/Tracearr/releases"><img src="https://img.shields.io/github/v/release/connorgallopo/Tracearr?style=flat-square&color=18D1E7" alt="Latest Release" /></a>
  <a href="https://ghcr.io/connorgallopo/tracearr"><img src="https://img.shields.io/badge/ghcr.io-tracearr-blue?style=flat-square&logo=docker&logoColor=white" alt="Docker" /></a>
  <a href="https://github.com/connorgallopo/Tracearr/blob/main/LICENSE"><img src="https://img.shields.io/github/license/connorgallopo/Tracearr?style=flat-square" alt="License" /></a>
  <a href="https://discord.gg/a7n3sFd2Yw"><img src="https://img.shields.io/discord/1444393247978946684?style=flat-square&logo=discord&logoColor=white&label=Discord&color=5865F2" alt="Discord" /></a>
</p>

---

Tracearr is a streaming access manager for **Plex**, **Jellyfin**, and **Emby** that answers one question: _Who's actually using my server, and are they sharing their login?_

Unlike monitoring tools that just show you data, Tracearr is built to detect account abuse. See streams in real-time, flag suspicious activity automatically, and get notified the moment something looks off.

## What It Does

**Session Tracking** — Full history of who watched what, when, from where, on what device. Every stream logged with geolocation data.

**Sharing Detection** — Five rule types catch account sharers:

- 🚀 **Impossible Travel** — NYC then London 30 minutes later? That's not one person.
- 📍 **Simultaneous Locations** — Same account streaming from two cities at once.
- 🔀 **Device Velocity** — Too many unique IPs in a short window signals shared credentials.
- 📺 **Concurrent Streams** — Set limits per user. Simple but effective.
- 🌍 **Geo Restrictions** — Block streaming from specific countries entirely.

**Real-Time Alerts** — Discord webhooks and custom notifications fire instantly when rules trigger. No waiting for daily reports.

**Stream Map** — Visualize where your streams originate on an interactive world map. Filter by user, server, or time period to zero in on suspicious patterns.

**Trust Scores** — Users earn (or lose) trust based on their behavior. Violations drop scores automatically.

**Multi-Server** — Connect Plex, Jellyfin, and Emby instances to the same dashboard. Manage everything in one place.

**Tautulli Import** — Already using Tautulli? Import your watch history so you don't start from scratch.

## What It Doesn't Do (Yet)

Tracearr v1 is focused on **detection and alerting**. Automated enforcement—killing streams, suspending accounts—is coming in future versions. For now, you see the problems; you decide the action.

## Why Not Tautulli or Jellystat?

[Tautulli](https://github.com/Tautulli/Tautulli) and [Jellystat](https://github.com/CyferShepard/Jellystat) are great monitoring tools. We use Highcharts for graphs too. But they show you what happened—they don't tell you when something's wrong.

|                           | Tautulli | Jellystat | Tracearr |
| ------------------------- | -------- | --------- | -------- |
| Watch history             | ✅       | ✅        | ✅       |
| Statistics & graphs       | ✅       | ✅        | ✅       |
| Session monitoring        | ✅       | ✅        | ✅       |
| Account sharing detection | ❌       | ❌        | ✅       |
| Impossible travel alerts  | ❌       | ❌        | ✅       |
| Trust scoring             | ❌       | ❌        | ✅       |
| Plex support              | ✅       | ❌        | ✅       |
| Jellyfin support          | ❌       | ✅        | ✅       |
| Emby support              | ❌       | ✅        | ✅       |
| Multi-server dashboard    | ❌       | ❌        | ✅       |
| IP geolocation            | ✅       | ✅        | ✅       |
| Import from Tautulli      | —        | ❌        | ✅       |

Tautulli and Jellystat are platform-locked equivalents—Plex-only vs Jellyfin/Emby-only. If you just want stats, they work fine. If you're tired of your brother's roommate's cousin streaming on your dime, that's what Tracearr is for.

## Quick Start

### Option 1: All-in-One (Recommended)

The supervised image bundles TimescaleDB, Redis, and Tracearr in a single container. No external database required. Secrets are auto-generated on first run.

```bash
docker compose -f docker/docker-compose.supervised.yml up -d
```

Open `http://localhost:3000` and connect your Plex, Jellyfin, or Emby server.

### Option 2: Separate Services

If you already have TimescaleDB/PostgreSQL and Redis, or prefer managing services separately:

```bash
# Copy and configure environment
cp docker/.env.example docker/.env
# Edit docker/.env with your secrets (generate with: openssl rand -hex 32)

docker compose -f docker/docker-compose.yml up -d
```

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

### Portainer / Proxmox

For one-click deployment via Portainer or Proxmox, see the ready-to-use compose files in [`docker/examples/`](docker/examples/). These use pre-built images only—no build context required.

### Development Setup

```bash
# Install dependencies (requires pnpm 10+, Node.js 22+)
pnpm install

# Start database services
docker compose -f docker/docker-compose.dev.yml up -d

# Copy and configure environment
cp .env.example .env

# Run migrations
pnpm --filter @tracearr/server db:migrate

# Start dev servers
pnpm dev
```

Frontend runs at `localhost:5173`, API at `localhost:3000`.

## Stack

| Layer     | Tech                                      |
| --------- | ----------------------------------------- |
| Frontend  | React 19, TypeScript, Tailwind, shadcn/ui |
| Charts    | Highcharts                                |
| Maps      | Leaflet                                   |
| Backend   | Node.js, Fastify                          |
| Database  | TimescaleDB (PostgreSQL extension)        |
| Cache     | Redis                                     |
| Real-time | Socket.io                                 |
| Monorepo  | pnpm + Turborepo                          |

**TimescaleDB** handles session history. Regular Postgres works fine until you have a year of watch data and your stats queries start taking forever. TimescaleDB is built for exactly this kind of time-series data—dashboard stats stay fast because they're pre-computed, not recalculated every page load.

**Fastify** over Express because it's measurably faster and the schema validation is nice.

**Plex SSE** — Plex servers stream session updates in real-time via Server-Sent Events. No polling delay, instant detection. Jellyfin and Emby still use polling (they don't support SSE), but Plex sessions appear the moment they start.

## Project Structure

```
tracearr/
├── apps/
│   ├── web/          # React frontend
│   ├── server/       # Fastify backend
│   └── mobile/       # React Native app (coming soon)
├── packages/
│   └── shared/       # Types, schemas, constants
├── docker/           # Compose files
└── docs/             # Documentation
```

## Configuration

Tracearr uses environment variables for configuration. Key settings:

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/tracearr

# Redis
REDIS_URL=redis://localhost:6379

# Security
JWT_SECRET=your-secret-here
COOKIE_SECRET=your-cookie-secret-here

# GeoIP (optional, for location detection)
MAXMIND_LICENSE_KEY=your-maxmind-key
```

See `.env.example` for all options.

## Community

Got questions? Found a bug? Want to contribute?

[![Discord](https://img.shields.io/badge/Discord-Join%20the%20server-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/a7n3sFd2Yw)

Or [open an issue](https://github.com/connorgallopo/Tracearr/issues) on GitHub.

## Contributing

Contributions welcome. Please:

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/thing`)
3. Make your changes
4. Run tests and linting (`pnpm test && pnpm lint`)
5. Open a PR

Check the [issues](https://github.com/connorgallopo/Tracearr/issues) for things to work on.

## Roadmap

**Alpha** (current — v0.1.x)

- [x] Multi-server Plex, Jellyfin, and Emby support
- [x] Session tracking with full history
- [x] 5 sharing detection rules
- [x] Real-time WebSocket updates
- [x] Plex SSE for instant session detection
- [x] Discord + webhook notifications
- [x] Interactive stream map
- [x] Trust scores
- [x] Tautulli history import

**v1.5** (next milestone)

- [ ] Mobile app (iOS & Android) — _in development_
- [ ] Stream termination (kill suspicious streams)
- [ ] Account suspension automation
- [ ] Email notifications
- [ ] Telegram notifier

**v2.0** (future)

- [ ] Tiered access controls
- [ ] Arr integration (Radarr/Sonarr)
- [ ] Multi-admin support

## License

[AGPL-3.0](LICENSE) — Open source with copyleft protection. If you modify Tracearr and offer it as a service, you share your changes.

---

<p align="center">
  <sub>Built because sharing is caring, but not when it's your server bill.</sub>
</p>
