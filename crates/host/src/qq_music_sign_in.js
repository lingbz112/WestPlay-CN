// WestPlay, in QQ Music's sign-in window (signin.rs): QQ Music's own log-in dialog on y.qq.com. The
// window opens the dialog once; scanning its QR code (or signing in with QQ) is the user's own. Once
// QQ Music's cookies say the account is signed in, this says only that: nothing of the account is read.
;(() => {
  if (!/(^|\.)y\.qq\.com$/.test(location.hostname) || window.top !== window) return
  const post = (message) => window.chrome?.webview?.postMessage(message)
  const cookie = (name) => {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(document.cookie || '')
    return match ? decodeURIComponent(match[1]) : ''
  }
  const signedIn = () => {
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
    const link = document.querySelector('.top_login__link')
    if (!link) return false
    if (link.querySelector('img, [class*="avatar"]')) return true
    const words = String(link.textContent || '').replace(/\s+/g, ' ').trim()
    return Boolean(words && !/登录|登入|sign in/i.test(words))
  }
  let opened = false
  let sent = false
  const look = () => {
    if (sent) return
    if (signedIn()) {
      sent = true
      post({ signedIn: true })
      return
    }
    if (!opened) {
      const login = document.querySelector('.top_login__link, .player_login__link')
      if (login) {
        opened = true
        login.click()
      }
    }
    setTimeout(look, 500)
  }
  look()
})()
