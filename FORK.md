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

### Discord posts under a chosen name and picture

Every Discord message came from "Tracearr" with the upstream repo's icon, whatever the deployment wanted to call it.

- `DISCORD_USERNAME` and `DISCORD_AVATAR_URL` (unset by default, which keeps Tracearr's) set the webhook's name and
  picture for every Discord destination. The picture must be an https URL with no credentials, since Discord fetches it
  itself; anything else is ignored with one warning. A name is cut to the 80 characters Discord accepts. Both are
  passed through by the example compose files and listed in `docker/.env.example`.

### Discord stream and violation messages show the viewer's picture

A stream or violation message named the viewer only in a field.

- Stream started, stream ended and violation embeds name the viewer as the embed's author, with their account picture
  as its icon, when that picture is a public https URL Discord can fetch itself (a Plex account's
  `https://plex.tv/users/…/avatar`). A relative path (what Jellyfin and Emby store), an IP literal, a single-label or
  local host name, credentials, or a query parameter whose name could carry a key or token leave the author off, as
  before, so nothing about the media server reaches Discord (`discord.ts`).
- Media added and media upgraded keep their own author, the automation's name.

### Discord stream messages carry the poster

Only media added and media upgraded messages uploaded a poster, so a stream message had no picture.

- Stream started and stream ended embeds upload the session's poster, the one its Now Playing card shows. For a Live TV
  episode from an XMLTV guide that is the channel logo, else the episode's picture, else the show's poster (the first
  patch above), so Live TV messages get the guide's show poster.
- An outside URL is fetched only as the image proxy allows (`EXTERNAL_IMAGE_ORIGINS`, through the Plex server's photo
  transcoder); a refused or failed fetch sends the message without a picture, as before.

### A Live TV programme change isn't a stream ending and another starting

Plex starts a new Live TV session (new session key, new metadata) at every guide programme boundary, so someone
watching one Tunarr channel got a "Stream Ended" and a "Stream Started" at every programme. Tracearr records each
programme as its own session, and that stays: the history keeps what was on. The notifications follow the watch
instead (`liveTvWatch.ts`, used by `notificationQueue.ts`).

- A watch is one account's Live TV on one device (server, server user and device id). A Live TV session that starts
  while another of the watch is playing, or at most 90 seconds after it stopped, continues it, and its start isn't
  sent. Changing channel on the same device continues the watch too: it is the same viewer on the same TV, and Plex's
  Live TV sessions from Tunarr don't carry the channel's name anyway.
- A Live TV stop is queued as a delayed job and held 150 seconds: the 90-second gap, the 30 seconds before Tracearr
  confirms and records a new session, and slack. When the hold is over it is sent only if no other session of the
  watch ends later. So a watch sends one Stream Ended, about the programme it ended on, with the watch's first start
  and the summed watch time of its programmes (pauses and the gaps between programmes left out).
- The decisions are read from the sessions table when they're made, so a restart loses nothing: the held stop is a
  BullMQ delayed job in Redis and runs when the worker is back, at once if it's overdue. A Stream Ended that went out
  is remembered in Redis for two days (`fork:live-tv-ended:*`), so a programme whose start is decided after its watch's
  end was already sent (Tracearr down across the boundary) is announced as a new watch rather than folded into one
  that was reported.
- A failed database read sends the start, or the stop unchanged, as before. Sessions without a device id and every
  other media type are sent as before, at once; a movie started on the same device within the hold gets its own
  messages, and the Live TV Stream Ended can then arrive after the movie's Stream Started.
- It applies to every destination type and to automation sends: a Stream Ended automation sees the watch's summed
  `durationMs` and first `startedAt`.
