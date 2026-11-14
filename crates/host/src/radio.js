// radio.cn's live stations, in one of the site's own pages (radio.rs). The copied Radio app is WestPlay's
// face; this script is its engine: it asks radio.cn's signed JSON APIs for the stations of a province, and
// plays what the app plays in an <audio> of its own on the truck's speakers (cab_sound.js, loaded first).
//
// The page is radio.cn's own, so the APIs' Origin is https://www.radio.cn and the site's rules apply as in
// its player. The streams are HLS (hls.min.js, loaded first) or plain mp3 for the few stations that offer
// one; every stream is taken over https, and the audio is handed to cab_sound.js so the cabin shapes it.
(() => {
  if (!/(^|\.)radio\.cn$/.test(location.hostname)) return;
  if (window.top !== window) return;
  const post = (message) => window.chrome?.webview?.postMessage(message);
  const log = (line) => post({ log: String(line).slice(0, 380) });

  const API = "https://ytmsout.radio.cn";
  const KEY = "f0fc4c668392f9f9a447e48584c214ee";
  const VOLUME_KEY = "westplay.radio.volume";

  // --- The site's signed APIs --------------------------------------------------------------------------

  /** MD5, uppercase: the signature is an MD5 of the sorted parameters and the key. */
  const md5 = (text) => {
    const bytes = new TextEncoder().encode(text);
    const length = bytes.length;
    const words = new Uint32Array((((length + 8) >>> 6) + 1) * 16);
    for (let i = 0; i < length; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
    words[length >> 2] |= 0x80 << ((length % 4) * 8);
    words[words.length - 2] = length * 8;
    const shifts = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    const constants = new Uint32Array(64);
    for (let i = 0; i < 64; i++) constants[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
    let a = 0x67452301;
    let b = 0xefcdab89;
    let c = 0x98badcfe;
    let d = 0x10325476;
    for (let at = 0; at < words.length; at += 16) {
      const [aa, bb, cc, dd] = [a, b, c, d];
      for (let i = 0; i < 64; i++) {
        let f;
        let g;
        if (i < 16) {
          f = (b & c) | (~b & d);
          g = i;
        } else if (i < 32) {
          f = (d & b) | (~d & c);
          g = (5 * i + 1) % 16;
        } else if (i < 48) {
          f = b ^ c ^ d;
          g = (3 * i + 5) % 16;
        } else {
          f = c ^ (b | ~d);
          g = (7 * i) % 16;
        }
        const sum = (a + f + constants[i] + words[at + g]) >>> 0;
        const shift = shifts[(i >> 4) * 4 + (i % 4)];
        a = d;
        d = c;
        c = b;
        b = (b + ((sum << shift) | (sum >>> (32 - shift)))) >>> 0;
      }
      a = (a + aa) >>> 0;
      b = (b + bb) >>> 0;
      c = (c + cc) >>> 0;
      d = (d + dd) >>> 0;
    }
    const hex = (word) =>
      Array.from({ length: 4 }, (_, i) => ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, "0")).join("");
    return (hex(a) + hex(b) + hex(c) + hex(d)).toUpperCase();
  };

  const query = (params) =>
    Object.keys(params)
      .filter((key) => params[key] !== undefined && params[key] !== null && params[key] !== "")
      .sort()
      .map((key) => `${key}=${params[key]}`)
      .join("&");

  const getData = async (path, params = {}) => {
    const timestamp = Date.now();
    const signature = md5(`${query(params)}${query(params) ? "&" : ""}timestamp=${timestamp}&key=${KEY}`);
    const response = await fetch(`${API}${path}?${query(params)}`, {
      credentials: "include",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        equipmentId: "0000",
        platformCode: "WEB",
        timestamp: String(timestamp),
        sign: signature,
      },
    });
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    const answer = await response.json();
    if (answer.code !== 0) throw new Error(`${path} ${answer.code}: ${answer.message}`);
    return answer.data ?? [];
  };

  // --- Stations ----------------------------------------------------------------------------------------

  const https = (url) => (typeof url === "string" && url ? url.replace(/^http:/, "https:") : null);
  const programOf = (subtitle) => String(subtitle ?? "").replace(/^正在直播[:：]\s*/, "") || "正在直播";

  const parseStation = (item, region) => ({
    id: String(item.contentId ?? ""),
    region: String(region),
    name: String(item.title ?? ""),
    program: programOf(item.subtitle),
    image: https(item.image),
    streams: [item.mp3PlayUrlHigh, item.playUrlMulti, item.playUrlLow, item.mp3PlayUrlLow]
      .map(https)
      .filter(Boolean),
  });

  const publicStation = (station) => ({
    id: station.id,
    region: station.region,
    name: station.name,
    program: station.program,
    image: station.image,
  });

  const lists = new Map();
  const loadStations = async (region, force = false) => {
    const known = lists.get(region);
    if (!force && known && Date.now() - known.at < 60000) return known;
    try {
      const data = await getData("/web/appBroadcast/list", { categoryId: 0, provinceCode: region });
      const list = data.map((item) => parseStation(item, region)).filter((station) => station.id);
      const entry = { at: Date.now(), list, byId: new Map(list.map((station) => [station.id, station])) };
      lists.set(region, entry);
      post({ stations: { region, stations: list.map(publicStation), failed: false } });
      return entry;
    } catch (error) {
      post({ stations: { region, stations: [], failed: true } });
      log(`stations ${region}: ${error}`);
      throw error;
    }
  };

  // --- The player --------------------------------------------------------------------------------------

  // The driver's head is known (the game's telemetry): until then the truck's speakers don't take the
  // sound, which would leave it silent while they wait for a head to place it from (the page's own sound
  // until then), as the other players do.
  let headReady = false;
  let audio = null;
  let hls = null;
  let station = null;
  let candidates = [];
  let candidateAt = 0;
  let loading = false;
  let failed = false;
  let pausedAt = 0;
  let attempts = 0;
  let retryTimer = 0;
  let volume = (() => {
    try {
      const saved = Number(localStorage.getItem(VOLUME_KEY));
      return Number.isFinite(saved) ? Math.min(1, Math.max(0, saved)) : 0.8;
    } catch {
      return 0.8;
    }
  })();

  const cab = window.westplayCabSound?.(() => (headReady ? audio : null), post);
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
      cab?.bass(data.bassManagement);
    },
    spectrum: (data) => cab?.spectrum(data.on),
  };

  const sayPlayback = () => {
    post({
      playback: station
        ? {
            station: publicStation(station),
            playing: Boolean(audio && !audio.paused),
            loading,
            volume: audio?.volume ?? volume,
            failed,
          }
        : null,
    });
  };

  const ensureAudio = () => {
    if (audio) return audio;
    audio = document.createElement("audio");
    audio.crossOrigin = "anonymous";
    audio.preload = "auto";
    audio.volume = volume;
    audio.style.display = "none";
    (document.body ?? document.documentElement).appendChild(audio);
    audio.addEventListener("playing", () => {
      loading = false;
      failed = false;
      attempts = 0;
      sayPlayback();
    });
    audio.addEventListener("pause", () => {
      pausedAt = Date.now();
      sayPlayback();
    });
    audio.addEventListener("waiting", () => {
      loading = true;
      sayPlayback();
    });
    audio.addEventListener("ended", () => retry(true));
    audio.addEventListener("error", () => {
      if (hls) return;
      loading = false;
      failed = true;
      sayPlayback();
      retry(true);
    });
    return audio;
  };

  const streamsOf = (station) => {
    const seen = new Set();
    const found = [];
    for (const url of station.streams) {
      if (seen.has(url)) continue;
      seen.add(url);
      if (/\.m3u8(\?|$)/i.test(url)) found.push({ url, hls: true });
      else if (/\.mp3(\?|$)/i.test(url)) found.push({ url, hls: false });
    }
    return found;
  };

  const openCandidate = () => {
    const candidate = candidates[candidateAt];
    if (!candidate) {
      retry(true);
      return;
    }
    try {
      if (candidate.hls) openHls(candidate.url);
      else openMp3(candidate.url);
    } catch (error) {
      log(`stream: ${error}`);
      nextCandidate();
    }
  };

  const nextCandidate = () => {
    candidateAt++;
    if (candidateAt < candidates.length) openCandidate();
    else retry(true);
  };

  const openHls = (url) => {
    const element = ensureAudio();
    if (hls) {
      hls.destroy();
      hls = null;
    }
    element.removeAttribute("src");
    element.load();
    if (!window.Hls?.isSupported()) throw new Error("HLS isn't supported");
    hls = new window.Hls({
      enableWorker: false,
      lowLatencyMode: false,
      liveSyncDurationCount: 2,
      backBufferLength: 60,
    });
    hls.on(window.Hls.Events.ERROR, (_, data) => {
      if (!data.fatal) return;
      log(`hls ${data.type}: ${data.details}`);
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        try {
          hls.recoverMediaError();
          return;
        } catch {}
      }
      const failedHls = hls;
      hls = null;
      try {
        failedHls.destroy();
      } catch {}
      nextCandidate();
    });
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      element.play().catch((error) => log(`play: ${error}`));
    });
    hls.attachMedia(element);
    hls.loadSource(url);
    element.play().catch((error) => log(`play: ${error}`));
  };

  const openMp3 = (url) => {
    const element = ensureAudio();
    if (hls) {
      hls.destroy();
      hls = null;
    }
    element.src = url;
    element.load();
    element.play().catch((error) => {
      log(`play: ${error}`);
      loading = false;
      failed = true;
      sayPlayback();
      nextCandidate();
    });
  };

  const retry = (fresh) => {
    clearTimeout(retryTimer);
    attempts++;
    const wait = Math.min(30000, 2000 * Math.min(attempts, 5));
    retryTimer = setTimeout(() => {
      if (!station) return;
      loading = attempts < 3;
      failed = false;
      sayPlayback();
      if (!fresh) {
        candidateAt = 0;
        openCandidate();
        return;
      }
      loadStations(station.region, true)
        .then((entry) => {
          if (!station) return;
          const current = entry.byId.get(station.id) ?? station;
          station = current;
          candidates = streamsOf(current);
          candidateAt = 0;
          openCandidate();
        })
        .catch(() => retry(true));
    }, wait);
  };

  const playStation = async (id, region) => {
    clearTimeout(retryTimer);
    if (station?.id === String(id) && audio) {
      if (audio.paused) {
        failed = false;
        loading = true;
        sayPlayback();
        if (Date.now() - pausedAt > 8000) {
          const entry = await loadStations(station.region, true);
          station = entry.byId.get(station.id) ?? station;
          candidates = streamsOf(station);
          candidateAt = 0;
          openCandidate();
        } else {
          audio.play().catch((error) => log(`resume: ${error}`));
        }
      }
      return;
    }
    const entry = (await loadStations(String(region))) ?? null;
    const next = entry?.byId.get(String(id));
    if (!next) throw new Error(`station ${id} isn't in ${region}`);
    station = next;
    failed = false;
    loading = true;
    attempts = 0;
    sayPlayback();
    candidates = streamsOf(next);
    candidateAt = 0;
    openCandidate();
  };

  const pause = () => {
    if (audio) audio.pause();
  };

  const setVolume = (percent) => {
    volume = Math.min(1, Math.max(0, (Number(percent) || 0) / 100));
    try {
      localStorage.setItem(VOLUME_KEY, String(volume));
    } catch {}
    if (audio) audio.volume = volume;
    sayPlayback();
  };

  window.chrome?.webview?.addEventListener("message", ({ data }) => {
    if (CAB[data?.action]) {
      CAB[data.action](data);
      return;
    }
    const action = data?.action;
    if (action === "start") {
      return;
    }
    if (action === "stations") {
      loadStations(String(data.region)).catch(() => {});
      return;
    }
    if (action === "play") {
      playStation(data.id, data.region ?? "0").catch((error) => {
        log(`play: ${error}`);
        loading = false;
        failed = true;
        sayPlayback();
      });
      return;
    }
    if (action === "pause") {
      pause();
      return;
    }
    if (action === "volume") setVolume(data.percent);
  });

  post({ ready: true });
  sayPlayback();
})();
