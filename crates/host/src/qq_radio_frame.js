// QQ Music's radio player runs its audio engine in this cross-origin iframe. WebView2 injects this
// script into that frame, where the top document cannot reach its AudioContext. The script joins QMA's
// output to the cab sound field and relays the cab's speakers and driver through the parent page.
(() => {
  if (window.top === window) return "top";
  if (!/(^|\.)u\.y\.qq\.com$/.test(location.hostname))
    return `other frame: ${location.hostname}`;
  if (window.__westplayRadioFrameStarted) return "already started";
  window.__westplayRadioFrameStarted = true;

  const tellTop = (message) =>
    window.top.postMessage({ __westplayRadioFrame: true, ...message }, "*");
  const tell = (message) => {
    try {
      window.chrome?.webview?.postMessage({
        role: "player",
        __westplayRadioFrame: true,
        ...message,
      });
    } catch {}
    tellTop(message);
  };
  const qmaOutput = { node: null, context: null };
  try {
    const connect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...rest) {
      if (
        destination === this.context?.destination &&
        !this.__westplayCabSoundNode &&
        qmaOutput.node !== this
      ) {
        qmaOutput.node = this;
        qmaOutput.context = this.context;
        tell({
          log: `QMA radio output found (${this.constructor?.name || "AudioNode"})`,
        });
      }
      return connect.call(this, destination, ...rest);
    };
  } catch (error) {
    tell({ log: `QMA radio output hook failed: ${error}` });
  }

  const mediaElements = new Set();
  try {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      mediaElements.add(this);
      tell({ log: `radio media element found (${this.tagName})` });
      setTimeout(attach, 0);
      return play.apply(this, args);
    };
  } catch (error) {
    tell({ log: `radio media element hook failed: ${error}` });
  }
  try {
    const AudioElement = window.Audio;
    window.Audio = function (...args) {
      const audio = new AudioElement(...args);
      mediaElements.add(audio);
      return audio;
    };
    window.Audio.prototype = AudioElement.prototype;
  } catch {}
  const findAudio = () =>
    [...mediaElements, ...document.querySelectorAll("audio, video")].find(
      (audio) => audio.src || audio.currentSrc,
    ) ?? null;
  const playing = () => {
    const audio = findAudio();
    return audio ? !audio.paused && !audio.ended : true;
  };
  const cab = {
    speakers: null,
    head: null,
    outside: null,
    equalizer: null,
    reverb: null,
    spectrum: false,
  };
  let sound = null;
  const apply = () => {
    if (!sound) return;
    if (cab.speakers !== null) sound.speakers(cab.speakers);
    if (cab.head !== null) sound.head(cab.head);
    if (cab.outside !== null)
      sound.outside(cab.outside.on, cab.outside.distance);
    if (cab.equalizer !== null) sound.equalizer(cab.equalizer);
    if (cab.reverb !== null) sound.reverb(cab.reverb);
    sound.spectrum(cab.spectrum);
  };
  const attach = () => {
    const source = qmaOutput.node ?? findAudio();
    if (!source || typeof window.westplayCabSound !== "function") return;
    try {
      if (!sound) {
        sound = window.westplayCabSound(
          () => qmaOutput.node ?? findAudio(),
          (message) => tell({ spectrum: message.spectrum }),
          { playing },
        );
        tell({ log: "radio audio joined the cab sound field" });
      } else {
        sound.tick();
      }
      apply();
    } catch (error) {
      tell({ log: `radio sound field failed: ${error}` });
    }
  };
  window.__westplayRadioState = () => ({
    qma: qmaOutput.node?.constructor?.name ?? null,
    context: qmaOutput.context?.state ?? null,
    media: mediaElements.size,
    audio: findAudio()?.tagName ?? null,
    sound: Boolean(sound),
    speakers: cab.speakers !== null,
    head: cab.head !== null,
    reverb: cab.reverb !== null,
  });
  const setCab = (message) => {
    switch (message.action) {
      case "speakers":
        cab.speakers = message.speakers;
        sound?.speakers(message.speakers);
        break;
      case "head":
        cab.head = message;
        sound?.head(message);
        break;
      case "outside":
        cab.outside = message;
        sound?.outside(message.on, message.distance);
        break;
      case "equalizer":
        cab.equalizer = message;
        cab.reverb = message.reverb;
        sound?.equalizer(message);
        sound?.reverb(message.reverb);
        break;
      case "spectrum":
        cab.spectrum = Boolean(message.on);
        sound?.spectrum(cab.spectrum);
        break;
      default:
        return;
    }
    attach();
  };
  window.__westplayRadioCab = setCab;
  window.addEventListener("message", ({ data }) => {
    if (data?.__westplayRadioCab && data.message) setCab(data.message);
  });

  tell({ log: "radio frame ready" });
  setInterval(attach, 500);
  setTimeout(
    () => tell({ log: `radio state ${JSON.stringify(window.__westplayRadioState())}` }),
    2500,
  );
  return "started";
})();
