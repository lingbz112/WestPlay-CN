import { useMemo } from 'react'
import { create } from 'zustand'
import {
  isInHost,
  postToHost,
  type RadioCommand,
  type RadioPlayback,
  type RadioStationInfo,
} from '../../../shared/host'
import type { MediaSource } from '../../../shared/media'
import { lastPlaying } from '../oneAtATime'

/**
 * A radio station: where it is, what it plays, and the mark on its tile. The stations are radio.cn's
 * (`crates/host radio.rs`), played in a hidden WebView on the truck's speakers; in a plain browser the demo's
 * stations stand in for them.
 */
export interface RadioStation {
  id: string
  /** Its province's name. */
  region: string
  /** Its province's code (`0`: the national stations). */
  regionCode: string
  name: string
  program: string
  image: string | null
  /** The two or three characters on its tile, as a station's own mark. */
  mark: string
  color: string
  /** Its cover, if there's a picture for it. */
  cover: string | null
}

/** A region the API offers: its name, and its province's code. */
export interface RadioRegion {
  name: string
  code: string
}

/** The regions offered, in the order radio.cn lists them (天津 has one station, though its own list leaves it
 * out). */
export const RADIO_REGIONS: readonly RadioRegion[] = [
  { name: '国家', code: '0' },
  { name: '北京', code: '110000' },
  { name: '上海', code: '310000' },
  { name: '天津', code: '120000' },
  { name: '重庆', code: '500000' },
  { name: '河北', code: '130000' },
  { name: '山西', code: '140000' },
  { name: '辽宁', code: '210000' },
  { name: '吉林', code: '220000' },
  { name: '黑龙江', code: '230000' },
  { name: '江苏', code: '320000' },
  { name: '浙江', code: '330000' },
  { name: '安徽', code: '340000' },
  { name: '福建', code: '350000' },
  { name: '江西', code: '360000' },
  { name: '山东', code: '370000' },
  { name: '河南', code: '410000' },
  { name: '湖北', code: '420000' },
  { name: '湖南', code: '430000' },
  { name: '广东', code: '440000' },
  { name: '海南', code: '460000' },
  { name: '四川', code: '510000' },
  { name: '贵州', code: '520000' },
  { name: '云南', code: '530000' },
  { name: '陕西', code: '610000' },
  { name: '甘肃', code: '620000' },
  { name: '青海', code: '630000' },
  { name: '内蒙古', code: '150000' },
  { name: '广西', code: '450000' },
  { name: '西藏', code: '540000' },
  { name: '宁夏', code: '640000' },
  { name: '新疆', code: '650000' },
  { name: '新疆兵团', code: '660000' },
] as const

export function regionCodeOf(name: string): string {
  return RADIO_REGIONS.find((region) => region.name === name)?.code ?? '0'
}

export function regionNameOf(code: string): string {
  return RADIO_REGIONS.find((region) => region.code === code)?.name ?? '国家'
}

type StationWords = readonly [name: string, program: string, mark: string]

const NATIONAL: readonly StationWords[] = [
  ['中国之声', '新闻和报纸摘要', '中国'],
  ['经济之声', '天下财经', '经济'],
  ['音乐之声', '音乐随心听', '音乐'],
  ['经典音乐广播', '经典留声机', '经典'],
  ['台海之声', '两岸观察', '台海'],
  ['神州之声', '华夏风情', '神州'],
  ['大湾区之声', '湾区在线', '湾区'],
  ['香港之声', '香江夜话', '香港'],
  ['民族之声', '民族音乐厅', '民族'],
  ['文艺之声', '文艺星空', '文艺'],
  ['老年之声', '健康课堂', '老年'],
  ['藏语广播', '雪域之声', '藏语'],
  ['维吾尔语广播', '天山之声', '维语'],
  ['中国交通广播', '一路畅通', '交通'],
  ['中国乡村之声', '田野新声', '乡村'],
  ['哈萨克语广播', '草原之声', '哈萨克'],
  ['南海之声', '南海巡航', '南海'],
  ['环球资讯广播', '环球直播间', '环球'],
  ['英语资讯广播 CGTN Radio', 'World Today', 'CGTN'],
]

const BEIJING: readonly StationWords[] = [
  ['北京新闻广播', '北京新闻', '新闻'],
  ['北京交通广播', '一路畅通', '交通'],
  ['北京音乐广播', '音乐随身听', '音乐'],
  ['北京文艺广播', '文艺调频', '文艺'],
  ['北京体育广播', '体坛在线', '体育'],
  ['北京城市广播', '城市热线', '城市'],
  ['北京故事广播', '故事会', '故事'],
  ['北京经典调频', '经典时光', '经典'],
  ['北京外语广播', '英语天地', '外语'],
  ['北京青年广播', '青年说', '青年'],
]

const PALETTE = ['#B3121B', '#1F3A5F', '#0F5C5C', '#6B4A1F', '#3E3A5C', '#7A1F3D', '#2F4A2F', '#4A4A4E']

/** The demo's cover: CNR's mark, kept with the other third-party brand logos (never shipped). */
const COVER = '/brand-logos/radio-cnr.png'

/** A station's mark from its name: the common suffixes left off, two characters. */
function markOf(name: string): string {
  const bare = name
    .replace(/[（(].*?[）)]/gu, '')
    .replace(/(广播|之声|电台|频率|频道)$/u, '')
    .trim()
  return (bare || name).slice(0, 2)
}

/** A colour for a station, from its name (radio.cn's images carry none). */
function colorOf(name: string): string {
  let hash = 0
  for (const character of name) hash = (hash * 31 + character.charCodeAt(0)) % 360
  return PALETTE[hash % PALETTE.length]
}

function toStation(info: RadioStationInfo, region = regionNameOf(info.region)): RadioStation {
  const name = info.name || '电台'
  const image = info.image ?? null
  return {
    id: info.id,
    region,
    regionCode: info.region,
    name,
    program: info.program || '正在直播',
    image,
    mark: markOf(name),
    color: colorOf(name),
    cover: image,
  }
}

/** The demo's stations of a region, in a plain browser (no host to ask). */
function stationsOf(region: string): RadioStation[] {
  const words: readonly StationWords[] =
    region === '国家'
      ? NATIONAL
      : region === '北京'
        ? BEIJING
        : [
            [region + '新闻广播', '新闻直播间', '新闻'],
            [region + '交通广播', '一路畅通', '交通'],
            [region + '音乐广播', '音乐随身听', '音乐'],
            [region + '文艺广播', '文化时空', '文艺'],
            [region + '体育广播', '体坛在线', '体育'],
            [region + '城市广播', '城市热线', '城市'],
          ]
  const offset = RADIO_REGIONS.findIndex((each) => each.name === region)
  const code = regionCodeOf(region)
  return words.map(([name, program, mark], index) => {
    const station: RadioStation = {
      id: region + ':' + name,
      region,
      regionCode: code,
      name,
      program,
      image: null,
      mark,
      color: PALETTE[(index + Math.max(0, offset)) % PALETTE.length],
      cover: null,
    }
    // The demo's one real cover: 中国之声 (CNR).
    if (region === '国家' && name === '中国之声') {
      station.image = COVER
      station.cover = COVER
      station.color = '#CC010E'
    }
    return station
  })
}

export const RADIO_DATA: Record<string, RadioStation[]> = Object.fromEntries(
  RADIO_REGIONS.map(({ name }) => [name, stationsOf(name)]),
)

export const RADIO_STATIONS = Object.values(RADIO_DATA).flat()

export const RADIO_BY_ID = new Map(RADIO_STATIONS.map((station) => [station.id, station]))

/** What plays first in a plain browser: 中国之声, whose cover is the demo's. */
export const RADIO_DEFAULT_STATION = RADIO_BY_ID.get('国家:中国之声')!

/** What the player shows before radio.cn's first list comes: 中国之声. */
const HOST_DEFAULT_STATION: RadioStation = {
  id: '639',
  region: '国家',
  regionCode: '0',
  name: '中国之声',
  program: '正在直播',
  image: null,
  mark: '中国',
  color: '#CC010E',
  cover: null,
}

const FAVORITES_KEY = 'westplay.radio.favorites'
const STATION_KEY = 'westplay.radio.station'
const VOLUME_KEY = 'westplay.radio.volume'

function demoFavorites(): RadioStation[] {
  return [RADIO_BY_ID.get('国家:中国之声'), RADIO_BY_ID.get('北京:北京交通广播')].filter(
    (station): station is RadioStation => Boolean(station),
  )
}

/** A station as it's kept (`null`: not a station). */
function storedStation(value: unknown): RadioStation | null {
  if (!value || typeof value !== 'object') return null
  const { id, name, region, regionCode, program, image } = value as Record<string, unknown>
  if (typeof id !== 'string' || typeof name !== 'string') return null
  return {
    id,
    name,
    region: typeof region === 'string' ? region : '国家',
    regionCode: typeof regionCode === 'string' ? regionCode : '0',
    program: typeof program === 'string' ? program : '正在直播',
    image: typeof image === 'string' ? image : null,
    mark: markOf(name),
    color: colorOf(name),
    cover: typeof image === 'string' ? image : null,
  }
}

/** The fields a station is kept with (its mark and colour come from its name). */
function storedFields({ id, name, region, regionCode, program, image }: RadioStation) {
  return { id, name, region, regionCode, program, image }
}

/** The favourites kept (a plain browser starts with the demo's). */
function loadFavorites(): RadioStation[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY)
    if (raw === null) return isInHost() ? [] : demoFavorites()
    const stored = JSON.parse(raw)
    if (!Array.isArray(stored)) return isInHost() ? [] : demoFavorites()
    return stored.flatMap((each) => {
      const station = storedStation(each)
      return station ? [station] : []
    })
  } catch {
    return isInHost() ? [] : demoFavorites()
  }
}

function saveFavorites(favorites: RadioStation[]): void {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites.map(storedFields)))
  } catch {}
}

/** The station that played last, and whether it was playing (`null`: none yet). */
function loadSavedStation(): { station: RadioStation; playing: boolean } | null {
  try {
    const raw = localStorage.getItem(STATION_KEY)
    if (raw === null) return null
    const value = JSON.parse(raw)
    const station = storedStation(value)
    if (!station) return null
    return { station, playing: Boolean((value as Record<string, unknown>).playing) }
  } catch {
    return null
  }
}

function saveStation(station: RadioStation, playing: boolean): void {
  try {
    localStorage.setItem(STATION_KEY, JSON.stringify({ ...storedFields(station), playing }))
  } catch {}
}

/** Whether the radio was the last media to play here (nothing yet: it may start). */
function radioPlayedLast(): boolean {
  const last = lastPlaying()
  return last === null || last === 'radio'
}

/** The volume kept (0 to 1), as it was when WestPlay last closed. */
function loadVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY)
    const saved = Number(raw)
    return raw !== null && Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 0.8
  } catch {
    return 0.8
  }
}

function saveVolume(volume: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(volume))
  } catch {}
}

interface RadioState {
  /** Each province's stations, by its code, as radio.cn says them. */
  stations: Record<string, RadioStation[]>
  /** The provinces whose list couldn't be read. */
  stationListsFailed: Record<string, boolean>
  station: RadioStation
  playing: boolean
  /** Playing as asked, its sound not come yet. */
  loading: boolean
  /** The stream didn't come (the page is trying another). */
  playbackFailed: boolean
  /** The player's volume, 0 to 1. */
  volume: number
  favorites: RadioStation[]
  /** It has played at least once: Now Playing shows it. */
  started: boolean
}

const preview = !isInHost()

export const useRadio = create<RadioState>()(() => ({
  stations: {},
  stationListsFailed: {},
  station: preview ? RADIO_DEFAULT_STATION : HOST_DEFAULT_STATION,
  // In a plain browser the demo plays, as it always did.
  playing: preview,
  loading: false,
  playbackFailed: false,
  volume: loadVolume(),
  favorites: loadFavorites(),
  started: preview,
}))

export function radioCommand(command: RadioCommand): void {
  if (isInHost()) postToHost({ type: 'radio', command })
}

/** The radio runs (hidden, under the page): asked as the app opens. */
export function startRadio(): void {
  if (!isInHost()) return
  radioCommand({ action: 'start' })
  radioCommand({ action: 'volume', percent: Math.round(useRadio.getState().volume * 100) })
  requestStations('0')
  // The station that played last, played again as the app opens (WestPlay restarted, or the page loaded
  // anew): before the first list's own choice.
  if (!useRadio.getState().started) {
    const saved = loadSavedStation()
    if (saved) {
      // The last station, shown paused: played again only if it was the one playing before, not when another
      // player was (opening the radio doesn't take over from it).
      useRadio.setState({ station: saved.station, playing: false, loading: false, started: true })
      requestStations(saved.station.regionCode)
      if (saved.playing && radioPlayedLast()) playStation(saved.station)
    }
  }
}

/** A province's stations, asked once (`force`: asked again: the list failed, or a stream needs a fresh URL). */
export function requestStations(code: string, force = false): void {
  if (!isInHost()) return
  const state = useRadio.getState()
  if (!force && (state.stations[code] || state.stationListsFailed[code])) return
  radioCommand({ action: 'stations', region: code })
}

/** radio.cn's stations of a province (`failed`: it didn't say). */
export function receiveStations(region: string, infos: RadioStationInfo[], failed = false): void {
  const name = regionNameOf(region)
  const list = infos.map((info) => toStation(info, name))
  const state = useRadio.getState()
  const stations = { ...state.stations, [region]: list }
  const stationListsFailed = { ...state.stationListsFailed, [region]: failed }
  let station = state.station
  // The station shown from this province: its cover and program as the fresh list has them.
  if (station.regionCode === region) {
    const found = list.find((each) => each.id === station.id)
    if (found) station = found
  }
  useRadio.setState({ stations, stationListsFailed, station })
  // The first list: the app opens playing, as it did (中国之声, or the first station), unless another player was
  // the last one playing here.
  if (!failed && region === '0' && !state.started && radioPlayedLast() && list.length > 0) {
    const preferred = list.find((each) => each.name === '中国之声') ?? list[0]
    playStation(preferred)
  }
}

/** What the radio plays (`radioPlayback`): the app follows it. */
export function receivePlayback(playback: RadioPlayback | null): void {
  const state = useRadio.getState()
  if (!playback) {
    // The page says nothing plays before the station asked for has come: not the app's answer yet.
    if (state.loading) return
    useRadio.setState({ playing: false, loading: false, playbackFailed: false })
    return
  }
  const station = playback.station ? toStation(playback.station) : state.station
  if (
    state.station.id !== station.id ||
    state.station.program !== station.program ||
    state.playing !== playback.playing
  ) {
    saveStation(station, playback.playing)
  }
  useRadio.setState({
    station,
    playing: playback.playing,
    loading: playback.loading,
    playbackFailed: Boolean(playback.failed),
    volume: playback.volume ?? state.volume,
    started: true,
  })
}

/** A station plays: the app shows it at once (radio.cn says how it really is a moment later). */
export function playStation(station: RadioStation): void {
  saveStation(station, true)
  useRadio.setState({
    station,
    playing: true,
    loading: isInHost(),
    playbackFailed: false,
    started: true,
  })
  radioCommand({ action: 'play', id: station.id, region: station.regionCode })
}

export function togglePlay(): void {
  const { station, playing } = useRadio.getState()
  if (playing) {
    saveStation(station, false)
    useRadio.setState({ playing: false, loading: false })
    radioCommand({ action: 'pause' })
  } else {
    saveStation(station, true)
    useRadio.setState({ playing: true, loading: isInHost(), playbackFailed: false, started: true })
    radioCommand({ action: 'play', id: station.id, region: station.regionCode })
  }
}

/** Plays or pauses what's playing. */
export function playOrPause(): void {
  togglePlay()
}

/** The next station (1), or the one before (-1), within the province shown. */
export function step(direction: 1 | -1): void {
  const { station, stations } = useRadio.getState()
  const list = stations[station.regionCode] ?? (!isInHost() ? RADIO_DATA[station.region] ?? [] : [])
  if (list.length < 2) return
  const at = list.findIndex((each) => each.id === station.id)
  const next = list[(at + direction + list.length) % list.length]
  if (next) playStation(next)
}

/** A province's stations, for the screens (`null`: not asked yet; the demo's in a plain browser). */
export function useStations(region: string): RadioStation[] {
  const list = useRadio((state) => state.stations[regionCodeOf(region)])
  if (list) return list
  return isInHost() ? [] : RADIO_DATA[region] ?? []
}

/** Whether a province's list failed. */
export function useStationsFailed(region: string): boolean {
  return useRadio((state) => Boolean(state.stationListsFailed[regionCodeOf(region)]))
}

let volumeSent = 0

/** The player's volume (0 to 1), as it's dragged: shown at once, sent a few times a second (the last one
 * always). */
export function setVolume(share: number, done = false): void {
  const volume = Math.min(1, Math.max(0, share))
  useRadio.setState({ volume })
  // Zero is the mute (the slider all the way down, or the speaker muted): the volume before it stays the one
  // kept for the next start.
  if (volume > 0) saveVolume(volume)
  if (!isInHost()) return
  const now = performance.now()
  if (!done && now - volumeSent < 120) return
  volumeSent = now
  radioCommand({ action: 'volume', percent: Math.round(volume * 100) })
}

/** The volume as a raw command (a fade): the player's own choice, and its slider, stay as they were. */
export function sendVolume(share: number): void {
  if (!isInHost()) return
  const volume = Math.min(1, Math.max(0, share))
  radioCommand({ action: 'volume', percent: Math.round(volume * 100) })
}

export function toggleFavorite(): void {
  const { station, favorites } = useRadio.getState()
  const next = favorites.some((each) => each.id === station.id)
    ? favorites.filter((each) => each.id !== station.id)
    : [...favorites, station]
  useRadio.setState({ favorites: next })
  saveFavorites(next)
}

export function removeFavorite(id: string): void {
  const favorites = useRadio.getState().favorites.filter((each) => each.id !== id)
  useRadio.setState({ favorites })
  saveFavorites(favorites)
}

/** Whether the radio plays now. */
export function playingNow(): boolean {
  return useRadio.getState().playing
}

/** Pauses what plays (the game paused, tabbed out of, its electrics off). */
export function pauseNow(): void {
  if (!useRadio.getState().playing) return
  useRadio.setState({ playing: false, loading: false })
  radioCommand({ action: 'pause' })
}

/** Plays on what was paused (back in the game). */
export function resumeNow(): void {
  const { station, playing } = useRadio.getState()
  if (playing) return
  saveStation(station, true)
  useRadio.setState({ playing: true, loading: isInHost(), playbackFailed: false, started: true })
  radioCommand({ action: 'play', id: station.id, region: station.regionCode })
}

export function skip(direction: 1 | -1): void {
  step(direction)
}

/** What the radio plays, as the Dashboard's Now Playing takes music, and its cover; `null` until it has
 * played. */
export function useRadioSource(): { source: MediaSource; artwork: string | null } | null {
  const station = useRadio((state) => state.station)
  const playing = useRadio((state) => state.playing)
  const started = useRadio((state) => state.started)
  return useMemo(() => {
    if (!started) return null
    return {
      source: {
        id: 'westplay-radio',
        service: 'radio',
        title: station.name,
        artist: station.program,
        album: '',
        artwork: null,
        status: playing ? 'playing' : 'paused',
        positionMs: 0,
        positionAt: 0,
        durationMs: 0,
        controls: { playPause: true, next: true, previous: true, shuffle: false, repeat: false },
        shuffle: null,
        repeat: null,
      },
      artwork: station.cover,
    }
  }, [station, playing, started])
}
