//! Files the dock shows: recent items, Downloads, screenshots and Start menu apps, plus shell thumbnails.
use crate::win;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use windows::core::HSTRING;
use windows::Win32::Foundation::SIZE;
use windows::Win32::UI::Shell::{IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_RESIZETOFIT};

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub modified: u64,
    pub size: u64,
}

fn env(var: &str) -> PathBuf {
    PathBuf::from(std::env::var(var).unwrap_or_default())
}

pub fn known(which: &str) -> Option<PathBuf> {
    let home = env("USERPROFILE");
    Some(match which {
        "downloads" => home.join("Downloads"),
        "screenshots" => home.join(r"Pictures\Screenshots"),
        "recent" => env("APPDATA").join(r"Microsoft\Windows\Recent"),
        _ => return None,
    })
}

/// Newest files first, at most `limit`, skipping folders and desktop.ini.
pub fn newest(dir: &Path, limit: usize) -> Vec<Entry> {
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut v: Vec<Entry> = rd
        .flatten()
        .filter_map(|e| {
            let m = e.metadata().ok()?;
            let name = e.file_name().to_string_lossy().into_owned();
            (m.is_file() && !name.eq_ignore_ascii_case("desktop.ini")).then(|| Entry {
                path: e.path().to_string_lossy().into_owned(),
                modified: m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs()),
                size: m.len(),
                name,
            })
        })
        .collect();
    v.sort_by_key(|e| std::cmp::Reverse(e.modified));
    v.truncate(limit);
    v
}

/// Recent items, resolved from their shortcuts to the real file.
pub fn recent(limit: usize) -> Vec<Entry> {
    newest(&known("recent").unwrap(), limit * 3)
        .into_iter()
        .filter_map(|e| {
            let target = win::lnk_target(&std::fs::read(&e.path).ok()?)?;
            let name = Path::new(&target).file_name()?.to_string_lossy().into_owned();
            Path::new(&target).exists().then_some(Entry { name, path: target, ..e })
        })
        .take(limit)
        .collect()
}

/// Start menu shortcuts whose name contains `query`.
pub fn start_apps(query: &str) -> Vec<Entry> {
    let q = query.to_lowercase();
    let roots = [env("APPDATA").join(r"Microsoft\Windows\Start Menu\Programs"), env("ProgramData").join(r"Microsoft\Windows\Start Menu\Programs")];
    let mut out = vec![];
    fn walk(d: &Path, q: &str, out: &mut Vec<Entry>, depth: u8) {
        let Ok(rd) = std::fs::read_dir(d) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() && depth > 0 {
                walk(&p, q, out, depth - 1);
            } else if p.extension().is_some_and(|x| x == "lnk") {
                let name = p.file_stem().unwrap_or_default().to_string_lossy().into_owned();
                if name.to_lowercase().contains(q) && !name.to_lowercase().contains("uninstall") {
                    out.push(Entry { name, path: p.to_string_lossy().into_owned(), modified: 0, size: 0 });
                }
            }
        }
    }
    for r in roots {
        walk(&r, &q, &mut out, 3);
    }
    out.sort_by_key(|e| (!e.name.to_lowercase().starts_with(&q), e.name.len()));
    out.dedup_by(|a, b| a.name == b.name);
    out.truncate(8);
    out
}

/// Shell thumbnail (what Explorer shows) as a PNG data URI.
pub fn thumbnail(path: &str, px: i32) -> Option<String> {
    use base64::Engine;
    unsafe {
        let f: IShellItemImageFactory = SHCreateItemFromParsingName(&HSTRING::from(path), None).ok()?;
        let bmp = f.GetImage(SIZE { cx: px, cy: px }, SIIGBF_RESIZETOFIT).ok()?;
        let png = win::bitmap_to_png(bmp.0 as _);
        windows::Win32::Graphics::Gdi::DeleteObject(bmp.into()).ok().ok();
        png.map(|b| format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(b)))
    }
}

/// Opens a URL, a settings page or an existing file/folder with its default handler.
pub fn open(target: &str, reveal: bool) -> Result<(), String> {
    let allowed_uri = ["https://", "http://", "ms-settings:", "ms-screenclip:", "ms-actioncenter:"].iter().any(|p| target.starts_with(p))
        || target == "shell:RecycleBinFolder";
    let mut cmd = std::process::Command::new("explorer");
    if allowed_uri {
        cmd.arg(target);
    } else if Path::new(target).exists() {
        if reveal {
            cmd.arg(format!("/select,{target}"));
        } else {
            cmd.arg(target);
        }
    } else {
        return Err("nothing to open there".into());
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}
