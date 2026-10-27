# QQ Music POC

This branch (`qq-music-poc`) is an experiment: copy the Apple Music app, keep its pages and animations, and make
QQ Music's own web player the data source.

The original Apple Music app is untouched. QQ Music is a separate app in the Home grid, with a green icon and
the copied Music UI.

## What is implemented

- `ui/src/cabin/apps/qqMusic/` — a copy of `apps/music`, renamed and scoped to QQ Music.
- `crates/host/src/qq_music.rs` — the host bridge. It runs two hidden WebView2 pages:
  - a browser page for Home, search, playlists, artists, the Library and lyrics;
  - the standalone QQ Music player page for playback and the player's own controls.
- `crates/host/src/qq_music.js` — the page adapter. It answers the same `Question`/`Answer` shapes as Apple
  Music, reads QQ Music's DOM and JSON-LD, and drives the player's own buttons.
- `crates/host/src/qq_music_sign_in.js` — opens QQ Music's own sign-in dialog and reports only whether the
  page is signed in.
- The QQ Music messages (`qqMusic`, `qqMusicAnswer`, `qqMusicPlayback`) are wired through `shared/host.ts`,
  the cabin store, media keys, pause-with-game and one-player-at-a-time.

## How it works

```
QQ Music browser page ── questions / JSON-LD / DOM ──┐
                                                     ├─ host qq_music.rs ─ cabin QQ Music app
QQ Music player page ── playback state / controls ───┘
```

Search, Home and lyrics navigate the browser page; the player page is separate, so browsing does not stop
playback. A song is queued by visiting its QQ Music page and pressing its own Play button. The shared WebView2
profile then gives the queue to the player page.

## Tested

- `npm run build` — UI TypeScript and Vite build pass.
- `npm test` — all 449 UI tests pass.
- `cargo check -p westplay-host` — host compiles.
- `cargo test -p westplay-host qq_music --lib` — message parsing tests pass.
- Live y.qq.com adapter test (signed out):
  - Home returns 12 playlists, 20 new songs and 8 albums.
  - A real playlist page returns its name and server-rendered tracks.
  - A song page returns 42 lyric lines.
  - The player page returns the current track's name, artist, cover and duration.
- The queue handoff works: a song page writes QQ Music's own `playSongData`, and the separate player page
  reads it and shows the same song.
- Signed-in playback works in the Codex in-app browser: “再回首” advanced from 00:04 to 00:11; pause froze
  at 00:09 and resume continued; seeking jumped to 02:08.
- A playlist queued six playable songs; Next switched from “Morning Mood” to “Death of Åse”.
- Signed-in search for “周杰伦” returned ten song rows with title, artist, duration and song ids.
- Not tested in the real ETS2 host: the same authenticated path through WestPlay's WebView2 profile. The
  site behavior and the adapter's DOM mapping were tested in the in-app browser; the game host still needs
  its own sign-in and an in-game pass.

## Known limitations

- QQ Music only plays for a signed-in account. Click **Sign in** in the QQ Music app, scan QQ Music's own QR
  code on the PC, then try again. Nothing of the account is read by WestPlay.
- Without a signed-in account, search results may be empty and the player will not sound. This is QQ Music's
  own web behavior, not a WestPlay error.
- The server-rendered playlist page exposes only its first page of tracks (8 in the tested playlist). Loading
  the rest needs QQ Music's signed client requests; that is the next piece to add if full long playlists are
  required.
- QQ Music's signed-in web player did not expose an `HTMLAudioElement` in the tested mode. It plays through
  its own engine, and the page's time/controls work, but `cab_sound.js` has no media element to attach to:
  the truck-speaker spatial audio and spectrum are skipped. Adding that needs an audio-capture route (for
  example Web Audio interception or system loopback), not just another DOM selector.
- Two hidden WebView2 pages are used for QQ Music (browse and player), so it costs more memory than a single
  page. That is the price of searching without stopping playback.
- QQ Music changes its DOM; the selectors in `qq_music.js` are intentionally broad but will need maintenance.
- This is a POC, not a production integration. It does not add QQ Music to the companion's account settings
  or the play log's service list.
- This is an unofficial integration. QQ Music's terms, account rules and content rights still apply; do not
  redistribute audio or account data.

## Try it

From this repository:

```powershell
npm install
npm run dev
```

To build the game plugin and host, follow the upstream README (`cargo build --release -p westplay-plugin`).
The UI preview alone (`ui` Vite server) shows the copied app with demo content; real QQ data needs the host,
WebView2 and ETS2 running.

## Revert

The experiment is isolated on the `qq-music-poc` branch. Return to the upstream app with:

```powershell
git checkout main
```
