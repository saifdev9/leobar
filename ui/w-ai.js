/* AI plan usage: Claude Code (logs + sign-in), ChatGPT/Codex (local logs), DeepSeek (your key). */
const shortModel = (m) => (m || '').replace(/^claude-/, '');

source('claude', 15e3, async () => { D.claude = await invoke('claude_snapshot'); });
/* The real app icons, taken from the Claude / ChatGPT apps installed on this PC. */
D.brand = {};
source('brands', 6 * 3600e3, async () => {
  for (const name of ['Claude', 'ChatGPT']) {
    const running = (D.apps || []).find((a) => a.icon && a.name.toLowerCase() === name.toLowerCase());
    D.brand[name] = (await invoke('brand_icon', { name }).catch(() => null)) || running?.icon || null;
  }
});
const C = () => D.claude;
const live = () => C()?.sessions.some((s) => Date.now() / 1000 - s.last < 120);
const mark = (glyph = svg.term, cls = 'claude') => {
  const brand = D.brand[cls === 'claude' ? 'Claude' : 'ChatGPT'];
  const dot = live() && cls === 'claude' ? '<i class="live"></i>' : '';
  return brand ? `<span class="mark logo"><img src="${brand}" alt="">${dot}</span>` : `<span class="mark ${cls}">${glyph}${dot}</span>`;
};
const usageRow = (k, w) => {
  const p = Math.round(w?.utilization ?? w?.used_percent ?? 0);
  const reset = w?.resets_at ? (typeof w.resets_at === 'number' ? w.resets_at * 1000 : Date.parse(w.resets_at)) : null;
  return `<div class="kv ${pctClass(p)}"><span class="k">${k}</span><span class="bar"><i style="width:${p}%"></i></span><span class="dim mono r">${reset ? left(reset) : '—'}</span><b>${p}%</b></div>`;
};

function claudeCard() {
  const c = C();
  if (!c) return '<p class="dim">Reading Claude Code logs…</p>';
  const L = c.limits;
  const stat = (label, val, sub, p) => `<div class="stat ${p != null ? pctClass(p) : ''}"><span class="lbl">${label}</span><b>${val}</b>${p != null ? `<span class="bar"><i style="width:${p}%"></i></span>` : ''}<span class="dim">${sub}</span></div>`;
  const pw = (w) => w?.utilization != null ? Math.round(w.utilization) : null;
  const status = !c.signed_in ? 'Not signed in · run <span class="mono">claude</span>' : L ? 'Plan limits · live' : 'Local logs only';
  const maxModel = Math.max(1, ...c.models.map((m) => m[1]));
  return `<header><h2>Claude Code</h2><span class="dim">${status}</span></header>
    <div class="stats">
      ${stat('Session · 5h', L ? (pw(L.five_hour) ?? '—') + '%' : tok(c.block_tokens), L?.five_hour?.resets_at ? 'resets in ' + left(Date.parse(L.five_hour.resets_at)) : c.block_reset ? 'resets in ' + left(c.block_reset * 1000) : 'no active window', L ? pw(L.five_hour) : null)}
      ${stat('Week', L ? (pw(L.seven_day) ?? '—') + '%' : tok(c.week_tokens), L?.seven_day?.resets_at ? 'resets ' + new Date(L.seven_day.resets_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: !store.clock24 }) : 'tokens, 7 days', L ? pw(L.seven_day) : null)}
      ${stat('Last 24h', tok(c.day_tokens), 'tokens')}
    </div>
    <h3 class="lbl">Sessions · last 24h</h3>
    <div class="rows">${c.sessions.length ? c.sessions.map((s) => `
      <div class="row"><span>${Date.now() / 1000 - s.last < 120 ? '<i class="live"></i>' : ''}</span>
        <span><b>${esc(s.project)}</b> <span class="dim">${esc(shortModel(s.model))} · ${s.messages} replies</span></span>
        <b>${tok(s.tokens)}</b><span class="dim">${ago(s.last)}</span></div>`).join('') : '<p class="dim">No Claude Code activity in the last day.</p>'}
    </div>
    <h3 class="lbl">Models · 7 days</h3>
    ${c.models.slice(0, 5).map(([m, t]) => `<div class="hbar"><span>${esc(shortModel(m))}</span><span class="bar"><i style="width:${t / maxModel * 100}%"></i></span><b>${tok(t)}</b></div>`).join('')}
    <p class="note dim">Tokens = input + output + cache writes, from Claude Code's logs on this PC.${c.limits_error && c.signed_in ? ' Plan limits unavailable: ' + esc(c.limits_error) + '.' : ''}</p>`;
}

def('claude', { cat: 'AI', name: 'Claude Usage', desc: 'Your Claude session limit and when it resets', src: ['claude', 'brands'],
  tile() {
    const c = C(); if (!c) return mark() + '<span class="dim">…</span>';
    const w = c.limits?.five_hour;
    if (w) { const p = Math.round(w.utilization ?? 0); return `${mark()}<div class="stack ${pctClass(p)}"><span><span class="k">Session</span> <b>${p}%</b></span><span class="bar wide"><i style="width:${p}%"></i></span><span class="dim mono tiny">resets in ${left(Date.parse(w.resets_at))}</span></div>`; }
    return `${mark()}<div class="stack"><span><span class="k">Session</span> <b>${tok(c.block_tokens)}</b></span><span class="dim mono tiny">${c.block_reset ? left(c.block_reset * 1000) + ' left' : 'idle'}</span></div>`;
  },
  card: claudeCard });

def('claudeplan', { cat: 'AI', name: 'Claude Plan Usage', desc: 'Session and weekly Claude limits, plus your most-used model', src: ['claude', 'brands'],
  tile() {
    const c = C(); if (!c) return mark() + '<span class="dim">…</span>';
    const L = c.limits;
    const body = L && (L.five_hour || L.seven_day)
      ? usageRow('Session', L.five_hour) + usageRow('Week', L.seven_day)
      : `<div class="kv"><span class="k">Session</span><b>${tok(c.block_tokens)}</b><span class="dim mono r">${c.block_reset ? left(c.block_reset * 1000) : 'idle'}</span></div>
         <div class="kv"><span class="k">Week</span><b>${tok(c.week_tokens)}</b><span class="dim r">${esc(shortModel(c.models[0]?.[0] || ''))}</span></div>`;
    return `${mark()}<div class="stack">${body}</div>`;
  },
  card: claudeCard });
ALERTS.push(() => {
  const L = C()?.limits;
  for (const [k, w, label] of [['5h', L?.five_hour, 'session'], ['7d', L?.seven_day, 'weekly limit']]) {
    if (w?.utilization >= store.claudeWarn) return { key: `claude${k}:${w.resets_at}`, text: `Claude ${label} at ${Math.round(w.utilization)}% · resets in ${left(Date.parse(w.resets_at))}` };
  }
  return null;
});

/* ChatGPT plan limits as Codex records them */
source('codex', 30e3, async () => { D.codex = await invoke('codex_usage'); });
const winLabel = (m) => !m ? 'Limit' : m <= 300 ? `${m / 60}h` : m <= 10080 ? 'Week' : `${Math.round(m / 1440)}d`;
const live_ = (l) => l && (!l.resets_at || l.resets_at * 1000 > Date.now()) ? l : l && { ...l, used_percent: 0 }; // a window that already reset is back to 0
def('codex', { cat: 'AI', name: 'ChatGPT Usage', desc: 'Your ChatGPT plan\'s Codex limits, read from Codex on this PC', src: ['codex', 'brands'],
  tile() {
    const c = D.codex;
    if (!c) return mark(svg.code, 'alt') + '<span class="dim">…</span>';
    if (!c.primary) return mark(svg.code, 'alt') + `<span class="dim">${c.found ? 'No limits yet' : 'Codex not used here'}</span>`;
    return `${mark(svg.code, 'alt')}<div class="stack">${usageRow(winLabel(c.primary.window_minutes), live_(c.primary))}${c.secondary ? usageRow(winLabel(c.secondary.window_minutes), live_(c.secondary)) : ''}</div>`;
  },
  card() {
    const c = D.codex;
    const row = (l) => l ? `<div class="stat ${pctClass(live_(l).used_percent)}"><span class="lbl">${winLabel(l.window_minutes)} window</span><b>${Math.round(live_(l).used_percent)}%</b><span class="bar"><i style="width:${live_(l).used_percent}%"></i></span><span class="dim">${l.resets_at ? 'resets in ' + left(l.resets_at * 1000) : ''}</span></div>` : '';
    return `<header><h2>ChatGPT · Codex</h2><span class="dim">${c?.plan ? nice(c.plan) + ' plan' : ''}</span></header>
      ${c?.primary ? `<div class="stats">${row(c.primary)}${row(c.secondary)}</div><p class="note dim">Last reported ${c.seen_at ? ago(c.seen_at) : ''} by Codex CLI. Run Codex to refresh it.</p>`
        : '<p class="dim">Install the Codex CLI and sign in with your ChatGPT account. leobar reads the limits Codex records in ~/.codex/sessions; nothing is sent anywhere.</p>'}`;
  } });
ALERTS.push(() => {
  const l = live_(D.codex?.primary);
  return l?.used_percent >= store.claudeWarn ? { key: `codex:${l.resets_at}`, text: `ChatGPT ${winLabel(l.window_minutes)} limit at ${Math.round(l.used_percent)}% · resets in ${left(l.resets_at * 1000)}` } : null;
});

/* DeepSeek balance; spend is worked out from the balance seen earlier today and this week */
source('deepseek', 10 * 60e3, async () => {
  if (!has('deepseek')) return;
  const r = await api('https://api.deepseek.com/user/balance', { headers: { Authorization: 'Bearer {{deepseek}}', Accept: 'application/json' } });
  const b = r.balance_infos?.[0];
  D.deepseek = { balance: +b.total_balance, currency: b.currency };
  const hist = store.cfg.dsHist || {};
  hist[today()] ??= D.deepseek.balance;
  for (const k of Object.keys(hist)) if (Date.parse(k) < Date.now() - 8 * DAY) delete hist[k];
  store.cfg.dsHist = hist; save();
});
def('deepseek', { cat: 'AI', name: 'DeepSeek Balance', desc: 'Your DeepSeek balance, with today\'s and this week\'s spend', src: ['deepseek'],
  connect: { host: 'api.deepseek.com', help: 'Create an API key at platform.deepseek.com → API keys, then paste it here.', fields: [{ key: 'deepseek', label: 'API key', placeholder: 'sk-…', secret: true }] },
  tile() {
    if (!has('deepseek')) return locked(svg.spark);
    const d = D.deepseek; if (!d) return locked(svg.spark, '…');
    const h = store.cfg.dsHist || {}, spentToday = (h[today()] ?? d.balance) - d.balance;
    return `<span class="gl">${svg.spark}</span><div class="stack tight"><b>${money(d.balance, d.currency)}</b><span class="dim">−${money(Math.max(0, spentToday), d.currency)} today</span></div>`;
  },
  card() {
    const d = D.deepseek, h = store.cfg.dsHist || {};
    const weekStart = Object.keys(h).sort()[0];
    return `<header><h2>DeepSeek</h2><span class="dim">${d ? money(d.balance, d.currency) + ' left' : ''}</span></header>
      ${d ? `<div class="stats"><div class="stat"><span class="lbl">Today</span><b>${money(Math.max(0, (h[today()] ?? d.balance) - d.balance), d.currency)}</b></div>
      <div class="stat"><span class="lbl">This week</span><b>${money(Math.max(0, (h[weekStart] ?? d.balance) - d.balance), d.currency)}</b></div></div>
      <p class="note dim">Spend is the drop in balance since leobar first saw it that day; top-ups make it read low.</p>` : ''}${errText('deepseek')}`;
  } });
