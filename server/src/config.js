/** Configuration, all from the environment so nothing secret lives in git. */

const num = (value, fallback) => {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  port: num(process.env.PORT, 8080),
  host: process.env.HOST || '0.0.0.0',

  /**
   * Shared secret. When set, every request must carry
   * `Authorization: Bearer <token>`. Strongly recommended: a public server
   * without one is an open converter for anyone who finds the URL.
   */
  token: process.env.ACCESS_TOKEN || '',

  /** Comma separated list of allowed origins, or '*' for any. */
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),

  /**
   * The extractor that turns a page URL into a media stream URL. Anything
   * yt-dlp compatible works; point it at whatever you have installed.
   */
  extractor: process.env.EXTRACTOR || 'yt-dlp',
  extractorArgs: (process.env.EXTRACTOR_ARGS || '').split(' ').filter(Boolean),

  /**
   * A Netscape-format cookies.txt, base64 encoded, written to disk at boot and
   * handed to the extractor. Some sites answer a request from a datacentre
   * address by asking it to sign in; these are how the server signs in as you.
   *
   * Treat it like a password: it is your live session. Prefer a throwaway
   * account, since a site may invalidate or flag the session it belongs to.
   */
  cookiesB64: process.env.COOKIES_B64 || '',

  ffmpeg: process.env.FFMPEG || 'ffmpeg',

  /** Guard rails. A converter with no limits is a free CPU faucet. */
  maxDurationSeconds: num(process.env.MAX_DURATION, 3 * 60 * 60),
  maxPlaylistItems: num(process.env.MAX_PLAYLIST_ITEMS, 100),
  extractorTimeoutMs: num(process.env.EXTRACTOR_TIMEOUT_MS, 90_000),
  convertTimeoutMs: num(process.env.CONVERT_TIMEOUT_MS, 20 * 60_000),
  maxConcurrent: num(process.env.MAX_CONCURRENT, 2),
  rateLimitPerMinute: num(process.env.RATE_LIMIT_PER_MINUTE, 20),
};

export const VERSION = '1.0.0';
