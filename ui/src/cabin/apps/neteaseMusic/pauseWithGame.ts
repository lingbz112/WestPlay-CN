import { type MusicPlayer, pauseMusicWithGame } from '../musicWithGame'
import { neteaseMusic, pauseNow, playingNow, resumeNow, setVolume, skip, useNeteaseMusic } from './neteaseMusic'

/** NetEase Cloud Music as one of the cab's players (musicWithGame.ts, oneAtATime.ts). */
export const neteaseMusicPlayer: MusicPlayer = {
  name: 'netease music',
  playingHere: playingNow,
  pauseHere: pauseNow,
  resumeHere: resumeNow,
  skipHere: skip,
  volume: () => useNeteaseMusic.getState().playback?.volume ?? null,
  sendVolume: (share) => neteaseMusic({ action: 'volume', percent: Math.round(share * 100) }),
  setVolume: (share) => setVolume(share, true),
  // Started: playing, its sound come (asked to play, it shows playing at once, loading until NetEase
  // confirms: the fade in waits for that).
  subscribe: (changed) =>
    useNeteaseMusic.subscribe((music, before) => {
      const sounding = (playback: typeof music.playback) => Boolean(playback?.playing && !playback.loading)
      changed(sounding(music.playback) && !sounding(before.playback))
    }),
}

/** Apple Music with the game (musicWithGame.ts). Returns the function that stops it. */
export function pauseNeteaseMusicWithGame(): () => void {
  return pauseMusicWithGame(neteaseMusicPlayer)
}
