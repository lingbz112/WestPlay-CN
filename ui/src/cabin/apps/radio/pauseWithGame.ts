import { type MusicPlayer, pauseMusicWithGame } from '../musicWithGame'
import { pauseNow, playingNow, resumeNow, sendVolume, setVolume, skip, useRadio } from './radio'

/** The radio as one of the cab's players (musicWithGame.ts, oneAtATime.ts). */
export const radioPlayer: MusicPlayer = {
  name: 'radio',
  playingHere: playingNow,
  pauseHere: pauseNow,
  resumeHere: resumeNow,
  skip,
  volume: () => useRadio.getState().volume,
  sendVolume,
  setVolume: (share) => setVolume(share, true),
  // Started: playing, its stream come (asked to play, it shows playing at once, loading until the page
  // confirms: the fade in waits for that).
  subscribe: (changed) =>
    useRadio.subscribe((radio, before) => {
      const sounding = (state: typeof radio) => state.playing && !state.loading
      changed(sounding(radio) && !sounding(before))
    }),
}

/** The radio with the game (musicWithGame.ts). Returns the function that stops it. */
export function pauseRadioWithGame(): () => void {
  return pauseMusicWithGame(radioPlayer)
}
