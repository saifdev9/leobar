//! Thin wrappers over the Win32 calls the dock needs.
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::path::Path;
use std::ptr::null_mut;
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering::SeqCst};
use std::sync::Mutex;
use windows_sys::core::GUID;
use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, HWND, LPARAM, RECT, SYSTEMTIME};
use windows_sys::Win32::Graphics::Dwm::{
    DwmGetWindowAttribute, DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CLOAKED, DWMWA_WINDOW_CORNER_PREFERENCE,
    DWMWCP_DONOTROUND, DWMWCP_ROUND,
};
use windows_sys::Win32::Graphics::Gdi::{
    DeleteObject, GetDC, GetDIBits, ReleaseDC, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP,
};
use windows_sys::Win32::System::SystemInformation::{GetLocalTime, GetTickCount, GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows_sys::Win32::System::Threading::{
    GetSystemTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, HWINEVENTHOOK};
use windows_sys::Win32::UI::Controls::{ImageList_GetIcon, ILD_TRANSPARENT};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{keybd_event, GetLastInputInfo, KEYEVENTF_KEYUP, LASTINPUTINFO, VK_LWIN};
use windows_sys::Win32::UI::Shell::{
    SHAppBarMessage, SHGetFileInfoW, SHGetImageList, SHQueryUserNotificationState, ABE_BOTTOM, ABE_TOP, ABM_GETSTATE,
    ABM_NEW, ABM_QUERYPOS, ABM_REMOVE, ABM_SETPOS, ABM_SETSTATE, ABS_AUTOHIDE, APPBARDATA, SHFILEINFOW,
    SHGFI_SYSICONINDEX, SHIL_EXTRALARGE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, EnumWindows, FindWindowExW, GetClassNameW, GetCursorPos, GetForegroundWindow, GetIconInfo, GetWindow,
    GetWindowLongPtrW, GetWindowRect, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
    IsWindowVisible, SetForegroundWindow, ShowWindowAsync, EVENT_SYSTEM_FOREGROUND, GWL_EXSTYLE, GW_OWNER, HICON,
    ICONINFO, SW_HIDE, SW_MINIMIZE, SW_RESTORE, SW_SHOW, WINEVENT_OUTOFCONTEXT, WM_USER, WS_EX_TOOLWINDOW,
};

pub fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain([0]).collect()
}

/* ---------- taskbar ---------- */

fn appbar() -> APPBARDATA {
    APPBARDATA { cbSize: size_of::<APPBARDATA>() as u32, ..unsafe { zeroed() } }
}

pub fn taskbar_state() -> isize {
    let mut d = appbar();
    unsafe { SHAppBarMessage(ABM_GETSTATE, &mut d) as isize }
}

pub fn set_taskbar_state(state: isize) {
    let mut d = appbar();
    d.lParam = state;
    unsafe { SHAppBarMessage(ABM_SETSTATE, &mut d) };
}

pub fn taskbar_autohide(prev: isize) {
    set_taskbar_state(prev | ABS_AUTOHIDE as isize);
}

/// The primary and every secondary-monitor taskbar.
fn taskbars() -> Vec<HWND> {
    let mut out = vec![];
    for class in ["Shell_TrayWnd", "Shell_SecondaryTrayWnd"] {
        let class = wide(class);
        let mut h = null_mut();
        loop {
            h = unsafe { FindWindowExW(null_mut(), h, class.as_ptr(), std::ptr::null()) };
            if h.is_null() {
                break;
            }
            out.push(h);
        }
    }
    out
}

pub static HIDE_TASKBAR: AtomicBool = AtomicBool::new(false);

/// Hides or shows the Windows taskbar. Called again by the watcher, since Explorer sometimes re-shows it.
pub fn enforce_taskbar() {
    let hide = HIDE_TASKBAR.load(SeqCst);
    for h in taskbars() {
        if (unsafe { IsWindowVisible(h) } != 0) == hide {
            unsafe { ShowWindowAsync(h, if hide { SW_HIDE } else { SW_SHOW }) };
        }
    }
}

pub fn restore_taskbar() {
    for h in taskbars() {
        unsafe { ShowWindowAsync(h, SW_SHOW) };
    }
}

/* ---------- reserved screen strip (AppBar) ---------- */

static APPBAR: AtomicIsize = AtomicIsize::new(0);

/// Reserves a strip at the top or bottom of the monitor so maximised windows stop above the dock.
pub fn reserve(hwnd: HWND, rc: RECT, top: bool) {
    let mut d = appbar();
    d.hWnd = hwnd;
    d.uCallbackMessage = WM_USER + 0x4c;
    if APPBAR.swap(hwnd as isize, SeqCst) == 0 {
        unsafe { SHAppBarMessage(ABM_NEW, &mut d) };
    }
    d.uEdge = if top { ABE_TOP } else { ABE_BOTTOM };
    d.rc = rc;
    unsafe {
        SHAppBarMessage(ABM_QUERYPOS, &mut d);
        SHAppBarMessage(ABM_SETPOS, &mut d);
    }
}

pub fn unreserve() {
    let h = APPBAR.swap(0, SeqCst);
    if h != 0 {
        let mut d = appbar();
        d.hWnd = h as HWND;
        unsafe { SHAppBarMessage(ABM_REMOVE, &mut d) };
    }
}

/// A game, video or presentation is running full screen.
pub fn fullscreen_busy() -> bool {
    let mut state = 0;
    unsafe { SHQueryUserNotificationState(&mut state) };
    matches!(state, 2..=4) // QUNS_BUSY, QUNS_RUNNING_D3D_FULL_SCREEN, QUNS_PRESENTATION_MODE
}

/* ---------- windows & apps ---------- */

/// Last foreground window that is not the dock, so a click on the dock can tell which app was active.
static LAST_FG: AtomicIsize = AtomicIsize::new(0);

unsafe extern "system" fn on_foreground(_: HWINEVENTHOOK, _: u32, h: HWND, _: i32, _: i32, _: u32, _: u32) {
    let mut pid = 0;
    GetWindowThreadProcessId(h, &mut pid);
    if pid != std::process::id() {
        LAST_FG.store(h as isize, SeqCst);
    }
}

/// Must run on a thread with a message loop (Tauri's main thread).
pub fn watch_foreground() {
    LAST_FG.store(unsafe { GetForegroundWindow() } as isize, SeqCst);
    unsafe {
        SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, null_mut(), Some(on_foreground), 0, 0, WINEVENT_OUTOFCONTEXT)
    };
}

pub fn last_foreground() -> isize {
    LAST_FG.load(SeqCst)
}

fn process_path(h: HWND) -> Option<(u32, String)> {
    unsafe {
        let mut pid = 0u32;
        GetWindowThreadProcessId(h, &mut pid);
        let p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if p.is_null() {
            return None;
        }
        let mut buf = [0u16; 520];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(p, PROCESS_NAME_WIN32, buf.as_mut_ptr(), &mut len);
        CloseHandle(p);
        (ok != 0).then(|| (pid, String::from_utf16_lossy(&buf[..len as usize])))
    }
}

fn text(h: HWND, f: unsafe extern "system" fn(HWND, *mut u16, i32) -> i32) -> String {
    let mut buf = [0u16; 256];
    let n = unsafe { f(h, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub struct AppWindow {
    pub hwnd: isize,
    pub exe: String,
    pub title: String,
}

/// Windows that would get a taskbar button.
pub fn app_windows() -> Vec<AppWindow> {
    unsafe extern "system" fn collect(h: HWND, l: LPARAM) -> i32 {
        (*(l as *mut Vec<HWND>)).push(h);
        1
    }
    let mut all: Vec<HWND> = vec![];
    unsafe { EnumWindows(Some(collect), &mut all as *mut _ as LPARAM) };
    let me = std::process::id();
    all.into_iter()
        .filter(|&h| unsafe {
            let mut cloaked = 0u32;
            DwmGetWindowAttribute(h, DWMWA_CLOAKED as u32, &mut cloaked as *mut _ as *mut c_void, 4);
            IsWindowVisible(h) != 0
                && GetWindow(h, GW_OWNER).is_null()
                && GetWindowLongPtrW(h, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW == 0
                && GetWindowTextLengthW(h) > 0
                && cloaked == 0
                && !matches!(text(h, GetClassNameW).as_str(), "Progman" | "WorkerW" | "Shell_TrayWnd")
        })
        .filter_map(|h| {
            let (pid, exe) = process_path(h)?;
            (pid != me).then(|| AppWindow { hwnd: h as isize, exe, title: text(h, GetWindowTextW) })
        })
        .collect()
}

/// Brings a window forward, or minimises it if it was the active one.
pub fn activate(hwnd: isize) -> bool {
    let h = hwnd as HWND;
    unsafe {
        if IsWindow(h) == 0 {
            return false;
        }
        if hwnd == last_foreground() && IsIconic(h) == 0 {
            ShowWindowAsync(h, SW_MINIMIZE);
            LAST_FG.store(0, SeqCst);
        } else {
            if IsIconic(h) != 0 {
                ShowWindowAsync(h, SW_RESTORE);
            }
            SetForegroundWindow(h);
        }
    }
    true
}

/// Target path stored in a .lnk's LinkInfo (MS-SHLLINK 2.3). None for shell-item-only links.
pub fn lnk_target(bytes: &[u8]) -> Option<String> {
    let u32_at = |o: usize| Some(u32::from_le_bytes(bytes.get(o..o + 4)?.try_into().ok()?));
    let u16_at = |o: usize| Some(u16::from_le_bytes(bytes.get(o..o + 2)?.try_into().ok()?));
    if u32_at(0)? != 0x4C {
        return None;
    }
    let flags = u32_at(20)?;
    let mut li = 76;
    if flags & 1 != 0 {
        li += 2 + u16_at(li)? as usize; // HasLinkTargetIDList
    }
    if flags & 2 == 0 || u32_at(li + 8)? & 1 == 0 {
        return None; // no LinkInfo, or no local base path
    }
    if u32_at(li + 4)? >= 0x24 {
        let off = u32_at(li + 28)? as usize;
        if off != 0 {
            let s: Vec<u16> = bytes
                .get(li + off..)?
                .as_chunks::<2>()
                .0
                .iter()
                .map(|c| u16::from_le_bytes(*c))
                .take_while(|&c| c != 0)
                .collect();
            return Some(String::from_utf16_lossy(&s));
        }
    }
    let s: Vec<u8> = bytes.get(li + u32_at(li + 16)? as usize..)?.iter().copied().take_while(|&c| c != 0).collect();
    Some(String::from_utf8_lossy(&s).into_owned())
}

/* ---------- icons ---------- */

const IID_IIMAGELIST: GUID = GUID::from_u128(0x46eb5926_582e_4017_9fdf_e8998daa0950);

/// 48px shell icon of a file (exe or shortcut) as PNG bytes.
pub fn icon_png(path: &Path) -> Option<Vec<u8>> {
    let p = wide(&path.to_string_lossy());
    unsafe {
        let mut sfi: SHFILEINFOW = zeroed();
        if SHGetFileInfoW(p.as_ptr(), 0, &mut sfi, size_of::<SHFILEINFOW>() as u32, SHGFI_SYSICONINDEX) == 0 {
            return None;
        }
        let mut list: *mut c_void = null_mut();
        if SHGetImageList(SHIL_EXTRALARGE as i32, &IID_IIMAGELIST, &mut list) != 0 {
            return None;
        }
        // An IImageList pointer is usable as an HIMAGELIST.
        let icon = ImageList_GetIcon(list as _, sfi.iIcon, ILD_TRANSPARENT);
        if icon.is_null() {
            return None;
        }
        let png = icon_to_png(icon);
        DestroyIcon(icon);
        png
    }
}

unsafe fn icon_to_png(icon: HICON) -> Option<Vec<u8>> {
    let mut ii: ICONINFO = zeroed();
    if GetIconInfo(icon, &mut ii) == 0 {
        return None;
    }
    let png = bitmap_to_png(ii.hbmColor);
    DeleteObject(ii.hbmColor as _);
    DeleteObject(ii.hbmMask as _);
    png
}

/// 32-bit bitmap to PNG. The caller keeps ownership of the bitmap.
pub fn bitmap_to_png(bmp: HBITMAP) -> Option<Vec<u8>> {
    unsafe {
    let mut bi: BITMAPINFO = zeroed();
    bi.bmiHeader.biSize = size_of::<BITMAPINFOHEADER>() as u32;
    let dc = GetDC(null_mut());
    GetDIBits(dc, bmp, 0, 0, null_mut(), &mut bi, DIB_RGB_COLORS);
    let (w, h) = (bi.bmiHeader.biWidth, bi.bmiHeader.biHeight.abs());
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    bi.bmiHeader.biHeight = -h; // top-down rows
    let mut px = vec![0u8; (w.max(0) * h * 4) as usize];
    let rows = GetDIBits(dc, bmp, 0, h as u32, px.as_mut_ptr() as *mut c_void, &mut bi, DIB_RGB_COLORS);
    ReleaseDC(null_mut(), dc);
    if rows == 0 || w <= 0 {
        return None;
    }
    for p in px.as_chunks_mut::<4>().0 {
        p.swap(0, 2); // BGRA -> RGBA
    }
    if px.as_chunks::<4>().0.iter().all(|p| p[3] == 0) {
        px.as_chunks_mut::<4>().0.iter_mut().for_each(|p| p[3] = 255); // old icons without an alpha channel
    }
    let mut out = Vec::new();
    let mut enc = png::Encoder::new(&mut out, w as u32, h as u32);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header().ok()?.write_image_data(&px).ok()?;
    Some(out)
    }
}

/* ---------- misc ---------- */

/// Opens Start the same way the Windows key does.
pub fn press_start() {
    unsafe {
        keybd_event(VK_LWIN as u8, 0, 0, 0);
        keybd_event(VK_LWIN as u8, 0, KEYEVENTF_KEYUP, 0);
    }
}

/// Windows 11 draws a thin border around rounded windows. The dock never wants that border, and
/// wants Windows' own corner rounding only when the whole window is a glass panel (not liquid mode,
/// where the window is transparent and every capsule draws its own rounded edge).
/// The mouse pointer in the window's own coordinates (physical px), if it is over the window.
pub fn cursor_in(hwnd: HWND) -> Option<(i32, i32)> {
    unsafe {
        let mut pt = zeroed();
        let mut r: RECT = zeroed();
        if GetCursorPos(&mut pt) == 0 || GetWindowRect(hwnd, &mut r) == 0 || IsWindowVisible(hwnd) == 0 {
            return None;
        }
        let (x, y) = (pt.x - r.left, pt.y - r.top);
        (x >= 0 && y >= 0 && x < r.right - r.left && y < r.bottom - r.top).then_some((x, y))
    }
}

pub fn frame(hwnd: HWND, round: bool) {
    let pref = if round { DWMWCP_ROUND } else { DWMWCP_DONOTROUND };
    let no_border: u32 = 0xFFFF_FFFE; // DWMWA_COLOR_NONE
    unsafe {
        DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE as u32, &pref as *const _ as _, size_of::<i32>() as u32);
        DwmSetWindowAttribute(hwnd, DWMWA_BORDER_COLOR as u32, &no_border as *const _ as _, size_of::<u32>() as u32);
    }
}

fn ft(t: FILETIME) -> u64 {
    (t.dwHighDateTime as u64) << 32 | t.dwLowDateTime as u64
}

static PREV_CPU: Mutex<(u64, u64)> = Mutex::new((0, 0));

/// (cpu %, memory %). CPU is the load since the previous call.
pub fn cpu_ram() -> (f32, u32) {
    let (mut idle, mut kernel, mut user) = unsafe { (zeroed(), zeroed(), zeroed()) };
    unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
    let (idle, total) = (ft(idle), ft(kernel) + ft(user)); // kernel time includes idle
    let mut prev = PREV_CPU.lock().unwrap();
    let (di, dt) = (idle.saturating_sub(prev.0), total.saturating_sub(prev.1));
    *prev = (idle, total);
    let cpu = if dt == 0 { 0.0 } else { 100.0 * (1.0 - di as f32 / dt as f32) };

    let mut mem = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..unsafe { zeroed() } };
    unsafe { GlobalMemoryStatusEx(&mut mem) };
    (cpu.clamp(0.0, 100.0), mem.dwMemoryLoad)
}

/// Exe stem of the foreground window's process, e.g. "chrome".
pub fn foreground_exe() -> Option<String> {
    let h = unsafe { GetForegroundWindow() };
    if h.is_null() {
        return None;
    }
    let (_, path) = process_path(h)?;
    Path::new(&path).file_stem().map(|s| s.to_string_lossy().into_owned())
}

pub fn idle_secs() -> u32 {
    let mut li = LASTINPUTINFO { cbSize: size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
    unsafe {
        GetLastInputInfo(&mut li);
        GetTickCount().wrapping_sub(li.dwTime) / 1000
    }
}

/// Local date as YYYY-MM-DD, and the hour.
pub fn local_now() -> (String, u16) {
    let mut t: SYSTEMTIME = unsafe { zeroed() };
    unsafe { GetLocalTime(&mut t) };
    (format!("{:04}-{:02}-{:02}", t.wYear, t.wMonth, t.wDay), t.wHour)
}

#[cfg(test)]
mod tests {
    #[test]
    fn lnk_local_base_path() {
        let mut b = vec![0u8; 76];
        b[0] = 0x4C;
        b[20] = 2; // HasLinkInfo
        let target = b"C:\\Apps\\tool.exe\0";
        let li: [u32; 7] = [0x1C + target.len() as u32, 0x1C, 1, 0, 0x1C, 0, 0];
        li.iter().for_each(|v| b.extend(v.to_le_bytes()));
        b.extend(target);
        assert_eq!(super::lnk_target(&b).as_deref(), Some("C:\\Apps\\tool.exe"));
        b[20] = 0;
        assert_eq!(super::lnk_target(&b), None);
    }
}
