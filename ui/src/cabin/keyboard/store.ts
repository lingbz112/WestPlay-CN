import { create } from 'zustand'
import type { TypedEvent, TypingState } from '../../shared/host'
import type { Language } from './layouts'
import { initialKeyboard, type KeyboardState, press, withoutLastWord } from './editing'
import type { Key, ReturnKind } from './layouts'
import { candidatesFor, type Composing, isPinyinLetter, typedPinyin } from './pinyin'

/** The text field being typed into: how to read and change its text, and what its return key does. */
export interface Typing {
  id: string
  returnKind: ReturnKind
  read(): string
  write(text: string): void
  submit(): void
}

interface KeyboardStore {
  /** The field the keyboard types into, `null` when the keyboard is away. */
  field: Typing | null
  /** Chinese being typed in pinyin: the letters so far and what they may become (`pinyin.ts`); `null` when
   * nothing is being composed. */
  composing: Composing | null
  /** That field's selection: a number that changes with every selection (0: none), so the player's own
   * keyboard types only into a field selected while the truck stood still (the game plugin decides). */
  selection: number
  keys: KeyboardState
  /** The language the player switched the keyboard to (the globe key), for the rest of the session. */
  chosen: Language | null
  /** Whether the player's own keyboard types into the field (the host says). */
  physical: TypingState
  /** The last character typed on the player's own keyboard, for its key to light up (a new `id` each). */
  flash: { char: string; id: number } | null
  /** Starts typing into `field` (selecting it): the keyboard comes up, in `language` (the game's) unless
   * the player switched it. */
  attach(field: Typing, language: Language): void
  /** Stops typing into the field `id`, if the keyboard types into it: the keyboard goes away. */
  detach(id: string): void
  /** A key of the keyboard, pressed at `at` (ms). */
  press(key: Key, at?: number): void
  /** What the player typed on their own keyboard. */
  typed(event: TypedEvent): void
}

let selections = 0

export const useKeyboard = create<KeyboardStore>()((set, get) => {
  /** Types `letter` on to the pinyin composition, starting one at the field's end, and shows it in the field. */
  const typeLetter = (letter: string) => {
    const { field, composing } = get()
    if (!field) return
    const started: Composing = composing ?? { before: field.read(), buffer: '', candidates: [] }
    const typed = typedPinyin(started, letter.toLowerCase())
    set({ composing: typed })
    field.write(typed.before + typed.buffer)
  }
  /** Puts `candidate` in the field where the composition is, ending it. */
  const commit = (candidate: string) => {
    const { field, composing } = get()
    if (!field || !composing) return
    field.write(composing.before + candidate)
    set({ composing: null })
  }
  /** Drops the pinyin letters being composed, leaving the field as it was before them (the keyboard switched, or
   * put away, mid-word). */
  const cancelPinyin = () => {
    const { field, composing } = get()
    if (!field || !composing) return
    field.write(composing.before)
    set({ composing: null })
  }
  const choosePinyin = (index: number) => {
    const candidate = get().composing?.candidates[index]
    if (candidate) commit(candidate)
  }
  /** Delete on a composition: a letter off it; none left, the composition goes and the letters with it. */
  const trimPinyin = () => {
    const { field, composing } = get()
    if (!field || !composing) return
    const buffer = composing.buffer.slice(0, -1)
    if (!buffer) {
      field.write(composing.before)
      set({ composing: null })
      return
    }
    const next = { ...composing, buffer, candidates: candidatesFor(buffer) }
    set({ composing: next })
    field.write(next.before + buffer)
  }

  return {
  field: null,
  composing: null,
  selection: 0,
  keys: initialKeyboard('en'),
  chosen: null,
  physical: 'off',
  flash: null,
  // A newly selected field starts on the letters, in the game's language (or the one the player switched to
  // with the globe key, which stays for the session); one selected again keeps the keyboard as it was. Either
  // way it's a new selection, which the player's own keyboard may type into.
  attach: (field, language) => {
    const { field: current, chosen } = get()
    const selection = ++selections
    if (current?.id === field.id) set({ field, selection })
    else set({ field, selection, keys: initialKeyboard(chosen ?? language), composing: null })
  },
  detach: (id) => {
    if (get().field?.id !== id) return
    cancelPinyin()
    set({ field: null, selection: 0, composing: null })
  },
  press: (key, at = performance.now()) => {
    const { field, keys, composing } = get()
    if (!field) return
    // Chinese: a letter is part of the pinyin being composed, a digit picks one of its candidates, space takes
    // the first, and delete takes a letter off it (Keyboard/pinyin.ts).
    if (keys.language === 'zh' && keys.layer === 'letters') {
      if (key.kind === 'char' && isPinyinLetter(key.char)) return typeLetter(key.char)
      if (composing) {
        if (key.kind === 'char' && /^[1-9]$/.test(key.char)) return choosePinyin(Number(key.char) - 1)
        if (key.kind === 'space') return choosePinyin(0)
        if (key.kind === 'delete') return trimPinyin()
        // Return searches for the first candidate; another keyboard, or the keyboard put away, drops the
        // letters typed so far, as iOS does (they'd otherwise sit in the field as pinyin).
        if (key.kind === 'return') choosePinyin(0)
        else if (key.kind === 'globe' || key.kind === 'hide') cancelPinyin()
      }
    }
    const before = field.read()
    const outcome = press(keys, before, key, at)
    const away = outcome.hide || outcome.submit
    set({
      keys: outcome.state,
      chosen: key.kind === 'globe' ? outcome.state.language : get().chosen,
      field: away ? null : field,
      selection: away ? 0 : get().selection,
      // As the pinyin above left it: it may have been committed, dropped or trimmed since this press began.
      composing: away ? null : get().composing,
    })
    if (outcome.text !== before) field.write(outcome.text)
    if (outcome.submit) field.submit()
  },
  typed: (event) => {
    const { field, flash, keys, composing } = get()
    if (!field) return
    if ('text' in event) {
      // The player's own keyboard types into the same pinyin composition while the keyboard is Chinese.
      if (keys.language === 'zh' && keys.layer === 'letters' && event.text.length === 1) {
        if (isPinyinLetter(event.text)) {
          typeLetter(event.text)
          set({ flash: { char: event.text, id: (flash?.id ?? 0) + 1 } })
          return
        }
        if (composing && /^[1-9]$/.test(event.text)) {
          choosePinyin(Number(event.text) - 1)
          return
        }
        if (composing && event.text === ' ') {
          choosePinyin(0)
          return
        }
      }
      set({ composing: null })
      field.write(field.read() + event.text)
      set({ flash: { char: event.text.slice(-1), id: (flash?.id ?? 0) + 1 } })
      return
    }
    switch (event.key) {
      case 'backspace':
        get().press({ kind: 'delete' })
        break
      case 'wordBackspace':
        field.write(withoutLastWord(field.read()))
        break
      case 'enter':
        get().press({ kind: 'return' })
        break
      case 'escape':
        get().press({ kind: 'hide' })
        break
    }
  },
  }
})
