//! System readings and switches: battery, disk, network, keyboard layout, recycle bin,
//! wallpaper, light/dark theme and brightness.
use crate::win::{last_foreground, wide};
use serde::Serialize;
use std::ffi::c_void;
use std::mem::{size_of, zeroed};
use std::os::windows::process::CommandExt;
use std::ptr::{null, null_mut};
use std::sync::Mutex;
use std::time::Instant;
use windows_sys::Win32::Foundation::{HWND, LPARAM};
use windows_sys::Win32::Globalization::LCIDToLocaleName;
use windows_sys::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows_sys::Win32::System::Registry::{RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_DWORD, RRF_RT_REG_DWORD};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetKeyboardLayout, GetKeyboardLayoutList};
use windows_sys::Win32::UI::Shell::{SHEmptyRecycleBinW, SHQueryRecycleBinW, SHQUERYRBINFO};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetWindowThreadProcessId, PostMessageW, SendMessageTimeoutW, SystemParametersInfoW, HWND_BROADCAST, SMTO_ABORTIFHUNG,
    SPIF_SENDCHANGE, SPIF_UPDATEINIFILE, SPI_GETDESKWALLPAPER, SPI_SETDESKWALLPAPER, WM_INPUTLANGCHANGEREQUEST, WM_SETTINGCHANGE,
};

const NO_WINDOW: u32 = 0x0800_0000;

#[derive(Serialize)]
pub struct Battery {
    percent: u8,
    charging: bool,
    minutes: Option<u32>,
}

pub fn battery() -> Option<Battery> {
    let mut s: SYSTEM_POWER_STATUS = unsafe { zeroed() };
    if unsafe { GetSystemPowerStatus(&mut s) } == 0 || s.BatteryFlag & 128 != 0 || s.BatteryLifePercent > 100 {
        return None; // no system battery
    }
    Some(Battery {
        percent: s.BatteryLifePercent,
        charging: s.ACLineStatus == 1,
        minutes: (s.BatteryLifeTime != u32::MAX).then_some(s.BatteryLifeTime / 60),
    })
}

/// (free, total) bytes for a drive root such as "C:\".
pub fn disk(root: &str) -> Option<(u64, u64)> {
    let (mut free, mut total, mut all_free) = (0u64, 0u64, 0u64);
    let ok = unsafe { GetDiskFreeSpaceExW(wide(root).as_ptr(), &mut free, &mut total, &mut all_free) };
    (ok != 0).then_some((free, total))
}

static NET: Mutex<Option<(Instant, u64, u64)>> = Mutex::new(None);

/// (download, upload) bytes per second across physical adapters since the previous call.
pub fn net_rate() -> (f64, f64) {
    let (mut rx, mut tx) = (0u64, 0u64);
    unsafe {
        let mut t: *mut MIB_IF_TABLE2 = null_mut();
        if GetIfTable2(&mut t) != 0 {
            return (0.0, 0.0);
        }
        let rows = std::slice::from_raw_parts((*t).Table.as_ptr(), (*t).NumEntries as usize);
        for r in rows {
            // HardwareInterface bit, adapter up: skips loopback, tunnels and the filter layers that repeat each NIC.
            if r.InterfaceAndOperStatusFlags._bitfield & 1 != 0 && r.OperStatus == 1 {
                rx += r.InOctets;
                tx += r.OutOctets;
            }
        }
        FreeMibTable(t as *const c_void);
    }
    let now = Instant::now();
    let mut prev = NET.lock().unwrap();
    let rate = match *prev {
        Some((at, prx, ptx)) => {
            let s = now.duration_since(at).as_secs_f64().max(0.001);
            (rx.saturating_sub(prx) as f64 / s, tx.saturating_sub(ptx) as f64 / s)
        }
        None => (0.0, 0.0),
    };
    *prev = Some((now, rx, tx));
    rate
}

fn locale(lang: u32) -> String {
    let mut buf = [0u16; 85];
    let n = unsafe { LCIDToLocaleName(lang, buf.as_mut_ptr(), buf.len() as i32, 0) };
    String::from_utf16_lossy(&buf[..(n.max(1) - 1) as usize])
}

fn layouts() -> Vec<usize> {
    let mut list = [null_mut(); 32];
    let n = unsafe { GetKeyboardLayoutList(list.len() as i32, list.as_mut_ptr()) };
    list[..n.max(0) as usize].iter().map(|h| *h as usize).collect()
}

/// Keyboard layout of the app the user is typing in, e.g. "en-US", plus every installed one.
pub fn keyboard() -> (String, Vec<String>) {
    let fg = last_foreground() as HWND;
    let hkl = unsafe { GetKeyboardLayout(GetWindowThreadProcessId(fg, null_mut())) } as usize;
    (locale((hkl & 0xffff) as u32), layouts().iter().map(|h| locale((h & 0xffff) as u32)).collect())
}

/// Switches the active app to the next installed layout.
pub fn next_keyboard() {
    let fg = last_foreground() as HWND;
    let cur = unsafe { GetKeyboardLayout(GetWindowThreadProcessId(fg, null_mut())) } as usize;
    let all = layouts();
    if let Some(i) = all.iter().position(|&h| h == cur) {
        let next = all[(i + 1) % all.len()];
        unsafe { PostMessageW(fg, WM_INPUTLANGCHANGEREQUEST, 0, next as LPARAM) };
    }
}

/// (items, bytes) in the Recycle Bin.
pub fn recycle_bin() -> (i64, i64) {
    let mut q = SHQUERYRBINFO { cbSize: size_of::<SHQUERYRBINFO>() as u32, ..unsafe { zeroed() } };
    unsafe { SHQueryRecycleBinW(null(), &mut q) };
    (q.i64NumItems, q.i64Size)
}

/// Windows asks for confirmation before emptying.
pub fn empty_recycle_bin() {
    unsafe { SHEmptyRecycleBinW(null_mut(), null(), 0) };
}

/// The image Windows is showing as the desktop background.
pub fn wallpaper_path() -> Option<std::path::PathBuf> {
    let mut buf = [0u16; 520];
    unsafe { SystemParametersInfoW(SPI_GETDESKWALLPAPER, buf.len() as u32, buf.as_mut_ptr() as *mut c_void, 0) };
    let n = buf.iter().position(|&c| c == 0).unwrap_or(0);
    let p = std::path::PathBuf::from(String::from_utf16_lossy(&buf[..n]));
    if n > 0 && p.is_file() {
        return Some(p);
    }
    // Slideshows and some themes only leave the processed copy.
    let t = std::path::PathBuf::from(std::env::var("APPDATA").ok()?).join(r"Microsoft\Windows\Themes\TranscodedWallpaper");
    t.is_file().then_some(t)
}

pub fn set_wallpaper(path: &str) -> bool {
    let p = wide(path);
    unsafe { SystemParametersInfoW(SPI_SETDESKWALLPAPER, 0, p.as_ptr() as *mut c_void, SPIF_UPDATEINIFILE | SPIF_SENDCHANGE) != 0 }
}

const PERSONALIZE: &str = r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";

pub fn light_theme() -> bool {
    let (mut v, mut n) = (1u32, 4u32);
    let key = wide(PERSONALIZE);
    unsafe {
        RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), wide("AppsUseLightTheme").as_ptr(), RRF_RT_REG_DWORD, null_mut(), &mut v as *mut _ as *mut c_void, &mut n)
    };
    v == 1
}

pub fn set_light_theme(light: bool) {
    let v = light as u32;
    let key = wide(PERSONALIZE);
    for name in ["AppsUseLightTheme", "SystemUsesLightTheme"] {
        unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), wide(name).as_ptr(), REG_DWORD, &v as *const _ as *const c_void, 4) };
    }
    let topic = wide("ImmersiveColorSet");
    unsafe { SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, topic.as_ptr() as LPARAM, SMTO_ABORTIFHUNG, 200, null_mut()) };
}

pub fn powershell(script: &str) -> Result<String, String> {
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ponytail: WMI brightness only works for built-in laptop panels; external monitors need DDC/CI.
pub fn brightness() -> Option<u32> {
    powershell("(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1).CurrentBrightness")
        .ok()?
        .parse()
        .ok()
}

pub fn set_brightness(level: u32) -> Result<(), String> {
    powershell(&format!(
        "Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{{Timeout=1;Brightness={}}} | Out-Null",
        level.min(100)
    ))
    .map(|_| ())
}
