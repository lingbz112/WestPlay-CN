// NetEase Cloud Music, in its own web page (netease_music.rs). The copied Music app is WestPlay's face;
// this script is its engine: it asks music.163.com's own JSON APIs for what the app shows, and plays
// what the app plays in an <audio> of its own on the truck's speakers (cab_sound.js, loaded first).
//
// The APIs are the site's plain ones (no weapi/eapi signing): the page is music.163.com's own, so the
// browser sends its cookies and Referer, and the account's rights (VIP, grey songs) apply as they do
// in its player. Nothing of the account leaves the page; only what the app shows is said to the host.
//
// A song plays from a URL the site gives (`/api/song/enhance/player/url/v1`). A song without one (no
// rights, no source) doesn't play: the app says so. A song with a 30-second trial plays its trial and
// says `preview` (the app shows the note).
(() => {
  if (!/(^|\.)music\.163\.com$/.test(location.hostname)) return;
  const post = (message) => window.chrome?.webview?.postMessage(message);
  const log = (line) => post({ log: String(line).slice(0, 380) });

  const ORIGIN = "https://music.163.com";
  const SONG_DETAIL_MOST = 400;
  const LEVELS = ["exhigh", "standard"];

  // --- The site's own APIs -----------------------------------------------------------------------------

  const query = (params) =>
    Object.entries(params)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
      .join("&");

  const getJson = async (path, params = {}) => {
    const address = `${ORIGIN}${path}${params && Object.keys(params).length ? `?${query(params)}` : ""}`;
    const response = await fetch(address, { credentials: "include", cache: "no-store" });
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    return response.json();
  };

  const postForm = async (path, body) => {
    const response = await fetch(`${ORIGIN}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: query(body),
    });
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    return response.json();
  };

  const csrf = () => (document.cookie.match(/__csrf=([^;]+)/) || [])[1] || "";
  const https = (url) => (typeof url === "string" ? url.replace(/^http:/, "https:") : null);
  const seconds = (milliseconds) => (Number.isFinite(milliseconds) ? milliseconds / 1000 : 0);

  /** A colour for a cover, from its id: the app washes pages in it (NetEase's images carry no colour). */
  const colorOf = (id) => {
    let hash = 0;
    for (const character of String(id)) hash = (hash * 31 + character.charCodeAt(0)) % 360;
    return `hsl(${hash} 42% 24%)`;
  };

  const artistNames = (song) => {
    const artists = song.ar ?? song.artists ?? [];
    return artists.map((artist) => artist.name).filter(Boolean).join(" / ");
  };
  const albumOf = (song) => song.al ?? song.album ?? {};
  const coverOf = (song) => https(albumOf(song).picUrl ?? albumOf(song).blurPicUrl ?? null);
  const durationOf = (song) => seconds(song.dt ?? song.duration ?? 0);

  /** A card's or row's id, by what it is: `playlist:123`, `album:456`, `artist:789`, `station:…`. */
  const itemId = (kind, id) => `${kind}:${id}`;

  const itemOf = ({ kind, id, name, by = "", note = "", image = null, wide = null, color = null, explicit = false, live = false, label = null }) => ({
    id: itemId(kind, id),
    kind,
    name: String(name ?? ""),
    by: String(by ?? ""),
    note: String(note ?? "").slice(0, 160),
    image: https(image),
    wide: https(wide),
    color: color ?? colorOf(id),
    explicit: Boolean(explicit),
    live: Boolean(live),
    ...(label ? { label } : {}),
  });

  const trackOf = (song) => {
    const album = albumOf(song);
    const artists = song.ar ?? song.artists ?? [];
    return {
      id: `track:${song.id}`,
      name: String(song.name ?? ""),
      artist: artistNames(song),
      album: String(album.name ?? ""),
      albumId: album.id ? itemId("album", album.id) : null,
      artistId: artists[0]?.id ? itemId("artist", artists[0].id) : null,
      image: coverOf(song),
      color: colorOf(song.id),
      duration: durationOf(song),
      explicit: false,
      vip: Number(song.fee) === 1,
      noSource: false,
      number: Number.isFinite(song.no) ? song.no : null,
    };
  };

  /** Songs by id, in the order asked, in batches (the site takes a hundred at a time); kept for the queue. */
  const tracks = new Map();
  const remember = (list) => {
    for (const track of list) tracks.set(track.id, track);
    return list;
  };
  const songsByIds = async (ids) => {
    const songs = [];
    let failures = 0;
    for (let start = 0; start < ids.length; start += SONG_DETAIL_MOST) {
      const batch = ids.slice(start, start + SONG_DETAIL_MOST);
      try {
        const answer = await getJson("/api/v1/song/detail", { ids: JSON.stringify(batch) });
        const found = new Map((answer.songs ?? []).map((song) => [String(song.id), song]));
        for (const id of batch) {
          const song = found.get(String(id));
          if (song) songs.push(trackOf(song));
        }
      } catch (error) {
        failures++;
        log(`songs: ${error}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    if (songs.length === 0 && failures > 0) throw new Error("the songs couldn't be read");
    return remember(songs);
  };
  const tracksByIds = async (ids) => {
    const wanted = ids.map((id) => `track:${id}`);
    const missing = ids.filter((id) => !tracks.has(`track:${id}`));
    if (missing.length) await songsByIds(missing);
    return wanted.map((id) => tracks.get(id)).filter(Boolean);
  };

  // What a song's own player says of it: playable, VIP's (no URL without its rights), or no source at all.
  const marksOf = async (ids) => {
    const marks = new Map();
    const list = ids.map(String);
    for (let start = 0; start < list.length; start += 50) {
      try {
        const answer = await getJson("/api/song/enhance/player/url/v1", {
          ids: JSON.stringify(list.slice(start, start + 50)),
          level: "standard",
          encodeType: "mp3",
        });
        for (const item of answer.data ?? []) {
          const id = String(item.id);
          if (!item.url && Number(item.fee) !== 1) marks.set(id, "none");
        }
      } catch (error) {
        log(`marks: ${error}`);
        break;
      }
    }
    return marks;
  };

  /** The first songs of a list marked 无音源 where the site has no source for them. */
  const marked = async (list, most = 200) => {
    const marks = await marksOf(list.slice(0, most).map((track) => track.id.split(":")[1]));
    if (marks.size === 0) return list;
    return list.map((track) => (marks.get(track.id.split(":")[1]) === "none" ? { ...track, noSource: true } : track));
  };

  const section = (title, style, items = [], songs = []) => ({ title, style, items, songs });

  // --- The account -------------------------------------------------------------------------------------

  let signedIn = false;
  let avatar = null;
  let uid = null;
  // Its id is kept between runs: the account's own list isn't asked for it again (and its request is easy to
  // be refused when the site is busy).
  let likedPlaylistId = (() => {
    try {
      return localStorage.getItem("westplay.netease.liked");
    } catch {
      return null;
    }
  })();
  let liked = new Set();
  let accountAt = 0;

  const saveLikedId = () => {
    try {
      if (likedPlaylistId) localStorage.setItem("westplay.netease.liked", String(likedPlaylistId));
    } catch {}
  };

  const checkAccount = async (force = false) => {
    if (!force && Date.now() - accountAt < 6000) return signedIn;
    accountAt = Date.now();
    try {
      const answer = await getJson("/api/nuser/account/get");
      const account = answer.account ?? null;
      const profile = answer.profile ?? {};
      signedIn = Boolean(account);
      uid = account ? account.id : null;
      avatar = signedIn ? https(profile.avatarUrl ?? null) : null;
      if (signedIn && !likedPlaylistId) await findLikedPlaylist();
      else if (signedIn && liked.size === 0) await loadLiked();
    } catch (error) {
      log(`account: ${error}`);
    }
    sayState();
    return signedIn;
  };

  const findLikedPlaylist = async () => {
    if (!uid) return;
    try {
      const answer = await getJson("/api/user/playlist", { uid, limit: 1000, offset: 0 });
      const playlists = answer.playlist ?? [];
      const mine = playlists.find((playlist) => playlist.specialType === 5);
      if (mine) {
        likedPlaylistId = mine.id;
        saveLikedId();
        await loadLiked();
      }
    } catch (error) {
      log(`playlists: ${error}`);
    }
  };

  const loadLiked = async (force = false) => {
    if (!likedPlaylistId) return;
    if (!force && liked.size > 0) return;
    try {
      const answer = await getJson("/api/v1/playlist/detail", { id: likedPlaylistId, n: 1, s: 0 });
      const playlist = answer.playlist ?? {};
      liked = new Set((playlist.trackIds ?? []).map((track) => String(track.id)));
    } catch (error) {
      log(`liked: ${error}`);
    }
  };

  // --- What the app asks ---------------------------------------------------------------------------------

  const playlistTracks = async (id) => {
    try {
      const answer = await getJson("/api/v1/playlist/detail", { id, n: 1000, s: 0 });
      const playlist = answer.playlist ?? {};
      const ids = (playlist.trackIds ?? []).map((track) => track.id);
      return { playlist, ids };
    } catch (error) {
      // The older page's own answer, should the newer one be refused.
      log(`playlist: ${error}`);
      const legacy = await getJson("/api/playlist/detail", { id });
      const playlist = legacy.result ?? {};
      const tracks = playlist.tracks ?? [];
      return { playlist, ids: tracks.map((track) => track.id) };
    }
  };

  const collectionAnswer = async (id) => {
    const [kind, key] = String(id).split(":");
    if (kind === "playlist" && key === "daily") {
      const answer = await getJson("/api/v1/discovery/recommend/songs", { limit: 30 });
      const tracks = (answer.recommend ?? answer.data ?? []).map(trackOf);
      return {
        item: itemOf({ kind: "playlist", id: "daily", name: "每日推荐", by: "根据你的口味", image: tracks[0]?.image, color: "#8a1f1f" }),
        description: "",
        genre: "",
        year: null,
        tracks,
      };
    }
    if (kind === "album") {
      const answer = await getJson(`/api/v1/album/${encodeURIComponent(key)}`);
      const album = answer.album ?? {};
      const songs = await marked((answer.songs ?? []).map(trackOf), 40);
      const published = album.publishTime ? new Date(album.publishTime).getFullYear() : null;
      return {
        item: itemOf({
          kind: "album",
          id: key,
          name: album.name,
          by: (album.artists ?? []).map((artist) => artist.name).join(" / "),
          note: album.description || "",
          image: album.picUrl,
        }),
        description: String(album.description ?? "").slice(0, 600),
        genre: "",
        year: published,
        tracks: songs,
      };
    }
    if (kind === "playlist" || kind === "station") {
      const { playlist, ids } = await playlistTracks(key);
      const tracks = await marked(await songsByIds(ids), 40);
      return {
        item: itemOf({
          kind: kind === "station" ? "station" : "playlist",
          id: key,
          name: playlist.name,
          by: playlist.creator?.nickname ?? "",
          note: playlist.description || "",
          image: playlist.coverImgUrl,
        }),
        description: String(playlist.description ?? "").slice(0, 600),
        genre: "",
        year: null,
        tracks,
      };
    }
    throw new Error(`not a collection: ${id}`);
  };

  const artistAnswer = async (id) => {
    const key = String(id).split(":")[1] ?? id;
    const answer = await getJson(`/api/v1/artist/${encodeURIComponent(key)}`);
    const artist = answer.artist ?? {};
    const albums = await getJson(`/api/artist/albums/${encodeURIComponent(key)}`, { limit: 24 });
    const items = (albums.hotAlbums ?? []).map((album) =>
      itemOf({
        kind: "album",
        id: album.id,
        name: album.name,
        by: artist.name ?? "",
        note: album.artist?.name ?? "",
        image: album.picUrl,
      }),
    );
    return {
      item: itemOf({ kind: "artist", id: key, name: artist.name, by: artist.briefDesc ?? "", note: artist.briefDesc ?? "", image: artist.picUrl }),
      top: (answer.hotSongs ?? []).map(trackOf),
      sections: [section("专辑", "shelf", items)],
    };
  };

  // The site stops answering searches asked again and again from one account ("操作频繁", a `code` its
  // answers carry rather than an error), and the app asks as the field is typed: its questions are kept
  // for the session, asked one at a time with a pause between, and only the newest one matters — a
  // question overtaken by the next one is left unanswered, which the field doesn't show anyway.
  const searched = new Map();
  const SEARCHES_KEPT = 30;
  const SEARCH_KEPT_MS = 10 * 60 * 1000;
  /** The newest search asked: an older one, overtaken, stops. */
  let searchNewest = 0;
  /** When the site was last asked: its search calls are spaced, one after the other. */
  let searchAsked = 0;
  let searchQueue = Promise.resolve();

  const searchPause = (gap) => {
    searchQueue = searchQueue.then(async () => {
      const wait = Math.max(0, searchAsked + gap - Date.now());
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      searchAsked = Date.now();
    });
    return searchQueue;
  };

  /** The site's search, the web page's own first (it takes pinyin where the page does), the older one next. */
  const searchJson = async (type, text) => {
    for (const path of ["/api/cloudsearch/pc", "/api/search/get"]) {
      await searchPause(500);
      try {
        const answer = await getJson(path, { s: text, type, limit: 24, offset: 0 });
        if (Number(answer.code) === 200) return answer;
        log(`search ${type} ${path}: ${answer.code} ${answer.msg ?? ""}`);
      } catch (error) {
        log(`search ${type} ${path}: ${error}`);
      }
    }
    return null;
  };

  /** An artist's picture, kept as it comes: a search's card takes it (its songs carry none). */
  const artistPictures = new Map();
  const artistPicture = async (id) => {
    const key = String(id);
    if (artistPictures.has(key)) return artistPictures.get(key);
    let picture = null;
    try {
      await searchPause(400);
      const answer = await getJson(`/api/v1/artist/${encodeURIComponent(key)}`);
      picture = https(answer.artist?.picUrl ?? answer.artist?.img1v1Url ?? null);
    } catch (error) {
      log(`artist picture: ${error}`);
    }
    artistPictures.set(key, picture);
    return picture;
  };

  const searchAnswer = async (queryText) => {
    const text = String(queryText ?? "").trim();
    const empty = { top: [], songs: [], artists: [], albums: [], playlists: [], stations: [] };
    if (!text) return empty;
    const kept = searched.get(text);
    if (kept && Date.now() < kept.at + SEARCH_KEPT_MS) return kept.answer;
    const mine = ++searchNewest;
    let failure = null;
    // A refused search (the site busy) is asked again once, after a moment. One question per search —
    // the artist the site would be asked about in a second one is read off the songs found, whose artists'
    // pictures are kept as they come, so a search is a single request of the site's search.
    const ask = async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (mine !== searchNewest) throw new Error("superseded");
        const answer = await searchJson(1, text);
        if (answer) return answer;
        failure = new Error("search refused");
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      return { result: {} };
    };
    const songs = await ask();
    const found = songs.result?.songs ?? [];
    const trackList = await marked(found.map(trackOf));
    // Only what the cab shows: the artist's card, and their songs.
    const seen = new Map();
    for (const song of found) {
      const artist = (song.ar ?? song.artists ?? [])[0];
      if (artist?.id && !seen.has(String(artist.id))) seen.set(String(artist.id), artist);
    }
    const artistList = [];
    for (const artist of [...seen.values()].slice(0, 2)) {
      artistList.push(
        itemOf({
          kind: "artist",
          id: artist.id,
          name: artist.name,
          by: (artist.alias ?? []).join(" / "),
          image: await artistPicture(artist.id),
        }),
      );
    }
    log(`search: ${trackList.length} songs, ${artistList.length} artists`);
    if (trackList.length === 0 && artistList.length === 0 && failure) throw failure;
    const answer = {
      top: artistList.slice(0, 2),
      songs: trackList,
      artists: [],
      albums: [],
      playlists: [],
      stations: [],
    };
    if (trackList.length > 0 || artistList.length > 0) {
      if (searched.size >= SEARCHES_KEPT) searched.delete(searched.keys().next().value);
      searched.set(text, { at: Date.now(), answer });
    }
    return answer;
  };

  const playlistItems = (playlists) =>
    playlists.map((playlist) =>
      itemOf({
        kind: "playlist",
        id: playlist.id,
        name: playlist.name,
        by: playlist.creator?.nickname || playlist.copywriter || "",
        note: playlist.copywriter || playlist.description || "",
        image: playlist.coverImgUrl,
      }),
    );

  const albumItems = (albums) =>
    albums.map((album) =>
      itemOf({
        kind: "album",
        id: album.id,
        name: album.name,
        by: (album.artists ?? []).map((artist) => artist.name).join(" / ") || album.artist?.name || "",
        image: album.picUrl,
      }),
    );

  const topSongs = async (playlistId, most = 12) => {
    try {
      const answer = await getJson("/api/playlist/detail", { id: playlistId });
      const playlist = answer.result ?? answer.playlist ?? {};
      return (playlist.tracks ?? []).slice(0, most).map(trackOf);
    } catch (error) {
      log(`top songs: ${error}`);
      return [];
    }
  };

  const homeAnswer = async () => {
    const sections = [];
    await checkAccount();
    // The first row: the private roam (a radio that plays at once, no list) and the daily picks, as two cards.
    const fm = await getJson("/api/v1/radio/get", { limit: 3 }).catch(() => ({ data: [] }));
    const fmSongs = (fm.data ?? []).map(trackOf);
    let dailySongs = [];
    let resources = [];
    if (signedIn) {
      const [recommended, recommendedResources] = await Promise.all([
        getJson("/api/v1/discovery/recommend/songs", { limit: 20 }).catch(() => ({ recommend: [] })),
        getJson("/api/v1/discovery/recommend/resource").catch(() => ({ recommend: [] })),
      ]);
      dailySongs = (recommended.recommend ?? recommended.data ?? []).map(trackOf);
      resources = recommendedResources.recommend ?? [];
    }
    const hero = [];
    if (fmSongs.length > 0) {
      hero.push(
        itemOf({
          kind: "station",
          id: "fm",
          name: "私人漫游",
          by: "无限电台",
          image: fmSongs[0].image,
          wide: fmSongs[0].image,
          color: "#243b55",
        }),
      );
    }
    if (dailySongs.length > 0) {
      hero.push(
        itemOf({
          kind: "playlist",
          id: "daily",
          name: "每日推荐",
          by: "根据你的口味",
          image: dailySongs[0].image,
          wide: dailySongs[0].image,
          color: "#8a1f1f",
        }),
      );
    }
    if (hero.length > 0) sections.push(section("", "hero", hero));
    if (!signedIn) {
      const hot = await getJson("/api/playlist/list", { cat: "全部", order: "hot", limit: 18, offset: 0 }).catch(() => ({ playlists: [] }));
      resources = hot.playlists ?? [];
    }
    if (resources.length > 0) sections.push(section("推荐歌单", "shelf", playlistItems(resources)));
    const albums = await getJson("/api/album/new", { area: "ALL", limit: 12 }).catch(() => ({ albums: [] }));
    sections.push(section("新碟上架", "shelf", albumItems(albums.albums ?? [])));
    const rising = await topSongs(19723756, 10);
    if (rising.length) sections.push(section("飙升榜", "songs", [], rising));
    return { sections };
  };

  const newAnswer = async () => {
    const sections = [];
    const [songs, albums] = await Promise.all([
      getJson("/api/v1/discovery/new/songs", { area: "ALL", limit: 30 }).catch(() => ({ data: [] })),
      getJson("/api/album/new", { area: "ALL", limit: 18 }).catch(() => ({ albums: [] })),
    ]);
    const tracks = (songs.data ?? songs.songs ?? []).map(trackOf);
    if (tracks.length) sections.push(section("新歌", "songs", [], tracks));
    sections.push(section("新碟", "shelf", albumItems(albums.albums ?? [])));
    const chart = await topSongs(3779629, 10);
    if (chart.length) sections.push(section("新歌榜", "songs", [], chart));
    return { sections };
  };

  const CHARTS = [
    { id: 19723756, name: "飙升榜", note: "每天更新" },
    { id: 3779629, name: "新歌榜", note: "每天更新" },
    { id: 2884035, name: "原创榜", note: "每周四更新" },
    { id: 3778678, name: "热歌榜", note: "每天更新" },
    { id: 180106, name: "UK排行榜周榜", note: "每天更新" },
    { id: 60198, name: "美国Billboard榜", note: "每周三更新" },
    { id: 60131, name: "日本Oricon榜", note: "每天更新" },
    { id: 71384707, name: "网易云古典榜", note: "每周四更新" },
    { id: 1978921795, name: "网易云电音榜", note: "每周五更新" },
    { id: 5059633707, name: "网易云摇滚榜", note: "每周五更新" },
    { id: 5059661515, name: "网易云民谣榜", note: "每周五更新" },
    { id: 5059644681, name: "网易云日语榜", note: "每周二更新" },
  ];

  const radioAnswer = async () => {
    const station = (chart) => ({
      ...itemOf({ kind: "station", id: chart.id, name: chart.name, by: chart.note, note: chart.note }),
      id: itemId("station", chart.id),
    });
    const pick = (ids) => station(CHARTS.find((chart) => chart.id === ids));
    return {
      sections: [
        section("云音乐特色榜", "shelf", [19723756, 3779629, 2884035, 3778678].map(pick)),
        section("全球媒体榜", "shelf", CHARTS.slice(4).map(station)),
      ],
    };
  };

  const browseAnswer = async () => {
    const catalogue = await getJson("/api/playlist/catalogue");
    const all = catalogue.all ?? null;
    const categories = (catalogue.sub ?? []).map((each) =>
      itemOf({ kind: "curator", id: each.name, name: each.name, by: `${each.resourceCount ?? 0} 个歌单` }),
    );
    return all ? [itemOf({ kind: "curator", id: all.name, name: all.name, by: `${all.resourceCount ?? 0} 个歌单` }), ...categories] : categories;
  };

  const curatorAnswer = async (id) => {
    const name = String(id).split(":").slice(1).join(":") || "全部";
    const answer = await getJson("/api/playlist/list", { cat: name, order: "hot", limit: 30, offset: 0 });
    return { sections: [section(name, "shelf", playlistItems(answer.playlists ?? []))] };
  };

  const libraryAnswer = async (shelf) => {
    await checkAccount();
    if (!signedIn) return { items: [], songs: [], sorts: [], sort: null };
    if (shelf === "songs") {
      await loadLiked();
      const ids = [...liked];
      const songs = await marked(await songsByIds(ids), 40);
      return { items: [], songs: songs.map((song) => ({ ...song, favorite: true })), sorts: [{ id: "default", label: "默认" }], sort: "default" };
    }
    if (shelf === "playlists") {
      const answer = await getJson("/api/user/playlist", { uid, limit: 1000, offset: 0 });
      return { items: playlistItems((answer.playlist ?? []).filter((playlist) => playlist.specialType !== 5)), songs: [], sorts: [{ id: "default", label: "默认" }], sort: "default" };
    }
    if (shelf === "albums") {
      const answer = await getJson("/api/album/sublist", { limit: 100, offset: 0 });
      return {
        items: (answer.data ?? []).map((album) =>
          itemOf({ kind: "album", id: album.id, name: album.name, by: album.artists?.map((artist) => artist.name).join(" / ") ?? "", image: album.picUrl }),
        ),
        songs: [],
        sorts: [],
        sort: null,
      };
    }
    if (shelf === "artists") {
      const answer = await getJson("/api/artist/sublist", { limit: 100, offset: 0 });
      return {
        items: (answer.data ?? []).map((artist) =>
          itemOf({ kind: "artist", id: artist.id, name: artist.name, by: artist.alias?.join(" / ") ?? "", image: artist.picUrl }),
        ),
        songs: [],
        sorts: [],
        sort: null,
      };
    }
    if (shelf === "podcasts") {
      // The site's subscribed podcasts: its plain APIs don't serve them; as far as they answer, show them.
      for (const path of ["/api/djradio/mysublist", "/api/djradio/subscribed"]) {
        try {
          const answer = await postForm(path, { limit: 100, offset: 0 });
          const radios = answer.data ?? answer.djRadios ?? [];
          if (radios.length > 0) {
            return {
              items: radios.map((radio) =>
                itemOf({ kind: "playlist", id: `djradio:${radio.id}`, name: radio.name, by: radio.dj?.nickname ?? "", image: radio.picUrl }),
              ),
              songs: [],
              sorts: [],
              sort: null,
            };
          }
        } catch {}
      }
      return { items: [], songs: [], sorts: [], sort: null };
    }
    return { items: [], songs: [], sorts: [], sort: null };
  };

  /** LRC (with the site's translation, line for line) as the app's words. */
  const lyricAnswer = async (id) => {
    const key = String(id).split(":")[1] ?? String(id);
    const answer = await getJson("/api/song/lyric", { id: key, lv: -1, kv: -1, tv: -1 });
    const original = String(answer.lrc?.lyric ?? "");
    const translation = String(answer.tlyric?.lyric ?? "");
    if (!original.trim()) return { synced: false, lines: [], provider: "网易云音乐" };
    const parse = (lrc) => {
      const lines = [];
      for (const raw of lrc.split(/\r?\n/)) {
        const match = raw.match(/^\[(\d+):(\d+)(?:[.:](\d+))?\]\s*(.*)$/);
        if (!match) continue;
        const start = Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] ?? 0}`) * (match[3] ? 1 : 0);
        const text = String(match[4] ?? "").trim();
        lines.push({ start: Number.isFinite(start) ? start : 0, text });
      }
      return lines;
    };
    const lyrics = parse(original);
    const translated = parse(translation);
    const mapped = lyrics.map((line, index) => {
      const other = translated[index];
      const text = other && Math.abs(other.start - line.start) < 0.6 && other.text ? `${line.text} / ${other.text}` : line.text;
      return { start: line.start, end: 0, text, stanza: line.text === "" };
    });
    const timed = mapped.filter((line) => line.start > 0 || line.text);
    for (let index = 0; index < timed.length; index++) {
      const next = timed[index + 1];
      timed[index].end = next ? Math.max(timed[index].start, next.start) : 0;
    }
    return { synced: true, lines: timed, provider: "网易云音乐" };
  };

  const ask = async (id, question) => {
    try {
      const name = question?.ask;
      let answer = null;
      if (name === "home") answer = await homeAnswer();
      else if (name === "new") answer = await newAnswer();
      else if (name === "radio") answer = await radioAnswer();
      else if (name === "browse") answer = await browseAnswer();
      else if (name === "curator") answer = await curatorAnswer(question.id);
      else if (name === "search") answer = await searchAnswer(question.query);
      else if (name === "collection") answer = await collectionAnswer(question.id);
      else if (name === "artist") answer = await artistAnswer(question.id);
      else if (name === "library") answer = await libraryAnswer(question.shelf);
      else if (name === "lyrics") answer = await lyricAnswer(question.id);
      if (answer === null) throw new Error(`unknown question: ${name}`);
      post({ answer: id, [name]: answer });
    } catch (error) {
      log(`ask ${question?.ask}: ${error}`);
      post({ answer: id, failed: true });
    }
  };

  // --- The player ---------------------------------------------------------------------------------------

  // A new element for every song: an element reloaded with another cross-origin source is refused by some
  // engines (Edge's WebView2), and the truck's speakers take whichever element plays now.
  let audio = null;
  let volume = 0.8;
  // Where the host fetches the songs whose hosts refuse the page its sound (given with `action: "proxy"`).
  let proxy = null;
  // The driver's head is known (the game's telemetry): until then the truck's speakers don't take the sound,
  // which would leave it silent while they wait for a head to place it from (the page's own sound until then).
  let headReady = false;
  // The playing song's host allows the page its sound (its own sound-field), or plays as the element's own.
  let throughCab = true;

  // The truck's speakers (cab_sound.js, loaded first): the playing element's sound, split to the cab's speakers.
  const cab = window.westplayCabSound?.(() => (headReady && throughCab ? audio : null), post);
  if (cab) setInterval(() => cab.tick(), 250);

  const CAB = {
    speakers: (data) => cab?.speakers(data.speakers),
    head: (data) => {
      headReady = true;
      cab?.head(data);
    },
    outside: (data) => cab?.outside(data.on, data.distance),
    equalizer: (data) => {
      cab?.equalizer(data);
      cab?.reverb(data.reverb);
      cab?.character(data.character);
      cab?.reflection(data.reflection);
      cab?.bass(data.bass);
    },
    spectrum: (data) => cab?.spectrum(data.on),
  };

  const queue = {
    ids: [],
    index: 0,
    context: null,
    shuffle: false,
    repeat: "off",
    loading: false,
    urls: new Map(),
    trial: null,
  };

  let lastPosition = 0;

  // The song behind an id, from what was fetched before (a page's list, the queue).
  const trackOfId = async (id) => (await tracksByIds([String(id)]))[0] ?? null;

  // Some of the site's media hosts don't allow the page's scripts their sound (`Access-Control-Allow-Origin`);
  // those play as the element's own (no convoi's sound-field), rather than not at all.
  const supportsCors = async (url) => {
    try {
      const response = await fetch(url, { headers: { Range: "bytes=0-1" }, cache: "no-store" });
      return response.ok || response.status === 206;
    } catch {
      return false;
    }
  };

  const urlOf = async (id) => {
    const known = queue.urls.get(String(id));
    if (known && Date.now() < known.expires) return known;
    let fallback = null;
    try {
      for (const level of LEVELS) {
        const answer = await getJson("/api/song/enhance/player/url/v1", {
          ids: JSON.stringify([id]),
          level,
          encodeType: "mp3",
        });
        const data = (answer.data ?? [])[0] ?? {};
        if (data.url) {
          const url = https(data.url);
          const cors = await supportsCors(url);
          if (!cors && proxy) {
            // The host fetches it: its stream comes with the headers a page needs, so the sound-field keeps it.
            const local = `http://127.0.0.1:${proxy.port}/m/${proxy.token}?u=${encodeURIComponent(url)}`;
            const found = { url: local, cors: true, trial: data.freeTrialInfo ?? null, br: data.br, expires: Date.now() + 15 * 60 * 1000 };
            queue.urls.set(String(id), found);
            log(`proxy ${(() => { try { return new URL(url).host; } catch { return "?"; } })()}`);
            return found;
          }
          const found = { url, cors, trial: data.freeTrialInfo ?? null, br: data.br, expires: Date.now() + 15 * 60 * 1000 };
          if (cors) {
            queue.urls.set(String(id), found);
            return found;
          }
          fallback = fallback ?? found;
        }
      }
    } catch (error) {
      log(`url: ${error}`);
    }
    if (fallback) {
      queue.urls.set(String(id), fallback);
      return fallback;
    }
    queue.urls.set(String(id), null);
    return null;
  };

  const prefetch = async () => {
    for (let offset = 1; offset <= 2; offset++) {
      const id = queue.ids[queue.index + offset];
      if (id && !queue.urls.has(String(id))) urlOf(id);
    }
  };

  const currentId = () => queue.ids[queue.index] ?? null;

  const setQueue = async ({ ids, index = 0, context = null, shuffle = false, insert = false }) => {
    if (!ids || ids.length === 0) return;
    const before = { ids: queue.ids.slice(), index: queue.index, context: queue.context };
    queue.ids = ids;
    queue.index = Math.min(Math.max(0, index), ids.length - 1);
    queue.context = context ?? (insert ? before.context : null);
    queue.shuffle = Boolean(shuffle);
    if (insert && ids.length === 1 && before.ids.length > 0) {
      // A search result pressed: it plays now, the queue already here resuming after it.
      queue.ids = [ids[0], ...before.ids.slice(before.index + 1)];
      queue.index = 0;
    }
    await playCurrent();
  };

  const playCurrent = async (tried = new Set()) => {
    const id = currentId();
    if (!id) {
      stop();
      return null;
    }
    queue.loading = true;
    sayPlayback();
    const found = await urlOf(id);
    if (!found) {
      // No rights or no source: the next one that plays, at once (a list of VIP songs never stalls on one).
      tried.add(String(id));
      const next = nextUntried(tried);
      if (next !== null) {
        queue.index = next;
        return playCurrent(tried);
      }
      queue.loading = false;
      audio.pause();
      const track = await trackOfId(id).catch(() => null);
      log(`no sound for ${id}`);
      post({
        playback: track
          ? {
              track: { ...track, favorite: liked.has(String(id)) },
              context: queue.context,
              playing: false,
              loading: false,
              position: 0,
              duration: track.duration,
              preview: false,
              shuffle: queue.shuffle,
              repeat: queue.repeat,
              volume: audio.volume,
              failed: true,
              next: [],
            }
          : null,
      });
      return null;
    }
    queue.trial = found.trial ?? null;
    const trialStart = queue.trial && Number.isFinite(queue.trial.start) ? queue.trial.start : null;
    throughCab = Boolean(found.cors);
    log(`play ${id} ${(() => { try { return new URL(found.url).host; } catch { return "?"; } })()} cab=${throughCab}`);
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    audio = newAudio(throughCab);
    audio.src = found.url;
    lastPosition = trialStart ?? 0;
    try {
      audio.currentTime = lastPosition;
    } catch {}
    try {
      await audio.play();
    } catch (error) {
      log(`play: ${error}`);
    }
    queue.loading = false;
    sayPlayback(true);
    prefetch();
    return id;
  };

  /** The next song of the queue not tried yet and not playing here: for one that can't play. */
  const nextUntried = (tried) => {
    const count = queue.ids.length;
    if (count === 0 || tried.size >= count) return null;
    if (queue.shuffle) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const index = Math.floor(Math.random() * count);
        if (!tried.has(queue.ids[index])) return index;
      }
      return null;
    }
    for (let step = 1; step <= count; step++) {
      const at = queue.index + step;
      if (at >= count && queue.repeat !== "all") return null;
      const index = at % count;
      if (!tried.has(queue.ids[index])) return index;
    }
    return null;
  };

  const stop = () => {
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    queue.loading = false;
    sayPlayback();
  };

  const nextIndex = () => {
    const count = queue.ids.length;
    if (count === 0) return null;
    if (queue.shuffle && count > 1) {
      let index = queue.index;
      while (index === queue.index) index = Math.floor(Math.random() * count);
      return index;
    }
    const after = queue.index + 1;
    if (after < count) return after;
    return queue.repeat === "all" ? 0 : null;
  };

  const skipTo = async (index) => {
    if (index === null) {
      audio.pause();
      sayPlayback();
      return;
    }
    queue.index = index;
    await playCurrent();
  };

  /** More songs of the private roam, as the ones here end (its own radio has no end). */
  const extendFm = async () => {
    if (queue.context?.id !== "station:fm") return false;
    try {
      const fm = await getJson("/api/v1/radio/get", { limit: 5 });
      const fresh = (fm.data ?? []).map((song) => String(song.id)).filter((id) => !queue.ids.includes(id));
      if (fresh.length === 0) return false;
      queue.ids.push(...fresh);
      return true;
    } catch (error) {
      log(`roam: ${error}`);
      return false;
    }
  };

  const next = async () => {
    const index = nextIndex();
    if (index === null && (await extendFm())) return skipTo(queue.index + 1);
    return skipTo(index);
  };

  const previous = () => {
    if (audio.currentTime > 3 || queue.repeat === "one") {
      audio.currentTime = 0;
      return;
    }
    const index = queue.index - 1;
    if (index >= 0) skipTo(index);
    else if (queue.repeat === "all" && queue.ids.length > 0) skipTo(queue.ids.length - 1);
    else {
      audio.currentTime = 0;
    }
  };

  const trialEnd = () => {
    if (!queue.trial) return Infinity;
    const end = Number(queue.trial.end);
    return Number.isFinite(end) && end > 0 ? end : Infinity;
  };

  /** A fresh element, its handlers on it (the truck's speakers then take it as the one playing). */
  const newAudio = (anonymous = true) => {
    const element = new Audio();
    if (anonymous) element.crossOrigin = "anonymous";
    element.preload = "auto";
    element.volume = volume;
    element.addEventListener("play", () => sayPlayback(true));
    element.addEventListener("pause", () => sayPlayback(true));
    element.addEventListener("error", () => {
      queue.loading = false;
      const src = element.currentSrc || element.src || "";
      log(`sound failed: ${element.error?.code ?? "?"} ${src ? `(${src.split("/")[2] ?? ""})` : "(no src)"}`);
      sayPlayback(true);
    });
    element.addEventListener("loadedmetadata", () => sayPlayback(true));
    element.addEventListener("ended", async () => {
      if (queue.repeat === "one") {
        element.currentTime = 0;
        element.play().catch(() => {});
        return;
      }
      // The private roam has no end: more songs of it, as the last one ends.
      if (nextIndex() === null && (await extendFm())) {
        await skipTo(queue.index + 1);
        return;
      }
      next();
    });
    element.addEventListener("timeupdate", () => {
      if (audio !== element) return;
      if (queue.trial && Number.isFinite(trialEnd()) && element.currentTime >= trialEnd() - 0.15) {
        log("trial over");
        next();
        return;
      }
      lastPosition = element.currentTime;
      sayPlayback();
    });
    return element;
  };
  audio = newAudio(true);

  const playbackOf = async () => {
    const id = currentId();
    if (!id) return null;
    const track = await trackOfId(id).catch(() => null);
    if (!track) return null;
    const now = { ...track, favorite: liked.has(String(id)) };
    const trial = queue.trial;
    const end = Number.isFinite(trialEnd()) ? trialEnd() : null;
    const duration = end !== null ? Math.max(0, end - (trial?.start ?? 0)) : track.duration || (Number.isFinite(audio.duration) ? audio.duration : 0);
    const position = end !== null ? Math.max(0, audio.currentTime - (trial?.start ?? 0)) : audio.currentTime;
    const upcoming = await tracksByIds(queue.ids.slice(queue.index + 1, queue.index + 6)).catch(() => []);
    // The song changed while this was being put together: it isn't what the app is to hear any more.
    if (currentId() !== id) return null;
    return {
      track: now,
      context: queue.context,
      playing: !audio.paused && !audio.ended,
      loading: queue.loading,
      position: Number.isFinite(position) ? position : 0,
      duration: Number.isFinite(duration) ? duration : 0,
      preview: Boolean(trial),
      shuffle: queue.shuffle,
      repeat: queue.repeat,
      volume: audio.volume,
      next: upcoming,
    };
  };

  let playbackAt = 0;
  const sayPlayback = (force = false) => {
    const now = performance.now();
    if (!force && now - playbackAt < 700) return;
    playbackAt = now;
    playbackOf()
      .then((playback) => post({ playback }))
      .catch((error) => log(`playback: ${error}`));
  };

  const sayState = () => {
    post({ state: { signedIn, playing: !audio.paused && !audio.ended, avatar } });
  };

  setInterval(() => {
    checkAccount().catch(() => {});
  }, 20000);

  window.chrome?.webview?.addEventListener("message", ({ data }) => {
    if (CAB[data?.action]) {
      CAB[data.action](data);
      return;
    }
    const action = data?.action;
    if (action === "proxy" && Number(data.port) && data.token) {
      proxy = { port: Number(data.port), token: String(data.token) };
      log(`proxy at 127.0.0.1:${proxy.port}`);
      return;
    }
    if (action === "start") {
      checkAccount(true).catch(() => {});
      sayState();
      sayPlayback();
      return;
    }
    if (action === "ask") {
      ask(data.id, data.question);
      return;
    }
    if (action === "play") {
      if (!data.songs && !data.id) {
        if (audio.paused) audio.play().catch((error) => log(`resume: ${error}`));
        return;
      }
      (async () => {
        if (data.id === "station:fm") {
          const fm = await getJson("/api/v1/radio/get", { limit: 5 });
          const ids = (fm.data ?? []).map((song) => song.id);
          if (ids.length === 0) throw new Error("the private roam is empty");
          await setQueue({ ids, index: 0, context: { id: "station:fm", name: "私人漫游", kind: "station" }, shuffle: false });
          return;
        }
        if (data.id && !data.songs) {
          const [kind, key] = String(data.id).split(":");
          if (kind === "track") {
            await setQueue({ ids: [key], index: 0, context: null, shuffle: data.shuffle, insert: data.insert });
            return;
          }
          if (kind === "song" || kind === "album" || kind === "playlist" || kind === "station") {
            if (kind === "song") {
              await setQueue({ ids: [key], index: 0, context: null, shuffle: data.shuffle, insert: data.insert });
              return;
            }
            const collection = await collectionAnswer(data.id);
            const ids = collection.tracks.map((track) => track.id.split(":")[1]);
            await setQueue({
              ids,
              index: data.index ?? 0,
              context: { id: data.id, name: collection.item.name, kind: collection.item.kind },
              shuffle: data.shuffle,
              insert: data.insert,
            });
            return;
          }
          if (kind === "artist") {
            const artist = await artistAnswer(data.id);
            const ids = artist.top.map((track) => track.id.split(":")[1]);
            await setQueue({
              ids,
              index: data.index ?? 0,
              context: { id: data.id, name: artist.item.name, kind: "artist" },
              shuffle: data.shuffle,
              insert: data.insert,
            });
            return;
          }
        }
        const songs = (data.songs ?? []).map((each) => String(each).split(":").pop());
        await setQueue({
          ids: songs,
          index: data.index ?? 0,
          context: data.id ? { id: data.id, name: data.name ?? "", kind: data.kind ?? "playlist" } : null,
          shuffle: data.shuffle,
          insert: data.insert,
        });
      })().catch((error) => log(`play: ${error}`));
      return;
    }
    if (action === "pause") {
      audio.pause();
      sayPlayback();
      return;
    }
    if (action === "next") {
      next();
      return;
    }
    if (action === "previous") {
      previous();
      return;
    }
    if (action === "seek") {
      const end = trialEnd();
      const at = Number(data.seconds) || 0;
      audio.currentTime = Math.min(Number.isFinite(end) ? end : Infinity, Math.max(0, at));
      sayPlayback();
      return;
    }
    if (action === "volume") {
      const share = Math.min(1, Math.max(0, (Number(data.percent) || 0) / 100));
      volume = share;
      if (audio) audio.volume = share;
      sayPlayback(true);
      return;
    }
    if (action === "shuffle") {
      queue.shuffle = Boolean(data.on);
      sayPlayback();
      return;
    }
    if (action === "repeat") {
      queue.repeat = data.mode === "one" || data.mode === "all" ? data.mode : "off";
      sayPlayback();
      return;
    }
    if (action === "jump") {
      const offset = Number(data.offset) || 0;
      const index = queue.index + offset;
      if (index >= 0 && index < queue.ids.length) skipTo(index);
      return;
    }
    if (action === "favorite") {
      (async () => {
        const id = String(data.id ?? "").split(":").pop();
        const on = Boolean(data.on);
        try {
          await postForm("/api/song/like", { id, like: on, csrf_token: csrf() });
          if (on) liked.add(String(id));
          else liked.delete(String(id));
        } catch (error) {
          log(`favorite: ${error}`);
        }
        sayPlayback();
      })();
      return;
    }
  });

  // The page's own player stays quiet: this one is the app's.
  audio.pause();
  post({ ready: true });
  checkAccount(true).catch(() => {});
  log("ready");
})();
