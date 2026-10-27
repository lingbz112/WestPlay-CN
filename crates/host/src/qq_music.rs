//! QQ Music's own web pages, hidden under the cabin.
//!
//! The copied Music app is WestPlay's face (`ui/src/cabin/apps/qqMusic`). QQ Music's pages are the
//! engine: a browser page answers the app's questions (home, search, playlists, artists, the Library,
//! lyrics) and queues songs, and a player page plays them and reports what plays. Both pages share
//! one WebView2 profile, so QQ Music's own sign-in is shared too.
//!
//! QQ Music only plays for a signed-in account. Without one the pages still answer (search may be
//! empty), and the app says it can't play. The account's cookies and tokens stay in QQ Music's page;
//! the host only forwards the fields the app shows.
//!
//! The page script (`qq_music.js`) uses the site's own DOM and JSON-LD: songs, albums and playlists
//! have stable pages and structured metadata. The player controls are the player page's own buttons;
//! `cab_sound.js` takes the player's sound when the browser exposes an audio element.

use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant};

pub use crate::apple_music::Command;
use crate::apple_music::{Answer, Playback, State};
use crate::signin::{self, Confirming, Progress, SignInWindow};
use crate::speakers::{self, Equalizer, Head, Speaker};
use crate::webview::{self, HiddenWebView, Stage};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN, COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP,
    COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE, COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_LEFT_BUTTON,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE,
};
use windows::Win32::Foundation::POINT;

/// QQ Music's home.
pub const HOME: &str = "https://y.qq.com/";
/// Its standalone player, where the player's own buttons live.
pub const PLAYER: &str = "https://y.qq.com/n/ryqq_v2/player";

/// What the host tells the player of the cab.
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
    },
    Spectrum {
        on: bool,
    },
}

/// What the player was told last, sent again when its page loads anew.
#[derive(Debug, Default)]
struct Told {
    speakers: Option<Option<Vec<Speaker>>>,
    head: Option<Head>,
    camera: Option<(bool, f32)>,
    equalizer: Option<Equalizer>,
    spectrum: Option<bool>,
    messages: [Option<String>; 5],
}

/// The questions asked of the browser page, by id, until answered.
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

    fn latest(&self) -> Option<String> {
        self.0.values().next_back().cloned()
    }
}

/// Which of the two pages a message came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Browse,
    Player,
}

/// What the pages said.
#[derive(Debug, PartialEq)]
pub enum Report {
    Spectrum(Vec<u8>),
    State(State),
    SignInWindow(bool),
    Confirming(bool),
    Answer(Box<Answer>),
    Playback(Option<Box<Playback>>),
    Queued,
}

pub struct QqMusic {
    browse: HiddenWebView,
    player: HiddenWebView,
    sign_in: RefCell<Option<SignInWindow>>,
    confirming: Confirming,
    pending: RefCell<Vec<Report>>,
    unanswered: RefCell<Unanswered>,
    /// The last `prepare` sent to the browser page, until it says `queued`.
    pending_prepare: RefCell<Option<String>>,
    /// A song was queued: the player page is to play when it's ready.
    pending_play: Cell<bool>,
    /// The volume chosen in the cabin, sent again whenever QQ replaces its player page.
    volume: Cell<Option<f64>>,
    told: RefCell<Told>,
    browse_rendering: Cell<bool>,
    player_rendering: Cell<bool>,
    browse_hidden_at: Cell<Option<Instant>>,
    player_hidden_at: Cell<Option<Instant>>,
}

impl QqMusic {
    pub fn start(_stage: &Stage, width: u32, height: u32, user_data: &Path) -> Result<Self, webview::Error> {
        let browse = HiddenWebView::new(width, height, user_data)?;
        browse.log_as("qq music browse")?;
        browse.show(false)?;
        browse.add_startup_script(concat!(
            "window.__westplayRole='browse';\n",
            include_str!("cab_sound.js"),
            "\n",
            include_str!("qq_music.js")
        ))?;
        browse.navigate(HOME)?;

        // One environment for both pages: they share QQ Music's profile, cookies and login. A second
        // environment on the same profile is refused by WebView2 (ERROR_INVALID_STATE).
        let player = HiddenWebView::with_environment(width, height, browse.environment().clone())?;
        player.log_as("qq music player")?;
        player.show(false)?;
        player.add_startup_script(concat!(
            "window.__westplayRole='player';\n",
            include_str!("cab_sound.js"),
            "\n",
            include_str!("qq_music.js")
        ))?;
        player.add_frame_script(concat!(include_str!("cab_sound.js"), "\n", include_str!("qq_radio_frame.js")))?;
        player.navigate(PLAYER)?;

        Ok(Self {
            browse,
            player,
            sign_in: RefCell::new(None),
            confirming: Confirming::default(),
            pending: RefCell::new(Vec::new()),
            unanswered: RefCell::default(),
            pending_prepare: RefCell::new(None),
            pending_play: Cell::new(false),
            volume: Cell::new(None),
            told: RefCell::default(),
            browse_rendering: Cell::new(true),
            player_rendering: Cell::new(true),
            browse_hidden_at: Cell::new(None),
            player_hidden_at: Cell::new(None),
        })
    }

    /// The truck's speakers, the driver's head, the camera, the tone and the spectrum, as YouTube's.
    pub fn cab(
        &self,
        speakers: Option<&[Speaker]>,
        head: Head,
        outside: bool,
        distance: f32,
        equalizer: Equalizer,
        spectrum: bool,
    ) -> windows::core::Result<()> {
        let mut told = self.told.borrow_mut();
        if told.head != Some(head) && head.is_sound() {
            told.head = Some(head);
            let message = serde_json::to_string(&Cab::Head { head }).unwrap_or_default();
            told.messages[1] = Some(message.clone());
            self.player.post_json(&message)?;
            self.tell_frame(&message);
        }
        if told.speakers.as_ref().map(Option::as_deref) != Some(speakers) {
            let speakers = speakers.map(<[_]>::to_vec);
            told.speakers = Some(speakers.clone());
            let message = serde_json::to_string(&Cab::Speakers { speakers }).unwrap_or_default();
            told.messages[0] = Some(message.clone());
            self.player.post_json(&message)?;
            self.tell_frame(&message);
        }
        let camera = (outside, if outside { (distance * 4.0).round() / 4.0 } else { 0.0 });
        if told.camera != Some(camera) && camera.1.is_finite() {
            told.camera = Some(camera);
            let message = serde_json::to_string(&Cab::Outside { on: camera.0, distance: camera.1 }).unwrap_or_default();
            told.messages[2] = Some(message.clone());
            self.player.post_json(&message)?;
            self.tell_frame(&message);
        }
        if told.equalizer != Some(equalizer) {
            told.equalizer = Some(equalizer);
            let message = serde_json::to_string(&Cab::Equalizer { equalizer }).unwrap_or_default();
            told.messages[3] = Some(message.clone());
            self.player.post_json(&message)?;
            self.tell_frame(&message);
        }
        if told.spectrum != Some(spectrum) {
            told.spectrum = Some(spectrum);
            let message = serde_json::to_string(&Cab::Spectrum { on: spectrum }).unwrap_or_default();
            told.messages[4] = Some(message.clone());
            self.player.post_json(&message)?;
            self.tell_frame(&message);
        }
        Ok(())
    }

    /// Delivers a cabin setting straight into QQ's radio frame, without relying on top-level `postMessage`
    /// (the radio frame is sandboxed and QQ owns the top page's message routing).
    fn tell_frame(&self, message: &str) {
        let script = format!("window.__westplayRadioCab?.({message});");
        let _ = self.player.run_in_frame(&script);
    }

    pub fn command(&self, command: &Command) -> windows::core::Result<()> {
        match command {
            Command::SignIn => {
                self.open_sign_in();
                Ok(())
            }
            Command::SignOut => {
                let _ = self.browse.delete_cookies();
                let _ = self.player.delete_cookies();
                self.unanswered.borrow_mut().clear();
                *self.pending_prepare.borrow_mut() = None;
                self.pending_play.set(false);
                self.render(Role::Browse, true);
                self.render(Role::Player, true);
                let _ = self.browse.navigate(HOME);
                let _ = self.player.navigate(PLAYER);
                Ok(())
            }
            Command::Start => {
                let message = r#"{"action":"start"}"#;
                self.browse.post_json(message)?;
                self.player.post_json(message)
            }
            Command::Ask { id, question } => {
                let sent =
                    serde_json::to_string(&Command::Ask { id: *id, question: question.clone() }).unwrap_or_default();
                self.unanswered.borrow_mut().asked(*id, sent.clone());
                self.browse.post_json(&sent)
            }
            Command::Play { id, songs, index, shuffle, .. } => {
                if id.is_none() && songs.is_none() {
                    return self.player.post_json(r#"{"action":"play"}"#);
                }
                let prepare = serde_json::json!({
                    "action": "prepare",
                    "id": id,
                    "songs": songs,
                    "index": index,
                    "shuffle": shuffle,
                })
                .to_string();
                *self.pending_prepare.borrow_mut() = Some(prepare.clone());
                self.pending_play.set(true);
                self.browse.post_json(&prepare)
            }
            Command::Volume { percent } => {
                if percent.is_finite() {
                    self.volume.set(Some(percent.clamp(0.0, 100.0)));
                }
                log!("[qq music] command {}", serde_json::to_string(command).unwrap_or_default());
                self.player.post_json(&serde_json::to_string(command).unwrap_or_default())
            }
            Command::Seek { .. } => {
                log!("[qq music] command {}", serde_json::to_string(command).unwrap_or_default());
                self.player.post_json(&serde_json::to_string(command).unwrap_or_default())
            }
            _ => self.player.post_json(&serde_json::to_string(command).unwrap_or_default()),
        }
    }

    fn open_sign_in(&self) {
        let mut sign_in = self.sign_in.borrow_mut();
        if let Some(window) = sign_in.as_ref() {
            window.bring_forward();
            return;
        }
        match SignInWindow::open(self.browse.environment(), &signin::QQ_MUSIC) {
            Ok(window) => {
                *sign_in = Some(window);
                self.pending.borrow_mut().push(Report::SignInWindow(true));
            }
            Err(e) => crate::startup::mark(&format!("host: the QQ Music sign-in window couldn't open: {e}")),
        }
    }

    /// Whether Chromium presents a hardware surface for one of QQ Music's hidden pages. Its scripts and
    /// audio keep running while it is off; capture overlays then have no second game-sized frame to select.
    fn render(&self, role: Role, rendered: bool) {
        let view = match role {
            Role::Browse => &self.browse,
            Role::Player => &self.player,
        };
        if let Err(error) = view.set_rendering(rendered) {
            log!(
                "[qq music] couldn't {} the {} page's compositor: {error}",
                if rendered { "resume" } else { "pause" },
                if role == Role::Browse { "browser" } else { "player" }
            );
            return;
        }
        let (rendering, hidden_at) = match role {
            Role::Browse => (&self.browse_rendering, &self.browse_hidden_at),
            Role::Player => (&self.player_rendering, &self.player_hidden_at),
        };
        rendering.set(rendered);
        hidden_at.set((!rendered).then(Instant::now));
    }

    /// A hidden page checks in regularly. If Chromium ever pauses it completely, show it again rather than
    /// losing music or navigation; the cost is the recording artifact, never a dead player.
    fn keep_hidden_page_alive(&self, role: Role) {
        let (rendering, hidden_at) = match role {
            Role::Browse => (&self.browse_rendering, &self.browse_hidden_at),
            Role::Player => (&self.player_rendering, &self.player_hidden_at),
        };
        if !rendering.get() {
            hidden_at.set(Some(Instant::now()));
        }
    }

    fn restore_if_paused(&self) {
        for role in [Role::Browse, Role::Player] {
            let (rendering, hidden_at) = match role {
                Role::Browse => (&self.browse_rendering, &self.browse_hidden_at),
                Role::Player => (&self.player_rendering, &self.player_hidden_at),
            };
            if !rendering.get() && hidden_at.get().is_none_or(|at| at.elapsed() > Duration::from_secs(5)) {
                log!(
                    "[qq music] {} page stopped reporting while hidden; its compositor is resumed",
                    if role == Role::Browse { "browser" } else { "player" }
                );
                self.render(role, true);
            }
        }
    }

    pub fn take_reports(&self) -> Vec<Report> {
        let mut reports = std::mem::take(&mut *self.pending.borrow_mut());
        let progress = self.sign_in.borrow().as_ref().map(SignInWindow::progress);
        if let Some(progress @ (Progress::SignedIn | Progress::Closed)) = progress {
            self.sign_in.borrow_mut().take();
            reports.push(Report::SignInWindow(false));
            if progress == Progress::SignedIn {
                self.render(Role::Browse, true);
                self.render(Role::Player, true);
                let _ = self.browse.navigate(HOME);
                let _ = self.player.navigate(PLAYER);
                self.confirming.start();
                reports.push(Report::Confirming(true));
            }
        }

        let mut messages: Vec<(Role, String)> =
            self.browse.take_page_messages().into_iter().map(|message| (Role::Browse, message)).collect();
        messages.extend(self.player.take_page_messages().into_iter().map(|message| (Role::Player, message)));
        for (source, message) in messages {
            self.keep_hidden_page_alive(source);
            if let Some(bars) = speakers::read_spectrum(&message) {
                reports.push(Report::Spectrum(bars));
                continue;
            }
            match read_message(&message) {
                Some(Message::Ready(Role::Browse)) => {
                    // Each library shelf has its own URL. Re-sending every unanswered shelf after a load
                    // would make this one browser bounce between them forever; the newest question is the
                    // page the player is looking at.
                    for sent in self.unanswered.borrow().latest().into_iter() {
                        let _ = self.browse.post_json(&sent);
                    }
                    if let Some(prepare) = self.pending_prepare.borrow().as_ref() {
                        let _ = self.browse.post_json(prepare);
                    }
                    self.render(Role::Browse, false);
                }
                Some(Message::Ready(Role::Player)) => {
                    for told in self.told.borrow().messages.iter().flatten() {
                        let _ = self.player.post_json(told);
                    }
                    if let Some(percent) = self.volume.get() {
                        log!("[qq music] restoring volume {percent:.0}% before playback");
                        let volume = serde_json::json!({ "action": "volume", "percent": percent });
                        let _ = self.player.post_json(&volume.to_string());
                    }
                    if self.pending_play.replace(false) {
                        let _ = self.player.post_json(r#"{"action":"play"}"#);
                    }
                    self.render(Role::Player, false);
                }
                Some(Message::Render(role)) => self.render(role, true),
                Some(Message::Queued { player }) => {
                    *self.pending_prepare.borrow_mut() = None;
                    self.pending_play.set(true);
                    // Songs share `playSongData`; a server-controlled radio has its own player route.
                    self.render(Role::Player, true);
                    let _ = self.player.navigate(player.as_deref().unwrap_or(PLAYER));
                    let _ = self.player.post_json(r#"{"action":"play"}"#);
                    reports.push(Report::Queued);
                }
                Some(Message::Click { x, y }) => {
                    self.render(Role::Player, true);
                    let point =
                        POINT { x: x.clamp(0.0, 10_000.0).round() as i32, y: y.clamp(0.0, 10_000.0).round() as i32 };
                    log!("[qq music] native click at {},{}", point.x, point.y);
                    let _ = self.player.send_mouse(
                        COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
                        COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE,
                        0,
                        point,
                    );
                    let _ = self.player.send_mouse(
                        COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN,
                        COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_LEFT_BUTTON,
                        0,
                        point,
                    );
                    let _ = self.player.send_mouse(
                        COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP,
                        COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE,
                        0,
                        point,
                    );
                }
                Some(Message::Drag { from_x, from_y, to_x, to_y }) => {
                    self.render(Role::Player, true);
                    let point = |x: f64, y: f64| POINT {
                        x: x.clamp(0.0, 10_000.0).round() as i32,
                        y: y.clamp(0.0, 10_000.0).round() as i32,
                    };
                    let from = point(from_x, from_y);
                    let to = point(to_x, to_y);
                    log!("[qq music] native drag {},{} -> {},{}", from.x, from.y, to.x, to.y);
                    let _ = self.player.send_mouse(
                        COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
                        COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE,
                        0,
                        from,
                    );
                    let _ = self.player.send_mouse(
                        COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN,
                        COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_LEFT_BUTTON,
                        0,
                        from,
                    );
                    for step in 1..=6 {
                        let point =
                            POINT { x: from.x + (to.x - from.x) * step / 6, y: from.y + (to.y - from.y) * step / 6 };
                        let _ = self.player.send_mouse(
                            COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
                            COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_LEFT_BUTTON,
                            0,
                            point,
                        );
                    }
                    let _ = self.player.send_mouse(
                        COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP,
                        COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS_NONE,
                        0,
                        to,
                    );
                }
                Some(Message::Log(line)) => log!("[qq music] {line}"),
                Some(Message::State(state)) => reports.push(Report::State(state)),
                Some(Message::Answer(answer)) => {
                    self.unanswered.borrow_mut().answered(answer.answer);
                    reports.push(Report::Answer(answer));
                    self.render(source, false);
                }
                Some(Message::Playback(playback)) => {
                    reports.push(Report::Playback(playback));
                    self.render(Role::Player, false);
                }
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
        if self.player.take_frame_ready() {
            for message in self.told.borrow().messages.iter().flatten() {
                self.tell_frame(message);
            }
            let _ = self
                .player
                .inspect_frame("QQ radio frame state", "JSON.stringify(window.__westplayRadioState?.() ?? null)");
        }
        self.restore_if_paused();
        reports
    }

    pub fn failed(&self) -> bool {
        self.browse.take_failure().is_some() || self.player.take_failure().is_some()
    }

    pub fn close(self, _stage: &Stage) {
        // HiddenWebViews are not part of the composition Stage.
    }
}

#[derive(Debug, PartialEq)]
enum Message {
    Ready(Role),
    Render(Role),
    Queued { player: Option<String> },
    Click { x: f64, y: f64 },
    Drag { from_x: f64, from_y: f64, to_x: f64, to_y: f64 },
    Log(String),
    State(State),
    Answer(Box<Answer>),
    Playback(Option<Box<Playback>>),
}

fn read_message(message: &str) -> Option<Message> {
    let value: serde_json::Value = serde_json::from_str(message).ok()?;
    let role = match value.get("role").and_then(serde_json::Value::as_str) {
        Some("player") => Role::Player,
        _ => Role::Browse,
    };
    if value.get("ready").and_then(serde_json::Value::as_bool) == Some(true) {
        return Some(Message::Ready(role));
    }
    if value.get("render").and_then(serde_json::Value::as_bool) == Some(true) {
        return Some(Message::Render(role));
    }
    if value.get("queued").and_then(serde_json::Value::as_bool) == Some(true) {
        let player = value
            .get("player")
            .and_then(serde_json::Value::as_str)
            .filter(|url| is_radio_player(url))
            .map(str::to_owned);
        return Some(Message::Queued { player });
    }
    if let Some(line) = value.get("log").and_then(serde_json::Value::as_str) {
        return Some(Message::Log(line.chars().take(400).collect()));
    }
    if let Some(click) = value.get("click") {
        let x = click.get("x")?.as_f64()?;
        let y = click.get("y")?.as_f64()?;
        if x.is_finite() && y.is_finite() {
            return Some(Message::Click { x, y });
        }
    }
    if let Some(drag) = value.get("drag") {
        let from_x = drag.get("fromX")?.as_f64()?;
        let from_y = drag.get("fromY")?.as_f64()?;
        let to_x = drag.get("toX")?.as_f64()?;
        let to_y = drag.get("toY")?.as_f64()?;
        if [from_x, from_y, to_x, to_y].into_iter().all(f64::is_finite) {
            return Some(Message::Drag { from_x, from_y, to_x, to_y });
        }
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
    serde_json::from_value::<State>(state.clone()).ok().map(Message::State)
}

/// The one page the radio player may navigate to: a numeric QQ Music station id.
fn is_radio_player(url: &str) -> bool {
    url.strip_prefix("https://y.qq.com/n/ryqq_v2/player_radio#id=")
        .is_some_and(|id| (1..=12).contains(&id.len()) && id.bytes().all(|byte| byte.is_ascii_digit()))
}

/// `{"type":"qqMusic","signedIn":…,"playing":…,"signingIn":…,"avatar":…}`.
pub fn state_message(state: Option<&State>, signing_in: bool) -> String {
    serde_json::json!({
        "type": "qqMusic",
        "signedIn": state.map(|state| state.signed_in),
        "playing": state.map(|state| state.playing),
        "signingIn": signing_in,
        "avatar": state.and_then(|state| state.avatar.as_deref()),
    })
    .to_string()
}

/// `{"type":"qqMusicAnswer","id":…,"search":{…}}`.
pub fn answer_message(answer: &Answer) -> String {
    let mut message = serde_json::to_value(answer).unwrap_or_default();
    message["type"] = "qqMusicAnswer".into();
    message.to_string()
}

/// `{"type":"qqMusicPlayback","playback":{…}}` (`null`: nothing plays).
pub fn playback_message(playback: Option<&Playback>) -> String {
    serde_json::json!({ "type": "qqMusicPlayback", "playback": playback }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ready_and_queued() {
        assert_eq!(read_message(r#"{"role":"player","ready":true}"#), Some(Message::Ready(Role::Player)));
        assert_eq!(read_message(r#"{"role":"browse","ready":true}"#), Some(Message::Ready(Role::Browse)));
        assert_eq!(read_message(r#"{"role":"browse","queued":true}"#), Some(Message::Queued { player: None }));
        assert_eq!(
            read_message(r#"{"role":"browse","queued":true,"player":"https://y.qq.com/n/ryqq_v2/player_radio#id=99"}"#),
            Some(Message::Queued { player: Some("https://y.qq.com/n/ryqq_v2/player_radio#id=99".into()) })
        );
        assert_eq!(
            read_message(
                r#"{"role":"browse","queued":true,"player":"https://example.com/n/ryqq_v2/player_radio#id=99"}"#
            ),
            Some(Message::Queued { player: None })
        );
    }

    #[test]
    fn reads_a_state() {
        assert_eq!(
            read_message(r#"{"role":"player","state":{"signedIn":true,"playing":false,"avatar":null}}"#),
            Some(Message::State(State { signed_in: true, playing: false, avatar: None }))
        );
    }

    #[test]
    fn reads_a_search_answer() {
        let message = r#"{"role":"browse","answer":7,"search":{"top":[],"songs":[],"artists":[],"albums":[],"playlists":[],"stations":[]}}"#;
        match read_message(message) {
            Some(Message::Answer(answer)) => {
                assert_eq!(answer.answer, 7);
                assert!(answer.search.is_some());
            }
            other => panic!("not an answer: {other:?}"),
        }
    }

    #[test]
    fn makes_cabin_messages() {
        let state: serde_json::Value = serde_json::from_str(&state_message(None, false)).unwrap();
        assert_eq!(state["type"], "qqMusic");
        assert!(state["signedIn"].is_null());
        assert!(state["playing"].is_null());
        assert_eq!(state["signingIn"], false);
        assert!(state["avatar"].is_null());
        let playback: serde_json::Value = serde_json::from_str(&playback_message(None)).unwrap();
        assert_eq!(playback["type"], "qqMusicPlayback");
        assert!(playback["playback"].is_null());
    }

    /// The first Home answer is already complete: QQ's lazy images and webpack APIs don't need a second visit.
    #[test]
    #[ignore = "loads QQ Music in WebView2"]
    fn the_first_home_answer_has_real_covers() {
        use std::time::{Duration, Instant};
        use windows::Win32::System::Com::{COINIT_APARTMENTTHREADED, CoInitializeEx};

        // SAFETY: COM on this test's own thread, once, before anything uses it.
        unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok().unwrap() };
        let profile = std::env::temp_dir().join(format!("westplay-qq-home-covers-{}", std::process::id()));
        let stage = Stage::new(1280, 720).unwrap();
        let music = QqMusic::start(&stage, 1280, 720, &profile).unwrap();
        music.command(&Command::Ask { id: 1, question: crate::apple_music::Question::Home }).unwrap();

        let mut answer = None;
        let until = Instant::now() + Duration::from_secs(45);
        while Instant::now() < until && answer.is_none() {
            crate::pump_messages();
            for report in music.take_reports() {
                if let Report::Answer(reply) = report {
                    if reply.answer == 1 {
                        answer = Some(reply);
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let answer = answer.expect("Home wasn't answered");
        assert!(!answer.failed, "Home failed");
        let page = answer.home.expect("a Home page");
        let missing: Vec<(String, Option<String>)> = page
            .sections
            .into_iter()
            .flat_map(|section| {
                section
                    .items
                    .into_iter()
                    .map(|item| (item.name, item.image))
                    .chain(section.songs.into_iter().map(|song| (song.name, song.image)))
            })
            .filter(|(_, image)| {
                image.as_deref().is_none_or(|image| {
                    image.contains("mediastyle/global/img/album_300")
                        || image.contains("blank.gif")
                        || image.contains("transparent.gif")
                })
            })
            .collect();
        println!("first Home covers missing: {missing:?}");
        assert!(missing.is_empty(), "the first Home answer still had missing covers: {missing:?}");
        music.close(&stage);
        let _ = std::fs::remove_dir_all(profile);
    }
}
