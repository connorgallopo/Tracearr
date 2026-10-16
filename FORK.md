# Fork notes

This is a personal fork of [connorgallopo/Tracearr](https://github.com/connorgallopo/Tracearr). Its `main` is an
upstream release tag plus the patches below, built into its own image. Patches stay upstream-shaped (one change and
its tests per commit) in case any of them is ever offered back.

- **Base:** upstream `v2.8.3` (merged in 2026-10-15; the fork started from `v2.8.0`). To take a newer release, merge
  its tag into a branch and open a pull request; the merge keeps the patches' history.
- **Image:** `ghcr.io/oliviacpu/tracearr:<tag>` and `:latest` (the newest tag build, which the deployment runs), built
  for linux/amd64 by `.github/workflows/fork.yml` when an `oliviacpu-*` tag is pushed, after lint, typecheck and the
  server tests pass. So pushing a tag is releasing it. That workflow is the fork's only one:
  upstream's publish its images and releases, run its bots and need its secrets.
- **GeoIP:** the build copies the GeoLite2 databases out of upstream's newest image. Upstream's own builds download them
  from MaxMind with a license key the fork doesn't have, and the committed copies can be weeks old: the first fork image
  put a viewer in the wrong city.
- **Version:** the image reports the upstream base tag as its version, so the update check still compares against
  upstream releases. The fork tag is the build's `tag`.

## Patches

### Live TV episodes show their show's poster

Plex Live TV channels fed by an XMLTV guide (for example from Tunarr) give an episode no picture of its own. Plex puts
the guide's picture on the show and hands it over as `grandparentThumb`, often an absolute URL, with no `thumb`.
Tracearr read only the episode's picture and the channel logo for Live TV, so the Now Playing card showed a
placeholder. Its image proxy also refused anything but a media server path.

- A live episode keeps its show, season and episode, and the poster falls back to the show's after the channel logo
  and the episode's own picture (`parser.ts`, `sessionMapper.ts`).
- `EXTERNAL_IMAGE_ORIGINS` (comma-separated origins, unset by default) lists the outside origins whose pictures may be
  shown, such as `https://guide.example.com`. A URL must be canonical, with no credentials, fragment, backslash or
  percent-encoding. It is fetched only by the Plex server's photo transcoder, resized, so Tracearr never requests
  it itself and the Plex token only goes to the configured server (`imageProxy.ts`).
- Sessions recorded before this change keep no picture: Tracearr stored none for them.

### A shared user's Live TV through an iptvtunerr proxy is theirs

The [iptvtunerr](https://github.com/oliviacpu/iptvtunerr) Plex proxy gives shared users Live TV by tuning it with the
server owner's token, so Plex lists the session under the owner. Tracearr recorded a friend's Live TV as the owner's.
The proxy (with `-live-viewers`) knows which Plex account is behind each Live TV client and lists them at
`/iptvtunerr/live-viewers`.

- `IPTVTUNERR_LIVE_VIEWERS_URL` (unset by default) is that list's address, such as
  `http://127.0.0.1:27198/iptvtunerr/live-viewers`; `IPTVTUNERR_LIVE_VIEWERS_KEY` is the proxy's read-only key for it
  (its `IPTV_TUNERR_PROXY_LIVE_VIEWERS_KEY`). Both are passed through by the example compose files and listed in
  `docker/.env.example`.
- For the Plex server the list names (its `machineIdentifier`, matched against the server's stored one), each Live TV
  session Plex lists under the owner whose client (`Player.machineIdentifier`) is on the list is filed under that
  shared user's plex.tv account id, which is the external id Tracearr already has for them, and their username.
  The owner's avatar isn't copied to them, and an entry without a username is ignored rather than overwrite the
  friend's stored name. Other sessions, other media and other servers are never changed (`proxyLiveViewers.ts`,
  called by the poller and the SSE path; `ServerWithToken` gains the `machineIdentifier` the servers row has).
- Who a session belongs to is decided once, the first time it's seen, and kept: a recorded session is never moved to
  someone else later, which would duplicate it and run its rules again. Decisions are keyed by server, Plex's
  `Session.id` (not reused, unlike the session key Plex restarts at 1 after a PMS restart) and client, and kept in
  memory and in Redis for 24 hours (`fork:proxy-live-viewer:*`, renewed hourly while the session is seen), so a
  Tracearr restart recovers them instead of deciding again.
- Each new session reads the list fresh (concurrent reads share one request): the proxy records the tune before Plex
  reports the session, so it finds its viewer, and a device that just changed hands is seen as it is now. Each
  session is decided once, so this is one request per new Live TV session. When the proxy can't answer, a new session
  stays under the owner (an older answer could be out of date) and a warning is logged at most every 5 minutes.
- A session Tracearr already records without a decision (it started before this feature, or its decision was lost)
  stays under whoever it's recorded under (the pending record's user, or the active row's server user), so it isn't
  duplicated under someone else. Both paths check the pending record, then the active row, for the same playback:
  same client, and the same Plex `Session.id` when both have one (a recycled session key after a PMS restart is a
  different playback).
- Without `IPTVTUNERR_LIVE_VIEWERS_URL` nothing is fetched, but decisions already made (memory or Redis) still apply,
  and a session Tracearr already records keeps its recorded user.
- Limit: because of that, if the proxy can't be reached when a session is first seen (the list fetch fails), that
  session stays under the owner.
- Sessions recorded before this change stay under the owner.
