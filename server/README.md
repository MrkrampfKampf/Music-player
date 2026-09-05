# Converter server

A small service that turns a link into an audio file the player can import.
The phone can fetch direct media links on its own; this handles everything
else.

It has **no npm dependencies**. It is Node's own HTTP server, `ffmpeg`, and an
external extractor that it runs as a subprocess.

---

## Deploying it from your phone

You do not need a computer for this. Render's free tier works, builds straight
from this repository, and is set up entirely in a browser.

1. Sign in at **render.com** with your GitHub account.
2. **New → Web Service**, and pick this repository.
3. Set **Root Directory** to `server`, and **Runtime** to `Docker`. Render
   finds the Dockerfile on its own.
4. Choose the **Free** instance type.
5. Under Environment, add:
   - `ACCESS_TOKEN` — a long random string. Make one up; 30+ characters.
   - `ALLOWED_ORIGINS` — your Pages address with no trailing slash, for
     example `https://yourname.github.io`.
6. Create the service and wait for the first build. It takes a few minutes
   because the image installs ffmpeg and the extractor.
7. Copy the service address, something like
   `https://resonate-converter.onrender.com`.
8. In the app: **Settings → Converter server**. Paste the address, paste the
   same token, then tap **Test connection**.

There is a `render.yaml` blueprint in this folder if you would rather use
Render's Blueprints flow, and a `fly.toml` for Fly.io.

> **Free tier caveats.** A free Render service sleeps after 15 minutes idle, so
> the first conversion after a quiet spell waits about a minute for the machine
> to wake. Free hosts also share datacentre IP addresses, and some sites block
> those, which shows up as "the source is blocking this server". A machine at
> home on your own connection does not have that problem.

## Running it at home

With Docker:

```sh
cd server
ACCESS_TOKEN=$(openssl rand -hex 24) docker compose up -d --build
```

Without Docker, you need Node 20+, `ffmpeg`, and an extractor on your PATH:

```sh
cd server
ACCESS_TOKEN=your-long-random-token npm start
```

The app calls the server from a page served over HTTPS, so the server must be
HTTPS too. A browser will not let an HTTPS page call a plain HTTP address. If
you host it at home, put it behind a tunnel that terminates TLS for you
(Cloudflare Tunnel and Tailscale Funnel both do, free).

---

## Configuration

Every setting is an environment variable. See `.env.example`.

| Variable | Default | What it does |
|---|---|---|
| `ACCESS_TOKEN` | *(empty)* | Shared secret. **Set this.** Without it, anyone who finds the URL can run conversions on your machine. |
| `ALLOWED_ORIGINS` | `*` | Comma-separated origins allowed to call the server. Narrow this to your Pages origin once things work. |
| `EXTRACTOR` | `yt-dlp` | The program that turns a page URL into a stream URL. Anything that speaks yt-dlp's `--dump-single-json` output works. |
| `EXTRACTOR_ARGS` | *(empty)* | Extra arguments passed to it, space separated. |
| `FFMPEG` | `ffmpeg` | Path to ffmpeg. |
| `PORT` | `8080` | Listen port. |
| `MAX_DURATION` | `10800` | Refuse anything longer, in seconds. |
| `MAX_PLAYLIST_ITEMS` | `100` | Cap on how many entries a playlist link may expand to. |
| `MAX_CONCURRENT` | `2` | Simultaneous conversions. Set to 1 on a free instance. |
| `RATE_LIMIT_PER_MINUTE` | `20` | Requests per IP per minute. |
| `EXTRACTOR_TIMEOUT_MS` | `90000` | How long to wait for the extractor. |
| `CONVERT_TIMEOUT_MS` | `1200000` | How long to wait for ffmpeg. |

### Choosing an extractor

The server deliberately knows nothing about any particular website. It runs the
program named by `EXTRACTOR`, reads JSON from it, and hands the stream URL to
ffmpeg. The Docker image installs `yt-dlp` because it is the common choice, but
you can point `EXTRACTOR` at anything that emits the same JSON shape.

That means what your server can reach, and whether reaching it is appropriate,
is your decision rather than something baked into this code.

---

## API

All endpoints need `Authorization: Bearer <ACCESS_TOKEN>` when a token is set.

### `GET /api/health`

```json
{
  "ok": true,
  "version": "1.0.0",
  "extractor": "yt-dlp 2026.01.01",
  "ffmpeg": "ffmpeg version 6.1",
  "tokenRequired": true,
  "maxDurationSeconds": 7200,
  "inFlight": 0,
  "qualities": ["original", "mp3_320", "mp3_v0", "m4a_256"]
}
```

### `POST /api/resolve`

```json
{ "url": "https://example.com/something" }
```

Returns what is behind the link without downloading audio:

```json
{
  "type": "track",
  "title": "Stub Song",
  "items": [{
    "id": "z9",
    "title": "Stub Song",
    "artist": "Stub Artist",
    "album": "",
    "duration": 123,
    "thumbnail": "https://.../z9.jpg",
    "webpageUrl": "https://example.com/something"
  }]
}
```

`type` is `playlist` when the link expands to more than one item.

### `POST /api/convert`

```json
{ "url": "https://example.com/something", "quality": "original" }
```

Streams the audio back. Metadata rides along in response headers, base64
encoded because HTTP headers cannot carry UTF-8:

- `X-Media-Title`, `X-Media-Artist`, `X-Media-Album`, `X-Media-Filename`
- `X-Media-Profile` — the profile actually used
- `X-Media-Downgraded` — `1` when Original had to re-encode after all
- `X-Media-Duration` — seconds

Errors come back as `{ "error": "...", "hint": "..." }` with a real status
code: 400 for a bad URL, 401 for auth, 413 for too long, 429 for rate limiting,
502 when the extractor fails, 503 when busy, 504 on timeout.

---

## Safety

- **Token auth**, compared in constant time so it cannot be guessed a byte at
  a time.
- **No private network access.** URLs pointing at loopback, RFC 1918 ranges,
  carrier-grade NAT, link-local (`169.254.0.0/16`, which is where cloud
  metadata services live) and `.internal` names are refused. Without this, an
  open converter is a way to read a host's own metadata service.
- **Rate limiting** per IP, and a concurrency cap, so one caller cannot pin
  the CPU.
- **Duration and playlist caps**, so a single link cannot tie the server up
  for hours.
- **Timeouts** on both the extractor and ffmpeg, with the child killed on
  expiry and when the client hangs up mid-download.
- **Runs as a non-root user** in the container, with `tini` reaping ffmpeg
  children.

## Tests

```sh
npm test
```

Starts the real server against a stub extractor and checks auth, CORS, the URL
guards, resolve, error mapping and the length limit. 34 assertions, no network
needed.
