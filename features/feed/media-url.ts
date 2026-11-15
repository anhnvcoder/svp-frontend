// Playlist and thumbnail URLs come from the API. They are used only when they point at the media origin the server
// configured (MEDIA_ORIGIN, also the only media origin the CSP allows); anything else counts as a playback error and
// gets no poster.
export function isMediaUrl(value: string, mediaOrigin: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (url.protocol === "http:" || url.protocol === "https:") && url.origin === mediaOrigin;
}

const premiumPlaylist =
  /^\/api\/videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/playback\/master\.m3u8$/;

/**
 * Whether `value` is the full master playlist of a premium video on this origin (`premiumPlaylistPath` of api.ts): a
 * path, so it can only resolve to this server. Its segments are absolute URLs, still loaded only from the media origin
 * the CSP allows.
 */
export function isPremiumPlaylistPath(value: string): boolean {
  return premiumPlaylist.test(value);
}
