<p align="center">
  <img src="apps/web/public/images/banner.png" alt="Tracearr" width="600" />
</p>

<p align="center">
  <strong>Real-time monitoring for Plex, Jellyfin, and Emby. One dashboard for all your servers.</strong>
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

Tracearr is a monitoring platform for **Plex**, **Jellyfin**, and **Emby**. Track streams in real-time, dig into playback analytics, and spot account sharing before it gets out of hand.

## What It Does

**Multi-Server Dashboard** — Connect Plex, Jellyfin, and Emby to a single interface. No more switching between apps.

**Session Tracking** — Complete session history: who watched what, when, where, and on what device. Every stream includes geolocation data.

**Stream Analytics** — See what's transcoding vs direct playing, track bandwidth usage, and see what people actually watch. Codec breakdowns, resolution stats, device compatibility scores.

**Live TV & Music** — Not just movies and shows. Track live TV sessions and music playback across all your servers.

**Stream Map** — Visualize where your streams originate on a world map. Filter by user, server, or time period.

**Sharing Detection** — Five rule types flag suspicious activity:

- **Impossible Travel** — NYC then London 30 minutes later? That's not one person.
- **Simultaneous Locations** — Same account streaming from two cities at once.
- **Device Velocity** — Too many unique IPs in a short window signals shared credentials.
- **Concurrent Streams** — Set limits per user.
- **Geo Restrictions** — Block streaming from specific countries.

**Trust Scores** — Users earn (or lose) trust based on behavior. Violations drop scores automatically.

**Real-Time Alerts** — Discord webhooks and custom notifications fire instantly when rules trigger.

**Data Import** — Already using Tautulli or Jellystat? Import your watch history so you don't start from scratch.

## Why Tracearr?

Tautulli only works with Plex. Jellystat only works with Jellyfin and Emby. If you run multiple servers, you're stuck with multiple dashboards.

Tracearr handles all three. One install, one interface.

|                           | Tautulli | Jellystat | Tracearr |
| ------------------------- | -------- | --------- | -------- |
| Watch history             | ✅       | ✅        | ✅       |
| Statistics & graphs       | ✅       | ✅        | ✅       |
| Session monitoring        | ✅       | ✅        | ✅       |
| Transcode analytics       | ✅       | ✅        | ✅       |
| Live TV & Music           | ✅       | ✅        | ✅       |
| Account sharing detection | ❌       | ❌        | ✅       |
| Impossible travel alerts  | ❌       | ❌        | ✅       |
| Trust scoring             | ❌       | ❌        | ✅       |
| Plex support              | ✅       | ❌        | ✅       |
| Jellyfin support          | ❌       | ✅        | ✅       |
| Emby support              | ❌       | ✅        | ✅       |
| Multi-server dashboard    | ❌       | ❌        | ✅       |
| IP geolocation            | ✅       | ✅        | ✅       |
| Import from Tautulli      | —        | ❌        | ✅       |
| Import from Jellystat     | ❌       | —         | ✅       |

## Quick Start

The supervised image bundles TimescaleDB, Redis, and Tracearr in a single container. Requires 2GB+ RAM. Secrets are auto-generated on first run.

```bash
docker compose -f docker/examples/docker-compose.supervised-example.yml up -d
```

Open `http://localhost:3000` and connect your Plex, Jellyfin, or Emby server.

For separate services, Portainer deployment, or detailed requirements, see the [Docker deployment guide](docker/examples/README.md).

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

**TimescaleDB** handles session history. Regular Postgres works for a few months, but long query histories kill performance. TimescaleDB is built for time-series data—dashboard stats stay fast because they're pre-computed, not recalculated every page load.

**Fastify** over Express because it's measurably faster and schema validation catches bad requests before they hit handlers.

**Plex SSE** — Plex servers stream session updates in real-time via Server-Sent Events. No polling delay, instant detection. Jellyfin and Emby still use polling (they don't support SSE), but Plex sessions appear the moment they start.

## Project Structure

```
tracearr/
├── apps/
│   ├── web/          # React frontend
│   ├── server/       # Fastify backend
│   └── mobile/       # React Native app (coming soon)
├── packages/
│   ├── shared/       # Types, schemas, constants
│   └── translations/ # i18n support
├── docker/           # Compose files
└── docs/             # Documentation
```

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

### Development with VS Code

Use the included `.vscode/launch.json` to debug both server and web apps directly from VS Code.

Run `pnpm dev` in a terminal to start both apps, then use the "Debug All" configuration to attach the debugger.

## Roadmap

**v1.4** (current)

- [x] Multi-server Plex, Jellyfin, and Emby support
- [x] Session tracking with full history
- [x] Sharing detection rules
- [x] Real-time WebSocket updates
- [x] Plex SSE for instant session detection
- [x] Discord + webhook notifications
- [x] Interactive stream map
- [x] Trust scores
- [x] Tautulli & Jellystat history import
- [x] Transcode analytics & device compatibility
- [x] Live TV & music tracking
- [x] Stream quality metrics (codec, resolution, bitrate)
- [x] Stream termination

**v1.5** (next)

- [ ] Mobile app (iOS & Android) — _in beta_
- [ ] Rule based automated stream termination
- [ ] Account suspension automation
- [ ] Email notifications
- [ ] Telegram notifier

**v2.0** (future)

- [ ] Tiered access controls
- [ ] Multi-admin support

## License

[AGPL-3.0](LICENSE) — Open source with copyleft protection. If you modify Tracearr and offer it as a service, you share your changes.

---

<p align="center">
  <sub>For Plex, Jellyfin, and Emby admins who want to see what's actually happening.</sub>
</p>
