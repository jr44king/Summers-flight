// Offline tests: run with `node test/test.js`. Uses fake data shaped like the real feeds.
'use strict';
const assert = require('assert');
process.env.FLIGHTAWARE_API_KEY = 'test-key';
process.env.METEO_FAST_RETRY = '1';
const { meteo, faCalls, adsb, adsbCalls, now, PIREPS, AIRSIGMET, ISIGMET, GAIRMET, openskyCalls, gfsCalls, installMockFetch } = require('./fixtures');
installMockFetch();

const { normalizeTurbulence, parseIntensity } = require('../lib/normalize');
const geo = require('../lib/geo');
const { buildProfile, forecastTrip } = require('../lib/plan');
const { localToUtc, offsetMinutes } = require('../lib/time');
// ----- intensity parsing -----
assert.strictEqual(parseIntensity('MOD'), 2);
assert.strictEqual(parseIntensity('LGT-MOD'), 1.5);
assert.strictEqual(parseIntensity('SMTH-LGT'), 0.5);
assert.strictEqual(parseIntensity('NEG'), 0);
assert.strictEqual(parseIntensity('SEV-EXTM'), 3.5);
assert.strictEqual(parseIntensity(''), null);

// ----- normalisation -----
const turb = normalizeTurbulence({ pireps: PIREPS, airsigmet: AIRSIGMET, isigmet: ISIGMET, gairmet: GAIRMET });
assert.strictEqual(turb.pireps.length, 3, 'report without turbulence info is dropped');
const smooth = turb.pireps.find((p) => p.ac === 'B744');
assert.strictEqual(smooth.intensity, 0, 'raw-text /TB SMOOTH parsed');
assert.strictEqual(smooth.altFt, 10500);
assert.strictEqual(turb.areas.length, 4, 'convective SIGMET + intl SIGMET + 2 G-AIRMETs');
const g = turb.areas.find((a) => a.kind === 'G-AIRMET' && a.baseFt === 30000);
assert.strictEqual(g.topFt, 42000);
assert.strictEqual(turb.areas.find((a) => a.forecastHour === 3).baseFt, 0, 'SFC base');
assert.strictEqual(turb.areas.find((a) => a.region === 'OAKLAND OCEANIC').severity, 3);

// ----- geometry -----
assert.ok(geo.inPolygon([40, -100], g.poly));
assert.ok(!geo.inPolygon([45, -100], g.poly));
const dateline = [[10, 170], [10, -170], [20, -170], [20, 170]];
assert.ok(geo.inPolygon([15, 179], dateline) && geo.inPolygon([15, -179], dateline) && !geo.inPolygon([15, 160], dateline));
assert.ok(Math.abs(geo.distanceNm([40.6399, -73.7787], [33.9416, -118.4085]) - 2145) < 15, 'JFK–LAX ≈ 2,145 nm');

// ----- places & aircraft names -----
const { describePlace, aircraftName } = require('../lib/places');
assert.strictEqual(describePlace(39.75, -104.99), 'Near Denver');
assert.match(describePlace(40.3, -104.2), /^\d+ mi NE of Denver$/);
assert.strictEqual(describePlace(35, -140), 'Over the Pacific');
assert.strictEqual(aircraftName('B738'), 'Boeing 737-800');
assert.strictEqual(aircraftName('B38M'), 'Boeing 737 MAX 8');
assert.strictEqual(aircraftName('B732'), 'Boeing 737', 'family fallback');
assert.strictEqual(require('../lib/places').airlineName('DAL437'), 'Delta Air Lines');
assert.strictEqual(aircraftName('A21N'), 'Airbus A321neo');
assert.strictEqual(aircraftName('CRJ9'), 'Bombardier CRJ-900');
assert.strictEqual(aircraftName('UAL747'), 'Flight UAL747');

// ----- time zones (daylight saving handled) -----
assert.strictEqual(new Date(localToUtc('2026-10-24T08:30', 'America/Los_Angeles')).toISOString(), '2026-10-24T15:30:00.000Z');
assert.strictEqual(new Date(localToUtc('2026-11-05T08:30', 'America/Los_Angeles')).toISOString(), '2026-11-05T16:30:00.000Z', 'after DST ends');
assert.strictEqual(offsetMinutes('Asia/Kolkata', Date.UTC(2026, 0, 1)), 330);

// ----- flight profile -----
const SFO = { lat: 37.619, lon: -122.375, elevFt: 13 }, JFK = { lat: 40.6399, lon: -73.7787, elevFt: 13 };
const prof = buildProfile({ origin: SFO, dest: JFK });
assert.ok(prof.durationMin > 280 && prof.durationMin < 340, 'SFO–JFK about 5 h: ' + prof.durationMin);
assert.strictEqual(Math.max(...prof.points.map((p) => p.altFt)), 37000);
assert.deepStrictEqual([...new Set(prof.points.map((p) => p.phase))], ['climb', 'cruise', 'descent']);
assert.ok(prof.points.at(-1).altFt < 100, 'lands');
const short = buildProfile({ origin: SFO, dest: { lat: 33.94, lon: -118.41, elevFt: 125 } });
assert.ok(short.durationMin > 40 && short.durationMin < 70 && Math.max(...short.points.map((p) => p.altFt)) <= 29000);
const desc = buildProfile({ origin: { lat: 40, lon: -76 }, dest: JFK, live: { altFt: 9000, gsKt: 280, track: 90, vsFpm: -1500 } });
assert.ok(!desc.points.some((p, i) => i > 0 && p.altFt > desc.points[i - 1].altFt), 'a descending plane never climbs');

// ----- scoring with fake weather -----
(async () => {
  const fake = (shearKt) => async (pts) => pts.map(() => () => ({
    levels: [[850, 20, 1500], [700, 30, 3000], [500, 50, 5600], [400, 60, 7200], [300, 60, 9200], [250, 60 + shearKt, 10400], [200, 60, 11800]].map(([p, spd, z]) => ({ p, spd, dir: 270, zFt: z * 3.28084 })),
    cape: 0, li: 3, code: 1, gustKt: 5,
  }));
  const calm = await forecastTrip({ origin: SFO, dest: JFK, departUtc: now + 2 * 86400000, getWeather: fake(5), now });
  assert.strictEqual(calm.rating.score, 1, 'calm air → Smooth');
  assert.strictEqual(calm.segments.length, 0);
  const rough = await forecastTrip({ origin: SFO, dest: JFK, departUtc: now + 2 * 86400000, getWeather: fake(40), now });
  assert.ok(rough.rating.score >= 4, 'strong shear everywhere → Bumpy: ' + rough.rating.score);
  assert.ok(rough.phases.find((p) => p.key === 'cruise').why.toLowerCase().includes('jet-stream'));
  // Mountain waves: strong mid-level wind over high ground.
  const mtn = await forecastTrip({ origin: SFO, dest: JFK, departUtc: now + 2 * 86400000, now, getWeather: async (pts) => pts.map((p) => () => ({
    levels: [[700, 70, 3000], [500, 75, 5600], [300, 60, 9200], [250, 62, 10400], [200, 60, 11800]].map(([pp, spd, z]) => ({ p: pp, spd, dir: 270, zFt: z * 3.28084 })),
    cape: 0, li: 3, code: 1, gustKt: 5, groundFt: p.lon > -112 && p.lon < -104 ? 7500 : 300 })) });
  const mw = mtn.segments.find((x) => x.reasons.some((r) => /Mountain waves/.test(r)));
  assert.ok(mw, 'mountain waves detected');
  assert.ok(/7,000 ft|8,000 ft/.test(mw.details.find((d) => /Mountain/.test(d.title)).detail), 'detail mentions the terrain height');
  const jetSeg = (await forecastTrip({ origin: SFO, dest: JFK, departUtc: now + 2 * 86400000, getWeather: fake(40), now })).segments[0];
  assert.ok(/jet stream/.test(jetSeg.details[0].detail) && /mph/.test(jetSeg.details[0].detail), 'jet detail has real numbers');
  // Calibration: typical quiet air (~4 kt/1,000 ft) is smooth; ~8 is moderate.
  const cal = (shear) => forecastTrip({ origin: SFO, dest: JFK, departUtc: now + 86400000, now, getWeather: fake(shear * 3.937) });
  assert.strictEqual((await cal(4.2)).rating.score, 1, 'quiet air → smooth');
  assert.ok((await cal(8.2)).rating.score >= 3, 'strong shear → bumps');
  // A single spiky forecast point gets trimmed; two in a row are kept.
  const spiky = (n) => async (pts) => pts.map((p, i) => () => ({
    levels: [[700, 30, 3000], [500, 50, 5600], [300, 60, 9200], [250, (i >= 15 && i < 15 + n) ? 100 : 62, 10400], [200, 60, 11800]].map(([pp, spd, z]) => ({ p: pp, spd, dir: 270, zFt: z * 3.28084 })),
    cape: 0, li: 3, code: 1, gustKt: 5 }));
  assert.strictEqual((await forecastTrip({ origin: SFO, dest: JFK, departUtc: now + 86400000, now, getWeather: spiky(1) })).segments.length, 0, 'lone spike ignored');
  assert.strictEqual((await forecastTrip({ origin: SFO, dest: JFK, departUtc: now + 86400000, now, getWeather: spiky(3) })).segments.length, 1, 'real patch kept');
  await assert.rejects(forecastTrip({ origin: SFO, dest: JFK, departUtc: now, getWeather: async () => { throw new Error('down'); }, now }), /weather forecast/);
  { // official forecast: model bumps outside its areas are toned down; inside, model + forecast agree on moderate
    const jetty = () => ({ levels: [{ p: 300, spd: 40, dir: 270, zFt: 30000 }, { p: 250, spd: 110, dir: 270, zFt: 34000 }, { p: 200, spd: 60, dir: 270, zFt: 38500 }], cape: 0, li: 5, code: 0, gustKt: 5, groundFt: 0 });
    const box = { kind: 'G-AIRMET', severity: 2, baseFt: 30000, topFt: 42000, from: now - 3600e3, to: now + 13 * 3600e3, poly: [[38, -102], [42, -102], [42, -96], [38, -96]] };
    const official = { from: now - 3600e3, to: now + 13 * 3600e3, areas: [box] };
    const r = await forecastTrip({ origin: SFO, dest: JFK, departUtc: now + 3600e3, now, turb: { pireps: [], areas: [], official }, getWeather: async (pts) => pts.map(() => jetty) });
    const cruise = r.points.filter((p) => p.altFt >= 34000);
    const inside = cruise.filter((p) => p.lat > 38 && p.lat < 42 && p.lon > -102 && p.lon < -96);
    const outside = cruise.filter((p) => !(p.lat > 37 && p.lat < 43 && p.lon > -103 && p.lon < -95));
    assert.ok(inside.length && inside.every((p) => p.score >= 2 && p.score < 2.25), 'inside official area: moderate');
    assert.ok(outside.length && outside.every((p) => p.score <= 1.4), 'outside official area: light at most');
    // smooth pilot reports nearby pull a bumpy model forecast down
    const spot = inside[Math.floor(inside.length / 2)];
    const smooth = Array.from({ length: 4 }, (_, k) => ({ lat: spot.lat + k * 0.1, lon: spot.lon, altFt: spot.altFt, intensity: 0, time: now - 10 * 60000 }));
    const r2 = await forecastTrip({ origin: SFO, dest: JFK, departUtc: now + 3600e3, now, turb: { pireps: smooth, areas: [], official }, getWeather: async (pts) => pts.map(() => jetty) });
    const near = r2.points.filter((p) => p.t === spot.t);
    assert.ok(near.length && near.every((p) => p.score < 1.5), 'smooth reports tone it down: ' + near.map((p) => p.score));
  }
  { // a huge jet-stream wind change in the model alone is shown as Moderate at most, never Strong or Severe
    const wild = () => ({ levels: [{ p: 400, spd: 40, dir: 270, zFt: 24000 }, { p: 300, spd: 60, dir: 270, zFt: 30000 }, { p: 250, spd: 170, dir: 270, zFt: 34000 }, { p: 200, spd: 60, dir: 270, zFt: 38500 }], cape: 0, li: 5, code: 0, gustKt: 10, groundFt: 0 });
    const r = await forecastTrip({ origin: SFO, dest: JFK, departUtc: now + 86400000, now, getWeather: async (pts) => pts.map(() => wild) });
    assert.ok(r.segments.length && r.segments.every((g) => !['strong', 'severe'].includes(g.key)), 'forecast alone capped at moderate: ' + r.segments.map((g) => g.key));
    assert.ok(r.segments.some((g) => g.key === 'moderate'), 'still shows moderate');
  }
})().catch((e) => { console.error(e); process.exit(1); });

// ----- server end-to-end with faked upstreams -----
const { server } = require('../server');
server.listen(0, async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const realFetch = require('http');
  const get = (p) => new Promise((res, rej) => realFetch.get(base + p, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b, type: r.headers['content-type'] })); }).on('error', rej));
  try {
    const page = await get('/');
    assert.strictEqual(page.status, 200); assert.ok(page.body.includes('Check my flight'));
    assert.strictEqual((await get('/app.js')).status, 200);
    assert.strictEqual((await get('/manifest.json')).status, 200);
    assert.strictEqual((await get('/../server.js')).status, 404);

    const t = JSON.parse((await get('/api/turbulence')).body);
    assert.strictEqual(t.pireps.length, 3); assert.strictEqual(t.areas.length, 4); assert.deepStrictEqual(t.warnings, []);

    // Live flight via the free ADS-B network (adsb.lol), UA123 → UAL123.
    let r = await get('/api/flight?q=UA123');
    let f = JSON.parse(r.body);
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(f.flight.callsign, 'UAL123', 'IATA UA123 → ICAO UAL123');
    assert.strictEqual(f.flight.altFt, 35000); assert.strictEqual(f.flight.gsKt, 450); assert.strictEqual(f.flight.icao24, 'a1b2c3');
    assert.ok(adsbCalls[0].startsWith('https://api.adsb.lol/v2/'), 'adsb.lol first');
    assert.strictEqual(f.flight.aircraft, 'Boeing 737-800'); assert.strictEqual(f.flight.airline, 'United Airlines');
    assert.strictEqual(f.route.origin.iata, 'SFO'); assert.strictEqual(f.route.dest.iata, 'JFK'); assert.ok(f.route.plausible);
    assert.ok(f.trailIsComplete, 'real FlightAware track used');
    assert.deepStrictEqual(f.trail[0], [37.7, -122.2]); assert.deepStrictEqual(f.trail.at(-1), [40, -104]);
    assert.ok(f.plan && f.plan.length === 6, 'filed route, bad fix dropped'); assert.strictEqual(f.pathSource, 'flightaware');
    assert.strictEqual(f.route.origin.iata, 'SFO'); assert.strictEqual(f.route.dest.name, 'New York');
    const faAfterFirst = faCalls.length;
    assert.strictEqual(faAfterFirst, 3, 'one flight + one route + one track lookup');
    assert.strictEqual(openskyCalls.length, 0, 'OpenSky not needed');
    const nAdsb = adsbCalls.length;
    await get('/api/flight?q=UA123');
    assert.strictEqual(adsbCalls.length, nAdsb, 'cached within refresh window');

    // All ADS-B networks unreachable → falls back to OpenSky.
    adsb.down = true;
    r = await get('/api/flight?q=UAL123');
    f = JSON.parse(r.body);
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(f.flight.callsign, 'UAL123');
    assert.strictEqual(openskyCalls.length, 1, 'OpenSky fallback used');
    adsb.down = false;

    r = await get('/api/flight?q=ZZZ999');
    assert.strictEqual(r.status, 404);
    assert.strictEqual((await get('/api/flight?q=')).status, 400);

    const a = JSON.parse((await get('/api/airport?id=JFK')).body);
    assert.strictEqual(a.id, 'KJFK', '3-letter code resolved via K prefix');
    assert.strictEqual((await get('/api/airport?id=QQQ')).status, 404);

    // ----- trip forecast endpoint -----
    const tomorrow = new Date(now + 86400000);
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(tomorrow);
    r = await get(`/api/forecast?from=SFO&to=JFK&depart=${day}T08:30`);
    assert.strictEqual(r.status, 200, r.body);
    let fc = JSON.parse(r.body);
    assert.strictEqual(fc.origin.tz, 'America/Los_Angeles'); assert.strictEqual(fc.dest.tz, 'America/New_York');
    assert.strictEqual(fc.departUtc, localToUtc(`${day}T08:30`, 'America/Los_Angeles'));
    assert.ok(fc.points.length <= 45 && fc.points.length > 20);
    assert.ok(fc.rating.score >= 3, 'jet stream in the fake data makes it bumpy: ' + fc.rating.score);
    assert.ok(fc.segments.some((s) => s.reasons.some((x) => /jet-stream/i.test(x))), 'jet reason');
    assert.ok(fc.segments.some((s) => s.reasons.some((x) => /Gusty winds at JFK/.test(x))), 'landing gusts');
    assert.deepStrictEqual(fc.phases.map((p) => p.key), ['climb', 'cruise', 'descent']);
    { const h = (fc.departUtc - Date.now()) / 3600000; assert.strictEqual(fc.confidence.label, h <= 3 ? 'Very high' : h <= 12 ? 'High' : h <= 36 ? 'Good' : 'Fair', 'accuracy matches hours ahead'); }
    const gfsBefore = gfsCalls.length;
    await get(`/api/forecast?from=SFO&to=JFK&depart=${day}T08:30`);
    assert.strictEqual(gfsCalls.length, gfsBefore, 'weather cached');

    assert.strictEqual((await get('/api/forecast?from=SFO&to=SFO&depart=now')).status, 400);
    assert.strictEqual((await get('/api/forecast?from=SFO&to=JFK&depart=2020-01-01T08:00')).status, 400);
    assert.strictEqual((await get('/api/forecast?from=SFO&to=JFK&depart=2099-01-01T08:00')).status, 400);
    assert.strictEqual((await get('/api/forecast?from=QQQ&to=JFK&depart=now')).status, 404);

    // Leaving now: live pilot reports and the current G-AIRMET count too.
    fc = JSON.parse((await get('/api/forecast?from=SFO&to=JFK&depart=now')).body);
    assert.strictEqual(fc.confidence.label, 'Very high'); assert.strictEqual(fc.confidence.score, 5);

    // Live flight already in the air over Colorado.
    r = await get('/api/forecast?lat=40&lon=-104&alt=35000&gs=450&track=90&vs=0&to=JFK');
    fc = JSON.parse(r.body);
    assert.strictEqual(r.status, 200, r.body);
    assert.ok(fc.live && fc.dest.id === 'KJFK');
    assert.ok(fc.points[0].altFt === 35000 && fc.durationMin < 260);
    assert.ok(fc.segments.some((g) => g.reasons.some((x) => /pilot|Official/i.test(x))), 'near-term reports used');
    // With the flight's callsign, the forecast follows the filed route (bends north over the Great Lakes).
    r = await get('/api/forecast?lat=40&lon=-104&alt=35000&gs=450&track=90&vs=0&to=JFK&q=UAL123');
    fc = JSON.parse(r.body);
    assert.strictEqual(r.status, 200, r.body);
    assert.ok(fc.followsFiledRoute, 'uses filed route');
    assert.ok(Math.max(...fc.line.map((p) => p[0])) > 43, 'line passes the northern waypoint');
    assert.ok(faCalls.length === faAfterFirst, 'no extra paid lookups (cached)');
    const { remainingPath } = require('../lib/flightaware');
    assert.strictEqual(remainingPath([[0, 0], [0, 10]], [30, 5]), null, 'far off the filed route → fall back');
    r = JSON.parse((await get('/api/forecast?lat=40&lon=-104&alt=35000&gs=450&track=90')).body);
    assert.strictEqual(r.durationMin, 120);
    // ----- live pilot-report feed -----
    const fd = JSON.parse((await get('/api/pireps')).body);
    assert.strictEqual(fd.reports.length, 3);
    assert.ok(fd.reports[0].time >= fd.reports[1].time && fd.reports[1].time >= fd.reports[2].time, 'newest first');
    assert.ok(fd.reports.every((r) => r.place && r.id));
    assert.strictEqual(fd.reports.find((r) => r.intensity === 2).aircraft, 'Boeing 737-800');
    assert.strictEqual(fd.refreshSec, 60);
    // ----- worldwide airports (built-in list) -----
    const lhr = JSON.parse((await get('/api/airport?id=LHR')).body);
    assert.strictEqual(lhr.id, 'EGLL'); assert.strictEqual(lhr.name, 'London'); assert.ok(Math.abs(lhr.lat - 51.47) < 0.05);
    assert.strictEqual(JSON.parse((await get('/api/airport?id=RJAA')).body).iata, 'NRT', 'ICAO codes work too');
    r = await get(`/api/forecast?from=LHR&to=JFK&depart=${day}T11:00`);
    assert.strictEqual(r.status, 200, r.body);
    assert.ok(JSON.parse(r.body).distanceMi > 3400, 'London → New York');

    // ----- flight number before takeoff (FlightAware) -----
    r = await get('/api/upcoming?q=DL173');
    let up = JSON.parse(r.body);
    assert.strictEqual(r.status, 200, r.body);
    assert.strictEqual(up.upcoming.ident, 'DAL173'); assert.strictEqual(up.upcoming.aircraft, 'Airbus A350-900'); assert.strictEqual(up.upcoming.airline, 'Delta Air Lines');
    assert.ok(Math.abs(up.departUtc - (Date.now() + 50 * 60000)) < 120000, 'forecast starts at the scheduled takeoff');
    assert.strictEqual(up.cruiseFt, 37000, 'filed cruise altitude used');
    assert.strictEqual(up.upcoming.filedRoute, false); assert.strictEqual(up.origin.iata, 'SFO'); assert.strictEqual(up.dest.iata, 'JFK');
    assert.ok(!up.radar, 'radar grid is no longer sent with every forecast');
    const radarQ = (o) => `/api/radar?path=${o.line.filter((_, i) => i % 6 === 0).concat([o.line[o.line.length - 1]]).map((q) => q[0].toFixed(2) + ',' + q[1].toFixed(2)).join(';')}&from=${o.departUtc}&to=${o.arriveUtc}`;
    r = await get(radarQ(up));
    assert.strictEqual(r.status, 200, r.body);
    const rd = JSON.parse(r.body);
    assert.ok(rd.cells.length % 5 === 0 && rd.cells.length <= 100, 'future rain grid');
    assert.ok(rd.times.length >= 6 && rd.rain.some((row) => row.some((v) => v > 0)), 'some forecast rain');
    assert.strictEqual((await get('/api/radar?path=1,2&from=0&to=1')).status, 400);
    up = JSON.parse((await get('/api/upcoming?q=UA123')).body);
    assert.ok(up.airborne, 'already flying → tell the page to track it live');
    assert.strictEqual((await get('/api/upcoming?q=ZZ999')).status, 404);
    // ----- weather service busy (429) -----
    meteo.busy = 1; // busy once → waits and tries again, and the forecast still works
    r = await get(`/api/forecast?from=LAX&to=ORD&depart=${day}T09:00`);
    assert.strictEqual(r.status, 200, 'retried after busy: ' + r.body);
    meteo.busy = 99; // busy for a long time, new route → friendly message, not a crash
    r = await get(`/api/forecast?from=SEA&to=MIA&depart=${day}T10:00`);
    assert.strictEqual(r.status, 503, r.body);
    assert.match(JSON.parse(r.body).error, /busy right now/);
    // …but a route we've seen recently still answers from the weather we already have
    r = await get(`/api/forecast?from=SFO&to=JFK&depart=${day}T08:30`);
    assert.strictEqual(r.status, 200, 'served from cache while busy: ' + r.body);
    meteo.busy = 0;
    console.log('All tests passed ✔');
  } catch (e) {
    console.error(e); process.exitCode = 1;
  } finally {
    server.close();
  }
});
