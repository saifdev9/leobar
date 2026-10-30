/* Start, apps, and every clock / date / progress widget. */

def('start', { cat: 'Apps & Files', name: 'Start', desc: 'Opens the Windows Start menu',
  tile: () => `<button class="ico start" data-act="start" title="Start">${svg.start}</button>` });
ACT.start = () => invoke('start_menu');

source('apps', 1500, async () => { D.apps = await invoke('apps'); });
def('apps', { cat: 'Apps & Files', name: 'Apps', desc: 'Pinned apps and every open window', src: ['apps'],
  tile() {
    const a = D.apps || [];
    if (!a.length) return '<span class="dim">Pin apps in Windows</span>';
    const loose = a.findIndex((x) => !x.pinned);
    return `<div class="apps">${a.map((x, i) => `${i === loose && i > 0 ? '<i class="vsep"></i>' : ''}
      <button class="app ${x.windows.length ? 'run' : ''} ${x.active ? 'active' : ''}" data-act="app" data-arg="${i}" aria-label="${esc((x.pinned ? x.name : nice(x.name)).replace(/ \(\d+\)$/, ''))}">
        ${x.icon ? `<img src="${x.icon}" alt="">` : `<span class="mono-ico">${esc(x.name.slice(0, 2))}</span>`}<i class="dot"></i></button>`).join('')}</div>`;
  } });
ACT.app = async (i, btn) => {
  const a = D.apps?.[+i]; if (!a) return;
  if (!a.windows.length) {
    if (!a.pinned) return;
    // like a dock: the icon bounces while the app starts
    btn?.classList.remove('bounce'); void btn?.offsetWidth; btn?.classList.add('bounce');
    setTimeout(() => btn?.classList.remove('bounce'), 1300);
    await invoke('launch', { path: a.pinned });
  } else {
    // one window: bring it forward (or minimise it if it is already in front);
    // several: each click moves on to the next one
    const next = a.focus == null ? 0 : (a.focus + 1) % a.windows.length;
    await invoke('activate', { hwnd: a.windows[a.windows.length > 1 ? next : 0] });
  }
  SRC.apps.at = 0;
};

/* ---------- shared clock pieces ---------- */
const zoneName = (z) => z.split('/').pop().replace(/_/g, ' ');
const inZone = (z) => new Date(new Date().toLocaleString('en-US', { timeZone: z }));
const offset = (z) => { const n = new Date(); const h = Math.round((new Date(n.toLocaleString('en-US', { timeZone: z })) - new Date(n.toLocaleString('en-US'))) / 36e5); return h === 0 ? 'same' : (h > 0 ? '+' : '') + h + 'h'; };
const wxNow = () => D.weather?.current;
const wxGlyph = (c = wxNow()) => c ? svg[sky(c.weather_code, c.is_day)[0]] : '';

function analog(d, { face = 'glass', size = 34, sec = true, ticks = 12 } = {}) {
  const h = d.getHours() % 12 + d.getMinutes() / 60, m = d.getMinutes() + d.getSeconds() / 60, s = d.getSeconds();
  const hand = (deg, len, w, cls) => `<line class="${cls}" x1="50" y1="50" x2="${50 + len * Math.sin(deg * Math.PI / 180)}" y2="${50 - len * Math.cos(deg * Math.PI / 180)}" stroke-width="${w}" stroke-linecap="round"/>`;
  const marks = [...Array(ticks)].map((_, i) => { const a = i * 360 / ticks * Math.PI / 180, r1 = i % 3 ? 40 : 36; return `<line x1="${50 + r1 * Math.sin(a)}" y1="${50 - r1 * Math.cos(a)}" x2="${50 + 44 * Math.sin(a)}" y2="${50 - 44 * Math.cos(a)}" class="tk"/>`; }).join('');
  return `<svg class="analog ${face}" viewBox="0 0 100 100" style="width:${size}px;height:${size}px"><circle cx="50" cy="50" r="48" class="face"/>${marks}
    ${hand(h * 30, 24, 6, 'hh')}${hand(m * 6, 34, 4, 'mh')}${sec ? hand(s * 6, 38, 1.6, 'sh') : ''}<circle cx="50" cy="50" r="3.2" class="hub"/></svg>`;
}

const SEG = { 0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg', 5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg' };
const SEGP = { a: 'M2 1h8l-1.5 1.5h-5z', b: 'M10.5 1.5v8L9 8.5V3z', c: 'M10.5 10.5v8L9 17V12z', d: 'M2 19h8l-1.5-1.5h-5z', e: 'M1.5 10.5v8L3 17v-5z', f: 'M1.5 1.5v8L3 8.5V3z', g: 'M2.5 10h7l-1 .9h-5z' };
const segDigit = (n) => `<svg viewBox="0 0 12 20" class="sd">${Object.keys(SEGP).map((k) => `<path d="${SEGP[k]}" class="${SEG[n]?.includes(k) ? 'lit' : ''}"/>`).join('')}</svg>`;
const hhmm = (d) => { const s = time(d).replace(/\s?[AP]M/i, ''); return s.length === 4 ? '0' + s : s; };

def('clock', { cat: 'Clocks', name: 'Clock', desc: 'Weekday, date, time and the temperature', src: ['weather'],
  tile() {
    const n = new Date(), w = wxNow();
    return `<div class="stack datecol"><span class="wd">${n.toLocaleDateString([], { weekday: 'long' })}</span><b>${n.toLocaleDateString([], { month: 'short', day: 'numeric' })}</b></div>
      <div class="stack clock"><b>${time(n, store.seconds ? { second: '2-digit' } : {})}</b>${w ? `<span class="dim">${wxGlyph()} ${deg(w.temperature_2m)}</span>` : ''}</div>`;
  },
  card: () => W.calendar.card() });

def('flip', { cat: 'Clocks', name: 'Flip Clock', desc: 'Split-flap digits that turn every minute',
  tile: () => `<div class="flip">${[...hhmm(new Date())].map((c) => c === ':' ? '<i class="fc">:</i>' : `<span class="fd" data-d="${c}">${c}</span>`).join('')}</div>` });

def('worldclocks', { cat: 'Clocks', name: 'World Clocks', desc: 'Three analog faces for the cities you work with',
  tile: () => `<div class="faces">${store.zones.slice(0, 3).map((z) => `<div class="face-l">${analog(inZone(z), { size: 30, sec: false })}<span class="lbl">${esc(zoneName(z).slice(0, 3))}</span></div>`).join('')}</div>`,
  card: () => zonesCard() });

def('analog', { cat: 'Clocks', name: 'Analog Classic', desc: 'A white face with a sweeping second hand',
  tile: () => analog(new Date(), { face: 'white', size: 40 }) });
def('analogdark', { cat: 'Clocks', name: 'Analog Classic Dark', desc: 'The classic face, in black',
  tile: () => analog(new Date(), { face: 'black', size: 40 }) });
def('analogmin', { cat: 'Clocks', name: 'Analog Minimal', desc: 'Hands and hour ticks, nothing else',
  tile: () => analog(new Date(), { face: 'min', size: 40, sec: false }) });

def('week7', { cat: 'Clocks', name: '7 Days', desc: 'This week as a strip, with today\'s temperature', src: ['weather'],
  tile() {
    const n = new Date(), mon = new Date(+sod(n) - ((n.getDay() + 6) % 7) * DAY);
    return `<div class="week">${[...Array(7)].map((_, i) => { const d = new Date(+mon + i * DAY), t = d.toDateString() === n.toDateString();
      return `<div class="${t ? 'today' : ''}"><span>${d.toLocaleDateString([], { weekday: 'narrow' })}</span><b>${d.getDate()}</b></div>`; }).join('')}</div>
      ${wxNow() ? `<span class="dim tiny-wx">${wxGlyph()}${deg(wxNow().temperature_2m)}</span>` : ''}`;
  } });

def('worldclock', { cat: 'Clocks', name: 'World Clock', desc: 'Cities in a list with their hour difference',
  tile: () => `<div class="zones">${store.zones.slice(0, 3).map((z) => `<div class="stack"><span class="lbl">${esc(zoneName(z).slice(0, 10))} <span class="dim">${offset(z)}</span></span><b>${time(new Date(), { timeZone: z })}</b></div>`).join('')}</div>`,
  card: () => zonesCard() });

def('worldtime', { cat: 'Clocks', name: 'World Time', desc: 'One more city in big digits',
  tile() { const z = store.zones[0] || 'UTC'; return `<div class="stack"><span class="lbl">${esc(zoneName(z))} · ${offset(z)}</span><b class="big2">${time(new Date(), { timeZone: z })}</b></div>`; },
  card: () => zonesCard() });

def('today', { cat: 'Clocks', name: 'Today', desc: 'Weekday, date, time and weather in one tile', src: ['weather'],
  tile() { const n = new Date(), w = wxNow();
    return `<div class="stack"><span class="lbl">${n.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}</span><b class="big">${time(n)}</b></div>${w ? `<span class="wxchip">${wxGlyph()}${deg(w.temperature_2m)}</span>` : ''}`; } });

def('date', { cat: 'Clocks', name: 'Date', desc: 'The full date, set large',
  tile: () => { const n = new Date(); return `<div class="stack"><span class="lbl">${n.getFullYear()}</span><b class="date-big">${n.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'long' })}</b></div>`; } });

def('daynum', { cat: 'Clocks', name: 'Day Number', desc: 'Today as a calendar page',
  tile: () => { const n = new Date(); return `<div class="page big-page"><span>${n.toLocaleDateString([], { month: 'short' })}</span><b>${n.getDate()}</b></div>`; } });

def('segment', { cat: 'Clocks', name: 'Segment Clock', desc: 'Seven-segment time under the weekday and date',
  tile() { const n = new Date(), t = hhmm(n);
    return `<div class="stack"><span class="lbl">${n.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</span><div class="segs">${[...t].map((c) => c === ':' ? '<i class="colon"></i>' : segDigit(+c)).join('')}</div></div>`; } });

def('clockwx', { cat: 'Clocks', name: 'Clock & Weather', desc: 'Time, date and temperature as three blocks', src: ['weather'],
  tile() { const n = new Date(), w = wxNow();
    return `<div class="blocks"><b class="b1">${hhmm(n)}</b><b class="b2">${n.getDate()}<small>${n.toLocaleDateString([], { month: 'short' })}</small></b><b class="b3">${w ? deg(w.temperature_2m) : '—'}</b></div>`; } });

function zonesCard() {
  return `<header><h2>World clock</h2><span class="dim">The first zones show on the dock</span></header>
    ${store.zones.map((z, i) => `<div class="todo"><span class="mono">${time(new Date(), { timeZone: z })}</span><span>${esc(z.replace(/_/g, ' '))} <span class="dim">${offset(z)}</span></span>
      <span class="chips">${i ? `<button class="chip sm" data-act="zone-up" data-arg="${i}">↑</button>` : ''}<button class="ico sm" data-act="zone-del" data-arg="${i}" aria-label="Remove">${svg.x}</button></span></div>`).join('')}
    <form data-form="zone"><input type="text" name="v" list="tz" placeholder="Add a time zone, e.g. Asia/Kolkata" autocomplete="off"><datalist id="tz">${Intl.supportedValuesOf('timeZone').map((z) => `<option value="${z}">`).join('')}</datalist></form>`;
}
ACT['zone-del'] = (i) => { store.zones.splice(+i, 1); save(); };
ACT['zone-up'] = (i) => { const j = +i; [store.zones[j - 1], store.zones[j]] = [store.zones[j], store.zones[j - 1]]; save(); };
FORMS.zone = (v) => { try { new Intl.DateTimeFormat([], { timeZone: v }); store.zones.push(v); } catch {} };

/* progress */
const yearFrac = () => { const n = new Date(), a = new Date(n.getFullYear(), 0, 1), b = new Date(n.getFullYear() + 1, 0, 1); return (n - a) / (b - a); };
const monthFrac = () => { const n = new Date(), a = new Date(n.getFullYear(), n.getMonth(), 1), b = new Date(n.getFullYear(), n.getMonth() + 1, 1); return (n - a) / (b - a); };
const dayFrac = () => (Date.now() - sod(new Date())) / DAY;
def('dayprog', { cat: 'System', name: 'Day Progress', desc: 'How much of today is behind you',
  tile: () => `${ring(dayFrac(), 14)}<div class="stack"><span class="lbl">Day</span><b>${Math.floor(dayFrac() * 100)}%</b></div>` });
def('monthprog', { cat: 'System', name: 'Month Progress', desc: 'How much of the month is behind you',
  tile: () => `<div class="stack"><span class="lbl">${new Date().toLocaleDateString([], { month: 'long' })} · ${Math.floor(monthFrac() * 100)}%</span><span class="bar wide"><i style="width:${monthFrac() * 100}%"></i></span></div>` });
def('yearprog', { cat: 'System', name: 'Year Progress', desc: 'The year as a grid of dots, filling up',
  tile() { const f = yearFrac(), n = 52, lit = Math.floor(f * n);
    return `<div class="dots">${[...Array(n)].map((_, i) => `<i class="${i < lit ? 'lit' : i === lit ? 'now' : ''}"></i>`).join('')}</div><b>${Math.floor(f * 100)}%</b>`; } });
