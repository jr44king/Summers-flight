// Offline tests: run with `node test/test.js`. Uses fake data shaped like the real feeds.
'use strict';
const assert = require('assert');
process.env.FLIGHTAWARE_API_KEY = 'test-key';
const { faCalls, adsb, adsbCalls, now, PIREPS, AIRSIGMET, ISIGMET, GAIRMET, openskyCalls, gfsCalls, installMockFetch } = require('./fixtures');
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
  assert.ok(rough.phases.find((p) => p.key === 'cruise').why.includes('jet-stream'));
  await assert.rejects(forecastTrip({ origin: SFO, dest: JFK, departUtc: now, getWeather: async () => { throw new Error('down'); }, now }), /weather forecast/);
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
    assert.ok(fc.segments.some((s) => s.reasons.some((x) => /jet-stream/.test(x))), 'jet reason');
    assert.ok(fc.segments.some((s) => s.reasons.some((x) => /Gusty winds at JFK/.test(x))), 'landing gusts');
    assert.deepStrictEqual(fc.phases.map((p) => p.key), ['climb', 'cruise', 'descent']);
    assert.strictEqual(fc.confidence.label, 'Good');
    const gfsBefore = gfsCalls.length;
    await get(`/api/forecast?from=SFO&to=JFK&depart=${day}T08:30`);
    assert.strictEqual(gfsCalls.length, gfsBefore, 'weather cached');

    assert.strictEqual((await get('/api/forecast?from=SFO&to=SFO&depart=now')).status, 400);
    assert.strictEqual((await get('/api/forecast?from=SFO&to=JFK&depart=2020-01-01T08:00')).status, 400);
    assert.strictEqual((await get('/api/forecast?from=SFO&to=JFK&depart=2099-01-01T08:00')).status, 400);
    assert.strictEqual((await get('/api/forecast?from=QQQ&to=JFK&depart=now')).status, 404);

    // Leaving now: live pilot reports and the current G-AIRMET count too.
    fc = JSON.parse((await get('/api/forecast?from=SFO&to=JFK&depart=now')).body);
    assert.strictEqual(fc.confidence.label, 'High');

    // Live flight already in the air over Colorado.
    r = await get('/api/forecast?lat=40&lon=-104&alt=35000&gs=450&track=90&vs=0&to=JFK');
    fc = JSON.parse(r.body);
    assert.strictEqual(r.status, 200, r.body);
    assert.ok(fc.live && fc.dest.id === 'KJFK');
    assert.ok(fc.points[0].altFt === 35000 && fc.durationMin < 260);
    assert.ok(fc.points.some((p) => /pilot|Official/.test(p.why || '')), 'near-term reports used');
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
    console.log('All tests passed ✔');
  } catch (e) {
    console.error(e); process.exitCode = 1;
  } finally {
    server.close();
  }
});
