/* leobar core: store, helpers, widget registry, data sources, glass, rendering, popover, gallery, settings. */
const { invoke } = window.__TAURI__.core;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/* ---------- settings ---------- */
const DEFAULTS = {
  order: ['start', 'apps', 'claudeplan', 'calendar', 'nowplaying', 'sysstats', 'weather', 'clock'],
  theme: 'glass', accent: 'mint', effect: 'live', frost: 'clear', size: 'm', span: 'full', align: 'center', top: false, taskbar: 'hidden', autostart: false,
  clock24: false, seconds: false, unit: 'c',
  claudeWarn: 80, remind: 10, quiet: { on: false, from: '22:00', to: '07:00' },
  todos: [], notes: '', focus: [25, 5], focusDone: {}, focusLog: [],
  icals: [], city: null, zones: ['Europe/London', 'America/New_York', 'Asia/Tokyo'],
  cfg: {},
};
const store = Object.assign(structuredClone(DEFAULTS), (() => { try { return JSON.parse(localStorage.leobar || '{}'); } catch { return {}; } })());
const save = () => { try { localStorage.leobar = JSON.stringify(store); } catch {} };
const cfg = (k, d) => store.cfg[k] ?? d;

/* ---------- geometry ----------
   The dock window keeps one size: the dock row, plus room above it for magnified icons and their
   labels, plus room for the largest popover. Everything outside the capsules and the open popover
   lets clicks through (see hitSync), so the empty space never gets in the way. */
const SIZES = { s: [56, .9], m: [68, 1.06], l: [80, 1.24] }; // dock row height (CSS px), content scale
const HEAD = 64;                       // above the row: magnified icons and their name labels
const POP_GAP = 10, POP_MAX = 460, POP_PAD = 22;
const MAG_SLACK = 90;                  // "fit" width: room either side for icons to swell into
const ACCENTS = { mint: '#9ef0b4', sky: '#8cc8ff', amber: '#ffc46b', rose: '#ff8fab', violet: '#b9a2ff', ice: '#e8f4ff' };
const THEMES = [['glass', 'Glass'], ['frost', 'Frost'], ['midnight', 'Midnight'], ['ink', 'Ink'], ['paper', 'Paper'], ['ember', 'Ember']];
/* What each theme tints the Live glass with (rgb 0–1, strength). Light themes tint toward white,
   and the shader deepens the tint whenever the background would make the text hard to read. */
const GLASS_TINT = {
  glass: [0.04, 0.045, 0.06, 1], frost: [0.95, 0.955, 0.965, 1], midnight: [0.03, 0.05, 0.15, 1.15],
  ink: [0.015, 0.016, 0.02, 1.6], paper: [0.97, 0.965, 0.94, 1.6], ember: [0.17, 0.07, 0.03, 1.15],
};

/* ---------- formatting ---------- */
const DAY = 864e5;
const today = () => new Date().toLocaleDateString('sv'); // YYYY-MM-DD, matches the Rust side
const tok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(Math.round(n));
const num = (n) => Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.abs(n) >= 1e4 ? (n / 1e3).toFixed(1) + 'k' : Math.round(n).toLocaleString();
const money = (n, cur = 'USD') => { try { return new Intl.NumberFormat([], { style: 'currency', currency: cur.toUpperCase(), maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2 }).format(n); } catch { return num(n); } };
const bytes = (b) => { const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (b >= 1024 && i < 4) { b /= 1024; i++; } return `${b >= 100 || i === 0 ? Math.round(b) : b.toFixed(1)} ${u[i]}`; };
const dur = (s) => { const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h}h ${m}m` : `${m}m`; };
const left = (ms) => {
  const s = Math.max(0, (ms - Date.now()) / 1000);
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor(s % 86400 / 3600)}h`;
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor(s % 3600 / 60)).padStart(2, '0')}m`;
  return `${Math.ceil(s / 60)}m`;
};
const ago = (unix) => { const s = Date.now() / 1000 - unix; return s < 60 ? 'now' : s < 3600 ? `${Math.floor(s / 60)}m ago` : s < 86400 ? `${Math.floor(s / 3600)}h ago` : `${Math.floor(s / 86400)}d ago`; };
const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const time = (d, o = {}) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: !store.clock24, ...o });
const pctClass = (p) => p >= 90 ? 'crit' : p >= store.claudeWarn ? 'warn' : '';
const nice = (s) => String(s).replace(/^./, (c) => c.toUpperCase());
const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const deg = (t) => t == null ? '—' : `${Math.round(t)}°`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const ring = (p, r = 15, cls = '') => { const c = 2 * Math.PI * r; return `<svg class="ring ${cls}" viewBox="0 0 36 36"><circle cx="18" cy="18" r="${r}"/><circle class="fill" cx="18" cy="18" r="${r}" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - clamp(p || 0, 0, 1))}"/></svg>`; };
/* area chart: gradient fill under a line that ends in a glowing dot */
const spark = (vals, w = 64, h = 22, cls = '') => {
  const v = vals.filter((x) => x != null);
  if (v.length < 2) return `<svg class="spark ${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1, pad = 3;
  const xy = v.map((x, i) => [pad + i / (v.length - 1) * (w - 2 * pad), h - pad - (x - lo) / span * (h - 2 * pad)]);
  const pts = xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const [ex, ey] = xy[xy.length - 1];
  const fill = cls === 'up' ? 'spark-up' : cls === 'down' ? 'spark-down' : 'spark-fill';
  return `<svg class="spark ${cls}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polygon fill="url(#${fill})" points="${pad},${h} ${pts} ${(w - pad).toFixed(1)},${h}"/><polyline points="${pts}"/><circle class="end" cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="2.6"/></svg>`;
};
const delta = (now, before) => { if (!before) return ''; const p = (now - before) / Math.abs(before) * 100; return `<span class="${p >= 0 ? 'up' : 'down'}">${p >= 0 ? '▲' : '▼'} ${Math.abs(p).toFixed(0)}%</span>`; };

/* ---------- icons (original line glyphs) ---------- */
const I = (d, vb = 24) => `<svg viewBox="0 0 ${vb} ${vb}" class="g">${d}</svg>`;
const svg = {
  start: '<svg viewBox="0 0 16 16"><circle cx="3" cy="3" r="1.6"/><circle cx="8" cy="3" r="1.6"/><circle cx="13" cy="3" r="1.6"/><circle cx="3" cy="8" r="1.6"/><circle cx="8" cy="8" r="1.6"/><circle cx="13" cy="8" r="1.6"/><circle cx="3" cy="13" r="1.6"/><circle cx="8" cy="13" r="1.6"/><circle cx="13" cy="13" r="1.6"/></svg>',
  play: '<svg viewBox="0 0 16 16"><path d="M5 3v10l8-5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><rect x="4" y="3" width="3" height="10" rx="1"/><rect x="9" y="3" width="3" height="10" rx="1"/></svg>',
  next: '<svg viewBox="0 0 16 16"><path d="M3 3v10l7-5zM11 3h2v10h-2z"/></svg>',
  prev: '<svg viewBox="0 0 16 16"><path d="M13 3v10L6 8zM3 3h2v10H3z"/></svg>',
  tick: '<svg viewBox="0 0 16 16"><path d="M6.2 11.6 2.7 8.1l1.1-1.1 2.4 2.4 6-6 1.1 1.1z"/></svg>',
  x: '<svg viewBox="0 0 16 16"><path d="m4 3 4 4 4-4 1 1-4 4 4 4-1 1-4-4-4 4-1-1 4-4-4-4z"/></svg>',
  term: '<svg viewBox="0 0 16 16"><path d="m3 4.2 1-1 4.3 4.3L4 11.8l-1-1 3.3-3.3zM8.5 11h4.5v1.4H8.5z"/></svg>',
  spark: I('<path d="M12 2.5 14 9l6.5 3-6.5 3-2 6.5-2-6.5L3.5 12 10 9z"/>'),
  sun: I('<circle cx="12" cy="12" r="4.5"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8"/></g>'),
  moon: I('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>'),
  cloud: I('<path d="M7 18a5 5 0 0 1-.6-10A6 6 0 0 1 18 9.5a4.3 4.3 0 0 1-.5 8.5z"/>'),
  rain: I('<path d="M7 14a4.5 4.5 0 0 1-.5-9A5.5 5.5 0 0 1 17 6.5a3.8 3.8 0 0 1-.5 7.5z"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m8 17-1 3M12 17l-1 3M16 17l-1 3"/></g>'),
  snow: I('<path d="M7 14a4.5 4.5 0 0 1-.5-9A5.5 5.5 0 0 1 17 6.5a3.8 3.8 0 0 1-.5 7.5z"/><circle cx="8" cy="18.5" r="1.3"/><circle cx="12" cy="20" r="1.3"/><circle cx="16" cy="18.5" r="1.3"/>'),
  storm: I('<path d="M7 14a4.5 4.5 0 0 1-.5-9A5.5 5.5 0 0 1 17 6.5a3.8 3.8 0 0 1-.5 7.5z"/><path d="m12.5 13-3 5h2.5l-1 4 4-6h-2.5l1-3z"/>'),
  fog: I('<g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 9h16M6 13h12M4 17h16"/></g>'),
  wifi: I('<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2.5 9a14 14 0 0 1 19 0M5.5 12.5a9.5 9.5 0 0 1 13 0M8.6 16a5 5 0 0 1 6.8 0"/></g><circle cx="12" cy="19.3" r="1.6"/>'),
  bt: I('<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="m7 7 10 10-5 4V3l5 4L7 17"/>'),
  hotspot: I('<circle cx="12" cy="12" r="2.2"/><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.5 18.5a9.2 9.2 0 0 1 0-13M18.5 5.5a9.2 9.2 0 0 1 0 13"/></g>'),
  plane: I('<path d="M21 15.5v-2l-8-5V3.5a1.5 1.5 0 0 0-3 0v5l-8 5v2l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L13 18v-5z"/>'),
  vol: I('<path d="M4 9h4l5-4v14l-5-4H4z"/><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M16 8.5a5 5 0 0 1 0 7M18.8 6a8.5 8.5 0 0 1 0 12"/></g>'),
  mute: I('<path d="M4 9h4l5-4v14l-5-4H4z"/><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="m16 9 5 6m0-6-5 6"/>'),
  bin: I('<path d="M5 7h14l-1.2 13a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8z"/><rect x="3" y="4" width="18" height="2.2" rx="1"/><rect x="9" y="2" width="6" height="2" rx="1"/>'),
  search: I('<circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="2.2"/><path stroke="currentColor" stroke-width="2.4" stroke-linecap="round" d="m15 15 5.5 5.5"/>'),
  cmd: I('<rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m7 9 3 3-3 3M12 15h5"/>'),
  drive: I('<rect x="3" y="6" width="18" height="12" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="16.5" cy="12" r="1.4"/>'),
  down: I('<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>'),
  shot: I('<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><circle cx="12" cy="12" r="3"/>'),
  clock: I('<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M12 7.5V12l3 2"/>'),
  image: I('<rect x="3" y="4" width="18" height="16" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="10" r="2"/><path d="m5 18 5-5 3 3 2-2 4 4z"/>'),
  file: I('<path fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" d="M6 3h8l4 4v14H6zM14 3v4h4"/>'),
  globe: I('<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="1.6" d="M3.5 12h17M12 3.5c3 3.2 3 13.8 0 17M12 3.5c-3 3.2-3 13.8 0 17"/>'),
  chart: I('<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="m4 16 5-5 4 3 7-8"/>'),
  coin: I('<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M14.8 9.2c-.5-1-1.6-1.5-2.8-1.5-1.6 0-2.8.8-2.8 2.1 0 2.9 5.8 1.5 5.8 4.4 0 1.3-1.3 2.1-3 2.1-1.3 0-2.4-.6-2.9-1.6M12 6v1.7M12 16.3V18"/>'),
  keyb: I('<rect x="2.5" y="6" width="19" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M8 14h8"/>'),
  bolt: I('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  code: I('<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="m8 7-5 5 5 5M16 7l5 5-5 5"/>'),
  mail: I('<rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" d="m4 7 8 6 8-6"/>'),
  db: I('<ellipse cx="12" cy="6" rx="7.5" ry="3" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>'),
  people: I('<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0z"/><circle cx="17" cy="9.5" r="2.7" opacity=".6"/><path d="M16 20a5.4 5.4 0 0 1 6-5.3V20z" opacity=".6"/>'),
  link: I('<path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  battery: I('<rect x="2.5" y="7" width="17" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><rect x="20.5" y="10" width="2" height="4" rx="1"/>'),
  contrast: I('<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z"/>'),
  brightness: I('<circle cx="12" cy="12" r="3.8"/><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1 1M17.4 17.4l1 1M5.6 18.4l1-1M17.4 6.6l1-1"/></g>'),
};

/* ---------- registry & data sources ---------- */
const W = {};
const CAT_ORDER = ['AI', 'Productivity', 'Finance', 'System', 'Media & Audio', 'Analytics', 'Developer', 'Online', 'Social', 'Apps & Files', 'Weather', 'Stocks', 'Clocks'];
function def(id, spec) { W[id] = { src: [], ...spec, id }; }
const SRC = {};
const D = { err: {} };
function source(id, every, load) { SRC[id] = { every, load, at: 0, busy: false }; }
let secrets = new Set();
const has = (...keys) => keys.every((k) => secrets.has(k));

/** HTTPS through the Rust side. Write {{key}} where a saved key belongs; it is filled in there. */
async function api(url, { method = 'GET', headers = {}, body } = {}) {
  const r = await invoke('http', { req: { method, url, headers: Object.entries(headers), body: body == null ? null : typeof body === 'string' ? body : JSON.stringify(body) } });
  if (r.status === 401 || r.status === 403) throw new Error(`key was rejected (${r.status})`);
  if (r.status === 429) throw new Error('rate limited, will retry');
  if (r.status >= 400) throw new Error(`service returned ${r.status}`);
  try { return JSON.parse(r.body); } catch { return r.body; }
}

/* Images from online services come through the Rust side as data URIs, so the page itself never
   talks to third parties (no tracking cookies, no Tracking Prevention warnings). */
const PROX = {};
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
function proxImg(url) {
  if (!url) return BLANK;
  if (PROX[url] === undefined) {
    PROX[url] = '';
    invoke('net_image', { url }).then((d) => { PROX[url] = d; renderDock(); if (open) queueCard(); }).catch(() => {});
  }
  return PROX[url] || BLANK;
}

/* connect form for widgets that read an account */
function connectCard(spec) {
  const c = spec.connect;
  const fields = c.fields.map((f) => {
    const done = f.secret ? secrets.has(f.key) : !!cfg(f.key);
    return `<label class="field"><span class="lbl">${f.label}${done ? ' · <span class="ok">saved</span>' : ''}</span>
      <input type="${f.secret ? 'password' : 'text'}" data-field="${f.key}" data-secret="${f.secret ? 1 : ''}" placeholder="${esc(done && f.secret ? '•••••••• (saved, paste to replace)' : f.placeholder || '')}" value="${f.secret ? '' : esc(cfg(f.key, ''))}" autocomplete="off" spellcheck="false"></label>`;
  }).join('');
  return `<div class="connect"><p>${c.help}</p>${fields}
    <div class="chips"><button class="chip on" data-act="connect-save" data-arg="${spec.id}">Save & check</button>
    ${c.fields.some((f) => f.secret && secrets.has(f.key)) ? `<button class="chip" data-act="connect-clear" data-arg="${spec.id}">Disconnect</button>` : ''}</div>
    <p class="note dim">Keys are encrypted for your Windows account (DPAPI) and only ever sent to ${esc(c.host)}.</p></div>`;
}
const connected = (spec) => !spec.connect || spec.connect.fields.every((f) => f.secret ? secrets.has(f.key) : cfg(f.key));
const locked = (glyph, label = 'Connect') => `<span class="gl">${glyph}</span><span class="dim">${label}</span>`;
const errText = (src) => D.err[src] ? `<p class="note err">${esc(D.err[src])}</p>` : '';

/* ---------- state ---------- */
let open = null, tab = 'widgets', gcat = 'All', gq = '';
let alert = null;
const dismissed = new Set();
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function quiet() {
  if (!store.quiet.on) return false;
  const m = (t) => { const [h, mi] = t.split(':').map(Number); return h * 60 + mi; };
  const n = new Date(), now = n.getHours() * 60 + n.getMinutes(), a = m(store.quiet.from), b = m(store.quiet.to);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}
function chime() {
  if (quiet()) return;
  try {
    const a = new AudioContext(), o = a.createOscillator(), g = a.createGain();
    o.frequency.value = 880; g.gain.setValueAtTime(.15, a.currentTime); g.gain.exponentialRampToValueAtTime(.001, a.currentTime + .6);
    o.connect(g).connect(a.destination); o.start(); o.stop(a.currentTime + .6);
  } catch {}
}
const ALERTS = []; // functions returning {key, text} or null, added by widget files
function checkAlerts() {
  alert = null;
  if (quiet()) return;
  for (const f of ALERTS) {
    try { const a = f(); if (a && !dismissed.has(a.key)) { alert = a; return; } } catch {}
  }
}

/* ---------- glass ----------
   live:   a native GPU layer behind the page refracts whatever is behind the dock, windows included.
           The page only reports where its capsules, popover and labels are (glassSync).
   liquid: "Wallpaper" glass, drawn by the page: the desktop wallpaper, lined up with the real one,
           bent through an SVG lens. It shows up in screenshots; Live does not.
   off:    plain tinted capsules, no glass work at all. */
const LIQ = { url: null, stamp: null, w: 0, h: 0, pos: [0, 0] };
const FROST = { clear: 0.5, soft: 2.5, frosted: 7 }, POP_FROST = { clear: 4, soft: 9, frosted: 16 };
const lensMap = (ex, ey) => 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100" preserveAspectRatio="none"><defs>`
  + `<linearGradient id="x"><stop offset="0" stop-color="#000"/><stop offset="${ex}" stop-color="#800000"/><stop offset="${1 - ex}" stop-color="#800000"/><stop offset="1" stop-color="#f00"/></linearGradient>`
  + `<linearGradient id="y" x2="0" y2="1"><stop offset="0" stop-color="#000"/><stop offset="${ey}" stop-color="#008000"/><stop offset="${1 - ey}" stop-color="#008000"/><stop offset="1" stop-color="#0f0"/></linearGradient>`
  + `</defs><rect width="100" height="100" fill="url(#x)"/><rect width="100" height="100" fill="url(#y)" style="mix-blend-mode:screen"/></svg>`);
const lensFilter = (id, ex, ey, scale) => `<filter id="${id}" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB">
  <feImage href="${lensMap(ex, ey)}" preserveAspectRatio="none" result="map"/>
  <feDisplacementMap in="SourceGraphic" in2="map" scale="${scale}" xChannelSelector="R" yChannelSelector="G"/>
  <feGaussianBlur stdDeviation="0.5" edgeMode="duplicate"/>
  <feComposite in2="SourceAlpha" operator="in"/></filter>`;
function installDefs() {
  const g = (id, c) => `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" style="stop-color:${c};stop-opacity:.42"/><stop offset="1" style="stop-color:${c};stop-opacity:0"/></linearGradient>`;
  document.body.insertAdjacentHTML('afterbegin', `<svg id="liquid-defs" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
    ${g('spark-fill', 'var(--accent)')}${g('spark-up', 'var(--up)')}${g('spark-down', 'var(--down)')}</defs>
    ${lensFilter('lg-seg', 0.16, 0.36, -26)}${lensFilter('lg-pop', 0.05, 0.08, -22)}</svg>`);
}
function placeWall() {
  const r = document.documentElement, sw = screen.width, sh = screen.height, k = Math.max(sw / LIQ.w, sh / LIQ.h) || 1;
  r.style.setProperty('--wall-w', LIQ.w * k + 'px');
  r.style.setProperty('--wall-h', LIQ.h * k + 'px');
  r.style.setProperty('--wall-x', (sw - LIQ.w * k) / 2 - LIQ.pos[0] + 'px');
  r.style.setProperty('--wall-y', (sh - LIQ.h * k) / 2 - LIQ.pos[1] + 'px');
}
let glassFailed = '', glassPrev = '';
const wantLive = () => store.effect === 'live' && !glassFailed;
const wallMode = () => store.effect === 'liquid' || (store.effect === 'live' && !!glassFailed);
const squircle = CSS.supports('corner-shape', 'squircle');
/* every glass shape on screen: [x, y, w, h, corner radius, kind (0 capsule, 1 panel), opacity] */
function glassShapes() {
  const out = [], strip = $('#strip').getBoundingClientRect();
  for (const s of document.querySelectorAll('#dock .seg')) {
    const r = s.getBoundingClientRect();
    const seen = (Math.min(r.right, strip.right) - Math.max(r.left, strip.left)) / r.width; // scrolled partly out: fades
    if (seen > 0.02) out.push([r.left, r.top, r.width, r.height, 18 * zoom, 0, Math.min(1, seen * 1.25)]);
  }
  const pop = $('#pop');
  if (open && pop.dataset.state) {
    const r = pop.getBoundingClientRect(), k = r.width / Math.max(1, pop.offsetWidth);
    const o = parseFloat(getComputedStyle(pop).opacity);
    if (r.width > 8 && o > 0.02) out.push([r.left, r.top, r.width, r.height, 26 * k, 1, o]);
  }
  const tip = $('#tip');
  if (tip.classList.contains('on')) {
    const r = tip.getBoundingClientRect(), o = parseFloat(getComputedStyle(tip).opacity);
    if (o > 0.02) out.push([r.left, r.top, r.width, r.height, r.height / 2, 0, o]);
  }
  return out;
}
function glassSync() {
  const live = wantLive(), shapes = live ? glassShapes() : [];
  const frost = ({ clear: 1.5, soft: 4, frosted: 9 })[store.frost] ?? 1.5;
  const tint = GLASS_TINT[store.theme] || GLASS_TINT.glass;
  const key = JSON.stringify([live, frost, store.theme, shapes.map((a) => a.map((v) => Math.round(v * 20) / 20))]);
  if (key === glassPrev) return;
  glassPrev = key;
  invoke('glass_set', { enabled: live, frost, squircle, tint, shapes }).catch(console.error);
}
/* follows an animation (popover, label, icons settling) frame by frame */
let followUntil = 0, followTimer = 0;
function glassFollow(ms = 460) {
  if (!wantLive()) return;
  followUntil = Math.max(followUntil, Date.now() + ms);
  if (followTimer) return;
  followTimer = setInterval(() => {
    glassSync();
    if (Date.now() > followUntil) { clearInterval(followTimer); followTimer = 0; glassSync(); }
  }, 16);
}
async function glassWatch() {
  if (store.effect !== 'live') return;
  const s = await invoke('glass_status').catch(() => 'error: unavailable');
  const failed = s.startsWith('error') ? s.slice(7) : '';
  if (failed !== glassFailed) { glassFailed = failed; applyEffect(); }
}
function applyGlass() {
  const root = document.documentElement, live = wantLive(), wall = wallMode() && !!LIQ.url;
  root.classList.toggle('gpu', live); // not 'live': that class is the session dot
  root.classList.toggle('liquid', wall);
  root.classList.toggle('solid', !live && !wall);
  document.querySelector('#lg-seg feGaussianBlur')?.setAttribute('stdDeviation', FROST[store.frost] ?? 0.5);
  document.querySelector('#lg-pop feGaussianBlur')?.setAttribute('stdDeviation', POP_FROST[store.frost] ?? 4);
  glassSync();
  if (!wall) return;
  root.style.setProperty('--wall', `url("${LIQ.url}")`);
  placeWall();
  segOffsets(true);
}
async function loadWall() {
  try {
    const r = await invoke('wallpaper', { known: LIQ.stamp });
    if (!r) LIQ.url = null;
    else if (r[1]) {
      const url = URL.createObjectURL(await (await fetch(r[1])).blob()), img = new Image();
      img.src = url; await img.decode();
      if (LIQ.url) URL.revokeObjectURL(LIQ.url);
      Object.assign(LIQ, { url, stamp: r[0], w: img.naturalWidth, h: img.naturalHeight });
    }
  } catch (e) { console.error(e); }
  applyGlass();
}
/* wallpaper glass: each capsule needs its place on screen to line its slice of wallpaper up */
function segOffsets(force) {
  if (!document.documentElement.classList.contains('liquid')) return;
  for (const s of document.querySelectorAll('#dock .seg, #pop')) {
    const r = s.getBoundingClientRect(), k = `${Math.round(r.left)},${Math.round(r.top)}`;
    if (!force && s._o === k) continue;
    s._o = k;
    s.style.setProperty('--ex', (s.id === 'pop' ? s.offsetLeft : r.left) + 'px');
    s.style.setProperty('--ey', (s.id === 'pop' ? s.offsetTop : r.top) + 'px');
  }
}
const applyEffect = () => (wallMode() ? loadWall() : applyGlass());

/* ---------- click-through ----------
   Only the dock row, the open popover and (while the pointer is on them) the swollen icons take
   the mouse; the rest of the window passes clicks and hovers to whatever is behind it. */
let hitPrev = '', hitAll = false;
function hitSync() {
  const rects = [], d = $('#dock').getBoundingClientRect();
  const l = Math.max(0, d.left), r = Math.min(innerWidth, d.right);
  if (r > l) rects.push([l, d.top, r - l, d.height]);
  const pop = $('#pop');
  if (open && pop.dataset.state) { const p = pop.getBoundingClientRect(); rects.push([p.left, p.top, p.width, p.height]); }
  if (mag) {
    const a = $('#dock .t-apps')?.getBoundingClientRect();
    if (a) rects.push([a.left, store.top ? a.top : a.top - HEAD, a.width, a.height + HEAD]);
  }
  const key = JSON.stringify([hitAll, rects.map((x) => x.map(Math.round))]);
  if (key === hitPrev) return;
  hitPrev = key;
  invoke('hit_set', { rects, all: hitAll }).catch(console.error);
}

/* ---------- the dock gesture: icons swell as the pointer passes over them ---------- */
const MAG = { peak: 1.72, reach: 2.5 }; // peak scale; reach in icon widths either side
let mag = null, magX = 0, magFrame = 0;
function magStart() {
  const icons = [...document.querySelectorAll('#dock .apps .app')];
  if (!icons.length) return null;
  const w = icons[0].getBoundingClientRect().width;
  // centres at rest, so the swell doesn't chase its own layout
  mag = { w, icons: icons.map((el) => { const r = el.getBoundingClientRect(); return { el, cx: r.left + r.width / 2 }; }) };
  $('#dock .apps').classList.add('mag');
  return mag;
}
function magApply() {
  magFrame = 0;
  if (!mag || !mag.icons[0].el.isConnected) { mag = null; if (!magStart()) return; }
  const reach = MAG.reach * mag.w;
  let best = null, bestS = 1.04;
  for (const it of mag.icons) {
    const t = Math.max(0, 1 - Math.abs(magX - it.cx) / reach);
    const s = 1 + (MAG.peak - 1) * t * t * (3 - 2 * t);
    it.el.style.setProperty('--s', s.toFixed(3));
    if (s > bestS) { bestS = s; best = it.el; }
  }
  showTip(best);
  glassFollow(240);
  hitSync();
}
function magMove(x) {
  if (reduced()) return;
  magX = x;
  if (!magFrame) magFrame = requestAnimationFrame(magApply);
}
function magEnd() {
  if (!mag) return;
  for (const it of mag.icons) it.el.style.removeProperty('--s');
  $('#dock .apps')?.classList.remove('mag');
  mag = null;
  showTip(null);
  glassFollow(320); // the platter settles back with a transition; the glass follows it
  setTimeout(() => { hitSync(); if (!mag) fit(); }, 340);
}
/* the name label over the icon under the pointer */
function showTip(el) {
  const tip = $('#tip');
  if (!el) { tip.classList.remove('on'); return; }
  const label = el.getAttribute('aria-label') || '';
  if (tip.textContent !== label) tip.textContent = label;
  const r = (el.querySelector('img, .mono-ico') || el).getBoundingClientRect();
  tip.style.left = `${r.left + r.width / 2}px`;
  tip.style.top = `${store.top ? r.bottom + 10 : r.top - 10}px`;
  tip.classList.add('on');
}

/* ---------- rendering ---------- */
let built = '', fitted = '', zoom = 1; // zoom: the content scale in use (always equal to --z)
const safeTile = (id) => { try { return W[id].tile(); } catch (e) { console.error(id, e); return `<span class="dim">${esc(W[id].name)}</span>`; } };
function applyLook() {
  const [h] = SIZES[store.size] || SIZES.m;
  const root = document.documentElement;
  root.dataset.theme = store.theme;
  root.style.setProperty('--accent', ACCENTS[store.accent] || ACCENTS.mint);
  root.style.setProperty('--dock-h', h + 'px');
  root.style.setProperty('--head', HEAD + 'px');
  document.body.classList.toggle('top', store.top);
  document.body.classList.toggle('full', store.span === 'full');
}
function renderDock() {
  applyLook();
  const ids = store.order.filter((id) => W[id]);
  const dock = $('#dock'), strip = $('#strip');
  const key = `${ids}|${open}|${alert?.key}`;
  if (key !== built) {
    built = key;
    const scroll = strip.scrollLeft;
    dock.innerHTML = (alert ? `<div class="seg alert"><span>${esc(alert.text)}</span><button class="ico sm" data-act="dismiss" aria-label="Dismiss">${svg.x}</button></div>` : '')
      + ids.map((id) => {
        const c = !!W[id].card;
        return `<div class="seg tile t-${id} ${c ? 'has-card' : ''} ${open === id ? 'on' : ''}" data-id="${id}"${c ? ` role="button" tabindex="0" aria-haspopup="dialog" aria-expanded="${open === id}" aria-label="${esc(W[id].name)}"` : ''}></div>`;
      }).join('');
    strip.scrollLeft = scroll;
    if (mag) magEnd();
  }
  for (const el of dock.querySelectorAll('.tile')) {
    const h = safeTile(el.dataset.id);
    if (el._h !== h) { el._h = h; el.innerHTML = h; }
  }
  dock.querySelectorAll('img[data-thumb]:not([src^="data"])').forEach(loadThumb);
  fitZoom();
  if (!mag) fit();
  dockEdges();
  segOffsets();
  glassSync();
  hitSync();
}
/* Like a dock, the bar shrinks its tiles (down to 78% of the chosen size) rather than run off the
   screen; in full width it keeps room for the app icons to swell. Past that, it scrolls. */
function fitZoom() {
  if (mag) return;
  const base = SIZES[store.size]?.[1] || 1, d = $('#dock'), kids = [...d.children];
  // the tiles' own width at scale 1: widths, gaps and padding (6 and 2 × 8 in the stylesheet)
  const w1 = kids.reduce((a, k) => a + k.getBoundingClientRect().width, 0) / zoom + 6 * Math.max(0, kids.length - 1) + 16;
  const room = store.span === 'full' ? innerWidth - (d.querySelector('.t-apps') ? 90 : 0) - 4 : screen.width - 16 - 2 * MAG_SLACK;
  const z = w1 * base > room ? Math.max(base * 0.78, room / w1) : base;
  if (Math.abs(z - zoom) < 0.004) return;
  zoom = z;
  document.documentElement.style.setProperty('--z', z.toFixed(4));
}
/* When the tiles still don't fit, the bar scrolls sideways and fades at the edge that hides more. */
function dockEdges() {
  const s = $('#strip'), room = s.scrollWidth - s.clientWidth;
  s.classList.toggle('ovl', room > 1 && s.scrollLeft > 2);
  s.classList.toggle('ovr', room > 1 && s.scrollLeft < room - 2);
}
function cardHtml() {
  if (open === 'settings') return settingsCard();
  const w = W[open];
  if (w.connect && !connected(w)) return `<header><h2>${w.name}</h2><span class="dim">${w.desc}</span></header>${connectCard(w)}`;
  return w.card() + (w.connect ? `<details class="conn"><summary class="dim">Connection</summary>${connectCard(w)}</details>` : '');
}
/* Live data re-renders the open card. Replacing it mid-scroll would cancel the scroll, so a card
   only re-renders when its content changed, and waits until the user has stopped scrolling. */
let cardPrev = '', scrollingUntil = 0, cardLater = 0, cardQueued = 0;
/* data refreshes go through here: several sources finishing together cost one render, not one each */
function queueCard() {
  if (!cardQueued) cardQueued = setTimeout(() => { cardQueued = 0; renderCard(); }, 250);
}
function renderCard() {
  const card = $('#card');
  if (open && Date.now() < scrollingUntil) {
    clearTimeout(cardLater);
    cardLater = setTimeout(renderCard, scrollingUntil - Date.now() + 50);
    return;
  }
  let html;
  try { html = open ? cardHtml() : ''; } catch (e) { console.error(e); html = `<p class="err">${esc(e.message)}</p>`; }
  if (html === cardPrev) return;
  const top = card.scrollTop, g = card.querySelector('.gallery');
  const gtop = g && g.dataset.k === `${gcat}|${gq}` ? g.scrollTop : 0; // the gallery grid scrolls on its own
  cardPrev = html;
  card.innerHTML = html;
  card.scrollTop = top;
  if (gtop) card.querySelector('.gallery').scrollTop = gtop;
  card.querySelectorAll('[data-thumb]').forEach(loadThumb);
  sizePop();
  if (open) { placePop(); glassSync(); hitSync(); }
}

/* ---------- popover: opens above (or below) the tile that was clicked, sized to its content ---------- */
/* popover widths: roomy where the content is a grid or a timeline */
const POP_W = { calendar: 640, clock: 640, claude: 560, claudeplan: 560, codex: 520, screen: 540, daytimeline: 540, wallpaper: 620, screenshots: 560 };
const popWidth = () => Math.min(innerWidth - 16, open === 'settings' ? (tab === 'widgets' ? 860 : 580)
  : W[open]?.popW || POP_W[open] || (W[open]?.cat === 'Weather' ? 620 : W[open]?.cat === 'Finance' ? 580 : 460));
function sizePop() {
  const pop = $('#pop'), card = $('#card');
  if (!open) return;
  pop.style.setProperty('--pop-w', popWidth() + 'px');
  pop.style.height = 'auto';
  const h = open === 'settings' && tab === 'widgets' ? POP_MAX : Math.min(POP_MAX, card.scrollHeight + 2);
  pop.style.height = h + 'px';
}
/* Lines the popover up with its tile (or centres it, for Settings). */
function placePop() {
  const pop = $('#pop');
  if (!open) return;
  const w = popWidth(), tile = $('#dock .tile.on');
  const r = tile?.getBoundingClientRect();
  const cx = r ? r.left + r.width / 2 : innerWidth / 2;
  const x = clamp(cx - w / 2, 8, Math.max(8, innerWidth - w - 8));
  pop.style.setProperty('--pop-x', x + 'px');
  pop.style.setProperty('--pop-w', w + 'px');
  pop.style.setProperty('--origin', clamp(cx - x, 24, w - 24) + 'px');
  segOffsets(true);
}
document.addEventListener('wheel', (e) => { if (e.target.closest('#card')) scrollingUntil = Date.now() + 900; }, { passive: true, capture: true });
document.addEventListener('scroll', (e) => { if (e.target.closest?.('#card')) scrollingUntil = Math.max(scrollingUntil, Date.now() + 300); }, true);
function fit() {
  const [dockH] = SIZES[store.size] || SIZES.m;
  // Full width asks for the whole screen; Rust clamps it to the monitor minus the margins.
  // Fit asks for the tiles' width plus room for icons to swell and for the widest popover.
  const content = $('#dock').getBoundingClientRect().width;
  const width = store.span === 'full' ? screen.width : Math.ceil(Math.max(content + 2 * MAG_SLACK, 860 + 32));
  const height = dockH + POP_GAP + POP_MAX + POP_PAD;
  const k = `${width}x${height}:${store.top}:${store.align}:${store.span}`;
  if (k === fitted) return;
  fitted = k;
  invoke('layout', { width, height, dock: dockH, top: store.top, align: store.span === 'full' ? 'center' : store.align })
    .then((p) => { if (p) { LIQ.pos = p; if (LIQ.url) placeWall(); } dockEdges(); segOffsets(true); placePop(); glassSync(); hitSync(); })
    .catch(console.error);
}

/* ---------- drag the dock to any edge: top or bottom, and left / centre / right when it fits its content ---------- */
let drag = null;
function dropTarget(e) {
  const top = e.screenY < screen.height / 2;
  const align = store.span === 'full' ? 'center' : e.screenX < screen.width / 3 ? 'left' : e.screenX > screen.width * 2 / 3 ? 'right' : 'center';
  return { top, align };
}
document.addEventListener('pointerdown', (e) => {
  if (e.target.closest('#dock .seg')) glassFollow(300);
  if (e.button !== 0 || open || e.target.closest('.seg, #pop, button, input, select, textarea')) return;
  drag = { x: e.screenX, y: e.screenY, moved: false };
  e.target.setPointerCapture?.(e.pointerId);
});
document.addEventListener('pointermove', (e) => {
  if (drag) {
    if (!drag.moved && Math.hypot(e.screenX - drag.x, e.screenY - drag.y) < 18) return;
    if (!drag.moved) { drag.moved = true; hitAll = true; hitSync(); document.body.classList.add('dragging'); }
    const t = dropTarget(e);
    if (t.top !== store.top || t.align !== store.align) { Object.assign(store, t); fitted = ''; renderDock(); } // live preview
    return;
  }
  if (overApps(e)) magMove(e.clientX);
  else if (mag) magEnd();
});
function overApps(e) {
  const a = $('#dock .t-apps')?.getBoundingClientRect();
  if (!a || e.clientX < a.left || e.clientX > a.right) return false;
  const head = mag ? HEAD : 0;
  return store.top ? e.clientY >= a.top && e.clientY <= a.bottom + head : e.clientY >= a.top - head && e.clientY <= a.bottom;
}
document.addEventListener('pointerup', (e) => {
  if (e.target.closest?.('#dock .seg')) glassFollow(300);
  if (!drag) return;
  document.body.classList.remove('dragging');
  if (drag.moved) { save(); hitAll = false; hitSync(); }
  drag = null;
});
document.documentElement.addEventListener('pointerleave', () => { if (mag) magEnd(); });

/* Signature motion: the popover grows out of the tile that was clicked and settles like a drop of
   glass (slight overshoot), then shrinks back into it. The Live glass follows it frame by frame. */
let closing = 0;
function toggle(id) {
  const next = open === id ? null : id;
  const pop = $('#pop');
  if (!next) {
    if (!open) return;
    pop.dataset.state = 'closing';
    glassFollow(220);
    const was = open;
    clearTimeout(closing);
    closing = setTimeout(() => {
      if (open !== was) return;
      open = null;
      delete pop.dataset.state;
      renderDock(); renderCard(); glassSync(); hitSync();
    }, reduced() ? 0 : 170);
    return;
  }
  clearTimeout(closing);
  const switching = !!open && pop.dataset.state === 'open'; // from one tile's popover to another: no re-entrance
  open = next;
  W[open]?.onOpen?.();
  if (mag) magEnd();
  if (!switching) pop.dataset.state = 'opening'; // shown (still transparent) first, so it can be measured
  renderCard(); renderDock(); pump();
  placePop();
  void pop.offsetWidth; // apply the start pose now, so the change below animates
  pop.dataset.state = 'open';
  glassFollow();
  hitSync();
  $('#card input[type=text]:not([data-keep]), #card textarea')?.focus();
}

/* lazily loaded shell thumbnails: <img data-thumb="path"> */
const THUMBS = {};
function loadThumb(img) {
  const p = img.dataset.thumb;
  if (THUMBS[p] !== undefined) { if (THUMBS[p]) img.src = THUMBS[p]; return; }
  invoke('thumb', { path: p }).then((d) => { THUMBS[p] = d || ''; if (d) img.src = d; }).catch(() => { THUMBS[p] = ''; });
}

/* ---------- gallery & settings ---------- */
function galleryCard() {
  const cats = ['All', 'On dock', ...CAT_ORDER.filter((c) => Object.values(W).some((w) => w.cat === c))];
  const q = gq.toLowerCase();
  const list = Object.values(W).filter((w) => (gcat === 'All' || (gcat === 'On dock' ? store.order.includes(w.id) : w.cat === gcat))
    && (!q || (w.name + ' ' + w.desc + ' ' + w.cat).toLowerCase().includes(q)));
  if (gcat === 'On dock') list.sort((a, b) => store.order.indexOf(a.id) - store.order.indexOf(b.id));
  return `<div class="gal-head"><input type="text" data-keep="1" id="gsearch" placeholder="Search ${Object.keys(W).length} widgets" value="${esc(gq)}" autocomplete="off">
    <div class="chips cats">${cats.map((c) => `<button class="chip ${gcat === c ? 'on' : ''}" data-act="gcat" data-arg="${c}">${c}${c === 'On dock' ? ' · ' + store.order.length : ''}</button>`).join('')}</div></div>
    <div class="gallery" data-k="${esc(gcat + '|' + gq)}">${list.map((w) => {
      const on = store.order.includes(w.id);
      return `<div class="gitem ${on ? 'on' : ''}" data-act="w-toggle" data-arg="${w.id}">
        <div class="preview"><div class="seg tile t-${w.id}">${safeTile(w.id)}</div></div>
        <div class="gmeta"><b>${w.name}</b><span class="dim">${w.desc}</span></div>
        <span class="badge">${on ? svg.tick : '+'}</span>
        ${on && gcat === 'On dock' ? `<span class="move"><button class="chip sm" data-act="w-move" data-arg="${w.id}:-1" aria-label="Move left">←</button><button class="chip sm" data-act="w-move" data-arg="${w.id}:1" aria-label="Move right">→</button></span>` : ''}</div>`;
    }).join('') || '<p class="dim">No widget matches.</p>'}</div>`;
}
/* macOS-style controls: a segmented control for choices, a switch for on/off */
const segmented = (key, opts) => `<div class="segmented" role="radiogroup">${opts.map(([v, label]) =>
  `<button class="${store[key] === v ? 'on' : ''}" role="radio" aria-checked="${store[key] === v}" data-act="set" data-arg="${key}:${v}">${label}</button>`).join('')}</div>`;
const toggleSwitch = (on, act, arg = '', label = '') =>
  `<button class="switch ${on ? 'on' : ''}" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-act="${act}" data-arg="${arg}"><i></i></button>`;
function settingsCard() {
  const tabs = `<div class="segmented tabs" role="tablist"><button class="${tab === 'widgets' ? 'on' : ''}" role="tab" data-act="tab" data-arg="widgets">Widgets</button><button class="${tab === 'settings' ? 'on' : ''}" role="tab" data-act="tab" data-arg="settings">Settings</button></div>`;
  if (tab === 'widgets') return tabs + galleryCard();
  const row = (label, body, hint = '') => `<div class="setting"><span class="slabel"><span>${label}</span>${hint ? `<span class="dim hint">${hint}</span>` : ''}</span><div class="sctl">${body}</div></div>`;
  const group = (title, rows) => `<h3 class="lbl">${title}</h3><div class="group">${rows}</div>`;
  const glassHint = store.effect === 'live'
    ? (glassFailed ? `Live glass is unavailable here (${esc(glassFailed)}), so the wallpaper glass is used` : 'Bends whatever is behind the dock, windows included. The dock is hidden from screenshots and screen sharing while it is on')
    : store.effect === 'liquid' ? 'Bends your wallpaper; shows up in screenshots' : 'Plain tinted capsules, lightest on battery';
  return `${tabs}
    ${group('Look', `
      ${row('Glass', segmented('effect', [['live', 'Live'], ['liquid', 'Wallpaper'], ['off', 'Off']]), glassHint)}
      ${store.effect !== 'off' ? row('Clarity', segmented('frost', [['clear', 'Clear'], ['soft', 'Soft'], ['frosted', 'Frosted']])) : ''}
      ${row('Theme', `<div class="themes">${THEMES.map(([v, l]) => `<button class="theme-dot t-${v} ${store.theme === v ? 'on' : ''}" data-act="set" data-arg="theme:${v}" aria-label="${l}" title="${l}"></button>`).join('')}</div>`, THEMES.find(([v]) => v === store.theme)?.[1])}
      ${row('Accent', `<div class="themes">${Object.entries(ACCENTS).map(([k, c]) => `<button class="swatch ${store.accent === k ? 'on' : ''}" style="--c:${c}" data-act="set" data-arg="accent:${k}" aria-label="${k}"></button>`).join('')}</div>`)}
      ${row('Size', segmented('size', [['s', 'S'], ['m', 'M'], ['l', 'L']]))}
      ${row('Width', segmented('span', [['full', 'Full'], ['fit', 'Fit']]), 'Full spreads the tiles across the screen')}
      ${row('Edge', segmented('top', [[false, 'Bottom'], [true, 'Top']]), 'Or drag the dock by a gap between tiles')}
      ${store.span === 'fit' ? row('Position', segmented('align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']])) : ''}`)}
    ${group('Windows', `
      ${row('Windows taskbar', segmented('taskbar', [['hidden', 'Hidden'], ['autohide', 'Auto-hide']]), 'Quitting leobar brings it back')}
      ${row('Start with Windows', toggleSwitch(store.autostart, 'flip', 'autostart', 'Start with Windows'))}`)}
    ${group('Clock & units', `
      ${row('Clock', segmented('clock24', [[false, '12-hour'], [true, '24-hour']]))}
      ${row('Show seconds', toggleSwitch(store.seconds, 'flip', 'seconds', 'Show seconds'))}
      ${row('Temperature', segmented('unit', [['c', '°C'], ['f', '°F']]))}`)}
    ${group('Alerts', `
      ${row('AI limit warning', segmented('claudeWarn', [[70, '70%'], [80, '80%'], [90, '90%'], [101, 'Off']]), 'Claude and ChatGPT session or week')}
      ${row('Event reminder', segmented('remind', [[5, '5 min'], [10, '10'], [15, '15'], [0, 'Off']]), 'Before the next calendar event')}
      ${row('Quiet hours', `${store.quiet.on ? `<input type="time" class="tm" data-quiet="from" value="${store.quiet.from}" aria-label="From"><span class="dim">to</span><input type="time" class="tm" data-quiet="to" value="${store.quiet.to}" aria-label="To">` : ''}${toggleSwitch(store.quiet.on, 'quiet-toggle', '', 'Quiet hours')}`, 'Holds alerts and chimes')}`)}
    <div class="setting actions"><button class="chip" data-act="reset">Reset layout</button><button class="chip danger" data-act="quit">Quit leobar</button></div>`;
}

/* ---------- actions ---------- */
const ACT = {
  set: (arg) => {
    const [k, raw] = arg.split(':');
    const v = raw === 'true' ? true : raw === 'false' ? false : /^\d+$/.test(raw) ? +raw : raw;
    store[k] = v; save();
    if (k === 'taskbar') return invoke('taskbar_mode', { hidden: v === 'hidden' });
    if (k === 'effect') { glassFailed = ''; return applyEffect(); }
    if (k === 'theme' || k === 'frost') return applyGlass();
    if (k === 'unit') { SRC.weather.at = 0; pump(); }
    if (['size', 'span', 'top', 'align'].includes(k)) fitted = '';
    checkAlerts();
  },
  flip: (k) => {
    store[k] = !store[k]; save();
    if (k === 'autostart') return invoke('autostart', { on: store[k] });
  },
  tab: (t) => { tab = t; },
  gcat: (c) => { gcat = c; },
  'w-toggle': (id) => { store.order = store.order.includes(id) ? store.order.filter((x) => x !== id) : [...store.order, id]; save(); pump(); },
  'w-move': (arg) => {
    const [id, d] = arg.split(':'), i = store.order.indexOf(id), j = i + +d;
    if (j >= 0 && j < store.order.length) { [store.order[i], store.order[j]] = [store.order[j], store.order[i]]; save(); }
  },
  'quiet-toggle': () => { store.quiet.on = !store.quiet.on; save(); checkAlerts(); },
  reset: () => { store.order = DEFAULTS.order.slice(); save(); },
  dismiss: () => { dismissed.add(alert?.key); checkAlerts(); },
  quit: () => invoke('quit'),
  open: (t) => invoke('open', { target: t }),
  reveal: (t) => invoke('open', { target: t, reveal: true }),
  'connect-save': async (id) => {
    for (const el of document.querySelectorAll('#card [data-field]')) {
      const v = el.value.trim();
      if (el.dataset.secret) { if (v) await invoke('secret_set', { name: el.dataset.field, value: v }); }
      else store.cfg[el.dataset.field] = v;
    }
    save();
    secrets = new Set(await invoke('secret_names'));
    for (const s of W[id].src) { SRC[s].at = 0; delete D.err[s]; }
    await pump(true);
  },
  'connect-clear': async (id) => {
    for (const f of W[id].connect.fields) if (f.secret) await invoke('secret_set', { name: f.key, value: '' });
    secrets = new Set(await invoke('secret_names'));
  },
};
const FORMS = {}; // data-form handlers, added by widget files

const rerender = () => { renderDock(); renderCard(); };
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a) {
    e.stopPropagation();
    const inCard = !!a.closest('#card');
    scrollingUntil = 0; // a click should show its result at once
    Promise.resolve(ACT[a.dataset.act]?.(a.dataset.arg, a)).catch((err) => console.error(err)).finally(() => { renderDock(); if (inCard || open) renderCard(); });
    return;
  }
  const t = e.target.closest('#dock .tile.has-card');
  if (t) toggle(t.dataset.id);
  else if (open && !e.target.closest('#pop')) toggle(null); // click outside closes the popover
});
document.addEventListener('keydown', (e) => {
  const t = e.target.closest?.('#dock .tile.has-card');
  if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(t.dataset.id); }
});
document.addEventListener('submit', (e) => {
  e.preventDefault();
  const v = e.target.v?.value.trim(), f = FORMS[e.target.dataset.form];
  if (v && f) Promise.resolve(f(v, e.target)).catch(console.error).finally(() => { save(); rerender(); $('#card form input')?.focus(); });
});
document.addEventListener('input', (e) => {
  if (e.target.id === 'gsearch') { gq = e.target.value; const pos = e.target.selectionStart; renderCard(); const s = $('#gsearch'); s.focus(); s.setSelectionRange(pos, pos); return; }
  if (e.target.type === 'range') e.target.style.setProperty('--v', `${(e.target.value - e.target.min) / (e.target.max - e.target.min) * 100}%`);
  W[open]?.onInput?.(e);
});
document.addEventListener('change', (e) => {
  const q = e.target.dataset.quiet;
  if (q) { store.quiet[q] = e.target.value; save(); checkAlerts(); renderDock(); }
  W[open]?.onChange?.(e);
});
/* Wheel over the bar: a tile's own wheel action (volume, brightness), else scroll the bar sideways.
   Attached to the bar only (in boot): a page-wide cancelable wheel listener would make every
   scroll, cards included, wait for page code to run. */
function dockWheel(e) {
  const t = e.target.closest('.tile');
  if (t && W[t.dataset.id].onWheel && !e.shiftKey) { e.preventDefault(); W[t.dataset.id].onWheel(e.deltaY < 0 ? 1 : -1); return; }
  const s = $('#strip');
  if (s.scrollWidth > s.clientWidth) { e.preventDefault(); s.scrollLeft += e.deltaY || e.deltaX; }
}
document.addEventListener('scroll', (e) => { if (e.target.id === 'strip') { dockEdges(); segOffsets(); glassSync(); hitSync(); } }, true);
window.addEventListener('resize', () => { fitZoom(); dockEdges(); segOffsets(true); placePop(); glassSync(); hitSync(); });
document.addEventListener('contextmenu', (e) => { if (!e.target.closest('#card')) { e.preventDefault(); toggle('settings'); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) toggle(null); });
window.addEventListener('blur', () => { if (open) toggle(null); if (mag) magEnd(); });

/* ---------- scheduler: runs the sources that visible widgets need ---------- */
const editing = () => ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
function needed() {
  const ids = new Set(store.order);
  if (open && W[open]) ids.add(open);
  const s = new Set();
  for (const id of ids) for (const x of W[id]?.src || []) s.add(x);
  return s;
}
async function pump(force) {
  const now = Date.now(), jobs = [];
  for (const id of needed()) {
    const s = SRC[id];
    if (!s || s.busy || (!force && now - s.at < s.every)) continue;
    s.busy = true; s.at = now;
    jobs.push(Promise.resolve().then(s.load).then(() => { delete D.err[id]; }).catch((e) => { D.err[id] = e.message || String(e); })
      .finally(() => {
        s.busy = false; checkAlerts(); renderDock();
        if (open && open !== 'settings' && W[open]?.src.includes(id) && !editing()) queueCard(); // the gallery stays still while browsed
      }));
  }
  await Promise.all(jobs);
}

async function boot() {
  installDefs();
  $('#dock').addEventListener('wheel', dockWheel, { passive: false });
  try { secrets = new Set(await invoke('secret_names')); } catch {}
  invoke('taskbar_mode', { hidden: store.taskbar === 'hidden' }).catch(console.error);
  applyEffect();
  setInterval(() => { if (wallMode()) loadWall(); }, 30e3); // follows wallpaper changes
  setInterval(glassWatch, 2000); glassWatch();
  renderDock(); pump();
  setInterval(pump, 500);
  setInterval(() => {
    for (const w of Object.values(W)) w.tick?.();
    checkAlerts(); renderDock();
    if (open && W[open]?.live && !editing()) queueCard();
  }, 1000);
}
