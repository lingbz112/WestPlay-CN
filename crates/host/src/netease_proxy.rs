//! A local proxy for the site's media hosts that don't allow the page its sound.
//!
//! Some of NetEase's CDNs (`m704`, `m804`, Tengine) answer without `Access-Control-Allow-Origin`, and a
//! WebView refuses a cross-origin media element whose response lacks it: the page can't take those songs into
//! its sound-field (the truck's speakers, equalizer, spectrum). The host has no such restriction, so this
//! serves those streams itself: it fetches the URL the site gave (the URL is the permission; no cookies are
//! needed), and passes it on with the headers a page needs, `Range` included, so it plays as the page's own.
//!
//! It listens on 127.0.0.1 alone, under a token made for this run, and only fetches NetEase's own hosts.

use std::sync::OnceLock;
use std::thread;
use std::time::Duration;

use tiny_http::{Header, Method, Response, Server, StatusCode};

pub struct Proxy {
    pub port: u16,
    pub token: String,
}

/// The one proxy of this run (`None`: it couldn't start, and the page plays without it).
pub fn start() -> Option<&'static Proxy> {
    static PROXY: OnceLock<Option<Proxy>> = OnceLock::new();
    PROXY
        .get_or_init(|| {
            // `reqwest`'s rustls is built without a provider so the workspace keeps its one, `ring`.
            let _ = rustls::crypto::ring::default_provider().install_default();
            let server = Server::http("127.0.0.1:0").map_err(|error| eprintln!("netease proxy: {error}")).ok()?;
            let port = server.server_addr().to_ip()?.port();
            let token = format!("{:032x}", fastrand::u128(..));
            let served = token.clone();
            thread::Builder::new()
                .name("netease proxy".into())
                .spawn(move || {
                    for request in server.incoming_requests() {
                        let token = served.clone();
                        let _ = thread::Builder::new()
                            .name("netease proxy request".into())
                            .spawn(move || serve(request, &token));
                    }
                })
                .map_err(|error| eprintln!("netease proxy: {error}"))
                .ok()?;
            Some(Proxy { port, token })
        })
        .as_ref()
}

fn serve(request: tiny_http::Request, token: &str) {
    let cors = [
        header("Access-Control-Allow-Origin", "*"),
        header("Access-Control-Allow-Headers", "Range"),
        header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"),
        header("Access-Control-Allow-Private-Network", "true"),
        header("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges"),
    ];
    if request.method() == &Method::Options {
        let mut response = Response::empty(StatusCode(204));
        for header in cors {
            response.add_header(header);
        }
        let _ = request.respond(response);
        return;
    }
    let Some(target) = target_of(request.url(), token) else {
        let mut response = Response::empty(StatusCode(403));
        for header in cors {
            response.add_header(header);
        }
        let _ = request.respond(response);
        return;
    };
    let range = request
        .headers()
        .iter()
        .find(|header| header.field.equiv("Range"))
        .map(|header| header.value.as_str().to_owned());
    // Straight out, never through the machine's own proxy: a system proxy (a VPN's, a capture tool's) answers
    // these CDNs with its own error page, which a media element can't play.
    let Ok(client) = reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(60))
        .build()
    else {
        let _ = request.respond(Response::empty(StatusCode(502)));
        return;
    };
    // Each site's own referer: QQ Music's hosts refuse a request that says it comes from NetEase's player.
    let referer = if target.contains("qq.com") { "https://y.qq.com/" } else { "https://music.163.com/" };
    let ask = |referer: Option<&str>| {
        let mut upstream = client
            .get(&target)
            .header(
                "User-Agent",
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
            )
            .header("Accept", "*/*");
        if let Some(referer) = referer {
            upstream = upstream.header("Referer", referer);
        }
        if let Some(range) = range.clone() {
            upstream = upstream.header("Range", range);
        }
        upstream.send()
    };
    let Ok(mut response) = ask(Some(referer)) else {
        let _ = request.respond(Response::empty(StatusCode(502)));
        return;
    };
    // A host that won't have that referer either: asked again without one.
    if response.status().is_client_error() {
        if let Ok(again) = ask(None) {
            response = again;
        }
    }
    let status = StatusCode(response.status().as_u16());
    let length = response
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok());
    let mut headers = cors.to_vec();
    headers.push(header("Accept-Ranges", "bytes"));
    if let Some(kind) = response.headers().get(reqwest::header::CONTENT_TYPE).and_then(|value| value.to_str().ok()) {
        headers.push(header("Content-Type", kind));
    }
    if let Some(content_range) =
        response.headers().get(reqwest::header::CONTENT_RANGE).and_then(|value| value.to_str().ok())
    {
        headers.push(header("Content-Range", content_range));
    }
    let response = Response::new(status, headers, response, length.map(|length| length as usize), None);
    let _ = request.respond(response);
}

/// The URL asked for (`/m/<token>?u=<percent-encoded URL>`), when the token is ours and its host is a music
/// CDN's: nothing else is ever fetched for a page. Both schemes are taken for QQ Music's hosts (much of its
/// sound is served over plain http, which a page at https can't play itself — the proxy is how it's played).
fn target_of(url: &str, token: &str) -> Option<String> {
    let prefix = format!("/m/{token}?u=");
    let encoded = url.strip_prefix(&prefix)?;
    let target = percent_encoding::percent_decode_str(encoded).decode_utf8().ok()?.into_owned();
    let (scheme, rest) = target.split_once("://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    let netease = host.ends_with(".126.net") || host.ends_with(".163.com") || host == "126.net" || host == "163.com";
    let qq = host.ends_with(".qq.com") || host == "qq.com";
    // NetEase's are https; QQ Music's may be either.
    let allowed = netease && scheme == "https" || qq && (scheme == "https" || scheme == "http");
    allowed.then_some(target)
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("a plain header")
}
