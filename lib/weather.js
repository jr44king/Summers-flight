// Forecast weather along a route from Open-Meteo (NOAA GFS model, free, no key, 16 days ahead).
'use strict';

const LEVELS = [850, 700, 500, 400, 300, 250, 200];
const VARS = [
  ...LEVELS.flatMap((l) => [`wind_speed_${l}hPa`, `wind_direction_${l}hPa`, `geopotential_height_${l}hPa`]),
  'cape', 'lifted_index', 'weather_code', 'wind_gusts_10m',
];
const BASE = 'https://api.open-meteo.com/v1/gfs';

const isoHour = (ms) => new Date(Math.floor(ms / 3600000) * 3600000).toISOString().slice(0, 16);

// points: [{lat, lon}]; returns one sampler per point: sample(utcMs) → weather at the nearest hour.
async function routeWeather(points, fromMs, toMs, fetchJSON) {
  const lat = points.map((p) => p.lat.toFixed(2)).join(',');
  const lon = points.map((p) => p.lon.toFixed(2)).join(',');
  const url = `${BASE}?latitude=${lat}&longitude=${lon}&hourly=${VARS.join(',')}` +
    `&wind_speed_unit=kn&timezone=GMT&start_hour=${isoHour(fromMs - 3600000)}&end_hour=${isoHour(toMs + 7200000)}`;
  const { data } = await fetchJSON(url, { timeout: 30000 });
  const list = Array.isArray(data) ? data : [data];
  if (list.length !== points.length) throw new Error('Forecast service returned an unexpected answer');
  return list.map((loc) => {
    const h = (loc && loc.hourly) || {};
    const times = (h.time || []).map((t) => Date.parse(t + 'Z'));
    return (utcMs) => {
      if (!times.length) return null;
      let best = 0;
      for (let i = 1; i < times.length; i++) if (Math.abs(times[i] - utcMs) < Math.abs(times[best] - utcMs)) best = i;
      const v = (k) => (h[k] && h[k][best] != null ? h[k][best] : null);
      const levels = LEVELS.map((p) => ({
        p, spd: v(`wind_speed_${p}hPa`), dir: v(`wind_direction_${p}hPa`), zFt: v(`geopotential_height_${p}hPa`) != null ? v(`geopotential_height_${p}hPa`) * 3.28084 : null,
      })).filter((l) => l.spd != null && l.dir != null && l.zFt != null);
      return { levels, cape: v('cape'), li: v('lifted_index'), code: v('weather_code'), gustKt: v('wind_gusts_10m'), groundFt: loc && loc.elevation != null ? loc.elevation * 3.28084 : null };
    };
  });
}

// Time zone name for one place (e.g. "America/New_York").
async function timeZoneFor(lat, lon, fetchJSON) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}&longitude=${lon.toFixed(3)}&hourly=temperature_2m&forecast_days=1&timezone=auto`;
  const { data } = await fetchJSON(url);
  return (Array.isArray(data) ? data[0] : data).timezone;
}

module.exports = { routeWeather, timeZoneFor, LEVELS, VARS };
