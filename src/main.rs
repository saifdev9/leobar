#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod ai;
mod claude;
mod files;
mod media;
mod glass;
mod net;
mod shell;
mod sys;
mod win;

use base64::Engine;
use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, RunEvent, State, WebviewWindow};
use windows_sys::Win32::Foundation::RECT;

/// date (YYYY-MM-DD) -> exe -> seconds in the foreground.
/// Keys starting with '@' hold active seconds per hour ("@09"), for the day timeline.
type Usage = BTreeMap<String, BTreeMap<String, u64>>;

struct Dock {
    logs: Mutex<claude::Logs>,
    screen: Arc<Mutex<Usage>>,
    icons: Mutex<HashMap<String, String>>,
    thumbs: Mutex<HashMap<String, Option<String>>>,
    media: Arc<Mutex<media::Media>>,
    media_tx: Mutex<Sender<media::Cmd>>,
    vault: net::Vault,
    glass: Arc<glass::Glass>,
    data_dir: PathBuf,
}

#[derive(serde::Serialize)]
struct AppItem {
    name: String,
    title: String,
    icon: String,
    pinned: Option<String>,
    windows: Vec<isize>,
    active: bool,
    /// Which of `windows` is in front, so clicks can cycle through an app's windows.
    focus: Option<usize>,
}

const MARGIN: f64 = 8.0;
const TICK: u64 = 5;
static SHOWN: AtomicBool = AtomicBool::new(false);

fn err<E: ToString>(e: E) -> String {
    e.to_string()
}

/* ---------- AI ---------- */

#[tauri::command(async)]
fn claude_snapshot(dock: State<Dock>) -> claude::Snapshot {
    dock.logs.lock().unwrap().snapshot()
}

#[tauri::command(async)]
fn codex_usage() -> ai::Codex {
    ai::codex()
}

/* ---------- system ---------- */

#[tauri::command]
fn system_stats() -> (f32, u32) {
    win::cpu_ram()
}

#[derive(serde::Serialize)]
struct Sensors {
    battery: Option<sys::Battery>,
    disk: Option<(u64, u64)>,
    net: (f64, f64),
    keyboard: (String, Vec<String>),
    recycle: (i64, i64),
    light: bool,
}

#[tauri::command(async)]
fn sensors() -> Sensors {
    let drive = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".into()) + "\\";
    Sensors {
        battery: sys::battery(),
        disk: sys::disk(&drive),
        net: sys::net_rate(),
        keyboard: sys::keyboard(),
        recycle: shell::run(3, sys::recycle_bin).unwrap_or((0, 0)),
        light: sys::light_theme(),
    }
}

#[tauri::command(async)]
fn system_action(action: String) {
    match action.as_str() {
        "next-keyboard" => sys::next_keyboard(),
        // Waits for the user to answer Windows' confirmation, so it gets its own thread.
        "empty-recycle" => drop(std::thread::spawn(sys::empty_recycle_bin)),
        "light" => drop(std::thread::spawn(|| sys::set_light_theme(true))),
        "dark" => drop(std::thread::spawn(|| sys::set_light_theme(false))),
        _ => {}
    }
}

/// The desktop wallpaper as a data URI, for the liquid glass. `known` skips the transfer when unchanged.
#[tauri::command(async)]
fn wallpaper(known: Option<String>) -> Option<(String, Option<String>)> {
    let path = sys::wallpaper_path()?;
    let m = std::fs::metadata(&path).ok()?;
    let stamp = format!("{}|{}|{:?}", path.display(), m.len(), m.modified().ok());
    if known.as_deref() == Some(stamp.as_str()) {
        return Some((stamp, None));
    }
    if m.len() > 40 << 20 {
        return None;
    }
    let bytes = std::fs::read(&path).ok()?;
    let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { "image/png" } else if bytes.starts_with(b"BM") { "image/bmp" } else { "image/jpeg" };
    Some((stamp, Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))))
}

#[tauri::command(async)]
fn brightness() -> Option<u32> {
    sys::brightness()
}

#[tauri::command(async)]
fn set_brightness(level: u32) -> Result<(), String> {
    sys::set_brightness(level)
}

#[tauri::command]
fn screen_time(dock: State<Dock>) -> Usage {
    dock.screen.lock().unwrap().clone()
}

/* ---------- media ---------- */

#[tauri::command]
fn media_state(dock: State<Dock>) -> media::Media {
    dock.media.lock().unwrap().clone()
}

#[tauri::command]
fn media_cmd(dock: State<Dock>, action: String, value: Option<f32>) {
    let cmd = match action.as_str() {
        "toggle" => media::Cmd::Toggle,
        "next" => media::Cmd::Next,
        "prev" => media::Cmd::Prev,
        "mute" => media::Cmd::Mute,
        "volume" => media::Cmd::Volume(value.unwrap_or(0.5)),
        _ => return,
    };
    let _ = dock.media_tx.lock().unwrap().send(cmd);
}

/* ---------- apps & files ---------- */

fn pinned_dir() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_default())
        .join(r"Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar")
}

fn stem(p: &str) -> String {
    Path::new(p).file_stem().map_or(String::new(), |s| s.to_string_lossy().to_lowercase())
}

/// Shell icons for paths not seen before, extracted on the shell worker.
fn icons_for(dock: &Dock, paths: Vec<String>) -> HashMap<String, String> {
    let missing: Vec<String> = {
        let known = dock.icons.lock().unwrap();
        paths.iter().filter(|p| !known.contains_key(*p)).cloned().collect()
    };
    if !missing.is_empty() {
        let found = shell::run(5, move || {
            missing
                .into_iter()
                .map(|p| {
                    let uri = win::icon_png(Path::new(&p)).map_or(String::new(), |b| {
                        format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b))
                    });
                    (p, uri)
                })
                .collect::<Vec<_>>()
        });
        dock.icons.lock().unwrap().extend(found.unwrap_or_default());
    }
    let known = dock.icons.lock().unwrap();
    paths.into_iter().filter_map(|p| known.get(&p).map(|u| (p, u.clone()))).collect()
}

/// Pinned shortcuts plus every open app window, grouped by program.
#[tauri::command(async)]
fn apps(dock: State<Dock>) -> Vec<AppItem> {
    let mut items = apps_without_icons();
    let icons = icons_for(&dock, items.iter().map(|i| i.icon.clone()).collect());
    for i in &mut items {
        i.icon = icons.get(&i.icon).cloned().unwrap_or_default();
    }
    items
}

/// Like `apps`, with each item's `icon` holding the path its icon comes from.
fn apps_without_icons() -> Vec<AppItem> {
    let icon = |path: &Path| path.to_string_lossy().into_owned();
    let fg = win::last_foreground();
    let mut wins = win::app_windows();
    let mut items = vec![];

    let mut pins: Vec<PathBuf> = std::fs::read_dir(pinned_dir())
        .map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "lnk")).collect())
        .unwrap_or_default();
    pins.sort();
    for lnk in pins {
        let name = lnk.file_stem().unwrap_or_default().to_string_lossy().into_owned();
        let target = std::fs::read(&lnk).ok().and_then(|b| win::lnk_target(&b)).map(|t| stem(&t));
        let squashed = name.to_lowercase().replace(' ', "");
        // ponytail: links without a stored path (File Explorer, Store apps) match by name.
        let (mine, rest): (Vec<_>, Vec<_>) = wins.into_iter().partition(|w| {
            let s = stem(&w.exe);
            match &target {
                Some(t) => *t == s,
                None => !s.is_empty() && (squashed.contains(&s) || s.contains(&squashed)),
            }
        });
        wins = rest;
        items.push(AppItem {
            title: mine.first().map_or(name.clone(), |w| w.title.clone()),
            icon: icon(&lnk),
            active: mine.iter().any(|w| w.hwnd == fg),
            focus: mine.iter().position(|w| w.hwnd == fg),
            windows: mine.iter().map(|w| w.hwnd).collect(),
            pinned: Some(lnk.to_string_lossy().into_owned()),
            name,
        });
    }

    let mut groups: Vec<(String, Vec<win::AppWindow>)> = vec![];
    for w in wins {
        match groups.iter_mut().find(|g| g.0 == w.exe) {
            Some(g) => g.1.push(w),
            None => groups.push((w.exe.clone(), vec![w])),
        }
    }
    for (exe, ws) in groups {
        let name = Path::new(&exe).file_stem().unwrap_or_default().to_string_lossy().into_owned();
        items.push(AppItem {
            title: ws[0].title.clone(),
            icon: icon(Path::new(&exe)),
            active: ws.iter().any(|w| w.hwnd == fg),
            focus: ws.iter().position(|w| w.hwnd == fg),
            windows: ws.iter().map(|w| w.hwnd).collect(),
            pinned: None,
            name,
        });
    }
    items
}

#[tauri::command]
fn launch(path: String) -> Result<(), String> {
    let p = PathBuf::from(path);
    // Only shortcuts the user pinned in Windows may be started from the dock.
    if p.parent() != Some(pinned_dir().as_path()) || !p.extension().is_some_and(|x| x == "lnk") || !p.exists() {
        return Err("not a pinned app".into());
    }
    std::process::Command::new("explorer").arg(&p).spawn().map(|_| ()).map_err(err)
}

#[tauri::command]
fn activate(hwnd: isize) -> bool {
    win::app_windows().iter().any(|w| w.hwnd == hwnd) && win::activate(hwnd)
}

#[tauri::command]
fn start_menu() {
    win::press_start()
}

#[tauri::command]
fn file_list(which: String, limit: usize) -> Vec<files::Entry> {
    let limit = limit.min(30);
    if which == "recent" {
        return files::recent(limit);
    }
    files::known(&which).map_or(vec![], |d| files::newest(&d, limit))
}

#[tauri::command]
fn start_search(query: String) -> Vec<files::Entry> {
    if query.trim().is_empty() { vec![] } else { files::start_apps(query.trim()) }
}

#[tauri::command(async)]
fn thumb(dock: State<Dock>, path: String) -> Option<String> {
    if let Some(t) = dock.thumbs.lock().unwrap().get(&path) {
        return t.clone();
    }
    let p = path.clone();
    let t = shell::run(4, move || files::thumbnail(&p, 256)).flatten();
    let mut cache = dock.thumbs.lock().unwrap();
    if cache.len() > 200 {
        cache.clear();
    }
    cache.insert(path, t.clone());
    t
}

/// The icon of an installed app, by its Start menu name ("Claude", "ChatGPT"), taken from the app
/// itself so the dock shows the real logo. Store apps are found by app ID, others by their shortcut.
#[tauri::command(async)]
fn brand_icon(dock: State<Dock>, name: String) -> Option<String> {
    // The name goes into a PowerShell command: letters, digits and spaces only.
    if name.is_empty() || name.len() > 40 || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == ' ') {
        return None;
    }
    let key = format!("brand:{name}");
    if let Some(i) = dock.icons.lock().unwrap().get(&key) {
        return Some(i.clone()).filter(|s| !s.is_empty());
    }
    let app_id = sys::powershell(&format!("(Get-StartApps -Name '{name}' | Where-Object Name -eq '{name}' | Select-Object -First 1).AppID"))
        .ok()
        .filter(|s| !s.is_empty() && !s.contains('\n'));
    let source = match app_id {
        Some(id) => Some(format!(r"shell:AppsFolder\{id}")),
        None => files::start_apps(&name).into_iter().find(|e| e.name.eq_ignore_ascii_case(&name)).map(|e| e.path),
    };
    let icon = source.and_then(|s| shell::run(5, move || files::thumbnail(&s, 96)).flatten()).unwrap_or_default();
    dock.icons.lock().unwrap().insert(key, icon.clone());
    Some(icon).filter(|s| !s.is_empty())
}

#[tauri::command]
fn open(target: String, reveal: Option<bool>) -> Result<(), String> {
    files::open(&target, reveal.unwrap_or(false))
}

/* ---------- online ---------- */

#[tauri::command(async)]
fn http(dock: State<Dock>, req: net::Req) -> Result<net::Resp, String> {
    net::send(&dock.vault, req)
}

#[tauri::command]
fn secret_set(dock: State<Dock>, name: String, value: String) -> Result<(), String> {
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("bad key name".into());
    }
    dock.vault.set(&name, &value)
}

#[tauri::command]
fn secret_names(dock: State<Dock>) -> Vec<String> {
    dock.vault.names()
}

#[tauri::command(async)]
fn set_wallpaper(dock: State<Dock>, url: String) -> Result<(), String> {
    // Alternate between two files: Windows caches the wallpaper by path.
    let flip = dock.data_dir.join("wallpaper-a.jpg").exists();
    let dest = dock.data_dir.join(if flip { "wallpaper-b.jpg" } else { "wallpaper-a.jpg" });
    net::download(&dock.vault, &url, &dest)?;
    let _ = std::fs::remove_file(dock.data_dir.join(if flip { "wallpaper-a.jpg" } else { "wallpaper-b.jpg" }));
    if sys::set_wallpaper(&dest.to_string_lossy()) { Ok(()) } else { Err("Windows refused the wallpaper".into()) }
}

#[tauri::command(async)]
fn fetch_ical(url: String) -> Result<String, String> {
    let url = url.trim();
    let url = match url.strip_prefix("webcal://") {
        Some(rest) => format!("https://{rest}"),
        None if url.starts_with("https://") => url.to_string(),
        None => return Err("use an https:// or webcal:// link".into()),
    };
    ureq::get(&url)
        .timeout(Duration::from_secs(20))
        .call()
        .map_err(|e| match e {
            ureq::Error::Status(code, _) => format!("calendar returned {code}"),
            other => other.kind().to_string(),
        })?
        .into_string()
        .map_err(err)
}

/* ---------- dock window ---------- */

#[tauri::command]
fn taskbar_mode(hidden: bool) {
    win::HIDE_TASKBAR.store(hidden, SeqCst);
    win::enforce_taskbar();
}

/// Live glass: on or off, frost, corner style, theme tint (rgb + strength), and the shapes to draw,
/// each `[x, y, w, h, radius, kind, opacity]` in CSS px relative to the dock window.
#[tauri::command]
fn glass_set(window: WebviewWindow, dock: State<Dock>, enabled: bool, frost: f32, squircle: bool, tint: [f32; 4], shapes: Vec<[f32; 7]>) {
    let k = window.scale_factor().unwrap_or(1.0) as f32;
    let shapes: Vec<glass::Shape> = shapes
        .into_iter()
        .take(glass::MAX_SHAPES)
        .map(|s| [s[0] * k, s[1] * k, s[2] * k, s[3] * k, s[4] * k, s[5], s[6].clamp(0.0, 1.0)])
        .collect();
    let mut st = dock.glass.state.lock().unwrap();
    if st.enabled != enabled || st.frost != frost * k || st.squircle != squircle || st.tint != tint || st.shapes != shapes || st.scale != k {
        st.enabled = enabled;
        st.frost = frost * k;
        st.scale = k;
        st.squircle = squircle;
        st.tint = tint;
        st.shapes = shapes;
        st.version += 1;
    }
}

/// The parts of the dock window that take the mouse (CSS px rects), or `all` while dragging.
/// Everywhere else the window lets clicks and hovers through to whatever is behind it.
#[tauri::command]
fn hit_set(window: WebviewWindow, rects: Vec<[f32; 4]>, all: bool) {
    let k = window.scale_factor().unwrap_or(1.0) as f32;
    let rects = rects.into_iter().map(|r| [r[0] * k, r[1] * k, r[2] * k, r[3] * k]).collect();
    *HIT.lock().unwrap() = (rects, all);
}

static HIT: Mutex<(Vec<[f32; 4]>, bool)> = Mutex::new((Vec::new(), true));

/// Makes the dock window click-through except over its capsules and popover, checked 60 times a
/// second against the pointer. The window is tall and mostly empty (room for the popover and the
/// magnified icons), so without this it would block clicks on the windows behind it.
fn hit_test(window: WebviewWindow) {
    let Ok(hwnd) = window.hwnd() else { return };
    let hwnd = hwnd.0 as isize;
    std::thread::spawn(move || {
        let mut last: Option<bool> = None;
        loop {
            std::thread::sleep(Duration::from_millis(16));
            let (inside, all) = {
                let h = HIT.lock().unwrap();
                let inside = win::cursor_in(hwnd as _).is_some_and(|(x, y)| {
                    let (x, y) = (x as f32, y as f32);
                    h.0.iter().any(|r| x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3])
                });
                (inside, h.1)
            };
            let take = all || inside;
            if last != Some(take) {
                last = Some(take);
                let _ = window.set_ignore_cursor_events(!take);
            }
        }
    });
}

/// An image from an allowed service as a data URI, so the page never loads third-party content itself.
#[tauri::command(async)]
fn net_image(dock: State<Dock>, url: String) -> Result<String, String> {
    let (bytes, mime) = net::fetch(&dock.vault, &url, 8 << 20)?;
    if !mime.starts_with("image/") {
        return Err("not an image".into());
    }
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

/// "off", "starting", "live" or "error: …", so the page can fall back to wallpaper glass.
#[tauri::command]
fn glass_status(dock: State<Dock>) -> String {
    dock.glass.status.lock().unwrap().clone()
}

/// Saves the next Live glass frame as a PNG in the app data folder (it can't be screenshotted).
#[tauri::command]
fn glass_snapshot(dock: State<Dock>) -> String {
    let path = dock.data_dir.join("glass-frame.png");
    let mut st = dock.glass.state.lock().unwrap();
    st.snapshot = Some(path.clone());
    st.version += 1; // forces a render
    path.to_string_lossy().into_owned()
}

/// Sizes the dock (logical px), pins it to the top or bottom edge at the left, centre or right,
/// and reserves that strip of the screen. Returns the dock's position on its monitor, in logical px.
#[tauri::command(async)]
fn layout(window: WebviewWindow, width: f64, height: f64, dock: f64, top: bool, align: Option<String>) -> Result<(f64, f64), String> {
    let mon = window
        .current_monitor()
        .ok()
        .flatten()
        .or(window.primary_monitor().ok().flatten())
        .ok_or("no monitor")?;
    let k = mon.scale_factor();
    let (mp, ms) = (mon.position(), mon.size());
    let (w, h, m) = ((width * k) as i32, (height * k) as i32, (MARGIN * k) as i32);
    let w = w.min(ms.width as i32 - 2 * m); // "full width" asks for more than fits; clamp to the monitor
    let x = match align.as_deref() {
        Some("left") => mp.x + m,
        Some("right") => mp.x + ms.width as i32 - w - m,
        _ => mp.x + (ms.width as i32 - w) / 2,
    };
    let y = if top { mp.y + m } else { mp.y + ms.height as i32 - h - m };

    // Reserve first: when the work area shrinks, Windows pushes windows out of the reserved strip,
    // the dock included, so the dock is placed only after the strip exists.
    let strip = ((dock + MARGIN) * k) as i32;
    let (l, r, t, b) = (mp.x, mp.x + ms.width as i32, mp.y, mp.y + ms.height as i32);
    let rc = if top { RECT { left: l, right: r, top: t, bottom: t + strip } } else { RECT { left: l, right: r, top: b - strip, bottom: b } };
    if let Ok(hwnd) = window.hwnd() {
        let hw = hwnd.0 as isize;
        shell::run(3, move || win::reserve(hw as _, rc, top));
    }
    window.set_size(PhysicalSize::new(w as u32, h as u32)).map_err(err)?;
    window.set_position(PhysicalPosition::new(x, y)).map_err(err)?;
    *PLACE.lock().unwrap() = Some((x, y));
    if !win::fullscreen_busy() {
        window.show().map_err(err)?;
    }
    SHOWN.store(true, SeqCst);
    Ok(((x - mp.x) as f64 / k, (y - mp.y) as f64 / k))
}

/// Where `layout` last put the dock. Windows pushes windows out of a reserved strip whenever the
/// work area changes (the taskbar hiding, a display change), the dock included; the watcher puts it back.
static PLACE: Mutex<Option<(i32, i32)>> = Mutex::new(None);

#[tauri::command]
fn autostart(on: bool) -> Result<(), String> {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let exe = std::env::current_exe().map_err(err)?;
    let exe = format!("\"{}\"", exe.display());
    let args: Vec<&str> =
        if on { vec!["add", key, "/v", "leobar", "/t", "REG_SZ", "/d", &exe, "/f"] } else { vec!["delete", key, "/v", "leobar", "/f"] };
    let ok = std::process::Command::new("reg").args(args).output().map_err(err)?.status.success();
    if ok || !on { Ok(()) } else { Err("could not write the Run key".into()) }
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0)
}

/// Samples the foreground app every few seconds while the user is active; saves once a minute.
fn track_screen_time(screen: Arc<Mutex<Usage>>, file: PathBuf) {
    std::thread::spawn(move || {
        let mut n = 0u64;
        loop {
            n += 1;
            std::thread::sleep(Duration::from_secs(TICK));
            if win::idle_secs() < 120 {
                if let Some(exe) = win::foreground_exe() {
                    let (date, hour) = win::local_now();
                    let mut s = screen.lock().unwrap();
                    let day = s.entry(date).or_default();
                    *day.entry(exe).or_default() += TICK;
                    *day.entry(format!("@{hour:02}")).or_default() += TICK;
                }
            }
            if n.is_multiple_of(60 / TICK) {
                let mut s = screen.lock().unwrap();
                while s.len() > 30 {
                    s.pop_first();
                }
                if let Ok(json) = serde_json::to_vec(&*s) {
                    let _ = std::fs::write(&file, json);
                }
            }
        }
    });
}

/// Hides the dock while something runs full screen, and keeps the Windows taskbar hidden if asked.
fn watch(window: WebviewWindow) {
    std::thread::spawn(move || {
        let mut hidden = false;
        loop {
            std::thread::sleep(Duration::from_secs(1));
            win::enforce_taskbar();
            let busy = win::fullscreen_busy();
            if SHOWN.load(SeqCst) && busy != hidden {
                hidden = busy;
                let _ = if busy { window.hide() } else { window.show() };
            }
            if let (Some((x, y)), Ok(p)) = (*PLACE.lock().unwrap(), window.outer_position()) {
                if (p.x, p.y) != (x, y) {
                    let _ = window.set_position(PhysicalPosition::new(x, y));
                }
            }
        }
    });
}

fn main() {
    let taskbar = win::taskbar_state();
    let app = tauri::Builder::default()
        .setup(move |app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            let file = dir.join("screentime.json");
            let usage: Usage = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
            let screen = Arc::new(Mutex::new(usage));
            track_screen_time(screen.clone(), file);
            let (media, media_tx) = media::start();
            let dock_window = app.get_webview_window("dock").ok_or("no dock window")?;
            let dock_hwnd = dock_window.hwnd()?.0 as isize;
            app.manage(Dock {
                logs: Mutex::default(),
                screen,
                icons: Mutex::default(),
                thumbs: Mutex::default(),
                media,
                media_tx: Mutex::new(media_tx),
                vault: net::Vault::load(dir.join("keys.bin")),
                glass: glass::start(dock_hwnd, dir.clone()),
                data_dir: dir,
            });
            // The window is a transparent canvas: no Windows corner rounding or border on it;
            // the capsules and popover draw their own edges.
            win::frame(dock_hwnd as _, false);
            hit_test(dock_window.clone());
            watch(dock_window);
            win::watch_foreground();
            shell::run(3, move || win::taskbar_autohide(taskbar));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            claude_snapshot,
            codex_usage,
            system_stats,
            sensors,
            system_action,
            brightness,
            set_brightness,
            screen_time,
            media_state,
            media_cmd,
            apps,
            launch,
            activate,
            start_menu,
            file_list,
            start_search,
            thumb,
            brand_icon,
            open,
            http,
            secret_set,
            secret_names,
            set_wallpaper,
            fetch_ical,
            wallpaper,
            taskbar_mode,
            glass_set,
            hit_set,
            net_image,
            glass_status,
            glass_snapshot,
            layout,
            autostart,
            quit
        ])
        .build(tauri::generate_context!())
        .expect("failed to start leobar");
    // ponytail: restored on normal exit only; if the process is killed, run leobar again and Quit, or toggle auto-hide in Windows Settings.
    app.run(move |_, e| {
        if let RunEvent::Exit = e {
            // Taskbar first: it matters most, and none of these may hang the exit.
            win::HIDE_TASKBAR.store(false, SeqCst);
            win::restore_taskbar();
            shell::run(2, move || {
                win::set_taskbar_state(taskbar);
                win::unreserve();
            });
        }
    });
}
