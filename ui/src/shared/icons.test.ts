import { describe, expect, it } from 'vitest'
import { type AppIconRole, appIcon } from './icons'

// The icon files there are (public/icons/westplay), as Vite sees them.
const FILES = Object.keys(import.meta.glob('../../public/icons/westplay/*.svg')).map((path) =>
  path.replace('../../public', ''),
)

const ROLES: AppIconRole[] = [
  'maps',
  'music',
  'qqMusic',
  'neteaseMusic',
  'spotify',
  'podcasts',
  'messages',
  'phone',
  'settings',
  'weather',
  'youtube',
  'youtubeMusic',
]

describe('appIcon', () => {
  it('gives every role WestPlay’s icon in the look asked for, and each file is there', () => {
    for (const role of ROLES) {
      for (const look of ['light', 'dark'] as const) {
        if (role !== 'qqMusic' && role !== 'neteaseMusic') expect(FILES).toContain(appIcon(role, look))
      }
    }
    expect(appIcon('youtubeMusic', 'dark')).toBe('/icons/westplay/youtube-music.dark.svg')
    expect(appIcon('qqMusic', 'dark')).toBe('/icons/westplay/qq-music-official.dark.webp')
    expect(appIcon('neteaseMusic', 'dark')).toBe('/icons/westplay/netease-music-official.dark.png')
  })
})
