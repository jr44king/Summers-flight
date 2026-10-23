// Fake upstream data shaped like the real aviationweather.gov / OpenSky responses.
'use strict';
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
// ----- fake upstream responses (field names match aviationweather.gov / OpenSky) -----
const PIREPS = [
  { receiptTime: iso(now - 20 * 60000), obsTime: Math.floor((now - 25 * 60000) / 1000), icaoId: 'KWBC', acType: 'B738', lat: 40.0, lon: -100.0, fltLvl: 350, fltLvlType: 'OTHER', tbInt1: 'MOD', tbType1: 'CHOP', tbFreq1: 'OCNL', tbBas1: null, tbTop1: null, tbInt2: '', pirepType: 'PIREP', rawOb: 'XXX UA /OV ... /FL350/TP B738/TB OCNL MOD CHOP' },
  { receiptTime: iso(now - 10 * 60000), obsTime: Math.floor((now - 12 * 60000) / 1000), icaoId: 'KWBC', acType: 'A320', lat: 40.2, lon: -99.6, fltLvl: 360, fltLvlType: 'OTHER', tbInt1: 'LGT-MOD', tbType1: '', tbFreq1: 'CONT', pirepType: 'AIREP', rawOb: 'raw' },
  { receiptTime: iso(now - 5 * 60000), obsTime: Math.floor((now - 6 * 60000) / 1000), icaoId: 'KWBC', acType: 'B744', lat: 42.28, lon: -87.46, fltLvl: 105, tbInt1: '', rawOb: 'ORD UA /OV ORD050027/TM 0822/FL105/TP B744/SK CLR/TB SMOOTH' },
  { receiptTime: iso(now - 5 * 60000), obsTime: Math.floor((now - 6 * 60000) / 1000), icaoId: 'KWBC', acType: 'B738', lat: 29.33, lon: -82.16, fltLvl: 290, tbInt1: null, rawOb: 'OCF UA /OV OCF020010/TM 0818/FL290/TP B738/SK SKC' },
];
const AIRSIGMET = [
  { airSigmetType: 'SIGMET', hazard: 'CONVECTIVE', altitudeHi1: 45000, altitudeLow1: null, validTimeFrom: Math.floor(now / 1000) - 600, validTimeTo: Math.floor(now / 1000) + 3600, rawAirSigmet: 'CONVECTIVE SIGMET 79W', coords: [{ lon: -112.991, lat: 40.139 }, { lon: -105.82, lat: 37.35 }, { lon: -108.963, lat: 32.887 }, { lon: -112.991, lat: 40.139 }] },
  { airSigmetType: 'SIGMET', hazard: 'IFR', coords: [] },
];
const ISIGMET = { type: 'FeatureCollection', features: [
  { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[-138.35, 29.167], [-135.233, 27.767], [-135.833, 25.117], [-139, 26], [-138.35, 29.167]]] }, properties: { hazard: 'TURB', qualifier: 'SEV', base: 20000, top: 30000, validTimeFrom: iso(now - 3600e3), validTimeTo: iso(now + 3600e3), firName: 'OAKLAND OCEANIC', rawSigmet: 'SEV TURB' } },
  { type: 'Feature', geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] }, properties: { hazard: 'TURB' } },
] };
// G-AIRMET box over Nebraska/Kansas, FL300–FL420, valid now.
const GAIRMET = [
  { tag: '1W', forecastHour: 0, validTime: iso(now), hazard: 'TURB-HI', severity: 'MOD', top: '420', base: '300', coords: [{ lat: '38', lon: '-102' }, { lat: '42', lon: '-102' }, { lat: '42', lon: '-96' }, { lat: '38', lon: '-96' }, { lat: '38', lon: '-102' }] },
  { tag: '5W', forecastHour: 3, validTime: iso(now + 3 * 3600e3), hazard: 'TURB-LO', severity: 'MOD', top: '150', base: 'SFC', coords: [{ lat: '37.01', lon: '-112.32' }, { lat: '38', lon: '-110' }, { lat: '36', lon: '-110' }, { lat: '37.01', lon: '-112.32' }] },
];
// OpenSky state vector: UAL123 at 40N 104W, FL350, eastbound 450 kt.
const STATE = ['a1b2c3', 'UAL123  ', 'United States', Math.floor(now / 1000) - 3, Math.floor(now / 1000) - 2, -104.0, 40.0, 10668, false, 231.5, 90, 0, null, 10700, '1234', false, 0];
const OTHER = ['abcdef', 'DAL45   ', 'United States', 1, 1, -80, 30, 9000, false, 200, 10, 0, null, 9000, null, false, 0];

// Fake Open-Meteo GFS answer: a strong jet stream (high wind shear near 34,000 ft)
// between 105°W and 95°W, and gusty winds near New York.
const gfsCalls = [];
function fakeGfs(sp) {
  gfsCalls.push(sp.toString());
  const lats = sp.get('latitude').split(',').map(Number);
  const lons = sp.get('longitude').split(',').map(Number);
  const start = Date.parse(sp.get('start_hour') + 'Z'), end = Date.parse(sp.get('end_hour') + 'Z');
  const times = [];
  for (let t = start; t <= end; t += 3600000) times.push(new Date(t).toISOString().slice(0, 16));
  const out = lats.map((lat, i) => {
    const lon = lons[i];
    const jet = lon > -105 && lon < -95;
    const nyc = lon > -75;
    const lv = { 850: [20, 1500], 700: [30, 3000], 500: [50, 5600], 400: [60, 7200], 300: [jet ? 85 : 60, 9200], 250: [jet ? 110 : 65, 10400], 200: [jet ? 95 : 60, 11800] };
    const hourly = { time: times };
    for (const [p, [spd, z]] of Object.entries(lv)) {
      hourly[`wind_speed_${p}hPa`] = times.map(() => spd);
      hourly[`wind_direction_${p}hPa`] = times.map(() => 270);
      hourly[`geopotential_height_${p}hPa`] = times.map(() => z);
    }
    hourly.cape = times.map(() => 0);
    hourly.lifted_index = times.map(() => 3);
    hourly.weather_code = times.map(() => 1);
    hourly.wind_gusts_10m = times.map(() => (nyc ? 30 : 8));
    return { latitude: lat, longitude: lon, hourly };
  });
  return out.length === 1 ? out[0] : out;
}

const openskyCalls = [];
const faCalls = [];
const adsbCalls = [];
const adsb = { down: false };
// adsb.lol-style answer: UAL123 over Colorado at 35,000 ft, 450 kt, level.
const ADSB_UAL123 = { hex: 'a1b2c3', flight: 'UAL123  ', r: 'N12345', t: 'B738', lat: 40.0, lon: -104.0, alt_baro: 35000, alt_geom: 35400, gs: 450, track: 90, baro_rate: 0, seen_pos: 0.4, seen: 0.2 };
function installMockFetch() {
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const json = (obj, headers = {}) => ({ ok: true, status: 200, headers: new Map(Object.entries(headers)), text: async () => JSON.stringify(obj) });
  if (u.includes('/pirep')) return json(PIREPS);
  if (u.includes('/airsigmet')) return json(AIRSIGMET);
  if (u.includes('/isigmet')) return json(ISIGMET);
  if (u.includes('/gairmet')) return json(u.includes('turb-hi') ? [GAIRMET[0]] : [GAIRMET[1]]);
  if (u.includes('/airport')) {
    if (u.includes('KJFK')) return json([{ icaoId: 'KJFK', iataId: 'JFK', name: 'NEW YORK/JOHN F KENNEDY INTL ', lat: 40.6399, lon: -73.7787, elev: 4 }]);
    if (u.includes('KSFO')) return json([{ icaoId: 'KSFO', iataId: 'SFO', name: 'SAN FRANCISCO/SAN FRANCISCO INTL', lat: 37.619, lon: -122.375, elev: 4 }]);
    return json([]);
  }
  if (u.includes('api.open-meteo.com/v1/forecast')) {
    const lon = Number(new URL(u).searchParams.get('longitude'));
    return json({ timezone: lon < -100 ? 'America/Los_Angeles' : 'America/New_York', utc_offset_seconds: 0, hourly: { time: [] } });
  }
  if (u.includes('api.open-meteo.com/v1/gfs')) return json(fakeGfs(new URL(u).searchParams));
  if (u.includes('aeroapi.flightaware.com')) {
    faCalls.push(u);
    if (!opts.headers || opts.headers['x-apikey'] !== 'test-key') return { ok: false, status: 401, headers: new Map(), text: async () => '{}' };
    const iso = (ms) => new Date(ms).toISOString();
    if (/\/flights\/UAL123\?/.test(u)) return json({ flights: [
      { fa_flight_id: 'UAL123-old', ident_icao: 'UAL123', actual_off: iso(Date.now() - 30 * 3600e3), actual_on: iso(Date.now() - 25 * 3600e3), origin: { code_iata: 'JFK', code_icao: 'KJFK' }, destination: { code_iata: 'SFO', code_icao: 'KSFO' } },
      { fa_flight_id: 'UAL123-now', ident_icao: 'UAL123', aircraft_type: 'B38M', actual_off: iso(Date.now() - 2 * 3600e3), actual_on: null, estimated_on: iso(Date.now() + 3 * 3600e3), progress_percent: 40, filed_altitude: 350,
        origin: { code: 'KSFO', code_iata: 'SFO', code_icao: 'KSFO', city: 'San Francisco', name: 'San Francisco Intl', timezone: 'America/Los_Angeles' },
        destination: { code: 'KJFK', code_iata: 'JFK', code_icao: 'KJFK', city: 'New York', name: 'John F Kennedy Intl', timezone: 'America/New_York' } }] });
    if (u.endsWith('/flights/UAL123-now/route')) return json({ route_distance: '2600 mi', fixes: [
      { name: 'KSFO', latitude: 37.619, longitude: -122.375 }, { name: 'WPT1', latitude: 39.5, longitude: -112 },
      { name: 'NOLL', latitude: null, longitude: null }, { name: 'WPT2', latitude: 40.1, longitude: -104.5 },
      { name: 'WPT3', latitude: 43.5, longitude: -92 }, { name: 'WPT4', latitude: 42, longitude: -80 }, { name: 'KJFK', latitude: 40.6399, longitude: -73.7787 }] });
    if (u.endsWith('/flights/UAL123-now/track')) return json({ positions: [
      { latitude: 37.7, longitude: -122.2, altitude: 20, timestamp: iso(Date.now() - 115 * 60000) },
      { latitude: 39.4, longitude: -112.3, altitude: 350, timestamp: iso(Date.now() - 60 * 60000) },
      { latitude: 39.9, longitude: -105.5, altitude: 350, timestamp: iso(Date.now() - 10 * 60000) }] });
    return { ok: false, status: 404, headers: new Map(), text: async () => '{}' };
  }
  if (u.includes('/api/0/routeset')) {
    return json([{ callsign: 'UAL123', plausible: true, _airport_codes_iata: 'SFO-JFK', _airports: [
      { iata: 'SFO', icao: 'KSFO', location: 'San Francisco', lat: 37.619, lon: -122.375, alt_feet: 13 },
      { iata: 'JFK', icao: 'KJFK', location: 'New York', lat: 40.6399, lon: -73.7787, alt_feet: 13 }] }]);
  }
  if (/api\.adsb\.lol|airplanes\.live|adsb\.fi/.test(u)) {
    adsbCalls.push(u);
    if (adsb.down) throw new TypeError('fetch failed');
    const hit = /\/callsign\/UAL123$/.test(u) || /\/hex\/a1b2c3$/.test(u);
    return json({ ac: hit ? [ADSB_UAL123] : [], msg: 'No error', now: Date.now(), total: hit ? 1 : 0 });
  }
  if (u.includes('opensky-network.org/api/states/all')) { openskyCalls.push(u); return json({ time: 1, states: [OTHER, STATE] }, { 'x-rate-limit-remaining': '390' }); }
  if (u.includes('opensky-network.org/api/tracks/all')) return json({ icao24: 'a1b2c3', path: [[1, 39.8, -106, 9000, 90, false], [2, 40.0, -104.0, 10668, 90, false]] });
  return { ok: false, status: 404, headers: new Map(), text: async () => '' };
};
}


module.exports = { faCalls, adsb, adsbCalls, now, PIREPS, AIRSIGMET, ISIGMET, GAIRMET, STATE, openskyCalls, gfsCalls, installMockFetch };
