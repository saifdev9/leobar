# 08 — Unknowns and Assumptions

## Unknowns (not publicly evidenced)
- UI framework / runtime (native, WebView, Electron, Flutter…).
- How "Liquid Glass" refraction is rendered (GPU shader over desktop capture? DWM?).
- Whether the dock reserves work area (AppBar) or overlays windows.
- Multi-monitor support.
- Refresh intervals for AI usage, revenue, analytics tiles.
- Exact Claude usage endpoint and request shape.
- How per-site screen time is attributed.
- Storage format, key encryption at rest.
- Automation rule model beyond the three examples.
- License verification protocol and offline grace.

## Assumptions in our design
- A WebView (Tauri/WebView2) UI is acceptable for a low-overhead dock if idle rendering is static.
- Claude session data: local JSONL logs are the reliable offline source; the vendor usage endpoint is optional and may change.
- Windows-native acrylic is an acceptable substitute for custom refraction.
- Single monitor first.
