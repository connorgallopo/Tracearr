import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sessions, serverUsers, servers, users } from '../../db/schema.js';
import { isLocalSession, readSessionRow } from '../../db/sessions/index.js';

/** One session joined to its account, identity and server, or undefined when there is none. */
export async function fetchSessionDetailRow(
  id: string,
  startedAt: Parameters<typeof readSessionRow>[1]
) {
  return readSessionRow(id, startedAt, (where) =>
    db
      .select({
        id: sessions.id,
        serverId: sessions.serverId,
        serverName: servers.name,
        serverType: servers.type,
        serverUserId: sessions.serverUserId,
        username: serverUsers.username,
        userThumb: serverUsers.thumbUrl,
        identityName: users.name,
        sessionKey: sessions.sessionKey,
        state: sessions.state,
        mediaType: sessions.mediaType,
        mediaTitle: sessions.mediaTitle,
        grandparentTitle: sessions.grandparentTitle,
        seasonNumber: sessions.seasonNumber,
        episodeNumber: sessions.episodeNumber,
        year: sessions.year,
        artistName: sessions.artistName,
        albumName: sessions.albumName,
        thumbPath: sessions.thumbPath,
        mediaId: sessions.mediaId,
        showMediaId: sessions.showMediaId,
        startedAt: sessions.startedAt,
        stoppedAt: sessions.stoppedAt,
        durationMs: sessions.durationMs,
        progressMs: sessions.progressMs,
        totalDurationMs: sessions.totalDurationMs,
        lastPausedAt: sessions.lastPausedAt,
        pausedDurationMs: sessions.pausedDurationMs,
        referenceId: sessions.referenceId,
        watched: sessions.watched,
        ipAddress: sessions.ipAddress,
        geoCity: sessions.geoCity,
        geoRegion: sessions.geoRegion,
        geoCountry: sessions.geoCountry,
        geoLat: sessions.geoLat,
        geoLon: sessions.geoLon,
        geoAsnNumber: sessions.geoAsnNumber,
        geoAsnOrganization: sessions.geoAsnOrganization,
        isLocal: sessions.isLocal,
        playerName: sessions.playerName,
        deviceId: sessions.deviceId,
        product: sessions.product,
        device: sessions.device,
        platform: sessions.platform,
        quality: sessions.quality,
        isTranscode: sessions.isTranscode,
        videoDecision: sessions.videoDecision,
        audioDecision: sessions.audioDecision,
        bitrate: sessions.bitrate,
        // Stream detail columns
        sourceVideoCodec: sessions.sourceVideoCodec,
        sourceAudioCodec: sessions.sourceAudioCodec,
        sourceAudioChannels: sessions.sourceAudioChannels,
        sourceVideoWidth: sessions.sourceVideoWidth,
        sourceVideoHeight: sessions.sourceVideoHeight,
        sourceVideoDetails: sessions.sourceVideoDetails,
        sourceAudioDetails: sessions.sourceAudioDetails,
        streamVideoCodec: sessions.streamVideoCodec,
        streamAudioCodec: sessions.streamAudioCodec,
        streamVideoDetails: sessions.streamVideoDetails,
        streamAudioDetails: sessions.streamAudioDetails,
        transcodeInfo: sessions.transcodeInfo,
        subtitleInfo: sessions.subtitleInfo,
      })
      .from(sessions)
      .innerJoin(serverUsers, eq(sessions.serverUserId, serverUsers.id))
      .innerJoin(servers, eq(sessions.serverId, servers.id))
      .leftJoin(users, eq(serverUsers.userId, users.id))
      .where(where)
      .limit(1)
      .then((rows) => rows[0])
  );
}

type SessionDetailRow = NonNullable<Awaited<ReturnType<typeof fetchSessionDetailRow>>>;

/** The detail row in the nested user and server shape the history rows use. */
export function mapSessionDetail(row: SessionDetailRow) {
  return {
    id: row.id,
    serverId: row.serverId,
    serverUserId: row.serverUserId,
    user: {
      id: row.serverUserId,
      username: row.username,
      thumbUrl: row.userThumb,
      identityName: row.identityName,
    },
    server: {
      id: row.serverId,
      name: row.serverName,
      type: row.serverType,
    },
    sessionKey: row.sessionKey,
    state: row.state,
    mediaType: row.mediaType,
    mediaTitle: row.mediaTitle,
    grandparentTitle: row.grandparentTitle,
    seasonNumber: row.seasonNumber,
    episodeNumber: row.episodeNumber,
    year: row.year,
    artistName: row.artistName,
    albumName: row.albumName,
    thumbPath: row.thumbPath,
    mediaId: row.mediaId,
    showMediaId: row.showMediaId,
    startedAt: row.startedAt,
    stoppedAt: row.stoppedAt,
    durationMs: row.durationMs,
    progressMs: row.progressMs,
    totalDurationMs: row.totalDurationMs,
    lastPausedAt: row.lastPausedAt,
    pausedDurationMs: row.pausedDurationMs,
    referenceId: row.referenceId,
    watched: row.watched,
    ipAddress: row.ipAddress,
    geoCity: row.geoCity,
    geoRegion: row.geoRegion,
    geoCountry: row.geoCountry,
    geoLat: row.geoLat,
    geoLon: row.geoLon,
    geoAsnNumber: row.geoAsnNumber,
    geoAsnOrganization: row.geoAsnOrganization,
    isLocal: isLocalSession(row),
    playerName: row.playerName,
    deviceId: row.deviceId,
    product: row.product,
    device: row.device,
    platform: row.platform,
    quality: row.quality,
    isTranscode: row.isTranscode,
    videoDecision: row.videoDecision,
    audioDecision: row.audioDecision,
    bitrate: row.bitrate,
    // Stream detail fields
    sourceVideoCodec: row.sourceVideoCodec,
    sourceAudioCodec: row.sourceAudioCodec,
    sourceAudioChannels: row.sourceAudioChannels,
    sourceVideoWidth: row.sourceVideoWidth,
    sourceVideoHeight: row.sourceVideoHeight,
    sourceVideoDetails: row.sourceVideoDetails,
    sourceAudioDetails: row.sourceAudioDetails,
    streamVideoCodec: row.streamVideoCodec,
    streamAudioCodec: row.streamAudioCodec,
    streamVideoDetails: row.streamVideoDetails,
    streamAudioDetails: row.streamAudioDetails,
    transcodeInfo: row.transcodeInfo,
    subtitleInfo: row.subtitleInfo,
  };
}
