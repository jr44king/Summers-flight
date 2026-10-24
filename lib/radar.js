// "Future radar": forecast rain and storms in a corridor around the route, hour by hour
// through the flight (NOAA GFS via Open-Meteo, free, worldwide, ~16 days ahead).
'use strict';
const { destinationPoint, distanceNm } = require('./geo');

const isoHour = (ms) => new Date(Math.floor(ms / 3600000) * 3600000).toISOString().slice(0, 16);

function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

// Grid cells along the route: rows across the path every `spacing` nm, 5 cells wide.
function corridor(line, maxCells = 150) {
  const path = line.map((p) => [p[0], p[1]]);
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distanceNm(path[i - 1], path[i]);
  const rows = Math.max(2, Math.min(Math.floor(maxCells / 5), Math.ceil(total / 70) + 1));
  const spacing = total / (rows - 1 || 1);
  const across = Math.min(90, Math.max(45, spacing));
  const cells = [];
  let walked = 0, j = 1;
  for (let r = 0; r < rows; r++) {
    const target = r * spacing;
    while (j < path.length - 1 && walked + distanceNm(path[j - 1], path[j]) < target) { walked += distanceNm(path[j - 1], path[j]); j++; }
    const a = path[j - 1], b = path[j];
    const seg = distanceNm(a, b) || 1;
    const f = Math.max(0, Math.min(1, (target - walked) / seg));
    const here = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    const brg = bearing(a, b);
    for (const k of [-2, -1, 0, 1, 2]) {
      const p = k === 0 ? here : destinationPoint(here, brg + (k > 0 ? 90 : -90), Math.abs(k) * across);
      cells.push([+p[0].toFixed(2), +p[1].toFixed(2)]);
    }
  }
  return { cells, radiusNm: Math.max(across, spacing) * 0.8 };
}

// Returns { cells: [[lat, lon]], radiusKm, times: [ms], rain: [[mm/h per time] per cell], storm: [[0/1 per time] per cell] }
async function forecastRadar(line, fromMs, toMs, fetchJSON) {
  const { cells, radiusNm } = corridor(line);
  const lat = cells.map((c) => c[0]).join(','), lon = cells.map((c) => c[1]).join(',');
  const url = `https://api.open-meteo.com/v1/gfs?latitude=${lat}&longitude=${lon}&hourly=precipitation,weather_code` +
    `&timezone=GMT&start_hour=${isoHour(fromMs - 3600000)}&end_hour=${isoHour(toMs + 3600000)}`;
  const { data } = await fetchJSON(url, { timeout: 30000 });
  const list = Array.isArray(data) ? data : [data];
  if (list.length !== cells.length) throw new Error('Unexpected radar forecast answer');
  const times = ((list[0] && list[0].hourly && list[0].hourly.time) || []).map((t) => Date.parse(t + 'Z'));
  return {
    cells,
    radiusKm: Math.round(radiusNm * 1.852),
    times,
    rain: list.map((l) => ((l.hourly && l.hourly.precipitation) || []).map((v) => (v == null ? 0 : +v.toFixed(1)))),
    storm: list.map((l) => ((l.hourly && l.hourly.weather_code) || []).map((v) => (v != null && v >= 95 ? 1 : 0))),
  };
}

module.exports = { forecastRadar, corridor };
