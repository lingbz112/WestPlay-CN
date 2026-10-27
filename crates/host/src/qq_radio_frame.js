// QQ Music's radio player runs its audio engine in this cross-origin iframe. WebView2 injects this
// script into that frame, where the top document cannot reach its AudioContext. The script joins QMA's
// output to the cab sound field and relays the cab's speakers and driver through the parent page.
(() => {
  if (window.top === window) return;
  if (!/(^|\.)u\.y\.qq\.com$/.test(location.hostname)) return;
  if (window.__westplayRadioFrameStarted) return;
  window.__westplayRadioFrameStarted = true;

  const tellTop = (message) =>
    window.top.postMessage({ __westplayRadioFrame: true, ...message }, "*");
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
        tellTop({
          log: `QMA radio output found (${this.constructor?.name || "AudioNode"})`,
        });
      }
      return connect.call(this, destination, ...rest);
    };
  } catch (error) {
    tellTop({ log: `QMA radio output hook failed: ${error}` });
  }

  const findAudio = () =>
    [...document.querySelectorAll("audio")].find(
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
    sound.spectrum(cab.spectrum);
  };
  const attach = () => {
    const source = qmaOutput.node ?? findAudio();
    if (!source || typeof window.westplayCabSound !== "function") return;
    try {
      if (!sound) {
        sound = window.westplayCabSound(
          () => qmaOutput.node ?? findAudio(),
          (message) => tellTop({ spectrum: message.spectrum }),
          { playing },
        );
        tellTop({ log: "radio audio joined the cab sound field" });
      } else {
        sound.tick();
      }
      apply();
    } catch (error) {
      tellTop({ log: `radio sound field failed: ${error}` });
    }
  };
  window.addEventListener("message", ({ data }) => {
    if (!data?.__westplayRadioCab || !data.message) return;
    const message = data.message;
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
        sound?.equalizer(message);
        break;
      case "spectrum":
        cab.spectrum = Boolean(message.on);
        sound?.spectrum(cab.spectrum);
        break;
      default:
        return;
    }
    attach();
  });

  tellTop({ ready: true });
  setInterval(attach, 500);
})();
