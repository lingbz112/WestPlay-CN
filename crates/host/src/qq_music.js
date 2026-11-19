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
  // A line for the host's log (never louder than a line, and never able to throw: the log must not be the
  // reason something fails).
  const log = (line) => {
    try {
      post({ log: String(line).slice(0, 400) });
    } catch {}
  };
  const navigate = (url) => {
    // The host stops Chromium presenting these hidden pages while they are idle. A full document
    // navigation briefly needs its compositor; the new page asks for it to be hidden after Ready.
    post({ render: true });
    location.href = url;
  };
  // QQ's media hosts send `Access-Control-Allow-Origin: *`. Set CORS before the site assigns a media
  // source so a radio <audio> can join Web Audio instead of being silenced by MediaElementSource.
  try {
    const src = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "src");
    if (src?.get && src?.set) {
      Object.defineProperty(HTMLMediaElement.prototype, "src", {
        configurable: true,
        enumerable: src.enumerable,
        get() {
          return src.get.call(this);
        },
        set(value) {
          if (/^https?:/i.test(String(value))) this.crossOrigin = "anonymous";
          src.set.call(this, value);
        },
      });
    }
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      if (
        this instanceof HTMLMediaElement &&
        String(name).toLowerCase() === "src" &&
        /^https?:/i.test(String(value))
      )
        this.crossOrigin = "anonymous";
      return setAttribute.call(this, name, value);
    };
    const append = Node.prototype.appendChild;
    Node.prototype.appendChild = function (child) {
      if (this instanceof HTMLMediaElement && child instanceof HTMLSourceElement)
        this.crossOrigin = "anonymous";
      return append.call(this, child);
    };
    const AudioElement = window.Audio;
    window.Audio = function (...args) {
      const audio = new AudioElement(...args);
      audio.crossOrigin = "anonymous";
      return audio;
    };
    window.Audio.prototype = AudioElement.prototype;
  } catch (error) {
    post({ log: `radio CORS media hook failed: ${error}` });
  }
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const norm = (value) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  /** The site's lyrics come base64 (the words, and their translation): the text it stands for. */
  const base64Text = (value) => {
    if (!value) return "";
    try {
      const binary = atob(String(value));
      return new TextDecoder().decode(
        Uint8Array.from(binary, (character) => character.charCodeAt(0)),
      );
    } catch {
      return String(value);
    }
  };
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

  const waitFor = async (read, timeout = 12000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const value = read();
      if (value) return value;
      await sleep(100);
    }
    return null;
  };
  const qqApi = async (module, usable = (api) => api) => {
    const require = await waitFor(() => window.__westplayRequire);
    if (!require) {
      log(`api ${module}: no require (factories ${window.__westplayFactories?.size ?? 0})`);
      throw new Error("QQ Music API is not ready");
    }
    // Why the wait found nothing, for the failure's log: an id the site no longer has ("throws") told apart
    // from one it has but shapes otherwise ("unusable"), and from one that simply never arrived.
    let why = "nothing";
    const api = await waitFor(() => {
      try {
        const value = require(module);
        if (usable(value)) return value;
        why = `unusable ${typeof value} [${value ? Object.keys(value).slice(0, 8).join(" ") : ""}]`;
        return null;
      } catch (error) {
        why = `throws ${String(error).slice(0, 100)}`;
        return null;
      }
    });
    if (!api) {
      const factories = window.__westplayFactories;
      log(
        `api ${module}: ${why}; factories ${factories?.size ?? 0}, id ${factories?.has(String(module)) ? "known" : "missing"}`,
      );
      throw new Error(`QQ Music API ${module} is not ready`);
    }
    return api;
  };
  const within = (promise, milliseconds, message) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(message)), milliseconds),
      ),
    ]);
  // The site's own signed request (module 8): only the favorite write still rides it — its signature comes
  // from QQ's own anti-scraping SDK and cannot be reproduced off the page (an unsigned write answers success
  // without touching the account). Every read now goes straight to the same HTTP APIs the module wraps.
  const requestApi = async () => {
    const api = (
      await qqApi(8, (value) => typeof value?.j === "function")
    ).j();
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

  const avatar = () => {
    const image = one(
      '.top_login__link img, .player_login__link img, [class*="avatar"] img',
    );
    const src = image?.currentSrc || image?.src || "";
    return src.startsWith("https://") && !src.startsWith("data:") ? src : null;
  };

  // --- The skills API's key ---------------------------------------------------------------------------------
  //
  // QQ Music's own skills page shows the account's key: masked until its eye is pressed. The page is read here
  // (the same cookies), and the key is kept for this session: only the daily 30 uses it.
  const KEY_PAGE = `${ORIGIN}/n/ryqq_v2/qqmusic_skills`;
  let apiKey = null;
  // Two asks at once (React's double effect in dev) must not navigate over each other: one page opens.
  let keyOpening = false;
  const keyOf = async () => {
    if (apiKey) return apiKey;
    if (!signedIn()) {
      log("key: not signed in");
      return null;
    }
    if (!location.pathname.includes("qqmusic_skills")) {
      if (!keyOpening) {
        keyOpening = true;
        log(`key: opening the skills page from ${location.pathname}`);
        navigate(KEY_PAGE);
        setTimeout(() => {
          keyOpening = false;
        }, 3000);
      }
      // Navigating: the host asks again once the page loads.
      return undefined;
    }
    // Every key the page shows (the setup's, and the rows of the account's own): the unmasked one is used.
    const rawKeys = () =>
      all(".api_key_text")
        .map((each) => String(each.textContent ?? ""))
        .filter(Boolean);
    const clean = (text) => text.replace(/[^A-Za-z0-9-]/g, "");
    const keys = () => rawKeys().filter((text) => !text.includes("*")).map(clean).filter(Boolean);
    const usable = () => keys().find((text) => /^qmk-[a-z0-9-]+$/i.test(text)) ?? null;
    const summaries = () =>
      rawKeys()
        .map((each) => `${each.length}ch/${(each.match(/\*/g) ?? []).length}*`)
        .join(", ");
    const text = await waitFor(() => rawKeys()[0] || null, 15000);
    if (!text) {
      log("key: no .api_key_text on the skills page");
      return null;
    }
    let full = usable();
    if (!full) {
      const eyes = all(".api_key_eye");
      log(`key: ${rawKeys().length} texts (${summaries()}), ${eyes.length} eyes`);
      for (const eye of eyes) eye.click();
      full = await waitFor(usable, 3000);
      if (!full) {
        log(`key: no usable key after the eyes (${summaries()})`);
        return null;
      }
    }
    apiKey = full;
    log(`key: read (${full.length} chars)`);
    return apiKey;
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
    const srcset =
      image.getAttribute("srcset") ||
      image.getAttribute("data-srcset") ||
      "";
    const candidates = [
      image.currentSrc,
      image.src,
      image.getAttribute("data-original"),
      image.getAttribute("data-origin"),
      image.getAttribute("data-lazy-src"),
      image.getAttribute("data-src"),
      image.getAttribute("data-qar-def"),
      srcset
        .split(",")
        .map((part) => part.trim().split(/\s+/)[0])
        .filter(Boolean)[0],
    ];
    for (const candidate of candidates) {
      if (!candidate || candidate.startsWith("data:")) continue;
      if (
        /mediastyle\/global\/img\/album_300|(?:blank|transparent)\.gif|no[_-]?cover/i.test(
          candidate,
        )
      )
        continue;
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
  const coverCache = new Map();
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
      image:
        coverCache.get(`qq:${kind}:${id}`) ?? imageOf(card) ?? DEFAULT_IMAGE,
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
      image: coverCache.get(`qq:track:${id}`) ?? imageOf(row) ?? DEFAULT_IMAGE,
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
    if (missing.length)
      post({ log: `item covers missing ${missing.length}/${list.length}` });
    const fill = (item) => {
      const parts = String(item.id).split(":");
      const kind = parts[1];
      const id = parts.slice(2).join(":");
      if (!id || (kind !== "album" && kind !== "playlist")) return null;
      const url =
        kind === "album"
          ? `${ORIGIN}/n/ryqq_v2/albumDetail/${id}`
          : `${ORIGIN}/n/ryqq_v2/playlist/${id}`;
      return fetchDoc(url).then((doc) => {
        const node =
          nodeOf(doc, kind === "album" ? "MusicAlbum" : "MusicPlaylist") ??
          nodeOf(doc, "MusicPlaylist") ??
          nodeOf(doc, "MusicAlbum");
        if (!node?.image) return;
        item.image = new URL(node.image, location.href).href;
        coverCache.set(item.id, item.image);
      });
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      await Promise.all(
        missing
          .filter((item) => missingCover(item.image))
          .map((item) => fill(item)?.catch(() => {})),
      );
      if (missing.every((item) => !missingCover(item.image))) break;
      await sleep(250);
    }
    if (missing.length)
      post({
        log: `item covers done ${missing.filter((item) => !missingCover(item.image)).length}/${missing.length}`,
      });
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

  /** The 猜你喜欢 station of the radio page, its cover read there (kept for the session). */
  let stationItem;
  const recommendStation = async () => {
    if (stationItem !== undefined) return stationItem;
    try {
      const doc = await within(
        fetchDoc(`${ORIGIN}/n/ryqq_v2/radio`),
        8000,
        "QQ Music station timed out",
      );
      const data = initialData(doc);
      const groups = data?.radio_list ?? data?.data?.radio_list ?? [];
      const found = (Array.isArray(groups) ? groups : [])
        .flatMap((group) => group?.list ?? [])
        .find(
          (station) =>
            Number(station?.id) === 99 ||
            norm(station?.title) === "猜你喜欢",
        );
      stationItem = found
        ? {
            id: `qq:station:${found.id}`,
            kind: "station",
            name: norm(found.title) || "猜你喜欢",
            by: "",
            note: "",
            image: imageUrl(found.pic_url),
            wide: null,
            color: COLOR,
            explicit: false,
            live: false,
          }
        : null;
    } catch (error) {
      log(`station: ${error}`);
      stationItem = null;
    }
    return stationItem;
  };

  const homePage = async () => {
    await waitFor(
      () =>
        document.readyState === "complete" &&
        tracks().length >= 20 &&
        items("playlist").length > 0 &&
        items("album").length > 0,
      12000,
    );
    // The last React commit follows `complete`; don't read the half-populated first frame.
    await sleep(250);
    const [playlists, songs, albums] = await Promise.all([
      enrichItems(items("playlist").slice(0, 12), 12),
      enrichTracks(tracks().slice(0, 20), 20),
      enrichItems(items("album").slice(0, 8), 8),
    ]);
    const sections = [];
    const station = await recommendStation();
    if (station) sections.push(section("", "hero", [station], []));
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
            .filter(
              (station) =>
                Number(station?.id) !== 99 &&
                norm(station?.title) !== "猜你喜欢",
            )
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
            if (!name || name === "猜你喜欢") return null;
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
  /** 为你推荐: the account's AI playlists (QQ Music's 9527 category), fetched afresh each time. */
  const radioPage = async () => {
    const profile = await profileData();
    const caller = String(profile?.pageuin ?? "");
    if (!caller) return emptyPage();
    const data = await api(
      "music.playlist.AiPlCategory",
      "get_ai_category_content",
      { caller, category_id: 9527, size: 20, page: 0, use_page: 1 },
      caller,
    );
    const cards = data?.content?.v_item ?? [];
    const items = cards
      .map((card) => {
        const basic = card?.basic ?? card ?? {};
        const id = String(basic?.tid ?? basic?.dissid ?? "");
        const name = norm(basic?.title ?? basic?.dissname);
        if (!id || id === "0" || !name) return null;
        return {
          id: `qq:playlist:${id}`,
          kind: "playlist",
          name,
          by: norm(basic?.creator?.nick),
          note: "",
          image: imageUrl(basic?.cover?.default_url) ?? DEFAULT_IMAGE,
          wide: null,
          color: COLOR,
          explicit: false,
          live: false,
        };
      })
      .filter(Boolean);
    log(`recommend: ${cards.length} cards, ${items.length} playlists`);
    return page([section("为你推荐", "shelf", items, [])]);
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
      ((song?.album?.pmid ?? song?.album?.mid)
        ? `//y.qq.com/music/photo_new/T002R300x300M000${song.album.pmid ?? song.album.mid}.jpg?max_age=2592000`
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
    const targets = list.slice(0, most);
    const missing = targets.filter((track) => missingCover(track.image));
    if (missing.length)
      post({ log: `covers missing ${missing.length}/${list.length}` });
    const byId = new Map(
      targets.map((track) => [String(track.id).split(":").pop(), track]),
    );
    const mids = [...byId.keys()];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        for (let start = 0; start < mids.length; start += 100) {
          const part = mids.slice(start, start + 100);
          const answers = await apiMany(
            part.map((mid) => ({
              module: "music.pf_song_detail_svr",
              method: "get_song_detail_yqq",
              param: { song_mid: mid },
            })),
          );
          const raw = answers.map((answer) => answer?.data?.track_info);
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
            if (!missingCover(track.image))
              coverCache.set(track.id, track.image);
          }
        }
      } catch (error) {
        if (attempt === 2)
          post({ log: `track covers API failed: ${error}` });
      }
      if (!targets.some((track) => missingCover(track.image))) break;
      await sleep(300 * (attempt + 1));
    }
    const stillMissing = targets.filter((track) => missingCover(track.image));
    await Promise.all(
      stillMissing.map(async (track) => {
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
          if (!missingCover(track.image))
            coverCache.set(track.id, track.image);
        } catch {}
      }),
    );
    if (missing.length)
      post({
        log: `covers done ${targets.filter((track) => !missingCover(track.image)).length}/${targets.length}`,
      });
    return list;
  };
  const collectionAnswer = async (id) => {
    const parts = String(id).split(":");
    const collectionKind = parts[1] === "album" ? "album" : "playlist";
    const collectionId = parts.slice(2).join(":");
    if (!collectionId) return null;
    // A station is not a playlist: its songs come from the radio API, a batch at a time (and each call is
    // fresh, which is the point of a radar).
    if (parts[1] === "radio" || parts[1] === "station") {
      try {
        const data = await api("mb_track_radio_svr", "get_radio_track", {
          id: Number(collectionId) || collectionId,
          num: 30,
          firstplay: 1,
        });
        const rows = Array.isArray(data.tracks) ? data.tracks : [];
        const songs = rows
          .map((raw) => {
            const mid = String(raw?.mid ?? "");
            const track = mid ? trackFromApi(raw) : null;
            if (track) byMid.set(mid, track);
            return track;
          })
          .filter(Boolean);
        if (songs.length) {
          const item = {
            id: `qq:radio:${collectionId}`,
            kind: "station",
            name: norm(data.name) || "QQ 音乐电台",
            by: norm(data.slogan),
            note: norm(data.slogan),
            image: imageUrl(data.bg_pic_url) ?? DEFAULT_IMAGE,
            wide: null,
            color: COLOR,
            explicit: false,
            live: false,
          };
          return {
            item,
            description: norm(data.slogan),
            genre: "",
            year: null,
            tracks: songs.slice(0, 12),
          };
        }
      } catch (error) {
        log(`radio ${collectionId}: ${error}`);
      }
    }
    if (collectionKind === "playlist") {
      try {
        const songs = [];
        let total = Infinity;
        let info = null;
        for (
          let start = 0, page = 0;
          start < total && page < 12;
          start += 100, page++
        ) {
          const response = await within(
            apiMany([
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
        navigate(url);
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
  /** The artist's own words, from the site's homepage tab (`wiki`): its paragraphs' text. */
  const artistBio = async (artistId) => {
    try {
      const [data] = await within(
        apiMany([
          {
            module: "music.UnifiedHomepage.UnifiedHomepageSrv",
            method: "GetHomepageTabDetail",
            param: {
              SingerMid: artistId,
              IsQueryTabDetail: 1,
              TabID: "wiki",
              PageNum: 0,
              PageSize: 10,
              Order: 0,
            },
          },
        ]),
        15000,
        "QQ Music artist bio timed out",
      );
      const paragraphs = data?.data?.IntroductionTab?.List ?? [];
      const text = paragraphs
        .map((each) => String(each?.Content ?? each?.content ?? each?.Text ?? each?.text ?? "").trim())
        .filter(Boolean)
        .join("\n\n");
      log(`artist ${artistId} wiki: ${paragraphs.length} paragraphs, ${text.length} chars`);
      return text;
    } catch (error) {
      log(`artist ${artistId} wiki: ${error}`);
      return "";
    }
  };
  /** An artist's page: their top songs and albums from the site's own APIs (its page shows ten songs, and
   * draws the rest only in its player), and their own words from its wiki tab. */
  const artistAnswer = async (id, page = 1) => {
    const artistId = String(id).split(":").slice(2).join(":");
    if (!artistId) return null;
    const at = Math.max(1, Number(page) || 1);
    const doc = await fetchDoc(`${ORIGIN}/n/ryqq_v2/singer/${artistId}`);
    const node = nodeOf(doc, "MusicGroup");
    // Their own words are the page's own data (whole, unlike its meta description): the wiki tab's when the
    // page has none.
    const own = initialData(doc)?.singerDetail;
    const words = String(own?.shortdesc ?? "").trim();
    const item = {
      id: `qq:artist:${artistId}`,
      kind: "artist",
      name: norm(
        node?.name ?? one("h1, .singer__title", doc)?.textContent ?? "QQ Music",
      ),
      by: "",
      note: "",
      image: node?.image
        ? new URL(node.image, location.href).href
        : DEFAULT_IMAGE,
      wide: null,
      color: COLOR,
      explicit: false,
      live: false,
    };
    if (at === 1) item.note = words || (await artistBio(artistId)) || norm(node?.description);
    if (at === 1) log(`artist ${artistId} bio: ${item.note.length} chars`);
    const requests = [
      {
        module: "musichall.song_list_server",
        method: "GetSingerSongList",
        param: { singerMid: artistId, order: 1, number: 30, begin: (at - 1) * 30 },
      },
    ];
    if (at === 1)
      requests.push({
        module: "music.musichallAlbum.AlbumListServer",
        method: "GetAlbumList",
        param: { singerMid: artistId, order: 1, number: 30, begin: 0 },
      });
    const answers = await within(apiMany(requests), 20000, "QQ Music artist timed out");
    const songs = (answers?.[0]?.data?.songList ?? [])
      .map((each) => trackFromApi(each?.songInfo ?? each))
      .filter(Boolean);
    // Its albums, every page of them (the client lists all of them: forty-three for 周杰伦, not one page).
    const albumRows = [...(answers?.[1]?.data?.albumList ?? [])];
    if (at === 1) {
      const total = Number(answers?.[1]?.data?.total) || 0;
      let begin = albumRows.length;
      for (let page = 0; page < 10 && begin > 0 && (total > 0 ? begin < total : albumRows.length >= 30); page++) {
        const [data] = await within(
          apiMany([
            {
              module: "music.musichallAlbum.AlbumListServer",
              method: "GetAlbumList",
              param: { singerMid: artistId, order: 1, number: 30, begin },
            },
          ]),
          20000,
          "QQ Music albums timed out",
        );
        const list = data?.data?.albumList ?? [];
        if (list.length === 0) break;
        albumRows.push(...list);
        begin += list.length;
      }
    }
    const albums = albumRows.map(albumFromApi).filter(Boolean);
    log(`artist ${artistId} p${at}: ${songs.length} songs, ${albums.length} albums`);
    return { item, top: songs, albums, sections: [] };
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
      navigate(`${ORIGIN}/n/ryqq_v2/search?w=${encodeURIComponent(label)}&t=playlist`);
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
  /** A singer of the search's, as its card: its picture's own address when it gives none. */
  const artistFromApi = (singer) => {
    const mid = String(
      singer?.mid ?? singer?.singermid ?? singer?.singerMID ?? singer?.singerMid ?? "",
    );
    const name = norm(
      singer?.name ?? singer?.title ?? singer?.singername ?? singer?.singerName,
    );
    if (!mid || !name) return null;
    return {
      id: `qq:artist:${mid}`,
      kind: "artist",
      name,
      by: "",
      note: "",
      image: imageUrl(
        singer?.pic ??
          singer?.singerPic ??
          singer?.avatar ??
          `//y.qq.com/music/photo_new/T001R300x300M000${mid}.jpg?max_age=2592000`,
      ),
      wide: null,
      color: COLOR,
      explicit: false,
      live: false,
    };
  };
  /** An album of the search's, as its card. */
  const albumFromApi = (album) => {
    const mid = String(
      album?.albumMID ??
        album?.albumMid ??
        album?.albummid ??
        album?.mid ??
        album?.pmid ??
        "",
    );
    const name = norm(
      album?.albumName ?? album?.albumname ?? album?.name ?? album?.title,
    );
    if (!mid || !name) return null;
    const singers = Array.isArray(album?.singer)
      ? album.singer.map((each) => each?.name).filter(Boolean)
      : [];
    return {
      id: `qq:album:${mid}`,
      kind: "album",
      name,
      by: norm(
        album?.singerName ?? album?.singername ?? singers.join(" / "),
      ),
      note: "",
      image: imageUrl(
        album?.albumPic ??
          album?.pic ??
          `//y.qq.com/music/photo_new/T002R300x300M000${mid}.jpg?max_age=2592000`,
      ),
      wide: null,
      color: COLOR,
      explicit: false,
      live: false,
    };
  };
  const playlistFromApi = (playlist) => {
    const id =
      playlist?.dissid ??
      playlist?.disstid ??
      playlist?.dirid ??
      playlist?.tid ??
      playlist?.id ??
      playlist?.content_id;
    const name = norm(
      playlist?.dissname ??
        playlist?.diss_name ??
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
  /** A GET of the account's own web APIs: the answer as JSON (one of them wraps it in a callback: unwrapped
   * here). These are plain public endpoints — no signature, just the page's own cookies. */
  const webGet = async (url, data) => {
    const query = Object.entries(data)
      .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
      .join("&");
    const response = await fetch(`${url}?${query}`, { credentials: "include" });
    if (!response.ok) throw new Error(`http ${response.status}`);
    const text = await response.text();
    return JSON.parse(
      text.replace(/^\s*[\w.]+\(/, "").replace(/\)?\s*;?\s*$/, ""),
    );
  };
  let cachedProfile = null;
  /** The account: its uin, and its 我喜欢 playlist's id (the homepage API's `mymusic` names it). */
  const profileData = async () => {
    if (!signedIn()) return null;
    if (cachedProfile) return cachedProfile;
    const data = await within(
      webGet("https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg", {
        cid: 205360838,
        ct: 24,
        userid: 0,
        reqfrom: 1,
        reqtype: 0,
        hostUin: 0,
        loginUin: cookie("uin") || 0,
        needNewCode: 0,
      }),
      15000,
      "QQ Music profile timed out",
    );
    const mine = (data?.data?.mymusic ?? []).find(
      (each) => Number(each?.type) === 1,
    );
    cachedProfile = {
      pageuin: cookie("uin") || "0",
      myFavDissId: Number(mine?.id) || 0,
    };
    return cachedProfile;
  };
  /**
   * The Library through QQ Music's own signed-in API rather than its visible page. The page deliberately
   * renders only ten songs and replaces its pager with a "download the client" advert. The API returns the
   * real total and pages, so all 641 liked songs are available without bouncing the browser between routes.
   */
  // The real 我喜欢 as the account's own list (what the official client shows). Both the library shelf and the
  // favourite star read from this one cache; a confirmed write clears it so the next read refetches.
  let liked = null;
  let likedLoading = null;
  const loadLiked = async () => {
    if (liked) return liked;
    likedLoading ??= (async () => {
      const profile = await profileData();
      const disstid = Number(profile?.myFavDissId);
      if (!disstid) return null;
      const rows = [];
      let total = Infinity;
      for (
        let start = 0, page = 0;
        start < total && page < 12;
        start += 100, page++
      ) {
        const [answer] = await within(
          apiMany([
            {
              module: "music.srfDissInfo.aiDissInfo",
              method: "uniform_get_Dissinfo",
              param: { song_begin: start, song_num: 100, disstid },
            },
          ]),
          15000,
          "QQ Music liked songs timed out",
        );
        const pageRows = answer?.data?.songlist ?? [];
        rows.push(...pageRows);
        total = Number(answer?.total_song_num ?? answer?.data?.total_song_num);
        if (!Number.isFinite(total) || total <= 0)
          total = pageRows.length < 100 ? start + pageRows.length : start + pageRows.length + 1;
        if (!pageRows.length || pageRows.length < 100) break;
      }
      liked = { rows, total: rows.length, mids: new Set(rows.map((row) => String(row?.mid ?? "")).filter(Boolean)) };
      return liked;
    })()
      .catch((error) => {
        log(`liked list: ${error}`);
        return null;
      })
      .finally(() => {
        likedLoading = null;
      });
    return likedLoading;
  };

  const libraryAnswer = async (shelf) => {
    if (!signedIn()) return { items: [], songs: [], sorts: [], sort: null };
    // Every entry shows the account's lists as they are now: the liked songs fetched again.
    if (shelf === "songs") liked = null;
    const profile = await profileData();
    if (!profile?.pageuin) throw new Error("QQ Music account is not ready");
    const size = 100;
    const pages = async (load) => {
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
        const reached = part.rows.length;
        rows.push(...part.rows);
        total = Number(part.total);
        if (!Number.isFinite(total) || total <= 0)
          total = reached < size ? start + reached : start + size + 1;
        if (reached === 0 || reached < size) break;
      }
      return rows;
    };
    if (shelf === "songs") {
      const list = await loadLiked();
      const rows = list?.rows ?? [];
      post({ log: `library liked songs ${rows.length}` });
      return {
        items: [],
        songs: tracksFromInitial({ songlist: rows }),
        sorts: [],
        sort: null,
      };
    }
    if (shelf === "playlists" || shelf === "recent") {
      const rows = await pages(async (start, pageSize) => {
        const data = await webGet(
          "https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss",
          { hostuin: profile.pageuin, sin: start, size: pageSize + 1 },
        );
        // The special folders (我喜欢, QZone, uploads) have no playlist id: not openable here, left out.
        const list = (data?.data?.disslist ?? []).filter((row) => row?.tid);
        return {
          rows: list.map((row) => ({
            dissid: row.tid,
            dissname: row.diss_name,
            diss_cover: row.diss_cover,
          })),
          total: Number(data?.data?.totoal),
        };
      });
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
      const rows = await pages(async (start, pageSize) => {
        const data = await webGet(
          "https://c.y.qq.com/shop/fcgi-bin/fcg_get_order",
          {
            from: 1,
            cmd: "sales_album",
            type: 2,
            t: Date.now(),
            uin: profile.pageuin,
            start,
            num: pageSize,
            platform: "yqq",
          },
        );
        return { rows: data?.data?.songlist ?? [], total: data?.data?.total };
      });
      return {
        items: [],
        songs: tracksFromInitial({ songlist: rows }),
        sorts: [],
        sort: null,
      };
    }
    if (shelf === "albums") {
      const rows = await pages(async (start, pageSize) => {
        const data = await webGet(
          "https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg",
          {
            ct: 20,
            cid: 205360956,
            userid: profile.pageuin,
            reqtype: 2,
            sin: start,
            ein: start + pageSize - 1,
          },
        );
        // The rows name the singer and cover in their own way: shaped as the shelves read them.
        return {
          rows: (data?.data?.albumlist ?? []).map((row) => ({
            ...row,
            singer: row.singername,
            picurl: row.pic,
          })),
          total: data?.data?.totalalbum,
        };
      });
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
          const response = await within(
            apiMany([
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
    // The words and the site's own translation of them (bilingual songs have one), from its lyric API.
    const [answer] = await within(
      apiMany([
        {
          module: "music.musichallSong.PlayLyricInfo",
          method: "GetPlayLyricInfo",
          param: {
            songMID: mid,
            songID: 0,
            trans: 1,
            crypt: 0,
            lrc_t: 0,
            qrc: 0,
            qrc_t: 0,
            roma: 0,
            roma_t: 0,
          },
        },
      ]),
      15000,
      "QQ Music lyrics timed out",
    );
    const payload = answer?.data ?? {};
    const text = base64Text(payload.lyric);
    const translation = base64Text(payload.trans);
    const timedWords = (raw) => {
      const found = [];
      for (const row of raw.split(/\r?\n/)) {
        const stamps = [...row.matchAll(/\[(\d{1,3}):(\d{2}(?:\.\d+)?)\]/g)];
        if (!stamps.length) continue;
        const words = norm(row.replace(/\[[^\]]+\]/g, ""));
        if (!words) continue;
        for (const stamp of stamps)
          found.push({
            start: Number(stamp[1]) * 60 + Number(stamp[2]),
            text: words,
          });
      }
      found.sort((a, b) => a.start - b.start);
      return found;
    };
    const timed = timedWords(text);
    // The site marks a line it has no translation for with slashes ("//"): it has none.
    const translated = new Map(
      timedWords(translation)
        .filter((line) => !/^[\/\s]+$/.test(line.text))
        .map((line) => [Math.round(line.start * 10), line.text]),
    );
    log(`lyrics ${mid}: ${timed.length} lines, ${translated.size} translated`);
    const lines = timed.map((line, index) => {
      const words = translated.get(Math.round(line.start * 10));
      return {
        start: line.start,
        end: timed[index + 1]?.start ?? 0,
        text: line.text,
        ...(words ? { translation: words } : {}),
      };
    });
    const plain = text.split(/\r?\n/).map((line) => norm(line)).filter(Boolean);
    const plainTranslation = translation
      .split(/\r?\n/)
      .map((line) => norm(line))
      .filter((line) => line && !line.startsWith("[") && !/^[\/\s]+$/.test(line));
    return {
      synced: lines.length > 0,
      lines: lines.length
        ? lines
        : plain
            .slice(0, 300)
            .map((line, index) => ({
              start: 0,
              end: 0,
              text: line,
              ...(plainTranslation[index] ? { translation: plainTranslation[index] } : {}),
            })),
      provider: "QQ音乐",
      writers: [],
      rtl: false,
    };
  };
  /** The search's groups: its body's key, the app's name for it, the site's `remoteplace`, the `search_type`s
   * tried for it (the site's own for the group first; a group the first answers nothing for is tried with the
   * others, and the first that answers is taken). */
  const SEARCH_GROUPS = [
    ["song", "songs", "txt.yqq.song", [0]],
    ["singer", "artists", "txt.yqq.singer", [1]],
    ["album", "albums", "txt.yqq.album", [2]],
    ["songlist", "playlists", "txt.yqq.playlist", [5, 4, 3, 2]],
  ];
  const SEARCH_MOST = 20;
  /** A search's page: every group's on the first (the app's page of them), or just `group`'s for the pages
   * after it. What each try held is logged, so a group the site stops answering is visible. */
  const searchAnswer = async (query, page = 1, group = null) => {
    const wanted = SEARCH_GROUPS.filter(([, name]) => !group || name === group);
    const tries = [];
    for (const [key, name, remoteplace, types] of wanted)
      for (const search_type of types) tries.push({ key, name, remoteplace, search_type });
    const searchid = String(Date.now());
    const response = await within(
      apiMany(
        tries.map(({ remoteplace, search_type }) => ({
          module: "music.search.SearchCgiService",
          method: "DoSearchForQQMusicDesktop",
          param: {
            remoteplace,
            searchid,
            search_type,
            query,
            page_num: Math.max(1, Number(page) || 1),
            num_per_page: SEARCH_MOST,
          },
        })),
      ),
      20000,
      "QQ Music search timed out",
    );
    const found = { songs: [], artists: [], albums: [], playlists: [] };
    tries.forEach(({ key, name, search_type }, index) => {
      const list = response?.[index]?.data?.body?.[key]?.list ?? [];
      const rows =
        name === "songs"
          ? list.map(trackFromApi).filter(Boolean)
          : name === "artists"
            ? list.map(artistFromApi).filter(Boolean)
            : name === "albums"
              ? list.map(albumFromApi).filter(Boolean)
              : list.map(playlistFromApi).filter(Boolean);
      log(`search ${JSON.stringify(query)} p${Math.max(1, Number(page) || 1)} ${name} type${search_type}: ${list.length} raw, ${rows.length} kept`);
      if (list.length > 0) log(`search ${name} fields: ${Object.keys(list[0]).join(",")}`);
      if (rows.length > 0 && found[name].length === 0) found[name] = rows;
    });
    return { top: [], ...found, stations: [] };
  };
  const inFlight = new Set();
  const ask = async (id, question) => {
    const key = `${id}:${question?.ask ?? ""}`;
    if (inFlight.has(key)) return;
    inFlight.add(key);
    try {
      let answer = null;
      switch (question?.ask) {
        case "home":
          if (location.pathname !== "/") {
            navigate(HOME);
            return;
          }
          answer = await homePage();
          break;
        case "new":
          if (!location.pathname.includes("/radio")) {
            navigate(`${ORIGIN}/n/ryqq_v2/radio`);
            return;
          }
          answer = await newPage();
          break;
        case "radio":
          answer = await radioPage();
          break;
        case "key":
          answer = await keyOf();
          if (answer === undefined) return;
          if (answer === null) post({ answer: id, failed: true });
          break;
        case "browse":
          answer = [];
          break;
        case "search":
          answer = await searchAnswer(question.query, question.page, question.group);
          break;
        case "collection":
          answer = await collectionAnswer(question.id);
          break;
        case "artist":
          answer = await artistAnswer(question.id, question.page);
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
    } finally {
      inFlight.delete(key);
    }
  };

  // --- Playing: WestPlay's own player, from the site's own sound -------------------------------------------
  //
  // QQ Music's own web player is a whole application: it renders into Web Audio (QMA), reloads itself to take a
  // new queue, and saves its volume badly (the first song after a load comes back at full). So this page is only
  // the data here — songs from the site's own APIs, their sound from `vkey.GetVkeyServer` — and WestPlay plays
  // it in an <audio> of its own: the volume, the place in the song and the truck's speakers are all ours, and
  // nothing of the site's player is loaded at all.

  const FCG = "https://u.y.qq.com/cgi-bin/musicu.fcg";
  const guid = String(1000000 + Math.floor(Math.random() * 8999999));

  /** A `musicu.fcg` call: the site's own JSON API, this page's cookies with it. `uin`: whose account, when the
   * caller knows it better than the cookie does (the writes need the real one). */
  const api = async (module, method, param, uin) => {
    const body = {
      comm: { ct: 24, cv: 0, format: "json", uin: uin || cookie("uin") || "0", guid },
      req_0: { module, method, param },
    };
    let response;
    try {
      response = await fetch(FCG, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      // The GET form, for a host that won't take the POST cross-origin.
      const url = `${FCG}?format=json&data=${encodeURIComponent(JSON.stringify(body))}`;
      response = await fetch(url, { credentials: "include" });
    }
    if (!response.ok) throw new Error(`http ${response.status}`);
    const answer = await response.json();
    const data = answer?.req_0?.data;
    if (!data) throw new Error(`musicu: ${answer?.req_0?.code ?? answer?.code ?? "no data"}`);
    return data;
  };

  /** Several `musicu.fcg` calls in one request (each its own `req_i`): the per-song ones, which the site only
   * answers one song at a time. */
  const apiMany = async (requests) => {
    const body = {
      comm: { ct: 24, cv: 0, format: "json", uin: cookie("uin") || "0", guid },
    };
    requests.forEach((request, i) => {
      body[`req_${i}`] = request;
    });
    let response;
    try {
      response = await fetch(FCG, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const url = `${FCG}?format=json&data=${encodeURIComponent(JSON.stringify(body))}`;
      response = await fetch(url, { credentials: "include" });
    }
    if (!response.ok) throw new Error(`http ${response.status}`);
    const answer = await response.json();
    return requests.map((_, i) => answer?.[`req_${i}`] ?? null);
  };

  const byMid = new Map();
  // Each song's own file information: the media mid its sound is named after, and which qualities it has.
  const details = new Map();
  const rememberFile = (raw) => {
    const mid = String(raw?.mid ?? raw?.songmid ?? "");
    if (!mid) return null;
    const file = raw.file ?? {};
    const detail = {
      songId: Number(raw.id) || 0,
      mediaMid: file.media_mid || null,
      best: Number(file.size_320mp3) || 0,
      mp3: Number(file.size_128mp3) || 0,
      aac: Number(file.size_96aac) || 0,
      aacLow: Number(file.size_48aac) || 0,
    };
    details.set(mid, detail);
    return detail;
  };
  /** That information, from the site's own detail call when it isn't known yet (which also names the song). */
  const detailOf = async (mid) => {
    if (details.has(mid)) return details.get(mid);
    try {
      const data = await api("music.pf_song_detail_svr", "get_song_detail_yqq", { song_mid: mid });
      const raw = data?.track_info;
      if (!raw) return null;
      const track = trackFromApi(raw);
      if (track) byMid.set(mid, track);
      return rememberFile(raw);
    } catch (error) {
      log(`detail ${mid}: ${error}`);
      return null;
    }
  };

  const trackFromApi = (raw) => {
    const mid = String(raw.mid ?? raw.songmid ?? "");
    if (!mid) return null;
    const singers = (raw.singer ?? raw.singers ?? []).map((each) => each.name).filter(Boolean);
    if (raw.file) rememberFile(raw);
    return {
      id: `qq:track:${mid}`,
      name: norm(raw.name ?? raw.title ?? mid),
      artist: singers.join(" / "),
      album: norm(raw.album?.name ?? raw.albumname ?? ""),
      albumId: raw.album?.mid ? `qq:album:${raw.album.mid}` : null,
      artistId: raw.singer?.[0]?.mid ? `qq:artist:${raw.singer[0].mid}` : null,
      image: coverOfSong(raw) ?? DEFAULT_IMAGE,
      color: COLOR,
      duration: Number(raw.interval) || 0,
      explicit: Boolean(raw.ov ?? raw.pay?.payplay === 0),
      number: null,
    };
  };

  /** The songs behind these mids, from the site's own track API (one call, kept for the queue). */
  const tracksOf = async (mids) => {
    const unknown = mids.map(String).filter((mid) => mid && !byMid.has(mid));
    for (let at = 0; at < unknown.length; at += 50) {
      const batch = unknown.slice(at, at + 50);
      try {
        const answers = await apiMany(
          batch.map((mid) => ({
            module: "music.pf_song_detail_svr",
            method: "get_song_detail_yqq",
            param: { song_mid: mid },
          })),
        );
        answers.forEach((answer, i) => {
          const raw = answer?.data?.track_info;
          const track = raw ? trackFromApi(raw) : null;
          if (track) byMid.set(batch[i], track);
        });
      } catch (error) {
        log(`tracks: ${error}`);
      }
    }
    // One the site has nothing for: still playable, named by its mid.
    for (const mid of mids.map(String)) {
      if (!byMid.has(mid)) {
        byMid.set(mid, {
          id: `qq:track:${mid}`,
          name: mid,
          artist: "",
          album: "",
          albumId: null,
          artistId: null,
          image: DEFAULT_IMAGE,
          color: COLOR,
          duration: 0,
          explicit: false,
          number: null,
        });
      }
    }
    return mids.map((mid) => byMid.get(String(mid))).filter(Boolean);
  };

  let audio = null;
  let proxy = null;
  const queue = { ids: [], index: 0, context: null, shuffle: false, repeat: "off", urls: new Map() };
  let loading = false;
  let lastPosition = 0;
  // Songs played a second time through the proxy after a host refused them, and songs in a row that failed.
  const retried = new Set();
  let failures = 0;

  const VOLUME_KEY = "westplay.qq.volume";
  let volume = (() => {
    try {
      const raw = localStorage.getItem(VOLUME_KEY);
      const saved = Number(raw);
      return raw !== null && Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 0.8;
    } catch {
      return 0.8;
    }
  })();

  // The hosts that won't play directly (plain http, or a response this page can't take into its sound): every
  // song from one goes through WestPlay's proxy from then on.
  const proxiedHosts = new Set();
  const proxiedUrl = (raw) =>
    `http://127.0.0.1:${proxy.port}/m/${proxy.token}?u=${encodeURIComponent(raw)}`;
  // The quality each song is tried at (a file that isn't there fails, and the next one is asked for).
  const qualities = new Map();

  /** What to ask the site for, best first: 320k mp3, 128k mp3, then the AACs — named after the song's media
   * mid, and only the qualities it has (a file that doesn't exist is a 404, which a player hears as nothing). */
  const filesOf = async (mid) => {
    const detail = await detailOf(mid);
    const name = detail?.mediaMid || mid;
    const list = [];
    if (!detail || detail.best) list.push(["M800", name, ".mp3"]);
    if (!detail || detail.mp3) list.push(["M500", name, ".mp3"]);
    if (!detail || detail.aac) list.push(["C400", name, ".m4a"]);
    if (!detail || detail.aacLow) list.push(["C600", name, ".m4a"]);
    if (list.length === 0) list.push(["M500", name, ".mp3"]);
    return list;
  };

  /** The sound of a song by its mid: the site's vkey, a URL to play it from. Tried directly (https) first; a
   * host that refuses is played through WestPlay's proxy instead, and remembered as one. */
  const urlOf = async (mid) => {
    const known = queue.urls.get(mid);
    if (known && Date.now() < known.expires) return known;
    const files = await filesOf(mid);
    let found = null;
    for (let at = qualities.get(mid) ?? 0; at < files.length; at++) {
      const [prefix, name, suffix] = files[at];
      try {
        const data = await api("vkey.GetVkeyServer", "CgiGetVkey", {
          guid,
          songmid: [mid],
          songtype: [0],
          uin: cookie("uin") || "0",
          loginflag: 1,
          platform: "20",
          filename: [`${prefix}${name}${suffix}`],
        });
        const info = (data.midurlinfo ?? [])[0];
        const purl = info?.purl;
        if (!purl || info.result !== 0) {
          log(`vkey ${prefix} ${mid}: result ${info?.result ?? "?"}`);
          continue;
        }
        const sip = (data.sip ?? []).find((each) => /^https?:/.test(each)) ?? data.sip?.[0] ?? "";
        const raw = `${sip}${purl}`;
        const host = raw.split("/")[2] ?? "";
        const through = Boolean(proxy && proxiedHosts.has(host));
        found = {
          url: through ? proxiedUrl(raw) : raw.replace(/^http:/, "https:"),
          cors: true,
          host,
          raw,
          more: at + 1 < files.length,
          expires: Date.now() + 15 * 60 * 1000,
        };
        log(`vkey ${prefix} ${mid}: ${through ? "proxy" : "direct"} ${host}, ${name}`);
        break;
      } catch (error) {
        log(`vkey ${prefix} ${mid}: ${error}`);
      }
    }
    queue.urls.set(mid, found);
    return found;
  };

  const currentMid = () => queue.ids[queue.index] ?? null;

  /** The station this queue is, by its id: a radio station's songs come from the server, a batch at a time. */
  const stationId = () => {
    const parts = String(queue.context?.id ?? "").split(":");
    return parts[1] === "radio" || parts[1] === "station"
      ? parts.slice(2).join(":")
      : null;
  };

  /** The next batch of a station's songs (`mb_track_radio_svr`): each call is fresh, so a station never runs
   * out — that is what the radar is. `true` when it gave songs the queue didn't have. */
  const extendStation = async () => {
    const id = stationId();
    if (!id) return false;
    try {
      const data = await api("mb_track_radio_svr", "get_radio_track", {
        id: Number(id) || id,
        num: 20,
        firstplay: queue.ids.length > 0 ? 0 : 1,
      });
      const rows = Array.isArray(data.tracks) ? data.tracks : [];
      let grown = false;
      for (const raw of rows) {
        const mid = String(raw?.mid ?? "");
        const track = mid ? trackFromApi(raw) : null;
        if (!track) continue;
        byMid.set(mid, track);
        if (!queue.ids.includes(mid)) {
          queue.ids.push(mid);
          grown = true;
        }
      }
      log(`radio ${id}: ${rows.length} songs, ${grown ? "more" : "nothing new"}`);
      return grown;
    } catch (error) {
      log(`radio ${id}: ${error}`);
      return false;
    }
  };

  const newAudio = () => {
    const element = new Audio();
    element.preload = "auto";
    element.volume = volume;
    element.crossOrigin = "anonymous";
    element.addEventListener("play", () => sayPlayback(true));
    // The cab's way, woken as the sound starts: a page nothing is ever clicked on can find it asleep.
    element.addEventListener("playing", () => {
      sound?.wake?.();
      sayPlayback(true);
    });
    element.addEventListener("pause", () => sayPlayback(true));
    element.addEventListener("loadedmetadata", () => sayPlayback(true));
    element.addEventListener("error", () => {
      loading = false;
      if (audio !== element) return;
      const id = currentMid();
      const way = id ? queue.urls.get(id) : null;
      const host = way?.host ?? String(element.currentSrc || element.src).split("/")[2] ?? "";
      log(`sound failed: ${element.error?.code ?? "?"} (${host})`);
      // One quality's file may be missing from the host (`M800` asked for, `M500` the only one there): the same
      // song at the next one.
      if (way?.more) {
        qualities.set(id, (qualities.get(id) ?? 0) + 1);
        queue.urls.delete(id);
        log(`sound: ${id} at another quality`);
        return void playCurrent();
      }
      // A host that won't play directly (plain http, or a response this page can't take): the same song
      // through the proxy, and every song from that host from now on.
      if (way && proxy && !proxiedHosts.has(host) && !retried.has(id)) {
        proxiedHosts.add(host);
        retried.add(id);
        queue.urls.delete(id);
        log(`sound: ${host} goes through the proxy from now on`);
        sayPlayback(true);
        void playCurrent();
        return;
      }
      sayPlayback(true);
      nextFailed();
    });
    element.addEventListener("timeupdate", () => {
      if (audio !== element) return;
      lastPosition = element.currentTime;
      sayPlayback();
    });
    element.addEventListener("ended", () => {
      if (queue.repeat === "one") {
        element.currentTime = 0;
        element.play().catch(() => {});
        return;
      }
      next();
    });
    return element;
  };

  const playCurrent = async (tried = new Set()) => {
    const mid = currentMid();
    if (!mid) return stop();
    loading = true;
    sayPlayback(true);
    const found = await urlOf(mid);
    if (!found) {
      tried.add(mid);
      const index = nextUntried(tried);
      if (index !== null) {
        queue.index = index;
        return playCurrent(tried);
      }
      loading = false;
      const track = byMid.get(mid) ?? null;
      post({
        playback: track
          ? {
              track,
              context: queue.context,
              playing: false,
              loading: false,
              position: 0,
              duration: track.duration,
              preview: false,
              shuffle: queue.shuffle,
              repeat: queue.repeat,
              volume,
              failed: true,
              next: [],
            }
          : null,
      });
      return null;
    }
    throughCab = Boolean(found.cors);
    log(`sound: ${throughCab ? "cors" : "cross-origin"}, proxy ${proxy ? "on" : "off"}, ${mid}`);
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    audio = newAudio();
    audio.src = found.url;
    lastPosition = 0;
    try {
      await audio.play();
    } catch (error) {
      log(`play: ${error}`);
    }
    const way = sound?.state?.() ?? {};
    log(
      `playing ${mid}: volume ${audio.volume.toFixed(2)}, muted ${audio.muted}, ${Math.round(audio.duration || 0)} s, ` +
        `cab ${way.built ? "built" : "none"}, context ${way.context ?? "?"}, speakers ${way.speakers ?? 0}, ` +
        `head ${Boolean(way.head)}, taking ${Boolean(throughCab && headReady)}`,
    );
    sound?.wake?.();
    void favourOf(mid).then((on) => on !== null && sayPlayback(true));
    failures = 0;
    setTimeout(checkAudible, 5000);
    loading = false;
    sayPlayback(true);
    for (const mid of queue.ids.slice(queue.index + 1, queue.index + 3)) urlOf(mid);
    return mid;
  };

  /** A song whose sound couldn't be had at all: the next one — unless three in a row fail, which is a sign the
   * account may play none of them, and asking again and again would only flicker through the queue. */
  const nextFailed = () => {
    failures += 1;
    if (failures >= 3) {
      failures = 0;
      audio?.pause();
      return sayPlayback(true);
    }
    next();
  };

  const nextUntried = (tried) => {
    const count = queue.ids.length;
    for (let step = 1; step <= count; step++) {
      const at = queue.index + step;
      if (at >= count && queue.repeat !== "all") return null;
      const index = at % count;
      if (!tried.has(queue.ids[index])) return index;
    }
    return null;
  };

  const nextIndex = () => (queue.shuffle && queue.ids.length > 1 ? Math.floor(Math.random() * queue.ids.length) : nextUntried(new Set()));

  const next = () => {
    const index = nextIndex();
    if (index !== null) {
      queue.index = index;
      return playCurrent();
    }
    // A station has no end: the server has more songs, asked for as this batch runs out.
    if (stationId()) {
      const from = queue.ids.length;
      return void extendStation().then((grown) => {
        if (!grown) {
          audio?.pause();
          return sayPlayback(true);
        }
        queue.index = from;
        return playCurrent();
      });
    }
    audio?.pause();
    sayPlayback(true);
  };

  const previous = () => {
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    if (queue.index > 0) {
      queue.index -= 1;
      playCurrent();
    } else if (audio) audio.currentTime = 0;
  };

  const stop = () => {
    audio?.pause();
    if (audio) audio.removeAttribute("src");
    loading = false;
    sayPlayback(true);
  };

  /** A station started from a card: its first batch, and a queue that grows itself as it plays. */
  const startStation = async (id, name) => {
    queue.ids = [];
    queue.index = 0;
    queue.shuffle = false;
    queue.context = { id: `qq:radio:${id}`, name: name ?? "", kind: "station" };
    loading = true;
    sayPlayback(true);
    if (!(await extendStation())) {
      loading = false;
      log(`play: the station ${id} gave no songs`);
      return sayPlayback(true);
    }
    queue.index = 0;
    await playCurrent();
  };

  const setQueue = async ({ ids, index = 0, context = null, shuffle = false }) => {
    if (!ids || ids.length === 0) return;
    queue.ids = ids.map(String);
    queue.index = Math.min(Math.max(0, index), queue.ids.length - 1);
    queue.context = context;
    queue.shuffle = Boolean(shuffle);
    await tracksOf(queue.ids);
    await playCurrent();
  };

  const playbackOf = () => {
    const mid = currentMid();
    if (!mid) return null;
    const track = byMid.get(mid);
    if (!track) return null;
    const upcoming = queue.ids
      .slice(queue.index + 1, queue.index + 6)
      .map((each) => byMid.get(each))
      .filter(Boolean);
    return {
      track,
      context: queue.context,
      playing: Boolean(audio && !audio.paused && !audio.ended),
      loading,
      position: Number.isFinite(audio?.currentTime) ? audio.currentTime : lastPosition,
      duration: track.duration || (Number.isFinite(audio?.duration) ? audio.duration : 0),
      preview: false,
      shuffle: queue.shuffle,
      repeat: queue.repeat,
      volume,
      next: upcoming,
    };
  };

  let playbackAt = 0;
  const sayPlayback = (force = false) => {
    const now = performance.now();
    if (!force && now - playbackAt < 700) return;
    playbackAt = now;
    post({ playback: playbackOf() });
    keepPlaceSoon();
  };

  const sayState = () =>
    post({ state: { signedIn: signedIn(), playing: Boolean(audio && !audio.paused), avatar: avatar() } });

  // The song and where it played, kept: opening WestPlay shows it again, paused (as the other players do).
  const LAST_KEY = "westplay.qq.last";
  let rememberedAt = 0;
  const keepPlace = () => {
    const mid = currentMid();
    if (!mid) return;
    try {
      localStorage.setItem(
        LAST_KEY,
        JSON.stringify({
          ids: queue.ids.slice(0, 200),
          index: queue.index,
          context: queue.context,
          position: Math.max(0, Number(audio?.currentTime) || 0),
        }),
      );
    } catch {}
  };
  const keepPlaceSoon = () => {
    const now = performance.now();
    if (now - rememberedAt < 2000) return;
    rememberedAt = now;
    keepPlace();
  };
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    if (currentMid()) return;
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(LAST_KEY) || "null");
    } catch {}
    const ids = Array.isArray(saved?.ids) ? saved.ids.map(String) : [];
    if (ids.length === 0) return;
    queue.ids = ids;
    queue.index = Math.min(Math.max(0, Number(saved.index) || 0), ids.length - 1);
    queue.context = saved.context ?? null;
    await tracksOf(ids);
    const found = await urlOf(currentMid()).catch(() => null);
    if (found) {
      throughCab = Boolean(found.cors);
      audio = newAudio();
      audio.src = found.url;
      const at = Math.max(0, Number(saved.position) || 0);
      audio.addEventListener("loadedmetadata", () => {
        try {
          audio.currentTime = Math.min(at, Math.max(0, (audio.duration || at) - 1));
        } catch {}
        sayPlayback(true);
      });
    }
    sayPlayback(true);
    log(`restored ${currentMid()} at ${Math.round(Number(saved.position) || 0)}s`);
  };

  // The truck's speakers (cab_sound.js, loaded first): this page's own sound, split to the cab's speakers —
  // once there is a cab to play it (its head known) and the song may be taken into the browser's own graph (a
  // host that refuses CORS lets a song be taken in, and plays it silently once it is). Until both, the song
  // plays as it is rather than not at all.
  let throughCab = false;
  let headReady = false;
  const sound = window.westplayCabSound?.(
    () => (throughCab && headReady ? audio : null),
    post,
  );

  // A song that plays silently: taken into the cab's way but with nothing coming out of it (a context the
  // browser left asleep, a way that couldn't be made). Five seconds in, it is played as it is instead — plainly
  // heard beats not heard — and the log says why (the cab is given up for that song only).
  const checkAudible = () => {
    const element = audio;
    if (!element || audio !== element || element.paused || element.error) return;
    // What was heard five seconds in (a song that runs on silently is read from this line).
    {
      const way = sound?.state?.() ?? {};
      log(
        `heard: ${throughCab && headReady ? `cab level ${way.level ?? "?"}` : "as it is"}, context ${way.context ?? "?"}, room ${way.room ? "on" : "off"}`,
      );
    }
    if (!throughCab || !headReady) return;
    const way = sound?.state?.() ?? {};
    const quiet = way.context !== "running" || !way.built;
    if (!quiet && !(way.level === 0)) return;
    // A quiet passage is not a silent one: two samples before giving the cab up.
    setTimeout(() => {
      if (audio !== element || element.paused) return;
      const now = sound?.state?.() ?? {};
      if (now.context === "running" && now.built && now.level !== 0) return;
      log(
        `sound: the cab plays nothing (context ${now.context}, built ${now.built}, level ${now.level}); playing it as it is`,
      );
      throughCab = false;
      const at = element.currentTime;
      const src = element.currentSrc || element.src;
      try {
        element.pause();
      } catch {}
      if (!src) return;
      audio = newAudio();
      audio.src = src;
      audio.addEventListener(
        "loadedmetadata",
        () => {
          try {
            audio.currentTime = Math.max(0, at);
          } catch {}
          audio.play().catch((error) => log(`dry resume: ${error}`));
        },
        { once: true },
      );
    }, 700);
  };

  const CAB = {
    speakers: (data) => sound?.speakers(data.speakers, data.cabin),
    head: (data) => {
      headReady = true;
      sound?.head(data);
    },
    outside: (data) => sound?.outside(data.on, data.distance),
    equalizer: (data) => sound?.equalizer(data),
    reflections: (data) => sound?.reflections(data),
    limiter: (data) => sound?.limiter(data),
    spectrum: (data) => sound?.spectrum(data.on),
  };

  // Whether each song is in 我喜欢. The answer is membership of the account's real liked-songs list (the
  // official client shows the same one), so a song already there starts lit and a lit star is never a guess.
  const favours = new Map();
  const favourOf = async (mid) => {
    if (!mid) return null;
    if (favours.has(mid)) return favours.get(mid);
    try {
      const list = await loadLiked();
      if (!list) return null;
      const on = list.mids.has(mid);
      favours.set(mid, on);
      const track = byMid.get(mid);
      if (track) track.favorite = on;
      return on;
    } catch (error) {
      log(`favourite check ${mid}: ${error}`);
      return null;
    }
  };

  /** 我喜欢: the song put in (or taken out). The write goes through the site's own signed request (an
   * unsigned musicu call answers retCode 0 without touching the account). Afterwards the real liked list
   * is refetched and the star follows what actually landed — a write that did not take rolls the star back. */
  const favorite = async (mid, on) => {
    const detail = await detailOf(mid);
    const songId = Number(detail?.songId);
    if (!songId) {
      log(`favorite ${mid}: no song id`);
      return false;
    }
    try {
      const request = await requestApi();
      const response = await within(
        request([
          {
            module: "music.musicasset.PlaylistDetailWrite",
            method: on ? "AddSonglist" : "DelSonglist",
            param: { dirId: 201, v_songInfo: [{ songId, songType: 0 }] },
          },
        ]),
        15000,
        "QQ Music favorite timed out",
      );
      const answer = response?.[0];
      log(`favorite ${mid} ${on ? "add" : "del"}: code ${answer?.code}, retCode ${answer?.data?.result?.retCode ?? "?"}`);
    } catch (error) {
      log(`favorite ${mid}: ${error}`);
      return false;
    }
    // What the account shows now, refetched: the star takes its state from this, not from the write's word.
    liked = null;
    favours.delete(mid);
    const list = await loadLiked();
    const now = list ? list.mids.has(mid) : null;
    if (now === null) log(`favorite ${mid}: could not confirm`);
    else if (now !== on) log(`favorite ${mid}: not ${on ? "added" : "removed"} (list still says ${now})`);
    const final = now ?? on;
    favours.set(mid, final);
    const track = byMid.get(mid);
    if (track) track.favorite = final;
    sayPlayback(true);
    return final === on;
  };

  const setVolume = (share) => {
    volume = Math.min(1, Math.max(0, share));
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {}
    if (audio) audio.volume = volume;
    sayPlayback(true);
  };

  window.chrome?.webview?.addEventListener("message", ({ data }) => {
    if (!data) return;
    // Two pages, one job each: this one is only the data when it's the browse page (its own player is nowhere in
    // it), and the sound when it's the player page (which never navigates, so the sound never stops).
    if (role === "browse") {
      if (data.action === "ask") return void ask(data.id, data.question);
      return;
    }
    if (CAB[data.action]) return CAB[data.action](data);
    const action = data.action;
    if (action === "proxy" && Number(data.port) && data.token) {
      proxy = { port: Number(data.port), token: String(data.token) };
      return;
    }
    if (action === "start") {
      sayState();
      sayPlayback();
      void restore();
      return;
    }
    if (action === "ask") return void ask(data.id, data.question);
    if (action === "play") {
      if (!data.id && !data.songs) {
        if (audio?.paused) audio.play().catch((error) => log(`resume: ${error}`));
        return;
      }
      const ids = (data.songs ?? []).map((each) => String(each).split(":").pop());
      const context = data.id ? { id: data.id, name: data.name ?? "", kind: data.kind ?? "playlist" } : null;
      // The songs as the app shows them, so their names, players and covers are there before the sound is.
      if (Array.isArray(data.tracks)) {
        for (const track of data.tracks) {
          const mid = String(track?.id ?? "").split(":").pop();
          if (mid) byMid.set(mid, { ...track, color: track.color ?? COLOR, image: track.image ?? DEFAULT_IMAGE });
        }
      }
      (async () => {
        if (ids.length > 0) return setQueue({ ids, index: data.index ?? 0, context, shuffle: data.shuffle });
        // A card pressed: a song plays on its own; a collection the app already shows a list of travels with it.
        const parts = String(data.id ?? "").split(":");
        const mid = parts.slice(2).join(":");
        if ((parts[1] === "track" || parts[1] === "song") && mid) {
          // A song picked in Search (`insert`): it plays now, before the queue's own next song, and the queue
          // carries on after it; the app keeps showing that queue, so nothing of it is replaced.
          if (data.insert && queue.ids.length > 0) {
            await tracksOf([mid]);
            queue.ids.splice(queue.index + 1, 0, mid);
            queue.index += 1;
            return playCurrent();
          }
          return setQueue({ ids: [mid], index: 0, context: null, shuffle: data.shuffle });
        }
        // A station: its first batch from the radio API, then a queue that grows as it plays.
        if ((parts[1] === "radio" || parts[1] === "station") && mid) {
          return startStation(mid, data.name);
        }
        log(`play: nothing to play for ${data.id}`);
      })().catch((error) => log(`play: ${error}`));
      return;
    }
    if (action === "favorite") {
      const id = String(data.id ?? "").split(":").pop();
      return void favorite(id, Boolean(data.on));
    }
    if (action === "pause") return stop();
    if (action === "next") return next();
    if (action === "previous") return previous();
    if (action === "seek") {
      const at = Number(data.seconds) || 0;
      if (audio) audio.currentTime = Math.max(0, at);
      sayPlayback(true);
      return;
    }
    if (action === "volume") return setVolume((Number(data.percent) || 0) / 100);
    if (action === "shuffle") {
      queue.shuffle = Boolean(data.on);
      // Shuffle and the loop modes are one setting: turning shuffle on leaves the loop (the list plays
      // through once, in a random order), so the two can't be lit at once.
      if (queue.shuffle) queue.repeat = "off";
      sayPlayback(true);
      return;
    }
    if (action === "repeat") {
      queue.repeat = data.mode === "one" || data.mode === "all" ? data.mode : "off";
      // And turning the loop on leaves the shuffle.
      queue.shuffle = false;
      sayPlayback(true);
      return;
    }
    if (action === "jump") {
      const index = queue.index + (Number(data.offset) || 0);
      if (index >= 0 && index < queue.ids.length) {
        queue.index = index;
        playCurrent();
      }
      return;
    }
  });

  window.addEventListener("pagehide", keepPlace);
  if (role === "player") {
    setInterval(sayState, 1500);
    setInterval(() => sound?.tick(), 250);
    sayState();
  }
  setInterval(() => post({ heartbeat: true }), 1000);
  post({ ready: true });
  log("ready");
})();
