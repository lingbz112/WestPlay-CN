//! radio.cn's live stations, in a page of the site's own hidden under the cabin.
//!
//! The copied Radio app is WestPlay's face (`ui/src/cabin/apps/radio`). This page is the engine: radio.cn's
//! own page (`https://www.radio.cn`), whose script (`radio.js`) asks the site's signed JSON APIs for the
//! stations of a province, and plays what the app plays in an <audio> of its own, on the truck's speakers
//! (`cab_sound.js`). The streams are HLS (`hls.min.js`), or plain mp3 for the few stations that offer one.
//!
//! The page is radio.cn's, so the API's `Origin` is `https://www.radio.cn` and the site's rules apply as in
//! its player. Nothing of an account is involved: the host only forwards the fields the app shows.

use std::cell::{Cell, RefCell};
use std::path::Path;

use crate::speakers::{self, BassManagement, CabinCharacter, CabinReflection, Equalizer, Head, Reverb, Speaker};
use crate::webview::{self, OffscreenWebView, Stage};

/// radio.cn's home, on the site's own origin (the API allows its requests).
pub const HOME: &str = "https://www.radio.cn/pc-portal/home/index.html";

/// What the page is asked: run, a province's stations, a station (or playing on), pause, and the volume.
#[derive(Debug, PartialEq, serde::Deserialize, serde::Serialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Command {
    Start,
    /// The stations of a province (`region`: its code, `0` for the national ones).
    Stations {
        region: String,
    },
    /// A station (`id` of `region`), from its start; the same one again plays on.
    Play {
        id: String,
        region: String,
    },
    Pause,
    /// The page's player's volume, 0 to 100.
    Volume {
        percent: f64,
    },
}

/// A station as the app shows it: its id, its province (`region`: the code), its name, what it plays now, and
/// its cover on radio.cn's image host.
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct Station {
    pub id: String,
    #[serde(default)]
    pub region: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub program: String,
    #[serde(default)]
    pub image: Option<String>,
}

/// What the radio plays: the station, whether it plays, whether its sound is yet to come, the volume (0 to 1),
/// and whether it couldn't play (a stream that didn't come).
#[derive(Clone, Debug, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct Playback {
    #[serde(default)]
    pub station: Option<Station>,
    pub playing: bool,
    #[serde(default)]
    pub loading: bool,
    #[serde(default)]
    pub volume: Option<f64>,
    #[serde(default)]
    pub failed: bool,
}

/// What the host tells the page of the cab (never the cabin page's to send): the truck's speakers (`None`: as
/// it is, a truck whose speakers aren't known), the driver's head, and the camera outside (its distance,
/// metres; 0: not known). As NetEase Cloud Music's.
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
        #[serde(rename = "bassManagement")]
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

#[derive(Debug, PartialEq)]
pub enum Report {
    /// The stations' spectrum, while the cab's Equalizer asks for it (`speakers::read_spectrum`).
    Spectrum(Vec<u8>),
    /// A province's stations (`failed`: radio.cn didn't say).
    Stations {
        region: String,
        stations: Vec<Station>,
        failed: bool,
    },
    /// What plays (`None`: nothing).
    Playback(Option<Box<Playback>>),
    Log(String),
}

/// The stations' page, hidden under the cabin page.
pub struct Radio {
    view: OffscreenWebView,
    pending: RefCell<Vec<Report>>,
    told: RefCell<Told>,
    /// The last province asked for, as the command sent (asked again by a page that loaded anew).
    stations: RefCell<Option<String>>,
    /// The station asked to play (none: paused), as the command sent (sent again by a page that loaded anew).
    wanted: RefCell<Option<String>>,
    /// The volume last asked for (percent), sent again to a page that loaded anew.
    volume: Cell<Option<f64>>,
}

impl Radio {
    /// Opens radio.cn's page in a WebView of `stage`'s frame (`width` x `height`), hidden under the cabin page.
    pub fn start(stage: &Stage, width: u32, height: u32, user_data: &Path) -> Result<Self, webview::Error> {
        let view = OffscreenWebView::new(stage, width, height, user_data)?;
        view.log_as("radio")?;
        view.show(false)?;
        stage.add(&view, false)?;
        // The streams' parser, the truck's speakers, and the page's own script, in that order.
        view.add_startup_script(concat!(
            include_str!("hls.min.js"),
            "\n",
            include_str!("cab_sound.js"),
            "\n",
            include_str!("radio.js")
        ))?;
        view.navigate(HOME)?;
        Ok(Self {
            view,
            pending: RefCell::default(),
            told: RefCell::default(),
            stations: RefCell::default(),
            wanted: RefCell::default(),
            volume: Cell::default(),
        })
    }

    /// The truck's speakers (none: its sound plays as it is), the driver's head, and whether the camera is
    /// outside the cab and how far (metres; 0: not known): as NetEase Cloud Music's.
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
            Command::Stations { .. } => {
                let sent = serde_json::to_string(command).unwrap_or_default();
                *self.stations.borrow_mut() = Some(sent.clone());
                self.view.post_json(&sent)
            }
            Command::Play { .. } => {
                let sent = serde_json::to_string(command).unwrap_or_default();
                *self.wanted.borrow_mut() = Some(sent.clone());
                self.view.post_json(&sent)
            }
            Command::Pause => {
                *self.wanted.borrow_mut() = None;
                self.view.post_json(&serde_json::to_string(command).unwrap_or_default())
            }
            Command::Volume { percent } => {
                self.volume.set(Some(*percent));
                self.view.post_json(&serde_json::to_string(command).unwrap_or_default())
            }
            Command::Start => self.view.post_json(&serde_json::to_string(command).unwrap_or_default()),
        }
    }

    /// What the page said since the last call.
    pub fn take_reports(&self) -> Vec<Report> {
        let mut reports = std::mem::take(&mut *self.pending.borrow_mut());
        for message in self.view.take_page_messages() {
            if let Some(bars) = speakers::read_spectrum(&message) {
                reports.push(Report::Spectrum(bars));
                continue;
            }
            match read_message(&message) {
                Some(Message::Ready) => {
                    // A page loaded anew: the province it was asked for, the volume, the station that was
                    // playing, and the cab as it is.
                    if let Some(sent) = self.stations.borrow().as_ref() {
                        let _ = self.view.post_json(sent);
                    }
                    if let Some(percent) = self.volume.get() {
                        let sent = serde_json::to_string(&Command::Volume { percent }).unwrap_or_default();
                        let _ = self.view.post_json(&sent);
                    }
                    if let Some(sent) = self.wanted.borrow().as_ref() {
                        let _ = self.view.post_json(sent);
                    }
                    for told in self.told.borrow().messages.iter().flatten() {
                        let _ = self.view.post_json(told);
                    }
                }
                Some(Message::Stations { region, stations, failed }) => {
                    reports.push(Report::Stations { region, stations, failed })
                }
                Some(Message::Playback(playback)) => reports.push(Report::Playback(playback)),
                Some(Message::Log(line)) => reports.push(Report::Log(line)),
                None => {}
            }
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

/// A message of radio.cn's page (`radio.js`).
#[derive(Debug, PartialEq)]
enum Message {
    Ready,
    Stations { region: String, stations: Vec<Station>, failed: bool },
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
    if let Some(stations) = value.get("stations") {
        #[derive(serde::Deserialize)]
        struct Stations {
            #[serde(default)]
            region: String,
            #[serde(default)]
            stations: Vec<Station>,
            #[serde(default)]
            failed: bool,
        }
        let stations: Stations = serde_json::from_value(stations.clone()).ok()?;
        return Some(Message::Stations {
            region: stations.region,
            stations: stations.stations.into_iter().map(checked_station).collect(),
            failed: stations.failed,
        });
    }
    if let Some(playback) = value.get("playback") {
        if playback.is_null() {
            return Some(Message::Playback(None));
        }
        return serde_json::from_value::<Playback>(playback.clone()).ok().map(|mut playback| {
            playback.station = playback.station.map(checked_station);
            Message::Playback(Some(Box::new(playback)))
        });
    }
    None
}

/// Only a cover on radio.cn's own image host passes.
fn checked_station(mut station: Station) -> Station {
    if !station.image.as_deref().is_some_and(is_radio_image) {
        station.image = None;
    }
    station
}

/// An image on radio.cn's own image hosts (`https://ytmedia.radio.cn/…`).
fn is_radio_image(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let host = rest.split('/').next().unwrap_or("");
    host == "radio.cn" || host.ends_with(".radio.cn")
}

/// `{"type":"radioStations","region":"0","stations":[…],"failed":false}`.
pub fn stations_message(region: &str, stations: &[Station], failed: bool) -> String {
    serde_json::json!({
        "type": "radioStations",
        "region": region,
        "stations": stations,
        "failed": failed,
    })
    .to_string()
}

/// `{"type":"radioPlayback","playback":{…}}` (`null`: nothing).
pub fn playback_message(playback: Option<&Playback>) -> String {
    serde_json::json!({ "type": "radioPlayback", "playback": playback }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ready_a_log_stations_and_a_playback() {
        assert_eq!(read_message(r#"{"ready":true}"#), Some(Message::Ready));
        assert_eq!(read_message(r#"{"log":"hi"}"#), Some(Message::Log("hi".into())));
        let stations = read_message(
            r#"{"stations":{"region":"0","stations":[{"id":"639","region":"0","name":"中国之声","program":"新闻","image":"https://ytmedia.radio.cn/a.jpg"}],"failed":false}}"#,
        );
        assert_eq!(
            stations,
            Some(Message::Stations {
                region: "0".into(),
                stations: vec![Station {
                    id: "639".into(),
                    region: "0".into(),
                    name: "中国之声".into(),
                    program: "新闻".into(),
                    image: Some("https://ytmedia.radio.cn/a.jpg".into()),
                }],
                failed: false,
            })
        );
        assert_eq!(read_message(r#"{"playback":null}"#), Some(Message::Playback(None)));
        let playback = read_message(r#"{"playback":{"playing":true,"volume":0.8}}"#);
        assert_eq!(
            playback,
            Some(Message::Playback(Some(Box::new(Playback {
                station: None,
                playing: true,
                loading: false,
                volume: Some(0.8),
                failed: false,
            }))))
        );
    }

    #[test]
    fn drops_a_cover_that_isnt_radio_cns() {
        let station = checked_station(Station {
            id: "1".into(),
            region: "0".into(),
            name: "A".into(),
            program: String::new(),
            image: Some("https://example.com/a.jpg".into()),
        });
        assert_eq!(station.image, None);
    }

    #[test]
    fn messages_have_their_types() {
        let stations = stations_message("0", &[], true);
        let value: serde_json::Value = serde_json::from_str(&stations).unwrap();
        assert_eq!(value["type"], "radioStations");
        assert_eq!(value["failed"], true);
        let playback = playback_message(None);
        let value: serde_json::Value = serde_json::from_str(&playback).unwrap();
        assert_eq!(value["type"], "radioPlayback");
        assert!(value["playback"].is_null());
    }
}
