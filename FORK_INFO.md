# Tracearr Fork Information

This file documents the local fork overlay so future upstream updates can preserve the fork-specific behavior intentionally.

## Comparison Snapshot

- Fork working tree: `/home/dev/work/Tracearr`
- Fork branch: `develop`
- Source repository checkout: `/tmp/Tracearr`
- Source branch/SHA inspected: `main` at `28b8c344`
- Last shared upstream commit found during inspection: `877c7f8a`
- Latest upstream commit merged into the current working tree: `28b8c344`
- Temporary comparison ref used locally: `source-tmp/main`

Useful commands for re-checking this later:

```bash
git fetch /tmp/Tracearr main:refs/remotes/source-tmp/main
git merge-base HEAD source-tmp/main
git diff --stat source-tmp/main..HEAD
git diff --name-status source-tmp/main..HEAD
```

## What This Fork Adds

The primary fork-owned change is first-class Dispatcharr support. The fork lets Tracearr track Dispatcharr Live TV and VOD streams alongside Plex, Jellyfin, and Emby.

General fork rule:

- When upstream changes touch server models, auth flows, polling/realtime, or UI around media-server management, treat Dispatcharr support as an intentional overlay that must be ported forward explicitly. Do not assume those changes are incidental drift that can be dropped during merge conflict resolution.

User-facing Dispatcharr behavior:

- Add Dispatcharr as a selectable server type.
- Connect to Dispatcharr with either an API key/JWT token or username/password credentials.
- Edit an existing Dispatcharr server in place to switch between API key/JWT token auth and username/password auth without deleting and re-adding the server.
- Cache username/password JWT acquisition by a non-reversible fingerprint of
  the complete credential set, preserving cross-client single-flight without
  allowing a warm token to validate a changed password.
- Use username/password mode for WebSocket-capable realtime updates; API-key mode falls back to REST polling.
- Legacy Dispatcharr servers upgraded from older fork versions remain in polling mode until username/password credentials are entered again, because older stored tokens do not contain recoverable credentials for automatic migration.
- Show Live TV streams, VOD movies, and VOD shows.
- Dispatcharr does not provide a Media library catalog or VOD library synchronization; it remains supported for sessions, history, Live TV/VOD streams, and user synchronization.
- Optionally ignore streams reported as anonymous.
- Terminate Dispatcharr live/VOD streams from Tracearr.
- Display Live TV channel/programme information, channel logos, stream bitrate, codecs, resolution, and FFmpeg speed where available.
- Jellyfin and Emby Live TV sessions are enriched from `/LiveTv/Programs`; the current programme is stored in `mediaTitle` while the channel remains in `live.*`. The EPG cache is shared per server/channel and refreshes the existing poller at programme boundaries. Web and mobile Live TV cards use the same channel-title/programme-subtitle layout as Dispatcharr; Plex keeps its legacy Live TV card for now.
- Show Dispatcharr active sessions immediately from healthy WebSocket snapshots.
- When a Dispatcharr Live TV channel gains its first client, enrich its card
  from the detailed channel status immediately and retry for up to ten seconds
  while Dispatcharr initializes stream metadata. This avoids waiting for a
  later `channel_stats` update; retries stop when core technical fields arrive
  or the channel becomes inactive.
- Reconcile connector-owned server configuration (type, name, normalized URL,
  token, and anonymous-stream filtering) on the Redis leader, replacing stale
  connectors after local or cross-replica edits.
- Dispatcharr Live TV, VOD, and catch-up sessions use the shared pending playback lifecycle: they become history after the global 30-second confirmation threshold. While a session is pending, every REST/WebSocket snapshot refreshes its metadata in place and retains the highest observed progress.

The fork also carries local maintenance/distribution changes:

- README has fork-specific warnings, Docker image names, and Dispatcharr feature notes.
- Renovate scheduled execution is disabled in `.github/workflows/renovate.yml`.
- CI runs only for pull requests; merges to `main` do not trigger a second CI run.
- The Snyk security workflow and README badge are disabled in this fork.
- The upstream `Vouch - Check PR` workflow is removed, so pull requests are
  not auto-closed or gated by a Vouch check in this fork.
- The Docker-backed integration matrix (PG15/Timescale 2.28 and PG18/Timescale
  2.29) is intentionally not part of GitHub PR CI. Run it manually when
  validating database, migration, or integration-test changes.
- Release automation is manual-only, so merging to `main` does not create a release, push Docker images, or post to Reddit.
- The manual release workflow's `bump-helm-chart` job is disabled with
  `if: false`; this fork does not use upstream's `RELEASE_PAT` path to bypass
  branch protection and push chart-version commits directly to `main`.
- Local Husky hooks were removed.
- `.tmp/`, `.plans/`, `AGENTS.md`, and this `FORK_INFO.md` are ignored locally.
- `AGENTS.md` documents the Pull Request CI workflow warning baseline. Read both `AGENTS.md` and this file before making changes, and update either file when a change affects repo instructions, fork overlay behavior, validation workflow expectations, warning counts, or future merge guidance.

## Typical Dispatcharr-Specific Changes

Most fork-only changes made for Dispatcharr fall into a few recurring categories:

- Shared model extensions:
  - add `dispatcharr` to server enums, schema validation, and frontend/backend shared types
  - carry Dispatcharr-only settings such as auth mode and anonymous-stream filtering
- Server configuration flow:
  - accept both token-based auth and username/password auth
  - allow switching auth mode in place while editing an existing server
  - avoid exposing stored token values back to the frontend response shape
- Realtime and polling:
  - use a dedicated Dispatcharr realtime connector instead of the existing Plex/Jellyfin/Emby SSE path
  - keep fallback polling when realtime is unavailable or when token auth cannot support realtime
  - bypass normal poller processing while healthy Dispatcharr realtime snapshots are active
- Session semantics:
  - treat Live TV and VOD differently
  - use the shared pending confirmation lifecycle for Dispatcharr Live TV, VOD, and catch-up
- Metadata and media presentation:
  - map channel/programme-specific live metadata
  - classify Dispatcharr catch-up/timeshift sessions as Live TV with estimated progress and a separate playback kind
  - support Dispatcharr images, logos, codecs, bitrate, and FFmpeg speed details
- Termination and sync:
  - route session termination through Dispatcharr-specific identifiers/endpoints
  - sync Dispatcharr users through the generic server sync path
- Frontend/mobile presentation:
  - expose Dispatcharr as a first-class server option
  - show Dispatcharr-specific setup guidance, polling/realtime state, and Live TV labels/cards/history rows
- Tests:
  - cover Dispatcharr parser/client/realtime behavior
  - extend server routes, public API formatting, image proxy, and UI tests for Dispatcharr cases

## Where The Fork Changes Code

Shared contracts:

- `packages/shared/src/schemas.ts` adds `dispatcharr` to server type validation and extends server create/update schemas with Dispatcharr credentials/settings.
- `packages/shared/src/types.ts` extends server-related types with `dispatcharr`, `dispatcharrAuthMode`, and `ignoreAnonymousStreams`.
- `packages/shared/src/constants.ts` adds Dispatcharr brand color support.

Database:

- `apps/server/src/db/schema.ts` extends `serverTypeEnum` and adds the Dispatcharr server column:
  - `ignore_anonymous_streams boolean default true not null`
- It also adds Dispatcharr playback metadata to `sessions`:
  - `dispatcharr_playback_kind varchar(20)`
  - `progress_estimated boolean default false not null`
- `apps/server/src/db/migrations/` is the upstream-only migration history. It must remain directly mergeable with the source repository.
- `apps/server/src/db/fork-migrations/` is the Dispatcharr overlay, with its own `meta/_journal.json` and `tracearr_fork.__drizzle_migrations` database ledger. Its current files `0000`–`0004` replace the historical main-ledger migrations `0067`–`0069`; `0004` removes the retired Dispatcharr live-history column.
- Before upstream migrations, the runtime removes the exact legacy `0069_steady_squadron_supreme` ledger entry only when `media` is absent. This is a one-time compatibility bridge: its timestamp would otherwise cause Drizzle to skip upstream `0067_cold_maggott`, which creates `media`.
- The overlay runs after upstream migrations. Its SQL is idempotent so installations that previously ran `0067`–`0069`, installations where they were skipped, and original Tracearr databases all converge without data loss.

Server-side Dispatcharr integration:

- `apps/server/src/services/mediaServer/dispatcharr/client.ts` implements the Dispatcharr media server client.
- `apps/server/src/services/mediaServer/dispatcharr/parser.ts` normalizes Dispatcharr status, user, Live TV, VOD, codec, profile, programme, and image data into Tracearr session shapes.
- `apps/server/src/services/mediaServer/dispatcharr/realtime.ts` implements Dispatcharr WebSocket handling with REST bootstrap/fallback behavior, including `timeshift_stats` catch-up updates and periodic EPG refresh.
- `apps/server/src/services/mediaServer/index.ts` registers `DispatcharrClient` in the media server factory.
- `apps/server/src/services/mediaServer/types.ts` carries Dispatcharr-specific config through the generic media server interface.

Server routes and services:

- `apps/server/src/routes/servers.ts` accepts Dispatcharr credentials/settings, verifies connections, stores encoded username/password credentials when token auth is not used, and returns Dispatcharr settings.
- `apps/server/src/services/sync.ts` syncs Dispatcharr users through the generic user sync path.
- `apps/server/src/services/termination.ts` passes Dispatcharr config into session termination.
- `apps/server/src/services/imageProxy.ts` normalizes Dispatcharr image paths, supports Dispatcharr channel logos, and uses `inside` resize fit for Dispatcharr images.
- Dispatcharr channel-logo proxy requests must use the configured server origin
  and an empty header set. Do not reintroduce generic `Accept` or auth headers
  when refactoring the shared image-proxy request builder; preserve URL
  normalization and `fit: inside` while retaining upstream cache/LQIP behavior
  for other server types.
- Uncropped Dashboard artwork is a permanent, intentional fork behavior,
  not a temporary workaround:
  preserve it when merging upstream image-proxy or Dashboard changes.
  Dashboard artwork reserves the normal poster slot, but an inner visual
  element takes the image's actual bounded aspect ratio. Shared
  poster cache entries preserve the full image with Sharp `fit: inside` for
  every provider; avatars/art retain their prior sizing behavior. Jellyfin/Emby
  thumbnails constrain both dimensions, while Plex posters use the source
  image to avoid fill-transcoder cropping. Cache keys and the cache directory
  are unchanged. Startup removes recognized cached WebP files once, before
  serving requests, then writes `.uncropped-artwork-v1` in the image-cache
  directory. Later starts retain the regenerated files. Dashboard URLs append
  `artwork=2` only to refresh browser caches; this is not a server cache variant.
  The artwork container is transparent when an image exists, exposing the
  card's blurred backdrop in letterbox/pillarbox space; it keeps `bg-muted`
  only for the missing-image server-icon placeholder. The shadow and hover
  dimmer belong to that inner visual element, never to the fixed poster slot.
  The `32px` Play/Pause icon is `shrink-0` and may extend past an extremely
  small image, so it must never be clipped by the artwork container.
  Validated with Node 24 / pnpm 12.3.4: services (3,347 passed, one skipped),
  web (1,224 passed with two workers), typecheck, lint (754 warnings, unchanged),
  and build. Docker and live-provider manual smoke checks were not run.
- `apps/server/src/routes/public.ts` and `apps/server/src/routes/public.openapi.ts` expose Dispatcharr-aware live media fields in public API responses.
- Dashboard daily stats keep `todayPlays`, `todaySessions`, and `watchTimeHours` as VOD-only metrics, add `tvSessions`, `tvChannels`, and `tvWatchTimeHours` for `mediaType === 'live'`, and count `activeUsersToday` across all media types so Dispatcharr Live TV/catch-up activity is no longer invisible on the homepage.
- Dispatcharr Server Resources are supplied by the separate `Dispatcharr-Metrics` v1 plugin. The plugin broadcasts sanitized `tracearr_server_stats` schema version `1` messages on the existing authenticated `updates` WebSocket; Tracearr accepts only finite timestamps and 0–100 utilization values. `process*` samples describe the complete Docker `web` container cgroup (including FFmpeg and cache-backed memory), not the host. If Docker has no explicit memory limit, the container memory percentage uses host-visible `MemTotal` as denominator, matching Docker Stats' no-limit behavior. `host*` samples are true host-wide CPU and memory utilization via Dispatcharr's bundled `psutil`, constrained to `0.00–100.00%`; they include every process visible to the host. The same plugin publishes `tracearr_bandwidth_stats` schema version `1` aggregate one-second samples (`lanBytes` and `wanBytes`) for the dashboard Bandwidth card; Tracearr retains 156 samples. A zero-valued sample is valid and shows the card; missing or invalid fields do not. Username/password authentication is required to keep the Dispatcharr WebSocket; API-key mode remains REST-only and has no resource or bandwidth samples. v1 supports Docker AIO and modular `web` deployments only; bare-metal/systemd is intentionally unsupported.
- The same plugin broadcasts `tracearr_plugin_info` schema version `1` on the authenticated `updates` WebSocket, with `pluginId: tracearr-sse-metrics`, name, and the runtime version from `plugin.json`. Dispatcharr realtime status treats a valid message as the active plugin/version signal and reports `pluginIssue: missing` when a connected WebSocket receives no such message within the detection grace period. This is active-plugin detection, not proof that disabled plugin files exist on disk.
- Plugin update checks use separate version families: Jellyfin/Emby continue using the configured SSE manifest, while Dispatcharr-Metrics uses the latest stable GitHub release from `d4rk-4lchemy/Tracearr-SSE-Metrics`. GitHub `vX.Y.Z` tags are normalized before comparison, and a failure in one source does not suppress checks for the other family.
- Activity stats (`plays`, `concurrent`, day/hour activity, platforms, quality, users, and top users) include `movie`, `episode`, and `live` sessions from every supported server type. The two-minute intentional-play threshold remains limited to the plays/activity charts; Dashboard, engagement, and other primary-statistics filters remain VOD-only.
- `apps/server/src/routes/sessions.ts` carries `dispatcharrPlaybackKind` through `/sessions/history` so History UI can distinguish Dispatcharr catch-up/timeshift rows from ordinary Live TV.

Realtime and polling:

- `apps/server/src/services/sseManager.ts` manages Dispatcharr WebSocket connectors in addition to Plex/Jellyfin/Emby SSE.
- `apps/server/src/jobs/dispatcharrRealtimeProcessor.ts` consumes healthy Dispatcharr WebSocket snapshots directly, updates the active-session cache, and publishes existing `session:started`, `session:updated`, and `session:stopped` events.
- `apps/server/src/index.ts` starts and stops the Dispatcharr realtime processor with other background services.
- `apps/server/src/jobs/poller/processor.ts` skips normal Dispatcharr session processing while WebSocket mode is healthy. Dispatcharr polling remains the fallback for API-key/token mode, disconnected/fallback WebSocket mode, and explicit reconciliation after realtime loss.
- Dispatcharr Live TV, VOD, and catch-up history confirmation uses the shared playback lifecycle and global confirmation threshold. Pending REST/WebSocket snapshots replace metadata in place while protecting maximum progress from partial/out-of-order data.
- Authoritative Dispatcharr stop results retain the exact active-session ID
  through pending/database stop, cache removal, pub/sub, and notifications, so
  catch-up clients sharing a provider session key cannot stop one another.
- Dispatcharr catch-up/timeshift sessions are also keyed to `media.type === 'live'`, but carry `dispatcharrPlaybackKind === 'catchup'` and `progressEstimated === true`. Catch-up uses `/proxy/stats/` plus `/proxy/catchup/programs/` for enrichment. Programme title and EPG timeline update in place like Dispatcharr Live TV; the resolved programme must not be part of catch-up session identity.
- `apps/server/src/jobs/poller/stateTracker.ts` supports a configurable confirmation threshold and detects media-title changes for DB writes.
- `apps/server/src/jobs/poller/types.ts` extends poller server/session types to include Dispatcharr.

Web UI:

- `apps/web/src/components/settings/ServerSettings.tsx` adds Dispatcharr server creation/editing, in-place auth mode switching, anonymous-stream filtering, and Dispatcharr-specific realtime setup guidance for legacy token-based servers.
- `apps/web/src/components/icons/MediaServerIcon.tsx` and `apps/web/public/images/servers/dispatcharr.png` add Dispatcharr branding.
- `apps/web/src/components/sessions/NowPlayingCard.tsx` shows Live TV channel/programme-oriented cards.
- Catch-up cards must continue to use the Live TV visual grouping, but favor progress/remaining-time presentation over FFmpeg live-speed presentation.
- `apps/web/src/pages/Dashboard.tsx` now renders six daily stat cards in this order: Alerts, VOD Plays, VOD Watch Time, TV Sessions, TV Watch Time, Active Users.
- `apps/web/src/components/history/HistoryTable.tsx` fixes column sizing/truncation for long Live TV content, improves history layout, and shows the Dispatcharr catch-up indicator for catch-up rows.
- `apps/web/src/components/history/StreamDetailsPanel.tsx` shows FFmpeg speed and Dispatcharr-oriented stream details.
- `apps/web/src/lib/api.ts`, `apps/web/src/hooks/queries/useServers.ts`, and `apps/web/src/hooks/useServer.tsx` carry Dispatcharr server settings through the frontend API/cache layer.
- `apps/web/src/components/charts/ServerResourceCharts.tsx` temporarily owns the
  live-data lifecycle for Server Resources only while a legend entry is
  hidden. With every series visible, it uses the ordinary upstream
  HighchartsReact update flow. While hidden, samples for that series are held
  outside Highcharts and applied when its native legend entry shows it again,
  avoiding Highcharts 13's crashing hidden-point destruction path.
  This is only a stopgap: when upstream Tracearr fixes the chart lifecycle,
  its implementation must overwrite and remove this fork-owned code and tests
  during the merge; do not retain parallel chart lifecycle code.
- `SERVER_STATS_CONFIG.DATA_POINTS` is temporarily `21`: a two-minute range at
  six-second cadence has 20 intervals and therefore needs both endpoint
  samples. If upstream changes the Server Resources window model, adopt its
  implementation and remove this fork-specific endpoint correction.

Mobile UI:

- `apps/mobile/src/lib/mediaConfig.ts` and `apps/mobile/app/session/[id].tsx` add Dispatcharr label/color metadata.
- `apps/mobile/src/components/sessions/NowPlayingCard.tsx` displays Live TV as channel plus programme instead of generic media title.
- `apps/mobile/src/components/history/HistoryRow.tsx` fixes Live TV history content labels and shows the Dispatcharr catch-up indicator for catch-up rows.
- `apps/mobile/src/hooks/useImageUrl.ts` accepts absolute image URLs for Dispatcharr images.

Tests:

- Dispatcharr server tests live mainly under `apps/server/src/services/mediaServer/__tests__/dispatcharr-*.test.ts`.
- Supporting tests cover public API formatting, image proxy behavior, server routes/settings including Dispatcharr auth-mode edits, poller pending progress, web server selector/settings, Now Playing, history table, and stream details.

## Why These Changes Exist

Dispatcharr differs from the original supported media servers in several ways:

- Live TV state comes from Dispatcharr transport-stream status endpoints and can be enriched with channel/logo/current-programme APIs.
- VOD state can be included in Dispatcharr realtime snapshots and follows the same global pending confirmation lifecycle as Live TV.
- Catch-up state arrives from `/proxy/stats/` and `timeshift_stats`, while EPG enrichment comes from `/proxy/catchup/programs/`; both sources are required to keep programme titles, boundaries, and estimated progress current without splitting a single catch-up viewing session.
- WebSocket auth needs a JWT, while API keys can still support REST polling.
- Catch-up playhead is approximate: Dispatcharr reports anchors such as `programme_start`, `position_anchor_at`, and optional `playback_base_secs`, not a guaranteed client-authoritative position.
- Dispatcharr can report anonymous clients; the fork defaults to ignoring them to reduce noise.
- Session identifiers and termination endpoints differ between live and VOD streams.

## Future Upstream Update Notes

When merging or rebasing on source `main`, preserve the Dispatcharr overlay deliberately instead of treating it as incidental drift.

### Latest upstream merge

- Upstream `main` at `28b8c344` was merged into `develop` on September 10,
  2026 without textual conflicts. The watched-media API now scopes all results
  by `user_id`, removes `window` and `watched_state_user`, includes episode
  numbering scoped by server, and pages a bounded Redis-cached candidate list.
  React, MapLibre, undici, Expo server SDK, jsdom, and image digests were updated.
  The toolchain is now Node 24 / pnpm 12.3.4, as selected by CI through the root
  `packageManager`; current local validation commands in `AGENTS.md` and
  `MERGE_INSTRUCTION.md` were updated accordingly. No migrations changed.
  Dispatcharr API types, library exclusions, and fork distribution policies
  remain intact. Docker integration and E2E are omitted at the user's request.
  Full non-Docker CI passed: install, lint, typecheck, translations, all five
  server groups, web, coverage, and build. The group/web jobs passed 7,687 tests
  with two skipped; coverage passed 5,068 with two skipped (65.34% statements,
  59.87% branches, 72.44% functions, 66.39% lines). Lint reported 756 warnings
  before rebuilding shared and 754 afterwards (two new upstream non-null
  assertions); other warning counts match September 9. Logs use
  `.tmp/github-ci-<job>-20260910.log`, with the final lint result in
  `.tmp/github-ci-lint-after-build-20260910.log`. Live Dispatcharr manual smoke
  checks and Docker image builds were not performed.

- Upstream `main` at `877c7f8a` was merged into `develop` on September 9,
  2026. The merge adds the public API v2 watched-media endpoint, two-part
  server-version normalization, shared table spacing improvements, Helm and
  Compose port configuration fixes, dependency updates, and Crowdin translations.
  Locale conflicts were reconciled by key, retaining fork-only labels while
  accepting updated upstream translations. The Snyk modify/delete conflict
  retains the fork's removal; PR-only CI, disabled Renovate, and manual-only
  releases with the Helm push job disabled remain intact. No migrations changed.
  Dispatcharr library-sync exclusions and API server types remain intact, and
  History retains its fixed column widths and mobile minimum table width.
  Full non-Docker CI passed with Node 24 and pnpm 11.11.0: lint (752 warnings,
  unchanged), typecheck, translations, unit/services/routes/auth/security,
  web, coverage, and build. The individual test jobs passed 7,677 tests with
  two skipped; the separate coverage run passed 5,063 tests with two skipped
  (65.46% statements, 59.93% branches, 72.65% functions, 66.50% lines).
  No live Dispatcharr instance was exercised in this local validation.
  Docker-backed integration and E2E validation are explicitly omitted at the
  user's request for this merge.

- Upstream `main` at `5c7912a1` was merged into `develop` on September 3,
  2026 (merge commit `a20477e3`). The merge retains upstream migrations
  `0095` and `0096` in the upstream ledger while preserving the separate
  Dispatcharr fork-migration ledger. It also carries upstream's TypeScript 7 /
  Oxlint transition, `session.first_seen` automation trigger, map and browser
  recovery improvements, user-merge hardening, dependency updates, and Crowdin
  translations. Dispatcharr realtime processing remains leader-gated, its
  polling/library exclusions remain in place, and the progress hook keeps its
  server timestamp anchoring while using the upstream fallback anchor for
  sessions that do not provide one.

- Upstream `main` at `7066c7a9` (Tracearr `v2.2.2`) was merged into
  `develop` on August 28, 2026 (merge commit `f9552a54`). The web automation
  builder now falls back to an RFC 4122 v4 UUID generated with
  `crypto.getRandomValues()` when a plain-HTTP LAN origin lacks
  `crypto.randomUUID`; the reducer regression coverage came with it. The
  supervised Docker image already contained the upstream basemap update, and
  the Helm chart version was advanced to 2.2.2. No migrations or
  Dispatcharr-specific control paths changed. Fork CI remains PR-only,
  Renovate remains disabled, and release automation remains manual-only with
  the Helm-chart push job disabled.

- Upstream `main` at `64401f0c` (Tracearr `v2.2.0`) was merged into
  `feature/prepare-for-2.2.0` on August 27, 2026. The built-in MapLibre/PMTiles
  map, richer media-added and media-upgraded notifications, Fastify 5.12.1,
  translation refresh, and release/Helm maintenance were retained. The merge
  added no upstream migrations. Translation conflicts were resolved with the
  refreshed upstream locales as the baseline and the fork's channel-count,
  VOD/TV dashboard, no-library, and upstream-version keys restored as English
  fallbacks in every locale. Dispatcharr remains excluded from media-library
  synchronization while retaining session, history, realtime, resource, and
  dashboard support; the fork's PR-only CI and manual-only release policy also
  remain intact. The upstream Helm-chart push job was subsequently disabled in
  the fork so it cannot use a release PAT to write directly to `main`.

- Upstream `main` at `6fc80e54` was merged into `feature/prepare-for-2.2.0`
  on August 20, 2026. The upstream `0089_zippy_frank_castle` migration,
  user identity rollups, server-list filtering, dashboard/navigation refresh,
  dependency/toolchain updates, and translation refresh were retained.
  Dispatcharr remains present in shared server contracts and settings; its
  fork migrations remain in the separate `fork-migrations` ledger. The History
  table now uses upstream's data-table structure while preserving Dispatcharr
  Live TV labels and the catch-up indicator. A post-`develop` shared-session
  mapper refactor had dropped Catch-up classification between `ProcessedSession`,
  active/pending cache entries, and session persistence; the fork restores
  `dispatcharrPlaybackKind` and active-card EPG fields across those boundaries.

- Upstream `main` at `bf662a89` was merged into `feature/prepare-for-2.2.0`
  on August 18, 2026. The upstream Plex re-authentication/token-reconciliation
  flow, dependency updates, Docker image refreshes, and translation fallbacks
  were retained. The `sseManager` conflict preserves the fork's leader-owned
  Dispatcharr-aware configuration comparison (type, name, normalized URL,
  token, and anonymous-stream setting), so it still replaces stale connectors
  after edits. GitHub Actions retain fork policy: CI is PR-only, Renovate is
  disabled, release is manual-only, and the integration matrix remains a
  manual validation path; upstream action/image pin updates were accepted.

- Upstream `main` at `da2828d1` was merged into `feature/prepare-for-2.2.0`
  on August 17, 2026. Upstream migration `0088`, the destinations-based
  notification system, and the rule lifecycle changes were retained.
  Dispatcharr continues to be included in the shared server and rule types;
  its WebSocket processor remains leader-lease owned, and authoritative stops
  retain the exact active-session ID through cache and notification handling.
  Upstream removed the mobile application, so the former mobile Dispatcharr
  presentation overlay was removed with it.

- Upstream `main` at `22199d26` (Tracearr `v2.1.0-beta.8`) was merged into
  `feature/prepare-for-2.1.0` on Friday, August 14, 2026 (merge commit
  `7b7e79e7`). Upstream security hardening, queue/Redis cleanup, media-detail
  replacement history, and migrations `0086`–`0087` were retained. Conflicts
  in the session cache and image proxy were reconciled: Redis active sessions
  still hydrate date fields for Dispatcharr lifecycle operations, while all
  image requests now receive upstream origin/SSRF validation; Dispatcharr
  retains normalized image paths, no added channel-logo headers, and
  `fit: inside` resizing.
- The upstream locale refresh omitted keys used by the fork's VOD/TV dashboard
  and update-status UI. The translation checker was run with `--fix`, adding
  the English fallback values to all locale files, after which the full
  translation check passed.

- Upstream `main` at `73e00663` (Tracearr `v2.1.0-beta.7`) was merged into
  `feature/prepare-for-2.1.0` on Tuesday, August 11, 2026. The upstream
  server-identity backfill, media-server deep links, login-role hardening,
  and scoped server listing were retained. Dispatcharr remains a first-class
  server type: its credentials/settings are returned only through the
  Dispatcharr-aware route formatting, it participates in identity backfill,
  and library sync stays guarded by `supportsMediaLibrary()`.
- Upstream Crowdin locale updates and package/workspace changes were retained.
  Future locale updates should continue to use upstream as the baseline;
  Dispatcharr UI labels are implemented in the server settings components and
  must be smoke-tested after translation changes.

- Upstream `main` at `36d82db5` was merged into
  `feature/prepare-for-2.1.0` on Monday, August 10, 2026 (merge commit
  `a1595115`). The upstream live-statistics time-window implementation was
  retained across server, mobile, shared contracts, and web charts.
- The temporary fork-only Highcharts hidden-series lifecycle workaround was
  removed as required: upstream now owns the chart update lifecycle. Its
  time-window model also supersedes the fork's 21-point endpoint correction;
  `SERVER_STATS_CONFIG` now uses the upstream time-bound retention settings.
- Dispatcharr server-resource samples continue to use the same generic
  `ServerResourceDataPoint` path, so no Dispatcharr-specific chart control
  flow was retained.

General merge rules:

- Prefer upstream as the baseline for auth hardening, security fixes, dependency/toolchain updates, generic SSE robustness, and identity/user model changes.
- Prefer the fork for Dispatcharr-specific capabilities, but port them onto the upstream structure instead of keeping older fork control flow wholesale.
- Do not resolve high-risk conflicts by taking the entire fork file or entire upstream file in:
  - shared server schemas/types
  - `apps/server/src/routes/servers.ts`
  - `apps/server/src/services/sseManager.ts`
  - `apps/server/src/jobs/poller/processor.ts`
  - Dispatcharr web/mobile settings and status UI
- Reconcile schema intent first, then regenerate migrations and lockfile artifacts afterwards.
- If a commit is labeled as lint/typecheck cleanup, still inspect it for hidden behavioral overlap before replaying it after a merge. Some recent CI-cleanup commits also touched active Dispatcharr integration points.

High-conflict areas to review manually:

- `apps/server/src/services/imageProxy.ts`, `imageCacheMigration.ts`, startup
  wiring in `apps/server/src/index.ts`, and web `NowPlayingCard.tsx`: preserve
  full poster images for all providers, the shared cache, the one-time cleanup
  marker, and the browser refresh marker. Do not restore upstream poster
  `cover` resizing or restore a fixed poster-shaped visual wrapper. Preserve the
  transparent artwork container for real images and the `bg-muted` missing-image
  placeholder, inner aspect-ratio-bound effects, and unclipped fixed-size
  Play/Pause control. Keep the existing
  image-proxy, cache-migration, and NowPlayingCard regression tests. An upstream
  replacement is acceptable only if it preserves this behavior end to end.
- Shared server type definitions and schemas.
- Drizzle migrations and `servers` table shape.
- `apps/server/src/routes/servers.ts`.
- `apps/server/src/services/mediaServer/index.ts` and media server generic types.
- `apps/server/src/services/sseManager.ts`.
- `apps/server/src/jobs/poller/processor.ts`, `stateTracker.ts`, and poller types.
- `apps/server/src/services/imageProxy.ts`, `sync.ts`, and `termination.ts`.
- Public API current-session formatting and OpenAPI schema.
- Web `ServerSettings`, Now Playing/history components, and API hooks.
- Mobile server metadata and Live TV display.

Current upstream merge notes:

- Upstream `main` at `2483fe68` (Tracearr `v2.1.0-beta.5`) was merged into
  `feature/prepare-for-2.1.0` on Monday, August 10, 2026 (merge commit
  `bf28c7df`). The upstream `0085_far_captain_universe` migration and
  `library_items(server_id, thumb_path)` index were retained, along with the
  short-lived image-proxy server-row cache. The Dispatcharr image overlay was
  verified after the automatic merge: absolute paths remain normalized to the
  configured server origin, channel-logo proxy requests use no added headers,
  and Dispatcharr images retain `fit: inside`.

- Upstream `main` at `d058577d` (Tracearr `v2.1.0-beta.4`) was merged into
  `feature/prepare-for-2.1.0` on Sunday, August 9, 2026 (merge commit
  `e3b84559`). The upstream migration lock, TimescaleDB drift/degradation
  checks, PostgreSQL 18 test volume layout, server-side image resizing,
  live-resource stats, and playback-reporting import work were retained.
  The guarded migration runner now applies the upstream history and the
  Dispatcharr fork overlay under the same advisory lock while retaining their
  separate ledgers and the legacy-ledger repair. Dispatcharr-specific image
  normalization and header-free channel-logo requests remain intact before
  the upstream resize/fallback candidates are built.

- Upstream `main` at `55af7da5` (Tracearr `v2.0.1`) was merged into
  `feature/better-live-tv-for-jellyfin-and-emby` on Thursday, August 7, 2026
  (merge commit `a28c0103`). The upstream full-scan and snapshot aggregation
  rewrite was retained. `LibrarySyncService.syncServer()` keeps the fork's
  `supportsMediaLibrary()` guard, so Dispatcharr remains excluded from library
  catalog work while retaining session/history and realtime support.
- Jellyfin/Emby SSE retains upstream's bounded event-burst debounce, plugin
  diagnostics, leader-only connection refresh, and library-event sync. The
  fork additionally carries immediate terminal-event polling; Dispatcharr
  continues to use its separate authenticated WebSocket snapshot processor.
- Session producers are leader-lease gated: the Redis lease holder runs the
  poller, Jellyfin/Emby SSE processor, plugin checker, and Dispatcharr
  realtime snapshot processor. On lease loss or shutdown they all stop before
  the lease is released, preventing duplicate polling or realtime consumers
  during failover.

- Upstream `main` at `c600f88f` was merged into `feature/version-2.0-preparation` on Wednesday, August 5, 2026 (merge commit `6a284d7a`). The merge retains the Dispatcharr library-capability guard: Dispatcharr remains excluded from library-sync scheduling and media catalog work while receiving session/history support.
- Upstream's Timescale maintenance, session-identity backfill, library-sync queue, import transaction, supervised Docker, and translation changes were retained. The database-client test conflict was resolved by retaining both the fork migration-ledger coverage and upstream raw-client error-listener coverage; the Dutch settings translation retains Dispatcharr configuration/realtime and fork-version keys alongside upstream localization updates.

- Upstream `main` at `367f6c69` has been merged into `feature/version-2.0-preparation` in the current working tree on Tuesday, August 4, 2026 (merge commit `0f7e1597`, followed by Dispatcharr reconciliation `368c460f`).
- The merge ports the Dispatcharr overlay onto Tracearr 2.0: the new media/version schema, public API v2, mobile navigation and SSE plugin recovery behavior are retained alongside Dispatcharr auth, polling/realtime snapshots, shared history-confirmation semantics, catch-up metadata, and image handling.
- Upstream migration history is now aligned through `0082_backfill_last_activity.sql`; the Dispatcharr overlay remains in its separate fork ledger.
- Migration `0063_long_maria_hill.sql` must keep upstream's login-username collision auto-rename block before creating `users_login_username_unique`; without it, `loginUsernameCollision.integration.test.ts` fails.
- Dispatcharr migrations now live in the separate fork overlay, leaving `apps/server/src/db/migrations/` aligned to upstream through `0066`.
- Local CI-equivalent validation for that merge used Node 24 and pnpm 11.11.0;
  use the current toolchain in `AGENTS.md` for subsequent validation.

### Migration History Policy

- Drizzle compares the latest `created_at` only within one ledger. The upstream and fork ledgers are intentionally separate so an original Tracearr database with newer upstream migrations still receives all missing Dispatcharr migrations.
- The pre-ledger Dispatcharr `0069_steady_squadron_supreme` entry remains a special upgrade case: before upstream migration, remove only its known hash/timestamp pair when `public.media` is missing. Do not generalize this to deleting arbitrary ledger rows.
- Keep upstream migration files and journal entries immutable and merge them from source as-is. Create fork schema changes only with `pnpm --filter @tracearr/server db:fork:generate -- <name>`; it creates a new overlay SQL file and monotonic journal entry.
- `db:generate` and `db:push` are deliberately disabled in this fork because the combined runtime schema would otherwise emit Dispatcharr DDL into the upstream history.
- Before releasing a migration-affecting merge, test a fresh database, an upgrade from the latest upstream release, and an upgrade from the prior fork release. Confirm `servers` rows survive, the fork ledger is populated, and all Dispatcharr columns exist.

Recommended merge workflow:

```bash
git fetch /tmp/Tracearr main:refs/remotes/source-tmp/main
git checkout develop
git checkout -b merge/upstream-main-2026-07-18
git merge source-tmp/main
pnpm install
pnpm test:unit
pnpm test:services
pnpm test:routes
pnpm test:security
```

For this environment, if global `pnpm` or Node is unavailable, use:

```bash
npx --yes -p node@24 -p pnpm@12.3.4 pnpm test:unit
```

## Minimum Dispatcharr Smoke Test After Merge

After an upstream merge that touched any server, auth, polling, realtime, or UI flow, do at least this minimum manual verification for Dispatcharr:

1. Add a new Dispatcharr server with token auth and verify it saves successfully.
2. Add or edit a Dispatcharr server with username/password auth and verify the server can switch into realtime-capable mode.
3. Open the server settings UI and confirm Dispatcharr-specific controls are still present:
   - auth mode handling
   - anonymous-stream filtering
   - shared global history-confirmation behavior
4. Verify a Dispatcharr Live TV session appears in active sessions.
5. Verify Dispatcharr VOD and catch-up use the shared history-confirmation lifecycle.
6. Confirm Dispatcharr channel/logo or image URLs still render through the current frontend/mobile image flow.
7. Confirm terminating a Dispatcharr session still works.
