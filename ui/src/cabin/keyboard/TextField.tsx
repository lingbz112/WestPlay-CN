import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLanguage, useText } from '../state/text'
import { keyboardLanguage, type ReturnKind } from './layouts'
import { type Typing, useKeyboard } from './store'

interface TextFieldProps {
  /** Unique among the fields on screen. */
  id: string
  value: string
  onChange(value: string): void
  /** The return key (on-screen or the player's own). */
  onSubmit?(): void
  returnKind?: ReturnKind
  /** What the field is for, shown while it's empty. */
  hint: string
  /** Its name for screen readers. */
  label: string
  /** A symbol before the text (search's magnifier). */
  icon?: ReactNode
  /** Selected as it comes (Safari's address field, pressed: typed into at once, the keyboard up). */
  autoSelect?: boolean
}

/** Where the candidates of a pinyin composition go: in the screen's own pixels, under the field they belong to. */
interface CandidatePlace {
  /** The screen they're drawn in (`.shell`: its glass's colours and its own pixels are there). */
  host: HTMLElement
  left: number
  top: number
  maxWidth: number
}

/** Under `element` (the field, where the caret is), in the screen it's drawn in. A panel of the field's own would
 * be clipped by the bars the field sits in; the screen the cab draws may be scaled, so the pixels are its own. */
function placeUnder(element: HTMLElement | null): CandidatePlace | null {
  const host = element?.closest<HTMLElement>('.shell')
  if (!element || !host) return null
  const outer = host.getBoundingClientRect()
  const inner = element.getBoundingClientRect()
  const scale = outer.width / host.offsetWidth || 1
  const left = (inner.left - outer.left) / scale
  return {
    host,
    left,
    top: (inner.bottom - outer.top) / scale + 8,
    maxWidth: outer.width / scale - left - 12,
  }
}

/**
 * A field the keyboard types into. Not an `<input>`: the page never has the PC's keyboard (the game does),
 * so WestPlay draws its own field, caret and all, and the keyboard (store.ts) writes into it. Pressing it
 * selects it and brings the keyboard up; it lets go when it leaves the screen.
 *
 * While pinyin is being composed, its candidates show under the field (over the screen, not in the keyboard):
 * picked by their number on the player's own keyboard, or by a tap.
 */
export function TextField({
  id,
  value,
  onChange,
  onSubmit,
  returnKind = 'done',
  hint,
  label,
  icon,
  autoSelect = false,
}: TextFieldProps) {
  const text = useText()
  const typing = useKeyboard((state) => state.field?.id === id)
  const language = keyboardLanguage(useLanguage())

  // The newest props, for the keyboard to call; and the text as last written, so keys pressed faster than
  // the page redraws (the player's own keyboard) each build on the one before.
  const latest = useRef({ onChange, onSubmit })
  const current = useRef(value)
  useLayoutEffect(() => {
    latest.current = { onChange, onSubmit }
    current.current = value
  })
  const field = useMemo<Typing>(
    () => ({
      id,
      returnKind,
      read: () => current.current,
      write: (next) => {
        current.current = next
        latest.current.onChange(next)
      },
      submit: () => latest.current.onSubmit?.(),
    }),
    [id, returnKind],
  )
  const select = () => useKeyboard.getState().attach(field, language)

  useEffect(() => () => useKeyboard.getState().detach(field.id), [field])
  useEffect(() => {
    if (autoSelect) select()
  }, [])

  // Chinese: what the pinyin typed so far may become, just under the field (where the caret is).
  const composing = useKeyboard((state) => (state.field?.id === id ? state.composing : null))
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<CandidatePlace | null>(null)
  const placeCandidates = () => setPlace(placeUnder(box.current))
  useLayoutEffect(placeCandidates, [composing, value])
  useEffect(() => {
    // The screen may be laid out again (another look, a truck's own screen): the field moves with it.
    window.addEventListener('resize', placeCandidates)
    return () => window.removeEventListener('resize', placeCandidates)
  })

  // A long text shows its end, where the typing is.
  const shown = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    if (shown.current) shown.current.scrollLeft = shown.current.scrollWidth
  }, [value, typing])

  return (
    <div
      ref={box}
      className={typing ? 'text-field typing' : 'text-field'}
      role="textbox"
      aria-label={label}
      onPointerDown={(event) => {
        if (event.button === 0) select()
      }}
    >
      {icon}
      <span ref={shown} className="text-field-text">
        {value}
        {typing && <span className="text-field-caret" aria-hidden />}
        {!value && <span className="text-field-hint">{hint}</span>}
      </span>
      {value && (
        <button
          type="button"
          tabIndex={-1}
          className="text-field-clear"
          aria-label={text.keyboard.clear}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            current.current = ''
            onChange('')
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {composing &&
        place &&
        composing.candidates.length > 0 &&
        createPortal(
          <div
            className="text-field-candidates"
            role="listbox"
            aria-label="候选词"
            style={{ left: place.left, top: place.top, maxWidth: place.maxWidth }}
          >
            {composing.candidates.map((candidate, index) => (
              <button
                key={`${index}:${candidate}`}
                type="button"
                tabIndex={-1}
                className="text-field-candidate"
                role="option"
                aria-selected={false}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => useKeyboard.getState().press({ kind: 'char', char: String(index + 1) })}
              >
                <span className="text-field-candidate-number">{index + 1}</span>
                <span className="text-field-candidate-word">{candidate}</span>
              </button>
            ))}
          </div>,
          place.host,
        )}
    </div>
  )
}
