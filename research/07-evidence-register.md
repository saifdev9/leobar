# 07 — Evidence Register

All evidence is public web content observed in a browser on 2026-10-30. No binary, installer or source
was available, so REA binary/runtime tools (decompile, PE imports/resources, Frida, process capture) could not be used.

| ID | Source | Type | Content |
|---|---|---|---|
| E-01 | https://lumabar.xyz/ hero | Screenshot `screenshots/01-home-hero.png` + DOM text | Dock layout, sample tile values, notification strip |
| E-02 | https://lumabar.xyz/widgets | DOM text + `screenshots/02-widgets.png` | Full widget list with categories and counts |
| E-03 | Home "Built for what you check every day" | DOM text + image alts | Four persona layouts |
| E-04 | Home "Real Liquid Glass" / "Your dock, your look" | DOM text + image alts | Six styles, top/bottom, pill/full |
| E-05 | Home FAQ | DOM text | Automations, iCal 15 min, taskbar behaviour, data policy, apps widget |
| E-06 | Home pricing | DOM text | $5.99 once, 14-day refund, 64/32-bit, quiet hours, local automations |
| E-07 | https://lumabar.xyz/docs | DOM text | Install, picker, top snap, styles, taskbar, accounts, updates, security table |
| E-08 | https://lumabar.xyz/docs/connect-claude | DOM text | Claude tile reads Claude Code sign-in; log-based token fallback |
| E-09 | Calendar image alt | DOM attr | Month grid with events, payouts, renewals, agenda |
| E-10 | Home reviews | DOM text (user-generated) | Glass idles when static; low resource use |
| E-11 | Local machine | File inspection | Claude Code JSONL `message.usage` schema verified |

## REA capability notes
- Available & relevant: web page inspection / screenshots / browser scenarios (used Playwright for capture; REA `capture_browser_scenario` schema call rejected once, not retried).
- Unavailable without a desktop binary: PE imports/resources/certificates, decompilation, native call tracing, Electron/JS bundle analysis, process capture.
