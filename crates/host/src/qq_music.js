// QQ Music, in its own web pages (qq_music.rs). The copied Apple Music app is WestPlay's face; this
// script is the adapter that makes QQ Music's own pages answer the same questions and play its sound.
//
// Two pages are run: a browser page (search, home, playlist and artist pages) and a player page (the
// standalone QQ Music player). QQ Music only plays for a signed-in account; without one the pages still
// browse, and the app says what it can't play.
(() => {
  if (!/(^|\.)y\.qq\.com$/.test(location.hostname)) return;
  const role = window.__westplayRole === "player" ? "player" : "browse";
  const post = (message) =>
    window.chrome?.webview?.postMessage({ role, ...message });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const one = (selector, root = document) =>
    root?.querySelector(selector) ?? null;
  const all = (selector, root = document) => [
    ...root.querySelectorAll(selector),
  ];
  const ORIGIN = "https://y.qq.com";
  const HOME = `${ORIGIN}/`;
  const PLAYER = `${ORIGIN}/n/ryqq_v2/player`;
  const COLOR = "#31c27c";
  const DEFAULT_IMAGE = `${ORIGIN}/mediastyle/global/img/album_300.png`;

  // QQ Music's own API lives in its Webpack modules. Capture the real Webpack loader before the site's
  // scripts run, so the adapter can ask the same signed-in APIs for every page of a list. This does not
  // read cookies or tokens: the site's request code does that in its own page.
  let webpackQueue;
  Object.defineProperty(window, "webpackJsonp", {
    configurable: true,
    get: () => webpackQueue,
    set(value) {
      webpackQueue = value;
      let push = value.push;
      Object.defineProperty(value, "push", {
        configurable: true,
        get: () => push,
        set(callback) {
          push = function (chunk) {
            const modules = chunk?.[1];
            if (modules) {
              window.__westplayFactories ??= new Map();
              for (const [id, factory] of Object.entries(modules)) {
                if (typeof factory !== "function" || factory.__westplayWrapped)
                  continue;
                window.__westplayFactories.set(String(id), factory);
                const wrapped = function (module, exports, require) {
                  window.__westplayRequire = require;
                  return factory.call(this, module, exports, require);
                };
                wrapped.__westplayWrapped = true;
                modules[id] = wrapped;
              }
            }
            return callback.call(this, chunk);
          };
        },
      });
    },
  });

  // QMA (QQ's audio engine) renders into Web Audio and joins its master gain to the destination. Remember
  // that node before the page's player starts, so cab_sound.js can put the truck's speakers after it.
  const qmaOutput = { node: null, context: null };
  window.__westplayQmaOutput = qmaOutput;
  try {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...rest) {
      if (
        destination === this.context?.destination &&
        this instanceof GainNode &&
        (!qmaOutput.node || qmaOutput.context !== this.context)
      ) {
        qmaOutput.node = this;
        qmaOutput.context = this.context;
        post({ log: "QMA audio output found" });
      }
      return connect.call(this, destination, ...rest);
    };
  } catch {}

  const waitFor = async (read, timeout = 12000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = read();
      if (value) return value;
      await sleep(100);
    }
    return null;
  };
  const qqApi = async (module) => {
    const require = await waitFor(() => window.__westplayRequire);
    if (!require) throw new Error("QQ Music API is not ready");
    return require(module);
  };
  const within = (promise, milliseconds, message) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(message)), milliseconds),
      ),
    ]);
  const reportApi = async () => qqApi(467);
  const tracksApi = async () => qqApi(449);
  const requestApi = async () => {
    const api = (await qqApi(8)).j();
    return (...args) => api.request(...args);
  };

  // --- Login -----------------------------------------------------------------------------------------------
  const cookie = (name) => {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(
      document.cookie || "",
    );
    return match ? decodeURIComponent(match[1]) : "";
  };
  const signedIn = () => {
    // The web player keeps its login in these cookies. `uin=0` is a guest, not an account.
    if (
      cookie("qm_keyst") ||
      cookie("qqmusic_key") ||
      cookie("psrf_musickey_createtime") ||
      cookie("psrf_qqunionid") ||
      cookie("psrf_qqopenid") ||
      cookie("skey") ||
      cookie("p_skey")
    )
      return true;
    const uin = cookie("uin") || cookie("wxuin");
    if (uin && !/^(0|o0|o)$/i.test(uin)) return true;
    // Signed in, the header's log-in link becomes the account's name or picture.
    const link = one(".top_login__link, .player_login__link");
    if (!link) return false;
    if (one('img, [class*="avatar"]', link)) return true;
    const words = norm(link.textContent);
    return Boolean(words && !/登录|登入|sign in/i.test(words));
  };

  const playing = () => {
    const audio = findAudio();
    if (audio) return !audio.paused && !audio.ended;
    const button = one(".btn_big_play");
    if (!button) return false;
    const words = norm(button.textContent);
    return /暂停|pause/i.test(words) || /pause/i.test(button.className);
  };

  const avatar = () => {
    const image = one(
      '.top_login__link img, .player_login__link img, [class*="avatar"] img',
    );
    const src = image?.currentSrc || image?.src || "";
    return src.startsWith("https://") && !src.startsWith("data:") ? src : null;
  };

  let lastState = "";
  const sayState = () => {
    const state = {
      signedIn: signedIn(),
      playing: playing(),
      avatar: avatar(),
    };
    const text = JSON.stringify(state);
    if (text !== lastState) {
      lastState = text;
      post({ state });
    }
  };

  // --- Pages -----------------------------------------------------------------------------------------------
  const parseTime = (value) => {
    const parts = norm(value)
      .split(":")
      .map((part) => Number(part));
    if (parts.length === 0 || parts.some((part) => !Number.isFinite(part)))
      return 0;
    return parts.reduce((seconds, part) => seconds * 60 + part, 0);
  };
  const pair = (value) => {
    const [position, duration] = norm(value).split("/").map(parseTime);
    return { position: position || 0, duration: duration || 0 };
  };
  const background = (element) => {
    if (!element) return null;
    const image = /url\(["']?(.*?)["']?\)/.exec(
      getComputedStyle(element).backgroundImage || "",
    );
    return image?.[1] ? new URL(image[1], location.href).href : null;
  };
  const imageOf = (root) => {
    const image = one("img", root);
    if (!image) return null;
    const candidates = [
      image.currentSrc,
      image.src,
      image.getAttribute("data-src"),
      image.getAttribute("data-qar-def"),
    ];
    for (const candidate of candidates) {
      if (!candidate || candidate.startsWith("data:")) continue;
      try {
        return new URL(candidate, location.href).href;
      } catch {}
    }
    return null;
  };
  const idOf = (href, kind) => {
    const pattern =
      kind === "track"
        ? /songDetail\/([^/?#]+)/
        : kind === "album"
          ? /albumDetail\/([^/?#]+)/
          : kind === "artist"
            ? /singer\/([^/?#]+)/
            : /playlist\/([^/?#]+)/;
    return pattern.exec(String(href ?? ""))?.[1] ?? null;
  };
  const itemOf = (anchor, kind) => {
    const id = idOf(anchor?.getAttribute("href"), kind);
    if (!id) return null;
    const card =
      anchor.closest('li, .mod_cover, [class*="card"], [class*="item"]') ??
      anchor.parentElement;
    const name = norm(anchor.getAttribute("title") || anchor.textContent);
    if (!name) return null;
    const by = all('a[href*="/singer/"]', card)
      .map((artist) => norm(artist.textContent))
      .filter(Boolean)
      .join(" / ");
    return {
      id: `qq:${kind}:${id}`,
      kind,
      name,
      by,
      note: "",
      image: imageOf(card) ?? DEFAULT_IMAGE,
      wide: null,
      color: COLOR,
      explicit: false,
      live: false,
    };
  };
  const trackOf = (row) => {
    const anchor = one('a[href*="/songDetail/"]', row);
    const id = idOf(anchor?.getAttribute("href"), "track");
    if (!id) return null;
    const artistAnchors = all('a[href*="/singer/"]', row);
    const artistAnchor = artistAnchors[0];
    const albumAnchor = one('a[href*="/albumDetail/"]', row);
    const time = one('[class*="time"], .songlist__time', row)?.textContent;
    return {
      id: `qq:track:${id}`,
      name: norm(anchor.getAttribute("title") || anchor.textContent),
      artist: artistAnchors
        .map((artist) => norm(artist.textContent))
        .filter(Boolean)
        .join(" / "),
      album: norm(albumAnchor?.textContent),
      albumId: albumAnchor
        ? `qq:album:${idOf(albumAnchor.getAttribute("href"), "album")}`
        : null,
      artistId: artistAnchor
        ? `qq:artist:${idOf(artistAnchor.getAttribute("href"), "artist")}`
        : null,
      image: imageOf(row) ?? DEFAULT_IMAGE,
      color: COLOR,
      duration: parseTime(time),
      explicit: false,
      number:
        Number(
          norm(one('[class*="number"], .songlist__number', row)?.textContent),
        ) || null,
    };
  };
  const tracks = (root = document) => {
    const seen = new Set();
    const found = [];
    for (const row of all(
      '.songlist__item, [class*="songlist__item"], .debutlist__item',
      root,
    )) {
      const track = trackOf(row);
      if (!track || seen.has(track.id)) continue;
      seen.add(track.id);
      found.push(track);
    }
    return found;
  };
  const items = (kind, root = document) => {
    const seen = new Set();
    const found = [];
    for (const anchor of all(
      `a[href*="${kind === "album" ? "/albumDetail/" : kind === "artist" ? "/singer/" : "/playlist/"}"]`,
      root,
    )) {
      const item = itemOf(anchor, kind);
      if (!item || seen.has(item.id)) continue;
      seen.add(item.id);
      found.push(item);
    }
    return found;
  };
  const enrichItems = async (list, most = 12) => {
    const missing = list
      .filter((item) => missingCover(item.image))
      .slice(0, most);
    await Promise.all(
      missing.map(async (item) => {
        try {
          const parts = String(item.id).split(":");
          const kind = parts[1];
          const id = parts.slice(2).join(":");
          if (!id || (kind !== "album" && kind !== "playlist")) return;
          const url =
            kind === "album"
              ? `${ORIGIN}/n/ryqq_v2/albumDetail/${id}`
              : `${ORIGIN}/n/ryqq_v2/playlist/${id}`;
          const doc = await fetchDoc(url);
          const node =
            nodeOf(doc, kind === "album" ? "MusicAlbum" : "MusicPlaylist") ??
            nodeOf(doc, "MusicPlaylist") ??
            nodeOf(doc, "MusicAlbum");
          if (node?.image) item.image = new URL(node.image, location.href).href;
        } catch {}
      }),
    );
    return list;
  };
  const page = (sections) => ({ sections });
  const section = (title, style, listed, songs) => ({
    title,
    style,
    items: listed,
    songs,
  });
  const emptyPage = () => page([]);

  const homePage = async () => {
    for (
      let i = 0;
      i < 40 &&
      !one(
        '.playlist__item, .debutlist__item, .songlist__item, .mod_index, [class*="index__"]',
      );
      i++
    ) {
      await sleep(250);
    }
    const playlists = items("playlist").slice(0, 12);
    const songs = await enrichTracks(tracks().slice(0, 20));
    const albums = await enrichItems(items("album").slice(0, 8));
    const sections = [];
    if (playlists.length)
      sections.push(section("热门歌单", "shelf", playlists, []));
    if (songs.length) sections.push(section("新歌首发", "songs", [], songs));
    if (albums.length) sections.push(section("新碟上架", "shelf", albums, []));
    return page(sections);
  };
  const newPage = async () => {
    const data = initialData(document);
    const groups = data?.radio_list ?? data?.data?.radio_list;
    if (Array.isArray(groups)) {
      const sections = groups
        .map((group) => {
          const stations = (group?.list ?? [])
            .map((station, index) => {
              const id = Number(station?.id);
              const name = norm(station?.title);
              if (!id || !name) return null;
              return {
                id: `qq:radio:${id}`,
                kind: "station",
                name,
                by: station?.listenNumStr
                  ? `${station.listenNumStr} 人在听`
                  : "",
                note: "",
                image: imageUrl(station?.pic_url),
                wide: null,
                color: ["#1c6b48", "#245b78", "#754e25", "#5d3974"][index % 4],
                explicit: false,
                live: false,
              };
            })
            .filter(Boolean);
          return stations.length
            ? section(norm(group?.title), "shelf", stations, [])
            : null;
        })
        .filter(Boolean);
      if (sections.length) return page(sections);
    }
    const sections = all(".radio__item")
      .map((group) => {
        const title = norm(
          one('h2, h3, .radio__title, [class*="title"]', group)?.textContent,
        );
        const stations = all(".radio_list__item", group)
          .map((item, index) => {
            const name = norm(item.textContent);
            if (!name) return null;
            return {
              id: `qq:radio:name:${encodeURIComponent(name)}`,
              kind: "station",
              name,
              by: "",
              note: "",
              image: imageOf(item),
              wide: null,
              color: ["#1c6b48", "#245b78", "#754e25", "#5d3974"][index % 4],
              explicit: false,
              live: false,
            };
          })
          .filter(Boolean);
        return title && stations.length
          ? section(title, "shelf", stations, [])
          : null;
      })
      .filter(Boolean);
    if (sections.length) return page(sections);
    const playlists = items("playlist").slice(0, 30);
    return page(
      playlists.length ? [section("雷达", "shelf", playlists, [])] : [],
    );
  };
  const radioPage = async () => {
    const playlists = items("playlist").slice(0, 40);
    const sections = [];
    if (playlists.length)
      sections.push(section("分类歌单", "shelf", playlists, []));
    return page(sections);
  };

  const fetchDoc = async (url) => {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`http ${response.status}`);
    return new DOMParser().parseFromString(await response.text(), "text/html");
  };
  const jsonLd = (doc) => {
    const found = [];
    for (const script of all('script[type="application/ld+json"]', doc)) {
      try {
        const value = JSON.parse(script.textContent);
        found.push(
          ...(Array.isArray(value)
            ? value
            : value["@graph"]
              ? value["@graph"]
              : [value]),
        );
      } catch {}
    }
    return found;
  };
  const nodeOf = (doc, type) =>
    jsonLd(doc).find((node) => node?.["@type"] === type);
  const initialData = (doc) => {
    for (const script of all("script", doc)) {
      const code = script.textContent ?? "";
      const at = code.indexOf("window.__INITIAL_DATA__");
      if (at < 0) continue;
      const start = code.indexOf("{", at);
      const end = code.lastIndexOf("}");
      if (start < 0 || end <= start) continue;
      try {
        // QQ Music's SSR data has a few literal `undefined`s, which JSON doesn't.
        return JSON.parse(
          code.slice(start, end + 1).replace(/\bundefined\b/g, "null"),
        );
      } catch {}
    }
    return null;
  };
  const coverOfSong = (song) => {
    const raw =
      song?.coverUrl ||
      (song?.album?.pmid
        ? `//y.qq.com/music/photo_new/T002R300x300M000${song.album.pmid}.jpg?max_age=2592000`
        : "");
    if (!raw) return DEFAULT_IMAGE;
    const url = raw.startsWith("//") ? `https:${raw}` : raw;
    return new URL(url, location.href).href;
  };
  const tracksFromInitial = (data) => {
    const songs =
      data?.songList ??
      data?.songlist ??
      data?.songs ??
      data?.data?.songList ??
      data?.data?.songlist;
    if (!Array.isArray(songs)) return [];
    return songs
      .map((song, index) => {
        if (!song?.mid) return null;
        const singers = Array.isArray(song.singer)
          ? song.singer
          : song.singer
            ? [song.singer]
            : [];
        return {
          id: `qq:track:${song.mid}`,
          name: norm(song.name ?? song.title),
          artist: singers
            .map((singer) => singer?.name)
            .filter(Boolean)
            .join(" / "),
          album: norm(song.album?.name ?? song.album?.title),
          albumId: song.album?.mid ? `qq:album:${song.album.mid}` : null,
          artistId: singers[0]?.mid ? `qq:artist:${singers[0].mid}` : null,
          image: coverOfSong(song),
          color: COLOR,
          duration: Number(song.interval) || parseTime(song.playTime),
          explicit: Boolean(song.ov),
          number: index + 1,
          favorite: typeof song.isFan === "boolean" ? song.isFan : undefined,
        };
      })
      .filter(Boolean);
  };
  const isoDuration = (value) => {
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(
      String(value ?? ""),
    );
    return match
      ? Number(match[1] || 0) * 3600 +
          Number(match[2] || 0) * 60 +
          Number(match[3] || 0)
      : 0;
  };
  const artistName = (value) =>
    Array.isArray(value)
      ? value
          .map((artist) => artist?.name)
          .filter(Boolean)
          .join(" / ")
      : (value?.name ?? "");
  const trackFromLd = (song, fallbackImage, albumName = "") => {
    const id = idOf(song?.url, "track");
    if (!id) return null;
    const album = song.inAlbum ?? {};
    const artists = Array.isArray(song.byArtist)
      ? song.byArtist
      : song.byArtist
        ? [song.byArtist]
        : [];
    return {
      id: `qq:track:${id}`,
      name: norm(song.name),
      artist: artistName(song.byArtist),
      album: norm(album.name ?? albumName),
      albumId: idOf(album.url, "album")
        ? `qq:album:${idOf(album.url, "album")}`
        : null,
      artistId: idOf(artists[0]?.url, "artist")
        ? `qq:artist:${idOf(artists[0]?.url, "artist")}`
        : null,
      image: song.image
        ? new URL(song.image, location.href).href
        : fallbackImage,
      color: COLOR,
      duration: isoDuration(song.duration),
      explicit: false,
      number: Number(song.position) || null,
    };
  };
  const missingCover = (image) =>
    !image ||
    image === DEFAULT_IMAGE ||
    image.includes("mediastyle/global/img/album_300");

  /**
   * QQ's home and search rows are lazily drawn: their <img> often holds only a transparent GIF and the
   * generic album placeholder. The site's own batch track API returns the real cover and metadata in one
   * request. A per-song detail page is only the fallback when that API is temporarily unavailable.
   */
  const enrichTracks = async (list, most = 16) => {
    const missing = list
      .filter((track) => missingCover(track.image))
      .slice(0, most);
    if (missing.length)
      post({ log: `covers missing ${missing.length}/${list.length}` });
    const byId = new Map(
      missing.map((track) => [String(track.id).split(":").pop(), track]),
    );
    try {
      const api = await tracksApi();
      const mids = [...byId.keys()];
      for (let start = 0; start < mids.length; start += 100) {
        const part = mids.slice(start, start + 100);
        const raw = await api.m(
          part,
          part.map(() => 0),
        );
        for (const song of raw ?? []) {
          const track = byId.get(song?.mid);
          if (!track) continue;
          track.image = coverOfSong(song);
          track.album =
            norm(song.album?.name ?? song.album?.title) || track.album;
          track.albumId = song.album?.mid
            ? `qq:album:${song.album.mid}`
            : track.albumId;
          track.artist = artistName(song.singer) || track.artist;
          track.artistId = song.singer?.[0]?.mid
            ? `qq:artist:${song.singer[0].mid}`
            : track.artistId;
          track.duration = Number(song.interval) || track.duration;
          if (typeof song.isFan === "boolean") track.favorite = song.isFan;
        }
      }
    } catch {}
    const stillMissing = missing.filter((track) => missingCover(track.image));
    await Promise.all(
      stillMissing.slice(0, 4).map(async (track) => {
        const mid = String(track.id).split(":").pop();
        if (!mid) return;
        try {
          const doc = await fetchDoc(`${ORIGIN}/n/ryqq_v2/songDetail/${mid}`);
          const node = nodeOf(doc, "MusicRecording");
          if (!node) return;
          if (node.image) track.image = new URL(node.image, location.href).href;
          if (node.inAlbum?.name) track.album = norm(node.inAlbum.name);
          if (node.inAlbum?.url) {
            const album = idOf(node.inAlbum.url, "album");
            if (album) track.albumId = `qq:album:${album}`;
          }
          if (!track.artist) track.artist = artistName(node.byArtist);
          const artist = Array.isArray(node.byArtist)
            ? node.byArtist[0]
            : node.byArtist;
          if (!track.artistId && artist?.url) {
            const id = idOf(artist.url, "artist");
            if (id) track.artistId = `qq:artist:${id}`;
          }
          if (!track.duration) track.duration = isoDuration(node.duration);
        } catch {}
      }),
    );
    if (missing.length)
      post({ log: `covers done ${missing.length}/${list.length}` });
    return list;
  };
  const collectionAnswer = async (id) => {
    const parts = String(id).split(":");
    const collectionKind = parts[1] === "album" ? "album" : "playlist";
    const collectionId = parts.slice(2).join(":");
    if (!collectionId) return null;
    if (collectionKind === "playlist") {
      try {
        const request = await requestApi();
        const songs = [];
        let total = Infinity;
        let info = null;
        for (
          let start = 0, page = 0;
          start < total && page < 12;
          start += 100, page++
        ) {
          const response = await within(
            request([
              {
                module: "music.srfDissInfo.aiDissInfo",
                method: "uniform_get_Dissinfo",
                param: {
                  song_begin: start,
                  song_num: 100,
                  disstid: Number(collectionId),
                },
              },
            ]),
            15000,
            "QQ Music playlist timed out",
          );
          const answer = response?.[0];
          if (answer?.code !== 0) break;
          info = info ?? answer.data?.dirinfo ?? null;
          const rows = answer.data?.songlist ?? [];
          songs.push(...rows);
          total = Number(answer.total_song_num) || songs.length;
          if (!rows.length || rows.length < 100) break;
        }
        if (songs.length) {
          const image = imageUrl(info?.logo ?? info?.picurl);
          const item = {
            id: `qq:playlist:${collectionId}`,
            kind: "playlist",
            name: norm(info?.dissname ?? info?.title) || "QQ Music",
            by: norm(info?.creator?.nick ?? info?.nickname),
            note: norm(info?.desc),
            image: image ?? DEFAULT_IMAGE,
            wide: null,
            color: COLOR,
            explicit: false,
            live: false,
          };
          return {
            item,
            description: norm(info?.desc),
            genre: "",
            year: null,
            tracks: await enrichTracks(
              tracksFromInitial({ songlist: songs }),
              12,
            ),
          };
        }
      } catch {}
    }
    const url =
      parts[1] === "album"
        ? `${ORIGIN}/n/ryqq_v2/albumDetail/${collectionId}`
        : parts[1] === "toplist"
          ? `${ORIGIN}/n/ryqq_v2/toplist/${collectionId}`
          : `${ORIGIN}/n/ryqq_v2/playlist/${collectionId}`;
    const doc = await fetchDoc(url);
    const data = initialData(doc);
    const node =
      nodeOf(
        doc,
        collectionKind === "album" ? "MusicAlbum" : "MusicPlaylist",
      ) ??
      nodeOf(doc, "MusicPlaylist") ??
      nodeOf(doc, "MusicAlbum");
    const listed = node?.track ?? node?.tracks ?? [];
    const fallback = node?.image ?? DEFAULT_IMAGE;
    const found = listed
      .map((song) => trackFromLd(song, fallback, node?.name))
      .filter(Boolean);
    const structured = tracksFromInitial(data);
    let rows = structured.length
      ? structured
      : found.length
        ? found
        : tracks(doc);
    if (!structured.length && found.length) {
      // The structured list carries names and covers, the page's rows carry lengths and albums.
      const detail = new Map(tracks(doc).map((track) => [track.id, track]));
      rows = found.map((track) => {
        const row = detail.get(track.id);
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
          : track;
      });
    }
    if (!node && rows.length === 0) {
      // A playlist the server didn't put in JSON-LD: its own page, with the site's scripts.
      const path = new URL(url).pathname;
      if (!location.pathname.includes(path)) {
        location.href = url;
        return null;
      }
      for (let i = 0; i < 24 && rows.length === 0; i++) {
        await sleep(250);
        rows = tracks(document);
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
            norm(
              one("h1, .playlist__title, .album__title", document)?.textContent,
            ) ||
            "QQ Music",
          by: norm(data?.detail?.host_nick ?? data?.detail?.creator?.nick),
          note: norm(data?.detail?.desc),
          image: data?.detail?.picurl
            ? new URL(data.detail.picurl, location.href).href
            : (imageOf(
                one("h1, .playlist__title, .album__title", document)
                  ?.parentElement,
              ) ?? DEFAULT_IMAGE),
          wide: null,
          color: COLOR,
          explicit: false,
          live: false,
        };
    return {
      item,
      description: norm(node?.description),
      genre: norm(node?.genre),
      year:
        Number(
          String(node?.dateCreated ?? node?.datePublished ?? "").slice(0, 4),
        ) || null,
      tracks: await enrichTracks(rows, 8),
    };
  };
  const artistAnswer = async (id) => {
    const artistId = String(id).split(":").slice(2).join(":");
    if (!artistId) return null;
    const doc = await fetchDoc(`${ORIGIN}/n/ryqq_v2/singer/${artistId}`);
    const node = nodeOf(doc, "MusicGroup");
    const item = {
      id: `qq:artist:${artistId}`,
      kind: "artist",
      name: norm(
        node?.name ?? one("h1, .singer__title", doc)?.textContent ?? "QQ Music",
      ),
      by: "",
      note: norm(node?.description),
      image: node?.image
        ? new URL(node.image, location.href).href
        : DEFAULT_IMAGE,
      wide: null,
      color: COLOR,
      explicit: false,
      live: false,
    };
    return {
      item,
      top: await enrichTracks(tracks(doc).slice(0, 20)),
      sections: [],
    };
  };
  const curatorAnswer = async (id) => {
    const label = decodeURIComponent(String(id).replace(/^qq:radio:/, ""));
    if (!label) return page([]);
    const here = new URLSearchParams(location.search);
    if (
      !location.pathname.includes("/search") ||
      here.get("w") !== label ||
      here.get("t") !== "playlist"
    ) {
      location.href = `${ORIGIN}/n/ryqq_v2/search?w=${encodeURIComponent(label)}&t=playlist`;
      return null;
    }
    for (let i = 0; i < 32 && items("playlist").length === 0; i++)
      await sleep(250);
    return page([
      section(`雷达 · ${label}`, "shelf", items("playlist").slice(0, 30), []),
    ]);
  };
  const imageUrl = (value) => {
    if (!value) return null;
    const raw = String(value);
    if (raw.startsWith("data:")) return null;
    try {
      return new URL(raw.startsWith("//") ? `https:${raw}` : raw, location.href)
        .href;
    } catch {
      return null;
    }
  };
  const playlistFromApi = (playlist) => {
    const id =
      playlist?.dissid ?? playlist?.dirid ?? playlist?.tid ?? playlist?.id;
    const name = norm(
      playlist?.dissname ??
        playlist?.dirname ??
        playlist?.title ??
        playlist?.name,
    );
    if (id == null || !name) return null;
    return {
      id: `qq:playlist:${id}`,
      kind: "playlist",
      name,
      by: norm(
        playlist?.nickname ?? playlist?.creator?.name ?? playlist?.creator,
      ),
      note: norm(playlist?.desc ?? playlist?.diss_desc),
      image: imageUrl(
        playlist?.diss_cover ??
          playlist?.imgurl ??
          playlist?.dir_picurl ??
          playlist?.coverUrl,
      ),
      wide: null,
      color: COLOR,
      explicit: false,
      live: false,
    };
  };
  let cachedProfile = null;
  const profileData = async () => {
    if (!signedIn()) return null;
    if (cachedProfile) return cachedProfile;
    cachedProfile = await within(
      (await reportApi()).f({ uin: "" }),
      15000,
      "QQ Music profile timed out",
    );
    return cachedProfile;
  };
  /**
   * The Library through QQ Music's own signed-in API rather than its visible page. The page deliberately
   * renders only ten songs and replaces its pager with a "download the client" advert. The API returns the
   * real total and pages, so all 641 liked songs are available without bouncing the browser between routes.
   */
  const libraryAnswer = async (shelf) => {
    if (!signedIn()) return { items: [], songs: [], sorts: [], sort: null };
    const profile = await profileData();
    if (!profile?.pageuin) throw new Error("QQ Music account is not ready");
    const api = await reportApi();
    const size = 100;
    const pages = async (load, key, totalKey) => {
      const rows = [];
      let total = Infinity;
      for (
        let start = 0, page = 0;
        start < total && page < 12;
        start += size, page++
      ) {
        const part = await within(
          load(start, size),
          15000,
          "QQ Music list timed out",
        );
        const pageRows = part?.[key];
        const reached = Array.isArray(pageRows) ? pageRows.length : 0;
        if (Array.isArray(pageRows)) rows.push(...pageRows);
        total = Number(part?.[totalKey]);
        if (!Number.isFinite(total) || total <= 0)
          total = reached < size ? start + reached : start + size + 1;
        if (reached === 0 || reached < size) break;
      }
      return { rows, total };
    };
    if (shelf === "songs") {
      const { rows, total } = await pages(
        (start, pageSize) =>
          api.h(["like", "song"], profile, { start, pageSize }),
        "songlist",
        "totalNum",
      );
      post({
        log: `library liked songs ${rows.length}/${Number.isFinite(total) ? total : "?"}`,
      });
      return {
        items: [],
        songs: tracksFromInitial({ songlist: rows }),
        sorts: [],
        sort: null,
      };
    }
    if (shelf === "playlists" || shelf === "recent") {
      const { rows } = await pages(
        (start, pageSize) =>
          api.h(["create", ""], profile, { start, pageSize }),
        "myCreatedPlaylist",
        "totalNum",
      );
      return {
        items: rows
          .map(playlistFromApi)
          .filter(
            (item) =>
              item && !/^(我喜欢的音乐|我喜欢)$/.test(String(item.name)),
          ),
        songs: [],
        sorts: [],
        sort: null,
      };
    }
    if (shelf === "artists") {
      const { rows } = await pages(
        (start, pageSize) =>
          api.h(["buy", "song"], profile, { start, pageSize }),
        "boughtsong",
        "boughtTotal",
      );
      return {
        items: [],
        songs: tracksFromInitial({ songlist: rows }),
        sorts: [],
        sort: null,
      };
    }
    if (shelf === "albums") {
      const { rows } = await pages(
        (start, pageSize) =>
          api.h(["like", "album"], profile, { start, pageSize }),
        "albumlist",
        "totalNum",
      );
      return {
        items: rows
          .map((album) => ({
            id: `qq:album:${album?.albummid ?? album?.albumMID ?? album?.mid}`,
            kind: "album",
            name: norm(album?.albumname ?? album?.albumName ?? album?.name),
            by: norm(album?.singer ?? album?.artist),
            note: "",
            image: imageUrl(album?.albumPic ?? album?.picurl),
            wide: null,
            color: COLOR,
            explicit: false,
            live: false,
          }))
          .filter((item) => item.name),
        songs: [],
        sorts: [],
        sort: null,
      };
    }
    return { items: [], songs: [], sorts: [], sort: null };
  };
  const lyricsAnswer = async (id) => {
    let mid = String(id).split(":").pop();
    if (String(id).startsWith("qq:radio-current:")) {
      const raw = String(id).slice("qq:radio-current:".length);
      const [title, artist] = raw
        .split("|")
        .map((part) => decodeURIComponent(part || ""));
      if (title) {
        try {
          const request = await requestApi();
          const response = await within(
            request([
              {
                module: "music.search.SearchCgiService",
                method: "DoSearchForQQMusicDesktop",
                param: {
                  remoteplace: "txt.yqq.song",
                  searchid: String(Date.now()),
                  search_type: 0,
                  query: [title, artist].filter(Boolean).join(" "),
                  page_num: 1,
                  num_per_page: 10,
                },
              },
            ]),
            10000,
            "QQ Music radio lyrics search timed out",
          );
          const songs = response?.[0]?.data?.body?.song?.list ?? [];
          const wanted = norm(title);
          mid =
            songs.find((song) => {
              const found = norm(song?.title ?? song?.name);
              return (
                found === wanted ||
                (found && (found.includes(wanted) || wanted.includes(found)))
              );
            })?.mid ??
            songs[0]?.mid ??
            "";
        } catch {}
      }
    }
    if (!mid) return { synced: false, lines: [] };
    const url =
      `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(mid)}` +
      "&format=json&nobase64=1&g_tk=5381";
    const response = await fetch(url, {
      credentials: "include",
      referer: `${ORIGIN}/`,
    });
    if (!response.ok) throw new Error(`lyrics http ${response.status}`);
    const data = await response.json();
    let text = String(data?.lyric ?? "");
    if (!text && data?.lyric && !data?.retcode) {
      try {
        text = atob(data.lyric);
      } catch {}
    }
    const timed = [];
    for (const raw of text.split(/\r?\n/)) {
      const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d+)?)\]/g)];
      if (!stamps.length) continue;
      const line = norm(raw.replace(/\[[^\]]+\]/g, ""));
      if (!line) continue;
      for (const stamp of stamps)
        timed.push({
          start: Number(stamp[1]) * 60 + Number(stamp[2]),
          text: line,
        });
    }
    timed.sort((a, b) => a.start - b.start);
    const lines = timed.map((line, index) => ({
      start: line.start,
      end: timed[index + 1]?.start ?? 0,
      text: line.text,
    }));
    return {
      synced: lines.length > 0,
      lines: lines.length
        ? lines
        : text
            .split(/\r?\n/)
            .map((line) => norm(line))
            .filter(Boolean)
            .map((line) => ({ start: 0, end: 0, text: line }))
            .slice(0, 300),
      provider: "QQ音乐",
      writers: [],
      rtl: false,
    };
  };
  const searchAnswer = async (query) => {
    const url = `${ORIGIN}/n/ryqq_v2/search?w=${encodeURIComponent(query)}&t=song`;
    if (
      !location.pathname.includes("/search") ||
      new URLSearchParams(location.search).get("w") !== query
    ) {
      location.href = url;
      return null;
    }
    for (let i = 0; i < 24 && tracks().length === 0; i++) await sleep(250);
    const songs = await enrichTracks(tracks().slice(0, 40));
    return {
      top: [],
      songs,
      artists: [],
      albums: [],
      playlists: [],
      stations: [],
    };
  };
  const ask = async (id, question) => {
    try {
      let answer = null;
      switch (question?.ask) {
        case "home":
          if (location.pathname !== "/") {
            location.href = HOME;
            return;
          }
          answer = await homePage();
          break;
        case "new":
          if (!location.pathname.includes("/radio")) {
            location.href = `${ORIGIN}/n/ryqq_v2/radio`;
            return;
          }
          answer = await newPage();
          break;
        case "radio":
          if (!location.pathname.includes("/category")) {
            location.href = `${ORIGIN}/n/ryqq_v2/category`;
            return;
          }
          answer = await radioPage();
          break;
        case "browse":
          answer = [];
          break;
        case "search":
          answer = await searchAnswer(question.query);
          break;
        case "collection":
          answer = await collectionAnswer(question.id);
          break;
        case "artist":
          answer = await artistAnswer(question.id);
          break;
        case "curator":
          answer = await curatorAnswer(question.id);
          break;
        case "library":
          answer = await libraryAnswer(question.shelf);
          break;
        case "lyrics":
          answer = await lyricsAnswer(question.id);
          break;
      }
      if (answer !== null) post({ answer: id, [question.ask]: answer });
    } catch {
      post({ answer: id, failed: true });
    }
  };

  // --- Playing a song from a page ---------------------------------------------------------------------------
  const PENDING = "westplay.qq.pending";
  const remember = (command) =>
    sessionStorage.setItem(
      PENDING,
      JSON.stringify({ ...command, at: Date.now() }),
    );
  const forget = () => sessionStorage.removeItem(PENDING);
  const pending = () => {
    try {
      const value = JSON.parse(sessionStorage.getItem(PENDING) || "null");
      return value && Date.now() - value.at < 120000 ? value : null;
    } catch {
      return null;
    }
  };
  const clickPlay = () => {
    const button = one(
      '.mod_btn_green, .mod_cover__icon_play, [class*="list_menu__play"], [title="播放"]',
    );
    if (button) {
      button.click();
      return true;
    }
    return false;
  };
  const QUEUE_META = "westplay.qq.queue.v1";
  const rawForIds = async (ids) => {
    const wanted = ids.map((id) => String(id).split(":").pop()).filter(Boolean);
    const api = await tracksApi();
    const found = [];
    for (let start = 0; start < wanted.length; start += 100) {
      const mids = wanted.slice(start, start + 100);
      const part =
        (await api.m(
          mids,
          mids.map(() => 0),
        )) ?? [];
      found.push(...part);
    }
    const byMid = new Map(found.map((song) => [song.mid, song]));
    return wanted.map((mid) => byMid.get(mid)).filter(Boolean);
  };
  const saveQueue = (songs, index, context) => {
    const value = {
      songList: songs,
      isAdd: true,
      isPlay: true,
      index: Math.max(0, Math.min(songs.length - 1, Number(index) || 0)),
      time: Date.now(),
      uin: "",
      isvip: false,
    };
    localStorage.setItem(
      "playSongData",
      JSON.stringify({ value, expire: Date.now() + 31536000000 }),
    );
    localStorage.setItem(
      QUEUE_META,
      JSON.stringify({
        context: context ?? null,
        at: Date.now(),
        count: songs.length,
      }),
    );
  };
  const queue = async (command) => {
    const wanted = command?.id ?? command?.songs?.[command?.index ?? 0] ?? null;
    if (!wanted) return;
    const parts = String(wanted).split(":");
    if (parts[0] !== "qq") return;
    const context = command.name
      ? {
          id: command.id ?? `qq:queue:${Date.now()}`,
          name: command.name,
          kind: command.kind || "playlist",
        }
      : null;
    if (parts[1] === "radio") {
      let id = parts[2] === "name" ? null : Number(parts[2]);
      const label =
        parts[2] === "name"
          ? decodeURIComponent(parts.slice(3).join(":"))
          : command.name;
      if (!id && label) {
        const data = initialData(document);
        const groups = data?.radio_list ?? data?.data?.radio_list;
        id = groups
          ?.flatMap((group) => group.list ?? [])
          .find((station) => norm(station.title) === label)?.id;
      }
      if (!id) return;
      localStorage.setItem(
        QUEUE_META,
        JSON.stringify({
          context: {
            id: `qq:radio:${id}`,
            name: command.name || label || "QQ 音乐电台",
            kind: "station",
          },
          at: Date.now(),
          count: 1,
        }),
      );
      post({
        queued: true,
        player: `${ORIGIN}/n/ryqq_v2/player_radio#id=${id}`,
        track: tracks()[0] ?? null,
      });
      return;
    }
    if (parts[1] === "track" || Array.isArray(command.songs)) {
      const ids =
        Array.isArray(command.songs) && command.songs.length
          ? command.songs
          : [wanted];
      const songs = await rawForIds(ids);
      if (!songs.length) return;
      if (command.insert) {
        try {
          const existing = JSON.parse(
            localStorage.getItem("playSongData") || "null",
          )?.value;
          const old = Array.isArray(existing?.songList)
            ? existing.songList
            : [];
          const current = Math.max(
            0,
            Math.min(old.length - 1, Number(existing?.index) || 0),
          );
          if (old.length) {
            const after = old.slice(current + 1);
            const before = old.slice(0, current + 1);
            const chosen = songs[0];
            const kept = [...after, ...before].filter(
              (song) => song?.mid !== chosen?.mid,
            );
            saveQueue(
              [chosen, ...kept],
              0,
              JSON.parse(localStorage.getItem(QUEUE_META) || "null")?.context ??
                null,
            );
            post({ queued: true, track: tracks()[0] ?? null });
            return;
          }
        } catch {}
      }
      saveQueue(songs, command.index, context);
      post({ queued: true, track: tracks()[0] ?? null });
      return;
    }
    if (
      parts[1] === "playlist" ||
      parts[1] === "album" ||
      parts[1] === "toplist"
    ) {
      remember({ kind: parts[1], id: wanted });
      location.href =
        parts[1] === "album"
          ? `${ORIGIN}/n/ryqq_v2/albumDetail/${parts.slice(2).join(":")}`
          : parts[1] === "toplist"
            ? `${ORIGIN}/n/ryqq_v2/toplist/${parts.slice(2).join(":")}`
            : `${ORIGIN}/n/ryqq_v2/playlist/${parts.slice(2).join(":")}`;
    }
  };
  const resume = async () => {
    const command = pending();
    if (!command) return;
    const key = String(command.id).split(":").slice(2).join(":");
    const where =
      command.kind === "track"
        ? "songDetail"
        : command.kind === "album"
          ? "albumDetail"
          : command.kind === "toplist"
            ? "toplist"
            : "playlist";
    if (!location.pathname.includes(where) || !location.pathname.includes(key))
      return;
    // QQ Music's own queue: the page's song list in the storage key its player reads. This avoids
    // pressing the page's Play button (which may open its log-in dialog) and carries the whole page.
    const data = window.__INITIAL_DATA__;
    const songs = data?.songList ?? data?.songlist ?? data?.songs;
    if (Array.isArray(songs) && songs.length > 0) {
      const title =
        command.name ||
        data?.detail?.title ||
        one("h1, .playlist__title, .album__title")?.textContent ||
        "QQ Music";
      saveQueue(
        songs,
        command.index,
        command.id
          ? {
              id: command.id,
              name: norm(title),
              kind:
                command.kind ||
                (where === "albumDetail"
                  ? "album"
                  : where === "songDetail"
                    ? "song"
                    : "playlist"),
            }
          : null,
      );
      forget();
      post({ queued: true, track: tracks()[0] ?? null });
      return;
    }
    for (let i = 0; i < 24; i++) {
      if (clickPlay()) {
        await sleep(1200);
        forget();
        post({ queued: true, track: tracks()[0] ?? null });
        return;
      }
      await sleep(250);
    }
  };

  // --- The player -------------------------------------------------------------------------------------------
  const findAudio = () =>
    all("audio").find((audio) => audio.src || audio.currentSrc) ?? null;
  const trackFromRaw = (song, index = 0) => {
    if (!song?.mid) return null;
    return {
      id: `qq:track:${song.mid}`,
      name: norm(song.name ?? song.title),
      artist: artistName(song.singer),
      album: norm(song.album?.name ?? song.album?.title),
      albumId: song.album?.mid ? `qq:album:${song.album.mid}` : null,
      artistId: song.singer?.[0]?.mid
        ? `qq:artist:${song.singer[0].mid}`
        : null,
      image: coverOfSong(song),
      color: COLOR,
      duration: Number(song.interval) || parseTime(song.playTime),
      explicit: Boolean(song.ov),
      number: Number(song.number) || index + 1,
      favorite: typeof song.isFan === "boolean" ? song.isFan : undefined,
    };
  };
  const musicInfo = () => {
    if (location.pathname.includes("player_radio")) {
      const title = norm(one(".player_radio__song")?.textContent);
      const artist = norm(one(".player_radio__author")?.textContent);
      return {
        title,
        artist,
        text: [title, artist].filter(Boolean).join(" - "),
        href:
          one(
            'a[href*="/songDetail/"]',
            one(".player_radio__content"),
          )?.getAttribute("href") ?? "",
      };
    }
    const info = one(".player_music__info");
    const links = all("a", info ?? document);
    const titleLink = links.find((link) =>
      /songDetail\//.test(link.getAttribute("href") ?? ""),
    );
    const artistLink = links.find((link) =>
      /singer\//.test(link.getAttribute("href") ?? ""),
    );
    const text = norm(info?.textContent);
    const [title, artist] = text.includes(" - ")
      ? text.split(/\s+-\s+/, 2)
      : [text, ""];
    return {
      title: norm(titleLink?.textContent ?? title),
      artist: norm(artistLink?.textContent ?? artist),
      text,
      href: titleLink?.getAttribute("href") ?? "",
    };
  };
  const currentPlayback = () => {
    const audio = findAudio();
    const radio = location.pathname.includes("player_radio");
    const info = musicInfo();
    const time = radio
      ? {
          position: parseTime(one(".player_now_time")?.textContent),
          duration: parseTime(one(".player_total_time")?.textContent),
        }
      : pair(one(".player_music__time")?.textContent);
    const cover = radio
      ? (imageOf(one(".player_radio__cover")) ??
        background(one(".player_radio__cover")))
      : (background(one(".bg_player")) ??
        imageOf(one(".player_music__info, .player_music")));
    const mid = idOf(info.href, "track");
    const rows = tracks();
    const savedValue = (() => {
      try {
        return (
          JSON.parse(localStorage.getItem("playSongData") || "null")?.value ??
          null
        );
      } catch {
        return null;
      }
    })();
    const savedMeta = (() => {
      try {
        return JSON.parse(localStorage.getItem(QUEUE_META) || "null") ?? null;
      } catch {
        return null;
      }
    })();
    const rawQueue = Array.isArray(savedValue?.songList)
      ? savedValue.songList
      : [];
    const savedIndex = rawQueue.findIndex(
      (song) => song?.mid && song.mid === mid,
    );
    const queueIndex =
      savedIndex >= 0
        ? savedIndex
        : Math.max(0, Number(savedValue?.index) || 0);
    const savedCurrent = trackFromRaw(rawQueue[queueIndex], queueIndex);
    const playedDuration =
      Number.isFinite(audio?.duration) && Number(audio?.duration) > 0
        ? Number(audio.duration)
        : time.duration;
    const current = radio
      ? null
      : (rows.find((row) => norm(info.text).startsWith(norm(row.name))) ??
        rows.find(
          (row) =>
            norm(row.name) === norm(info.title) &&
            norm(row.artist) === norm(info.artist),
        ) ??
        rows.find((row) => norm(row.name) === norm(info.title)) ??
        savedCurrent ??
        null);
    const liked =
      /btn_big_like--like|btn_big_like[^"' ]*[^"' ]*(?:liked|active)/i.test(
        one(".btn_big_like")?.className ?? "",
      );
    const radioLiked =
      /btn_like--like|btn_like[^"' ]*[^"' ]*(?:liked|active)/i.test(
        one(".btn_like")?.className ?? "",
      );
    const next = radio
      ? []
      : rawQueue
          .slice(queueIndex + 1, queueIndex + 31)
          .map((song, index) => trackFromRaw(song, queueIndex + index + 1))
          .filter(Boolean);
    const track =
      current ??
      (info.title
        ? {
            id: mid
              ? `qq:track:${mid}`
              : radio
                ? `qq:radio-current:${encodeURIComponent(info.title)}|${encodeURIComponent(info.artist)}`
                : `qq:current:${info.title}`,
            name: info.title,
            artist: info.artist,
            album: "",
            image: cover ?? DEFAULT_IMAGE,
            color: COLOR,
            duration: playedDuration,
            explicit: false,
            favorite: radio ? radioLiked : liked,
          }
        : null);
    if (!track) return null;
    const index = current ? rows.indexOf(current) : 0;
    const mode = norm(
      one('.btn_big_only, [class*="loop"], [class*="mode"]')?.textContent,
    );
    const volumeBar = one(
      ".player_voice .player_progress__inner, .player_radio__voice .player_progress__inner",
    );
    const volumeBox = volumeBar?.getBoundingClientRect();
    const volumeFill = volumeBar
      ? one(".player_progress__play", volumeBar)
      : null;
    const volume =
      volumeBox && volumeBox.width > 0 && volumeFill
        ? Math.max(
            0,
            Math.min(
              1,
              volumeFill.getBoundingClientRect().width / volumeBox.width,
            ),
          )
        : (audio?.volume ?? null);
    return {
      track: {
        ...track,
        image: cover ?? track.image,
        duration: playedDuration || track.duration,
        favorite: radio ? radioLiked : liked,
      },
      context: savedMeta?.context ?? {
        id: radio ? "qq:radio" : "qq:player",
        name: radio ? "QQ 音乐电台" : "QQ Music",
        kind: radio ? "station" : "playlist",
      },
      playing: audio ? !audio.paused && !audio.ended : playing(),
      loading: false,
      position:
        Number.isFinite(audio?.currentTime) && Number(audio?.currentTime) > 0
          ? Number(audio.currentTime)
          : time.position,
      duration: playedDuration || track.duration,
      preview: false,
      shuffle: /随机|shuffle/i.test(mode),
      repeat: /单曲|one/i.test(mode)
        ? "one"
        : /循环|list/i.test(mode)
          ? "all"
          : "off",
      volume,
      next: next.length ? next : rows.slice(index + 1, index + 9),
    };
  };
  let lastPlayback = "";
  const sayPlayback = () => {
    const playback = currentPlayback();
    const text = JSON.stringify(playback);
    if (text !== lastPlayback) {
      lastPlayback = text;
      post({ playback });
    }
  };
  const click = (selector) => {
    const button = one(selector);
    if (button) {
      button.click();
      return true;
    }
    return false;
  };
  const clickAt = (x, y) => post({ click: { x, y } });
  const fire = (element, type, x, y, buttons = 0) =>
    element?.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        clientX: x,
        clientY: y,
        button: 0,
        buttons,
      }),
    );
  const seek = (seconds) => {
    const audio = findAudio();
    if (audio) {
      audio.currentTime = Math.max(0, seconds);
      return;
    }
    const bar = one(".player_progress__inner");
    const duration = currentPlayback()?.duration || 0;
    if (!bar || !duration) {
      post({
        log: `seek no bar=${Boolean(bar)} duration=${Math.round(duration)}`,
      });
      return;
    }
    const box = bar.getBoundingClientRect();
    const x =
      box.left + Math.max(0, Math.min(1, seconds / duration)) * box.width;
    const y = box.top + box.height / 2;
    post({
      log: `seek ${Math.round(seconds)}s at ${Math.round(x)},${Math.round(y)}`,
    });
    clickAt(x, y);
    // Fallback for a hidden composition view that does not take native input: the page's own
    // onClick is on the outer progress bar, not on its inner line.
    fire(bar.closest(".player_progress") ?? bar, "click", x, y);
  };
  const setVolume = (share) => {
    const audio = findAudio();
    if (audio) {
      audio.volume = Math.max(0, Math.min(1, share));
      return;
    }
    const bar = one(".player_voice .player_progress__inner");
    if (!bar) {
      post({ log: "volume no bar" });
      return;
    }
    const box = bar.getBoundingClientRect();
    const fill = one(".player_progress__play", bar);
    const current =
      fill && box.width
        ? Math.max(
            0,
            Math.min(1, fill.getBoundingClientRect().width / box.width),
          )
        : 0;
    const y = box.top + box.height / 2;
    const fromX = box.left + current * box.width;
    const toX = box.left + Math.max(0, Math.min(1, share)) * box.width;
    const dot = one(".player_progress__dot", bar);
    post({
      log: `volume ${Math.round(share * 100)}% at ${Math.round(toX)},${Math.round(y)}`,
    });
    post({
      drag: {
        fromX,
        fromY: y,
        toX,
        toY: y,
      },
    });
    // The same drag as the page itself: the dot's onMouseDown starts it, then the document's move/up
    // finish it. The outer bar's onClick is a second fallback.
    fire(dot ?? bar, "mousedown", fromX, y, 1);
    fire(document, "mousemove", toX, y, 1);
    fire(document, "mouseup", toX, y);
    fire(bar.closest(".player_progress") ?? bar, "click", toX, y);
  };
  const CONTROLS = {
    play() {
      const audio = findAudio();
      if (audio && audio.paused) return void audio.play().catch(() => {});
      if (!playing()) click(".btn_big_play, .btn_play");
    },
    pause() {
      const audio = findAudio();
      if (audio && !audio.paused) return void audio.pause();
      if (playing()) click(".btn_big_play, .btn_play");
    },
    next() {
      click(".btn_big_next, .js_play_next");
    },
    previous() {
      click(".btn_big_prev");
    },
    seek(command) {
      seek(Number(command.seconds) || 0);
    },
    volume(command) {
      setVolume((Number(command.percent) || 0) / 100);
    },
    shuffle() {
      click('[class*="shuffle"], [title*="随机"], [class*="random"]');
    },
    repeat() {
      click(
        '.btn_big_only, [class*="repeat"], [class*="loop"], [title*="循环"]',
      );
    },
    jump(command) {
      try {
        const stored = JSON.parse(
          localStorage.getItem("playSongData") || "null",
        );
        const currentMid = String(currentPlayback()?.track?.id ?? "")
          .split(":")
          .pop();
        const currentIndex = stored?.value?.songList?.findIndex(
          (song) => song?.mid === currentMid,
        );
        const base =
          currentIndex >= 0 ? currentIndex : Number(stored?.value?.index) || 0;
        if (stored?.value?.songList?.[base + (Number(command.offset) || 0)]) {
          stored.value.index = base + (Number(command.offset) || 0);
          stored.value.time = Date.now();
          localStorage.setItem("playSongData", JSON.stringify(stored));
          location.reload();
          return;
        }
      } catch {}
      const rows = all('.songlist__item, [class*="songlist__item"]');
      const row = rows[Number(command.offset) || 0];
      const button = row
        ? one(
            '[class*="list_menu__play"], [title="播放"], .songlist__icon',
            row,
          )
        : null;
      button?.click();
    },
    favorite() {
      click(".btn_big_like, .btn_like");
    },
    add() {},
  };

  // --- The truck's speakers ---------------------------------------------------------------------------------
  const cab = {
    speakers: null,
    head: null,
    outside: null,
    equalizer: null,
    spectrum: false,
  };
  let sound = null;
  const attach = () => {
    const qma = () => window.__westplayQmaOutput?.node ?? null;
    const source = qma() ?? findAudio();
    if (!source || sound || typeof window.westplayCabSound !== "function")
      return;
    sound = window.westplayCabSound(
      () => qma() ?? findAudio(),
      (message) => post(message),
      { playing },
    );
    if (cab.speakers !== null) sound.speakers(cab.speakers);
    if (cab.head !== null) sound.head(cab.head);
    if (cab.outside !== null)
      sound.outside(cab.outside.on, cab.outside.distance);
    if (cab.equalizer !== null) sound.equalizer(cab.equalizer);
    sound.spectrum(cab.spectrum);
  };
  const CAB = {
    speakers(data) {
      cab.speakers = data.speakers;
      sound?.speakers(data.speakers);
    },
    head(data) {
      cab.head = data;
      sound?.head(data);
    },
    outside(data) {
      cab.outside = data;
      sound?.outside(data.on, data.distance);
    },
    equalizer(data) {
      cab.equalizer = data;
      sound?.equalizer(data);
    },
    spectrum(data) {
      cab.spectrum = Boolean(data.on);
      sound?.spectrum(cab.spectrum);
    },
  };

  // --- Messages ---------------------------------------------------------------------------------------------
  window.chrome?.webview?.addEventListener("message", ({ data }) => {
    if (!data) return;
    if (CAB[data.action]) return CAB[data.action](data);
    if (data.action === "start") return sayState();
    if (role === "browse") {
      if (data.action === "ask") return void ask(data.id, data.question);
      if (data.action === "prepare") return void queue(data);
    } else {
      CONTROLS[data.action]?.(data);
    }
  });

  // A page loaded anew: the host re-asks what it missed, and prepares what was waiting.
  setTimeout(() => {
    post({ ready: true });
    sayState();
    if (role === "browse") void resume();
    if (role === "player") {
      sayPlayback();
      attach();
    }
  }, 600);

  setInterval(sayState, 1500);
  if (role === "player") {
    setInterval(sayPlayback, 500);
    setInterval(attach, 1000);
  }
})();
