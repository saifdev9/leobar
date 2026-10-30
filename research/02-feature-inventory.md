# 02 — Feature Inventory

Each feature: problem · workflow · UI · interaction · evidence · inferred tech · unknowns.
"Inferred" = deduced from public behavior only. Nothing here comes from binaries or source.

## F1 Dock (taskbar replacement)
- **Problem:** Windows taskbar shows icons, not information.
- **Workflow:** Install → dock appears bottom → taskbar set to auto-hide or hidden → right-click dock for menu.
- **UI:** Rounded pill or full-width bar; app icons left, widget tiles middle, date/time/weather right (E-01 screenshot).
- **Interaction:** Drag empty area to top half → snaps top, panels open downward; drag back to return. Hides on fullscreen apps.
- **Evidence:** E-01, E-05 (FAQ taskbar/top), E-07 (docs §3, §5).
- **Inferred tech:** Topmost layered window; AppBar (`SHAppBarMessage`) or work-area reservation; taskbar auto-hide via `ABM_SETSTATE`; fullscreen detection via foreground window bounds vs monitor; persisted edge.
- **Unknown:** Multi-monitor behaviour; whether it reserves work area; UI toolkit.

## F2 Apps widget
- **Problem:** Need Start, pinned apps and open windows once the taskbar is hidden.
- **UI:** Start tile + pinned icons + running windows with indicator dots (E-01).
- **Evidence:** E-05 FAQ "Can I add my own apps" — mirrors pins from Windows taskbar plus every open window.
- **Inferred tech:** Read `%APPDATA%\Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar` .lnk files; `EnumWindows` for top-level visible windows; icon extraction; `SetForegroundWindow`.
- **Unknown:** Grouping, jump lists, thumbnails.

## F3 Widget ecosystem (100+ tiles, 13 categories)
AI 10 · Productivity 9 · Finance 15 · System 14 · Media 5 · Analytics 3 · Developer 3 · Online & Mail 7 ·
Social 4 · Apps & Files 9 · Weather 7 · Stocks 3 · Clocks 14 (E-02). Full list in E-02 capture.

## F4 Widget customization
- **Workflow:** Right-click → "Widgets…" → picker (category + search) → click tile to add; click again or "−" badge to remove; drag to reorder (E-07 §2).
- **UI:** Picker grid of preview tiles; dock enters edit mode with − badges.
- **Inferred tech:** Ordered list of widget IDs persisted locally; drag-and-drop reorder.

## F5 Tile → Card pattern
- Clicking a tile opens a larger **card** (panel) with detail, settings, connection status ("Check again") (E-08).
- **Inferred tech:** Popup window anchored above/below tile depending on dock edge.

## F6 Calendar
- **Problem:** Dates scattered across calendars, billing, AI resets.
- **Workflow:** Paste secret iCal URL in Calendar card; polled every 15 min, read-only (E-05).
- **UI:** Tile = next event + countdown ("Calculus lecture 11:15 AM · in 1h 27m"); card = month grid with event dots + agenda (E-01, E-09).
- **Inferred tech:** HTTP GET + ICS parsing (incl. RRULE); merges derived events (renewals, payouts, AI resets).
- **Unknown:** Recurrence/timezone handling depth.

## F7 Productivity tools
Pomodoro, Timer, Stopwatch (laps), Todos (progress ring), Notes, Day Timeline, Currency (E-02).
Local state only (E-05 "todos, notes … stay on your PC").

## F8 AI usage / Claude session (developer integration)
- **Problem:** Hitting AI plan limits unexpectedly.
- **Workflow:** Install Claude Code, sign in, add "Claude Usage" tile, press "Check again" (E-08).
- **UI:** Tile shows "Session 2h 40m 41%" and "Weekly Tue 3 64%" with bars (E-01).
- **Inferred tech:** Reads Claude Code's locally stored sign-in, calls vendor usage endpoint; fallback counts tokens from Claude Code's local logs (E-08 explicit).
- **Unknown:** Exact endpoint and refresh cadence.
- Similar tiles: ChatGPT/Codex, Gemini CLI, Grok, Cursor, DeepSeek, GLM, OpenCode.

## F9 Developer integrations
GitHub (notifications, PRs, contribution grid), Linear, Supabase, Resend, LeetCode — user-supplied read-only keys (E-02, E-07).

## F10 Revenue integrations
Stripe, Polar, Dodo, Shopify, Lemon Squeezy, Paddle, Gumroad; Total Revenue aggregates 30 days with monthly goal (E-02).
Inferred: each provider's REST API with restricted key, 30-day sums, 14-day charts.

## F11 Screen time
- Per-app and per-site time, hourly today, by day/week (E-02, E-04 image alt).
- **Inferred tech:** Foreground-window sampling (`GetForegroundWindow` + process name), idle detection (`GetLastInputInfo`), local DB. Site attribution — unknown (browser title parsing likely).

## F12 Automations
Pause music before a meeting; warn before AI limit runs out; ask before plan renewals; Quiet hours hold all alerts; each automation a single switch (E-05, E-06). Runs locally.

## F13 Themes & personalization
Styles: Black, White, Liquid Glass, iOS Glass, Midnight (+Glass variants); size S/M/L; 12/24h clock; top/bottom; pill/full width; launch at startup (E-04, E-07).
"Liquid Glass" refracts wallpaper live, idles when nothing changes behind it (E-04, review text).

## F14 Pricing & licensing
See 01. License activation only on button press; never reads clipboard (E-07).

## F15 System widgets
CPU/RAM rings, temperature, network chart, battery, quick toggles (Wi-Fi, BT, hotspot, airplane), brightness, theme toggle, tray grid, keyboard layout, storage (E-02).
