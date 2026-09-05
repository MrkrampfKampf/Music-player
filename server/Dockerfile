# Converter server: Node for the HTTP layer, ffmpeg for the audio, and a
# yt-dlp compatible extractor for turning a page URL into a stream URL.
FROM node:22-alpine

RUN apk add --no-cache ffmpeg python3 py3-pip ca-certificates tini \
  && python3 -m pip install --break-system-packages --no-cache-dir yt-dlp \
  && yt-dlp --version && ffmpeg -version | head -1

WORKDIR /app
COPY package.json ./
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Do not run as root, and reap zombie ffmpeg children properly.
RUN addgroup -S app && adduser -S app -G app
USER app

HEALTHCHECK --interval=60s --timeout=10s --start-period=15s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/" > /dev/null || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
