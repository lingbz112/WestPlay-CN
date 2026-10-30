//! NetEase Cloud Music's own web page, hidden under the cabin.
//!
//! The copied Music app is WestPlay's face (`ui/src/cabin/apps/neteaseMusic`). NetEase's page is the engine:
//! one hidden page on music.163.com, whose script (`netease_music.js`) asks the site's plain JSON APIs for
//! what the app shows (home, new, charts, categories, search, playlists, albums, artists, the Library and a
//! song's words) and plays what the app plays in an `<audio>` of its own, on the truck's speakers
//! (`cab_sound.js`).
//!
//! The APIs are the site's own, unsigned ones: the page is music.163.com's, so the browser sends the
//! account's cookies and the site's rights apply as they do in its player. The sign-in is NetEase's own page
//! in a window on the desktop, on this WebView's profile. Nothing of the account leaves the page: the host
//! only forwards the fields the app shows.
//!
//! A song plays from a URL the site gives (`/api/song/enhance/player/url/v1`); one it won't give (no rights,
//! no source) doesn't play, and the app says so. A song with a 30-second trial plays its trial and says
//! `preview`: the app shows a short note.

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::Path;

pub use crate::apple_music::Command;
use crate::apple_music::{Answer, Playback, State};
use crate::signin::{self, Confirming, Progress, SignInWindow};
use crate::speakers::{self, BassManagement, CabinCharacter, CabinReflection, Equalizer, Head, Reverb, Speaker};
use crate::webview::{self, OffscreenWebView, Stage};

/// NetEase Cloud Music's home.
pub const HOME: &str = "https://music.163.com/";

/// What the host tells the page of the cab (never the cabin page's to send): the truck's speakers (`None`: as
/// it is, a truck whose speakers aren't known), the driver's head, and the camera outside (its distance,
/// metres; 0: not known). As Apple Music's and YouTube's.
#[derive(Debug, PartialEq, serde::Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
enum Cab {
    Speakers {
        speakers: Option<Vec<Speaker>>,
    },
    Head {
        #[serde(flatten)]
        head: Head,
    },
    Outside {
        on: bool,
        distance: f32,
    },
    Equalizer {
        #[serde(flatten)]
        equalizer: Equalizer,
        reverb: Reverb,
        character: CabinCharacter,
        reflection: CabinReflection,
        bass: BassManagement,
    },
    Spectrum {
        on: bool,
    },
}

/// What the page was told last of the cab (sent again to a page that loaded anew).
#[derive(Debug, Default)]
struct Told {
    speakers: Option<Option<Vec<Speaker>>>,
    head: Option<Head>,
    camera: Option<(bool, f32)>,
    equalizer: Option<(Equalizer, Reverb, CabinCharacter, CabinReflection, BassManagement)>,
    spectrum: Option<bool>,
    messages: [Option<String>; 5],
}

/// The questions asked of the page, by id, until answered (`MOST` at most: the app gives up on older ones).
#[derive(Debug, Default)]
struct Unanswered(BTreeMap<u32, String>);

impl Unanswered {
    const MOST: usize = 32;

    fn asked(&mut self, id: u32, sent: String) {
        self.0.insert(id, sent);
        while self.0.len() > Self::MOST {
            self.0.pop_first();
        }
    }

    fn answered(&mut self, id: u32) {
        self.0.remove(&id);
    }

    fn clear(&mut self) {
        self.0.clear();
    }

    /// What to ask again, oldest first.
    fn all(&self) -> Vec<String> {
        self.0.values().cloned().collect()
    }
}

#[derive(Debug, PartialEq)]
pub enum Report {
    /// The music's spectrum, while the cab's Equalizer asks for it ([`speakers::read_spectrum`]).
    Spectrum(Vec<u8>),
    State(State),
    /// The sign-in window opened (`true`) or closed.
    SignInWindow(bool),
    /// Signed in in its window, and the page here is yet to say it's signed in (`true`), or it has (or took
    /// too long: `false`).
    Confirming(bool),
    Answer(Box<Answer>),
    /// What plays (`None`: nothing).
    Playback(Option<Box<Playback>>),
    Log(String),
}

pub struct NeteaseMusic {
    view: OffscreenWebView,
    sign_in: RefCell<Option<SignInWindow>>,
    confirming: Confirming,
    pending: RefCell<Vec<Report>>,
    unanswered: RefCell<Unanswered>,
    told: RefCell<Told>,
}

impl NeteaseMusic {
    /// Opens NetEase's page in a WebView of `stage`'s frame (`width` x `height`), hidden under the cabin page.
    pub fn start(stage: &Stage, width: u32, height: u32, user_data: &Path) -> Result<Self, webview::Error> {
        let view = OffscreenWebView::new(stage, width, height, user_data)?;
        view.log_as("netease music")?;
        view.show(false)?;
        stage.add(&view, false)?;
        // The songs whose hosts the page can't take into its sound-field are fetched by the host instead.
        let _ = crate::netease_proxy::start();
        // The truck speakers' sound first: the page's script makes its own of it.
        view.add_startup_script(concat!(include_str!("cab_sound.js"), "\n", include_str!("netease_music.js")))?;
        view.navigate(HOME)?;
        Ok(Self {
            view,
            sign_in: RefCell::new(None),
            confirming: Confirming::default(),
            pending: RefCell::new(Vec::new()),
            unanswered: RefCell::default(),
            told: RefCell::default(),
        })
    }

    /// The truck's speakers (none: its sound plays as it is), the driver's head, and whether the camera is
    /// outside the cab and how far (metres; 0: not known): as Apple Music's.
    pub fn cab(
        &self,
        speakers: Option<&[Speaker]>,
        head: Head,
        outside: bool,
        distance: f32,
        equalizer: Equalizer,
        reverb: Reverb,
        character: CabinCharacter,
        reflection: CabinReflection,
        bass: BassManagement,
        spectrum: bool,
    ) -> windows::core::Result<()> {
        let mut told = self.told.borrow_mut();
        if told.head != Some(head) && head.is_sound() {
            told.head = Some(head);
            let message = serde_json::to_string(&Cab::Head { head }).unwrap_or_default();
            told.messages[1] = Some(message.clone());
            self.view.post_json(&message)?;
        }
        if told.speakers.as_ref().map(Option::as_deref) != Some(speakers) {
            let speakers = speakers.map(<[_]>::to_vec);
            told.speakers = Some(speakers.clone());
            let message = serde_json::to_string(&Cab::Speakers { speakers }).unwrap_or_default();
            told.messages[0] = Some(message.clone());
            self.view.post_json(&message)?;
        }
        let camera = (outside, if outside { (distance * 4.0).round() / 4.0 } else { 0.0 });
        if told.camera != Some(camera) && camera.1.is_finite() {
            told.camera = Some(camera);
            let message = serde_json::to_string(&Cab::Outside { on: camera.0, distance: camera.1 }).unwrap_or_default();
            told.messages[2] = Some(message.clone());
            self.view.post_json(&message)?;
        }
        if told.equalizer != Some((equalizer, reverb, character, reflection, bass)) {
            told.equalizer = Some((equalizer, reverb, character, reflection, bass));
            let message = serde_json::to_string(&Cab::Equalizer { equalizer, reverb, character, reflection, bass })
                .unwrap_or_default();
            told.messages[3] = Some(message.clone());
            self.view.post_json(&message)?;
        }
        if told.spectrum != Some(spectrum) {
            told.spectrum = Some(spectrum);
            let message = serde_json::to_string(&Cab::Spectrum { on: spectrum }).unwrap_or_default();
            told.messages[4] = Some(message.clone());
            self.view.post_json(&message)?;
        }
        Ok(())
    }

    pub fn command(&self, command: &Command) -> windows::core::Result<()> {
        match command {
            Command::SignIn => {
                self.open_sign_in();
                Ok(())
            }
            Command::SignOut => {
                let _ = self.view.delete_cookies();
                self.unanswered.borrow_mut().clear();
                let _ = self.view.navigate(HOME);
                Ok(())
            }
            Command::Ask { id, question } => {
                let sent = serde_json::to_string(&Command::Ask { id: *id, question: question.clone() }).unwrap_or_default();
                self.unanswered.borrow_mut().asked(*id, sent.clone());
                self.view.post_json(&sent)
            }
            _ => self.view.post_json(&serde_json::to_string(command).unwrap_or_default()),
        }
    }

    /// NetEase's sign-in page, opened in a window on the desktop (or brought forward if it is).
    fn open_sign_in(&self) {
        let mut sign_in = self.sign_in.borrow_mut();
        if let Some(window) = sign_in.as_ref() {
            window.bring_forward();
            return;
        }
        match SignInWindow::open(self.view.environment(), &signin::NETEASE_MUSIC) {
            Ok(window) => {
                *sign_in = Some(window);
                self.pending.borrow_mut().push(Report::SignInWindow(true));
            }
            Err(e) => crate::startup::mark(&format!("host: the NetEase sign-in window couldn't open: {e}")),
        }
    }

    /// What the page said since the last call, and the sign-in window opening or closing (signed in, the page
    /// here loads again, signed in).
    pub fn take_reports(&self) -> Vec<Report> {
        let mut reports = std::mem::take(&mut *self.pending.borrow_mut());
        let progress = self.sign_in.borrow().as_ref().map(SignInWindow::progress);
        if let Some(progress @ (Progress::SignedIn | Progress::Closed)) = progress {
            self.sign_in.borrow_mut().take();
            reports.push(Report::SignInWindow(false));
            if progress == Progress::SignedIn {
                let _ = self.view.navigate(HOME);
                self.confirming.start();
                reports.push(Report::Confirming(true));
            }
        }
        for message in self.view.take_page_messages() {
            if let Some(bars) = speakers::read_spectrum(&message) {
                reports.push(Report::Spectrum(bars));
                continue;
            }
            match read_message(&message) {
                Some(Message::Ready) => {
                    // A page loaded anew: where the host's proxy is (for the songs whose hosts can't be), the
                    // cab as it is, and the questions it missed.
                    if let Some(proxy) = crate::netease_proxy::start() {
                        let _ = self.view.post_json(&format!(
                            "{{\"action\":\"proxy\",\"port\":{},\"token\":\"{}\"}}",
                            proxy.port, proxy.token
                        ));
                    }
                    for told in self.told.borrow().messages.iter().flatten() {
                        let _ = self.view.post_json(told);
                    }
                    for sent in self.unanswered.borrow().all() {
                        let _ = self.view.post_json(&sent);
                    }
                }
                Some(Message::State(state)) => reports.push(Report::State(state)),
                Some(Message::Answer(answer)) => {
                    self.unanswered.borrow_mut().answered(answer.answer);
                    reports.push(Report::Answer(answer));
                }
                Some(Message::Playback(playback)) => reports.push(Report::Playback(playback)),
                Some(Message::Log(line)) => reports.push(Report::Log(line)),
                None => {}
            }
        }
        let signed_in = reports.iter().rev().find_map(|report| match report {
            Report::State(state) => Some(state.signed_in),
            _ => None,
        });
        if self.confirming.ended(signed_in) {
            reports.push(Report::Confirming(false));
        }
        reports
    }

    /// Whether the WebView failed since the last call (it's then closed and started again when needed).
    pub fn failed(&self) -> bool {
        self.view.take_failure().is_some()
    }

    /// Takes the WebView off the frame; it closes as it's dropped.
    pub fn close(self, stage: &Stage) {
        let _ = stage.remove(&self.view);
    }
}

/// A message of NetEase's page (`netease_music.js`).
#[derive(Debug, PartialEq)]
enum Message {
    Ready,
    State(State),
    Answer(Box<Answer>),
    Playback(Option<Box<Playback>>),
    Log(String),
}

fn read_message(message: &str) -> Option<Message> {
    let value: serde_json::Value = serde_json::from_str(message).ok()?;
    if value.get("ready").and_then(serde_json::Value::as_bool) == Some(true) {
        return Some(Message::Ready);
    }
    if let Some(line) = value.get("log").and_then(serde_json::Value::as_str) {
        return Some(Message::Log(line.chars().take(400).collect()));
    }
    if value.get("answer").is_some() {
        return match serde_json::from_value::<Answer>(value.clone()) {
            Ok(mut answer) => {
                answer.lyrics = answer.lyrics.map(crate::lyrics::Lyrics::checked);
                Some(Message::Answer(Box::new(answer)))
            }
            Err(_) => {
                let id = value.get("answer").and_then(serde_json::Value::as_u64)?;
                Some(Message::Answer(Box::new(Answer {
                    answer: u32::try_from(id).ok()?,
                    failed: true,
                    ..Default::default()
                })))
            }
        };
    }
    if let Some(playback) = value.get("playback") {
        if playback.is_null() {
            return Some(Message::Playback(None));
        }
        return serde_json::from_value::<Playback>(playback.clone())
            .ok()
            .map(|playback| Message::Playback(Some(Box::new(playback))));
    }
    let state = value.get("state").unwrap_or(&value);
    serde_json::from_value::<State>(state.clone()).ok().map(|state| Message::State(checked_state(state)))
}

/// Only a picture on NetEase's image hosts passes, and only while signed in.
fn checked_state(mut state: State) -> State {
    if !state.signed_in || !state.avatar.as_deref().is_some_and(is_netease_image) {
        state.avatar = None;
    }
    state
}

/// An image on NetEase's own image hosts (`https://p1.music.126.net/…`).
fn is_netease_image(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split('/').next().unwrap_or("");
    host.ends_with(".music.126.net") && host.split('.').next().is_some_and(|part| !part.is_empty() && part.len() <= 4)
}

/// `{"type":"neteaseMusic","signedIn":…,"playing":…,"signingIn":…,"avatar":…}`.
pub fn state_message(state: Option<&State>, signing_in: bool) -> String {
    serde_json::json!({
        "type": "neteaseMusic",
        "signedIn": state.map(|state| state.signed_in),
        "playing": state.map(|state| state.playing),
        "signingIn": signing_in,
        "avatar": state.and_then(|state| state.avatar.as_deref()),
    })
    .to_string()
}

/// `{"type":"neteaseMusicAnswer","id":…,"search":{…}}`.
pub fn answer_message(answer: &Answer) -> String {
    let mut message = serde_json::to_value(answer).unwrap_or_default();
    message["type"] = "neteaseMusicAnswer".into();
    message.to_string()
}

/// `{"type":"neteaseMusicPlayback","playback":{…}}` (`null`: nothing plays).
pub fn playback_message(playback: Option<&Playback>) -> String {
    serde_json::json!({ "type": "neteaseMusicPlayback", "playback": playback }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ready_a_log_a_state_and_a_playback() {
        assert_eq!(read_message(r#"{"ready":true}"#), Some(Message::Ready));
        assert_eq!(read_message(r#"{"log":"hi"}"#), Some(Message::Log("hi".into())));
        let state = read_message(r#"{"state":{"signedIn":true,"playing":false,"avatar":null}}"#);
        assert_eq!(state, Some(Message::State(State { signed_in: true, playing: false, avatar: None })));
        assert_eq!(read_message(r#"{"playback":null}"#), Some(Message::Playback(None)));
        let playback = r##"{"playback":{"track":{"id":"track:1","name":"A","color":"#123456"},"playing":true,"repeat":"off"}}"##;
        assert!(matches!(read_message(playback), Some(Message::Playback(Some(_)))));
    }

    #[test]
    fn reads_an_answer() {
        let message = r##"{"answer":7,"home":{"sections":[{"style":"songs","songs":[{"id":"track:1","name":"A","color":"#123456"}]}]}}"##;
        match read_message(message) {
            Some(Message::Answer(answer)) => {
                assert_eq!(answer.answer, 7);
                assert!(answer.home.is_some());
            }
            other => panic!("not an answer: {other:?}"),
        }
    }

    #[test]
    fn makes_cabin_messages() {
        let state: serde_json::Value = serde_json::from_str(&state_message(None, false)).unwrap();
        assert_eq!(state["type"], "neteaseMusic");
        assert!(state["signedIn"].is_null());
        assert!(state["playing"].is_null());
        assert_eq!(state["signingIn"], false);
        assert!(state["avatar"].is_null());
        let playback: serde_json::Value = serde_json::from_str(&playback_message(None)).unwrap();
        assert_eq!(playback["type"], "neteaseMusicPlayback");
        assert!(playback["playback"].is_null());
    }

    #[test]
    fn passes_on_only_the_accounts_picture_from_neteases_hosts() {
        let mut state = State { signed_in: true, playing: false, avatar: Some("https://p1.music.126.net/x.jpg".into()) };
        assert_eq!(checked_state(state.clone()).avatar.as_deref(), Some("https://p1.music.126.net/x.jpg"));
        state.avatar = Some("https://evil.example.com/x.jpg".into());
        assert_eq!(checked_state(state.clone()).avatar, None);
        state.signed_in = false;
        state.avatar = Some("https://p1.music.126.net/x.jpg".into());
        assert_eq!(checked_state(state).avatar, None);
    }
}
