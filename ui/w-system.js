/* System, media & audio, apps & files. */

/* ---------- system ---------- */
const NET = [];
source('sys', 2000, async () => { D.sys = await invoke('system_stats'); });
source('sensors', 2000, async () => {
  D.sensors = await invoke('sensors');
  NET.push(D.sensors.net); if (NET.length > 30) NET.shift();
});
const cpu = () => Math.round(D.sys?.[0] ?? 0), ram = () => D.sys?.[1] ?? 0;
const ringStat = (label, v) => `<div class="ringstat">${ring(v / 100, 14, v >= 90 ? 'crit' : '')}<span><b>${v}</b><small>%</small></span></div><span class="lbl">${label}</span>`;
const rate = (b) => b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB/s' : b >= 1e3 ? Math.round(b / 1e3) + ' KB/s' : Math.round(b) + ' B/s';

def('sysstats', { cat: 'System', name: 'System Stats', desc: 'CPU and RAM as two live rings', src: ['sys'],
  tile: () => `<div class="ringstat">${ring(cpu() / 100, 14, cpu() >= 90 ? 'crit' : '')}<span><b>${cpu()}</b></span></div><div class="stack tight"><span class="lbl">CPU</span><span class="lbl">RAM</span></div><div class="ringstat">${ring(ram() / 100, 14, ram() >= 90 ? 'crit' : '')}<span><b>${ram()}</b></span></div>` });
def('cpu', { cat: 'System', name: 'CPU', desc: 'Processor load as a ring', src: ['sys'], tile: () => ringStat('CPU', cpu()) });
def('ram', { cat: 'System', name: 'RAM', desc: 'Memory in use as a ring', src: ['sys'], tile: () => ringStat('RAM', ram()) });
def('system', { cat: 'System', name: 'System Bars', desc: 'CPU and memory as two bars', src: ['sys'],
  tile: () => { const m = (v) => `<span><i style="height:${Math.max(4, v)}%;${v >= 90 ? 'background:var(--crit)' : ''}"></i></span>`;
    return `<div class="meter">${m(cpu())}${m(ram())}</div><div class="stack"><div><span class="lbl">CPU</span> <b>${cpu()}%</b></div><div><span class="lbl">RAM</span> <b>${ram()}%</b></div></div>`; } });
def('network', { cat: 'System', name: 'Network', desc: 'Download and upload speed with a live chart', src: ['sensors'],
  tile: () => { const [d, u] = D.sensors?.net || [0, 0];
    return `${spark(NET.map((x) => x[0]), 56, 26)}<div class="stack tight"><span><span class="lbl">↓</span> <b>${rate(d)}</b></span><span><span class="lbl">↑</span> <b class="dim">${rate(u)}</b></span></div>`; } });
def('battery', { cat: 'System', name: 'Battery', desc: 'Charge level as a filling gauge', src: ['sensors'],
  tile() { const b = D.sensors?.battery;
    if (!b) return locked(svg.battery, D.sensors ? 'No battery' : '…');
    return `<div class="batt ${b.percent <= 15 && !b.charging ? 'low' : ''}"><i style="width:${b.percent}%"></i>${b.charging ? `<span>${svg.bolt}</span>` : ''}</div><div class="stack tight"><b>${b.percent}%</b><span class="dim">${b.charging ? 'charging' : b.minutes ? dur(b.minutes * 60) + ' left' : 'on battery'}</span></div>`; } });
def('storage', { cat: 'Apps & Files', name: 'Storage', desc: 'Free space on your drive, with a usage bar', src: ['sensors'],
  tile() { const d = D.sensors?.disk; if (!d) return locked(svg.drive, '…'); const used = 1 - d[0] / d[1];
    return `<span class="gl">${svg.drive}</span><div class="stack"><span><b>${bytes(d[0])}</b> <span class="dim">free</span></span><span class="bar wide ${used > .9 ? 'crit' : ''}"><i style="width:${used * 100}%"></i></span></div>`; } });
def('language', { cat: 'System', name: 'Language', desc: 'The current keyboard layout; click to switch', src: ['sensors'],
  tile: () => `<button class="langbtn" data-act="next-kb" title="Switch layout">${svg.keyb}<b>${esc((D.sensors?.keyboard?.[0] || '--').split('-')[0].toUpperCase())}</b></button>` });
ACT['next-kb'] = async () => { await invoke('system_action', { action: 'next-keyboard' }); setTimeout(() => { SRC.sensors.at = 0; pump(); }, 300); };
def('toggles', { cat: 'System', name: 'Quick Toggles', desc: 'Wi-Fi, Bluetooth, hotspot and airplane mode settings',
  tile: () => `<div class="qt">${[['wifi', 'ms-settings:network-wifi', 'Wi-Fi'], ['bt', 'ms-settings:bluetooth', 'Bluetooth'], ['hotspot', 'ms-settings:network-mobilehotspot', 'Mobile hotspot'], ['plane', 'ms-settings:network-airplanemode', 'Airplane mode']]
    .map(([g, uri, t]) => `<button class="ico" data-act="open" data-arg="${uri}" title="${t}">${svg[g]}</button>`).join('')}</div>` });
def('theme', { cat: 'System', name: 'Theme Toggle', desc: 'Switch Windows between light and dark mode', src: ['sensors'],
  tile: () => { const light = D.sensors?.light; return `<button class="ico themebtn ${light ? 'light' : ''}" data-act="win-theme" title="Switch to ${light ? 'dark' : 'light'} mode">${light ? svg.sun : svg.moon}</button>`; } });
ACT['win-theme'] = async () => { await invoke('system_action', { action: D.sensors?.light ? 'dark' : 'light' }); SRC.sensors.at = 0; await pump(true); };
source('brightness', 60e3, async () => { D.brightness = await invoke('brightness'); });
def('brightness', { cat: 'System', name: 'Brightness', desc: 'A slider for the display\'s brightness', src: ['brightness'],
  tile: () => D.brightness == null ? locked(svg.brightness, D.err.brightness ? 'n/a' : '…') : `<span class="gl">${svg.brightness}</span><span class="bar wide"><i style="width:${D.brightness}%"></i></span><b>${D.brightness}%</b>`,
  card: () => `<header><h2>Brightness</h2><b>${D.brightness ?? '—'}%</b></header>
    ${D.brightness == null ? '<p class="dim">This display does not report brightness to Windows (external monitors usually don\'t).</p>' : `<input type="range" min="0" max="100" value="${D.brightness}" data-bright class="slider" style="--v:${D.brightness}%" aria-label="Brightness">`}`,
  onWheel(d) { if (D.brightness == null) return; D.brightness = clamp(D.brightness + d * 5, 0, 100); renderDock(); invoke('set_brightness', { level: D.brightness }); },
  onChange(e) { if (e.target.dataset.bright != null) { D.brightness = +e.target.value; invoke('set_brightness', { level: D.brightness }); renderDock(); } } });
def('recycle', { cat: 'Apps & Files', name: 'Recycle Bin', desc: 'What the bin holds, and a click to empty it', src: ['sensors'],
  tile() { const [n, b] = D.sensors?.recycle || [0, 0];
    return `<span class="gl">${svg.bin}</span><div class="stack tight"><b>${n} item${n === 1 ? '' : 's'}</b><span class="dim">${bytes(b)}</span></div>`; },
  card() { const [n, b] = D.sensors?.recycle || [0, 0];
    return `<header><h2>Recycle Bin</h2><span class="dim">${n} items · ${bytes(b)}</span></header>
      <div class="chips"><button class="chip" data-act="open" data-arg="shell:RecycleBinFolder">Open</button><button class="chip danger" data-act="empty-bin" ${n ? '' : 'disabled'}>Empty…</button></div>
      <p class="note dim">Windows asks you to confirm before anything is deleted.</p>`; } });
ACT['empty-bin'] = async () => { await invoke('system_action', { action: 'empty-recycle' }); SRC.sensors.at = 0; await pump(true); };

/* ---------- media & audio ---------- */
source('media', 1000, async () => { D.media = await invoke('media_state'); });
const M = () => D.media || {};
const mctl = (a, v) => invoke('media_cmd', { action: a, value: v ?? null }).then(() => { SRC.media.at = 0; setTimeout(pump, 250); });
ACT.media = (a) => mctl(a);
const artImg = (cls = 'art') => M().art ? `<img class="${cls}" src="${M().art}" alt="">` : `<span class="${cls} noart">♪</span>`;
const ctrls = (full = true) => `<div class="mctl">${full ? `<button class="ico sm" data-act="media" data-arg="prev" title="Previous">${svg.prev}</button>` : ''}<button class="ico play" data-act="media" data-arg="toggle" title="${M().playing ? 'Pause' : 'Play'}">${M().playing ? svg.pause : svg.play}</button><button class="ico sm" data-act="media" data-arg="next" title="Next">${svg.next}</button></div>`;
const nothing = () => `<span class="gl">♪</span><span class="dim">Nothing playing</span>`;
const prog = () => M().duration ? clamp(M().position / M().duration, 0, 1) : 0;
const mediaCard = () => `<header><h2>Now Playing</h2><span class="dim">${esc((M().app || '').split('!').pop().replace(/\.exe$/i, ''))}</span></header>
  ${M().title ? `<div class="np-card">${artImg('art xl')}<div class="stack"><b class="plain big">${esc(M().title)}</b><span class="dim">${esc(M().artist)}</span>
    <span class="bar wide"><i style="width:${prog() * 100}%"></i></span><span class="dim mono">${mmss(M().position || 0)} / ${mmss(M().duration || 0)}</span>${ctrls()}</div></div>` : '<p class="dim">Play something in any app that shows media controls in Windows.</p>'}
  <h3 class="lbl">Output volume</h3>
  <div class="volrow"><button class="ico" data-act="media" data-arg="mute">${M().muted ? svg.mute : svg.vol}</button><input type="range" min="0" max="100" value="${Math.round((M().volume || 0) * 100)}" data-vol class="slider" style="--v:${Math.round((M().volume || 0) * 100)}%" aria-label="Volume"><b>${Math.round((M().volume || 0) * 100)}%</b></div>`;
const mediaWidget = (id, name, desc, tile) => def(id, { cat: 'Media & Audio', name, desc, src: ['media'], tile, card: mediaCard,
  onChange(e) { if (e.target.dataset.vol != null) mctl('volume', +e.target.value / 100); },
  onWheel(d) { mctl('volume', clamp((M().volume || 0) + d * 0.05, 0, 1)); } });
mediaWidget('nowplaying', 'Now Playing', 'Cover art, title and full controls for the current track',
  () => M().title ? `${artImg()}<div class="stack np"><b class="plain clip">${esc(M().title)}</b><span class="dim clip">${esc(M().artist)}</span></div>${ctrls()}` : nothing());
mediaWidget('nowcompact', 'Now Playing (compact)', 'Title, artist and play/pause in a smaller card',
  () => M().title ? `<div class="stack np sm"><b class="plain clip">${esc(M().title)}</b><span class="dim clip">${esc(M().artist)}</span></div>${ctrls(false)}` : nothing());
mediaWidget('nowmini', 'Now Playing Mini', 'One round play button with the track\'s progress',
  () => `<button class="ringbtn" data-act="media" data-arg="toggle" title="${esc(M().title || 'Play')}">${ring(prog())}${M().playing ? svg.pause : svg.play}</button>`);
mediaWidget('nowbar', 'Now Playing Bar', 'The track with a progress bar and skip',
  () => M().title ? `<div class="stack np"><b class="plain clip">${esc(M().title)}</b><span class="bar wide"><i style="width:${prog() * 100}%"></i></span></div>${ctrls(false)}` : nothing());
mediaWidget('audio', 'Audio Output', 'Volume for your speakers or headphones; scroll to change',
  () => `<button class="ico" data-act="media" data-arg="mute">${M().muted ? svg.mute : svg.vol}</button><span class="bar wide"><i style="width:${(M().muted ? 0 : M().volume || 0) * 100}%"></i></span><b>${M().muted ? 'Muted' : Math.round((M().volume || 0) * 100) + '%'}</b>`);

/* ---------- apps & files ---------- */
source('files', 20e3, async () => {
  const [downloads, screenshots, recent] = await Promise.all(['downloads', 'screenshots', 'recent'].map((w) => invoke('file_list', { which: w, limit: 12 })));
  D.files = { downloads, screenshots, recent };
});
const fileRow = (f) => `<div class="frow" data-act="open" data-arg="${esc(f.path)}"><img data-thumb="${esc(f.path)}" alt=""><span class="clip">${esc(f.name)}</span><span class="dim">${ago(f.modified)}</span>
  <button class="ico sm" data-act="reveal" data-arg="${esc(f.path)}" title="Show in folder">${svg.search}</button></div>`;
const listCard = (title, list, empty) => `<header><h2>${title}</h2></header>${list?.length ? list.map(fileRow).join('') : `<p class="dim">${empty}</p>`}`;
const thumbTile = (path) => `<img class="tthumb" data-thumb="${esc(path)}" alt="" src="${THUMBS[path] || ''}">`;

def('recent', { cat: 'Apps & Files', name: 'Recently Opened', desc: 'The apps and files you used last', src: ['files'],
  tile() { const f = D.files?.recent?.[0]; return f ? `${thumbTile(f.path)}<div class="stack tight"><span class="lbl">Recent</span><span class="clip" style="max-width:150px">${esc(f.name)}</span></div>` : locked(svg.clock, 'Nothing yet'); },
  card: () => listCard('Recently opened', D.files?.recent, 'Nothing opened recently.') });
def('downloads', { cat: 'Apps & Files', name: 'Downloads', desc: 'The latest file in Downloads, one click to open', src: ['files'],
  tile() { const f = D.files?.downloads?.[0]; return f ? `<button class="tfile" data-act="open" data-arg="${esc(f.path)}">${thumbTile(f.path)}</button><div class="stack tight"><span class="lbl">Downloads</span><span class="clip" style="max-width:150px">${esc(f.name)}</span></div>` : locked(svg.down, 'Empty'); },
  card: () => listCard('Downloads', D.files?.downloads, 'Your Downloads folder is empty.') });
def('screenshots', { cat: 'Apps & Files', name: 'Recent Screenshots', desc: 'Your newest screenshots as thumbnails', src: ['files'],
  tile() { const s = D.files?.screenshots || []; return s.length ? `<div class="shots">${s.slice(0, 3).map((f) => `<button data-act="open" data-arg="${esc(f.path)}" title="${esc(f.name)}">${thumbTile(f.path)}</button>`).join('')}</div>` : locked(svg.image, 'No screenshots'); },
  card: () => `<header><h2>Screenshots</h2><button class="chip" data-act="open" data-arg="ms-screenclip:">New screenshot</button></header>
    <div class="shotgrid">${(D.files?.screenshots || []).map((f) => `<button data-act="open" data-arg="${esc(f.path)}" title="${esc(f.name)}"><img data-thumb="${esc(f.path)}" alt=""><span class="dim">${ago(f.modified)}</span></button>`).join('') || '<p class="dim">Press Win+Shift+S to take one.</p>'}</div>` });
def('capture', { cat: 'Apps & Files', name: 'Screenshot Capture', desc: 'Capture the screen, a window or a region',
  tile: () => `<button class="ico" data-act="open" data-arg="ms-screenclip:" title="Capture">${svg.shot}</button>` });

const ENGINES = { google: 'https://www.google.com/search?q=', bing: 'https://www.bing.com/search?q=', duck: 'https://duckduckgo.com/?q=', brave: 'https://search.brave.com/search?q=' };
def('search', { cat: 'Apps & Files', name: 'Search', desc: 'Search the web, or type a folder path to open it',
  tile: () => `<span class="gl">${svg.search}</span><span class="dim">Search…</span>`,
  card: () => `<header><h2>Search</h2><div class="chips">${Object.keys(ENGINES).map((k) => `<button class="chip sm ${cfg('engine', 'google') === k ? 'on' : ''}" data-act="engine" data-arg="${k}">${nice(k)}</button>`).join('')}</div></header>
    <form data-form="search"><input type="text" name="v" placeholder="Search the web, or C:\\path\\to\\folder" autocomplete="off"></form>
    <p class="note dim">A path like C:\\Users opens in Explorer.</p>` });
ACT.engine = (k) => { store.cfg.engine = k; save(); };
FORMS.search = async (v) => {
  const isPath = /^[a-z]:[\\/]/i.test(v) || v.startsWith('\\\\');
  await invoke('open', { target: isPath ? v : ENGINES[cfg('engine', 'google')] + encodeURIComponent(v) });
  toggle(null);
};

def('commands', { cat: 'Apps & Files', name: 'Commands', desc: 'Type a word to launch an app or a settings page',
  tile: () => `<span class="gl">${svg.cmd}</span><span class="dim">Run…</span>`,
  card: () => `<header><h2>Commands</h2><span class="dim">Enter runs the first match</span></header>
    <form data-form="cmd"><input type="text" name="v" id="cmdq" placeholder="chrome, settings, wifi, bluetooth, display…" autocomplete="off" value="${esc(D.cmdq || '')}"></form>
    <div id="cmdres">${cmdResults()}</div>`,
  async onInput(e) { if (e.target.id !== 'cmdq') return; D.cmdq = e.target.value; D.cmdhits = await invoke('start_search', { query: D.cmdq }); $('#cmdres').innerHTML = cmdResults(); } });
const SETTINGS = { settings: 'ms-settings:', wifi: 'ms-settings:network-wifi', bluetooth: 'ms-settings:bluetooth', display: 'ms-settings:display', sound: 'ms-settings:sound', apps: 'ms-settings:appsfeatures', update: 'ms-settings:windowsupdate', power: 'ms-settings:powersleep', personalize: 'ms-settings:personalization', privacy: 'ms-settings:privacy', notifications: 'ms-settings:notifications', storage: 'ms-settings:storagesense', vpn: 'ms-settings:network-vpn', mouse: 'ms-settings:mousetouchpad' };
function cmdHits() {
  const q = (D.cmdq || '').toLowerCase().trim();
  const s = q ? Object.entries(SETTINGS).filter(([k]) => k.startsWith(q)).map(([k, uri]) => ({ name: nice(k) + ' settings', path: uri })) : [];
  return [...(D.cmdhits || []), ...s];
}
const cmdResults = () => cmdHits().map((h, i) => `<div class="frow ${i ? '' : 'first'}" data-act="open" data-arg="${esc(h.path)}"><span class="gl">${h.path.startsWith('ms-settings') ? svg.cmd : svg.bolt}</span><span>${esc(h.name)}</span><span class="dim">${i ? '' : 'Enter'}</span></div>`).join('');
FORMS.cmd = async () => { const h = cmdHits()[0]; if (h) { await invoke('open', { target: h.path }); D.cmdq = ''; D.cmdhits = []; toggle(null); } };
