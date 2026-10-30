// NetEase Cloud Music's sign-in window (signin.rs): its own log-in page on music.163.com, which says when
// the account is signed in. Polled from the window's own page, so the window only has to be open.
(() => {
  if (!/(^|\.)music\.163\.com$/.test(location.hostname)) return;
  const post = (message) => window.chrome?.webview?.postMessage(message);
  let said = false;
  const check = async () => {
    if (said) return;
    try {
      const response = await fetch("/api/nuser/account/get", { credentials: "include", cache: "no-store" });
      const answer = await response.json();
      if (answer && answer.account) {
        said = true;
        post({ signedIn: true });
      }
    } catch {}
  };
  setInterval(check, 1500);
  check();
})();
