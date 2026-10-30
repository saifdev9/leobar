//! Now Playing (Windows media session, any app that reports to Windows) and the output volume.
//! Both live on one COM thread so WinRT and Core Audio calls never block the UI thread.
use base64::Engine;
use serde::Serialize;
use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSessionManager as Manager, GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_MULTITHREADED};

#[derive(Serialize, Clone, Default)]
pub struct Media {
    pub title: String,
    pub artist: String,
    pub app: String,
    pub playing: bool,
    pub position: f64,
    pub duration: f64,
    pub art: String,
    pub volume: f32,
    pub muted: bool,
}

pub enum Cmd {
    Toggle,
    Next,
    Prev,
    Volume(f32),
    Mute,
}

pub fn start() -> (Arc<Mutex<Media>>, Sender<Cmd>) {
    let state = Arc::new(Mutex::new(Media::default()));
    let (tx, rx) = channel();
    let s = state.clone();
    std::thread::spawn(move || run(s, rx));
    (state, tx)
}

fn ticks(t: windows::Foundation::TimeSpan) -> f64 {
    t.Duration as f64 / 1e7
}

fn volume() -> windows::core::Result<IAudioEndpointVolume> {
    unsafe {
        let e: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        e.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)
    }
}

fn art(session: &windows::Media::Control::GlobalSystemMediaTransportControlsSession) -> Option<String> {
    let props = session.TryGetMediaPropertiesAsync().ok()?.join().ok()?;
    let stream = props.Thumbnail().ok()?.OpenReadAsync().ok()?.join().ok()?;
    let size = stream.Size().ok()?.min(4 << 20) as u32;
    let reader = DataReader::CreateDataReader(&stream).ok()?;
    reader.LoadAsync(size).ok()?.join().ok()?;
    let mut buf = vec![0u8; size as usize];
    reader.ReadBytes(&mut buf).ok()?;
    let mime = stream.ContentType().map(|m| m.to_string()).unwrap_or_else(|_| "image/png".into());
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(buf)))
}

fn run(state: Arc<Mutex<Media>>, rx: Receiver<Cmd>) {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).ok().ok() };
    let manager = Manager::RequestAsync().and_then(|op| op.join()).ok();
    let mut last_track = String::new();
    loop {
        let session = manager.as_ref().and_then(|m| m.GetCurrentSession().ok());
        match rx.recv_timeout(Duration::from_millis(1000)) {
            Ok(cmd) => {
                let s = session.as_ref();
                let _ = match cmd {
                    Cmd::Toggle => s.map(|s| s.TryTogglePlayPauseAsync().and_then(|o| o.join())),
                    Cmd::Next => s.map(|s| s.TrySkipNextAsync().and_then(|o| o.join())),
                    Cmd::Prev => s.map(|s| s.TrySkipPreviousAsync().and_then(|o| o.join())),
                    Cmd::Volume(v) => volume().and_then(|a| unsafe { a.SetMasterVolumeLevelScalar(v.clamp(0.0, 1.0), std::ptr::null()) }).ok().map(|_| Ok(true)),
                    Cmd::Mute => volume()
                        .and_then(|a| unsafe { a.SetMute(!a.GetMute()?.as_bool(), std::ptr::null()) })
                        .ok()
                        .map(|_| Ok(true)),
                };
                std::thread::sleep(Duration::from_millis(150)); // let the session report its new state
            }
            Err(RecvTimeoutError::Disconnected) => return,
            Err(RecvTimeoutError::Timeout) => {}
        }

        let mut m = Media::default();
        if let Ok(a) = volume() {
            unsafe {
                m.volume = a.GetMasterVolumeLevelScalar().unwrap_or(0.0);
                m.muted = a.GetMute().map(|b| b.as_bool()).unwrap_or(false);
            }
        }
        if let Some(s) = &session {
            if let Ok(p) = s.TryGetMediaPropertiesAsync().and_then(|o| o.join()) {
                m.title = p.Title().map(|t| t.to_string()).unwrap_or_default();
                m.artist = p.Artist().map(|t| t.to_string()).unwrap_or_default();
            }
            m.app = s.SourceAppUserModelId().map(|t| t.to_string()).unwrap_or_default();
            m.playing = s.GetPlaybackInfo().and_then(|i| i.PlaybackStatus()).is_ok_and(|st| st == Status::Playing);
            if let Ok(t) = s.GetTimelineProperties() {
                m.position = t.Position().map(ticks).unwrap_or(0.0);
                m.duration = t.EndTime().map(ticks).unwrap_or(0.0);
            }
            let key = format!("{}\u{1}{}", m.title, m.artist);
            let prev = state.lock().unwrap().art.clone();
            m.art = if key == last_track { prev } else { art(s).unwrap_or_default() };
            last_track = key;
        }
        *state.lock().unwrap() = m;
    }
}
