import { type CSSProperties, type PointerEvent, type ReactNode, useEffect, useRef, useState } from 'react'
import { NoteGlyph, PauseGlyph, PlayGlyph } from '../music/glyphs'
import { useNowPlayingTrack } from '../../dashboard/useNowPlaying'
import { smoothThrough } from './curve'
import { useWallpapers } from '../../state/looks'
import { pickVariant, prepareWallpaper } from '../../wallpapers'
import { type Appearance, resolveAppearance } from '../../state/appearance'
import { useLook, useScreenProfile } from '../../state/hooks'
import { DASHBOARD_WIDGETS, type DashboardWidget, useCabin, useLive } from '../../state/store'
import { useText } from '../../state/text'
import { TEXT_SIZES } from '../../state/textSize'
import {
  AppearanceGlyph,
  CheckGlyph,
  ChevronGlyph,
  DashboardGlyph,
  NowPlayingGlyph,
  SoundGlyph,
  WallpaperGlyph,
} from './glyphs'
import { type SettingsPage, useSettings } from './settings'
import './settings.css'
import {
  cabClock,
  BASS_CUTOFF,
  CABIN_CHARACTERS,
  type CabinCharacter,
  EQUALIZER_BANDS,
  EQUALIZER_MOST,
  GRAPHIC_BANDS,
  GRAPHIC_FREQUENCIES,
  GRAPHIC_MOST,
  isInHost,
  postToHost,
} from '../../../shared/host'

/**
 * The Settings app, in iOS 26's Settings look: a large title, inset grouped cards, coloured tiles, chevrons
 * and pill switches, in Apple's colours (shell/apple.css). Only the player's own CarPlay choices live here;
 * WestPlay's management (the cab's sound, the companion's options) belongs to the companion window.
 *
 * Appearance (with Text Size), Wallpaper, the Dashboard's widgets, Now Playing's album art and the Equalizer.
 */
export function SettingsApp() {
  const text = useText()
  const page = useSettings((state) => state.page)
  const went = useSettings((state) => state.went)
  // Opened again, the page it was left on comes with the window, without a slide of its own.
  useEffect(() => () => useSettings.setState({ went: 'none' }), [])
  return (
    <section className="app-panel settings-app" aria-label={text.apps.settings}>
      <div key={page} className={`settings-page went-${went}`}>
        <PageContent page={page} />
      </div>
    </section>
  )
}

function PageContent({ page }: { page: SettingsPage }) {
  switch (page) {
    case 'list':
      return <ListPage />
    case 'appearance':
      return <AppearancePage />
    case 'wallpaper':
      return <WallpaperPage />
    case 'dashboard':
      return <DashboardPage />
    case 'nowPlaying':
      return <NowPlayingPage />
    case 'sound':
      return <SoundPage />
    case 'presets':
      return <PresetsPage />
    case 'soundDetail':
      return <SoundDetailPage />
    case 'equalizer':
      return <EqualizerPage />
    case 'reverb':
      return <ReverbPage />
    case 'character':
      return <CharacterPage />
    case 'bass':
      return <BassPage />
    case 'textSize':
      return <TextSizePage />
  }
}

/** The appearance the mode asks for now (before a wallpaper with one variant only overrules it). */
function useWantedAppearance(): Appearance {
  const mode = useCabin((state) => state.appearanceMode)
  const gameTime = useLive((state) => (state.telemetry ? cabClock(state.telemetry, state.clockShift) : null))
  const lowBeam = useLive((state) => state.telemetry?.lowBeam ?? false)
  return resolveAppearance(mode, { gameTime, lowBeam })
}

function ListPage() {
  const text = useText()
  const open = useSettings((state) => state.open)
  const mode = useCabin((state) => state.appearanceMode)
  const wanted = useWantedAppearance()
  return (
    <Page title={text.apps.settings} list>
      <Group>
        <NavRow
          tile="var(--apple-blue)"
          icon={<AppearanceGlyph />}
          label={text.settings.appearance}
          value={mode === 'auto' ? text.settings.automatic : text.settings[wanted]}
          onOpen={() => open('appearance')}
        />
        <NavRow
          tile="var(--apple-cyan)"
          icon={<WallpaperGlyph />}
          label={text.settings.wallpaper}
          onOpen={() => open('wallpaper')}
        />
      </Group>
      <Group>
        <NavRow
          tile="var(--apple-indigo)"
          icon={<DashboardGlyph />}
          label={text.settings.dashboard}
          onOpen={() => open('dashboard')}
        />
        <NavRow
          tile="var(--apple-pink)"
          icon={<NowPlayingGlyph />}
          label={text.nowPlaying}
          onOpen={() => open('nowPlaying')}
        />
      </Group>
      <Group>
        <NavRow
          tile="var(--apple-red)"
          icon={<SoundGlyph />}
          label={text.settings.sound}
          onOpen={() => open('sound')}
        />
      </Group>
    </Page>
  )
}

/** Light or Dark, each a little picture of the screen, and Automatic (iOS's Display & Brightness). */
function AppearancePage() {
  const text = useText()
  const mode = useCabin((state) => state.appearanceMode)
  const setMode = useCabin((state) => state.setAppearanceMode)
  const wanted = useWantedAppearance()
  // The Vehicle Bar: only on a screen that has one (the truck's own bar, beside WestPlay).
  const hasBar = useScreenProfile().oemStrip !== null
  const oemMode = useCabin((state) => state.oemMode)
  const chooseOemMode = useCabin((state) => state.chooseOemMode)
  const open = useSettings((state) => state.open)
  return (
    <Page title={text.settings.appearance}>
      <Group footer={text.settings.automaticFooter}>
        <div className="appearance-choices">
          {(['light', 'dark'] as const).map((appearance) => (
            <button
              key={appearance}
              type="button"
              className="appearance-choice"
              aria-pressed={wanted === appearance}
              onClick={() => setMode(appearance)}
            >
              <ScreenPicture appearance={appearance} />
              <span className="appearance-name">{text.settings[appearance]}</span>
              <span className={wanted === appearance ? 'settings-radio on' : 'settings-radio'}>
                {wanted === appearance && <CheckGlyph />}
              </span>
            </button>
          ))}
        </div>
        <SwitchRow
          label={text.settings.automatic}
          on={mode === 'auto'}
          // Off, it keeps what Automatic shows now.
          onToggle={(on) => setMode(on ? 'auto' : wanted)}
        />
      </Group>
      <Group>
        <NavRow label={text.settings.textSize} onOpen={() => open('textSize')} />
      </Group>
      {hasBar && (
        <Group footer={text.settings.vehicleBarFooter}>
          <SwitchRow
            label={text.settings.vehicleBar}
            on={oemMode === 'auto'}
            onToggle={(on) => chooseOemMode(on ? 'auto' : 'off')}
          />
        </Group>
      )}
    </Page>
  )
}

/**
 * The apps' text size, as iOS's Text Size (owner 2026-10-22): its own text at the size chosen, and a slider
 * of nine steps between a small and a large A, dragged or tapped (state/textSize.ts).
 */
function TextSizePage() {
  const text = useText()
  return (
    <Page title={text.settings.textSize}>
      <p className="text-size-about">{text.settings.textSizeAbout}</p>
      <Group>
        <TextSizeSlider />
      </Group>
    </Page>
  )
}

/** The slider: a line with a tick at each step and the thumb on the one chosen. Dragged, the thumb follows the
 * finger and the size changes at each step it passes; let go, it settles on the step. */
function TextSizeSlider() {
  const text = useText()
  const step = useCabin((state) => state.textSize)
  const setStep = useCabin((state) => state.setTextSize)
  const track = useRef<HTMLDivElement>(null)
  // Where along the track the finger is while it drags (0 to 1), `null` otherwise.
  const [held, setHeld] = useState<number | null>(null)
  const last = TEXT_SIZES.length - 1
  const follow = (event: PointerEvent) => {
    const box = track.current?.getBoundingClientRect()
    if (!box || box.width === 0) return
    const along = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
    setHeld(along)
    const nearest = Math.round(along * last)
    if (nearest !== step) setStep(nearest)
  }
  const at = (index: number) => `${(index / last) * 100}%`
  return (
    <div className="text-size-row">
      <span className="text-size-a small" aria-hidden>
        A
      </span>
      <div
        ref={track}
        className={held === null ? 'text-size-track' : 'text-size-track dragging'}
        data-own-drag
        role="slider"
        aria-label={text.settings.textSize}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={step}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId)
          follow(event)
        }}
        onPointerMove={(event) => held !== null && follow(event)}
        onPointerUp={() => setHeld(null)}
        onPointerCancel={() => setHeld(null)}
      >
        <span className="text-size-line" />
        {TEXT_SIZES.map((_, index) => (
          <span key={index} className="text-size-tick" style={{ left: at(index) }} />
        ))}
        <span className="text-size-thumb" style={{ left: held === null ? at(step) : `${held * 100}%` }} />
      </div>
      <span className="text-size-a large" aria-hidden>
        A
      </span>
    </div>
  )
}

/** A little picture of the screen in an appearance: a wallpaper, the sidebar and the Dashboard's widgets. */
function ScreenPicture({ appearance }: { appearance: Appearance }) {
  return (
    <span className={`screen-picture ${appearance}`} aria-hidden>
      <span className="screen-picture-sidebar" />
      <span className="screen-picture-widget large" />
      <span className="screen-picture-widget" />
      <span className="screen-picture-widget" />
    </span>
  )
}

function WallpaperPage() {
  const text = useText()
  const wallpaperId = useCabin((state) => state.wallpaperId)
  const setWallpaper = useCabin((state) => state.setWallpaper)
  const wallpapers = useWallpapers()
  const { appearance } = useLook()
  return (
    <Page title={text.settings.wallpaper}>
      <Group>
        <div className="wallpaper-choices">
          {wallpapers.map((wallpaper) => (
            <button
              key={wallpaper.id}
              type="button"
              className="wallpaper-choice"
              aria-pressed={wallpaper.id === wallpaperId}
              onClick={() => setWallpaper(wallpaper.id)}
            >
              <WallpaperThumbnail src={pickVariant(wallpaper, appearance).src} />
              <span className="wallpaper-name">{wallpaper.name}</span>
            </button>
          ))}
        </div>
      </Group>
    </Page>
  )
}

/** Thumbnails, each drawn once from its wallpaper: the files are up to 4000 px wide. */
const thumbnails = new Map<string, Promise<string>>()

function WallpaperThumbnail({ src }: { src: string }) {
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    let made = thumbnails.get(src)
    if (!made) {
      made = prepareWallpaper(src, THUMBNAIL_WIDTH, (THUMBNAIL_WIDTH * 9) / 16).catch(() => src)
      thumbnails.set(src, made)
    }
    void made.then((url) => current && setThumbnail(url))
    return () => {
      current = false
    }
  }, [src])
  return thumbnail ? <img src={thumbnail} alt="" /> : <span className="wallpaper-thumbnail-empty" />
}

/** Twice a thumbnail's width on the screen, so it stays sharp. */
const THUMBNAIL_WIDTH = 600

/** Which widgets the Dashboard shows (turn-by-turn always does while there's a route). */
function DashboardPage() {
  const text = useText()
  const widgets = useCabin((state) => state.dashboardWidgets)
  const setWidget = useCabin((state) => state.setDashboardWidget)
  const names: Record<DashboardWidget, string> = {
    nowPlaying: text.nowPlaying,
    destination: text.destination,
    weather: text.apps.weather,
  }
  return (
    <Page title={text.settings.dashboard}>
      <Group header={text.settings.widgets}>
        {DASHBOARD_WIDGETS.map((widget) => (
          <SwitchRow key={widget} label={names[widget]} on={widgets[widget]} onToggle={(on) => setWidget(widget, on)} />
        ))}
      </Group>
    </Page>
  )
}

/** The album art on Now Playing and in Music. */
function NowPlayingPage() {
  const text = useText()
  const albumArt = useCabin((state) => state.albumArt)
  const setAlbumArt = useCabin((state) => state.setAlbumArt)
  return (
    <Page title={text.nowPlaying}>
      <Group>
        <SwitchRow label={text.settings.showAlbumArt} on={albumArt} onToggle={setAlbumArt} />
      </Group>
    </Page>
  )
}

/**
 * The cab's sound: its EQ switch, then — while that's on — the preset playing and the settings that tune it.
 * Off, the switch is all there is to show: the players shape nothing, so the rest would say nothing.
 */
function SoundPage() {
  const text = useText()
  const open = useSettings((state) => state.open)
  const enabled = useCabin((state) => state.soundEnabled)
  const setEnabled = useCabin((state) => state.setSoundEnabled)
  const presets = useCabin((state) => state.presets)
  const preset = useCabin((state) => state.preset)
  const presetName = presets.find((each) => each.id === preset)?.name
  return (
    <Page title={text.settings.sound}>
      <Group footer={text.settings.eqFooter}>
        <SwitchRow label={text.settings.eq} on={enabled} onToggle={setEnabled} />
      </Group>
      {enabled && (
        <Group footer={text.settings.soundFooter}>
          <NavRow label={text.settings.presets} value={presetName} onOpen={() => open('presets')} />
          <NavRow label={text.settings.soundDetail} onOpen={() => open('soundDetail')} />
        </Group>
      )}
    </Page>
  )
}

/** The presets the developer tuned the cabin with, one playing at a time (none yet: nothing to list). */
function PresetsPage() {
  const text = useText()
  const presets = useCabin((state) => state.presets)
  const preset = useCabin((state) => state.preset)
  const choose = useCabin((state) => state.setPreset)
  return (
    <Page title={text.settings.presets}>
      <Group footer={text.settings.presetsFooter}>
        {presets.length === 0 ? (
          <div className="settings-row">
            <span className="settings-value">{text.settings.noPresets}</span>
          </div>
        ) : (
          presets.map((each) => (
            <CheckRow key={each.id} label={each.name} on={preset === each.id} onPick={() => choose(each.id)} />
          ))
        )}
      </Group>
    </Page>
  )
}

/** The sound's own settings: the Equalizer, the cabin's character, its bass and its reverb. */
function SoundDetailPage() {
  const text = useText()
  const open = useSettings((state) => state.open)
  const custom = useCabin((state) => state.equalizerCustom)
  const reverb = useCabin((state) => state.reverb)
  const character = useCabin((state) => state.cabinCharacter)
  const bass = useCabin((state) => state.bass)
  const characterNames: Record<CabinCharacter, string> = {
    reference: text.settings.characterReference,
    equalized: text.settings.characterEq,
    impulse: text.settings.characterIr,
    full: text.settings.characterFull,
  }
  return (
    <Page title={text.settings.soundDetail}>
      <Group>
        <NavRow
          label={text.settings.equalizer}
          value={custom ? text.settings.custom : text.settings.recommended}
          onOpen={() => open('equalizer')}
        />
        <NavRow
          label={text.settings.cabinCharacter}
          value={characterNames[character]}
          onOpen={() => open('character')}
        />
        <NavRow label={text.settings.bassManagement} value={`${bass.cutoff} Hz`} onOpen={() => open('bass')} />
        <NavRow
          label={text.settings.cabinReverb}
          value={reverb.enabled ? `${reverb.amount}%` : text.settings.off}
          onOpen={() => open('reverb')}
        />
      </Group>
    </Page>
  )
}

/** The four-step cabin A/B: direct speakers, cabin EQ, early reflections, then the full model. */
function CharacterPage() {
  const text = useText()
  const chosen = useCabin((state) => state.cabinCharacter)
  const choose = useCabin((state) => state.setCabinCharacter)
  const reflection = useCabin((state) => state.reflection)
  const setReflection = useCabin((state) => state.setReflection)
  const names: Record<CabinCharacter, string> = {
    reference: text.settings.characterReference,
    equalized: text.settings.characterEq,
    impulse: text.settings.characterIr,
    full: text.settings.characterFull,
  }
  return (
    <Page title={text.settings.cabinCharacter}>
      <Group footer={text.settings.characterFooter}>
        {CABIN_CHARACTERS.map((character) => (
          <CheckRow
            key={character}
            label={names[character]}
            on={chosen === character}
            onPick={() => choose(character)}
          />
        ))}
      </Group>
      <Group>
        <SettingSlider
          label={text.settings.reflectionAmount}
          value={reflection.amount}
          change={(amount) => setReflection({ amount })}
        />
      </Group>
    </Page>
  )
}

/** Always-on bass management. There is no switch: only where the mono bass crossover sits. */
function BassPage() {
  const text = useText()
  const bass = useCabin((state) => state.bass)
  const set = useCabin((state) => state.setBass)
  return (
    <Page title={text.settings.bassManagement}>
      <Group footer={text.settings.bassFooter}>
        <SettingSlider
          label={text.settings.bassCutoff}
          value={bass.cutoff}
          min={BASS_CUTOFF.min}
          max={BASS_CUTOFF.max}
          step={BASS_CUTOFF.step}
          suffix=" Hz"
          change={(cutoff) => set({ cutoff })}
        />
      </Group>
    </Page>
  )
}

/** The cab's shared acoustic space: first reflections and the diffuse tail every player's sound makes in the
 * same truck interior. Presets keep it quick; the sliders let a large sleeper or a compact day cab be tuned. */
function ReverbPage() {
  const text = useText()
  const reverb = useCabin((state) => state.reverb)
  const set = useCabin((state) => state.setReverb)
  const presets = [
    { id: 'compact', label: text.settings.compactCab, size: 25, amount: 30 },
    { id: 'standard', label: text.settings.standardCab, size: 55, amount: 32 },
    { id: 'large', label: text.settings.largeCab, size: 85, amount: 40 },
  ] as const
  const chosen = presets.find((preset) => preset.size === reverb.size && preset.amount === reverb.amount)
  return (
    <Page title={text.settings.cabinReverb}>
      <Group footer={text.settings.reverbFooter}>
        <SwitchRow label={text.settings.reverbEnabled} on={reverb.enabled} onToggle={(enabled) => set({ enabled })} />
      </Group>
      <Group header={text.settings.reverbPresets}>
        {presets.map((preset) => (
          <CheckRow
            key={preset.id}
            label={preset.label}
            on={chosen?.id === preset.id}
            onPick={() => set({ enabled: true, size: preset.size, amount: preset.amount })}
          />
        ))}
      </Group>
      <Group>
        <SettingSlider
          label={text.settings.reverbSize}
          value={reverb.size}
          change={(size) => set({ enabled: true, size })}
        />
        <SettingSlider
          label={text.settings.reverbAmount}
          value={reverb.amount}
          change={(amount) => set({ enabled: true, amount })}
        />
      </Group>
    </Page>
  )
}

function SettingSlider({
  label,
  value,
  min = 0,
  max = 100,
  step = 1,
  suffix = '%',
  change,
}: {
  label: string
  value: number
  min?: number
  max?: number
  step?: number
  suffix?: string
  change(value: number): void
}) {
  return (
    <label className="settings-slider-row">
      <span className="settings-slider-text">
        <span className="settings-label">{label}</span>
        <span className="settings-slider-value">
          {value}
          {suffix}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        data-own-drag
        onChange={(event) => change(Number(event.currentTarget.value))}
      />
    </label>
  )
}

/**
 * The players' tone, as iOS 27's AirPods Equalizer (owner 2026-10-22): Recommended (the speakers as tuned) or
 * Custom (the player's own curve, kept while Recommended plays); the track playing, to hear it by; and the curve
 * over its bands, dragged up or down. Advanced swaps the three tone bands (Low, Mid, High, ±`EQUALIZER_MOST`) for
 * fifteen graphic ones, an ISO two-thirds of an octave each from 25 Hz to 16 kHz (±`GRAPHIC_MOST`); both curves are
 * kept, so the switch only chooses which plays.
 */
function EqualizerPage() {
  const text = useText()
  const custom = useCabin((state) => state.equalizerCustom)
  const advanced = useCabin((state) => state.equalizer.advanced)
  const curve = useCabin((state) => state.equalizer)
  const choose = useCabin((state) => state.chooseEqualizer)
  const setAdvanced = useCabin((state) => state.setEqualizerAdvanced)
  const reset = useCabin((state) => state.resetEqualizer)
  const flat = advanced ? curve.bands.every((db) => db === 0) : EQUALIZER_BANDS.every((band) => curve[band] === 0)
  // The music's spectrum, for the graph's waveform, while the page is open.
  useEffect(() => {
    if (!isInHost()) return
    postToHost({ type: 'spectrum', on: true })
    return () => postToHost({ type: 'spectrum', on: false })
  }, [])
  return (
    <Page title={text.settings.equalizer}>
      <Group footer={text.settings.advancedFooter}>
        <SwitchRow label={text.settings.advanced} on={advanced} onToggle={setAdvanced} />
      </Group>
      <Group footer={text.settings.equalizerFooter}>
        <CheckRow label={text.settings.recommended} on={!custom} onPick={() => choose(false)} />
        <CheckRow label={text.settings.custom} on={custom} onPick={() => choose(true)} />
      </Group>
      <Group>
        <TrackRow />
        {/* In a box of its own: the card's separator lines are drawn before its rows, which an svg can't take. */}
        <div>
          <EqualizerGraph />
        </div>
      </Group>
      <Group>
        <button type="button" className="settings-row settings-action" disabled={!custom || flat} onClick={reset}>
          {text.settings.resetEqualizer}
        </button>
      </Group>
    </Page>
  )
}

/** A row picked from those in its card, a blue tick on the one picked. */
function CheckRow({ label, on, onPick }: { label: string; on: boolean; onPick: () => void }) {
  return (
    <button type="button" role="radio" aria-checked={on} className="settings-row" onClick={onPick}>
      <span className="settings-label">{label}</span>
      {on && (
        <span className="settings-check">
          <CheckGlyph />
        </span>
      )}
    </button>
  )
}

/** The track Now Playing shows (the Dashboard's), to hear the tone by: its cover, title and artist, and a
 * button to play or pause it; none, an empty cover and the button greyed. */
function TrackRow() {
  const text = useText()
  const track = useNowPlayingTrack()
  const albumArt = useCabin((state) => state.albumArt)
  const cover = albumArt ? (track?.artwork ?? null) : null
  return (
    <div className="eq-track">
      <span className="eq-track-art">{cover ? <img src={cover} alt="" /> : track && <NoteGlyph size={32} />}</span>
      <span className="eq-track-lines">
        {track && <span className="eq-track-title">{track.title}</span>}
        {track && <span className="eq-track-by">{track.by}</span>}
      </span>
      <button
        type="button"
        className="eq-track-play"
        aria-label={track?.playing ? text.pause : text.play}
        disabled={!track?.playPause}
        onClick={() => track?.playPause?.()}
      >
        {track?.playing ? <PauseGlyph size={34} /> : <PlayGlyph size={34} />}
      </button>
    </div>
  )
}

/** The graph's drawing, in its own units: its width and height, and how high a band is from its dB (flat in the
 * middle, ±the mode's most at the top and bottom margins). */
const GRAPH = { width: 600, height: 300, top: 24, bottom: 236 }
const BAND_AT: Record<'bass' | 'mid' | 'treble', number> = { bass: 100, mid: 300, treble: 500 }
const GRAPHIC_AT = GRAPHIC_FREQUENCIES.map((_, i) => 40 + (i * (GRAPH.width - 80)) / (GRAPHIC_BANDS - 1))
/** The bands whose frequency is written under the graph: 100 Hz, 1 kHz and 10 kHz. */
const GRAPHIC_NAMED = [3, 8, 13]
const heightOf = (db: number, most: number) =>
  (GRAPH.top + GRAPH.bottom) / 2 - (db / most) * ((GRAPH.bottom - GRAPH.top) / 2)
const hz = (frequency: number) =>
  frequency >= 1000 ? `${Math.round(frequency / 100) / 10}k` : `${Math.round(frequency)}`

/**
 * The curve over its bands, as iOS draws it: the music's waveform along the middle and, Custom, a line through
 * each band's point over it — three bands' smoothed, fifteen drawn straight between them. A band follows the
 * finger up and down anywhere in its share of the graph, in whole dB; moving one picks Custom.
 */
function EqualizerGraph() {
  const text = useText()
  const custom = useCabin((state) => state.equalizerCustom)
  const curve = useCabin((state) => state.equalizer)
  const setBand = useCabin((state) => state.setEqualizerBand)
  const setGraphicBand = useCabin((state) => state.setGraphicBand)
  const svg = useRef<SVGSVGElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const advanced = curve.advanced
  const most = advanced ? GRAPHIC_MOST : EQUALIZER_MOST
  const count = advanced ? GRAPHIC_BANDS : 3
  const at = (band: number) => (advanced ? GRAPHIC_AT[band] : BAND_AT[EQUALIZER_BANDS[band]])
  const dbAt = (band: number) => (advanced ? (curve.bands[band] ?? 0) : curve[EQUALIZER_BANDS[band]])
  const inGraph = (event: PointerEvent) => {
    const matrix = svg.current?.getScreenCTM()?.inverse()
    if (!matrix) return null
    return new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix)
  }
  const drag = (band: number, event: PointerEvent) => {
    const pointer = inGraph(event)
    if (!pointer) return
    const middle = (GRAPH.top + GRAPH.bottom) / 2
    const db = Math.round(((middle - pointer.y) / ((GRAPH.bottom - GRAPH.top) / 2)) * most)
    const kept = Math.max(-most, Math.min(most, db))
    if (kept === dbAt(band) && custom) return
    if (advanced) setGraphicBand(band, kept)
    else setBand(EQUALIZER_BANDS[band], kept)
  }
  /** The band nearest across the graph (each owns its share of the width). */
  const bandAt = (x: number) => {
    if (!advanced) return x < GRAPH.width / 3 ? 0 : x < (2 * GRAPH.width) / 3 ? 1 : 2
    const at = Math.round(((x - 40) / (GRAPH.width - 80)) * (GRAPHIC_BANDS - 1))
    return Math.max(0, Math.min(GRAPHIC_BANDS - 1, at))
  }
  const names: Record<'bass' | 'mid' | 'treble', string> = {
    bass: text.settings.low,
    mid: text.settings.mid,
    treble: text.settings.high,
  }
  // What the curve shows: the player's, or flat while Recommended plays.
  const shown = (band: number) => (custom ? dbAt(band) : 0)
  const points: [number, number][] = advanced
    ? GRAPHIC_AT.map((x, band) => [x, heightOf(shown(band), most)])
    : [
        [0, heightOf(shown(0), most)],
        ...EQUALIZER_BANDS.map((_, band): [number, number] => [at(band), heightOf(shown(band), most)]),
        [GRAPH.width, heightOf(shown(2), most)],
      ]
  return (
    <svg
      ref={svg}
      className={dragging !== null ? 'eq-graph dragging' : 'eq-graph'}
      viewBox={`0 0 ${GRAPH.width} ${GRAPH.height}`}
      role="group"
      aria-label={text.settings.equalizer}
      // Its own drags (the page's drag to scroll leaves them: shell/dragScroll.ts).
      data-own-drag
      onPointerDown={(event) => {
        const pointer = inGraph(event)
        if (!pointer) return
        const band = bandAt(pointer.x)
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(band)
        drag(band, event)
      }}
      onPointerMove={(event) => dragging !== null && drag(dragging, event)}
      onPointerUp={() => setDragging(null)}
      onPointerCancel={() => setDragging(null)}
    >
      {!advanced && (
        <defs>
          <linearGradient id="eq-middle-column" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="eq-column-edge" />
            <stop offset="0.5" className="eq-column-middle" />
            <stop offset="1" className="eq-column-edge" />
          </linearGradient>
        </defs>
      )}
      {!advanced && <rect x={200} y={0} width={200} height={GRAPH.bottom + 14} fill="url(#eq-middle-column)" />}
      {(advanced ? GRAPHIC_NAMED : [0, 1, 2]).map((band) => (
        <line key={band} className="eq-band-line" x1={at(band)} x2={at(band)} y1={8} y2={GRAPH.bottom + 6} />
      ))}
      <Waveform />
      {custom &&
        (advanced ? (
          <polyline className="eq-curve" points={points.map(([x, y]) => `${x},${y}`).join(' ')} />
        ) : (
          <path className="eq-curve" d={smoothThrough(points)} />
        ))}
      {custom &&
        Array.from({ length: count }, (_, band) => (
          <circle
            key={band}
            className={dragging === band ? 'eq-point dragged' : 'eq-point'}
            cx={at(band)}
            cy={heightOf(dbAt(band), most)}
            r={advanced ? 10 : 14}
            role="slider"
            aria-label={advanced ? `${hz(GRAPHIC_FREQUENCIES[band])} Hz` : names[EQUALIZER_BANDS[band]]}
            aria-valuemin={-most}
            aria-valuemax={most}
            aria-valuenow={dbAt(band)}
          />
        ))}
      {advanced
        ? GRAPHIC_NAMED.map((band) => (
            <text key={band} className="eq-band-name" x={GRAPHIC_AT[band]} y={GRAPH.height - 16}>
              {hz(GRAPHIC_FREQUENCIES[band])}
            </text>
          ))
        : EQUALIZER_BANDS.map((band) => (
            <text key={band} className="eq-band-name" x={BAND_AT[band]} y={GRAPH.height - 16}>
              {names[band]}
            </text>
          ))}
    </svg>
  )
}

/** How many of the waveform's bars there are, and how far up and down from the middle the loudest reaches. */
const WAVEFORM = { bars: 48, reach: 84, thick: 6 }

/**
 * The music's waveform, as iOS draws it under the curve: a row of dots along the middle, each a part of the
 * music's spectrum (the lows on the left, the highs on the right, as the bands stand), growing up and down
 * with its loudness as it plays; stopped, or nothing playing, the dots at rest.
 */
function Waveform() {
  const bars = useLive((state) => state.spectrum)
  const step = (GRAPH.width - 2 * WAVEFORM.thick) / (WAVEFORM.bars - 1)
  return (
    <g className="eq-waveform">
      {Array.from({ length: WAVEFORM.bars }, (_, i) => {
        const loud = Math.min(1, Math.max(0, (bars[i] ?? 0) / 255))
        const tall = WAVEFORM.thick + loud * 2 * WAVEFORM.reach
        return (
          <rect
            key={i}
            x={WAVEFORM.thick / 2 + i * step}
            y={heightOf(0, EQUALIZER_MOST) - tall / 2}
            width={WAVEFORM.thick}
            height={tall}
            rx={WAVEFORM.thick / 2}
          />
        )
      })}
    </g>
  )
}

/**
 * A page: its content scrolling under a bar that holds the back button and the page's title. On the list,
 * the title is large at the top of the content, and the bar's small one takes over once it scrolls under.
 * Content scrolled under the bar fades and blurs away, iOS 26's edge.
 */
function Page({ title, list = false, children }: { title: string; list?: boolean; children: ReactNode }) {
  const text = useText()
  const back = useSettings((state) => state.back)
  const [scrolled, setScrolled] = useState(false)
  const [largeTitleGone, setLargeTitleGone] = useState(false)
  return (
    <>
      <div
        className={list ? 'settings-scroll list' : 'settings-scroll'}
        onScroll={(event) => {
          const top = event.currentTarget.scrollTop
          setScrolled(top > 0)
          setLargeTitleGone(top > LARGE_TITLE_HEIGHT)
        }}
      >
        {list && <h1 className="settings-large-title">{title}</h1>}
        {children}
      </div>
      <header className={scrolled ? 'settings-bar scrolled' : 'settings-bar'}>
        {!list && (
          <button type="button" className="settings-back" aria-label={text.settings.back} onClick={back}>
            <ChevronGlyph back />
          </button>
        )}
        <div className={!list || largeTitleGone ? 'settings-bar-title shown' : 'settings-bar-title'}>{title}</div>
      </header>
    </>
  )
}

/** How far the list scrolls before its large title is under the bar (settings.css: .settings-large-title). */
const LARGE_TITLE_HEIGHT = 56

function Group({ header, footer, children }: { header?: string; footer?: string; children: ReactNode }) {
  return (
    <div className="settings-group">
      {header && <h2 className="settings-group-header">{header}</h2>}
      <div className="settings-card">{children}</div>
      {footer && <p className="settings-group-footer">{footer}</p>}
    </div>
  )
}

interface RowLabel {
  label: string
  /** A coloured tile with a white glyph before the label (rows on the list have one). */
  tile?: string
  icon?: ReactNode
}

function RowStart({ label, tile, icon }: RowLabel) {
  return (
    <>
      {tile && (
        <span className="settings-tile" style={{ background: tile } as CSSProperties}>
          {icon}
        </span>
      )}
      <span className="settings-label">{label}</span>
    </>
  )
}

/** A row that opens a page: its value in grey, and a chevron. */
function NavRow({ value, onOpen, ...start }: RowLabel & { value?: string; onOpen: () => void }) {
  return (
    <button type="button" className={start.tile ? 'settings-row with-tile' : 'settings-row'} onClick={onOpen}>
      <RowStart {...start} />
      {value && <span className="settings-value">{value}</span>}
      <span className="settings-chevron">
        <ChevronGlyph />
      </span>
    </button>
  )
}

/** A row with a switch; the whole row flips it (a big target on a truck's screen). */
function SwitchRow({ on, onToggle, ...start }: RowLabel & { on: boolean; onToggle: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={start.tile ? 'settings-row with-tile' : 'settings-row'}
      onClick={() => onToggle(!on)}
    >
      <RowStart {...start} />
      <span className={on ? 'apple-switch on' : 'apple-switch'} aria-hidden>
        <span className="apple-switch-thumb" />
      </span>
    </button>
  )
}
