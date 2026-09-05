# Converter server: Node for the HTTP layer, ffmpeg for the audio, and a
# yt-dlp compatible extractor for turning a page URL into a stream URL.
#
# yt-dlp comes from pip rather than the Alpine package so it stays current.
# Sites change how they serve media constantly and a stale extractor is the
# most common reason a link stops working.
FROM node:22-alpine

RUN apk add --no-cache ffmpeg python3 py3-pip ca-certificates tini \
  && python3 -m pip install --break-system-packages --no-cache-dir yt-dlp \
  && yt-dlp --version && ffmpeg -version | head -1

# A real home directory: the extractor writes a cache there, and falling back
# to an unwritable path is a confusing way to fail on a read-only container.
RUN addgroup -S app \
  && adduser -S -h /home/app -G app app \
  && mkdir -p /home/app/.cache \
  && chown -R app:app /home/app

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=8080 \
    HOME=/home/app \
    XDG_CACHE_HOME=/home/app/.cache

EXPOSE 8080
USER app

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" > /dev/null || exit 1

# tini reaps the ffmpeg and extractor children rather than leaving zombies.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
