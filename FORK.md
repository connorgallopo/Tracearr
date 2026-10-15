# Fork notes

This is a personal fork of [connorgallopo/Tracearr](https://github.com/connorgallopo/Tracearr). Its `main` is an
upstream release tag plus the patches below, built into its own image. Patches stay upstream-shaped (one change and
its tests per commit) in case any of them is ever offered back.

- **Base:** upstream `v2.8.3` (merged in 2026-10-15; the fork started from `v2.8.0`). To take a newer release, merge
  its tag into a branch and open a pull request; the merge keeps the patches' history.
- **Image:** `ghcr.io/oliviacpu/tracearr:<tag>`, built for linux/amd64 by `.github/workflows/fork.yml` when an
  `oliviacpu-*` tag is pushed, after lint, typecheck and the server tests pass. That workflow is the fork's only one:
  upstream's publish its images and releases, run its bots and need its secrets.
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
