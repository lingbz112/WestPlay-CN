// The cab's own room, as an audio worklet: six walls for the early reflections (each speaker's own, in its own
// delay line, placed about the head) and eight lines feeding one another for the late field. Nothing here is an
// impulse response: the room's size and absorption give the times, the damping and the tail. Loaded as a blob,
// as a page's own script can't be a worklet's.
const CABIN_SPACE = `
const SPEED = 343;
const MOST_DELAY = 0.06;
// How much of the highs each wall gives back: glass keeps them (a bright return), fabric and carpet take
// them (a dull one). The six ways are left, right, floor, ceiling, front, back.
const FACE_TONE = [7000, 7000, 2200, 2600, 6500, 2000];
const LINES = 8;
const MOST_LINES = 1 << 15;
const HADAMARD = 0.3535533905932738;

class CabinSpace extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "headX", defaultValue: 0, minValue: -8, maxValue: 8, automationRate: "k-rate" },
      { name: "headY", defaultValue: 0, minValue: -8, maxValue: 8, automationRate: "k-rate" },
      { name: "headZ", defaultValue: 0, minValue: -8, maxValue: 8, automationRate: "k-rate" },
      { name: "heading", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "k-rate" },
      { name: "pitch", defaultValue: 0, minValue: -1, maxValue: 1, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    // A truck's cab until told its own: a middle-sized sleeper's.
    this.cabin = { min: [-1.2, -1.2, -1.1], max: [1.2, 1.0, 1.1], absorption: 0.3 };
    this.speakers = [];
    this.size = Math.ceil(MOST_DELAY * sampleRate);
    this.buffers = [];
    this.writes = [];
    this.delays = [];
    this.volumes = [];
    this.pans = [];
    this.lines = Array.from({ length: LINES }, () => ({
      buffer: new Float32Array(MOST_LINES),
      at: 0,
      length: 1,
      gain: 0,
      low: 0,
    }));
    this.work = new Float32Array(LINES);
    this.dry = new Float32Array(256);
    this.damp = 0.5;
    this.tuned = false;
    // How much of each layer plays: the walls' own returns, and the late field's.
    this.reflections = 1;
    this.late = 1;
    this.port.onmessage = (event) => {
      const data = event.data || {};
      if (data.cabin) {
        this.cabin = data.cabin;
        this.tuned = false;
      }
      if (data.speakers) {
        this.speakers = data.speakers;
        this.shape();
        this.tuned = false;
      }
      if (data.reflections !== undefined) {
        const value = Number(data.reflections);
        this.reflections = Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 1;
      }
      if (data.late !== undefined) {
        const value = Number(data.late);
        this.late = Number.isFinite(value) ? Math.max(0, Math.min(2, value)) : 0.5;
      }
    };
  }

  // One line for each way each speaker's sound comes back: its six walls.
  shape() {
    const count = Math.max(1, this.speakers.length) * 6;
    if (this.buffers.length === count) return;
    this.buffers = Array.from({ length: count }, () => new Float32Array(this.size));
    this.writes = new Int32Array(count);
    this.delays = new Float32Array(count);
    this.volumes = new Float32Array(count);
    this.pans = new Float32Array(count);
    this.lows = new Float32Array(count);
    // A short allpass for each way back: the seats and trim scatter what would otherwise come back as a clean
    // mirror, and a scattered return is heard as a soft one.
    this.spread = Array.from({ length: count }, () => new Float32Array(256));
    this.spreadAt = new Int32Array(count);
  }

  // The room's own times: its volume and surfaces give the late field's decay (Sabine) and the lines' lengths
  // (its mean free path), its absorption how fast the highs go.
  tune() {
    // A room of numbers only: anything else would make every delay and gain nothing, and silence the room.
    if (![...this.cabin.min, ...this.cabin.max, this.cabin.absorption].every((v) => Number.isFinite(v))) {
      this.cabin = { min: [-1.2, -1.2, -1.1], max: [1.2, 1.0, 1.1], absorption: 0.3 };
    }
    const { min, max, absorption } = this.cabin;
    const wide = Math.max(0.5, max[0] - min[0]);
    const high = Math.max(0.5, max[1] - min[1]);
    const deep = Math.max(0.5, max[2] - min[2]);
    const volume = wide * high * deep;
    const surface = 2 * (wide * high + high * deep + deep * wide);
    const soft = Math.max(0.05, Math.min(0.9, absorption));
    const rt60 = Math.max(0.06, Math.min(1.4, (0.161 * volume) / (surface * soft)));
    const free = (4 * volume) / surface / SPEED;
    for (let l = 0; l < LINES; l++) {
      const line = this.lines[l];
      // Spaced apart a little, so their echoes don't pile on one another.
      const delay = Math.max(0.0015, free * (0.65 + l * 0.12));
      const frames = Math.round(delay * sampleRate);
      line.length = Number.isFinite(frames) ? Math.max(1, Math.min(MOST_LINES - 1, frames)) : 128;
      line.at = 0;
      const gain = 10 ** ((-3 * delay) / rt60);
      line.gain = Number.isFinite(gain) ? Math.min(0.95, gain) : 0.85;
      line.low = 0;
    }
    // A softer cab takes the highs out of its tail sooner.
    this.damp = 1 - Math.exp((-2 * Math.PI * (900 + (0.9 - soft) * 4200)) / sampleRate);
    this.tuned = true;
  }

  process(inputs, outputs, parameters) {
    const out = outputs[0];
    if (!out || out.length < 2) return true;
    const left = out[0];
    const right = out[1];
    const length = left.length;
    left.fill(0);
    right.fill(0);
    if (this.speakers.length === 0) return true;
    if (!this.tuned) this.tune();

    const hx = parameters.headX[0];
    const hy = parameters.headY[0];
    const hz = parameters.headZ[0];
    const across = parameters.heading[0] * 2 * Math.PI;
    const rightX = Math.cos(across);
    const rightZ = -Math.sin(across);
    const { min, max, absorption } = this.cabin;
    const reflect = Math.max(0.05, 1 - absorption);

    // Where each of every speaker's six ways comes from now: the head moves no faster than a block.
    for (let s = 0; s < this.speakers.length; s++) {
      const at = this.speakers[s].at;
      const sx = at[0], sy = at[1], sz = at[2];
      const dx = sx - hx, dy = sy - hy, dz = sz - hz;
      const direct = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
      for (let f = 0; f < 6; f++) {
        const index = s * 6 + f;
        let mx = sx, my = sy, mz = sz;
        if (f === 0) mx = 2 * min[0] - sx;
        else if (f === 1) mx = 2 * max[0] - sx;
        else if (f === 2) my = 2 * min[1] - sy;
        else if (f === 3) my = 2 * max[1] - sy;
        else if (f === 4) mz = 2 * min[2] - sz;
        else mz = 2 * max[2] - sz;
        const ex = mx - hx, ey = my - hy, ez = mz - hz;
        const path = Math.sqrt(ex * ex + ey * ey + ez * ez) || 0.001;
        const extra = (path - direct) / SPEED;
        this.delays[index] =
          Number.isFinite(extra) && extra > 0 ? (extra > MOST_DELAY ? MOST_DELAY : extra) : 0;
        const volume = (reflect / Math.max(0.4, path)) * 0.62;
        this.volumes[index] = Number.isFinite(volume) ? volume : 0;
        const flat = Math.sqrt(ex * ex + ez * ez) || 1;
        const pan = (ex * rightX + ez * rightZ) / flat;
        this.pans[index] = Number.isFinite(pan) ? (pan < -1 ? -1 : pan > 1 ? 1 : pan) : 0;
      }
    }

    // The early field: each speaker's six ways, out of their own lines, each to its side of the head.
    for (let s = 0; s < this.speakers.length; s++) {
      const input = inputs[s] ? inputs[s][0] : null;
      if (!input) continue;
      for (let f = 0; f < 6; f++) {
        const index = s * 6 + f;
        const buffer = this.buffers[index];
        const frames = buffer.length;
        const delay = this.delays[index] * sampleRate;
        const volume = this.volumes[index];
        const pan = this.pans[index];
        const gl = volume * this.reflections * Math.sqrt((1 - pan) * 0.5);
        const gr = volume * this.reflections * Math.sqrt((1 + pan) * 0.5);
        // What this wall gives back of the highs: glass bright, carpet and fabric dull.
        const alpha = 1 - Math.exp((-2 * Math.PI * FACE_TONE[f]) / sampleRate);
        let low = this.lows[index];
        let at = this.writes[index];
        // The scatter: a short allpass (a different length for each wall), its phase spread but its energy kept.
        const spreadDelay = 48 + f * 16;
        const spread = this.spread[index];
        let spreadAt = this.spreadAt[index];
        for (let i = 0; i < length; i++) {
          const heard = input[i];
          buffer[at] = Number.isFinite(heard) ? heard : 0;
          let read = at - delay;
          if (read < 0) read += frames;
          const from = read | 0;
          const next = from + 1 === frames ? 0 : from + 1;
          const sample = buffer[from] + (buffer[next] - buffer[from]) * (read - from);
          low += alpha * (sample - low);
          let spreadRead = spreadAt - spreadDelay;
          if (spreadRead < 0) spreadRead += 256;
          const out = -0.5 * low + spread[spreadRead];
          const back = low + 0.5 * out;
          spread[spreadAt] = Number.isFinite(back) ? back : 0;
          spreadAt = spreadAt + 1 === 256 ? 0 : spreadAt + 1;
          left[i] += out * gl;
          right[i] += out * gr;
          at = at + 1 === frames ? 0 : at + 1;
        }
        this.lows[index] = low;
        this.writes[index] = at;
        this.spreadAt[index] = spreadAt;
      }
    }

    // The late field: every speaker into eight lines that feed each other, the highs fading first.
    for (let i = 0; i < length; i++) this.dry[i] = 0;
    for (let s = 0; s < this.speakers.length; s++) {
      const input = inputs[s] ? inputs[s][0] : null;
      if (!input) continue;
      for (let i = 0; i < length; i++) this.dry[i] += input[i];
    }
    const scale = 0.3 / Math.max(1, this.speakers.length);
    for (let i = 0; i < length; i++) {
      const feed = this.dry[i] * scale;
      for (let l = 0; l < LINES; l++) {
        const line = this.lines[l];
        let read = line.at - line.length;
        if (read < 0) read += MOST_LINES;
        const value = line.buffer[read];
        line.low += this.damp * (value - line.low);
        if (!Number.isFinite(line.low)) line.low = 0;
        this.work[l] = line.low;
      }
      for (let step = 1; step < LINES; step *= 2) {
        for (let a = 0; a < LINES; a += step * 2) {
          for (let b = 0; b < step; b++) {
            const x = this.work[a + b];
            const y = this.work[a + b + step];
            this.work[a + b] = x + y;
            this.work[a + b + step] = x - y;
          }
        }
      }
      for (let l = 0; l < LINES; l++) {
        const line = this.lines[l];
        const written = feed + this.work[l] * HADAMARD * line.gain;
        line.buffer[line.at] = Number.isFinite(written) ? written : 0;
        line.at = line.at + 1 === MOST_LINES ? 0 : line.at + 1;
      }
      left[i] += (this.work[0] + this.work[2] + this.work[4] + this.work[6]) * 0.075 * this.late;
      right[i] += (this.work[1] + this.work[3] + this.work[5] + this.work[7]) * 0.075 * this.late;
    }
    // Nothing leaves this room that isn't a number: one NaN would poison every filter after it, and the whole
    // sound with it.
    for (let i = 0; i < length; i++) {
      if (!Number.isFinite(left[i])) left[i] = 0;
      if (!Number.isFinite(right[i])) right[i] = 0;
    }
    return true;
  }
}

// The low band's own limiter: 200 Hz and under alone (the crossover outside this worklet), pulled down before
// a truck's several low units can add up past full. A look-ahead one: the sound waits in a line while it works
// out what to do, so a peak comes down before it arrives rather than being clipped as it passes. Its peaks are
// held at the threshold, and never past the ceiling.
class LowLimiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "threshold", defaultValue: -6, minValue: -60, maxValue: 0, automationRate: "k-rate" },
      { name: "ceiling", defaultValue: -1, minValue: -60, maxValue: 0, automationRate: "k-rate" },
      { name: "knee", defaultValue: 6, minValue: 0, maxValue: 24, automationRate: "k-rate" },
      { name: "attack", defaultValue: 2, minValue: 0.1, maxValue: 100, automationRate: "k-rate" },
      { name: "release", defaultValue: 120, minValue: 10, maxValue: 2000, automationRate: "k-rate" },
      { name: "lookahead", defaultValue: 5, minValue: 0, maxValue: 20, automationRate: "k-rate" },
    ];
  }

  constructor() {
    super();
    // Room enough for the furthest ahead it looks, and a block over that.
    this.size = Math.ceil(0.02 * sampleRate) + 128;
    this.delay = [new Float32Array(this.size), new Float32Array(this.size)];
    this.at = 0;
    this.gain = 1;
  }

  process(inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    const left = output[0];
    const right = output[1];
    const length = left.length;
    const input = inputs[0];
    const heard = input && input[0];
    if (!heard) {
      left.fill(0);
      right.fill(0);
      return true;
    }
    const other = input[1] || heard;

    const setting = (name, least, most, falls) => {
      const told = Number(parameters[name][0]);
      return Number.isFinite(told) ? Math.max(least, Math.min(most, told)) : falls;
    };
    const threshold = setting("threshold", -60, 0, -6);
    const ceiling = setting("ceiling", -60, 0, -1);
    const knee = setting("knee", 0, 24, 6);
    const attack = setting("attack", 0.1, 100, 2) / 1000;
    const release = setting("release", 10, 2000, 120) / 1000;
    const ahead = Math.round((setting("lookahead", 0, 20, 5) * sampleRate) / 1000);
    const attackStep = Math.exp(-1 / (attack * sampleRate));
    const releaseStep = Math.exp(-1 / (release * sampleRate));
    // What the low band is held at: its threshold, and never past its ceiling.
    const cap = 10 ** (Math.min(threshold, ceiling) / 20);

    for (let i = 0; i < length; i++) {
      const l = Number.isFinite(heard[i]) ? heard[i] : 0;
      const r = Number.isFinite(other[i]) ? other[i] : 0;
      this.delay[0][this.at] = l;
      this.delay[1][this.at] = r;
      let read = this.at - ahead;
      if (read < 0) read += this.size;
      const late_l = this.delay[0][read];
      const late_r = this.delay[1][read];

      // What it must do with the wave it hears now, done to the one it held back.
      const peak = Math.max(Math.abs(l), Math.abs(r));
      if (peak > 0) {
        const over = 20 * Math.log10(peak) - threshold;
        // A soft knee: the pull-down comes in over knee dB under the threshold, not at it.
        const asked =
          knee > 0 && over < knee / 2
            ? over <= -knee / 2
              ? 0
              : (over + knee / 2) ** 2 / (2 * knee)
            : Math.max(0, over);
        let wanted = 10 ** (-asked / 20);
        // Held at the threshold, and never past the ceiling.
        if (peak * wanted > cap) wanted = cap / peak;
        const step = wanted < this.gain ? attackStep : releaseStep;
        this.gain = wanted + (this.gain - wanted) * step;
        if (!Number.isFinite(this.gain)) this.gain = 1;
      } else {
        this.gain = 1 + (this.gain - 1) * releaseStep;
      }

      // And the sound itself never goes past it: the envelope above shapes how gently, this is the promise.
      const latePeak = Math.max(Math.abs(late_l), Math.abs(late_r));
      if (latePeak * this.gain > cap) this.gain = cap / latePeak;

      left[i] = late_l * this.gain;
      right[i] = late_r * this.gain;
      this.at = this.at + 1 === this.size ? 0 : this.at + 1;
    }
    return true;
  }
}

registerProcessor("cabin-space", CabinSpace);
registerProcessor("low-limiter", LowLimiter);
`;

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
  // The cab as a room for sound, as the host reads it from the interior's own model: its box, and how much its
  // surfaces soak up (none: the worklet's own middle-sized cab until it's said).
  let cabin = null;
  // A room only if its corners are numbers: a bad one would turn the room's delays into nothing and silence
  // the whole chain.
  const soundCabin = (room) =>
    room &&
    Array.isArray(room.min) &&
    Array.isArray(room.max) &&
    room.min.length === 3 &&
    room.max.length === 3 &&
    [...room.min, ...room.max, room.absorption].every((value) => Number.isFinite(value));
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
  // The player's tone (the cab's Settings › Equalizer), as a car stereo's: bass, mid and treble, dB each, on all
  // the sound before it's split to the speakers. Each band a filter (the bass a shelf under 100 Hz, the mids a
  // broad bell round 1 kHz, the treble a shelf over 8 kHz); the whole turned down by the most any band lifts, so
  // a boost shapes the sound without pushing it past full. Set as it's changed, gliding (no click).
  let equalizer = { bass: 0, mid: 0, treble: 0 };
  const TONE = [
    ["bass", { type: "lowshelf", frequency: 100 }],
    ["mid", { type: "peaking", frequency: 1000, Q: 0.7 }],
    ["treble", { type: "highshelf", frequency: 8000 }],
  ];
  // Advanced (the cab's Settings › Sound Settings › Equalizer): fifteen bands instead, an ISO two-thirds of an
  // octave each from 25 Hz to 16 kHz -- the range a car's three-band tone control leaves alone -- each a peaking
  // filter of its own. One or the other plays; both curves are kept, so switching back keeps what was tuned.
  const GRAPHIC_BANDS = 15;
  const GRAPHIC_MOST = 12;
  const GRAPHIC = Array.from(
    { length: GRAPHIC_BANDS },
    (_, i) => 25 * (16000 / 25) ** (i / (GRAPHIC_BANDS - 1)),
  );
  // The cab's own curve until the host says otherwise: fifteen bands, the lows lifted and the highs rising.
  let advanced = true;
  let graphic = [5, 2, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1, 3, 5, 7];
  // The cab's own tuning, as it was tuned in the truck (owner 2026-11-18): its harmonics driven at 46 and the
  // mids a decibel down (the rest of it sounding hollow).
  let drive = 46;
  let midTrim = -1;
  let highTrim = 0;
  // The room's own levels, independent of the tone: per cent, early returns and late field each.
  let earlyReflections = 70;
  let lateReflections = 50;
  // The drive the shaper's curve was made for: setting it again resets the node's state (a click), so only a
  // moved slider touches it.
  let shapedDrive = -1;
  // The low band's own limiter (200 Hz and under alone), as the Settings › Sound › Low Limiter sliders give it:
  // where it starts pulling a peak down and the level it holds it at (dB), the most it sends on (dB), how
  // softly it comes in (dB), how fast it works (ms), and how far ahead of a peak it looks (ms).
  const LIMITER_FALLBACK = { threshold: 0, ceiling: -3.5, knee: 2, attack: 11.5, release: 250, lookahead: 2.5 };
  const LIMITER_RANGE = {
    threshold: [-60, 0],
    ceiling: [-60, 0],
    knee: [0, 24],
    attack: [0.1, 100],
    release: [10, 2000],
    lookahead: [0, 20],
  };
  let lowLimit = { ...LIMITER_FALLBACK };
  const applyLimiter = (node) => {
    const { currentTime } = audio.context;
    for (const [name, value] of Object.entries(lowLimit)) {
      node.parameters.get(name)?.setValueAtTime(value, currentTime);
    }
  };
  // A soft drive's curve: no hard edges, so it thickens rather than distorts.
  const saturation = (amount) => {
    const steps = 1024;
    const curve = new Float32Array(steps);
    const k = 1 + (amount / 100) * 9;
    for (let i = 0; i < steps; i++) {
      const x = (i / (steps - 1)) * 2 - 1;
      curve[i] = Math.tanh(k * x) / Math.tanh(k);
    }
    return curve;
  };
  // The filters the tone is made of now, and the gain each plays (dB).
  const toneFilters = () =>
    advanced
      ? GRAPHIC.map((frequency) => ({ type: "peaking", frequency, Q: 1.1 }))
      : TONE.map(([, options]) => options);
  const toneCurve = () => (advanced ? graphic : TONE.map(([band]) => equalizer[band]));
  const setTone = (atOnce) => {
    if (!audio?.tone) return;
    const { currentTime } = audio.context;
    const set = (param, value) => {
      // Set at once, not glided: a drag sends a message every few milliseconds, and a glide restarted that
      // often chased its own target, the whole tone floating until the drag stopped.
      if (Math.abs(param.value - value) < 0.001) return;
      param.setValueAtTime(value, currentTime);
    };
    const curve = toneCurve();
    audio.tone.bands.forEach((band, i) => set(band.gain, curve[i] ?? 0));
    // No trim: making up for the curve's lifts changed the whole song's level with every slider, and left a
    // custom curve quieter than the flat one. The curve shapes the tone; the listener's volume is their own.
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
  // The cab's room, its worklet loaded once (its source as a blob: a page's own script can't be a worklet's).
  let worklet = null;
  const loadWorklet = (context) => {
    if (!worklet) {
      try {
        const url = URL.createObjectURL(new Blob([CABIN_SPACE], { type: "application/javascript" }));
        worklet = context.audioWorklet
          .addModule(url)
          .then(() => URL.revokeObjectURL(url))
          .catch(() => {});
      } catch {
        worklet = Promise.resolve();
      }
    }
    return worklet;
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
    // The room hears from where the head is too: its walls' returns move with it.
    const space = audio.space;
    if (space) {
      const { parameters } = space;
      parameters.get("headX").setTargetAtTime(head.x, currentTime, 0.03);
      parameters.get("headY").setTargetAtTime(head.y, currentTime, 0.03);
      parameters.get("headZ").setTargetAtTime(head.z, currentTime, 0.03);
      parameters.get("heading").setTargetAtTime(head.heading, currentTime, 0.03);
      parameters.get("pitch").setTargetAtTime(head.pitch, currentTime, 0.03);
    }
  };
  const wire = () => {
    const told = media();
    const node =
      told && typeof told.connect === "function" && told.context ? told : null;
    const video = node ? null : told;
    // The sound is the page's own until there are speakers to play it (and a head to hear them), a cab's walls
    // to come through, or its spectrum to measure.
    if ((!video && !node) || (!audio && !(speakers && head) && !outside && !spectrumWanted)) return;
    if (audio && node && audio.context !== node.context) audio = null;
    if (!audio) {
      audio = {
        context: node ? node.context : new AudioContext(),
        video: null,
        source: null,
        nodes: [],
        meters: null,
        muffle: null,
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
    // A new source (the page's player replaced, a song's own element): the way is already made, its head the
    // sound's own way in, so only the source is moved onto it. Rebuilding the whole cab — its lines, its
    // panners — takes long enough to be heard as a hitch at the start of a song; moving one connection isn't.
    if (node && audio.input && audio.wired === speakers && audio.source !== node) {
      try {
        audio.source?.disconnect();
      } catch {}
      try {
        node.disconnect(context.destination);
      } catch {}
      node.connect(audio.input);
      audio.source = node;
      audio.video = null;
      placed = null;
      placeHead();
      return;
    }
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
    // Rebuilt when the camera goes in or out too: the walls' own filter is made with that state, not only
    // nudged afterwards (a page swapping elements around a pause left the nudge unheard).
    if (audio.wired === speakers && audio.outside === outside) return;
    if (speakers && !head) return;
    audio.source.disconnect();
    for (const node of audio.nodes) node.disconnect();
    audio.nodes = [];
    audio.meters = null;
    audio.space = null;
    audio.limiter = null;
    audio.wired = speakers;
    audio.outside = outside;
    const keep = (node) => {
      // qq_music.js watches nodes joining the page's destination to find QMA's output. Never mistake this
      // sound-field chain for a new player output when it joins that destination itself.
      node.__westplayCabSoundNode = true;
      audio.nodes.push(node);
      return node;
    };
    // The cab's room and the low band's own limiter, as one worklet (its source as a blob: a page's own script
    // can't be a worklet's). Until it loads, the sound plays without either (a moment, the first time).
    if (!audio.roomTried) {
      audio.roomTried = true;
      loadWorklet(context).then(() => {
        if (audio?.context === context) {
          audio.room = true;
          audio.wired = undefined;
          try {
            wire();
          } catch {}
        }
      });
    }
    // First of all, the tone: three bands, or fifteen while Advanced is on. Its trim is the way in every path
    // comes off, so a page that swaps its player's element (as around a pause) moves one connection, not the
    // whole room.
    const bands = toneFilters().map((options) => keep(new BiquadFilterNode(context, options)));
    const trim = keep(new GainNode(context));
    // The way in, before the tone: the equalizer sits at the very end now (after the room), so nothing it does
    // can reach the speakers' own paths or the room's.
    const input = keep(new GainNode(context));
    audio.source.connect(input);
    audio.input = input;
    // The cab's broad transfer, what makes a cab a cab and not a room: a little low-frequency gain, a gentle
    // upper-mid recession and softer highs. The old cabin curve's measurements, kept: reflections alone can't
    // make this, and without it the room sounds like a plain reverb.
    const cabinTone = [
      { type: "lowshelf", frequency: 90, gain: 2.4 },
      { type: "peaking", frequency: 220, Q: 0.7, gain: 0.9 },
      { type: "peaking", frequency: 2800, Q: 0.8, gain: -1.2 },
      { type: "highshelf", frequency: 9000, gain: -1.1 },
    ].map((options) => keep(new BiquadFilterNode(context, options)));
    input.connect(cabinTone[0]);
    // The lowest notes' own harmonics, as a cab's panels give them: driven under 60 Hz and mixed back, so the
    // bottom is heard as well as felt. Its curve is made of finite numbers only, and its own gain is what the
    // slider moves (0: nothing at all).
    const subLow = keep(new BiquadFilterNode(context, { type: "lowpass", frequency: 60, Q: 0.7 }));
    const shaper = keep(new WaveShaperNode(context, { oversample: "2x" }));
    const subGain = keep(new GainNode(context, { gain: (drive / 100) * 0.6 }));
    shaper.curve = saturation(drive);
    input.connect(subLow);
    subLow.connect(shaper);
    shaper.connect(subGain);
    subGain.connect(cabinTone[0]);
    // The Tuning sliders' own trims, after the cab's curve: mid and high, as the ear wants them.
    const midTone = keep(
      new BiquadFilterNode(context, { type: "peaking", frequency: 1000, Q: 0.9, gain: midTrim }),
    );
    const highTone = keep(
      new BiquadFilterNode(context, { type: "highshelf", frequency: 6000, gain: highTrim }),
    );
    cabinTone.reduce((from, to) => (from.connect(to), to)).connect(midTone);
    midTone.connect(highTone);
    audio.tone = { bands, trim, cabinTone, shaper, subGain, midTone, highTone, advanced };
    setTone(true);
    const shaped = highTone;
    // Beside it, the spectrum's ear (measuring, playing nothing): after the tone, at the end.
    audio.analyser = keep(
      new AnalyserNode(context, {
        fftSize: 4096,
        smoothingTimeConstant: 0.5,
        minDecibels: -80,
        maxDecibels: -22,
      }),
    );
    trim.connect(audio.analyser);
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
    // The cab's own boom: the three axial standing waves of its box, each a narrow lift at c/(2L) -- around
    // 73, 78 and 81 Hz in a sleeper, a little higher in a day cab. No tone control makes this: it is the room
    // itself, and what a real cab's low end sounds like. Each is gentle: three together are the boom, not one.
    const box = cabin ?? { min: [-1.2, -1.2, -1.1], max: [1.2, 1.0, 1.1] };
    const modes = [0, 1, 2].map((axis) =>
      keep(
        new BiquadFilterNode(context, {
          type: "peaking",
          frequency: (() => {
            const hz = 343 / (2 * Math.max(0.8, box.max[axis] - box.min[axis]));
            return Number.isFinite(hz) ? Math.max(42, Math.min(200, hz)) : 70;
          })(),
          Q: 5,
          gain: 2.5,
        }),
      ),
    );
    // The tone last of all, on what the cab has made: its curve shapes the finished sound, and moving a slider
    // reaches nothing else in the chain.
    mix.connect(modes[0]);
    modes.reduce((from, to) => (from.connect(to), to)).connect(bands[0]);
    // The low band's own limiter, on 200 Hz and under alone: where a truck's several low units would add up
    // past full, the level comes down before the sum does. The highs take another way round, so a bass peak
    // carries nothing of the mids and treble down with it. A Linkwitz-Riley split (two Butterworth sections a
    // side): its halves sum back to the sound unchanged, where one section a side leaves a hole at 200 Hz.
    const finished = bands.reduce((from, to) => (from.connect(to), to));
    const lowCut = [0, 1].map(() =>
      keep(new BiquadFilterNode(context, { type: "lowpass", frequency: 200, Q: Math.SQRT1_2 })),
    );
    const highCut = [0, 1].map(() =>
      keep(new BiquadFilterNode(context, { type: "highpass", frequency: 200, Q: Math.SQRT1_2 })),
    );
    finished.connect(lowCut[0]);
    lowCut[0].connect(lowCut[1]);
    finished.connect(highCut[0]);
    highCut[0].connect(highCut[1]);
    highCut[1].connect(trim);
    if (audio.room) {
      try {
        const lowLimiter = keep(
          new AudioWorkletNode(context, "low-limiter", {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            // Both sides of the low band, however the sound came in.
            channelCount: 2,
            channelCountMode: "explicit",
            channelInterpretation: "speakers",
          }),
        );
        applyLimiter(lowLimiter);
        lowCut[1].connect(lowLimiter);
        lowLimiter.connect(trim);
        audio.limiter = lowLimiter;
      } catch {
        lowCut[1].connect(trim);
      }
    } else {
      lowCut[1].connect(trim);
    }
    trim.connect(context.destination);
    // The cab's reflections and its late field come from the room itself now (the worklet below): each speaker's
    // six walls, and eight lines feeding one another. No impulse response is made or played.
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
    // Each side plays its own sound: what a speaker plays of it is its band's (the crossover below).
    const highs = channels;
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
        gain: Math.min(3, Math.max(1, HEADROOM / seat)),
      }),
    );
    // No limiter: even a soft one pulled the life out of every beat, the bass setting its gain and the mids
    // going down with it. The chain's own headroom is what keeps peaks in now.
    // The room's worklet answers a block (128 samples) after it hears: the direct sound waits as long, so its
    // returns land where they should.
    const latency = keep(
      new DelayNode(context, {
        delayTime: 128 / context.sampleRate,
        maxDelayTime: 0.05,
      }),
    );
    out.connect(latency);
    latency.connect(walls);
    // A meter on each ear.
    const ears = keep(context.createChannelSplitter(2));
    mix.connect(ears);
    audio.meters = [0, 1].map((ear) => {
      const meter = keep(new AnalyserNode(context, { fftSize: 2048 }));
      ears.connect(meter, ear);
      return meter;
    });
    // The cab's room: a worklet that puts each speaker's own six ways about the head, and feeds one late field
    // from them all (loaded above). Until it loads, the speakers' direct sound plays alone.
    let roomNode = null;
    if (audio.room) {
      try {
        roomNode = keep(
          new AudioWorkletNode(context, "cabin-space", {
            numberOfInputs: speakers.length,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            // Every way in is one speaker's own sound: mono, whatever its band's paths made of it.
            channelCount: 1,
            channelCountMode: "explicit",
          }),
        );
        roomNode.port.postMessage({
          speakers,
          cabin: cabin
            ? {
                min: cabin.min,
                max: cabin.max,
                absorption: cabin.absorption,
              }
            : null,
          reflections: earlyReflections / 100,
          late: lateReflections / 100,
        });
        // The room's returns come through the cab's walls too: outside, its reflections are muffled with the
        // rest (the old chain's reverb took its sound past the same wall, and sounded it).
        roomNode.connect(walls);
        audio.space = roomNode;
      } catch {}
    }
    speakers.forEach((speaker, index) => {
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
      // The room hears this speaker too, its own way in: out of it come this speaker's six ways back.
      if (roomNode) node.connect(roomNode, 0, index);
    });
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
    /** Whether the cab's way is made (its way in, its lines and panners there to play through). */
    built: () => Boolean(audio?.input),
    speakers(list, room) {
      const was = cabin;
      speakers = list ?? null;
      if (room !== undefined) cabin = soundCabin(room) ? room : null;
      try {
        if (was !== cabin && audio) audio.wired = undefined;
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
      equalizer = Object.fromEntries(TONE.map(([band]) => [band, Number(told?.[band]) || 0]));
      const curve = Array.isArray(told?.bands) ? told.bands : [];
      graphic = Array.from({ length: GRAPHIC_BANDS }, (_, i) =>
        Math.max(-GRAPHIC_MOST, Math.min(GRAPHIC_MOST, Number(curve[i]) || 0)),
      );
      // Three bands and fifteen are different graphs: one traded for the other.
      const was = advanced;
      advanced = Boolean(told?.advanced);
      // Only what moved is touched: a curve's own drag must not nudge the room or the trims at all.
      const tone = audio?.tone;
      if (tone) {
        const now = audio.context.currentTime;
        const put = (param, value) => {
          if (Math.abs(param.value - value) > 0.01) param.setValueAtTime(value, now);
        };
        if (drive !== shapedDrive) {
          shapedDrive = drive;
          tone.shaper.curve = saturation(drive);
          put(tone.subGain.gain, (drive / 100) * 0.6);
        }
        put(tone.midTone.gain, midTrim);
        put(tone.highTone.gain, highTrim);
      }
      // A curve's own sliders only move gains: the way is rebuilt for the three-band/fifteen-band switch, and
      // for the first song, when there is no way yet. The switch comes first, so its new filters get the curve
      // rather than the old ones (whose count no longer matches it, which the mix heard as a level drop).
      if (!audio || was !== advanced) {
        if (audio) audio.wired = undefined;
        try {
          wire();
        } catch {}
      } else {
        setTone(false);
      }
    },
    /** The room's levels, set on their own: per cent from 0 to 200, early returns and late field each. */
    reflections(told) {
      earlyReflections = Math.max(0, Math.min(200, Number(told?.early) || 0));
      lateReflections = Math.max(0, Math.min(200, Number(told?.late) || 0));
      audio?.space?.port.postMessage({
        reflections: earlyReflections / 100,
        late: lateReflections / 100,
      });
    },
    /** The low band's own limiter (200 Hz and under alone), set on its own: where it starts, the most it sends
     * on, how softly and how fast it works, and how far ahead of a peak it looks. */
    limiter(told) {
      for (const [name, [least, most]] of Object.entries(LIMITER_RANGE)) {
        const value = Number(told?.[name]);
        lowLimit[name] = Number.isFinite(value)
          ? Math.max(least, Math.min(most, value))
          : LIMITER_FALLBACK[name];
      }
      if (audio?.limiter) applyLimiter(audio.limiter);
    },
    outside(on, far) {
      const cut = outside !== on;
      outside = on;
      distance = far ?? 0;
      // The walls' muffling is set even if the way is rebuilt over a player swapping its element: a page that
      // pauses as the view changes must still go dull outside the cab.
      try {
        wire();
      } catch {}
      muffle(cut);
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
    /** What the sound's way is now, for a page that has to tell a silent song from a broken one: whether the
     * cab's way is built, its context's state, how many speakers it plays, and whether the head is known. */
    state: () => ({
      built: Boolean(audio?.input),
      context: audio?.context?.state ?? "none",
      speakers: speakers?.length ?? 0,
      head: Boolean(head),
      room: Boolean(audio?.space),
      // The level after the cab (the first meter's RMS), for a page that has to tell a quiet song from a
      // silent one.
      level: audio ? (cabLevel()?.[0] ?? null) : null,
    }),
    /** Wakes the sound's context (a page with no way to be clicked, as a hidden one, can find it asleep). */
    wake: () => {
      const context = audio?.context;
      if (!context) return "none";
      if (context.state === "suspended") context.resume().catch(() => {});
      return context.state;
    },
  };
};
