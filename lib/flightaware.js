// FlightAware AeroAPI (paid, optional): the real filed route and the real flown track.
// Only used when FLIGHTAWARE_API_KEY is set. Calls are cached hard to keep costs to ~3 lookups per flight.
'use strict';
const { distanceNm } = require('./geo');

const BASE = 'https://aeroapi.flightaware.com/aeroapi';

function createFlightAware({ apiKey, fetchJSON }) {
  const enabled = Boolean(apiKey);
  const status = { enabled, lastError: null, calls: 0, log: [], samples: {} };
  const cache = new Map(); // key → { at, value }

  async function call(path) {
    status.calls++;
    const note = (entry) => { status.log.push({ at: new Date().toISOString(), path, ...entry }); if (status.log.length > 15) status.log.shift(); };
    try {
      const { data } = await fetchJSON(BASE + path, { headers: { 'x-apikey': apiKey }, timeout: 15000 });
      status.lastError = null;
      note({ ok: true });
      return data;
    } catch (e) {
      status.lastError = e.status === 401 || e.status === 403 ? 'FlightAware rejected the API key' : e.status === 429 ? 'FlightAware rate limit reached' : e.message;
      note({ ok: false, http: e.status || null, error: status.lastError });
      throw e;
    }
  }
  async function cached(key, ttlMs, fn) {
    const c = cache.get(key);
    if (c && Date.now() - c.at < ttlMs) return c.value;
    let value = null;
    try { value = await fn(); } catch { value = c ? c.value : null; }
    cache.set(key, { at: Date.now(), value });
    if (cache.size > 400) cache.delete(cache.keys().next().value);
    return value;
  }

  const shapeAirport = (a) => (a && (a.code_iata || a.code_icao || a.code) ? {
    id: a.code_icao || a.code, iata: a.code_iata || null, name: a.city || a.name || '', fullName: a.name || '', tz: a.timezone || null,
  } : null);

  // The flight that is in the air right now for this callsign (1 lookup, cached 20 min).
  async function currentFlight(callsign) {
    if (!enabled || !/^[A-Z0-9]{3,8}$/.test(callsign || '')) return null;
    return cached('f:' + callsign, 20 * 60000, async () => {
      const d = await call(`/flights/${encodeURIComponent(callsign)}?ident_type=designator`);
      const list = (d && d.flights) || [];
      status.samples.flight = list[0] ? { keys: Object.keys(list[0]), originKeys: list[0].origin ? Object.keys(list[0].origin) : null, count: list.length } : { count: 0 };
      const airborne = list.filter((f) => f.actual_off && !f.actual_on && !f.cancelled);
      const f = airborne[0] || list.filter((x) => x.actual_off && !x.cancelled).sort((a, b) => Date.parse(b.actual_off) - Date.parse(a.actual_off))[0];
      if (!f) return null;
      return {
        faId: f.fa_flight_id, ident: f.ident_icao || f.ident, aircraftType: f.aircraft_type || null, registration: f.registration || null,
        origin: shapeAirport(f.origin), dest: shapeAirport(f.destination),
        filedAltitudeFt: f.filed_altitude ? f.filed_altitude * 100 : null,
        departed: f.actual_off || null, eta: f.estimated_on || f.scheduled_on || null, progress: f.progress_percent ?? null,
        status: f.status || '',
      };
    });
  }

  // Filed route as [lat, lon] waypoints from departure to arrival (1 lookup per flight, cached 2 h).
  async function filedRoute(faId) {
    if (!enabled || !faId) return null;
    return cached('r:' + faId, 2 * 3600000, async () => {
      const d = await call(`/flights/${encodeURIComponent(faId)}/route`);
      status.samples.route = { keys: d ? Object.keys(d) : null, fixKeys: d && d.fixes && d.fixes[0] ? Object.keys(d.fixes[0]) : null, count: d && d.fixes ? d.fixes.length : 0, withCoords: d && d.fixes ? d.fixes.filter((x) => x.latitude != null).length : 0 };
      const fixes = ((d && d.fixes) || [])
        .map((x) => [Number(x.latitude), Number(x.longitude)])
        .filter((p) => isFinite(p[0]) && isFinite(p[1]) && !(p[0] === 0 && p[1] === 0));
      return fixes.length >= 2 ? fixes : null;
    });
  }

  // Real flown track as [lat, lon, altFt, ms] (1 lookup per flight; later points come from live ADS-B).
  async function flownTrack(faId) {
    if (!enabled || !faId) return null;
    return cached('t:' + faId, 3 * 3600000, async () => {
      const d = await call(`/flights/${encodeURIComponent(faId)}/track`);
      status.samples.track = { keys: d ? Object.keys(d) : null, posKeys: d && d.positions && d.positions[0] ? Object.keys(d.positions[0]) : null, count: d && d.positions ? d.positions.length : 0 };
      const pts = ((d && d.positions) || [])
        .map((p) => [Number(p.latitude), Number(p.longitude), p.altitude != null ? (p.altitude < 1000 ? p.altitude * 100 : p.altitude) : null, Date.parse(p.timestamp)])
        .filter((p) => isFinite(p[0]) && isFinite(p[1]));
      return pts.length ? pts : null;
    });
  }

  return { enabled, status, currentFlight, filedRoute, flownTrack };
}

// The part of a route still ahead of a position: [here, next waypoint, ..., arrival].
// Returns null if the plane is far from the filed route (re-routed), so callers can fall back.
function remainingPath(route, here, maxOffNm = 120) {
  if (!route || route.length < 2 || !here) return null;
  const toXY = (p) => [(p[1] - here[1]) * Math.cos((here[0] * Math.PI) / 180) * 60, (p[0] - here[0]) * 60]; // nm, flat near the plane
  let best = null;
  for (let i = 0; i < route.length - 1; i++) {
    const a = toXY(route[i]), b = toXY(route[i + 1]);
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    let t = len2 ? -(a[0] * dx + a[1] * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const off = Math.hypot(a[0] + t * dx, a[1] + t * dy);
    if (!best || off < best.off) best = { i, t, off };
  }
  if (!best || best.off > maxOffNm) return null;
  const rest = route.slice(best.i + 1);
  // Skip a waypoint that's basically where the plane already is.
  if (rest.length > 1 && distanceNm(here, rest[0]) < 5) rest.shift();
  return [here, ...rest];
}

module.exports = { createFlightAware, remainingPath };
