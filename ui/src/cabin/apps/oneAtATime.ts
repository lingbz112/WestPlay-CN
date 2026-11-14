import type { MusicPlayer } from './musicWithGame'

/** The media player that last started playing here (its `MusicPlayer.name`), kept for the next start: the
 * radio plays its station again only when it was the one playing. */
const LAST_PLAYING_KEY = 'westplay.media.last'

/** The player that last started playing here (`null`: none yet). */
export function lastPlaying(): string | null {
  try {
    return localStorage.getItem(LAST_PLAYING_KEY)
  } catch {
    return null
  }
}

/**
 * One player at a time, as on a phone: when one of the cab's players (Apple Music, Spotify, YouTube Music, Player,
 * YouTube) starts playing here, the others playing here pause, and the newest plays on (owner 2026-10-21: a
 * player's report, Spotify and YouTube Music playing over each other). Music playing elsewhere (Spotify on a
 * phone) is left as it is. Returns the function that stops it.
 */
export function oneAtATime(players: readonly MusicPlayer[]): () => void {
  const stops = players.map((player) =>
    player.subscribe((started) => {
      if (!started) return
      try {
        localStorage.setItem(LAST_PLAYING_KEY, player.name)
      } catch {}
      for (const other of players) {
        if (other !== player && other.playingHere()) other.pauseHere()
      }
    }),
  )
  return () => {
    for (const stop of stops) stop()
  }
}
