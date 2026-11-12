//! A WebView that runs in an ordinary offscreen HWND instead of a composition visual: the pages whose
//! picture is never shown (QQ Music's browser and player). It contributes no full-screen DirectComposition
//! surface to the desktop, so a capture overlay is never offered it as another game source.

use std::cell::{Cell, RefCell};
use std::path::Path;
use std::rc::Rc;
use std::sync::mpsc;

use webview2_com::Microsoft::Web::WebView2::Win32::{
    COREWEBVIEW2_COLOR, COREWEBVIEW2_MOUSE_EVENT_KIND, COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN,
    COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP, COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE,
    COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS, COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
    CreateCoreWebView2EnvironmentWithOptions, ICoreWebView2, ICoreWebView2_2, ICoreWebView2Controller, ICoreWebView2Controller2,
    ICoreWebView2Environment, ICoreWebView2EnvironmentOptions, ICoreWebView2Settings5, ICoreWebView2Settings6,
};
use webview2_com::{
    AddScriptToExecuteOnDocumentCreatedCompletedHandler, CoTaskMemPWSTR, CoreWebView2EnvironmentOptions,
    CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler,
    ProcessFailedEventHandler, WebMessageReceivedEventHandler,
};
use windows::Win32::Foundation::{E_POINTER, HWND, LPARAM, POINT, RECT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::UI::Input::KeyboardAndMouse::EnableWindow;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DestroyWindow, GetWindow, GW_CHILD, PostMessageW, WINDOW_EX_STYLE, WM_LBUTTONDOWN,
    WM_LBUTTONUP, WM_MOUSEMOVE, WS_OVERLAPPEDWINDOW,
};
use windows::core::{HSTRING, Interface, PCWSTR, PWSTR, w};

use crate::webview::{Error, Failure, note_browser, web_error};

/// Where the hidden host windows are: beyond any monitor's (Windows parks minimized windows there too).
const OFF_THE_DESKTOP: i32 = -32000;

pub struct HiddenWebView {
    environment: ICoreWebView2Environment,
    host: HWND,
    controller: ICoreWebView2Controller,
    webview: ICoreWebView2,
    page_messages: Rc<RefCell<Vec<String>>>,
    failure: Rc<Cell<Option<Failure>>>,
    pub version: String,
}

impl HiddenWebView {
    pub fn new(width: u32, height: u32, user_data: &Path) -> Result<Self, Error> {
        let environment = create_environment(user_data)?;
        Self::with_environment(width, height, environment)
    }

    pub fn with_environment(width: u32, height: u32, environment: ICoreWebView2Environment) -> Result<Self, Error> {
        let host = create_hidden_host(width, height)?;
        let version = unsafe {
            let mut value = PWSTR::null();
            environment.BrowserVersionString(&mut value)?;
            value.to_string()?
        };
        let controller = create_controller(&environment, host)?;
        // SAFETY: the controller was just made on this thread.
        unsafe {
            controller.cast::<ICoreWebView2Controller2>()?.SetDefaultBackgroundColor(COREWEBVIEW2_COLOR {
                A: 0,
                R: 0,
                G: 0,
                B: 0,
            })?;
            controller.SetBounds(RECT { left: 0, top: 0, right: width as i32, bottom: height as i32 })?;
            controller.SetIsVisible(true)?;
        }
        let webview = unsafe { controller.CoreWebView2()? };
        note_browser(&webview);
        unsafe {
            let settings = webview.Settings()?;
            settings.SetAreDefaultContextMenusEnabled(false)?;
            settings.SetIsZoomControlEnabled(false)?;
            settings.SetIsStatusBarEnabled(false)?;
            settings.cast::<ICoreWebView2Settings5>()?.SetIsPinchZoomEnabled(false)?;
            settings.cast::<ICoreWebView2Settings6>()?.SetIsSwipeNavigationEnabled(false)?;
        }

        let page_messages = Rc::new(RefCell::new(Vec::new()));
        let queue = page_messages.clone();
        let received = WebMessageReceivedEventHandler::create(Box::new(move |_webview, args| {
            if let Some(args) = args {
                let mut message = PWSTR::null();
                if unsafe { args.WebMessageAsJson(&mut message) }.is_ok() {
                    queue.borrow_mut().push(CoTaskMemPWSTR::from(message).to_string());
                }
            }
            Ok(())
        }));
        let mut token = 0;
        unsafe { webview.add_WebMessageReceived(&received, &mut token)? };

        let failure = Rc::new(Cell::new(None));
        let failed = failure.clone();
        let process_failed = ProcessFailedEventHandler::create(Box::new(move |_webview, args| {
            if let Some(args) = args {
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                unsafe { args.ProcessFailedKind(&mut kind)? };
                if let Some(this) = failure_of(kind) {
                    failed.set(failed.get().max(Some(this)));
                }
            }
            Ok(())
        }));
        unsafe { webview.add_ProcessFailed(&process_failed, &mut token)? };

        Ok(Self {
            environment,
            host,
            controller,
            webview,
            page_messages,
            failure,
            version,
        })
    }

    pub fn take_failure(&self) -> Option<Failure> {
        self.failure.take()
    }

    pub fn log_as(&self, name: &'static str) -> windows::core::Result<()> {
        use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_ERROR_STATUS;
        use webview2_com::NavigationCompletedEventHandler;
        use windows::core::BOOL;
        let loaded = NavigationCompletedEventHandler::create(Box::new(move |webview, args| {
            let (Some(webview), Some(args)) = (webview, args) else { return Ok(()) };
            let mut source = PWSTR::null();
            let mut success = BOOL::default();
            let address = unsafe {
                webview.Source(&mut source)?;
                args.IsSuccess(&mut success)?;
                CoTaskMemPWSTR::from(source).to_string()
            };
            let host = host_of(&address);
            if success.as_bool() {
                log!("[{name}] page loaded ({host})");
            } else {
                let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                unsafe { args.WebErrorStatus(&mut status)? };
                log!("[{name}] page didn't load ({host}): {}", web_error(status));
            }
            Ok(())
        }));
        let mut token = 0;
        unsafe { self.webview.add_NavigationCompleted(&loaded, &mut token) }
    }

    pub fn environment(&self) -> &ICoreWebView2Environment {
        &self.environment
    }

    pub fn show(&self, _shown: bool) -> windows::core::Result<()> {
        // The HWND stays off the desktop. Keeping the controller visible lets scripts, media and frames run.
        Ok(())
    }

    pub fn set_rendering(&self, _rendered: bool) -> windows::core::Result<()> {
        Ok(())
    }

    pub fn add_startup_script(&self, script: &str) -> Result<(), Error> {
        let webview = self.webview.clone();
        let script = HSTRING::from(script);
        AddScriptToExecuteOnDocumentCreatedCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                webview
                    .AddScriptToExecuteOnDocumentCreated(&script, &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(|error, _id| error),
        )?;
        Ok(())
    }

    pub fn navigate(&self, url: &str) -> windows::core::Result<()> {
        unsafe { self.webview.Navigate(&HSTRING::from(url)) }
    }

    pub fn take_page_messages(&self) -> Vec<String> {
        std::mem::take(&mut self.page_messages.borrow_mut())
    }

    pub fn post_json(&self, json: &str) -> windows::core::Result<()> {
        unsafe { self.webview.PostWebMessageAsJson(&HSTRING::from(json)) }
    }

    pub fn send_mouse(
        &self,
        kind: COREWEBVIEW2_MOUSE_EVENT_KIND,
        keys: COREWEBVIEW2_MOUSE_EVENT_VIRTUAL_KEYS,
        data: u32,
        point: POINT,
    ) -> windows::core::Result<()> {
        let _ = (keys, data);
        let message = if kind == COREWEBVIEW2_MOUSE_EVENT_KIND_MOVE {
            WM_MOUSEMOVE
        } else if kind == COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_DOWN {
            WM_LBUTTONDOWN
        } else if kind == COREWEBVIEW2_MOUSE_EVENT_KIND_LEFT_BUTTON_UP {
            WM_LBUTTONUP
        } else {
            return Ok(());
        };
        unsafe {
            let child = GetWindow(self.host, GW_CHILD)?;
            let position = ((point.y as u16 as u32) << 16) | (point.x as u16 as u32);
            PostMessageW(
                Some(child),
                message,
                WPARAM(if message == WM_LBUTTONDOWN { 1 } else { 0 }),
                LPARAM(position as isize),
            )?;
        }
        Ok(())
    }

    pub fn delete_cookies(&self) -> windows::core::Result<()> {
        use webview2_com::ClearBrowsingDataCompletedHandler;
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES, ICoreWebView2_13, ICoreWebView2Profile2,
        };
        let profile: ICoreWebView2Profile2 = unsafe { self.webview.cast::<ICoreWebView2_13>()?.Profile()? }.cast()?;
        let cleared = ClearBrowsingDataCompletedHandler::wait_for_async_operation(
            Box::new(move |handler| unsafe {
                profile
                    .ClearBrowsingData(COREWEBVIEW2_BROWSING_DATA_KINDS_COOKIES, &handler)
                    .map_err(webview2_com::Error::WindowsError)
            }),
            Box::new(|error| error),
        );
        if cleared.is_ok() {
            return Ok(());
        }
        unsafe { self.webview.cast::<ICoreWebView2_2>()?.CookieManager()?.DeleteAllCookies() }
    }
}

impl Drop for HiddenWebView {
    fn drop(&mut self) {
        unsafe {
            let _ = self.controller.Close();
            let _ = DestroyWindow(self.host);
        }
    }
}

/// The page for [`OffscreenWebView::fit`]: `width` x `height` grown evenly until it fills `room` one way,

fn create_environment(user_data: &Path) -> Result<ICoreWebView2Environment, Error> {
    let options = CoreWebView2EnvironmentOptions::default();
    // A hidden page: no hardware compositor (so no surface NVIDIA's capture sees), its scripts and sound still
    // running, and its sound allowed without a gesture (the cab asks it to play).
    let arguments = "--disable-features=CalculateNativeWinOcclusion,LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests \
                     --disable-background-timer-throttling --disable-renderer-backgrounding \
                     --disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required \
                     --disable-gpu --disable-gpu-compositing"
        .to_string();
    // SAFETY: the options object is ours and alive; the arguments are a plain string.
    unsafe {
        options.set_additional_browser_arguments(arguments);
    }
    let options: ICoreWebView2EnvironmentOptions = options.into();
    let user_data = HSTRING::from(user_data.as_os_str());

    let (tx, rx) = mpsc::channel();
    CreateCoreWebView2EnvironmentCompletedHandler::wait_for_async_operation(
        // SAFETY: the profile folder and the options live through the call; the handler is kept alive until
        // WebView2 calls it.
        Box::new(move |handler| unsafe {
            CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), &user_data, &options, &handler)
                .map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |error, environment| {
            error?;
            tx.send(environment.ok_or_else(|| windows::core::Error::from(E_POINTER))).expect("send environment");
            Ok(())
        }),
    )?;
    Ok(rx.recv()??)
}

fn create_hidden_host(width: u32, height: u32) -> windows::core::Result<HWND> {
    unsafe {
        let host = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            w!("STATIC"),
            w!("westplay-hidden-webview"),
            WS_OVERLAPPEDWINDOW,
            OFF_THE_DESKTOP,
            OFF_THE_DESKTOP,
            width as i32,
            height as i32,
            None,
            None,
            Some(GetModuleHandleW(None)?.into()),
            None,
        )?;
        let _ = EnableWindow(host, false);
        Ok(host)
    }
}

fn create_controller(environment: &ICoreWebView2Environment, host: HWND) -> Result<ICoreWebView2Controller, Error> {
    let environment = environment.clone();
    let (tx, rx) = mpsc::channel();
    CreateCoreWebView2ControllerCompletedHandler::wait_for_async_operation(
        Box::new(move |handler| unsafe {
            environment.CreateCoreWebView2Controller(host, &handler).map_err(webview2_com::Error::WindowsError)
        }),
        Box::new(move |error, controller| {
            error?;
            tx.send(controller.ok_or_else(|| windows::core::Error::from(E_POINTER))).expect("send controller");
            Ok(())
        }),
    )?;
    Ok(rx.recv()??)
}

fn failure_of(kind: COREWEBVIEW2_PROCESS_FAILED_KIND) -> Option<Failure> {
    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => Some(Failure::Browser),
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
        | COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => Some(Failure::Page),
        _ => None,
    }
}

/// A page's address as the log gives it: only its host.
fn host_of(address: &str) -> &str {
    let rest = address.split_once("://").map_or(address, |(_, rest)| rest);
    rest.split(['/', '?', '#']).next().unwrap_or("")
}
