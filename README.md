# Resonate

An offline music and video player for your iPhone that plays your own files.
No account, no subscription, no ads, and nothing leaves your device.

It installs from Safari to your Home Screen, runs full screen with its own
icon, and works with no signal. There is no Mac, Xcode or Apple developer
account involved, and it never expires.

---

## Getting it on your iPhone

**1. Publish it.** On GitHub, open this repository's **Settings → Pages**. Under
"Build and deployment" set Source to **Deploy from a branch**, pick `main` and
the **/ (root)** folder, then Save. A minute later Pages gives you the address:

```
https://mrkrampfkampf.github.io/Music-player/
```

**2. Install it.** Open that address in **Safari** on your iPhone. Tap the
Share button, scroll down, tap **Add to Home Screen**, then **Add**.

**3. Open it from the Home Screen icon**, not from Safari. That is what gives
you the full-screen app, the lock-screen controls, and durable storage.

Then tap **Add** and choose files, or paste a link.

> Use Safari for the install. Chrome and Firefox on iOS cannot add a web app to
> the Home Screen, because iOS only lets Safari do it.

---

## What it does

**Your files, untouched.** Import MP3, M4A, AAC, WAV, FLAC, AIFF, ALAC, Ogg and
Opus, plus MP4, M4V and MOV video. Files are copied in exactly as they are and
never re-encoded, so a 24-bit/96 kHz master stays a 24-bit/96 kHz master.

**Bit-perfect playback by default.** Audio goes straight from the file to the
output with nothing in the signal path. The equaliser and crossfade are off
until you turn them on, because routing audio through the browser's mixer
resamples it. Settings tells you which mode you are in.

**Real metadata.** Titles, artists, albums, track numbers, years, genres and
embedded cover art are read out of the files themselves, across every format
above. No filenames-as-titles unless a file genuinely has no tags.

**The features you actually use.**

| | |
|---|---|
| Library | Songs, albums, artists, genres, videos, playlists |
| Liked Songs | Heart anything; converted links land here automatically |
| Now Playing | Full screen, scrubber, drag down to dismiss, colour taken from the album art |
| Up Next | See the queue, reorder it by dragging, play next, add to queue |
| Lyrics | Synced `.lrc` that follows the song, or plain text |
| Search | Instant, across titles, artists, albums and genres |
| Equaliser | Ten bands, twenty presets, preamp |
| Crossfade | 2 to 12 seconds |
| Sleep timer | By minutes, or at the end of the current song |
| Speed | 0.5x to 2x |
| Lock screen | Play, pause, skip and scrub from the Lock Screen and Control Centre |
| Quality badges | Lossless and Hi-Res markers, full format details per track |

**Everything stays on your phone.** No account, no sync, no analytics. Ask iOS
to protect your library in Settings → Storage so it is not cleared when space
runs low.

---

## Adding music from a link

Open the **Add** tab and paste a link.

**Links that point straight at a file** (anything ending in `.mp3`, `.m4a`,
`.wav`, `.flac`, `.mp4` and so on) are downloaded by the phone itself. Nothing
else is needed.

**Everything else needs the converter server**, a small service you run
yourself. Setting it up takes about five minutes and can be done entirely from
your phone. See **[server/README.md](server/README.md)**.

### About Spotify

Spotify audio is DRM encrypted. It cannot be converted to MP3 by this app or by
any other tool, and that is a technical wall rather than a policy one. What the
converter can do with a Spotify link is read its **track list** and then find
each song from a source that is not encrypted. Matches are usually right but
are not guaranteed to be the same master.

### What you are responsible for

The converter runs whichever extraction tool you point it at, against whichever
links you feed it. Many sites' terms do not permit downloading, and most music
is copyrighted. Converting things you own, things published under a licence
that allows it, and your own uploads is on solid ground. Beyond that, it is
your call and your responsibility.

---

## Quality settings

The converter offers four profiles. The default never re-encodes.

| Profile | What happens |
|---|---|
| **Original** | The source audio is copied into an `.m4a` container byte for byte. No quality loss at all. Falls back to AAC 256 only when the source codec cannot live in an MP4, which is the case for Opus and Vorbis. |
| MP3 320 | Re-encoded to constant 320 kbps. Most compatible, but a re-encode of already-lossy audio always loses a little. |
| MP3 V0 | Variable bitrate, around 245 kbps. Smaller than 320 at much the same quality. |
| AAC 256 | Re-encoded to 256 kbps AAC in `.m4a`. |

For the best sound, leave it on Original.

---

## Things worth knowing

**Volume.** iOS does not let a web app change the system volume, so use the
hardware buttons. The in-app slider only appears where it actually works.

**AirPlay.** Swipe down from the top-right for Control Centre and pick a
speaker there.

**Storage.** iOS gives web apps a generous but not unlimited allowance. Check
what you are using in Settings → Storage, and tap "Protect my library" so iOS
does not clear the app when space runs low. Adding to the Home Screen and
using the app regularly makes iOS much more willing to grant this.

**Private Browsing** blocks the storage the app needs. Use a normal window.

**Backups.** Settings → Storage → Export library details saves a JSON file of
your tracks, playlists and settings. The audio files themselves are not
included; keep those wherever you got them.

---

## Project layout

```
index.html            app shell
manifest.webmanifest  Home Screen metadata
sw.js                 service worker, caches the shell for offline use
css/styles.css        design system
js/
  main.js             bootstrap and routing
  db.js               IndexedDB: tracks, media blobs, artwork, playlists
  tags.js             metadata reader for every supported container
  player.js           playback engine, queue, Media Session
  library.js          import, grouping, playlists, search
  lyrics.js           .lrc parsing
  converter.js        link to library
  ui.js               shared components, artwork colour extraction
  views.js            browsing screens
  nowplaying.js       full screen player
  addview.js          the Add tab
  settings.js         preferences and the Settings screen
server/               the optional converter service
test/                 metadata parser tests
```

## Running the tests

```sh
node test/tags.test.mjs      # 68 assertions over the metadata parser
cd server && npm test        # 34 assertions over the converter server
```

The app itself has a browser test that imports real tagged audio, plays it,
and checks the library survives a reload. It needs Playwright:

```sh
npx http-server -p 8099 -c-1 .
node test/browser.test.mjs http://127.0.0.1:8099
```
