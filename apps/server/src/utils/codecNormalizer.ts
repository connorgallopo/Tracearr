/**
 * Codec Normalizer
 *
 * Normalizes video and audio codec names from various media servers (Plex, Jellyfin, Emby)
 * into consistent, display-friendly values for Tracearr analytics.
 *
 * Input formats vary by source:
 * - Plex: 'hevc', 'h264', 'ac3', 'eac3'
 * - Jellyfin/Emby: 'HEVC', 'H264', 'AC3', 'EAC3'
 * - FFmpeg style: 'h265', 'avc1', 'aac_latm'
 *
 * Output: Consistent display names like 'HEVC', 'H.264', 'AAC', 'Dolby TrueHD'
 */

/**
 * Normalize video codec to display-friendly name
 */
export function normalizeVideoCodec(codec: string | null | undefined): string {
  if (!codec) return 'Unknown';

  const lower = codec.toLowerCase().trim();

  // HEVC / H.265
  if (lower === 'hevc' || lower === 'h265' || lower === 'x265' || lower === 'hev1') {
    return 'HEVC';
  }

  // H.264 / AVC
  if (lower === 'h264' || lower === 'avc' || lower === 'avc1' || lower === 'x264') {
    return 'H.264';
  }

  // AV1
  if (lower === 'av1' || lower === 'av01') {
    return 'AV1';
  }

  // VP9
  if (lower === 'vp9' || lower === 'vp09') {
    return 'VP9';
  }

  // VP8
  if (lower === 'vp8') {
    return 'VP8';
  }

  // MPEG-4 (not H.264)
  if (lower === 'mpeg4' || lower === 'mp4v' || lower === 'divx' || lower === 'xvid') {
    return 'MPEG-4';
  }

  // MPEG-2
  if (lower === 'mpeg2' || lower === 'mpeg2video' || lower === 'mpg2' || lower === 'h262') {
    return 'MPEG-2';
  }

  // MPEG-1
  if (lower === 'mpeg1' || lower === 'mpeg1video' || lower === 'mpg1') {
    return 'MPEG-1';
  }

  // VC-1 (Windows Media Video 9 Advanced Profile)
  if (lower === 'vc1' || lower === 'vc-1' || lower === 'wvc1' || lower === 'wmv3') {
    return 'VC-1';
  }

  // WMV (older Windows Media)
  if (lower.startsWith('wmv')) {
    return 'WMV';
  }

  // Theora
  if (lower === 'theora') {
    return 'Theora';
  }

  // ProRes (Apple)
  if (lower.includes('prores')) {
    return 'ProRes';
  }

  // DNxHD/DNxHR (Avid)
  if (lower.includes('dnxh')) {
    return 'DNxHD';
  }

  // Return original (titlecased) if unknown
  return codec.toUpperCase();
}

/**
 * Normalize audio codec to display-friendly name
 */
export function normalizeAudioCodec(codec: string | null | undefined): string {
  if (!codec) return 'Unknown';

  const lower = codec.toLowerCase().trim();

  // AAC variants
  if (
    lower === 'aac' ||
    lower === 'aac_latm' ||
    lower === 'mp4a' ||
    lower === 'he-aac' ||
    lower === 'heaac'
  ) {
    return 'AAC';
  }

  // AC3 (Dolby Digital)
  if (lower === 'ac3' || lower === 'ac-3' || lower === 'a52') {
    return 'AC3';
  }

  // EAC3 (Dolby Digital Plus)
  if (
    lower === 'eac3' ||
    lower === 'ec-3' ||
    lower === 'ec3' ||
    lower === 'e-ac-3' ||
    lower === 'ddp'
  ) {
    return 'EAC3';
  }

  // Dolby TrueHD
  if (lower === 'truehd' || lower === 'mlp' || lower.includes('truehd')) {
    return 'TrueHD';
  }

  // Dolby Atmos (usually TrueHD or EAC3 with Atmos metadata)
  if (lower.includes('atmos')) {
    return 'Atmos';
  }

  // DTS variants
  if (lower === 'dts') {
    return 'DTS';
  }
  if (lower === 'dts-hd ma' || lower === 'dtshd_ma' || lower === 'dts-hd' || lower === 'dtshd') {
    return 'DTS-HD MA';
  }
  if (lower === 'dts-hd hra' || lower === 'dts-hd hi res' || lower === 'dtshd_hra') {
    return 'DTS-HD HRA';
  }
  if (lower === 'dts:x' || lower === 'dtsx') {
    return 'DTS:X';
  }

  // FLAC
  if (lower === 'flac') {
    return 'FLAC';
  }

  // ALAC (Apple Lossless)
  if (lower === 'alac') {
    return 'ALAC';
  }

  // MP3
  if (lower === 'mp3' || lower === 'mp3float' || lower === 'libmp3lame') {
    return 'MP3';
  }

  // Opus
  if (lower === 'opus') {
    return 'Opus';
  }

  // Vorbis
  if (lower === 'vorbis' || lower === 'libvorbis') {
    return 'Vorbis';
  }

  // PCM variants (uncompressed)
  if (lower.startsWith('pcm_') || lower === 'pcm' || lower === 'lpcm') {
    return 'PCM';
  }

  // WAV
  if (lower === 'wav') {
    return 'WAV';
  }

  // WMA
  if (lower.startsWith('wma') || lower === 'wmav2') {
    return 'WMA';
  }

  // Return original (uppercase) if unknown
  return codec.toUpperCase();
}

/**
 * Get canonical codec key for aggregation (lowercase, no spaces)
 * Used for grouping in database queries
 */
export function getVideoCodecKey(codec: string | null | undefined): string {
  return normalizeVideoCodec(codec)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Get canonical audio codec key for aggregation
 */
export function getAudioCodecKey(codec: string | null | undefined): string {
  return normalizeAudioCodec(codec)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Normalize audio channel count to display-friendly name
 */
export function normalizeAudioChannels(channels: number | null | undefined): string {
  if (channels === null || channels === undefined) return 'Unknown';

  switch (channels) {
    case 1:
      return 'Mono';
    case 2:
      return 'Stereo';
    case 3:
      return '2.1';
    case 4:
      return '4.0';
    case 5:
      return '4.1';
    case 6:
      return '5.1';
    case 7:
      return '6.1';
    case 8:
      return '7.1';
    case 10:
      return '7.1.2'; // Atmos common layout
    case 12:
      return '7.1.4'; // Atmos with 4 height channels
    case 16:
      return '7.1.4+'; // Extended Atmos
    default:
      if (channels > 8) {
        return `${channels}ch`; // e.g., "14ch"
      }
      return `${channels}ch`;
  }
}
