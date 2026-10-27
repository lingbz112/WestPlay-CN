// QQ Music, in its own web pages (qq_music.rs). The copied Apple Music app is WestPlay's face; this
// script is the adapter that makes QQ Music's own pages answer the same questions and play its sound.
//
// Two pages are run: a browser page (search, home, playlist and artist pages) and a player page (the
// standalone QQ Music player). QQ Music only plays for a signed-in account; without one the pages still
// browse, and the app says what it can't play.
;(() => {
  if (!/(^|\.)y\.qq\.com$/.test(location.hostname)) return
  const role = window.__westplayRole === 'player' ? 'player' : 'browse'
  const post = (message) => window.chrome?.webview?.postMessage({ role, ...message })
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const norm = (value) => String(value ?? '').replace(/\s+/g, ' ').trim()
  const one = (selector, root = document) => root.querySelector(selector)
  const all = (selector, root = document) => [...root.querySelectorAll(selector)]
  const ORIGIN = 'https://y.qq.com'
  const HOME = `${ORIGIN}/`
  const PLAYER = `${ORIGIN}/n/ryqq_v2/player`
  const COLOR = '#31c27c'
  const DEFAULT_IMAGE = `${ORIGIN}/mediastyle/global/img/album_300.png`

  // --- Login -----------------------------------------------------------------------------------------------
  const cookie = (name) => {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie || '')
    return match ? decodeURIComponent(match[1]) : ''
  }
  const signedIn = () => {
    // The web player keeps its login in these cookies. `uin=0` is a guest, not an account.
    if (
      cookie('qm_keyst') ||
      cookie('qqmusic_key') ||
      cookie('psrf_musickey_createtime') ||
      cookie('psrf_qqunionid') ||
      cookie('psrf_qqopenid') ||
      cookie('skey') ||
      cookie('p_skey')
    )
      return true
    const uin = cookie('uin') || cookie('wxuin')
    if (uin && !/^(0|o0|o)$/i.test(uin)) return true
    // Signed in, the header's log-in link becomes the account's name or picture.
    const link = one('.top_login__link, .player_login__link')
    if (!link) return false
    if (one('img, [class*="avatar"]', link)) return true
    const words = norm(link.textContent)
    return Boolean(words && !/登录|登入|sign in/i.test(words))
  }

  const playing = () => {
    const audio = findAudio()
    if (audio) return !audio.paused && !audio.ended
    const button = one('.btn_big_play')
    if (!button) return false
    const words = norm(button.textContent)
    return /暂停|pause/i.test(words) || /pause/i.test(button.className)
  }

  const avatar = () => {
    const image = one('.top_login__link img, .player_login__link img, [class*="avatar"] img')
    const src = image?.currentSrc || image?.src || ''
    return src.startsWith('https://') && !src.startsWith('data:') ? src : null
  }

  let lastState = ''
  const sayState = () => {
    const state = { signedIn: signedIn(), playing: playing(), avatar: avatar() }
    const text = JSON.stringify(state)
    if (text !== lastState) {
      lastState = text
      post({ state })
    }
  }

  // --- Pages -----------------------------------------------------------------------------------------------
  const parseTime = (value) => {
    const parts = norm(value)
      .split(':')
      .map((part) => Number(part))
    if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) return 0
    return parts.reduce((seconds, part) => seconds * 60 + part, 0)
  }
  const pair = (value) => {
    const [position, duration] = norm(value).split('/').map(parseTime)
    return { position: position || 0, duration: duration || 0 }
  }
  const background = (element) => {
    if (!element) return null
    const image = /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(element).backgroundImage || '')
    return image?.[1] ? new URL(image[1], location.href).href : null
  }
  const imageOf = (root) => {
    const image = one('img', root)
    if (!image) return null
    const candidates = [image.currentSrc, image.src, image.getAttribute('data-src'), image.getAttribute('data-qar-def')]
    for (const candidate of candidates) {
      if (!candidate || candidate.startsWith('data:')) continue
      try {
        return new URL(candidate, location.href).href
      } catch {}
    }
    return null
  }
  const idOf = (href, kind) => {
    const pattern = kind === 'track' ? /songDetail\/([^/?#]+)/ : kind === 'album' ? /albumDetail\/([^/?#]+)/ : kind === 'artist' ? /singer\/([^/?#]+)/ : /playlist\/([^/?#]+)/
    return pattern.exec(String(href ?? ''))?.[1] ?? null
  }
  const itemOf = (anchor, kind) => {
    const id = idOf(anchor?.getAttribute('href'), kind)
    if (!id) return null
    const card = anchor.closest('li, .mod_cover, [class*="card"], [class*="item"]') ?? anchor.parentElement
    const name = norm(anchor.getAttribute('title') || anchor.textContent)
    if (!name) return null
    const by = all('a[href*="/singer/"]', card)
      .map((artist) => norm(artist.textContent))
      .filter(Boolean)
      .join(' / ')
    return {
      id: `qq:${kind}:${id}`,
      kind,
      name,
      by,
      note: '',
      image: imageOf(card) ?? DEFAULT_IMAGE,
      wide: null,
      color: COLOR,
      explicit: false,
      live: false,
    }
  }
  const trackOf = (row) => {
    const anchor = one('a[href*="/songDetail/"]', row)
    const id = idOf(anchor?.getAttribute('href'), 'track')
    if (!id) return null
    const artistAnchors = all('a[href*="/singer/"]', row)
    const artistAnchor = artistAnchors[0]
    const albumAnchor = one('a[href*="/albumDetail/"]', row)
    const time = one('[class*="time"], .songlist__time', row)?.textContent
    return {
      id: `qq:track:${id}`,
      name: norm(anchor.getAttribute('title') || anchor.textContent),
      artist: artistAnchors.map((artist) => norm(artist.textContent)).filter(Boolean).join(' / '),
      album: norm(albumAnchor?.textContent),
      albumId: albumAnchor ? `qq:album:${idOf(albumAnchor.getAttribute('href'), 'album')}` : null,
      artistId: artistAnchor ? `qq:artist:${idOf(artistAnchor.getAttribute('href'), 'artist')}` : null,
      image: imageOf(row) ?? DEFAULT_IMAGE,
      color: COLOR,
      duration: parseTime(time),
      explicit: false,
      number: Number(norm(one('[class*="number"], .songlist__number', row)?.textContent)) || null,
    }
  }
  const tracks = (root = document) => {
    const seen = new Set()
    const found = []
    for (const row of all('.songlist__item, [class*="songlist__item"], .debutlist__item', root)) {
      const track = trackOf(row)
      if (!track || seen.has(track.id)) continue
      seen.add(track.id)
      found.push(track)
    }
    return found
  }
  const items = (kind, root = document) => {
    const seen = new Set()
    const found = []
    for (const anchor of all(`a[href*="${kind === 'album' ? '/albumDetail/' : kind === 'artist' ? '/singer/' : '/playlist/'}"]`, root)) {
      const item = itemOf(anchor, kind)
      if (!item || seen.has(item.id)) continue
      seen.add(item.id)
      found.push(item)
    }
    return found
  }
  const page = (sections) => ({ sections })
  const section = (title, style, listed, songs) => ({ title, style, items: listed, songs })
  const emptyPage = () => page([])

  const homePage = async () => {
    const playlists = items('playlist').slice(0, 12)
    const songs = await enrichTracks(tracks().slice(0, 20))
    const albums = items('album').slice(0, 8)
    const sections = []
    if (playlists.length) sections.push(section('热门歌单', 'shelf', playlists, []))
    if (songs.length) sections.push(section('新歌首发', 'songs', [], songs))
    if (albums.length) sections.push(section('新碟上架', 'shelf', albums, []))
    return page(sections)
  }
  const newPage = async () => {
    const albums = items('album').slice(0, 16)
    const songs = await enrichTracks(tracks().slice(0, 24))
    const sections = []
    if (albums.length) sections.push(section('新碟上架', 'shelf', albums, []))
    if (songs.length) sections.push(section('新歌首发', 'songs', [], songs))
    return page(sections)
  }
  const radioPage = () => {
    const toplists = [...new Set(all('a[href*="/toplist/"]'))]
      .map((anchor) => {
        const id = /toplist\/([^/?#]+)/.exec(anchor.getAttribute('href') ?? '')?.[1]
        const name = norm(anchor.getAttribute('title') || anchor.textContent)
        return id && name ? { id: `qq:toplist:${id}`, kind: 'playlist', name, by: '', note: '', image: DEFAULT_IMAGE, wide: null, color: COLOR, explicit: false, live: false } : null
      })
      .filter(Boolean)
      .slice(0, 20)
    return page(toplists.length ? [section('排行榜', 'shelf', toplists, [])] : [])
  }

  const fetchDoc = async (url) => {
    const response = await fetch(url, { credentials: 'include' })
    if (!response.ok) throw new Error(`http ${response.status}`)
    return new DOMParser().parseFromString(await response.text(), 'text/html')
  }
  const jsonLd = (doc) => {
    const found = []
    for (const script of all('script[type="application/ld+json"]', doc)) {
      try {
        const value = JSON.parse(script.textContent)
        found.push(...(Array.isArray(value) ? value : value['@graph'] ? value['@graph'] : [value]))
      } catch {}
    }
    return found
  }
  const nodeOf = (doc, type) => jsonLd(doc).find((node) => node?.['@type'] === type)
  const initialData = (doc) => {
    for (const script of all('script', doc)) {
      const code = script.textContent ?? ''
      const at = code.indexOf('window.__INITIAL_DATA__')
      if (at < 0) continue
      const start = code.indexOf('{', at)
      const end = code.lastIndexOf('}')
      if (start < 0 || end <= start) continue
      try {
        // QQ Music's SSR data has a few literal `undefined`s, which JSON doesn't.
        return JSON.parse(code.slice(start, end + 1).replace(/\bundefined\b/g, 'null'))
      } catch {}
    }
    return null
  }
  const coverOfSong = (song) => {
    const raw = song?.coverUrl || (song?.album?.pmid ? `//y.qq.com/music/photo_new/T002R300x300M000${song.album.pmid}.jpg?max_age=2592000` : '')
    if (!raw) return DEFAULT_IMAGE
    const url = raw.startsWith('//') ? `https:${raw}` : raw
    return new URL(url, location.href).href
  }
  const tracksFromInitial = (data) => {
    const songs = data?.songList ?? data?.songs ?? data?.data?.songList
    if (!Array.isArray(songs)) return []
    return songs
      .map((song, index) => {
        if (!song?.mid) return null
        const singers = Array.isArray(song.singer) ? song.singer : song.singer ? [song.singer] : []
        return {
          id: `qq:track:${song.mid}`,
          name: norm(song.name ?? song.title),
          artist: singers.map((singer) => singer?.name).filter(Boolean).join(' / '),
          album: norm(song.album?.name ?? song.album?.title),
          albumId: song.album?.mid ? `qq:album:${song.album.mid}` : null,
          artistId: singers[0]?.mid ? `qq:artist:${singers[0].mid}` : null,
          image: coverOfSong(song),
          color: COLOR,
          duration: Number(song.interval) || parseTime(song.playTime),
          explicit: Boolean(song.ov),
          number: index + 1,
        }
      })
      .filter(Boolean)
  }
  const isoDuration = (value) => {
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(value ?? ''))
    return match ? (Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0)) : 0
  }
  const artistName = (value) => (Array.isArray(value) ? value.map((artist) => artist?.name).filter(Boolean).join(' / ') : value?.name ?? '')
  const trackFromLd = (song, fallbackImage, albumName = '') => {
    const id = idOf(song?.url, 'track')
    if (!id) return null
    const album = song.inAlbum ?? {}
    const artists = Array.isArray(song.byArtist) ? song.byArtist : song.byArtist ? [song.byArtist] : []
    return {
      id: `qq:track:${id}`,
      name: norm(song.name),
      artist: artistName(song.byArtist),
      album: norm(album.name ?? albumName),
      albumId: idOf(album.url, 'album') ? `qq:album:${idOf(album.url, 'album')}` : null,
      artistId: idOf(artists[0]?.url, 'artist') ? `qq:artist:${idOf(artists[0]?.url, 'artist')}` : null,
      image: song.image ? new URL(song.image, location.href).href : fallbackImage,
      color: COLOR,
      duration: isoDuration(song.duration),
      explicit: false,
      number: Number(song.position) || null,
    }
  }
  const missingCover = (image) =>
    !image || image === DEFAULT_IMAGE || image.includes('mediastyle/global/img/album_300')

  /**
   * QQ's home and search rows are lazily drawn: their <img> often holds only a transparent GIF and the
   * generic album placeholder. Ask each song's own page for its MusicRecording JSON-LD, whose image is the
   * real album cover (and fills in a missing album or length too).
   */
  const enrichTracks = async (list, most = 16) => {
    const missing = list.filter((track) => missingCover(track.image)).slice(0, most)
    if (missing.length) post({ log: `covers missing ${missing.length}/${list.length}` })
    await Promise.all(
      missing.map(async (track) => {
        const mid = String(track.id).split(':').pop()
        if (!mid) return
        try {
          const doc = await fetchDoc(`${ORIGIN}/n/ryqq_v2/songDetail/${mid}`)
          const node = nodeOf(doc, 'MusicRecording')
          if (!node) return
          if (node.image) track.image = new URL(node.image, location.href).href
          if (node.inAlbum?.name) track.album = norm(node.inAlbum.name)
          if (node.inAlbum?.url) {
            const album = idOf(node.inAlbum.url, 'album')
            if (album) track.albumId = `qq:album:${album}`
          }
          if (!track.artist) track.artist = artistName(node.byArtist)
          const artist = Array.isArray(node.byArtist) ? node.byArtist[0] : node.byArtist
          if (!track.artistId && artist?.url) {
            const id = idOf(artist.url, 'artist')
            if (id) track.artistId = `qq:artist:${id}`
          }
          if (!track.duration) track.duration = isoDuration(node.duration)
        } catch {}
      }),
    )
    if (missing.length) post({ log: `covers done ${missing.length}/${list.length}` })
    return list
  }
  const collectionAnswer = async (id) => {
    const parts = String(id).split(':')
    const collectionKind = parts[1] === 'album' ? 'album' : 'playlist'
    const collectionId = parts.slice(2).join(':')
    if (!collectionId) return null
    const url = parts[1] === 'album' ? `${ORIGIN}/n/ryqq_v2/albumDetail/${collectionId}` : parts[1] === 'toplist' ? `${ORIGIN}/n/ryqq_v2/toplist/${collectionId}` : `${ORIGIN}/n/ryqq_v2/playlist/${collectionId}`
    const doc = await fetchDoc(url)
    const data = initialData(doc)
    const node = nodeOf(doc, collectionKind === 'album' ? 'MusicAlbum' : 'MusicPlaylist') ?? nodeOf(doc, 'MusicPlaylist') ?? nodeOf(doc, 'MusicAlbum')
    const listed = node?.track ?? node?.tracks ?? []
    const fallback = node?.image ?? DEFAULT_IMAGE
    const found = listed.map((song) => trackFromLd(song, fallback, node?.name)).filter(Boolean)
    const structured = tracksFromInitial(data)
    let rows = structured.length ? structured : found.length ? found : tracks(doc)
    if (!structured.length && found.length) {
      // The structured list carries names and covers, the page's rows carry lengths and albums.
      const detail = new Map(tracks(doc).map((track) => [track.id, track]))
      rows = found.map((track) => {
        const row = detail.get(track.id)
        return row
          ? {
              ...track,
              album: track.album || row.album,
              albumId: track.albumId || row.albumId,
              artistId: track.artistId || row.artistId,
              image: track.image || row.image,
              duration: track.duration || row.duration,
              number: track.number || row.number,
            }
          : track
      })
    }
    if (!node && rows.length === 0) {
      // A playlist the server didn't put in JSON-LD: its own page, with the site's scripts.
      const path = new URL(url).pathname
      if (!location.pathname.includes(path)) {
        location.href = url
        return null
      }
      for (let i = 0; i < 24 && rows.length === 0; i++) {
        await sleep(250)
        rows = tracks(document)
      }
    }
    const item = node
      ? {
          id: `qq:${collectionKind}:${collectionId}`,
          kind: collectionKind,
          name: norm(node.name),
          by: artistName(node.author ?? node.byArtist),
          note: norm(node.description),
          image: fallback,
          wide: null,
          color: COLOR,
          explicit: false,
          live: false,
        }
      : {
          id: `qq:${collectionKind}:${collectionId}`,
          kind: collectionKind,
          name:
            norm(data?.detail?.title) ||
            norm(one('h1, .playlist__title, .album__title', document)?.textContent) ||
            'QQ Music',
          by: norm(data?.detail?.host_nick ?? data?.detail?.creator?.nick),
          note: norm(data?.detail?.desc),
          image: data?.detail?.picurl ? new URL(data.detail.picurl, location.href).href : imageOf(one('h1, .playlist__title, .album__title', document)?.parentElement) ?? DEFAULT_IMAGE,
          wide: null,
          color: COLOR,
          explicit: false,
          live: false,
        }
    return {
      item,
      description: norm(node?.description),
      genre: norm(node?.genre),
      year: Number(String(node?.dateCreated ?? node?.datePublished ?? '').slice(0, 4)) || null,
      tracks: await enrichTracks(rows, 8),
    }
  }
  const artistAnswer = async (id) => {
    const artistId = String(id).split(':').slice(2).join(':')
    if (!artistId) return null
    const doc = await fetchDoc(`${ORIGIN}/n/ryqq_v2/singer/${artistId}`)
    const node = nodeOf(doc, 'MusicGroup')
    const item = {
      id: `qq:artist:${artistId}`,
      kind: 'artist',
      name: norm(node?.name ?? one('h1, .singer__title', doc)?.textContent ?? 'QQ Music'),
      by: '',
      note: norm(node?.description),
      image: node?.image ? new URL(node.image, location.href).href : DEFAULT_IMAGE,
      wide: null,
      color: COLOR,
      explicit: false,
      live: false,
    }
    return { item, top: await enrichTracks(tracks(doc).slice(0, 20)), sections: [] }
  }
  const libraryAnswer = async (shelf) => {
    if (!signedIn()) return { items: [], songs: [], sorts: [], sort: null }
    // The Library is drawn by QQ Music's own client script; its fetched HTML is only a shell. Open it in
    // this hidden browser and read the live page. The host re-asks after the navigation.
    if (!location.pathname.includes('/profile')) {
      post({ log: `library opening from ${location.pathname}` })
      location.href = `${ORIGIN}/n/ryqq_v2/profile`
      return null
    }
    for (let i = 0; i < 24; i++) {
      const ready =
        shelf === 'songs'
          ? all('.songlist__item, [class*="songlist__item"]', document).length > 0
          : all('a[href*="/playlist/"]', document).length > 0
      if (ready) break
      await sleep(250)
    }
    post({
      log: `library path=${location.pathname} playlists=${all('a[href*="/playlist/"]', document).length} songs=${all('.songlist__item, [class*="songlist__item"]', document).length}`,
    })
    const listed =
      shelf === 'albums' ? items('album') : shelf === 'artists' ? items('artist') : items('playlist')
    return {
      items: listed.slice(0, 60),
      songs: shelf === 'songs' ? await enrichTracks(tracks().slice(0, 100), 20) : [],
      sorts: [],
      sort: null,
    }
  }
  const lyricsAnswer = async (id) => {
    const mid = String(id).split(':').pop()
    if (!mid) return { synced: false, lines: [] }
    const path = `/n/ryqq_v2/songDetail/${mid}`
    if (!location.pathname.includes(path)) {
      location.href = `${ORIGIN}${path}`
      return null
    }
    for (let i = 0; i < 24 && !one('#lrc_content'); i++) await sleep(250)
    const container = one('#lrc_content, .lyric__cont_box, .mod_lyric')
    let text = all('p', container ?? document)
      .map((line) => norm(line.textContent))
      .filter(Boolean)
      .join('\n')
    if (!text) {
      text = container?.innerText ?? ''
    }
    if (!text) {
      const body = document.body?.innerText ?? ''
      const start = body.indexOf('歌词')
      const end = body.indexOf('评论', start + 2)
      text = start >= 0 ? body.slice(start + 2, end > start ? end : undefined) : ''
    }
    const lines = text
      .split(/\n+/)
      .map((line) => norm(line))
      .filter((line) => line && !/^(歌词|复制|展开|收起|更多)$/.test(line))
      .slice(0, 300)
      .map((line) => ({ start: 0, end: 0, text: line }))
    return { synced: false, lines, provider: 'QQ音乐', writers: [], rtl: false }
  }
  const searchAnswer = async (query) => {
    const url = `${ORIGIN}/n/ryqq_v2/search?w=${encodeURIComponent(query)}&t=song`
    if (!location.pathname.includes('/search') || new URLSearchParams(location.search).get('w') !== query) {
      location.href = url
      return null
    }
    for (let i = 0; i < 24 && tracks().length === 0; i++) await sleep(250)
    const songs = await enrichTracks(tracks().slice(0, 40))
    return { top: [], songs, artists: [], albums: [], playlists: [], stations: [] }
  }
  const ask = async (id, question) => {
    try {
      let answer = null
      switch (question?.ask) {
        case 'home':
          if (location.pathname !== '/') {
            location.href = HOME
            return
          }
          answer = await homePage()
          break
        case 'new':
          if (location.pathname !== '/') {
            location.href = HOME
            return
          }
          answer = await newPage()
          break
        case 'radio':
          if (location.pathname !== '/') {
            location.href = HOME
            return
          }
          answer = radioPage()
          break
        case 'browse':
          answer = []
          break
        case 'search':
          answer = await searchAnswer(question.query)
          break
        case 'collection':
          answer = await collectionAnswer(question.id)
          break
        case 'artist':
          answer = await artistAnswer(question.id)
          break
        case 'library':
          answer = await libraryAnswer(question.shelf)
          break
        case 'lyrics':
          answer = await lyricsAnswer(question.id)
          break
      }
      if (answer !== null) post({ answer: id, [question.ask]: answer })
    } catch {
      post({ answer: id, failed: true })
    }
  }

  // --- Playing a song from a page ---------------------------------------------------------------------------
  const PENDING = 'westplay.qq.pending'
  const remember = (command) => sessionStorage.setItem(PENDING, JSON.stringify({ ...command, at: Date.now() }))
  const forget = () => sessionStorage.removeItem(PENDING)
  const pending = () => {
    try {
      const value = JSON.parse(sessionStorage.getItem(PENDING) || 'null')
      return value && Date.now() - value.at < 120000 ? value : null
    } catch {
      return null
    }
  }
  const clickPlay = () => {
    const button = one('.mod_btn_green, .mod_cover__icon_play, [class*="list_menu__play"], [title="播放"]')
    if (button) {
      button.click()
      return true
    }
    return false
  }
  const queue = async (command) => {
    const wanted = command?.id ?? command?.songs?.[command?.index ?? 0] ?? null
    if (!wanted) return
    const parts = String(wanted).split(':')
    if (parts[0] !== 'qq') return
    if (parts[1] === 'track') {
      remember({ kind: 'track', id: wanted })
      location.href = `${ORIGIN}/n/ryqq_v2/songDetail/${parts.slice(2).join(':')}`
    } else if (parts[1] === 'playlist' || parts[1] === 'album' || parts[1] === 'toplist') {
      remember({ kind: parts[1], id: wanted })
      location.href =
        parts[1] === 'album'
          ? `${ORIGIN}/n/ryqq_v2/albumDetail/${parts.slice(2).join(':')}`
          : parts[1] === 'toplist'
            ? `${ORIGIN}/n/ryqq_v2/toplist/${parts.slice(2).join(':')}`
            : `${ORIGIN}/n/ryqq_v2/playlist/${parts.slice(2).join(':')}`
    }
  }
  const resume = async () => {
    const command = pending()
    if (!command) return
    const key = String(command.id).split(':').slice(2).join(':')
    const where =
      command.kind === 'track'
        ? 'songDetail'
        : command.kind === 'album'
          ? 'albumDetail'
          : command.kind === 'toplist'
            ? 'toplist'
            : 'playlist'
    if (!location.pathname.includes(where) || !location.pathname.includes(key)) return
    // QQ Music's own queue: the page's song list in the storage key its player reads. This avoids
    // pressing the page's Play button (which may open its log-in dialog) and carries the whole page.
    const data = window.__INITIAL_DATA__
    const songs = data?.songList ?? data?.songs
    if (Array.isArray(songs) && songs.length > 0) {
      const queue = {
        songList: songs,
        isAdd: true,
        isPlay: true,
        index: Math.max(0, Math.min(songs.length - 1, Number(command.index) || 0)),
        time: Date.now(),
        uin: '',
        isvip: false,
      }
      localStorage.setItem('playSongData', JSON.stringify({ value: queue, expire: Date.now() + 31536000000 }))
      forget()
      post({ queued: true, track: tracks()[0] ?? null })
      return
    }
    for (let i = 0; i < 24; i++) {
      if (clickPlay()) {
        await sleep(1200)
        forget()
        post({ queued: true, track: tracks()[0] ?? null })
        return
      }
      await sleep(250)
    }
  }

  // --- The player -------------------------------------------------------------------------------------------
  const findAudio = () => all('audio').find((audio) => audio.src || audio.currentSrc) ?? null
  const musicInfo = () => {
    const info = one('.player_music__info')
    const links = all('a', info ?? document)
    const titleLink = links.find((link) => /songDetail\//.test(link.getAttribute('href') ?? ''))
    const artistLink = links.find((link) => /singer\//.test(link.getAttribute('href') ?? ''))
    const text = norm(info?.textContent)
    const [title, artist] = text.includes(' - ') ? text.split(/\s+-\s+/, 2) : [text, '']
    return {
      title: norm(titleLink?.textContent ?? title),
      artist: norm(artistLink?.textContent ?? artist),
      text,
      href: titleLink?.getAttribute('href') ?? '',
    }
  }
  const currentPlayback = () => {
    const audio = findAudio()
    const info = musicInfo()
    const time = pair(one('.player_music__time')?.textContent)
    const cover = background(one('.bg_player')) ?? imageOf(one('.player_music__info, .player_music'))
    const mid = idOf(info.href, 'track')
    const rows = tracks()
    const current =
      rows.find((row) => norm(info.text).startsWith(norm(row.name))) ??
      rows.find((row) => norm(row.name) === norm(info.title) && norm(row.artist) === norm(info.artist)) ??
      rows.find((row) => norm(row.name) === norm(info.title)) ??
      null
    const track =
      current ??
      (info.title
        ? {
            id: mid ? `qq:track:${mid}` : `qq:current:${info.title}`,
            name: info.title,
            artist: info.artist,
            album: '',
            image: cover ?? DEFAULT_IMAGE,
            color: COLOR,
            duration: audio?.duration || time.duration,
            explicit: false,
          }
        : null)
    if (!track) return null
    const index = current ? rows.indexOf(current) : 0
    const mode = norm(one('.btn_big_only, [class*="loop"], [class*="mode"]')?.textContent)
    return {
      track: { ...track, image: cover ?? track.image, duration: audio?.duration || time.duration || track.duration },
      context: { id: 'qq:player', name: 'QQ Music', kind: 'playlist' },
      playing: audio ? !audio.paused && !audio.ended : playing(),
      loading: false,
      position: audio?.currentTime || time.position,
      duration: audio?.duration || time.duration || track.duration,
      preview: false,
      shuffle: /随机|shuffle/i.test(mode),
      repeat: /单曲|one/i.test(mode) ? 'one' : /循环|list/i.test(mode) ? 'all' : 'off',
      volume: audio ? audio.volume : null,
      next: rows.slice(index + 1, index + 9),
    }
  }
  let lastPlayback = ''
  const sayPlayback = () => {
    const playback = currentPlayback()
    const text = JSON.stringify(playback)
    if (text !== lastPlayback) {
      lastPlayback = text
      post({ playback })
    }
  }
  const click = (selector) => {
    const button = one(selector)
    if (button) {
      button.click()
      return true
    }
    return false
  }
  const clickAt = (x, y) => post({ click: { x, y } })
  const fire = (element, type, x, y, buttons = 0) =>
    element?.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons }))
  const seek = (seconds) => {
    const audio = findAudio()
    if (audio) {
      audio.currentTime = Math.max(0, seconds)
      return
    }
    const bar = one('.player_progress__inner')
    const duration = currentPlayback()?.duration || 0
    if (!bar || !duration) {
      post({ log: `seek no bar=${Boolean(bar)} duration=${Math.round(duration)}` })
      return
    }
    const box = bar.getBoundingClientRect()
    const x = box.left + Math.max(0, Math.min(1, seconds / duration)) * box.width
    const y = box.top + box.height / 2
    post({ log: `seek ${Math.round(seconds)}s at ${Math.round(x)},${Math.round(y)}` })
    clickAt(x, y)
    // Fallback for a hidden composition view that does not take native input: the page's own
    // onClick is on the outer progress bar, not on its inner line.
    fire(bar.closest('.player_progress') ?? bar, 'click', x, y)
  }
  const setVolume = (share) => {
    const audio = findAudio()
    if (audio) {
      audio.volume = Math.max(0, Math.min(1, share))
      return
    }
    const bar = one('.player_voice .player_progress__inner')
    if (!bar) {
      post({ log: 'volume no bar' })
      return
    }
    const box = bar.getBoundingClientRect()
    const fill = one('.player_progress__play', bar)
    const current = fill && box.width ? Math.max(0, Math.min(1, fill.getBoundingClientRect().width / box.width)) : 0
    const y = box.top + box.height / 2
    const fromX = box.left + current * box.width
    const toX = box.left + Math.max(0, Math.min(1, share)) * box.width
    const dot = one('.player_progress__dot', bar)
    post({ log: `volume ${Math.round(share * 100)}% at ${Math.round(toX)},${Math.round(y)}` })
    post({
      drag: {
        fromX,
        fromY: y,
        toX,
        toY: y,
      },
    })
    // The same drag as the page itself: the dot's onMouseDown starts it, then the document's move/up
    // finish it. The outer bar's onClick is a second fallback.
    fire(dot ?? bar, 'mousedown', fromX, y, 1)
    fire(document, 'mousemove', toX, y, 1)
    fire(document, 'mouseup', toX, y)
    fire(bar.closest('.player_progress') ?? bar, 'click', toX, y)
  }
  const CONTROLS = {
    play() {
      const audio = findAudio()
      if (audio && audio.paused) return void audio.play().catch(() => {})
      if (!playing()) click('.btn_big_play')
    },
    pause() {
      const audio = findAudio()
      if (audio && !audio.paused) return void audio.pause()
      if (playing()) click('.btn_big_play')
    },
    next() {
      click('.btn_big_next')
    },
    previous() {
      click('.btn_big_prev')
    },
    seek(command) {
      seek(Number(command.seconds) || 0)
    },
    volume(command) {
      setVolume((Number(command.percent) || 0) / 100)
    },
    shuffle() {
      click('[class*="shuffle"], [title*="随机"], [class*="random"]')
    },
    repeat() {
      click('.btn_big_only, [class*="repeat"], [class*="loop"], [title*="循环"]')
    },
    jump(command) {
      const rows = all('.songlist__item, [class*="songlist__item"]')
      const row = rows[Number(command.offset) || 0]
      const button = row ? one('[class*="list_menu__play"], [title="播放"], .songlist__icon', row) : null
      button?.click()
    },
    favorite() {
      click('.btn_big_like, [class*="like"]')
    },
    add() {},
  }

  // --- The truck's speakers ---------------------------------------------------------------------------------
  const cab = { speakers: null, head: null, outside: null, equalizer: null, spectrum: false }
  let sound = null
  const attach = () => {
    const audio = findAudio()
    if (!audio || sound || typeof window.westplayCabSound !== 'function') return
    sound = window.westplayCabSound(audio, (message) => post(message))
    if (cab.speakers !== null) sound.speakers(cab.speakers)
    if (cab.head !== null) sound.head(cab.head)
    if (cab.outside !== null) sound.outside(cab.outside.on, cab.outside.distance)
    if (cab.equalizer !== null) sound.equalizer(cab.equalizer)
    sound.spectrum(cab.spectrum)
  }
  const CAB = {
    speakers(data) {
      cab.speakers = data.speakers
      sound?.speakers(data.speakers)
    },
    head(data) {
      cab.head = data
      sound?.head(data)
    },
    outside(data) {
      cab.outside = data
      sound?.outside(data.on, data.distance)
    },
    equalizer(data) {
      cab.equalizer = data
      sound?.equalizer(data)
    },
    spectrum(data) {
      cab.spectrum = Boolean(data.on)
      sound?.spectrum(cab.spectrum)
    },
  }

  // --- Messages ---------------------------------------------------------------------------------------------
  window.chrome?.webview?.addEventListener('message', ({ data }) => {
    if (!data) return
    if (CAB[data.action]) return CAB[data.action](data)
    if (data.action === 'start') return sayState()
    if (role === 'browse') {
      if (data.action === 'ask') return void ask(data.id, data.question)
      if (data.action === 'prepare') return void queue(data)
    } else {
      CONTROLS[data.action]?.(data)
    }
  })

  // A page loaded anew: the host re-asks what it missed, and prepares what was waiting.
  setTimeout(() => {
    post({ ready: true })
    sayState()
    if (role === 'browse') void resume()
    if (role === 'player') {
      sayPlayback()
      attach()
    }
  }, 600)

  setInterval(sayState, 1500)
  if (role === 'player') {
    setInterval(sayPlayback, 500)
    setInterval(attach, 1000)
  }
})()
