import { describe, expect, it } from 'vitest'
import { languageOf, STRINGS } from './strings'

describe("the cabin's language", () => {
  it("is the game's: Turkish, Chinese, or English", () => {
    expect(languageOf('tr_tr')).toBe('tr')
    expect(languageOf('zh_cn')).toBe('zh')
    // Traditional reads as simplified for now.
    expect(languageOf('zh_tw')).toBe('zh')
    expect(languageOf('en_gb')).toBe('en')
    expect(languageOf('de_de')).toBe('en')
    expect(languageOf(null)).toBe('en')
  })

  it('speaks Chinese in the Settings pages and Maps, English elsewhere yet', () => {
    expect(STRINGS.zh.settings.appearance).toBe('外观')
    expect(STRINGS.zh.settings.advanced).toBe('高级均衡器')
    expect(STRINGS.zh.settings.soundDetail).toBe('声音设置')
    expect(STRINGS.zh.destinations.go).toBe('出发')
    expect(STRINGS.zh.apps.maps).toBe('地图')
    // Not translated yet: these take English's words.
    expect(STRINGS.zh.keyboard).toBe(STRINGS.en.keyboard)
    expect(STRINGS.zh.apps.music).toBe(STRINGS.en.apps.music)
    // Numbers keep the point.
    expect(STRINGS.zh.decimal).toBe('.')
  })
})
