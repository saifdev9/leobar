# 06 — Technical Requirements (inferred from behavior)

| Requirement | Derived from | Windows mechanism (candidate) |
|---|---|---|
| Always-on-top borderless transparent dock | F1 | WS_EX_TOOLWINDOW + topmost; transparent webview or native layer |
| Taskbar auto-hide / hide, restored on exit | F1, E-05 | `SHAppBarMessage(ABM_SETSTATE)`; `ShowWindow(Shell_TrayWnd)`; restore on exit/crash |
| Top/bottom snapping | F1 | Move window to monitor work-area edge |
| Fullscreen hide | F1 | Foreground window rect == monitor rect (poll or `SetWinEventHook`) |
| Pinned apps + open windows | F2 | Read TaskBar pin .lnk dir; `EnumWindows`; `ShellExecute` |
| Media control | Now Playing | `GlobalSystemMediaTransportControlsSessionManager` (WinRT) |
| System stats | F15 | `GetSystemTimes`, `GlobalMemoryStatusEx`, `sysinfo` crate |
| Screen time | F11 | Foreground sampling every 1–5 s + `GetLastInputInfo` idle; local SQLite/JSON |
| Calendar | F6 | HTTPS GET iCal, parse VEVENT/RRULE, 15-min poll |
| Claude session usage | F8 | Read `~/.claude/.credentials.json` token → vendor usage endpoint; fallback parse `~/.claude/projects/**/*.jsonl` `message.usage` |
| Revenue/dev APIs | F9, F10 | Per-provider REST with user key stored locally (DPAPI ideal) |
| Automations | F12 | Local rule engine over widget state; toast/notification strip |
| Settings persistence | F4, F13 | JSON in `%APPDATA%\<app>` |
| Launch at startup | F13 | `HKCU\...\Run` |
| Auto-update | lifecycle | Signed updater (e.g. Tauri updater) |
| Licensing | F14 | Key validation against store API |
| Low idle CPU | review E-10 | Event-driven redraw; no render loop when static |

Verified locally (this machine): Claude Code writes JSONL with `message.usage`
(`input_tokens`, `output_tokens`, `cache_*`), `timestamp`, `sessionId`, `cwd`, `message.model`.
