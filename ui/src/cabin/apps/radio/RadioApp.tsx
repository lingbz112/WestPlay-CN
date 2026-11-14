import { type CSSProperties, type PointerEvent as ReactPointerEvent, useEffect, useRef, useState } from 'react'
import { useText } from '../../state/text'
import {
  BackGlyph,
  ChevronRightGlyph,
  CloseGlyph,
  ListGlyph,
  NextGlyph,
  PauseGlyph,
  PlayGlyph,
  PreviousGlyph,
  SpeakerGlyph,
  StarGlyph,
} from '../music/glyphs'
import {
  playStation as play,
  RADIO_REGIONS,
  type RadioStation,
  regionCodeOf,
  removeFavorite,
  requestStations,
  setVolume,
  startRadio,
  step as stepStation,
  toggleFavorite,
  togglePlay,
  useRadio,
  useStations,
  useStationsFailed,
} from './radio'
import './radio.css'

type Screen = 'player' | 'regions' | 'stations'

/**
 * Radio: the player first, on its station's colours (the cover's, blurred and veiled as Apple Music's Now
 * Playing), its star and volume beside the transport. 选台 opens the regions and then their stations, each a
 * settings-like list; the star at the top opens the favourites, drawn in from the right over the player's
 * own backdrop. The stations are radio.cn's, played in a hidden WebView on the truck's speakers.
 */
export function RadioApp() {
  const text = useText()
  const station = useRadio((state) => state.station)
  const playing = useRadio((state) => state.playing)
  const loading = useRadio((state) => state.loading)
  const playbackFailed = useRadio((state) => state.playbackFailed)
  const volume = useRadio((state) => state.volume)
  const favorites = useRadio((state) => state.favorites)
  const [stack, setStack] = useState<Screen[]>(['player'])
  const [region, setRegion] = useState('国家')
  const [lastStationRegion, setLastStationRegion] = useState<string | null>(null)
  const [panel, setPanel] = useState(false)
  const [muted, setMuted] = useState(false)
  const [coverFailedFor, setCoverFailedFor] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const lastVolume = useRef(0.8)
  const stations = useStations(region)
  const stationsFailed = useStationsFailed(region)
  const stationsLoaded = useRadio((state) => Boolean(state.stations[regionCodeOf(region)]))

  useEffect(() => startRadio(), [])

  const current = stack[stack.length - 1]
  const favorite = favorites.some((each) => each.id === station.id)
  const coverFailed = coverFailedFor === station.id
  const shown = muted ? 0 : volume
  const program = loading ? '正在连接…' : playbackFailed ? '暂时无法播放' : station.program

  const screenClass = (name: Screen) => {
    const depth = stack.indexOf(name)
    if (depth === -1) return 'radio-screen'
    if (depth === stack.length - 1) return 'radio-screen active'
    if (depth === stack.length - 2) return 'radio-screen behind'
    return 'radio-screen far'
  }
  const hidden = (name: Screen) => current !== name

  const go = (next: Screen[]) => {
    setPanel(false)
    setStack(next)
  }

  const openRegion = (next: string) => {
    setRegion(next)
    setLastStationRegion(next)
    requestStations(regionCodeOf(next))
    go(['player', 'regions', 'stations'])
  }

  /** 选台: the station page opened last, or the regions when none has been. */
  const openPicker = () => {
    if (lastStationRegion) setRegion(lastStationRegion)
    go(lastStationRegion ? ['player', 'regions', 'stations'] : ['player', 'regions'])
  }

  const choose = (next: RadioStation) => {
    play(next)
    setRegion(next.region)
    go(['player'])
  }

  const step = (delta: 1 | -1) => {
    stepStation(delta)
  }

  const volumeFrom = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    const next = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width))
    if (next > 0) {
      lastVolume.current = next
      setMuted(false)
    }
    setVolume(next)
  }

  const toggleMute = () => {
    if (muted) {
      setMuted(false)
      setVolume(lastVolume.current || 0.8, true)
    } else {
      lastVolume.current = volume
      setMuted(true)
      setVolume(0, true)
    }
  }

  return (
    <section className="app-panel radio-app" aria-label={text.apps.radio}>
      <section
        className={screenClass('player') + ' radio-player' + (panel ? ' panel-open' : '')}
        aria-label={text.apps.radio}
        aria-hidden={hidden('player')}
        inert={hidden('player')}
      >
        <div className="radio-backdrop" style={{ '--radio-color': station.color } as CSSProperties} aria-hidden>
          {station.cover && !coverFailed && (
            <img src={station.cover} alt="" onError={() => setCoverFailedFor(station.id)} />
          )}
        </div>

        <header className="radio-head">
          <h1 className="radio-brand">{text.apps.radio}</h1>
          <div className="radio-head-actions">
            <button
              type="button"
              className="radio-corner glass"
              aria-label="收藏"
              onClick={() => setPanel(true)}
            >
              <StarGlyph size={26} />
            </button>
            <button
              type="button"
              className="radio-corner glass"
              aria-label="选台"
              onClick={openPicker}
            >
              <ListGlyph size={26} />
            </button>
          </div>
        </header>

        <div className="radio-body">
          <div className="radio-art" style={{ '--radio-color': station.color } as CSSProperties}>
            {station.cover && !coverFailed ? (
              <img src={station.cover} alt="" onError={() => setCoverFailedFor(station.id)} />
            ) : (
              <span className={station.name.length > 6 ? 'long' : undefined}>{station.name}</span>
            )}
          </div>
          <div className="radio-info">
            <h2 className="radio-name">{station.name}</h2>
            <p className="radio-program">{program}</p>
            <div className="radio-controls">
              <button
                type="button"
                className={'radio-control small favorite' + (favorite ? ' on' : '')}
                aria-label="收藏电台"
                aria-pressed={favorite}
                onClick={() => toggleFavorite()}
              >
                <StarGlyph size={30} on={favorite} />
              </button>
              <button type="button" className="radio-control" aria-label="上一台" onClick={() => step(-1)}>
                <PreviousGlyph size={54} />
              </button>
              <button
                type="button"
                className="radio-control primary"
                aria-label={playing ? '暂停' : '播放'}
                onClick={() => togglePlay()}
              >
                {playing ? <PauseGlyph size={72} /> : <PlayGlyph size={72} />}
              </button>
              <button type="button" className="radio-control" aria-label="下一台" onClick={() => step(1)}>
                <NextGlyph size={54} />
              </button>
              <div className="radio-volume">
                <button
                  type="button"
                  className="radio-control small"
                  aria-label={muted ? '取消静音' : '静音'}
                  onClick={toggleMute}
                >
                  <SpeakerGlyph size={34} volume={shown} />
                </button>
                <div
                  className="radio-slider"
                  role="slider"
                  aria-label="音量"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(shown * 100)}
                  tabIndex={0}
                  onPointerDown={(event) => {
                    event.currentTarget.setPointerCapture(event.pointerId)
                    setDragging(true)
                    volumeFrom(event)
                  }}
                  onPointerMove={(event) => {
                    if (dragging) volumeFrom(event)
                  }}
                  onPointerUp={() => {
                    setDragging(false)
                    setVolume(useRadio.getState().volume, true)
                  }}
                  onPointerCancel={() => setDragging(false)}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft') {
                      event.preventDefault()
                      setVolume(Math.max(0, volume - 0.05), true)
                    }
                    if (event.key === 'ArrowRight') {
                      event.preventDefault()
                      setVolume(Math.min(1, volume + 0.05), true)
                    }
                  }}
                >
                  <span style={{ width: `${shown * 100}%` }} />
                </div>
              </div>
            </div>
          </div>
        </div>

        <aside className="radio-favorites" aria-label="收藏" aria-hidden={!panel} inert={!panel}>
          <header className="radio-favorites-head">
            <h2>收藏</h2>
            <button
              type="button"
              className="radio-corner glass"
              aria-label="关闭收藏"
              onClick={() => setPanel(false)}
            >
              <CloseGlyph size={26} />
            </button>
          </header>
          <div className="radio-favorites-list">
            {favorites.length === 0 ? (
              <div className="radio-empty">
                <StarGlyph size={56} />
                <strong>暂无收藏</strong>
                <span>在播放页点星标添加</span>
              </div>
            ) : (
              favorites.map((each) => (
                <div
                  key={each.id}
                  className="radio-fav-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => choose(each)}
                  onKeyDown={(event) => {
                    if ((event.target as HTMLElement).closest('.radio-remove')) return
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      choose(each)
                    }
                  }}
                >
                  <span
                    className={'radio-logo' + (each.mark.length > 2 ? ' long' : '')}
                    style={{ '--radio-color': each.color } as CSSProperties}
                  >
                    {each.mark}
                  </span>
                  <span className="radio-row-text">
                    <span className="radio-row-name">{each.name}</span>
                    <span className="radio-row-meta">{each.program}</span>
                  </span>
                  <button
                    type="button"
                    className="radio-remove"
                    aria-label="取消收藏"
                    onClick={(event) => {
                      event.stopPropagation()
                      removeFavorite(each.id)
                    }}
                  >
                    <StarGlyph size={28} on />
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>
      </section>

      <section
        className={screenClass('regions')}
        aria-label="地区"
        aria-hidden={hidden('regions')}
        inert={hidden('regions')}
      >
        <header className="radio-nav">
          <button
            type="button"
            className="radio-nav-btn"
            aria-label="返回播放"
            onClick={() => go(['player'])}
          >
            <BackGlyph size={24} />
          </button>
          <h1>地区</h1>
        </header>
        <div className="radio-list">
          {RADIO_REGIONS.map(({ name }) => (
            <button type="button" key={name} className="radio-row" onClick={() => openRegion(name)}>
              <span className="radio-row-name">{name}</span>
              <span className="radio-chev">
                <ChevronRightGlyph size={22} />
              </span>
            </button>
          ))}
        </div>
      </section>

      <section
        className={screenClass('stations')}
        aria-label="电台"
        aria-hidden={hidden('stations')}
        inert={hidden('stations')}
      >
        <header className="radio-nav">
          <button
            type="button"
            className="radio-nav-btn"
            aria-label="返回地区"
            onClick={() => go(['player', 'regions'])}
          >
            <BackGlyph size={24} />
          </button>
          <h1>{region}</h1>
        </header>
        <div className="radio-list">
          {stations.length === 0 ? (
            <button
              type="button"
              className="radio-row"
              onClick={() => requestStations(regionCodeOf(region), true)}
            >
              <span className="radio-row-name">
                {stationsFailed ? '无法载入，点按重试' : stationsLoaded ? '暂无电台' : '正在载入…'}
              </span>
            </button>
          ) : (
            stations.map((each) => (
              <button
                type="button"
                key={each.id}
                className={'radio-row radio-station-row' + (each.id === station.id ? ' playing' : '')}
                onClick={() => choose(each)}
              >
                <span
                  className={'radio-logo' + (each.mark.length > 2 ? ' long' : '')}
                  style={{ '--radio-color': each.color } as CSSProperties}
                >
                  {each.mark}
                </span>
                <span className="radio-row-text">
                  <span className="radio-row-name">{each.name}</span>
                  <span className="radio-row-meta">{each.program}</span>
                </span>
                {each.id === station.id ? (
                  <span className="radio-eq" aria-hidden>
                    <i />
                    <i />
                    <i />
                  </span>
                ) : (
                  <span className="radio-chev">
                    <ChevronRightGlyph size={22} />
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      </section>
    </section>
  )
}
