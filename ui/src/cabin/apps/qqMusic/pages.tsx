import {
  type CSSProperties,
  type ReactNode,
  type UIEventHandler,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { TextField } from '../../keyboard/TextField'
import { useLanguage, useText } from './text'
import {
  addToLibrary,
  ask,
  type AppleMusicDaily,
  type AppleMusicItem,
  type AppleMusicResults,
  type AppleMusicSection,
  type AppleMusicShelf,
  type AppleMusicTrack,
  clearRecent,
  type LibraryLook,
  openArtist,
  openItem,
  openSearchGroup,
  openView,
  playFrom,
  playSearchTrack,
  remember,
  setLibraryLook,
  signIn,
  useAccount,
  useAdded,
  useQqMusic,
  useAsked,
  useShownAgain,
  type SearchGroup,
  type View,
} from './qqMusic'
import {
  AllGlyph,
  CheckGlyph,
  ChevronRightGlyph,
  FilterGlyph,
  GridGlyph,
  LibraryGlyph,
  ListGlyph,
  MoreGlyph,
  NoteGlyph,
  PlayGlyph,
  PlusGlyph,
  RadioGlyph,
  SearchGlyph,
  ShuffleGlyph,
  StarGlyph,
} from './glyphs'
import { Cover, Explicit, Failed, Loading, Section, SectionHead, SongRow, Tile } from './parts'

/** The Music app's pages: each tab's own (Home, New, Radio, the Library, Search), and the pages over them. */

/** A page that scrolls, its large title on top (Apple's). */
function Scroll({
  title,
  children,
  onScroll,
}: {
  title?: string
  children: ReactNode
  onScroll?: UIEventHandler<HTMLDivElement>
}) {
  return (
    <div className="am-scroll" onScroll={onScroll}>
      {title && <h1 className="am-title">{title}</h1>}
      {children}
    </div>
  )
}

/** A question's answer as a page: Apple's spinner while it comes, Try Again if it didn't. */
function Answered<T>({
  asked,
  title,
  children,
}: {
  asked: { answer: T | null; failed: boolean; retry(): void }
  title?: string
  children(answer: T): ReactNode
}) {
  if (asked.failed) {
    return (
      <Scroll title={title}>
        <Failed onRetry={asked.retry} />
      </Scroll>
    )
  }
  if (!asked.answer) {
    return (
      <Scroll title={title}>
        <Loading />
      </Scroll>
    )
  }
  return <>{children(asked.answer)}</>
}

/** Sections, the first of Home (what was played lately) named here. */
function Sections({ sections }: { sections: AppleMusicSection[] }) {
  const text = useText()
  return (
    <>
      {sections.map((section, i) => (
        <Section
          key={`${section.title}:${i}`}
          section={section}
          title={section.style === 'recent' ? text.appleMusic.recentlyPlayed : undefined}
        />
      ))}
    </>
  )
}

/** Apple's card asking to sign in (Home and the Library, signed out). */
function Pitch({ title, text: words }: { title: string; text: string }) {
  const text = useText()
  const signingIn = useQqMusic((state) => state.signingIn)
  return (
    <div className="am-pitch">
      <span className="am-pitch-mark" aria-hidden>
        <NoteGlyph size={52} />
      </span>
      <div className="am-pitch-text">
        <h2>{title}</h2>
        {(signingIn || words) && <p>{signingIn ? text.appleMusic.finishOnPc : words}</p>}
      </div>
      <button type="button" className="am-pill key" onClick={signIn} disabled={signingIn}>
        {text.appleMusic.signIn}
      </button>
    </div>
  )
}

/** Home: the daily 30 and 猜你喜欢 on top, then asked again each time it's shown again. */
export function Home({ shown }: { shown: boolean }) {
  const text = useText()
  const account = useAccount()
  const visits = useQqMusic((state) => state.visits.home)
  const shownAgain = useShownAgain(shown)
  // The skills API's key is read first (its page opened once, signed in), then Home and the daily 30.
  const keyAsked = useAsked(account === 'in' ? { ask: 'key' } : null)
  const key = keyAsked.answer
  const ready = account === 'in' && (key !== null || keyAsked.failed)
  const dailyAsked = useAsked(account === 'in' && key ? { ask: 'daily' } : null, visits + shownAgain)
  const asked = useAsked(ready ? { ask: 'home' } : null, visits + shownAgain)
  const title = '首页'
  if (account === 'unknown') {
    return (
      <Scroll title={title}>
        <Loading />
      </Scroll>
    )
  }
  if (account === 'out') {
    // Signed out, Home is the ask to sign in alone: nothing else is shown or asked before it.
    return (
      <Scroll title={title}>
        <Pitch title="需要登录" text="" />
      </Scroll>
    )
  }
  return (
    <Answered asked={asked} title={title}>
      {(page) => {
        const hero = page.sections.find((section) => section.style === 'hero')
        const station = hero?.items[0] ?? null
        const sections = page.sections.filter((section) => section !== hero)
        return (
          <Scroll title={title}>
            <TopRow
              daily={dailyAsked.answer}
              station={station}
              keyFailed={keyAsked.failed}
              dailyFailed={dailyAsked.failed}
              onRetry={() => {
                if (keyAsked.failed) keyAsked.retry()
                else if (dailyAsked.answer || dailyAsked.failed) dailyAsked.retry()
                else asked.retry()
              }}
            />
            {sections.length === 0 && <p className="am-empty">{text.appleMusic.empty}</p>}
            <Sections sections={sections} />
          </Scroll>
        )
      }}
    </Answered>
  )
}

/** Home's first row: the daily 30 and 猜你喜欢, named above their covers (each cover whole over its own
 * blurred picture; the daily's name leads into its playlist). */
function TopRow({
  daily,
  station,
  keyFailed,
  dailyFailed,
  onRetry,
}: {
  daily: AppleMusicDaily | null
  station: AppleMusicItem | null
  keyFailed: boolean
  dailyFailed: boolean
  onRetry(): void
}) {
  let dailyError: 'apiKey' | 'api' | null = null
  if (daily?.error) dailyError = daily.error
  else if (!daily && (dailyFailed || keyFailed)) dailyError = keyFailed ? 'apiKey' : 'api'
  const name =
    dailyError === 'apiKey' ? 'API Key异常' : dailyError === 'api' ? 'API异常' : (daily?.item?.name ?? '每日30首')
  const cover = daily?.item?.image ?? null
  const tracks = daily?.tracks ?? []
  return (
    <div className="am-top">
      <div className="am-top-item">
        <button
          type="button"
          className="am-top-name"
          onClick={
            dailyError
              ? onRetry
              : () => {
                  if (daily?.item) openView({ kind: 'collection', item: daily.item })
                }
          }
        >
          {name}
          {!dailyError && (
            <span className="am-top-more" aria-hidden>
              ›
            </span>
          )}
        </button>
        <div className="am-top-card">
          {cover && <span className="am-top-blur" style={{ backgroundImage: `url(${cover})` }} />}
          <button
            type="button"
            className="am-top-cover"
            aria-label={name}
            onClick={
              dailyError
                ? onRetry
                : () => {
                    if (daily?.item && tracks.length > 0) playFrom(daily.item, tracks, 0)
                  }
            }
          >
            {cover ? <img src={cover} alt="" draggable={false} /> : <NoteGlyph size={46} />}
          </button>
        </div>
      </div>
      <div className="am-top-item">
        <button type="button" className="am-top-name" disabled={!station} onClick={() => station && openItem(station)}>
          {station?.name ?? '猜你喜欢'}
        </button>
        <button type="button" className="am-top-card" disabled={!station} onClick={() => station && openItem(station)}>
          {station?.image && <span className="am-top-blur" style={{ backgroundImage: `url(${station.image})` }} />}
          <span className="am-top-cover">
            {station?.image ? <img src={station.image} alt="" draggable={false} /> : <RadioGlyph size={46} />}
          </span>
        </button>
      </div>
    </div>
  )
}

export function New({ shown }: { shown: boolean }) {
  const asked = useAsked(shown ? { ask: 'new' } : null)
  return (
    <Answered asked={asked} title="雷达">
      {(page) => (
        <Scroll title="雷达">
          <Sections sections={page.sections} />
        </Scroll>
      )}
    </Answered>
  )
}

export function Radio({ shown }: { shown: boolean }) {
  const visits = useQqMusic((state) => state.visits.radio)
  const asked = useAsked(shown ? { ask: 'radio' } : null, visits + useShownAgain(shown))
  return (
    <Answered asked={asked} title="为你推荐">
      {(page) => (
        <Scroll title="为你推荐">
          <Sections sections={dedupe(page.sections)} />
        </Scroll>
      )}
    </Answered>
  )
}

/** Apple's Radio repeats its first big cards in a second carousel: once is enough here. */
function dedupe(sections: AppleMusicSection[]): AppleMusicSection[] {
  const seen = new Set<string>()
  return sections.filter((section) => {
    const key = `${section.style}:${section.items[0]?.id ?? section.songs[0]?.id ?? section.title}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const SHELVES: AppleMusicShelf[] = ['playlists', 'artists', 'songs']

export function Library() {
  const text = useText()
  const account = useAccount()
  const title = '我的音乐'
  if (account !== 'in') {
    return (
      <Scroll title={title}>
        {account === 'out' ? (
          <Pitch title={text.appleMusic.libraryPitch.title} text={text.appleMusic.libraryPitch.text} />
        ) : (
          <Loading />
        )}
      </Scroll>
    )
  }
  return (
    <Scroll title={title}>
      <div className="am-list">
        {SHELVES.map((shelf) => (
          <button
            key={shelf}
            type="button"
            className="am-list-row"
            onClick={() => openView({ kind: 'library', shelf })}
          >
            <LibraryRowGlyph shelf={shelf} />
            <span>{shelfName(text, shelf)}</span>
            <ChevronRightGlyph size={28} />
          </button>
        ))}
      </div>
    </Scroll>
  )
}

function shelfName(text: ReturnType<typeof useText>, shelf: AppleMusicShelf): string {
  const words = text.appleMusic
  return shelf === 'playlists'
    ? '我创建的歌单'
    : shelf === 'artists'
      ? '我的已购'
      : shelf === 'albums'
        ? '我收藏的专辑'
        : shelf === 'songs'
          ? '我喜欢的音乐'
          : words.recentlyAdded
}

/** The Library's rows' glyphs, in Apple Music's key colour. */
function LibraryRowGlyph({ shelf }: { shelf: AppleMusicShelf }) {
  return (
    <span className="am-list-glyph" aria-hidden>
      {shelf === 'songs' ? <NoteGlyph size={30} /> : <LibraryGlyph size={30} />}
    </span>
  )
}

/** Search's own page: the field is in the app's bar; under it, what was searched lately and Apple Music's
 * categories. */
export function Search({ shown = true }: { shown?: boolean }) {
  const text = useText()
  const recent = useQqMusic((state) => state.recent)
  const asked = useAsked(shown ? { ask: 'browse' } : null)
  return (
    <Scroll title="搜索">
      {recent.length > 0 && (
        <section className="am-section">
          <div className="am-section-head">
            <h2>{text.appleMusic.recentlySearched}</h2>
            <button type="button" className="am-link" onClick={clearRecent}>
              {text.appleMusic.clear}
            </button>
          </div>
          <div className="am-shelf">
            {recent.map((item) => (
              <Tile key={item.id} item={item} />
            ))}
          </div>
        </section>
      )}
      <section className="am-section">
        <div className="am-section-head">
          <h2>{text.appleMusic.browseCategories}</h2>
        </div>
        {asked.failed ? (
          <Failed onRetry={asked.retry} />
        ) : !asked.answer ? (
          <Loading />
        ) : (
          <div className="am-categories">
            {asked.answer.map((category) => (
              <button
                key={category.id}
                type="button"
                className="am-category"
                style={{ '--cover': category.color } as CSSProperties}
                onClick={() => openItem(category)}
              >
                {category.image && <img src={category.image} alt="" draggable={false} />}
                <b>{category.name}</b>
              </button>
            ))}
          </div>
        )}
      </section>
    </Scroll>
  )
}

/** What's typed in the search field: the results as it's typed (a pause in the typing before asking). */
export function Typing({ query, onPicked }: { query: string; onPicked(): void }) {
  const [asked, setAsked] = useState(query.trim())
  useEffect(() => {
    const timer = setTimeout(() => setAsked(query.trim()), 250)
    return () => clearTimeout(timer)
  }, [query])
  if (!asked) return <Search />
  return <Results query={asked} onPicked={onPicked} />
}

/** A search's results: its groups one under the other (songs, artists, albums, playlists), each its first
 * results in three columns of two rows; a group's title row opens all of it. */
function Results({ query, onPicked }: { query: string; onPicked?(): void }) {
  const text = useText()
  const asked = useAsked({ ask: 'search', query })
  const words = text.appleMusic
  return (
    <Answered asked={asked}>
      {(results) => {
        const none =
          results.songs.length +
            results.artists.length +
            results.albums.length +
            results.playlists.length ===
          0
        if (none) {
          return (
            <Scroll>
              <div className="am-none">
                <h2>{words.noResults}</h2>
                <p>{words.noResultsHint}</p>
              </div>
            </Scroll>
          )
        }
        const pick = (item: AppleMusicItem) => {
          remember(item)
          onPicked?.()
          openItem(item)
        }
        const group = (title: string, kind: SearchGroup, children: ReactNode) => (
          <section className="am-section am-search-group">
            <SectionHead title={title} onAll={() => openSearchGroup(query, kind)} />
            <div className="am-shelf">{children}</div>
          </section>
        )
        return (
          <Scroll>
            {results.songs.length > 0 &&
              group(
                words.songs,
                'songs',
                results.songs
                  .slice(0, 6)
                  .map((track) => (
                    <SongRow key={track.id} track={track} cover onPlay={() => playSearchTrack(track)} />
                  )),
              )}
            {results.artists.length > 0 &&
              group(
                words.artists,
                'artists',
                results.artists
                  .slice(0, 6)
                  .map((item) => <SearchItem key={item.id} item={item} onPick={pick} />),
              )}
            {results.albums.length > 0 &&
              group(
                words.albums,
                'albums',
                results.albums
                  .slice(0, 6)
                  .map((item) => <SearchItem key={item.id} item={item} onPick={pick} />),
              )}
            {results.playlists.length > 0 &&
              group(
                words.playlists,
                'playlists',
                results.playlists
                  .slice(0, 6)
                  .map((item) => <SearchItem key={item.id} item={item} onPick={pick} />),
              )}
          </Scroll>
        )
      }}
    </Answered>
  )
}

/** One of a search's groups: every result it has, one a row; scrolled to the bottom, the site's next page. */
function SearchGroupPage({ query, group }: { query: string; group: SearchGroup }) {
  const text = useText()
  const words = text.appleMusic
  const titles: Record<SearchGroup, string> = {
    songs: words.songs,
    artists: words.artists,
    albums: words.albums,
    playlists: words.playlists,
  }
  const title = titles[group]
  const [songs, setSongs] = useState<AppleMusicTrack[]>([])
  const [items, setItems] = useState<AppleMusicItem[]>([])
  const [failed, setFailed] = useState(false)
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)
  const page = useRef(0)
  const busy = useRef(false)
  /** The rows this page has shown: a page that brings none new is the last (the site may repeat one). */
  const seen = useRef(new Set<string>())
  /** The last page whose answer was taken (an answer to a page already taken, as the first one asked twice, is
   * the same rows again: not the last page). */
  const applied = useRef(0)

  const listOf = (answer: AppleMusicResults) =>
    group === 'songs' ? answer.songs : group === 'artists' ? answer.artists : group === 'albums' ? answer.albums : answer.playlists
  const fill = (answer: AppleMusicResults, next: number) => {
    if (next <= applied.current) return
    applied.current = next
    const list = listOf(answer)
    const fresh = list.filter((each) => !seen.current.has(each.id))
    for (const each of fresh) seen.current.add(each.id)
    if (group === 'songs') setSongs((was) => [...was, ...(fresh as AppleMusicTrack[])])
    else setItems((was) => [...was, ...(fresh as AppleMusicItem[])])
    setDone(list.length === 0 || (next > 1 && fresh.length === 0))
  }
  const load = (next: number) => {
    if (busy.current) return
    busy.current = true
    setLoading(true)
    ask({ ask: 'search', query, page: next, group }).then(
      (answer) => {
        page.current = next
        fill(answer, next)
        setLoading(false)
        busy.current = false
      },
      () => {
        setLoading(false)
        busy.current = false
        setFailed(true)
      },
    )
  }

  useEffect(() => {
    page.current = 0
    busy.current = false
    seen.current = new Set()
    applied.current = 0
    setSongs([])
    setItems([])
    setFailed(false)
    setDone(false)
    setLoading(false)
    // The results page asked for the first page already: its answer is this group's first page too.
    ask({ ask: 'search', query }).then(
      (answer) => {
        page.current = 1
        fill(answer, 1)
      },
      () => setFailed(true),
    )
    // The query and the group stand for the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, group])

  const onScroll: UIEventHandler<HTMLDivElement> = (event) => {
    const list = event.currentTarget
    if (!done && !failed && list.scrollHeight - list.scrollTop - list.clientHeight < 240) load(page.current + 1)
  }
  if (failed && page.current === 0) {
    return (
      <Scroll title={title}>
        <Failed
          onRetry={() => {
            setFailed(false)
            load(1)
          }}
        />
      </Scroll>
    )
  }
  if (page.current === 0) {
    return (
      <Scroll title={title}>
        <Loading />
      </Scroll>
    )
  }
  return (
    <Scroll title={title} onScroll={onScroll}>
      {group === 'songs' ? (
        <div className="am-songs">
          {songs.map((track) => (
            <SongRow key={track.id} track={track} cover onPlay={() => playSearchTrack(track)} />
          ))}
        </div>
      ) : (
        <div className="am-songs">
          {items.map((item) => (
            <SearchItem key={item.id} item={item} onPick={(picked) => openItem(picked)} />
          ))}
        </div>
      )}
      {loading && <Loading />}
      {failed && !loading && (
        <Failed
          onRetry={() => {
            setFailed(false)
            load(page.current + 1)
          }}
        />
      )}
    </Scroll>
  )
}

/** A search's artist, album or playlist as a row: its cover, its name and who it's by. */
function SearchItem({ item, onPick }: { item: AppleMusicItem; onPick(item: AppleMusicItem): void }) {
  return (
    <button type="button" className="am-song" onClick={() => onPick(item)}>
      <span className="am-song-cover">
        <Cover item={item} />
      </span>
      <span className="am-song-text">
        <span className="am-song-name">{item.name}</span>
        {item.by && <span className="am-song-by">{item.by}</span>}
      </span>
    </button>
  )
}

/** A page over a tab's own (`shown`: on top, showing). */
export function Page({ view, shown }: { view: View; shown: boolean }) {
  switch (view.kind) {
    case 'collection':
      return <CollectionPage item={view.item} visible={shown} nonce={view.id} />
    case 'artist':
      return <ArtistPage item={view.item} />
    case 'curator':
      return <CuratorPage item={view.item} />
    case 'results':
      return <Results query={view.query} />
    case 'searchGroup':
      return <SearchGroupPage query={view.query} group={view.group} />
    case 'library':
      return <LibraryShelfPage shelf={view.shelf} folder={view.folder} shown={shown} nonce={view.id} />
    case 'section':
      return <SectionPage section={view.section} />
  }
}

/** An album's or playlist's page: the cover beside its name, who it's by, Play and Shuffle; its songs under.
 * Asked afresh each time it is opened (`nonce`) or shown again: a song liked since (or one taken out of a
 * playlist) is in its list the next time. */
function CollectionPage({ item, visible, nonce }: { item: AppleMusicItem; visible: boolean; nonce: number }) {
  const text = useText()
  const asked = useAsked({ ask: 'collection', id: item.id }, nonce + useShownAgain(visible))
  const page = asked.answer
  const shown = page?.item ?? item
  const tracks = page?.tracks ?? []
  const album = shown.kind === 'album'
  const length = tracks.reduce((sum, track) => sum + track.duration, 0)
  const words = text.appleMusic
  return (
    <div className="am-scroll" style={{ '--cover': shown.color } as CSSProperties}>
      <header className="am-collection-head">
        <Cover item={shown} className="am-collection-cover" />
        <div className="am-collection-text">
          <h1>
            {shown.name}
            {shown.explicit && <Explicit />}
          </h1>
          {shown.by && (
            <p className="am-collection-by">
              {album && page?.tracks[0]?.artistId ? (
                <button type="button" onClick={() => openArtist(page.tracks[0].artistId!, shown.by)}>
                  {shown.by}
                </button>
              ) : (
                shown.by
              )}
            </p>
          )}
          {page && (page.genre || page.year) && (
            <p className="am-collection-meta">{[page.genre, page.year].filter(Boolean).join(' · ')}</p>
          )}
          <div className="am-actions">
            <button
              type="button"
              className="am-pill key"
              disabled={tracks.length === 0}
              onClick={() => playFrom(shown, tracks, null, false)}
            >
              <PlayGlyph size={26} />
              {words.play}
            </button>
            <button
              type="button"
              className="am-pill key"
              disabled={tracks.length === 0}
              onClick={() => playFrom(shown, tracks, null, true)}
            >
              <ShuffleGlyph size={26} />
              {words.shuffle}
            </button>
            <AddButton id={shown.id} />
          </div>
          {page?.description && <p className="am-collection-note">{plain(page.description)}</p>}
        </div>
      </header>
      {asked.failed && <Failed onRetry={asked.retry} />}
      {!page && !asked.failed && <Loading />}
      {page && (
        <>
          <div className="am-songs">
            {tracks.map((track, i) => (
              <SongRow
                key={`${track.id}:${i}`}
                track={track}
                contextId={shown.id}
                cover={!album}
                number={album ? (track.number ?? i + 1) : null}
                onPlay={() => playFrom(shown, tracks, i)}
                end={
                  !album ? null : track.artist !== shown.by ? (
                    <span className="am-song-aside">{track.artist}</span>
                  ) : null
                }
              />
            ))}
          </div>
          {tracks.length > 0 && <p className="am-foot">{words.length(tracks.length, length)}</p>}
        </>
      )}
    </div>
  )
}

/** Apple's editors' notes come with a little HTML: shown as plain text. */
function plain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, '’')
}

/** Add to Library (+), a check once added. */
function AddButton({ id }: { id: string }) {
  const text = useText()
  const added = useAdded(id)
  return (
    <button
      type="button"
      className="am-round"
      aria-label={text.appleMusic.addToLibrary}
      disabled={added}
      onClick={() => addToLibrary(id, { added: text.appleMusic.added })}
    >
      {added ? <CheckGlyph size={28} /> : <PlusGlyph size={28} />}
    </button>
  )
}

/** An artist's page: their picture across the top, their name on it and Play; their songs, albums and their
 * own words under it, a tab each; the songs' next page comes as the list's bottom is reached. */
function ArtistPage({ item }: { item: AppleMusicItem }) {
  const text = useText()
  const asked = useAsked({ ask: 'artist', id: item.id })
  const page = asked.answer
  const shown = page?.item ?? item
  const picture = shown.wide ?? shown.image
  const words = text.appleMusic
  // Its groups, one showing under the tabs: its songs, its albums, its own words (QQ Music's page).
  const [tab, setTab] = useState<'songs' | 'albums' | 'bio'>('songs')
  const groups: { id: typeof tab; label: string }[] = [
    { id: 'songs', label: words.songs },
    { id: 'albums', label: words.albums },
  ]
  if (shown.note) groups.push({ id: 'bio', label: words.bio ?? 'Bio' })
  const albums = page?.albums ?? []
  // The songs so far and the page the site's next one is (a page brings thirty).
  const [songs, setSongs] = useState<AppleMusicTrack[]>([])
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const last = useRef(0)
  const busy = useRef(false)
  const seen = useRef(new Set<string>())

  useEffect(() => {
    if (!page) return
    setSongs(page.top)
    seen.current = new Set(page.top.map((track) => track.id))
    last.current = 1
    setMore(page.top.length >= 30)
  }, [page])

  const load = (next: number) => {
    if (busy.current) return
    busy.current = true
    setLoading(true)
    ask({ ask: 'artist', id: item.id, page: next }).then(
      (answer) => {
        const fresh = answer.top.filter((track) => !seen.current.has(track.id))
        for (const track of fresh) seen.current.add(track.id)
        setSongs((was) => [...was, ...fresh])
        last.current = next
        // A page that brings none new is the last (the site may repeat one).
        setMore(answer.top.length >= 30 && fresh.length > 0)
        setLoading(false)
        busy.current = false
      },
      () => {
        setLoading(false)
        busy.current = false
        setMore(false)
      },
    )
  }
  const onScroll: UIEventHandler<HTMLDivElement> = (event) => {
    if (tab !== 'songs' || !more) return
    const list = event.currentTarget
    if (list.scrollHeight - list.scrollTop - list.clientHeight < 240) load(last.current + 1)
  }
  return (
    <div className="am-scroll am-artist" style={{ '--cover': shown.color } as CSSProperties} onScroll={onScroll}>
      <header className="am-artist-head">
        {picture && <img src={picture} alt="" draggable={false} />}
        <div className="am-artist-name">
          <button
            type="button"
            className="am-play-round"
            aria-label={words.play}
            disabled={songs.length === 0}
            onClick={() => songs.length > 0 && playFrom(shown, songs, null, false)}
          >
            <PlayGlyph size={34} />
          </button>
          <h1>{shown.name}</h1>
        </div>
      </header>
      <nav className="am-artist-tabs">
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            className={tab === group.id ? 'on' : undefined}
            onClick={() => setTab(group.id)}
          >
            {group.label}
          </button>
        ))}
      </nav>
      {asked.failed && <Failed onRetry={asked.retry} />}
      {!page && !asked.failed && <Loading />}
      {page && tab === 'songs' && (
        <>
          <div className="am-songs">
            {songs.map((track, i) => (
              <SongRow key={track.id} track={track} cover onPlay={() => playFrom(shown, songs, i)} />
            ))}
          </div>
          {loading && <Loading />}
        </>
      )}
      {page && tab === 'albums' && (
        <div className="am-grid">
          {albums.map((album) => (
            <Tile key={album.id} item={album} />
          ))}
        </div>
      )}
      {page && tab === 'bio' && <p className="am-artist-bio">{shown.note}</p>}
    </div>
  )
}

/** A category's page: its name, and Apple's editors' sections for it. */
function CuratorPage({ item }: { item: AppleMusicItem }) {
  const asked = useAsked({ ask: 'curator', id: item.id })
  return (
    <Answered asked={asked} title={item.name}>
      {(page) => (
        <Scroll title={item.name}>
          <Sections sections={page.sections} />
        </Scroll>
      )}
    </Answered>
  )
}

/** A section's See All: its cards in a grid, or its songs. */
function SectionPage({ section }: { section: AppleMusicSection }) {
  return (
    <Scroll title={section.title}>
      {section.songs.length > 0 ? (
        <div className="am-songs">
          {section.songs.map((track, i) => (
            <SongRow key={`${track.id}:${i}`} track={track} cover onPlay={() => playFrom(null, section.songs, i)} />
          ))}
        </div>
      ) : (
        <div className="am-grid">
          {section.items.map((item, i) => (
            <Tile key={`${item.id}:${i}`} item={item} />
          ))}
        </div>
      )}
    </Scroll>
  )
}

/** The filter's name for all of a list ("All Playlists"). */
function allOf(_text: ReturnType<typeof useText>, shelf: AppleMusicShelf): string {
  return shelf === 'albums'
    ? '所有专辑'
    : shelf === 'songs'
      ? '所有歌曲'
      : shelf === 'artists'
        ? '所有已购歌曲'
        : '所有歌单'
}

/** Which lists can show only favourites (Apple Music rates playlists, albums and songs). */
const FAVOURABLE: AppleMusicShelf[] = []

/**
 * A list of the Library, as Apple's (iOS 26): its title, and on its right the filter (all, or favourites:
 * Apple Music's red while it filters) and More (a grid or a list, and the sorts); a search field to find in
 * it; then the list, a favourite's star beside it. The sorts are Apple Music's own (playlists': its web
 * player's three), as chosen; showing as a grid or list, filtering and finding are here.
 */
function LibraryShelfPage({
  shelf,
  folder,
  shown,
  nonce,
}: {
  shelf: AppleMusicShelf
  folder?: AppleMusicItem
  shown: boolean
  nonce: number
}) {
  const text = useText()
  const language = useLanguage()
  const look = useQqMusic((state) => state.libraryLooks[shelf])
  const visits = useQqMusic((state) => state.visits.library)
  const asked = useAsked(
    {
      ask: 'library',
      shelf,
      ...(look.sort ? { sort: look.sort } : {}),
      ...(folder ? { folder: folder.id } : {}),
      // These pages' own UI is English or Turkish (a Chinese game gets English there, as YouTube Music does).
      language: language === 'tr' ? 'tr' : 'en',
    },
    visits + nonce + useShownAgain(shown),
  )
  // A new sort shows the list as it was until the sorted one comes.
  const [kept, setKept] = useState(asked.answer)
  if (asked.answer && asked.answer !== kept) setKept(asked.answer)
  const found = asked.answer ?? kept
  const [query, setQuery] = useState('')
  const title = folder?.name ?? shelfName(text, shelf)
  const wanted = query.trim().toLocaleLowerCase()
  const matches = (name: string, by: string) =>
    !wanted || name.toLocaleLowerCase().includes(wanted) || by.toLocaleLowerCase().includes(wanted)
  const favourites = look.filter === 'favorites'
  const items = (found?.items ?? []).filter((item) => (!favourites || item.favorite) && matches(item.name, item.by))
  const songs = (found?.songs ?? []).filter((song) => (!favourites || song.favorite) && matches(song.name, song.artist))
  return (
    <Scroll>
      <div className="am-page-head">
        <h1 className="am-title">{title}</h1>
        <LibraryControls shelf={shelf} look={look} sorts={found?.sorts ?? []} sort={found?.sort ?? null} />
      </div>
      <div className="am-find">
        <TextField
          id={`apple-music-library-${shelf}`}
          value={query}
          onChange={setQuery}
          hint={text.appleMusic.find}
          label={text.appleMusic.find}
          icon={<SearchGlyph size={28} />}
        />
      </div>
      {asked.failed && !found && <Failed onRetry={asked.retry} />}
      {!found && !asked.failed && <Loading />}
      {found && items.length + songs.length === 0 && <p className="am-empty">{text.appleMusic.empty}</p>}
      {songs.length > 0 && <SongList songs={songs} />}
      {items.length > 0 &&
        (look.view === 'grid' ? (
          <div className="am-grid">
            {items.map((item, i) => (
              <Tile key={`${item.id}:${i}`} item={item} />
            ))}
          </div>
        ) : (
          <div className="am-list">
            {items.map((item, i) => (
              <ListRow key={`${item.id}:${i}`} item={item} />
            ))}
          </div>
        ))}
    </Scroll>
  )
}

/** A row of a Library list: a favourite's star in the margin, the cover, the name (and who it's by), the
 * chevron. */
function ListRow({ item }: { item: AppleMusicItem }) {
  return (
    <button type="button" className="am-list-item" onClick={() => openItem(item)}>
      <span className="am-list-star" aria-hidden>
        {item.favorite && <StarGlyph size={18} on />}
      </span>
      <Cover item={item} />
      <span className="am-song-text">
        <span className="am-list-name">{item.name}</span>
        {item.kind === 'album' && item.by && <span className="am-song-by">{item.by}</span>}
      </span>
      <ChevronRightGlyph size={28} />
    </button>
  )
}

/** Where a menu sits in the app: under its buttons, their right edges together (CSS pixels of the app). */
type MenuPlace = { app: HTMLElement; top: number; right: number }

/** The filter and More, in a glass capsule; each opens its menu under it. The menu is drawn in the app, not
 *  in the page's scroller: glass inside a scroller leaves the text and hairlines under it sharp (Chromium
 *  composites them over the blur), and over it the veil keeps the page from scrolling away from the menu. */
function LibraryControls({
  shelf,
  look,
  sorts,
  sort,
}: {
  shelf: AppleMusicShelf
  look: LibraryLook
  sorts: { id: string; label: string }[]
  sort: string | null
}) {
  const text = useText()
  const [menu, setMenu] = useState<'filter' | 'more' | null>(null)
  const [place, setPlace] = useState<MenuPlace | null>(null)
  const controls = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const app = controls.current?.closest<HTMLElement>('.am-app')
    if (!menu || !app || !controls.current) return
    const outer = app.getBoundingClientRect()
    const inner = controls.current.getBoundingClientRect()
    // The cab may draw the app scaled: back to its own pixels.
    const scale = outer.width / app.offsetWidth || 1
    setPlace({ app, top: (inner.bottom - outer.top) / scale + 10, right: (outer.right - inner.right) / scale })
  }, [menu])
  const words = text.appleMusic
  const filtering = look.filter !== 'all'
  const choose = (change: Partial<LibraryLook>) => {
    setLibraryLook(shelf, change)
    setMenu(null)
  }
  const views = shelf === 'playlists' || shelf === 'albums'
  return (
    <div className="am-controls" ref={controls}>
      <div className="am-control-bar glass">
        {FAVOURABLE.includes(shelf) && (
          <button
            type="button"
            className={filtering ? 'am-control on' : 'am-control'}
            aria-label={words.filter}
            aria-expanded={menu === 'filter'}
            onClick={() => setMenu(menu === 'filter' ? null : 'filter')}
          >
            <FilterGlyph size={30} />
          </button>
        )}
        {(views || sorts.length > 0) && (
          <button
            type="button"
            className="am-control"
            aria-label={words.more}
            aria-expanded={menu === 'more'}
            onClick={() => setMenu(menu === 'more' ? null : 'more')}
          >
            <MoreGlyph size={30} />
          </button>
        )}
      </div>
      {menu &&
        place &&
        createPortal(
          <>
            <div className="am-menu-veil" onClick={() => setMenu(null)} />
            {menu === 'filter' ? (
              <div className="am-popover glass" role="menu" style={{ top: place.top, right: place.right }}>
                <MenuItem on={!filtering} glyph={<AllGlyph size={28} />} onPick={() => choose({ filter: 'all' })}>
                  {allOf(text, shelf)}
                </MenuItem>
                <hr />
                <MenuItem on={filtering} glyph={<StarGlyph size={28} />} onPick={() => choose({ filter: 'favorites' })}>
                  {words.favorites}
                </MenuItem>
              </div>
            ) : (
              <div className="am-popover glass" role="menu" style={{ top: place.top, right: place.right }}>
                {views && (
                  <>
                    <MenuItem
                      on={look.view === 'grid'}
                      glyph={<GridGlyph size={28} />}
                      onPick={() => choose({ view: 'grid' })}
                    >
                      {words.grid}
                    </MenuItem>
                    <MenuItem
                      on={look.view === 'list'}
                      glyph={<ListGlyph size={28} />}
                      onPick={() => choose({ view: 'list' })}
                    >
                      {words.list}
                    </MenuItem>
                  </>
                )}
                {views && sorts.length > 0 && <hr />}
                {sorts.map((each) => (
                  <MenuItem key={each.id} on={each.id === sort} onPick={() => choose({ sort: each.id })}>
                    {each.label || words.sorts[each.id as keyof typeof words.sorts] || each.id}
                  </MenuItem>
                ))}
              </div>
            )}
          </>,
          place.app,
        )}
    </div>
  )
}

/** A menu's choice: its check while it's chosen, its glyph, its words. */
function MenuItem({
  on,
  glyph,
  onPick,
  children,
}: {
  on: boolean
  glyph?: ReactNode
  onPick(): void
  children: ReactNode
}) {
  return (
    <button type="button" role="menuitemradio" aria-checked={on} className="am-menu-item" onClick={onPick}>
      <span className="am-menu-check">{on && <CheckGlyph size={24} />}</span>
      {glyph && <span className="am-menu-glyph">{glyph}</span>}
      <span>{children}</span>
    </button>
  )
}

/** The Library's songs: Play and Shuffle over them, as Apple's list has. */
function SongList({ songs }: { songs: AppleMusicTrack[] }) {
  const text = useText()
  return (
    <>
      <div className="am-actions">
        <button type="button" className="am-pill key" onClick={() => playFrom(null, songs, null, false)}>
          <PlayGlyph size={26} />
          {text.appleMusic.play}
        </button>
        <button type="button" className="am-pill key" onClick={() => playFrom(null, songs, null, true)}>
          <ShuffleGlyph size={26} />
          {text.appleMusic.shuffle}
        </button>
      </div>
      <div className="am-songs">
        {songs.map((track, i) => (
          <SongRow key={`${track.id}:${i}`} track={track} cover onPlay={() => playFrom(null, songs, i)} />
        ))}
      </div>
    </>
  )
}
