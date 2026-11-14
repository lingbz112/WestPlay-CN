// Builds the cabin keyboard's pinyin dictionary from Rime's `pinyin_simp` (rime/rime-pinyin-simp, Apache-2.0):
// one line per word — `词<TAB>ge qu<TAB>weight` — which is exactly what an IME needs (词 + 拼音 + 词频).
//
//   curl -L https://codeload.github.com/rime/rime-pinyin-simp/tar.gz/refs/heads/master -o rime.tgz
//   tar -xzf rime.tgz
//   node ui/scripts/pinyin-dict.mjs rime-pinyin-simp-master/pinyin_simp.dict.yaml
//
// Writes ui/src/cabin/keyboard/pinyin-dict.json: { words: { pinyin: [词…] }, chars: { syllable: "字字…" } }.
// The output is committed, so a build needs neither this script nor the download.
import { readFileSync, writeFileSync } from 'node:fs'

const SOURCE = process.argv[2] ?? 'pinyin_simp.dict.yaml'
const OUT = 'ui/src/cabin/keyboard/pinyin-dict.json'
/** Candidates kept for a key (the keyboard shows nine; the rest are room for paging later). */
const KEEP = 18

const lines = readFileSync(SOURCE, 'utf8').split('\n')
const words = new Map()
const chars = new Map()
let inBody = false
for (const line of lines) {
  const text = line.replace(/\r$/, '')
  if (text.trim() === '...') {
    inBody = true
    continue
  }
  if (!inBody || !text || text.startsWith('#')) continue
  const [word, pinyin, weight] = text.split('\t')
  if (!word || !pinyin) continue
  const key = pinyin.trim().toLowerCase().replace(/[ ']/g, '')
  if (!/^[a-zü]+$/.test(key)) continue
  const at = Number(weight ?? 0) || 0
  const list = words.get(key) ?? []
  list.push({ text: word, at })
  words.set(key, list)
  if ([...word].length === 1) {
    const single = chars.get(key) ?? []
    single.push({ text: word, at })
    chars.set(key, single)
  }
}

/** A key's candidates, most used first, without repeats. */
function pack(map, join) {
  const out = {}
  for (const [key, list] of map) {
    list.sort((a, b) => b.at - a.at)
    const seen = new Set()
    const kept = []
    for (const { text } of list) {
      if (seen.has(text)) continue
      seen.add(text)
      kept.push(text)
      if (kept.length >= KEEP) break
    }
    if (kept.length) out[key] = join ? kept.join('') : kept
  }
  return out
}

const json = JSON.stringify({ words: pack(words, false), chars: pack(chars, true) })
writeFileSync(OUT, json)
console.log('keys', words.size, 'syllables', chars.size, 'bytes', json.length)
