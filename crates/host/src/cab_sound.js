// WestPlay: the truck's own speakers, for a page's sound (youtube.js's video, apple_music.js's music): loaded
// before the page's own script, which makes one with `window.westplayCabSound(media, say)` (`media`: the
// element its sound comes from now, or none; `say`: its way to the host, for the spectrum it measures) and
// tells it the speakers, the driver's head and the camera as the host says them. Until there are speakers to
// play it (and a head to hear them), or a cab's walls to come through, the sound is the page's own.
window.westplayCabSound = (media, say, state = {}) => {
  // The truck's own speakers: the video's sound split as a car's system splits it (each side's tweeter the
  // highs, its door woofer the rest above the bass, the bass units the bass of both sides), each played from
  // where it sits in the cab, heard from the driver's head (the browser's 3D sound, HRTF). The cab's space
  // is the game's, x right, y up, z back: Web Audio's own. No speakers (a truck they aren't known for): the
  // sound as it is. Each split is two filters in a row (Linkwitz-Riley), so the parts add up to the whole.
  // A speaker's band: from `band[0]` Hz up to `band[1]` (0: no limit that way); its level, in dB; and how much
  // later it plays (ms: a rear fill's, so the front, heard first, places the music).
  // A speaker's sound falls with its distance from the head past this, as in a cab (metres): leaning to a
  // door, its speaker is much louder. The whole is made up so that from where the head is as the speakers
  // are placed (the driver's seat: the host tells the head first) it's as loud as the sound was.
  const NEAR = 0.3;
  const fall = (at, from) =>
    NEAR /
    Math.max(NEAR, Math.hypot(at[0] - from.x, at[1] - from.y, at[2] - from.z));
  let speakers = null;
  let head = null;
  // The camera outside the cab: the sound through its closed walls, only its bass, at once; quieter and
  // duller the further away, and from 16 m it fades out, silent at 20 m (`distance`: from the driver's head,
  // metres; 0: not known). Each row: distance (m), level (dB), and the lowpass (Hz, 250 × √(4 / distance));
  // between rows both change smoothly with the distance (as heard: by its doublings).
  let outside = false;
  let distance = 0;
  const MUFFLE = [
    [4, -6, 250],
    [5, -9, 224],
    [6, -12, 204],
    [8, -16, 177],
    [16, -24, 125],
  ];
  const SILENT = 20;
  const muffled = () => {
    const last = MUFFLE.at(-1);
    const d = Math.min(Math.max(MUFFLE[0][0], distance), last[0]);
    const after = Math.max(
      1,
      MUFFLE.findIndex(([at]) => at >= d),
    );
    const [from, to] = [MUFFLE[after - 1], MUFFLE[after]];
    const t = Math.log2(d / from[0]) / Math.log2(to[0] / from[0]);
    const level = from[1] + (to[1] - from[1]) * t;
    const frequency = from[2] * (to[2] / from[2]) ** t;
    const fade = Math.min(
      1,
      Math.max(0, (SILENT - distance) / (SILENT - last[0])),
    );
    return { frequency, gain: 10 ** (level / 20) * fade };
  };
  const muffle = (cut) => {
    if (!audio?.muffle) return;
    const { currentTime } = audio.context;
    const { frequency, gain } = outside
      ? muffled()
      : { frequency: 20000, gain: 1 };
    // In or out at once, as the game cuts from one camera to the other; further or nearer as the camera moves.
    for (const [param, value] of [
      [audio.muffle.filter.frequency, frequency],
      [audio.muffle.gain.gain, gain],
    ]) {
      if (cut) param.setValueAtTime(value, currentTime);
      else param.setTargetAtTime(value, currentTime, 0.05);
    }
  };
  // The player's tone (the cab's Settings › Sound), as a car stereo's: bass, mid and treble, dB each, on all
  // the sound before it's split to the speakers. Each band a filter (the bass a shelf under 100 Hz, the mids a
  // broad bell round 1 kHz, the treble a shelf over 8 kHz); the whole turned down by the most any band lifts, so
  // a boost shapes the sound without pushing it past full. Set as it's changed, gliding (no click).
  let equalizer = { bass: 0, mid: 0, treble: 0 };
  const TONE = [
    ["bass", { type: "lowshelf", frequency: 100 }],
    ["mid", { type: "peaking", frequency: 1000, Q: 0.7 }],
    ["treble", { type: "highshelf", frequency: 8000 }],
  ];
  const flat = () => TONE.every(([band]) => !equalizer[band]);
  const setTone = (atOnce) => {
    if (!audio?.tone) return;
    const { currentTime } = audio.context;
    const set = (param, value) =>
      atOnce
        ? param.setValueAtTime(value, currentTime)
        : param.setTargetAtTime(value, currentTime, 0.05);
    TONE.forEach(([band], i) => set(audio.tone.bands[i].gain, equalizer[band]));
    const lift = Math.max(0, ...TONE.map(([band]) => equalizer[band]));
    set(audio.tone.trim.gain, 10 ** (-lift / 20));
  };
  // Cabin character and reverb are independent layers. Cabin IR adds short reflections; the reverb page adds
  // a damped diffuse tail generated for the chosen room size. Both are sends after the speaker mix, so the
  // direct sound keeps its speaker position. A 180 Hz high-pass keeps heavy bass out of the diffuse tail.
  let character = "full";
  let reverb = { enabled: true, size: 55, amount: 32 };
  let reflectionAmount = 100;
  let bassCutoff = 60;
  let reverbTimer = null;
  const level = (value, most = 100) =>
    Math.max(0, Math.min(most, Number(value) || 0));
  const cabinToneOn = () =>
    character === "equalized" || character === "full";
  const reflectionsOn = () => character === "impulse" || character === "full";
  const reverbOn = () =>
    reverb.enabled && reverb.amount > 0;
  const reverbGain = () => (reverb.amount / 100) ** 1.35 * 0.75;
  const reflectionGain = () =>
    (character === "full" ? 0.18 : 0.32) * (reflectionAmount / 100);
  const cabinImpulse = (context) => {
    const size = level(reverb.size) / 100;
    const seconds = 0.42 + size * 1.18;
    const preDelay = 0.006 + size * 0.018;
    const damping = 6800 - size * 2600;
    const rate = context.sampleRate;
    const impulse = context.createBuffer(2, Math.ceil(seconds * rate), rate);
    const start = Math.floor(preDelay * rate);
    const decay = 6.9 / seconds;
    const smooth = 1 - Math.exp((-2 * Math.PI * damping) / rate);
    let seed = 0x51f15e;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2147483648 - 1;
    };
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      let low = 0;
      for (let i = start; i < data.length; i++) {
        const t = (i - start) / rate;
        const envelope =
          Math.exp(-decay * t) * (1 - Math.min(1, t / seconds) ** 5);
        const noise = random();
        low += smooth * (noise - low);
        const high = noise - low;
        data[i] =
          (low * 0.72 + high * 0.32 * Math.exp((-2.4 * t) / seconds)) *
          envelope;
      }
      // Six discrete returns from the windscreen, doors, roof and rear wall; their timing grows with the cab.
      [
        [0.0038, 0.58],
        [0.0067, -0.42],
        [0.0109, 0.34],
        [0.0157, -0.27],
        [0.0228, 0.2],
        [0.0311, -0.14],
      ].forEach(([tap, gain], index) => {
        const at =
          start + Math.floor((tap * (0.72 + size * 0.8)) * rate);
        if (at < data.length)
          data[at] += gain * (channel ? 1 : -1) ** index;
      });
    }
    return impulse;
  };
  const cabinEarlyImpulse = (context) => {
    const size = level(reverb.size) / 100;
    const seconds = 0.12 + size * 0.09;
    const rate = context.sampleRate;
    const impulse = context.createBuffer(2, Math.ceil(seconds * rate), rate);
    const taps = [
      [0.0041, 0.72],
      [0.0073, -0.5],
      [0.0116, 0.4],
      [0.0169, -0.31],
      [0.0242, 0.23],
      [0.0338, -0.16],
    ];
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      taps.forEach(([time, gain], index) => {
        const at = Math.floor(
          time * (0.72 + size * 0.8) * rate + channel * (index % 2) * 3,
        );
        if (at < data.length)
          data[at] += gain * (channel ? 1 : -1) ** index;
      });
      // A very short damped cluster fills between the discrete returns without becoming a long reverb.
      let seed = 0x4a2c91 + channel;
      let low = 0;
      const smooth = 1 - Math.exp((-2 * Math.PI * 6200) / rate);
      for (let i = Math.floor(0.004 * rate); i < data.length; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const noise = seed / 2147483648 - 1;
        low += smooth * (noise - low);
        const t = i / rate;
        data[i] +=
          (low + (noise - low) * 0.25) *
          Math.exp(-30 * t) *
          (1 - i / data.length) ** 2 *
          0.06;
      }
    }
    return impulse;
  };
  const updateReverb = (atOnce = false) => {
    const node = audio?.reverb;
    if (!node) return;
    const { currentTime } = audio.context;
    const set = (param, value) =>
      atOnce
        ? param.setValueAtTime(value, currentTime)
        : param.setTargetAtTime(value, currentTime, 0.08);
    set(node.wet.gain, reverbOn() ? reverbGain() : 0);
    set(node.lowpass.frequency, 6800 - (level(reverb.size) / 100) * 2600);
    if (node.size !== reverb.size) {
      clearTimeout(reverbTimer);
      const rebuild = () => {
        if (audio?.reverb !== node) return;
        node.convolver.buffer = cabinImpulse(audio.context);
        node.size = reverb.size;
      };
      if (atOnce) rebuild();
      else reverbTimer = setTimeout(rebuild, 90);
    }
  };
  // The music's spectrum, while the cab's Equalizer asks for it (`spectrum(true)`): BARS bars from LOWEST to
  // HIGHEST Hz, spaced by octaves (as the ear hears them), each its loudest bin's loudness (0 to 255), measured
  // after the tone (so the curve shapes it) and said to the host (`say`) every SPECTRUM_EVERY ms while the music
  // plays; stopped or paused, said once silent (the cab's bars settle into dots).
  const BARS = 48;
  const LOWEST = 40;
  const HIGHEST = 16000;
  const SPECTRUM_EVERY = 50;
  let spectrumWanted = false;
  let spectrumTimer = null;
  let saidSilent = false;
  const sayQuiet = () => {
    if (!saidSilent) say?.({ spectrum: new Array(BARS).fill(0) });
    saidSilent = true;
  };
  const saySpectrum = () => {
    const analyser = audio?.analyser;
    if (!analyser || !audio?.playing()) return sayQuiet();
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    const perBin = audio.context.sampleRate / 2 / data.length;
    const bars = Array.from({ length: BARS }, (_, i) => {
      const from = LOWEST * (HIGHEST / LOWEST) ** (i / BARS);
      const to = LOWEST * (HIGHEST / LOWEST) ** ((i + 1) / BARS);
      const first = Math.floor(from / perBin);
      const last = Math.max(first + 1, Math.ceil(to / perBin));
      let loudest = 0;
      for (let bin = first; bin < last; bin++)
        loudest = Math.max(loudest, data[bin] ?? 0);
      // Music is quieter the higher it goes: lifted a little up there, so the highs show.
      return loudest === 0
        ? 0
        : Math.min(255, Math.round(loudest + (i / BARS) * 40));
    });
    say?.({ spectrum: bars });
    saidSilent = bars.every((bar) => bar === 0);
  };
  // The sound's way through: its context, the video it comes from, and the nodes of the speakers' way (kept
  // to be undone as the speakers change).
  let audio = null;
  // Each element's way into the context, kept: an element can be taken in once only.
  const sources = new WeakMap();
  // The head as last placed. A head tracker never holds still: its noise (a few tenths of a degree, many times
  // a second) kept the 3D sound swapping its filters, a faint crackle all the time (-51 dB under a tone,
  // measured; none with the head still). So the head moves the sound only once it has turned a degree or moved
  // 2 cm since; while it really turns, the faint swapping stays (the browser's own, about -50 dB).
  const STILL_TURN = 1 / 360;
  const STILL_MOVE = 0.02;
  let placed = null;
  let reflectionOrigin = null;
  const CABIN_REFLECTIONS = [
    { at: [-1.18, 0.18, -0.12], level: 0.24, lowpass: 7200 },
    { at: [1.18, 0.18, -0.12], level: 0.24, lowpass: 7200 },
    { at: [-0.34, 0.2, -1.28], level: 0.18, lowpass: 5600 },
    { at: [0.34, 0.2, -1.28], level: 0.18, lowpass: 5600 },
    { at: [-0.12, 0.9, 0.08], level: 0.13, lowpass: 4800 },
    { at: [0.08, -0.22, -0.95], level: 0.11, lowpass: 4200 },
    { at: [-0.18, 0.12, 1.35], level: 0.14, lowpass: 3600 },
    { at: [0.18, 0.12, 1.35], level: 0.14, lowpass: 3600 },
  ];
  const placeHead = () => {
    if (!audio || !head) return;
    const turn = (a, b) => Math.abs(((a - b + 1.5) % 1) - 0.5);
    if (
      placed &&
      turn(head.heading, placed.heading) < STILL_TURN &&
      Math.abs(head.pitch - placed.pitch) < STILL_TURN &&
      Math.hypot(head.x - placed.x, head.y - placed.y, head.z - placed.z) <
        STILL_MOVE
    )
      return;
    placed = { ...head };
    const { listener, currentTime } = audio.context;
    const across = head.heading * 2 * Math.PI;
    const up = head.pitch * 2 * Math.PI;
    const values = {
      positionX: head.x,
      positionY: head.y,
      positionZ: head.z,
      forwardX: -Math.sin(across) * Math.cos(up),
      forwardY: Math.sin(up),
      forwardZ: -Math.cos(across) * Math.cos(up),
      upX: Math.sin(across) * Math.sin(up),
      upY: Math.cos(up),
      upZ: Math.cos(across) * Math.sin(up),
    };
    for (const [name, value] of Object.entries(values))
      listener[name].setTargetAtTime(value, currentTime, 0.03);
  };
  const wire = () => {
    const told = media();
    const node =
      told && typeof told.connect === "function" && told.context ? told : null;
    const video = node ? null : told;
    // The sound is the page's own until there are speakers to play it (and a head to hear them), a cab's walls
    // to come through, a tone to give it, or its spectrum to measure.
    if (
      (!video && !node) ||
      (!audio &&
        !(speakers && head) &&
        !outside &&
        flat() &&
        !spectrumWanted &&
        !cabinToneOn() &&
        !reflectionsOn() &&
        !reverbOn())
    )
      return;
    if (audio && node && audio.context !== node.context) audio = null;
    if (!audio) {
      audio = {
        context: node ? node.context : new AudioContext(),
        video: null,
        source: null,
        nodes: [],
        meters: null,
        muffle: null,
        cabin: null,
        reverb: null,
        reflections: null,
        earlyReflections: null,
        bassManagement: null,
        wired: undefined,
        playing: () =>
          node
            ? (state.playing?.() ?? true)
            : Boolean(video && !video.paused && !video.ended),
      };
    }
    audio.playing = () =>
      node
        ? (state.playing?.() ?? true)
        : Boolean(video && !video.paused && !video.ended);
    const { context } = audio;
    if (node) {
      if (audio.source !== node) {
        try {
          node.disconnect(context.destination);
        } catch {}
        audio.video = null;
        audio.source = node;
        audio.wired = undefined;
      }
    } else if (audio.video !== video) {
      // An element is taken into the context only once, ever (a second time throws, and its sound would stay
      // in the first way, unheard): one the page plays again (a player switching between its elements, as
      // around a pause) gets its own way back.
      let source = sources.get(video);
      if (!source) {
        source = context.createMediaElementSource(video);
        sources.set(video, source);
      }
      audio.video = video;
      audio.source = source;
      audio.wired = undefined;
    }
    if (audio.wired === speakers || (speakers && !head)) return;
    audio.source.disconnect();
    for (const node of audio.nodes) node.disconnect();
    audio.nodes = [];
    audio.meters = null;
    audio.cabin = null;
    audio.reverb = null;
    audio.reflections = null;
    audio.earlyReflections = null;
    audio.bassManagement = null;
    audio.wired = speakers;
    const keep = (node) => {
      // qq_music.js watches nodes joining the page's destination to find QMA's output. Never mistake this
      // sound-field chain for a new player output when it joins that destination itself.
      node.__westplayCabSoundNode = true;
      audio.nodes.push(node);
      return node;
    };
    // First of all, the tone.
    const bands = TONE.map(([, options]) =>
      keep(new BiquadFilterNode(context, options)),
    );
    const trim = keep(new GainNode(context));
    bands.reduce((from, to) => (from.connect(to), to)).connect(trim);
    audio.source.connect(bands[0]);
    audio.tone = { bands, trim };
    setTone(true);
    // The cabin's broad transfer, not a concert room: a little low-frequency gain, a gentle upper-mid
    // recession and softer highs, then only enough compression to keep very dynamic material coherent.
    let shaped = trim;
    if (cabinToneOn()) {
      const cabinBands = [
        { type: "lowshelf", frequency: 90, gain: 2.4 },
        { type: "peaking", frequency: 220, Q: 0.7, gain: 0.9 },
        { type: "peaking", frequency: 2800, Q: 0.8, gain: -1.2 },
        { type: "highshelf", frequency: 9000, gain: -1.1 },
      ].map((options) => keep(new BiquadFilterNode(context, options)));
      const compressor = keep(
        new DynamicsCompressorNode(context, {
          threshold: -16,
          knee: 10,
          ratio: 1.6,
          attack: 0.015,
          release: 0.25,
        }),
      );
      shaped.connect(cabinBands[0]);
      cabinBands
        .reduce((from, to) => (from.connect(to), to))
        .connect(compressor);
      shaped = compressor;
      audio.cabin = { bands: cabinBands, compressor };
    }
    // Beside it, the spectrum's ear (measuring, playing nothing).
    audio.analyser = keep(
      new AnalyserNode(context, {
        fftSize: 4096,
        smoothingTimeConstant: 0.5,
        minDecibels: -80,
        maxDecibels: -22,
      }),
    );
    shaped.connect(audio.analyser);
    // Last of all, the cab's walls (open while the camera is in it).
    const walls = keep(
      new BiquadFilterNode(context, {
        type: "lowpass",
        frequency: outside ? muffled().frequency : 20000,
        Q: Math.SQRT1_2,
      }),
    );
    const through = keep(
      new GainNode(context, { gain: outside ? muffled().gain : 1 }),
    );
    walls.connect(through);
    audio.muffle = { filter: walls, gain: through };
    // Dry sound and the cab's reflections meet here after the speakers and the windows. A little headroom keeps
    // the wet return from pushing peaks past full.
    const mix = keep(new GainNode(context, { gain: 0.96 }));
    through.connect(mix);
    mix.connect(context.destination);
    if (reverbOn()) {
      const highpass = keep(
        new BiquadFilterNode(context, {
          type: "highpass",
          frequency: 180,
          Q: Math.SQRT1_2,
        }),
      );
      const lowpass = keep(
        new BiquadFilterNode(context, {
          type: "lowpass",
          frequency: 6800 - (level(reverb.size) / 100) * 2600,
          Q: Math.SQRT1_2,
        }),
      );
      const convolver = keep(
        new ConvolverNode(context, {
          buffer: cabinImpulse(context),
          disableNormalization: false,
        }),
      );
      const wet = keep(new GainNode(context, { gain: reverbGain() }));
      through.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(convolver);
      convolver.connect(wet);
      wet.connect(mix);
      audio.reverb = { highpass, lowpass, convolver, wet, size: reverb.size };
    }
    if (reflectionsOn()) {
      const highpass = keep(
        new BiquadFilterNode(context, {
          type: "highpass",
          frequency: 120,
          Q: Math.SQRT1_2,
        }),
      );
      const convolver = keep(
        new ConvolverNode(context, {
          buffer: cabinEarlyImpulse(context),
          disableNormalization: false,
        }),
      );
      const wet = keep(new GainNode(context, { gain: reflectionGain() }));
      through.connect(highpass);
      highpass.connect(convolver);
      convolver.connect(wet);
      wet.connect(mix);
      audio.reflections = { highpass, convolver, wet };
    }
    if (!speakers) {
      shaped.connect(walls);
      return;
    }
    // Stereo always (a mono video plays on both sides), then each side, and both mixed.
    const stereo = keep(
      new GainNode(context, {
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      }),
    );
    const split = keep(context.createChannelSplitter(2));
    shaped.connect(stereo);
    stereo.connect(split);
    const channels = {
      left: keep(context.createGain()),
      right: keep(context.createGain()),
      both: keep(new GainNode(context, { gain: 0.5 })),
    };
    split.connect(channels.left, 0);
    split.connect(channels.right, 1);
    split.connect(channels.both, 0);
    split.connect(channels.both, 1);
    // Standard car bass management: below the selected cutoff the cabin sums the channels to mono and bypasses the
    // directional HRTF path. Above it, each side keeps its normal speaker imaging.
    const highs = Object.fromEntries(
      Object.entries(channels).map(([name, channel]) => {
        const high = keep(
          new BiquadFilterNode(context, {
            type: "highpass",
            frequency: bassCutoff,
            Q: Math.SQRT1_2,
          }),
        );
        channel.connect(high);
        return [name, high];
      }),
    );
    const bassMono = keep(
      new GainNode(context, {
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
        gain: 0.5,
      }),
    );
    split.connect(bassMono, 0);
    split.connect(bassMono, 1);
    const bassLow = keep(
      new BiquadFilterNode(context, {
        type: "lowpass",
        frequency: bassCutoff,
        Q: Math.SQRT1_2,
      }),
    );
    bassMono.connect(bassLow);
    audio.bassManagement = { highs, bassLow };
    // Made up for the distance as the speakers' power adds up at the seat (each plays its own part of the
    // sound): their loudnesses there, squared, summed. (Their average made it up far too much: a loud song
    // went past full, and the limiter squashed it all the time.)
    const seat = Math.sqrt(
      speakers.reduce(
        (sum, speaker) =>
          sum +
          (fall(speaker.at, head) * 10 ** ((speaker.level ?? 0) / 20)) ** 2,
        0,
      ),
    );
    // With 2 dB to spare (a loud song's peaks from the seat stay under the limiter).
    const HEADROOM = 10 ** (-2 / 20);
    const out = keep(
      new GainNode(context, {
        gain: Math.min(6, Math.max(1, HEADROOM / seat)),
      }),
    );
    // Never past full: a head right by a speaker is loud, and a limiter keeps it clean (only then).
    const limiter = keep(
      new DynamicsCompressorNode(context, {
        threshold: -3,
        knee: 0,
        ratio: 20,
        attack: 0.003,
        release: 0.1,
      }),
    );
    audio.limiter = limiter;
    // The walls after the limiter: it would make up what they take.
    bassLow.connect(out);
    out.connect(limiter);
    limiter.connect(walls);
    if (reflectionsOn() && head) {
      // Discrete cabin reflections stay fixed to the interior while the listener turns. Unlike an
      // omnidirectional reverb return, these carry stable directions from the side glass, windscreen,
      // dashboard, roof and rear wall, so turning toward the A-pillar does not move the whole image.
      reflectionOrigin ??= { x: head.x, y: head.y, z: head.z };
      const side = speakers.map((speaker) => speaker.at[0]);
      const cabCenterX = (Math.min(...side) + Math.max(...side)) / 2;
      const scale = 0.88 + (level(reverb.size) / 100) * 0.24;
      const early = [];
      for (const reflection of CABIN_REFLECTIONS) {
        const at = [
          cabCenterX + reflection.at[0] * scale,
          reflectionOrigin.y + reflection.at[1] * scale,
          reflectionOrigin.z + reflection.at[2] * scale,
        ];
        const path = Math.hypot(
          at[0] - reflectionOrigin.x,
          at[1] - reflectionOrigin.y,
          at[2] - reflectionOrigin.z,
        );
        const delay = keep(
          new DelayNode(context, {
            delayTime: Math.max(0.003, Math.min(0.04, (2 * path) / 343)),
            maxDelayTime: 0.05,
          }),
        );
        const highpass = keep(
          new BiquadFilterNode(context, {
            type: "highpass",
            frequency: 110,
            Q: Math.SQRT1_2,
          }),
        );
        const lowpass = keep(
          new BiquadFilterNode(context, {
            type: "lowpass",
            frequency: reflection.lowpass,
            Q: Math.SQRT1_2,
          }),
        );
        const base = reflection.level * (character === "full" ? 0.82 : 1);
        const levelNode = keep(
          new GainNode(context, {
            gain: base * (reflectionAmount / 100),
          }),
        );
        const panner = keep(
          new PannerNode(context, {
            panningModel: "HRTF",
            distanceModel: "inverse",
            refDistance: NEAR,
            rolloffFactor: 1,
            positionX: at[0],
            positionY: at[1],
            positionZ: at[2],
          }),
        );
        shaped.connect(delay);
        delay.connect(highpass);
        highpass.connect(lowpass);
        lowpass.connect(levelNode);
        levelNode.connect(panner);
        panner.connect(out);
        early.push({ at, delay, highpass, lowpass, level: levelNode, base, panner });
      }
      audio.earlyReflections = early;
    }
    // A meter on each ear.
    const ears = keep(context.createChannelSplitter(2));
    mix.connect(ears);
    audio.meters = [0, 1].map((ear) => {
      const meter = keep(new AnalyserNode(context, { fftSize: 2048 }));
      ears.connect(meter, ear);
      return meter;
    });
    for (const speaker of speakers) {
      let node =
        speaker.channel === "left"
          ? highs.left
          : speaker.channel === "right"
            ? highs.right
            : highs.both;
      const [from, to] = speaker.band;
      const filters = [
        ...(from > 0 ? [["highpass", from]] : []),
        ...(to > 0 ? [["lowpass", to]] : []),
      ];
      for (const [type, frequency] of filters) {
        for (let i = 0; i < 2; i++) {
          const filter = keep(
            new BiquadFilterNode(context, { type, frequency, Q: Math.SQRT1_2 }),
          );
          node.connect(filter);
          node = filter;
        }
      }
      const level = keep(
        new GainNode(context, { gain: 10 ** ((speaker.level ?? 0) / 20) }),
      );
      node.connect(level);
      node = level;
      if (speaker.delay > 0) {
        const late = keep(
          new DelayNode(context, {
            delayTime: Math.min(speaker.delay, 50) / 1000,
            maxDelayTime: 0.05,
          }),
        );
        node.connect(late);
        node = late;
      }
      const [x, y, z] = speaker.at;
      const panner = keep(
        new PannerNode(context, {
          panningModel: "HRTF",
          distanceModel: "inverse",
          refDistance: NEAR,
          rolloffFactor: 1,
          positionX: x,
          positionY: y,
          positionZ: z,
        }),
      );
      node.connect(panner);
      panner.connect(out);
    }
    // A way made anew (its context's listener perhaps new too): the head placed whatever it last was.
    placed = null;
    placeHead();
  };
  // How loud the speakers play now in each ear, 0 to 1 (the loudness of the last moment of sound), and how
  // much the limiter is taking off (dB, 0 or less); or none.
  const cabLevel = () =>
    audio?.meters && [
      ...audio.meters.map((meter) => {
        const samples = new Float32Array(meter.fftSize);
        meter.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        return Math.round(Math.sqrt(sum / samples.length) * 10000) / 10000;
      }),
      Math.round((audio.limiter?.reduction ?? 0) * 100) / 100,
    ];

  return {
    speakers(list) {
      speakers = list ?? null;
      reflectionOrigin = null;
      try {
        wire();
      } catch {}
    },
    head(told) {
      head = told;
      placeHead();
      try {
        wire();
      } catch {}
    },
    spectrum(on) {
      spectrumWanted = Boolean(on);
      clearInterval(spectrumTimer);
      spectrumTimer = null;
      saidSilent = false;
      if (spectrumWanted)
        spectrumTimer = setInterval(saySpectrum, SPECTRUM_EVERY);
      else sayQuiet();
      try {
        wire();
      } catch {}
    },
    equalizer(told) {
      equalizer = Object.fromEntries(
        TONE.map(([band]) => [band, Number(told?.[band]) || 0]),
      );
      setTone(false);
      try {
        wire();
      } catch {}
    },
    character(told) {
      const next = ["reference", "equalized", "impulse", "full"].includes(
        told,
      )
        ? told
        : "full";
      if (next === character) return;
      character = next;
      try {
        if (audio) audio.wired = undefined;
        wire();
      } catch {}
    },
    reverb(told) {
      reverb = {
        enabled: told?.enabled !== false,
        size: level(told?.size),
        amount: level(told?.amount),
      };
      try {
        if (!audio?.reverb && reverbOn() && audio) audio.wired = undefined;
        if (audio?.reverb) updateReverb(false);
        wire();
      } catch {}
    },
    reflection(told) {
      reflectionAmount = level(told?.amount);
      if (!audio) return;
      const { currentTime } = audio.context;
      if (audio.reflections?.wet)
        audio.reflections.wet.gain.setTargetAtTime(
          reflectionGain(),
          currentTime,
          0.08,
        );
      for (const reflection of audio.earlyReflections ?? [])
        reflection.level.gain.setTargetAtTime(
          reflection.base * (reflectionAmount / 100),
          currentTime,
          0.08,
        );
    },
    bass(told) {
      bassCutoff = Math.max(30, Math.min(150, Number(told?.cutoff) || 60));
      if (!audio?.bassManagement) return;
      const { currentTime } = audio.context;
      for (const high of Object.values(audio.bassManagement.highs))
        high.frequency.setTargetAtTime(bassCutoff, currentTime, 0.05);
      audio.bassManagement.bassLow.frequency.setTargetAtTime(
        bassCutoff,
        currentTime,
        0.05,
      );
    },
    outside(on, far) {
      const cut = outside !== on;
      outside = on;
      distance = far ?? 0;
      try {
        wire();
        muffle(cut);
      } catch {}
    },
    // Each pass: the speakers' way on the element there is now (the page may make a new one); the sound's
    // context woken if it sleeps.
    tick() {
      try {
        wire();
        if (audio?.context.state === "suspended") audio.context.resume();
      } catch {}
    },
    level: cabLevel,
  };
};
