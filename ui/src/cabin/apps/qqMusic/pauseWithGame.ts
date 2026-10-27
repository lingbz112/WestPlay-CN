import { type MusicPlayer, pauseMusicWithGame } from '../musicWithGame'
import { pauseNow, playingNow, qqMusic, resumeNow, setVolume, skip, useQqMusic, volumeNow } from './qqMusic'

/** QQ Music as one of the cab's players (musicWithGame.ts, oneAtATime.ts). */
export const qqMusicPlayer: MusicPlayer = {
  name: 'qq music',
  playingHere: playingNow,
  pauseHere: pauseNow,
  resumeHere: resumeNow,
  skipHere: skip,
  volume: volumeNow,
  sendVolume: (share) => qqMusic({ action: 'volume', percent: Math.round(share * 100) }),
  setVolume: (share) => setVolume(share, true),
  // Started: playing, its sound come (asked to play, it shows playing at once, loading until Apple Music
  // confirms: the fade in waits for that).
  subscribe: (changed) =>
    useQqMusic.subscribe((music, before) => {
      const sounding = (playback: typeof music.playback) => Boolean(playback?.playing && !playback.loading)
      changed(sounding(music.playback) && !sounding(before.playback))
    }),
}

/** QQ Music with the game (musicWithGame.ts). Returns the function that stops it. */
export function pauseQqMusicWithGame(): () => void {
  return pauseMusicWithGame(qqMusicPlayer)
}
