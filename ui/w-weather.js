/* Weather (Open-Meteo, no key). One source feeds every weather tile. */
function sky(code, day) {
  if (code >= 95) return ['storm', 'storm'];
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return ['snow', 'snow'];
  if (code >= 51) return ['rain', 'rain'];
  if (code >= 45) return ['fog', 'cloud'];
  if (code >= 3) return ['cloud', 'cloud'];
  return day ? ['sun', 'day'] : ['moon', 'night'];
}
const WORDS = (c) => c >= 95 ? 'Thunderstorm' : c >= 85 ? 'Snow showers' : c >= 80 ? 'Rain showers' : c >= 71 ? 'Snow' : c >= 61 ? 'Rain' : c >= 51 ? 'Drizzle' : c >= 45 ? 'Fog' : c === 3 ? 'Overcast' : c >= 1 ? 'Partly cloudy' : 'Clear';

source('weather', 15 * 60e3, async () => {
  if (!store.city) { D.weather = null; return; }
  const { lat, lon } = store.city;
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}`
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,is_day,wind_speed_10m'
    + '&hourly=temperature_2m,weather_code,precipitation_probability,is_day&forecast_hours=12'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max&forecast_days=7&timezone=auto'
    + (store.unit === 'f' ? '&temperature_unit=fahrenheit&wind_speed_unit=mph' : ''));
  if (!r.ok) throw new Error('weather service returned ' + r.status);
  D.weather = await r.json();
});
FORMS.city = async (v) => {
  const r = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&name=${encodeURIComponent(v)}`)).json();
  const c = r.results?.[0];
  if (!c) throw new Error('city not found');
  store.city = { name: c.name, lat: c.latitude, lon: c.longitude };
  save(); SRC.weather.at = 0; await pump(true);
};

const wx = () => D.weather;
const setCity = (msg = 'Set city') => `<span class="sky cloud">${svg.cloud}</span><span class="dim">${store.city ? '…' : msg}</span>`;
const windU = () => store.unit === 'f' ? 'mph' : 'km/h';
const dayName = (t) => new Date(t + 'T12:00').toLocaleDateString([], { weekday: 'short' });

function weatherCard() {
  const d = wx(), w = d?.current, dl = d?.daily;
  const form = `<form data-form="city"><input type="text" name="v" placeholder="${store.city ? 'Change city' : 'Type your city and press Enter'}" autocomplete="off"></form>`;
  if (!w) return `<header><h2>Weather</h2><span class="dim">Open-Meteo · no account needed</span></header>${form}${errText('weather')}`;
  const [g, tone] = sky(w.weather_code, w.is_day);
  return `<header><h2>${esc(store.city.name)}</h2><span class="dim">${WORDS(w.weather_code)} · feels ${deg(w.apparent_temperature)}</span></header>
    <div class="wx"><span class="sky big ${tone}">${svg[g]}<b>${deg(w.temperature_2m)}</b></span>
      <div class="stack"><span>H ${deg(dl.temperature_2m_max[0])} · L ${deg(dl.temperature_2m_min[0])} · rain ${dl.precipitation_probability_max[0] ?? 0}%</span>
      <span class="dim">Wind ${Math.round(w.wind_speed_10m)} ${windU()} · humidity ${w.relative_humidity_2m}% · sunrise ${time(new Date(dl.sunrise[0]))} · sunset ${time(new Date(dl.sunset[0]))}</span></div></div>
    <h3 class="lbl">Next hours</h3>
    <div class="hours">${d.hourly.time.slice(0, 12).map((t, i) => `<div><span class="lbl">${time(new Date(t)).replace(':00', '')}</span>${svg[sky(d.hourly.weather_code[i], d.hourly.is_day[i])[0]]}<b>${deg(d.hourly.temperature_2m[i])}</b><span class="dim">${d.hourly.precipitation_probability[i] ?? 0}%</span></div>`).join('')}</div>
    <div class="fc">${dl.time.slice(1, 7).map((t, i) => `<div><span class="lbl">${dayName(t)}</span>${svg[sky(dl.weather_code[i + 1], 1)[0]]}<b>${deg(dl.temperature_2m_max[i + 1])}</b><span class="dim">${deg(dl.temperature_2m_min[i + 1])}</span></div>`).join('')}</div>
    ${form}${errText('weather')}`;
}
const wxDef = (id, name, desc, tile) => def(id, { cat: 'Weather', name, desc, src: ['weather'], tile: () => (wx()?.current ? tile(wx()) : setCity()), card: weatherCard });

wxDef('weather', 'Weather', 'Temperature now, with today\'s high and low', (d) => {
  const w = d.current, [g, tone] = sky(w.weather_code, w.is_day);
  return `<span class="sky ${tone}">${svg[g]}<b>${deg(w.temperature_2m)}</b></span><div class="stack tight"><span class="dim">H ${deg(d.daily.temperature_2m_max[0])}</span><span class="dim">L ${deg(d.daily.temperature_2m_min[0])}</span></div>`;
});
wxDef('wxdetails', 'Weather Details', 'Wind, rain and the day\'s range', (d) => {
  const w = d.current;
  return `<div class="stack"><span><span class="lbl">Wind</span> <b>${Math.round(w.wind_speed_10m)}</b> <span class="dim">${windU()}</span></span><span><span class="lbl">Rain</span> <b>${d.daily.precipitation_probability_max[0] ?? 0}%</b> <span class="dim">${deg(d.daily.temperature_2m_min[0])}–${deg(d.daily.temperature_2m_max[0])}</span></span></div>`;
});
wxDef('wxforecast', 'Weather Forecast', 'The next four days', (d) =>
  `<div class="mini-fc">${d.daily.time.slice(1, 5).map((t, i) => `<div><span class="lbl">${dayName(t)}</span>${svg[sky(d.daily.weather_code[i + 1], 1)[0]]}<b>${deg(d.daily.temperature_2m_max[i + 1])}</b></div>`).join('')}</div>`);
wxDef('wxtoday', 'Today & Forecast', 'Today next to the next three days', (d) => {
  const w = d.current, [g, tone] = sky(w.weather_code, w.is_day);
  return `<span class="sky ${tone}">${svg[g]}<b>${deg(w.temperature_2m)}</b></span><div class="mini-fc">${d.daily.time.slice(1, 4).map((t, i) => `<div><span class="lbl">${dayName(t)}</span>${svg[sky(d.daily.weather_code[i + 1], 1)[0]]}<b>${deg(d.daily.temperature_2m_max[i + 1])}</b></div>`).join('')}</div>`;
});
wxDef('wxstatus', 'Weather Status', 'The conditions in words, with your city', (d) =>
  `<span class="gl">${svg[sky(d.current.weather_code, d.current.is_day)[0]]}</span><div class="stack"><b class="plain">${WORDS(d.current.weather_code)}, ${deg(d.current.temperature_2m)}</b><span class="dim">${esc(store.city.name)}</span></div>`);
wxDef('wxhourly', 'Hourly', 'The next six hours', (d) =>
  `<div class="mini-fc">${d.hourly.time.slice(0, 6).map((t, i) => `<div><span class="lbl">${time(new Date(t)).replace(':00', '')}</span>${svg[sky(d.hourly.weather_code[i], d.hourly.is_day[i])[0]]}<b>${deg(d.hourly.temperature_2m[i])}</b></div>`).join('')}</div>`);
wxDef('sun', 'Sunrise & Sunset', 'Where the sun is between sunrise and sunset', (d) => {
  const rise = new Date(d.daily.sunrise[0]), set = new Date(d.daily.sunset[0]), f = clamp((Date.now() - rise) / (set - rise), 0, 1);
  const x = 4 + f * 52, y = 24 - Math.sin(f * Math.PI) * 18;
  return `<svg class="sunarc" viewBox="0 0 60 28"><path d="M4 24 Q30 -12 56 24" /><line x1="0" y1="24" x2="60" y2="24"/>${Date.now() > rise && Date.now() < set ? `<circle cx="${x}" cy="${y}" r="3.4"/>` : ''}</svg>
    <div class="stack tight"><span class="dim">↑ ${time(rise)}</span><span class="dim">↓ ${time(set)}</span></div>`;
});
