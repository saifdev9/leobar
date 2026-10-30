/* Widgets that read an online account with your own key, plus keyless online data. */
const iso = (ms) => new Date(ms).toISOString();
const since30 = () => Date.now() - 30 * DAY;
const enc = encodeURIComponent;

/* ---------- revenue: each provider returns [{t: ms, amount: major units, cur}] for the last 30 days ---------- */
// ponytail: amounts in minor units are divided by 100, so zero-decimal currencies (JPY, KRW) read 100x low.
const PROVIDERS = {
  stripe: { name: 'Stripe', host: 'api.stripe.com', help: 'Stripe Dashboard → Developers → API keys → Create restricted key with read access to Balance.',
    fields: [{ key: 'stripe', label: 'Restricted key', placeholder: 'rk_live_…', secret: true }],
    async fetch() {
      const out = []; let after = '';
      for (let i = 0; i < 10; i++) {
        const r = await api(`https://api.stripe.com/v1/balance_transactions?limit=100&${enc('created[gte]')}=${Math.floor(since30() / 1000)}${after}`, { headers: { Authorization: 'Bearer {{stripe}}' } });
        for (const t of r.data) if (!['payout', 'transfer', 'stripe_fee'].includes(t.type)) out.push({ t: t.created * 1000, amount: t.net / 100, cur: t.currency });
        if (!r.has_more) break;
        after = '&starting_after=' + r.data[r.data.length - 1].id;
      }
      return out;
    } },
  polar: { name: 'Polar', host: 'api.polar.sh', help: 'Polar → Settings → Developers → New token with orders:read.',
    fields: [{ key: 'polar', label: 'Organization access token', placeholder: 'polar_oat_…', secret: true }],
    async fetch() {
      const out = [];
      for (let p = 1; p <= 10; p++) {
        const r = await api(`https://api.polar.sh/v1/orders/?limit=100&page=${p}&sorting=-created_at`, { headers: { Authorization: 'Bearer {{polar}}' } });
        let old = false;
        for (const o of r.items || []) {
          const t = Date.parse(o.created_at); if (t < since30()) { old = true; break; }
          out.push({ t, amount: (o.net_amount ?? (o.amount - (o.tax_amount || 0))) / 100, cur: o.currency });
        }
        if (old || p >= (r.pagination?.max_page || 1)) break;
      }
      return out;
    } },
  dodo: { name: 'Dodo Payments', host: 'live.dodopayments.com', help: 'Dodo Payments dashboard → Developer → API keys → create a key.',
    fields: [{ key: 'dodo', label: 'API key', placeholder: 'Your live API key', secret: true }],
    async fetch() {
      const r = await api(`https://live.dodopayments.com/payments?page_size=100&created_at_gte=${enc(iso(since30()))}`, { headers: { Authorization: 'Bearer {{dodo}}' } });
      return (r.items || []).filter((p) => p.status === 'succeeded').map((p) => ({ t: Date.parse(p.created_at), amount: p.total_amount / 100, cur: p.currency }));
    } },
  shopify: { name: 'Shopify', host: 'your-store.myshopify.com', help: 'Shopify admin → Settings → Apps → Develop apps → create an app with read_orders, install it and copy the Admin API token.',
    fields: [{ key: 'shopifyShop', label: 'Store name (the part before .myshopify.com)', placeholder: 'my-store' }, { key: 'shopify', label: 'Admin API access token', placeholder: 'shpat_…', secret: true }],
    async fetch() {
      const shop = cfg('shopifyShop', '').replace(/\.myshopify\.com.*/, '').replace(/^https?:\/\//, '');
      // ponytail: first 250 orders of the period; Shopify's cursor pagination is in a response header we don't read.
      const r = await api(`https://${shop}.myshopify.com/admin/api/2025-01/orders.json?status=any&limit=250&created_at_min=${enc(iso(since30()))}&fields=created_at,current_total_price,currency,cancelled_at`, { headers: { 'X-Shopify-Access-Token': '{{shopify}}' } });
      return (r.orders || []).filter((o) => !o.cancelled_at).map((o) => ({ t: Date.parse(o.created_at), amount: +o.current_total_price, cur: o.currency }));
    } },
  lemon: { name: 'Lemon Squeezy', host: 'api.lemonsqueezy.com', help: 'Lemon Squeezy → Settings → API → create an API key.',
    fields: [{ key: 'lemon', label: 'API key', placeholder: 'eyJ0…', secret: true }],
    async fetch() {
      const out = [];
      for (let p = 1; p <= 10; p++) {
        const r = await api(`https://api.lemonsqueezy.com/v1/orders?${enc('page[size]')}=100&${enc('page[number]')}=${p}&sort=-created_at`, { headers: { Authorization: 'Bearer {{lemon}}', Accept: 'application/vnd.api+json' } });
        let old = false;
        for (const o of r.data || []) {
          const a = o.attributes, t = Date.parse(a.created_at); if (t < since30()) { old = true; break; }
          out.push({ t, amount: (a.total - (a.tax || 0) - (a.refunded_amount || 0)) / 100, cur: a.currency });
        }
        if (old || !r.links?.next) break;
      }
      return out;
    } },
  paddle: { name: 'Paddle', host: 'api.paddle.com', help: 'Paddle → Developer tools → Authentication → API keys, with transaction read permission.',
    fields: [{ key: 'paddle', label: 'API key', placeholder: 'pdl_live_apikey_…', secret: true }],
    async fetch() {
      const r = await api(`https://api.paddle.com/transactions?status=completed&per_page=200&${enc('created_at[GTE]')}=${enc(iso(since30()))}`, { headers: { Authorization: 'Bearer {{paddle}}' } });
      return (r.data || []).map((t) => ({ t: Date.parse(t.created_at), amount: +(t.details?.totals?.earnings || 0) / 100, cur: t.currency_code }));
    } },
  gumroad: { name: 'Gumroad', host: 'api.gumroad.com', help: 'Gumroad → Settings → Advanced → Applications → create an application and generate an access token.',
    fields: [{ key: 'gumroad', label: 'Access token', placeholder: 'Your access token', secret: true }],
    async fetch() {
      const out = []; let url = `https://api.gumroad.com/v2/sales?access_token={{gumroad}}&after=${new Date(since30()).toISOString().slice(0, 10)}`;
      for (let i = 0; i < 5 && url; i++) {
        const r = await api(url);
        for (const s of r.sales || []) out.push({ t: Date.parse(s.created_at), amount: ((s.price || 0) - (s.gumroad_fee || 0)) / 100, cur: s.currency || 'usd' });
        url = r.next_page_key ? `https://api.gumroad.com/v2/sales?access_token={{gumroad}}&page_key=${enc(r.next_page_key)}` : '';
      }
      return out;
    } },
};
const total = (rows, from = 0, to = Infinity) => rows.filter((x) => x.t >= from && x.t < to).reduce((a, x) => a + x.amount, 0);
const daily = (rows, days = 14) => [...Array(days)].map((_, i) => { const a = +sod(new Date()) - (days - 1 - i) * DAY; return total(rows, a, a + DAY); });
const mainCur = (rows) => rows[0]?.cur || cfg('goalCur', 'usd');

for (const [pid, P] of Object.entries(PROVIDERS)) {
  source(pid, 10 * 60e3, async () => { if (connected(W[pid])) D[pid] = await P.fetch(); });
  const conn = { host: P.host, help: P.help, fields: P.fields };
  const card = () => {
    const rows = D[pid];
    if (!rows) return `<header><h2>${P.name}</h2></header><p class="dim">Loading…</p>${errText(pid)}`;
    const cur = mainCur(rows), wk = total(rows, Date.now() - 7 * DAY), prev = total(rows, Date.now() - 14 * DAY, Date.now() - 7 * DAY);
    return `<header><h2>${P.name}</h2><span class="dim">last 30 days</span></header>
      <div class="stats"><div class="stat"><span class="lbl">30 days</span><b>${money(total(rows), cur)}</b><span class="dim">${rows.length} payments</span></div>
      <div class="stat"><span class="lbl">This week</span><b>${money(wk, cur)}</b>${delta(wk, prev)}</div>
      <div class="stat"><span class="lbl">Today</span><b>${money(total(rows, +sod(new Date())), cur)}</b></div></div>
      <div class="bigspark">${spark(daily(rows, 30), 520, 90)}</div>${errText(pid)}`;
  };
  def(pid, { cat: 'Finance', name: P.name, desc: `Net revenue over the last 30 days from ${P.name}`, src: [pid], connect: conn, card,
    tile: () => !connected(W[pid]) ? locked(svg.coin) : D[pid] ? `<span class="gl">${svg.coin}</span><div class="stack tight"><span class="lbl">${P.name} · 30d</span><b>${money(total(D[pid]), mainCur(D[pid]))}</b></div>` : locked(svg.coin, D.err[pid] ? 'Error' : '…') });
  def(pid + 'chart', { cat: 'Finance', name: P.name + ' Chart', desc: `This week's ${P.name} revenue over a 14-day line`, src: [pid], connect: conn, card,
    tile() {
      if (!connected(W[pid])) return locked(svg.chart);
      const rows = D[pid]; if (!rows) return locked(svg.chart, '…');
      const wk = total(rows, Date.now() - 7 * DAY), prev = total(rows, Date.now() - 14 * DAY, Date.now() - 7 * DAY);
      return `<div class="stack tight"><span class="lbl">${P.name} · 7d</span><b>${money(wk, mainCur(rows))}</b>${delta(wk, prev)}</div>${spark(daily(rows), 70, 28)}`;
    } });
}
def('totalrev', { cat: 'Finance', name: 'Total Revenue', desc: 'Every connected store\'s last 30 days added up, with a monthly goal', src: Object.keys(PROVIDERS),
  tile() {
    const rows = Object.keys(PROVIDERS).flatMap((p) => D[p] || []);
    if (!Object.keys(PROVIDERS).some((p) => connected(W[p]))) return locked(svg.coin, 'Connect a store');
    const goal = +cfg('goal', 0), got = total(rows), cur = mainCur(rows);
    const pace = goal ? got / (goal * (new Date().getDate() / new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate())) : 0;
    return `${goal ? ring(got / goal, 14) : `<span class="gl">${svg.coin}</span>`}<div class="stack tight"><span class="lbl">Revenue · 30d</span><b>${money(got, cur)}</b>${goal ? `<span class="dim tiny">${Math.round(got / goal * 100)}% of ${money(goal, cur)} · ${pace >= 1 ? 'on pace' : 'behind'}</span>` : ''}</div>`;
  },
  card() {
    const per = Object.entries(PROVIDERS).filter(([p]) => D[p]).map(([p, P]) => [P.name, total(D[p]), mainCur(D[p])]);
    return `<header><h2>Total revenue</h2><span class="dim">last 30 days, each store in its own currency</span></header>
      ${per.map(([n, v, c]) => `<div class="hbar"><span>${n}</span><span class="bar"><i style="width:${v / Math.max(1, ...per.map((x) => x[1])) * 100}%"></i></span><b>${money(v, c)}</b></div>`).join('') || '<p class="dim">Connect a store from its own widget first.</p>'}
      <label class="field"><span class="lbl">Monthly goal</span><input type="number" min="0" data-goal value="${cfg('goal', '')}" placeholder="e.g. 3000"></label>`;
  },
  onChange(e) { if (e.target.dataset.goal != null) { store.cfg.goal = +e.target.value; save(); renderDock(); } } });

/* ---------- analytics ---------- */
source('plausible', 10 * 60e3, async () => {
  if (!connected(W.plausible)) return;
  const site = enc(cfg('plausibleSite')), h = { headers: { Authorization: 'Bearer {{plausible}}' } };
  const [agg, ts] = await Promise.all([
    api(`https://plausible.io/api/v1/stats/aggregate?site_id=${site}&period=7d&metrics=visitors,pageviews&compare=previous_period`, h),
    api(`https://plausible.io/api/v1/stats/timeseries?site_id=${site}&period=30d&metrics=visitors`, h)]);
  D.plausible = { visitors: agg.results.visitors.value, change: agg.results.visitors.change, views: agg.results.pageviews.value, series: ts.results.map((x) => x.visitors) };
});
def('plausible', { cat: 'Analytics', name: 'Plausible', desc: 'Visitors this week from Plausible, with the trend', src: ['plausible'],
  connect: { host: 'plausible.io', help: 'Plausible → Account settings → API keys → New API key.', fields: [{ key: 'plausibleSite', label: 'Site domain', placeholder: 'example.com' }, { key: 'plausible', label: 'API key', placeholder: 'Your Stats API key', secret: true }] },
  tile: () => !connected(W.plausible) ? locked(svg.people) : D.plausible ? `<div class="stack tight"><span class="lbl">Visitors · 7d</span><b>${num(D.plausible.visitors)}</b><span class="${D.plausible.change >= 0 ? 'up' : 'down'} tiny">${D.plausible.change >= 0 ? '▲' : '▼'} ${Math.abs(D.plausible.change)}%</span></div>${spark(D.plausible.series.slice(-14), 64, 26)}` : locked(svg.people, '…'),
  card: () => `<header><h2>${esc(cfg('plausibleSite'))}</h2><span class="dim">Plausible · 7 days</span></header>${D.plausible ? `<div class="stats"><div class="stat"><span class="lbl">Visitors</span><b>${num(D.plausible.visitors)}</b></div><div class="stat"><span class="lbl">Pageviews</span><b>${num(D.plausible.views)}</b></div><div class="stat"><span class="lbl">Change</span><b>${D.plausible.change}%</b></div></div><div class="bigspark">${spark(D.plausible.series, 520, 90)}</div>` : ''}${errText('plausible')}` });

source('dub', 10 * 60e3, async () => {
  if (!has('dub')) return;
  const [now, all] = await Promise.all([api('https://api.dub.co/analytics?event=clicks&interval=7d', { headers: { Authorization: 'Bearer {{dub}}' } }),
    api('https://api.dub.co/analytics?event=clicks&interval=30d&groupBy=timeseries', { headers: { Authorization: 'Bearer {{dub}}' } })]);
  D.dub = { clicks: now.clicks ?? now, series: Array.isArray(all) ? all.map((x) => x.clicks) : [] };
});
def('dub', { cat: 'Analytics', name: 'Dub', desc: 'Clicks on your Dub links this week', src: ['dub'],
  connect: { host: 'api.dub.co', help: 'Dub → Settings → API keys → create a key with analytics read access.', fields: [{ key: 'dub', label: 'API key', placeholder: 'dub_…', secret: true }] },
  tile: () => !has('dub') ? locked(svg.link) : D.dub ? `<span class="gl">${svg.link}</span><div class="stack tight"><span class="lbl">Clicks · 7d</span><b>${num(D.dub.clicks)}</b></div>${spark(D.dub.series.slice(-14), 56, 24)}` : locked(svg.link, '…'),
  card: () => `<header><h2>Dub</h2><span class="dim">clicks</span></header>${D.dub ? `<div class="bigspark">${spark(D.dub.series, 520, 90)}</div>` : ''}${errText('dub')}` });

/* ---------- developer ---------- */
source('resend', 10 * 60e3, async () => {
  if (!has('resend')) return;
  const r = await api('https://api.resend.com/emails?limit=100', { headers: { Authorization: 'Bearer {{resend}}' } });
  const wk = (r.data || []).filter((e) => Date.parse(e.created_at) > Date.now() - 7 * DAY);
  D.resend = { sent: wk.length, delivered: wk.filter((e) => e.last_event === 'delivered').length, bounced: wk.filter((e) => e.last_event === 'bounced').length };
});
def('resend', { cat: 'Developer', name: 'Resend', desc: 'Emails sent this week and how many were delivered', src: ['resend'],
  connect: { host: 'api.resend.com', help: 'Resend → API Keys → Create API key (full access is needed to list emails).', fields: [{ key: 'resend', label: 'API key', placeholder: 're_…', secret: true }] },
  tile: () => !has('resend') ? locked(svg.mail) : D.resend ? `<span class="gl">${svg.mail}</span><div class="stack tight"><span><b>${D.resend.sent}</b> <span class="dim">sent</span></span><span class="dim tiny">${D.resend.sent ? Math.round(D.resend.delivered / D.resend.sent * 100) : 0}% delivered</span></div>` : locked(svg.mail, '…'),
  card: () => `<header><h2>Resend</h2><span class="dim">last 7 days (latest 100 emails)</span></header>${D.resend ? `<div class="stats"><div class="stat"><span class="lbl">Sent</span><b>${D.resend.sent}</b></div><div class="stat"><span class="lbl">Delivered</span><b>${D.resend.delivered}</b></div><div class="stat ${D.resend.bounced ? 'warn' : ''}"><span class="lbl">Bounced</span><b>${D.resend.bounced}</b></div></div>` : ''}${errText('resend')}` });

source('linear', 5 * 60e3, async () => {
  if (!has('linear')) return;
  const q = '{ viewer { assignedIssues(first: 50, filter: { state: { type: { nin: ["completed", "canceled"] } } }) { nodes { identifier title url state { name type } } } } }';
  const r = await api('https://api.linear.app/graphql', { method: 'POST', headers: { Authorization: '{{linear}}', 'Content-Type': 'application/json' }, body: { query: q } });
  if (r.errors) throw new Error(r.errors[0].message);
  D.linear = r.data.viewer.assignedIssues.nodes;
});
def('linear', { cat: 'Developer', name: 'Linear', desc: 'Issues assigned to you and what\'s in progress', src: ['linear'],
  connect: { host: 'api.linear.app', help: 'Linear → Settings → Security & access → Personal API keys → New key.', fields: [{ key: 'linear', label: 'Personal API key', placeholder: 'lin_api_…', secret: true }] },
  tile: () => !has('linear') ? locked(svg.tick) : D.linear ? `<span class="gl">${svg.tick}</span><div class="stack tight"><span><b>${D.linear.length}</b> <span class="dim">assigned</span></span><span class="dim tiny">${D.linear.filter((i) => i.state.type === 'started').length} in progress</span></div>` : locked(svg.tick, '…'),
  card: () => `<header><h2>Linear</h2><span class="dim">assigned to you</span></header>${(D.linear || []).map((i) => `<div class="frow" data-act="open" data-arg="${esc(i.url)}"><span class="mono dim">${esc(i.identifier)}</span><span class="clip">${esc(i.title)}</span><span class="dim">${esc(i.state.name)}</span></div>`).join('')}${errText('linear')}` });

source('supabase', 5 * 60e3, async () => {
  if (!connected(W.supabase)) return;
  D.supabase = await api(`https://api.supabase.com/v1/projects/${enc(cfg('supabaseRef'))}/health?services=db&services=auth&services=rest&services=storage&services=realtime`, { headers: { Authorization: 'Bearer {{supabase}}' } });
});
def('supabase', { cat: 'Developer', name: 'Supabase', desc: 'Your project\'s services and their health', src: ['supabase'],
  connect: { host: 'api.supabase.com', help: 'Supabase → Account → Access tokens → Generate new token. The project ref is in Project Settings → General.', fields: [{ key: 'supabaseRef', label: 'Project ref', placeholder: 'abcdefghijklmnop' }, { key: 'supabase', label: 'Access token', placeholder: 'sbp_…', secret: true }] },
  tile() {
    if (!connected(W.supabase)) return locked(svg.db);
    const s = D.supabase; if (!Array.isArray(s)) return locked(svg.db, '…');
    const ok = s.filter((x) => x.healthy).length;
    return `<span class="gl ${ok === s.length ? 'okc' : 'warnc'}">${svg.db}</span><div class="stack tight"><span><b>${ok}/${s.length}</b> <span class="dim">healthy</span></span><span class="dim tiny">${esc(cfg('supabaseRef'))}</span></div>`;
  },
  card: () => `<header><h2>Supabase</h2><span class="dim">${esc(cfg('supabaseRef'))}</span></header>${(Array.isArray(D.supabase) ? D.supabase : []).map((x) => `<div class="todo"><span class="check ${x.healthy ? 'on' : ''}"></span><span>${esc(x.name)}</span><span class="dim">${esc(x.status)}</span></div>`).join('')}${errText('supabase')}` });

/* ---------- GitHub & LeetCode ---------- */
const gh = (path) => api('https://api.github.com' + path, { headers: { Authorization: 'Bearer {{github}}', Accept: 'application/vnd.github+json' } });
source('github', 3 * 60e3, async () => {
  if (!has('github')) return;
  const [notes, prs, repos] = await Promise.all([gh('/notifications?per_page=50'), gh('/search/issues?q=' + enc('is:pr is:open author:@me')), gh('/user/repos?per_page=100&affiliation=owner')]);
  D.github = { notes, prs: prs.total_count, stars: repos.reduce((a, r) => a + r.stargazers_count, 0) };
});
const ghConnect = { host: 'api.github.com', help: 'GitHub → Settings → Developer settings → Fine-grained token (or classic with notifications and repo read).', fields: [{ key: 'github', label: 'Personal access token', placeholder: 'github_pat_…', secret: true }] };
const ghCard = () => `<header><h2>GitHub</h2><span class="dim">${D.github ? `${D.github.prs} open PRs · ${num(D.github.stars)} stars` : ''}</span></header>
  ${(D.github?.notes || []).slice(0, 12).map((n) => `<div class="frow" data-act="open" data-arg="https://github.com/notifications"><span class="mono dim">${esc(n.repository.name)}</span><span class="clip">${esc(n.subject.title)}</span><span class="dim">${esc(n.subject.type)}</span></div>`).join('') || '<p class="dim">No unread notifications.</p>'}${errText('github')}`;
const GH = I('<path d="M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.7-.2.7-.5v-1.7c-2.7.6-3.3-1.2-3.3-1.2-.4-1.1-1-1.4-1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.1-.2-4.3-1.1-4.3-4.7 0-1 .4-1.9 1-2.6-.1-.2-.4-1.2.1-2.5 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.3.2 2.3.1 2.5.6.7 1 1.6 1 2.6 0 3.7-2.2 4.5-4.3 4.7.3.3.6.9.6 1.8v2.6c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5z"/>');
def('github', { cat: 'Online', name: 'GitHub', desc: 'Unread GitHub notifications', src: ['github'], connect: ghConnect, card: ghCard,
  tile: () => !has('github') ? locked(GH) : D.github ? `<span class="gl">${GH}</span><b>${D.github.notes.length}${D.github.notes.length >= 50 ? '+' : ''}</b><span class="dim">unread</span>` : locked(GH, '…') });
def('githuboverview', { cat: 'Online', name: 'GitHub Overview', desc: 'Notifications, open pull requests and stars', src: ['github'], connect: ghConnect, card: ghCard,
  tile: () => !has('github') ? locked(GH) : D.github ? `<span class="gl">${GH}</span><div class="trio"><span><b>${D.github.notes.length}</b><span class="lbl">inbox</span></span><span><b>${D.github.prs}</b><span class="lbl">PRs</span></span><span><b>${num(D.github.stars)}</b><span class="lbl">stars</span></span></div>` : locked(GH, '…') });

source('ghactivity', 30 * 60e3, async () => {
  const u = cfg('ghUser'); if (!u) return;
  const html = await api(`https://github.com/users/${enc(u)}/contributions`);
  const days = [...String(html).matchAll(/data-date="(\d{4}-\d{2}-\d{2})"[^>]*?data-level="(\d)"/g)].map((m) => [m[1], +m[2]]).sort((a, b) => a[0] < b[0] ? -1 : 1);
  let streak = 0;
  for (let i = days.length - 1; i >= 0; i--) { if (days[i][1] > 0) streak++; else if (i !== days.length - 1) break; }
  D.ghactivity = { days, streak };
});
def('githubactivity', { cat: 'Developer', name: 'GitHub Activity', desc: 'Your contribution grid and streak', src: ['ghactivity'],
  connect: { host: 'github.com', help: 'Only your public username is needed: the contribution graph is public.', fields: [{ key: 'ghUser', label: 'GitHub username', placeholder: 'octocat' }] },
  tile() {
    if (!cfg('ghUser')) return locked(GH);
    const a = D.ghactivity; if (!a) return locked(GH, '…');
    const last = a.days.slice(-7 * 18);
    return `<div class="contrib">${last.map(([d, l]) => `<i class="l${l}" title="${d}"></i>`).join('')}</div><div class="stack tight"><b>${a.streak}</b><span class="dim tiny">day streak</span></div>`;
  },
  card: () => `<header><h2>${esc(cfg('ghUser'))}</h2><span class="dim">${D.ghactivity?.streak ?? 0}-day streak</span></header><div class="contrib big">${(D.ghactivity?.days || []).slice(-7 * 53).map(([d, l]) => `<i class="l${l}" title="${d}"></i>`).join('')}</div>${errText('ghactivity')}` });

source('leetcode', 30 * 60e3, async () => {
  const u = cfg('lcUser'); if (!u) return;
  const r = await api('https://leetcode.com/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.com' },
    body: { query: 'query($u:String!){ matchedUser(username:$u){ submitStatsGlobal{ acSubmissionNum{ difficulty count } } userCalendar{ streak totalActiveDays } } }', variables: { u } } });
  const m = r.data?.matchedUser; if (!m) throw new Error('user not found');
  D.leetcode = { solved: Object.fromEntries(m.submitStatsGlobal.acSubmissionNum.map((x) => [x.difficulty, x.count])), streak: m.userCalendar?.streak || 0 };
});
def('leetcode', { cat: 'Online', name: 'LeetCode Stats', desc: 'Problems solved and your streak', src: ['leetcode'],
  connect: { host: 'leetcode.com', help: 'Your public LeetCode username is enough.', fields: [{ key: 'lcUser', label: 'LeetCode username', placeholder: 'username' }] },
  tile: () => !cfg('lcUser') ? locked(svg.code) : D.leetcode ? `<span class="gl">${svg.code}</span><div class="stack tight"><span><b>${D.leetcode.solved.All}</b> <span class="dim">solved</span></span><span class="tiny"><span class="ez">${D.leetcode.solved.Easy}</span> · <span class="md">${D.leetcode.solved.Medium}</span> · <span class="hd">${D.leetcode.solved.Hard}</span> · ${D.leetcode.streak}d</span></div>` : locked(svg.code, '…') });

/* ---------- social ---------- */
source('youtube', 30 * 60e3, async () => {
  if (!connected(W.youtube)) return;
  const r = await api(`https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${enc(cfg('ytChannel'))}&key={{youtube}}`);
  const c = r.items?.[0]; if (!c) throw new Error('channel not found');
  D.youtube = { subs: +c.statistics.subscriberCount, views: +c.statistics.viewCount, videos: +c.statistics.videoCount, name: c.snippet.title };
});
def('youtube', { cat: 'Social', name: 'YouTube', desc: 'Subscribers on your YouTube channel, via your own API key', src: ['youtube'],
  connect: { host: 'www.googleapis.com', help: 'Google Cloud console → enable YouTube Data API v3 → Credentials → API key. Your channel ID starts with UC (YouTube → Settings → Advanced).', fields: [{ key: 'ytChannel', label: 'Channel ID', placeholder: 'UC…' }, { key: 'youtube', label: 'API key', placeholder: 'AIza…', secret: true }] },
  tile: () => !connected(W.youtube) ? locked(svg.play) : D.youtube ? `<span class="gl yt">${svg.play}</span><div class="stack tight"><b>${num(D.youtube.subs)}</b><span class="dim tiny">subscribers</span></div>` : locked(svg.play, '…'),
  card: () => `<header><h2>${esc(D.youtube?.name || 'YouTube')}</h2></header>${D.youtube ? `<div class="stats"><div class="stat"><span class="lbl">Subscribers</span><b>${num(D.youtube.subs)}</b></div><div class="stat"><span class="lbl">Views</span><b>${num(D.youtube.views)}</b></div><div class="stat"><span class="lbl">Videos</span><b>${D.youtube.videos}</b></div></div>` : ''}${errText('youtube')}` });

/* ---------- stocks & metric (keyless) ---------- */
// ponytail: Yahoo's public chart endpoint is unofficial; if it starts refusing, swap in a keyed quote API.
const tickers = () => (cfg('tickers', 'AAPL,MSFT,NVDA')).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 6);
source('stocks', 5 * 60e3, async () => {
  const out = {};
  await Promise.all(tickers().map(async (t) => {
    const r = await api(`https://query1.finance.yahoo.com/v8/finance/chart/${enc(t)}?range=1d&interval=5m`);
    const res = r.chart?.result?.[0]; if (!res) return;
    out[t] = { price: res.meta.regularMarketPrice, prev: res.meta.chartPreviousClose ?? res.meta.previousClose, cur: res.meta.currency, line: res.indicators.quote[0].close.filter((x) => x != null) };
  }));
  D.stocks = out;
});
const chg = (s) => s.prev ? (s.price - s.prev) / s.prev * 100 : 0;
const stockLine = (t, s) => `<span class="lbl">${t}</span><b>${s.price.toFixed(2)}</b><span class="${chg(s) >= 0 ? 'up' : 'down'} tiny">${chg(s) >= 0 ? '+' : ''}${chg(s).toFixed(2)}%</span>`;
const stockCard = () => `<header><h2>Stocks</h2><span class="dim">intraday, delayed</span></header>
  ${tickers().map((t) => D.stocks?.[t] ? `<div class="hbar stockrow">${stockLine(t, D.stocks[t])}${spark(D.stocks[t].line, 160, 26, chg(D.stocks[t]) >= 0 ? 'up' : 'down')}</div>` : `<div class="dim">${t}…</div>`).join('')}
  <label class="field"><span class="lbl">Tickers, comma separated (first one is the main stock)</span><input type="text" data-tickers value="${esc(tickers().join(', '))}"></label>${errText('stocks')}`;
const stockChange = (e) => { if (e.target.dataset.tickers != null) { store.cfg.tickers = e.target.value; save(); SRC.stocks.at = 0; pump(true); } };
def('stock', { cat: 'Stocks', name: 'Stock', desc: 'One ticker\'s price and daily change', src: ['stocks'], card: stockCard, onChange: stockChange,
  tile: () => { const t = tickers()[0], s = D.stocks?.[t]; return s ? `<span class="gl">${svg.chart}</span><div class="stack tight"><span class="lbl">${t}</span><span><b>${s.price.toFixed(2)}</b> <span class="${chg(s) >= 0 ? 'up' : 'down'} tiny">${chg(s).toFixed(2)}%</span></span></div>` : locked(svg.chart, t + '…'); } });
def('stockchart', { cat: 'Stocks', name: 'Stock Chart', desc: 'One ticker with its intraday line', src: ['stocks'], card: stockCard, onChange: stockChange,
  tile: () => { const t = tickers()[0], s = D.stocks?.[t]; return s ? `<div class="stack tight">${stockLine(t, s)}</div>${spark(s.line, 70, 28, chg(s) >= 0 ? 'up' : 'down')}` : locked(svg.chart, t + '…'); } });
def('watchlist', { cat: 'Stocks', name: 'Stock Watchlist', desc: 'Three tickers at a glance', src: ['stocks'], card: stockCard, onChange: stockChange,
  tile: () => `<div class="watch">${tickers().slice(0, 3).map((t) => D.stocks?.[t] ? `<div class="stack tight">${stockLine(t, D.stocks[t])}</div>` : `<span class="dim">${t}</span>`).join('')}</div>` });

const pair = () => cfg('pair', 'BTC-USD').toUpperCase();
const METRIC = [];
source('metric', 60e3, async () => {
  const r = await api(`https://api.coinbase.com/v2/prices/${enc(pair())}/spot`);
  D.metric = +r.data.amount; METRIC.push(D.metric); if (METRIC.length > 60) METRIC.shift();
});
def('metric', { cat: 'Online', name: 'Metric', desc: 'A live number, such as BTC/USD', src: ['metric'],
  tile: () => D.metric ? `<div class="stack tight"><span class="lbl">${pair().replace('-', '/')}</span><b>${D.metric.toLocaleString([], { maximumFractionDigits: D.metric < 10 ? 4 : 0 })}</b></div>${spark(METRIC, 50, 24)}` : locked(svg.coin, '…'),
  card: () => `<header><h2>${pair()}</h2><b>${D.metric?.toLocaleString() ?? '—'}</b></header>
    <label class="field"><span class="lbl">Pair (Coinbase spot)</span><input type="text" data-pair value="${esc(pair())}" placeholder="ETH-EUR"></label>${errText('metric')}`,
  onChange(e) { if (e.target.dataset.pair != null) { store.cfg.pair = e.target.value.trim(); METRIC.length = 0; save(); SRC.metric.at = 0; pump(true); } } });

/* ---------- wallpaper gallery (Bing images of the day, keyless) ---------- */
source('walls', 6 * 3600e3, async () => {
  const r = await api('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=en-US');
  D.walls = (r.images || []).map((i) => ({ url: 'https://www.bing.com' + i.urlbase + '_UHD.jpg', thumb: 'https://www.bing.com' + i.urlbase + '_400x240.jpg', title: i.title || i.copyright }));
});
def('wallpaper', { cat: 'Online', name: 'Wallpaper Gallery', desc: 'Browse and set new wallpapers', src: ['walls'],
  tile: () => D.walls?.[0] ? `<img class="wthumb" src="${proxImg(D.walls[0].thumb)}" alt=""><div class="stack tight"><span class="lbl">Wallpaper</span><span class="dim clip" style="max-width:130px">${esc(D.walls[0].title)}</span></div>` : locked(svg.image, '…'),
  card: () => `<header><h2>Wallpapers</h2><span class="dim">${D.wallMsg || 'Images of the day · click to set'}</span></header>
    <div class="wallgrid">${(D.walls || []).map((w, i) => `<button data-act="set-wall" data-arg="${i}" title="${esc(w.title)}"><img src="${proxImg(w.thumb)}" alt=""></button>`).join('')}</div>${errText('walls')}` });
ACT['set-wall'] = async (i) => {
  D.wallMsg = 'Setting…'; renderCard();
  try { await invoke('set_wallpaper', { url: D.walls[+i].url }); D.wallMsg = 'Wallpaper set'; } catch (e) { D.wallMsg = String(e); }
};
