// Turbulence Tracker — small server with no dependencies (Node 18+).
// It fetches turbulence data from aviationweather.gov and live aircraft
// positions from OpenSky, caches both, and serves the website in /public.
//
//   node server.js            → http://localhost:3000
//
// Optional settings (environment variables):
//   PORT                    port to listen on (default 3000)
//   OPENSKY_CLIENT_ID       OpenSky API client id     (free account → 10x more lookups)
//   OPENSKY_CLIENT_SECRET   OpenSky API client secret
//   FLIGHT_REFRESH_SEC      how often to refresh a tracked plane (default 15 with account, 30 without)
//   TURB_REFRESH_SEC        how often to refresh turbulence data (default 300 = 5 min)

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { normalizeTurbulence } = require('./lib/normalize');
const { forecastTrip } = require('./lib/plan');
const { routeWeather, timeZoneFor } = require('./lib/weather');
const { localToUtc, validZone } = require('./lib/time');
const { describePlace, aircraftName } = require('./lib/places');

const PORT = Number(process.env.PORT) || 3000;
const OS_ID = process.env.OPENSKY_CLIENT_ID || '';
const OS_SECRET = process.env.OPENSKY_CLIENT_SECRET || '';
const HAS_OS_AUTH = Boolean(OS_ID && OS_SECRET);
const FLIGHT_REFRESH = (Number(process.env.FLIGHT_REFRESH_SEC) || (HAS_OS_AUTH ? 15 : 30)) * 1000;
const TURB_REFRESH = (Number(process.env.TURB_REFRESH_SEC) || 300) * 1000;
const UA = 'TurbulenceTracker/1.0 (personal flight-ride outlook)';
const AWC = 'https://aviationweather.gov/api/data';
const OPENSKY = 'https://opensky-network.org/api';
const OS_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------- small helpers ----------
async function fetchJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 20000);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(opts.headers || {}) },
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error(`${new URL(url).host} answered ${res.status}`);
      err.status = res.status;
      err.headers = res.headers;
      throw err;
    }
    const out = text.trim() ? JSON.parse(text) : null;
    return { data: out, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

function send(res, status, body, extraHeaders = {}) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  res.end(json);
}

// ---------- turbulence data (refreshed every 5 minutes) ----------
const turb = { data: null, at: 0, pending: null, error: null };

async function loadTurbulence() {
  // Each source is fetched separately so one outage doesn't blank the map.
  const sources = {
    pireps: `${AWC}/pirep?format=json&bbox=-90,-180,90,180&age=3`,
    airsigmet: `${AWC}/airsigmet?format=json`,
    isigmet: `${AWC}/isigmet?format=geojson`,
    gairmetHi: `${AWC}/gairmet?format=json&hazard=turb-hi`,
    gairmetLo: `${AWC}/gairmet?format=json&hazard=turb-lo`,
  };
  const entries = await Promise.all(
    Object.entries(sources).map(async ([k, url]) => {
      try {
        const { data } = await fetchJSON(url);
        return [k, { ok: true, data }];
      } catch (e) {
        return [k, { ok: false, error: e.message }];
      }
    })
  );
  const raw = Object.fromEntries(entries);
  const failed = Object.entries(raw).filter(([, v]) => !v.ok).map(([k, v]) => `${k}: ${v.error}`);
  if (failed.length === entries.length) throw new Error('All turbulence sources failed — ' + failed.join('; '));
  const out = normalizeTurbulence({
    pireps: raw.pireps.ok ? raw.pireps.data : [],
    airsigmet: raw.airsigmet.ok ? raw.airsigmet.data : [],
    isigmet: raw.isigmet.ok ? raw.isigmet.data : null,
    gairmet: [].concat(raw.gairmetHi.ok ? raw.gairmetHi.data || [] : [], raw.gairmetLo.ok ? raw.gairmetLo.data || [] : []),
  });
  out.updated = Date.now();
  out.refreshSec = TURB_REFRESH / 1000;
  out.warnings = failed;
  return out;
}

async function getTurbulence() {
  const fresh = turb.data && Date.now() - turb.at < TURB_REFRESH;
  if (fresh) return turb.data;
  if (!turb.pending) {
    turb.pending = loadTurbulence()
      .then((d) => { turb.data = d; turb.at = Date.now(); turb.error = null; return d; })
      .catch((e) => { turb.error = e.message; turb.at = Date.now() - TURB_REFRESH + 60000; if (turb.data) return turb.data; throw e; })
      .finally(() => { turb.pending = null; });
  }
  return turb.pending;
}

// ---------- live pilot-report feed (refreshed every minute) ----------
const feed = { data: null, at: 0, pending: null };
const FEED_REFRESH = 60 * 1000;
async function getPirepFeed() {
  if (feed.data && Date.now() - feed.at < FEED_REFRESH) return feed.data;
  if (!feed.pending) {
    feed.pending = (async () => {
      const { data } = await fetchJSON(`${AWC}/pirep?format=json&bbox=-90,-180,90,180&age=3`);
      const { pireps } = normalizeTurbulence({ pireps: data || [] });
      const reports = pireps
        .filter((p) => p.time != null)
        .sort((a, b) => b.time - a.time)
        .slice(0, 300)
        .map((p) => ({
          id: `${p.time}-${p.lat.toFixed(2)}-${p.lon.toFixed(2)}-${p.altFt}`,
          time: p.time, lat: p.lat, lon: p.lon, altFt: p.altFt, baseFt: p.baseFt, topFt: p.topFt,
          intensity: p.intensity, urgent: p.urgent,
          place: describePlace(p.lat, p.lon),
          aircraft: aircraftName(p.ac),
          raw: p.raw,
        }));
      feed.data = { reports, updated: Date.now(), refreshSec: FEED_REFRESH / 1000 };
      feed.at = Date.now();
      return feed.data;
    })()
      .catch((e) => { feed.at = Date.now() - FEED_REFRESH + 20000; if (feed.data) return feed.data; throw e; })
      .finally(() => { feed.pending = null; });
  }
  return feed.pending;
}

// ---------- OpenSky (live aircraft positions) ----------
const osToken = { value: null, exp: 0 };
const osCredits = { remaining: null, retryAfter: 0 };

async function openskyHeaders() {
  if (!HAS_OS_AUTH) return {};
  if (osToken.value && Date.now() < osToken.exp) return { Authorization: `Bearer ${osToken.value}` };
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: OS_ID, client_secret: OS_SECRET });
  const { data } = await fetchJSON(OS_TOKEN_URL, {
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  osToken.value = data.access_token;
  osToken.exp = Date.now() + ((data.expires_in || 1800) - 60) * 1000;
  return { Authorization: `Bearer ${osToken.value}` };
}

async function opensky(pathAndQuery) {
  if (Date.now() < osCredits.retryAfter) {
    const err = new Error('OpenSky daily lookup limit reached');
    err.status = 429;
    throw err;
  }
  try {
    const { data, headers } = await fetchJSON(OPENSKY + pathAndQuery, { headers: await openskyHeaders() });
    const rem = headers.get('x-rate-limit-remaining');
    if (rem != null) osCredits.remaining = Number(rem);
    return data;
  } catch (e) {
    if (e.status === 401 && HAS_OS_AUTH) osToken.exp = 0; // token expired: next call fetches a new one
    if (e.status === 429) {
      const wait = Number(e.headers && e.headers.get('x-rate-limit-retry-after-seconds')) || 3600;
      osCredits.retryAfter = Date.now() + wait * 1000;
      e.message = 'OpenSky lookup limit reached';
    }
    throw e;
  }
}

// Common airline IATA (2-letter) → ICAO (3-letter) codes, so "UA123" finds "UAL123".
const AIRLINES = {
  UA: 'UAL', AA: 'AAL', DL: 'DAL', WN: 'SWA', AS: 'ASA', B6: 'JBU', NK: 'NKS', F9: 'FFT', HA: 'HAL', G4: 'AAY',
  SY: 'SCX', MX: 'MXY', XP: 'VXP', QX: 'QXE', OO: 'SKW', YX: 'RPA', MQ: 'ENY', '9E': 'EDV', OH: 'JIA', YV: 'ASH',
  PT: 'PDT', ZW: 'AWI', C5: 'UCA', G7: 'GJS', FX: 'FDX', '5X': 'UPS', AC: 'ACA', WS: 'WJA', PD: 'POE', AM: 'AMX',
  Y4: 'VOI', VB: 'VIV', BA: 'BAW', VS: 'VIR', LH: 'DLH', AF: 'AFR', KL: 'KLM', IB: 'IBE', AY: 'FIN', SK: 'SAS',
  LX: 'SWR', OS: 'AUA', SN: 'BEL', TP: 'TAP', EI: 'EIN', FR: 'RYR', U2: 'EZY', W6: 'WZZ', TK: 'THY', EK: 'UAE',
  QR: 'QTR', EY: 'ETD', SQ: 'SIA', CX: 'CPA', NH: 'ANA', JL: 'JAL', KE: 'KAL', OZ: 'AAR', CI: 'CAL', BR: 'EVA',
  QF: 'QFA', NZ: 'ANZ', VA: 'VOZ', CA: 'CCA', MU: 'CES', CZ: 'CSN', AI: 'AIC', LA: 'LAN', AV: 'AVA', CM: 'CMP',
  ET: 'ETH', SA: 'SAA', MS: 'MSR', LY: 'ELY', PR: 'PAL', TG: 'THA', MH: 'MAS', GA: 'GIA', VN: 'HVN', '6E': 'IGO',
};

function callsignCandidates(q) {
  const c = new Set([q]);
  const m = q.match(/^([A-Z0-9]{2})(\d{1,4}[A-Z]?)$/);
  if (m && AIRLINES[m[1]]) c.add(AIRLINES[m[1]] + m[2].replace(/^0+(?=\d)/, ''));
  const m3 = q.match(/^([A-Z]{3})0+(\d+[A-Z]?)$/);
  if (m3) c.add(m3[1] + m3[2]);
  return c;
}

function shapeState(s) {
  const m2ft = 3.28084;
  const alt = s[7] != null ? s[7] : s[13];
  return {
    icao24: s[0],
    callsign: (s[1] || '').trim(),
    country: s[2],
    posTime: (s[3] || s[4]) * 1000,
    lat: s[6],
    lon: s[5],
    altFt: alt != null ? Math.round(alt * m2ft) : null,
    onGround: s[8],
    gsKt: s[9] != null ? Math.round(s[9] * 1.94384) : null,
    track: s[10],
    vsFpm: s[11] != null ? Math.round(s[11] * 196.85) : 0,
    squawk: s[14],
  };
}

// ---------- free ADS-B networks (readsb "v2" API format) ----------
const ADSB_SOURCES = (process.env.ADSB_SOURCES || 'https://api.adsb.lol/v2,https://api.airplanes.live/v2,https://opendata.adsb.fi/api/v2').split(',').map((s) => s.trim()).filter(Boolean);

function shapeAdsb(a, nowMs) {
  const ground = a.alt_baro === 'ground';
  const alt = ground ? 0 : (typeof a.alt_baro === 'number' ? a.alt_baro : typeof a.alt_geom === 'number' ? a.alt_geom : null);
  const vs = typeof a.baro_rate === 'number' ? a.baro_rate : typeof a.geom_rate === 'number' ? a.geom_rate : 0;
  return {
    icao24: String(a.hex || '').replace(/^~/, ''),
    callsign: String(a.flight || '').trim(),
    country: a.r ? `Reg. ${a.r}` : '',
    posTime: nowMs - (Number(a.seen_pos) || 0) * 1000,
    lat: a.lat, lon: a.lon,
    altFt: alt != null ? Math.round(alt) : null,
    onGround: ground,
    gsKt: typeof a.gs === 'number' ? Math.round(a.gs) : null,
    track: typeof a.track === 'number' ? a.track : (typeof a.true_heading === 'number' ? a.true_heading : null),
    vsFpm: Math.round(vs),
    squawk: a.squawk || null,
    type: a.t || '',
  };
}

// Returns a shaped state, or null if the networks answered but can't see the flight.
// Throws only if every source is unreachable.
async function adsbLookup(q, knownHex) {
  adsbLookup.lastAnswered = false;
  const paths = [];
  if (knownHex) paths.push(`/hex/${knownHex}`);
  if (/^[0-9A-F]{6}$/.test(q)) paths.push(`/hex/${q.toLowerCase()}`);
  for (const c of callsignCandidates(q)) paths.push(`/callsign/${c}`);
  let lastErr = null;
  for (const base of ADSB_SOURCES) {
    let answered = false;
    for (const p of paths) {
      try {
        const { data } = await fetchJSON(base + p, { timeout: 10000 });
        answered = true;
        const now = (data && data.now) || Date.now();
        const hits = ((data && data.ac) || []).filter((a) => typeof a.lat === 'number' && typeof a.lon === 'number');
        if (hits.length) {
          hits.sort((a, b) => (a.seen_pos || 0) - (b.seen_pos || 0));
          adsbLookup.lastAnswered = true;
          return shapeAdsb(hits[0], now);
        }
      } catch (e) {
        lastErr = e;
        if (!answered) break; // this source is down or rate-limiting: try the next one
      }
    }
    if (answered) adsbLookup.lastAnswered = true; // empty here; another network may still see it
  }
  if (adsbLookup.lastAnswered) return null;
  throw lastErr || new Error('No live-flight source reachable');
}

const tracked = new Map(); // query → { icao24, state, at, pending }
const trackPaths = new Map(); // icao24 → { path, at }

async function findFlight(q) {
  const entry = tracked.get(q) || {};
  tracked.set(q, entry);
  if (entry.state && Date.now() - entry.at < FLIGHT_REFRESH) return entry;
  if (entry.pending) return entry.pending;

  entry.pending = (async () => {
    // 1) Free community ADS-B networks (work from hosting services like Render).
    let state = null;
    try {
      state = await adsbLookup(q, entry.icao24);
    } catch (e) {
      state = null; // all ADS-B sources unreachable: fall through to OpenSky
    }
    if (state) {
      entry.icao24 = state.icao24; entry.state = state; entry.at = Date.now();
      return entry;
    }
    if (adsbLookup.lastAnswered) {
      // ADS-B networks answered but don't see this flight right now.
      const err = new Error(`No live aircraft found for “${q}”. Check the flight is in the air right now, and try the airline’s 3-letter code (e.g. UAL123 instead of UA123).`);
      err.status = 404;
      throw err;
    }
    // 2) OpenSky as a last resort. Cheap lookup (1 credit): a small box around where the plane was last seen.
    if (entry.state && entry.state.lat != null) {
      const { lat, lon } = entry.state;
      const d = 2.4; // 4.8° × 4.8° ≈ 23 sq° → the cheapest OpenSky price tier
      const box = `lamin=${(lat - d).toFixed(3)}&lomin=${(lon - d).toFixed(3)}&lamax=${(lat + d).toFixed(3)}&lomax=${(lon + d).toFixed(3)}`;
      const data = await opensky(`/states/all?${box}`);
      const s = (data && data.states || []).find((v) => v[0] === entry.icao24);
      if (s) state = shapeState(s);
    }
    // Full lookup (4 credits): search every airborne aircraft by callsign or transponder code.
    if (!state) {
      const data = await opensky('/states/all');
      const cands = callsignCandidates(q);
      const hex = q.toLowerCase();
      const s = (data && data.states || []).find((v) => cands.has((v[1] || '').trim().toUpperCase()) || v[0] === hex || v[0] === entry.icao24);
      if (s) state = shapeState(s);
    }
    if (!state) {
      const err = new Error(`No live aircraft found for “${q}”. Check the flight is airborne now and try the airline's ICAO callsign (e.g. UAL123 instead of UA123).`);
      err.status = 404;
      throw err;
    }
    entry.icao24 = state.icao24;
    entry.state = state;
    entry.at = Date.now();
    return entry;
  })().finally(() => { entry.pending = null; });
  return entry.pending;
}

async function getTrackPath(icao24) {
  const c = trackPaths.get(icao24);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.path;
  try {
    const data = await opensky(`/tracks/all?icao24=${icao24}&time=0`);
    const path = (data && data.path || []).filter((p) => p[1] != null).map((p) => [p[1], p[2], p[3] != null ? Math.round(p[3] * 3.28084) : null]);
    trackPaths.set(icao24, { path, at: Date.now() });
    return path;
  } catch {
    trackPaths.set(icao24, { path: (c && c.path) || [], at: Date.now() });
    return (c && c.path) || [];
  }
}

// ---------- airports (for the destination) ----------
const airports = new Map();
async function getAirport(id) {
  if (airports.has(id)) return airports.get(id);
  const tries = [id];
  if (id.length === 3) tries.push('K' + id, 'C' + id, 'P' + id);
  for (const t of tries) {
    const { data } = await fetchJSON(`${AWC}/airport?ids=${encodeURIComponent(t)}&format=json`);
    const a = Array.isArray(data) && data[0];
    if (a && a.lat != null) {
      const out = { id: a.icaoId || t, iata: a.iataId, name: (a.name || '').trim(), lat: Number(a.lat), lon: Number(a.lon), elevFt: Number(a.elev) * 3.28084 || 0 };
      airports.set(id, out);
      return out;
    }
  }
  const err = new Error(`Couldn't find an airport with the code “${id}”. Try the 3-letter code on your ticket, like SFO or JFK.`);
  err.status = 404;
  throw err;
}

// Airport with its time zone (so "8:30 AM" means 8:30 at that airport).
async function getAirportWithZone(id) {
  const a = await getAirport(id);
  if (!a.tz) {
    try {
      const tz = await timeZoneFor(a.lat, a.lon, fetchJSON);
      a.tz = validZone(tz) ? tz : 'UTC';
    } catch {
      return { ...a, tz: 'UTC', tzGuess: true }; // try again next time
    }
  }
  return a;
}

// ---------- trip forecasts ----------
const weatherCache = new Map(); // key → { at, samplers }
async function cachedWeather(points, fromMs, toMs) {
  const key = points.map((p) => `${p.lat.toFixed(1)},${p.lon.toFixed(1)}`).join(';') + '|' + Math.floor(fromMs / 3600000) + '|' + Math.floor(toMs / 3600000);
  const hit = weatherCache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60000) return hit.samplers;
  const samplers = await routeWeather(points, fromMs, toMs, fetchJSON);
  weatherCache.set(key, { at: Date.now(), samplers });
  if (weatherCache.size > 200) weatherCache.delete(weatherCache.keys().next().value);
  return samplers;
}

const MAX_AHEAD_DAYS = 15;
async function tripForecast(params) {
  const code = (v) => (v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const toCode = code(params.get('to'));
  const dest = toCode ? await getAirportWithZone(toCode) : null;
  let turbData = null;
  try { turbData = await getTurbulence(); } catch { /* forecast still works without live reports */ }
  const now = Date.now();

  // Already in the air: start from the plane's current position.
  if (params.get('lat') != null) {
    const n = (k) => (params.get(k) != null && params.get(k) !== '' ? Number(params.get(k)) : null);
    const live = { altFt: n('alt'), gsKt: n('gs'), track: n('track'), vsFpm: n('vs') || 0 };
    const lat = n('lat'), lon = n('lon');
    if (!isFinite(lat) || !isFinite(lon)) { const e = new Error('Missing position'); e.status = 400; throw e; }
    const out = await forecastTrip({ origin: { lat, lon, elevFt: 0, code: 'current position' }, dest, departUtc: now, live, turb: turbData, getWeather: cachedWeather, now });
    return { ...out, live: true, dest };
  }

  const fromCode = code(params.get('from'));
  if (!fromCode || !toCode) { const e = new Error('Enter both a departure and an arrival airport.'); e.status = 400; throw e; }
  if (fromCode === toCode) { const e = new Error('Departure and arrival airports are the same.'); e.status = 400; throw e; }
  const origin = await getAirportWithZone(fromCode);
  const depart = params.get('depart') || 'now';
  let departUtc = depart === 'now' ? now : localToUtc(depart, origin.tz);
  if (!isFinite(departUtc)) { const e = new Error('Pick a departure date and time.'); e.status = 400; throw e; }
  if (departUtc < now - 60 * 60000) { const e = new Error('That departure time has already passed. For a flight in the air now, use “Live flight”.'); e.status = 400; throw e; }
  if (departUtc > now + MAX_AHEAD_DAYS * 86400000) { const e = new Error(`Weather forecasts only reach about ${MAX_AHEAD_DAYS} days ahead. Check back closer to your trip.`); e.status = 400; throw e; }
  departUtc = Math.max(departUtc, now - 60 * 60000);
  const out = await forecastTrip({
    origin: { ...origin, code: origin.iata || origin.id }, dest: { ...dest, code: dest.iata || dest.id },
    departUtc, turb: turbData, getWeather: cachedWeather, now,
  });
  return { ...out, live: false, origin, dest };
}

// ---------- HTTP routes ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  try {
    if (p === '/api/turbulence') {
      const data = await getTurbulence();
      return send(res, 200, { ...data, error: turb.error });
    }
    if (p === '/api/flight') {
      const q = (url.searchParams.get('q') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!q || q.length > 8) return send(res, 400, { error: 'Enter a flight callsign like UAL123 or a 6-character transponder code.' });
      const entry = await findFlight(q);
      const withPath = url.searchParams.get('path') === '1';
      return send(res, 200, {
        flight: entry.state,
        path: withPath ? await getTrackPath(entry.icao24) : undefined,
        fetchedAt: entry.at,
        refreshSec: FLIGHT_REFRESH / 1000,
        creditsRemaining: osCredits.remaining,
        authenticated: HAS_OS_AUTH,
      });
    }
    if (p === '/api/airport') {
      const id = (url.searchParams.get('id') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (id.length < 3 || id.length > 4) return send(res, 400, { error: 'Use a 3- or 4-letter airport code like JFK or KJFK.' });
      return send(res, 200, await getAirport(id));
    }
    if (p === '/api/pireps') {
      return send(res, 200, await getPirepFeed());
    }
    if (p === '/api/forecast') {
      return send(res, 200, await tripForecast(url.searchParams));
    }
    if (p === '/api/status') {
      return send(res, 200, { flightRefreshSec: FLIGHT_REFRESH / 1000, turbRefreshSec: TURB_REFRESH / 1000, authenticated: HAS_OS_AUTH, creditsRemaining: osCredits.remaining, turbulenceUpdated: turb.at || null, turbulenceError: turb.error });
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'Unknown endpoint' });
    return serveStatic(req, res, p);
  } catch (e) {
    const status = e.status === 404 || e.status === 400 || e.status === 429 ? e.status : 502;
    return send(res, status, { error: e.message || 'Something went wrong' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Turbulence Tracker running → http://localhost:${PORT}`);
    const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    if (lan.length) {
      console.log('');
      console.log('  On your iPhone (same Wi-Fi), open Safari and go to:');
      for (const ip of lan) console.log(`     http://${ip}:${PORT}`);
      console.log('');
    }
    console.log(`Plane refresh every ${FLIGHT_REFRESH / 1000}s, turbulence every ${TURB_REFRESH / 60000} min. OpenSky account: ${HAS_OS_AUTH ? 'yes' : 'no (400 lookups/day)'}`);
  });
}

module.exports = { server, callsignCandidates, shapeState };
