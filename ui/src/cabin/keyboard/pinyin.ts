/**
 * Chinese typed in pinyin, the way an IME does it: the letters typed so far are the composition, and the
 * candidates for them are shown above the keyboard (Keyboard.tsx), picked with the number keys or a tap.
 *
 * The dictionary is Rime's `pinyin_simp` (rime/rime-pinyin-simp, Apache-2.0), turned into
 * `pinyin-dict.json` by `tmp-dict/rime.mjs` at development time: whole words first (歌曲 for `gequ`), then
 * single characters for a syllable (`ge` → 个各格歌…), then the words that start with the letters, so a
 * half-typed syllable still offers something.
 */
import dictionary from './pinyin-dict.json'

export interface Composing {
  /** The field's text before the composition began. */
  before: string
  /** The letters typed so far, lowercase. */
  buffer: string
  /** What they may become, nine at most (the number keys pick them). */
  candidates: string[]
}

const WORDS: Record<string, string[]> = dictionary.words
/** A syllable's characters, one after another (`ge` → 个各格歌…). */
const CHARS: Record<string, string> = dictionary.chars
const KEYS = Object.keys(WORDS)

/** Whether `char` is a pinyin letter (ü is typed `v`, as on every pinyin keyboard). */
export function isPinyinLetter(char: string): boolean {
  return /^[a-z]$/.test(char)
}

/** The candidates for `buffer`, most used first, nine at most. */
export function candidatesFor(buffer: string): string[] {
  if (!buffer) return []
  const word = WORDS[buffer]
  if (word) return word.slice(0, 9)
  const syllable = CHARS[buffer]
  if (syllable) return [...syllable].slice(0, 9)
  const out: string[] = []
  for (const key of KEYS) {
    if (!key.startsWith(buffer)) continue
    for (const candidate of WORDS[key]) {
      if (!out.includes(candidate)) out.push(candidate)
      if (out.length >= 9) break
    }
    if (out.length >= 9) break
  }
  return out
}

/** The composition with `char` typed on to it. */
export function typedPinyin(composing: Composing, char: string): Composing {
  const buffer = composing.buffer + char
  return { ...composing, buffer, candidates: candidatesFor(buffer) }
}
