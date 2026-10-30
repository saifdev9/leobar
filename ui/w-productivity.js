/* Calendar, day timeline, timers, todos, notes, screen time, currency. */

/* ---------- calendar (iCal links) ---------- */
function icsDate(v) {
  const m = /(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/.exec(v || '');
  if (!m) return null;
  const [, y, mo, d, h = 0, mi = 0, s = 0, z] = m;
  return z ? new Date(Date.UTC(y, mo - 1, d, h, mi, s)) : new Date(y, mo - 1, d, h, mi, s);
}
function parseICS(text) {
  const out = []; let e = null;
  for (const l of text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/)) {
    if (l === 'BEGIN:VEVENT') e = { exdates: [] };
    else if (l === 'END:VEVENT') { if (e?.start && !e.cancelled) out.push(e); e = null; }
    else if (e) {
      const i = l.indexOf(':'); if (i < 0) continue;
      const name = l.slice(0, i).split(';')[0], val = l.slice(i + 1);
      if (name === 'SUMMARY') e.summary = val.replace(/\\n/gi, ' ').replace(/\\(.)/g, '$1');
      else if (name === 'LOCATION') e.location = val.replace(/\\(.)/g, '$1');
      else if (name === 'DTSTART') { e.start = icsDate(val); e.allDay = !val.includes('T'); }
      else if (name === 'DTEND') e.end = icsDate(val);
      else if (name === 'RRULE') e.rrule = Object.fromEntries(val.split(';').map((p) => p.split('=')));
      else if (name === 'EXDATE') val.split(',').forEach((v) => e.exdates.push(+icsDate(v)));
      else if (name === 'STATUS' && val === 'CANCELLED') e.cancelled = true;
    }
  }
  return out;
}
// ponytail: DAILY/WEEKLY(+BYDAY)/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, EXDATE; TZID times are read as local time.
function expand(evs, from, to) {
  const out = [];
  for (const e of evs) {
    const len = (e.end ?? e.start) - e.start;
    const add = (s) => { if (s < to && +s + len > from && !e.exdates.includes(+s)) out.push({ ...e, start: s, end: new Date(+s + len) }); };
    const r = e.rrule;
    if (!r) { add(e.start); continue; }
    const until = r.UNTIL ? icsDate(r.UNTIL) : null, every = +(r.INTERVAL || 1), max = r.COUNT ? +r.COUNT : Infinity;
    let n = 0;
    if (r.FREQ === 'DAILY' || r.FREQ === 'WEEKLY') {
      const days = r.BYDAY ? r.BYDAY.split(',').map((d) => ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'].indexOf(d.slice(-2))) : [e.start.getDay()];
      const shift = (e.start.getDay() + 6) % 7;
      for (const d = new Date(e.start); d < to; d.setDate(d.getDate() + 1)) {
        if (until && d > until) break;
        const i = Math.round((sod(d) - sod(e.start)) / DAY);
        if (r.FREQ === 'DAILY' ? i % every : Math.floor((i + shift) / 7) % every || !days.includes(d.getDay())) continue;
        if (++n > max) break;
        add(new Date(d));
      }
    } else if (r.FREQ === 'MONTHLY' || r.FREQ === 'YEARLY') {
      for (let k = 0; ; k += every) {
        const d = new Date(e.start); d.setMonth(d.getMonth() + k * (r.FREQ === 'YEARLY' ? 12 : 1));
        if (d >= to || (until && d > until) || ++n > max) break;
        add(d);
      }
    } else add(e.start);
  }
  return out.sort((a, b) => a.start - b.start);
}
source('calendar', 15 * 60e3, async () => {
  const all = []; let err = null;
  for (const url of store.icals) {
    try { all.push(...parseICS(await invoke('fetch_ical', { url }))); } catch (e) { err = String(e); }
  }
  const now = new Date();
  D.events = expand(all, new Date(+sod(now) - DAY), new Date(+sod(now) + 42 * DAY));
  if (err) throw new Error(err);
});
const events = () => D.events || [];
const nextEvent = () => events().find((e) => !e.allDay && e.end > Date.now());

def('calendar', { cat: 'Productivity', name: 'Calendar', desc: 'Your next event and how soon it starts', src: ['calendar'],
  tile() {
    const n = new Date(), e = nextEvent();
    const page = `<div class="page"><span>${n.toLocaleDateString([], { weekday: 'short' })}</span><b>${n.getDate()}</b></div>`;
    if (!store.icals.length) return page + '<div class="stack"><b class="ev">Add a calendar</b><span class="dim">Paste an iCal link</span></div>';
    if (!e) return page + '<div class="stack"><b class="ev">Nothing scheduled</b><span class="dim">Next 6 weeks are free</span></div>';
    const now = e.start <= Date.now();
    return `${page}<div class="stack evline"><b class="ev">${esc(e.summary || 'Busy')}</b><span class="dim">${now ? 'Now · ends in ' + left(+e.end) : time(e.start) + ' · in ' + left(+e.start)}</span></div>`;
  },
  card() {
    const n = new Date(), first = new Date(n.getFullYear(), n.getMonth(), 1);
    const days = new Date(n.getFullYear(), n.getMonth() + 1, 0).getDate();
    const busy = new Set(events().map((e) => e.start.toDateString()));
    const cells = [...'MTWTFSS'].map((d) => `<span class="lbl">${d}</span>`)
      .concat(Array((first.getDay() + 6) % 7).fill('<span></span>'))
      .concat([...Array(days)].map((_, i) => { const d = new Date(n.getFullYear(), n.getMonth(), i + 1); return `<span class="${i + 1 === n.getDate() ? 'today' : ''} ${busy.has(d.toDateString()) ? 'busy' : ''}">${i + 1}</span>`; }));
    let lastDay = '';
    const agenda = events().filter((e) => e.end > Date.now() && e.start < Date.now() + 7 * DAY).map((e) => {
      const d = e.start.toDateString(), head = d !== lastDay ? `<h4 class="lbl">${+sod(e.start) === +sod(n) ? 'Today' : e.start.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}</h4>` : '';
      lastDay = d;
      return `${head}<div class="event"><i></i><span class="mono dim">${e.allDay ? 'all day' : time(e.start)}</span><span>${esc(e.summary || 'Busy')}${e.location ? ` <span class="dim">· ${esc(e.location)}</span>` : ''}</span></div>`;
    }).join('');
    return `<header><h2>${n.toLocaleDateString([], { month: 'long', year: 'numeric' })}</h2><span class="dim">${n.toLocaleDateString([], { weekday: 'long', day: 'numeric' })}</span></header>
      <div class="two"><div class="month">${cells.join('')}</div><div class="agenda">${agenda || '<p class="dim">No events in the next 7 days.</p>'}</div></div>
      <h3 class="lbl">Calendars</h3>
      ${store.icals.map((u, i) => `<div class="todo"><span class="check on"></span><span class="mono dim clip">${esc(u.replace(/^(https?|webcal):\/\//, '').slice(0, 60))}…</span><button class="ico sm" data-act="ical-del" data-arg="${i}" aria-label="Remove">${svg.x}</button></div>`).join('')}
      <form data-form="ical"><input type="text" name="v" placeholder="Paste a secret iCal link (Google, Outlook, iCloud) and press Enter" autocomplete="off"></form>
      <p class="note dim">Read-only, refreshed every 15 minutes. Links stay on this PC.</p>${errText('calendar')}`;
  } });
ACT['ical-del'] = (i) => { store.icals.splice(+i, 1); save(); SRC.calendar.at = 0; return pump(true); };
FORMS.ical = (v) => { store.icals.push(v); save(); SRC.calendar.at = 0; return pump(true); };
ALERTS.push(() => {
  const e = nextEvent();
  if (!e || !store.remind || e.start <= Date.now() || e.start - Date.now() > store.remind * 60e3) return null;
  return { key: `ev:${+e.start}:${e.summary}`, text: `${e.summary || 'Event'} in ${left(+e.start)}` };
});

/* ---------- screen time & day timeline ---------- */
source('screen', 30e3, async () => { D.screen = await invoke('screen_time'); });
const dayApps = (date = today()) => Object.entries(D.screen?.[date] || {}).filter(([k]) => !k.startsWith('@'));
const dayTotal = (date) => dayApps(date).reduce((a, x) => a + x[1], 0);

def('screen', { cat: 'Productivity', name: 'Screen Time', desc: 'Today\'s time in front of the PC, and every app\'s', src: ['screen'],
  tile() {
    const top = dayApps().sort((a, b) => b[1] - a[1])[0];
    return `<div class="stack"><span class="lbl">Screen</span><b>${dur(dayTotal(today()))}</b></div>${top ? `<span class="dim">${esc(nice(top[0]))}</span>` : ''}`;
  },
  card() {
    const d = dayApps().sort((a, b) => b[1] - a[1]), max = Math.max(1, ...d.map((x) => x[1]));
    const days = [...Array(7)].map((_, i) => { const t = new Date(Date.now() - (6 - i) * DAY); return [t, dayTotal(t.toLocaleDateString('sv'))]; });
    const dmax = Math.max(1, ...days.map((x) => x[1]));
    const hours = [...Array(24)].map((_, h) => D.screen?.[today()]?.['@' + String(h).padStart(2, '0')] || 0);
    return `<header><h2>Screen time</h2><span class="dim">${dur(dayTotal(today()))} today</span></header>
      <div class="cols hours24">${hours.map((s, h) => `<div title="${h}:00 · ${dur(s)}"><i style="height:${s / 3600 * 100}%"></i>${h % 6 ? '' : `<span class="lbl">${h}</span>`}</div>`).join('')}</div>
      ${d.slice(0, 7).map(([exe, s]) => `<div class="hbar"><span>${esc(nice(exe))}</span><span class="bar"><i style="width:${s / max * 100}%"></i></span><b>${dur(s)}</b></div>`).join('') || '<p class="dim">Tracking started. Time counts while you are active.</p>'}
      <h3 class="lbl">Last 7 days</h3>
      <div class="cols">${days.map(([t, s]) => `<div title="${dur(s)}"><i style="height:${s / dmax * 100}%"></i><span class="lbl">${t.toLocaleDateString([], { weekday: 'narrow' })}</span></div>`).join('')}</div>`;
  } });

def('daytimeline', { cat: 'Productivity', name: 'Day Timeline', desc: 'Active hours, focus rounds, meetings, sunrise and sunset on one line', src: ['screen', 'calendar', 'weather'],
  tile() {
    const n = new Date(), t0 = +sod(n), pos = (ms) => clamp((ms - t0) / DAY * 100, 0, 100);
    const hours = [...Array(24)].map((_, h) => D.screen?.[today()]?.['@' + String(h).padStart(2, '0')] || 0);
    const evs = events().filter((e) => !e.allDay && +sod(e.start) === t0);
    const focus = (store.focusLog || []).filter((t) => t > t0);
    const dl = D.weather?.daily;
    return `<div class="timeline">
      ${hours.map((s, h) => `<i class="hr" style="left:${h / 24 * 100}%;opacity:${0.12 + Math.min(1, s / 3600) * 0.88}"></i>`).join('')}
      ${dl ? `<i class="night" style="width:${pos(+new Date(dl.sunrise[0]))}%"></i><i class="night" style="left:${pos(+new Date(dl.sunset[0]))}%;right:0"></i>` : ''}
      ${evs.map((e) => `<i class="meet" style="left:${pos(+e.start)}%;width:${Math.max(.8, pos(+e.end) - pos(+e.start))}%" title="${esc(e.summary)}"></i>`).join('')}
      ${focus.map((t) => `<i class="fdot" style="left:${pos(t)}%"></i>`).join('')}
      <i class="now" style="left:${pos(+n)}%"></i></div>
      <div class="stack tight"><b>${dur(dayTotal(today()))}</b><span class="dim">${focus.length} focus</span></div>`;
  },
  card: () => W.screen.card() });

/* ---------- focus, timer, stopwatch ---------- */
const F = { mode: 'focus', running: false, end: 0, rest: store.focus[0] * 60 };
const fRemaining = () => F.running ? Math.max(0, (F.end - Date.now()) / 1000) : F.rest;
def('focus', { cat: 'Productivity', name: 'Pomodoro', desc: 'Focus rounds and breaks you start from the bar',
  tile() {
    const total = (F.mode === 'focus' ? store.focus[0] : store.focus[1]) * 60;
    return `<button class="ringbtn ${F.mode}" data-act="focus-toggle" title="${F.running ? 'Pause' : 'Start'}">${ring(1 - fRemaining() / total)}${F.running ? svg.pause : svg.play}</button>
      <div class="stack"><span class="lbl">${F.mode}</span><b class="big">${mmss(Math.ceil(fRemaining()))}</b></div>`;
  },
  card: () => `<header><h2>Focus</h2><span class="dim">${store.focusDone[today()] || 0} rounds today</span></header>
    <div class="chips">${[[25, 5], [50, 10], [90, 15]].map((p) => `<button class="chip ${store.focus.join() === p.join() ? 'on' : ''}" data-act="focus-preset" data-arg="${p}">${p[0]} / ${p[1]}</button>`).join('')}
    <button class="chip" data-act="focus-reset">Reset</button></div>
    <p class="note dim">A chime plays when a round ends (not during quiet hours), and the break starts on its own.</p>`,
  tick() {
    if (!F.running || fRemaining() > 0) return;
    chime();
    if (F.mode === 'focus') {
      store.focusDone[today()] = (store.focusDone[today()] || 0) + 1;
      store.focusLog = [...(store.focusLog || []).filter((t) => t > Date.now() - 2 * DAY), Date.now()]; save();
      F.mode = 'break'; F.end = Date.now() + store.focus[1] * 60e3;
    } else { F.mode = 'focus'; F.running = false; F.rest = store.focus[0] * 60; }
  } });
ACT['focus-toggle'] = () => { if (F.running) { F.rest = fRemaining(); F.running = false; } else { F.end = Date.now() + fRemaining() * 1000; F.running = true; } };
ACT['focus-preset'] = (v) => { store.focus = v.split(',').map(Number); save(); ACT['focus-reset'](); };
ACT['focus-reset'] = () => { F.mode = 'focus'; F.running = false; F.rest = store.focus[0] * 60; };

const T = { end: 0, rest: cfg('timer', 300), running: false, total: cfg('timer', 300) };
const tRemaining = () => T.running ? Math.max(0, (T.end - Date.now()) / 1000) : T.rest;
def('timer', { cat: 'Productivity', name: 'Timer', desc: 'A countdown that starts in one click', live: true,
  tile: () => `<button class="ringbtn" data-act="timer-toggle" title="${T.running ? 'Pause' : 'Start'}">${ring(1 - tRemaining() / T.total)}${T.running ? svg.pause : svg.play}</button><b class="big">${mmss(Math.ceil(tRemaining()))}</b>`,
  card: () => `<header><h2>Timer</h2><b class="big">${mmss(Math.ceil(tRemaining()))}</b></header>
    <div class="chips">${[1, 3, 5, 10, 15, 30, 60].map((m) => `<button class="chip ${T.total === m * 60 ? 'on' : ''}" data-act="timer-set" data-arg="${m}">${m} min</button>`).join('')}</div>
    <div class="chips" style="margin-top:10px"><button class="chip" data-act="timer-toggle">${T.running ? 'Pause' : 'Start'}</button><button class="chip" data-act="timer-set" data-arg="${T.total / 60}">Reset</button></div>`,
  tick() { if (T.running && tRemaining() <= 0) { T.running = false; T.rest = T.total; chime(); } } });
ACT['timer-toggle'] = () => { if (T.running) { T.rest = tRemaining(); T.running = false; } else { T.end = Date.now() + tRemaining() * 1000; T.running = true; } };
ACT['timer-set'] = (m) => { T.total = T.rest = +m * 60; T.running = false; store.cfg.timer = T.total; save(); };

const SW = { start: 0, acc: 0, running: false, laps: [] };
const swNow = () => SW.acc + (SW.running ? Date.now() - SW.start : 0);
const swFmt = (ms) => { const s = ms / 1000; return s >= 3600 ? `${Math.floor(s / 3600)}:${mmss(s % 3600)}` : `${mmss(s)}.${Math.floor(ms % 1000 / 100)}`; };
def('stopwatch', { cat: 'Productivity', name: 'Stopwatch', desc: 'Start, pause and lap from the bar', live: true,
  tile: () => `<button class="ico" data-act="sw-toggle" title="${SW.running ? 'Pause' : 'Start'}">${SW.running ? svg.pause : svg.play}</button><b class="big">${swFmt(swNow())}</b>${SW.running ? `<button class="chip sm" data-act="sw-lap">Lap</button>` : ''}`,
  card: () => `<header><h2>Stopwatch</h2><b class="big">${swFmt(swNow())}</b></header>
    <div class="chips"><button class="chip" data-act="sw-toggle">${SW.running ? 'Pause' : 'Start'}</button><button class="chip" data-act="sw-lap">Lap</button><button class="chip" data-act="sw-reset">Reset</button></div>
    <div class="rows" style="margin-top:12px">${SW.laps.map((l, i) => `<div class="row"><span class="dim">${i + 1}</span><span></span><b>${swFmt(l)}</b><span class="dim">+${swFmt(l - (SW.laps[i - 1] || 0))}</span></div>`).reverse().join('')}</div>` });
ACT['sw-toggle'] = () => { if (SW.running) { SW.acc = swNow(); SW.running = false; } else { SW.start = Date.now(); SW.running = true; } };
ACT['sw-lap'] = () => { if (swNow()) SW.laps.push(swNow()); };
ACT['sw-reset'] = () => Object.assign(SW, { start: 0, acc: 0, running: false, laps: [] });
setInterval(() => { if (SW.running && store.order.includes('stopwatch')) renderDock(); }, 100);

/* ---------- todos & notes ---------- */
def('todos', { cat: 'Productivity', name: 'Todos', desc: 'Your next open task; tick it off from the dock',
  tile() {
    const openT = store.todos.filter((t) => !t.done), next = openT[0], n = store.todos.length;
    return `${ring(n ? (n - openT.length) / n : 0, 13)}<span class="clip" style="max-width:170px">${next ? esc(next.text) : '<span class="dim">All clear</span>'}</span>
      ${next ? `<button class="ico sm" data-act="todo-tick" data-arg="${store.todos.indexOf(next)}" title="Done">${svg.tick}</button>` : ''}`;
  },
  card: () => `<header><h2>Todos</h2><span class="dim">${store.todos.filter((t) => t.done).length}/${store.todos.length} done</span></header>
    <form data-form="todo"><input type="text" name="v" placeholder="Add a task and press Enter" autocomplete="off" maxlength="200"></form>
    <div style="margin-top:8px">${store.todos.map((t, i) => `<div class="todo ${t.done ? 'done' : ''}">
      <button class="check" data-act="todo-tick" data-arg="${i}" aria-label="Toggle">${t.done ? svg.tick : ''}</button>
      <span>${esc(t.text)}</span><button class="ico sm" data-act="todo-del" data-arg="${i}" aria-label="Delete">${svg.x}</button></div>`).join('')}</div>
    ${store.todos.some((t) => t.done) ? '<button class="chip" style="margin-top:10px" data-act="todo-clear">Clear done</button>' : ''}` });
ACT['todo-tick'] = (i) => { const t = store.todos[+i]; if (t) { t.done = !t.done; save(); } };
ACT['todo-del'] = (i) => { store.todos.splice(+i, 1); save(); };
ACT['todo-clear'] = () => { store.todos = store.todos.filter((t) => !t.done); save(); };
FORMS.todo = (v) => { store.todos.push({ text: v, done: false }); };

def('notes', { cat: 'Productivity', name: 'Notes', desc: 'Your latest note, one click from editing',
  tile: () => `<span class="gl">${svg.file}</span><span class="clip" style="max-width:160px">${esc(store.notes.split('\n').find((l) => l.trim()) || '') || '<span class="dim">Empty note</span>'}</span>`,
  card: () => `<header><h2>Notes</h2><span class="dim">Saved as you type</span></header><textarea id="notes" spellcheck="true" placeholder="Write anything…">${esc(store.notes)}</textarea>`,
  onInput(e) { if (e.target.id === 'notes') { store.notes = e.target.value; save(); renderDock(); } } });

/* ---------- currency ---------- */
source('fx', 60 * 60e3, async () => {
  const from = cfg('fxFrom', 'USD'), to = cfg('fxTo', 'EUR');
  const r = await api(`https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`);
  D.fx = { from, to, rate: r.rates?.[to], date: r.date };
});
const CUR = ['USD', 'EUR', 'GBP', 'INR', 'JPY', 'CNY', 'AUD', 'CAD', 'CHF', 'SGD', 'AED', 'BRL', 'MXN', 'KRW', 'TRY', 'SEK', 'NOK', 'PLN', 'ZAR', 'HKD'];
def('currency', { cat: 'Productivity', name: 'Currency', desc: 'Convert between currencies at current rates', src: ['fx'],
  tile: () => D.fx?.rate ? `<span class="gl">${svg.coin}</span><div class="stack"><span class="lbl">1 ${D.fx.from}</span><b>${D.fx.rate.toFixed(D.fx.rate < 10 ? 4 : 2)} ${D.fx.to}</b></div>` : locked(svg.coin, '…'),
  card() {
    const sel = (k, d) => `<select data-fx="${k}">${CUR.map((c) => `<option ${cfg(k, d) === c ? 'selected' : ''}>${c}</option>`).join('')}</select>`;
    const amt = cfg('fxAmt', 100);
    return `<header><h2>Currency</h2><span class="dim">${D.fx?.date ? 'Rates of ' + D.fx.date : ''}</span></header>
      <div class="fxrow"><input type="number" data-fx="fxAmt" value="${amt}" min="0">${sel('fxFrom', 'USD')}<span>→</span>${sel('fxTo', 'EUR')}</div>
      <p class="fxout">${D.fx?.rate ? `<b>${(amt * D.fx.rate).toLocaleString([], { maximumFractionDigits: 2 })} ${D.fx.to}</b>` : '…'}</p>
      <p class="note dim">Reference rates from the European Central Bank via Frankfurter, updated on working days.</p>${errText('fx')}`;
  },
  onChange(e) { const k = e.target.dataset.fx; if (!k) return; store.cfg[k] = k === 'fxAmt' ? +e.target.value : e.target.value; save(); if (k !== 'fxAmt') { SRC.fx.at = 0; pump(true); } else renderCard(); } });
