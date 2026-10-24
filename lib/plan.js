// Builds a ride forecast for a trip: where the plane will be minute by minute,
// how bumpy each stretch is likely to be, and a plain-English summary.
//
// Intensity scale used everywhere: 0 smooth · 1 light · 2 moderate · 3 severe · 4 extreme
'use strict';
const { distanceNm, destinationPoint, interpolate, inPolygon } = require('./geo');
const { aircraftName } = require('./places');

// ---------- levels & wording ----------
const LEVELS = [
  { max: 0.75, key: 'smooth', name: 'Smooth', color: '#34c759' },
  { max: 1.5, key: 'light', name: 'Light bumps', color: '#c7cf2f' },
  { max: 2.25, key: 'moderate', name: 'Moderate bumps', color: '#ff9500' },
  { max: 3, key: 'strong', name: 'Strong bumps', color: '#ff3b30' },
  { max: Infinity, key: 'severe', name: 'Severe turbulence', color: '#af52de' },
];
const level = (s) => (s == null ? LEVELS[0] : LEVELS.find((l) => s < l.max));

const lerp = (pts, x) => {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (x <= pts[i][0]) { const [x0, y0] = pts[i - 1], [x1, y1] = pts[i]; return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0); }
  }
  return pts[pts.length - 1][1];
};

// Vertical wind shear (knots per 1,000 ft) → expected bumpiness.
// Strong shear near the jet stream is the main cause of clear-air turbulence.
const SHEAR_TO_INT = [[2.5, 0], [4, 1], [5.5, 1.5], [7, 2], [9, 2.5], [11, 3]];
// Surface wind gusts (knots) → bumpiness on takeoff and landing.
const GUST_TO_INT = [[18, 0], [25, 1], [32, 1.6], [40, 2.2], [50, 2.8]];

const fmtFt = (ft) => `${Math.round(ft / 1000).toLocaleString('en-US')},000 ft`;
const mph = (kt) => Math.round((kt * 1.15078) / 5) * 5;

// ---------- the flight path ----------
function cruiseAltitude(distNm) {
  if (distNm < 200) return 22000;
  if (distNm < 400) return 29000;
  if (distNm < 900) return 34000;
  return 37000;
}

// Minute-by-minute simulation: climb, cruise, then a standard 3-to-1 descent.
// origin/dest: {lat, lon, elevFt}; live: {altFt, gsKt, track, vsFpm} when already airborne.
// Position a given distance along a multi-point path (great-circle between waypoints).
function pathWalker(path) {
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + distanceNm(path[i - 1], path[i]));
  const total = cum[cum.length - 1];
  return {
    total,
    at(d) {
      if (d <= 0) return path[0].slice();
      if (d >= total) return path[path.length - 1].slice();
      let i = 1;
      while (i < cum.length - 1 && cum[i] < d) i++;
      const seg = cum[i] - cum[i - 1];
      return interpolate(path[i - 1], path[i], seg ? (d - cum[i - 1]) / seg : 1);
    },
  };
}

// path (optional): [[lat, lon], ...] from the start to the destination, e.g. the filed flight plan.
function buildProfile({ origin, dest, live, path, cruiseFt }) {
  const start = [origin.lat, origin.lon];
  const pts = [];
  if (!dest) {
    // Live flight with no destination: carry on at current heading and speed for 2 hours.
    const gs = Math.max(live.gsKt || 0, 150);
    for (let t = 0; t <= 120; t++) {
      const p = destinationPoint(start, live.track || 0, (gs * t) / 60);
      pts.push({ t, lat: p[0], lon: p[1], altFt: live.altFt || 0, phase: 'cruise', distLeft: null });
    }
    return { points: pts, distanceNm: null, cruiseFt: live.altFt, durationMin: 120 };
  }
  const end = [dest.lat, dest.lon];
  const usePath = Array.isArray(path) && path.length >= 2;
  const walker = pathWalker(usePath ? [start, ...path.slice(1, -1), end] : [start, end]);
  const total = walker.total;
  const destElev = dest.elevFt || 0;
  let cruise = cruiseFt && cruiseFt > 10000 ? cruiseFt : cruiseAltitude(total);
  let alt = origin.elevFt || 0;
  if (live) {
    alt = live.altFt || 0;
    // Still climbing: assume a normal cruise height. Level or descending: stay at the current height.
    cruise = (live.vsFpm || 0) > 500 ? Math.max(cruise, alt) : alt;
  }
  const cruiseGs = live && live.gsKt > 300 && alt > 18000 ? live.gsKt : 460;
  let flown = 0;
  let topOfClimb = null, topOfDescent = null;
  for (let t = 0; t < 20 * 60; t++) {
    const left = Math.max(0, total - flown);
    const p = walker.at(flown);
    const descentAlt = destElev + (left / 3) * 1000; // 3 nm per 1,000 ft
    let phase;
    // On the descent path once it meets the current altitude (below cruise height).
    if (topOfDescent != null || (descentAlt <= alt + 100 && descentAlt < cruise - 100 && t > 0)) phase = 'descent';
    else if (alt < cruise - 300) phase = 'climb';
    else phase = 'cruise';
    if (phase === 'cruise' && topOfClimb == null) topOfClimb = t;
    if (phase === 'descent' && topOfDescent == null) { topOfDescent = t; if (topOfClimb == null) topOfClimb = t; }
    pts.push({ t, lat: p[0], lon: p[1], altFt: Math.round(alt), phase, distLeft: left });
    if (left <= 0.5) break;
    // Speed rises with altitude; slower near the ground.
    const frac = Math.min(1, Math.max(0, alt / Math.max(cruise, 1)));
    const gs = phase === 'cruise' ? cruiseGs : 230 + frac * (cruiseGs - 230);
    flown = Math.min(total, flown + gs / 60);
    const nextLeft = Math.max(0, total - flown);
    if (phase === 'climb') alt = Math.min(cruise, alt + (alt < 10000 ? 2500 : alt < 25000 ? 2000 : 1300));
    alt = Math.min(alt, destElev + (nextLeft / 3) * 1000);
    if (phase === 'descent' && nextLeft <= 0.5) alt = destElev;
  }
  const last = pts[pts.length - 1];
  return { points: pts, distanceNm: total, cruiseFt: cruise, durationMin: last.t, topOfClimb, topOfDescent, followsFiledRoute: usePath };
}

// Fewer, evenly spaced points for the weather lookup (max ~40).
function samplePoints(profile) {
  const dur = profile.durationMin;
  const step = Math.max(4, Math.ceil(dur / 38));
  const out = [];
  for (let t = 0; t < dur; t += step) out.push(profile.points[t]);
  out.push(profile.points[profile.points.length - 1]);
  return { step, points: out };
}

// ---------- scoring ----------
function shearAt(w, altFt) {
  // Largest wind shear in any layer that contains (or is within 3,000 ft of) the altitude.
  let best = null;
  const L = w.levels.slice().sort((a, b) => a.zFt - b.zFt);
  for (let i = 1; i < L.length; i++) {
    const lo = L[i - 1], hi = L[i];
    if (altFt < lo.zFt - 3000 || altFt > hi.zFt + 3000) continue;
    const u = (l) => [l.spd * Math.sin((l.dir * Math.PI) / 180), l.spd * Math.cos((l.dir * Math.PI) / 180)];
    const a = u(lo), b = u(hi);
    const dz = (hi.zFt - lo.zFt) / 1000;
    if (dz <= 0.5) continue;
    const s = Math.hypot(b[0] - a[0], b[1] - a[1]) / dz;
    const jet = Math.max(lo.spd, hi.spd);
    if (!best || s > best.shear) best = { shear: s, jet, lo, hi };
  }
  return best;
}

function modelScore(pt, w, ctx) {
  const reasons = [];
  let score = 0;
  if (!w) return { score: null, reasons };
  const aglFt = pt.altFt - (pt.phase === 'descent' ? ctx.destElev : ctx.originElev);

  // 1. Clear-air turbulence from wind shear (jet stream).
  if (pt.altFt > 8000) {
    const sh = shearAt(w, pt.altFt);
    if (sh) {
      let s = lerp(SHEAR_TO_INT, sh.shear);
      if (sh.jet > 120 && s >= 1) s += 0.25;
      if (s > score) score = s;
      if (s >= 0.75) {
        const perK = mph(sh.shear) || Math.round(sh.shear * 1.15);
        const detail = sh.jet > 90
          ? `The jet stream — a fast river of wind high up — is blowing about ${mph(sh.jet)} mph here, and its speed changes from about ${mph(sh.lo.spd)} mph at ${fmtFt(sh.lo.zFt)} to ${mph(sh.hi.spd)} mph at ${fmtFt(sh.hi.zFt)}. Layers of air sliding past each other at different speeds churn the air, like rapids in a river. This is called clear-air turbulence, and it's the most common kind at cruising height.`
          : `The wind changes by about ${perK} mph for every 1,000 ft of height here. Layers of air moving at different speeds rub against each other and create ripples, which the plane feels as bumps.`;
        reasons.push({ kind: 'jet', text: sh.jet > 90 ? 'Fast jet-stream winds changing sharply with height' : 'Winds changing sharply with height', detail, s });
      }
    }
  }

  // 2. Thunderstorms and unstable air.
  const storm = w.code != null && w.code >= 95;
  const unstable = (w.cape || 0) >= 1000 && (w.li == null || w.li <= -2);
  if (storm) {
    const s = pt.altFt < 25000 ? 2.6 : 2.0;
    if (s > score) score = s;
    reasons.push({ kind: 'storm', text: pt.altFt < 25000 ? 'Thunderstorms forecast nearby' : 'Thunderstorms below — pilots usually steer around them', detail: 'Thunderstorms are forecast along this part of the route. Storms have powerful up- and down-drafts, so the air in and around them is rough. Pilots fly around storm cells, sometimes adding a few minutes to the flight, but the air near them can still be bumpy.', s });
  } else if (unstable) {
    const s = pt.altFt < 25000 ? 1.6 : 1.1;
    if (s > score) score = s;
    reasons.push({ kind: 'storm', text: 'Unstable air — showers or storms could build', detail: 'Warm, moist air near the ground is rising here. Rising air builds puffy clouds and can turn into showers or storms, and it makes the air bumpy — mostly at lower altitudes, on the way up or down.', s });
  }

  // 3. Gusty, choppy air close to the ground.
  if (aglFt < 6000 && ctx.edge) {
    const gust = ctx.edge === 'origin' ? ctx.originGust : ctx.destGust;
    if (gust != null) {
      const s = lerp(GUST_TO_INT, gust);
      if (s > score) score = s;
      if (s >= 0.75) reasons.push({ kind: 'gust', text: `Gusty winds at ${ctx.edge === 'origin' ? ctx.originName : ctx.destName} (gusts to ${Math.round(gust * 1.15078)} mph)`, detail: `Wind at ${ctx.edge === 'origin' ? ctx.originName : ctx.destName} is forecast to gust up to ${Math.round(gust * 1.15078)} mph around the time you ${ctx.edge === 'origin' ? 'take off' : 'land'}. Gusty wind near the ground makes the plane bounce and rock a little until it's higher up${ctx.edge === 'origin' ? '' : ' or on the runway'}.`, s });
    }
  }
  if (aglFt < 10000 && pt.altFt < 14000) {
    const low = w.levels.filter((l) => l.p >= 700);
    const strongest = low.reduce((m, l) => Math.max(m, l.spd), 0);
    const s = lerp([[35, 0], [45, 1], [60, 1.75], [75, 2.4]], strongest);
    if (s > score) score = s;
    if (s >= 0.75) reasons.push({ kind: 'wind', text: 'Strong winds at low altitude make the air choppy', detail: `Winds of about ${mph(strongest)} mph are blowing a few thousand feet up. Fast wind tumbling over hills, buildings and uneven ground gets choppy, which you feel on the way up or down.`, s });
  }
  // 4. Mountain waves: strong wind blowing across high terrain.
  if (w.groundFt != null && w.groundFt > 4000 && pt.altFt > w.groundFt + 3000) {
    const mid = w.levels.filter((l) => l.p === 700 || l.p === 500);
    const across = mid.reduce((m, l) => Math.max(m, l.spd), 0);
    const s = lerp([[40, 0], [50, 0.8], [65, 1.4], [85, 2]], across);
    if (s > score) score = s;
    if (s >= 0.75) reasons.push({ kind: 'mountain', text: 'Mountain waves from strong winds over high terrain', detail: `Winds of about ${mph(across)} mph are blowing across mountains (the ground below is about ${fmtFt(w.groundFt)} high). Air flowing over mountains ripples like water over rocks in a stream, and those waves can reach far above the peaks — a common source of bumps over the Rockies and other ranges.`, s });
  }
  return { score, reasons };
}

// Live data: recent pilot reports and official turbulence areas. Most useful for the next few hours.
function observedScore(pt, turb, now) {
  const reasons = [];
  if (!turb) return { score: null, reasons };
  let areaScore = null;
  for (const a of turb.areas || []) {
    if (a.from != null && pt.eta < a.from - 30 * 60000) continue;
    if (a.to != null && pt.eta > a.to) continue;
    const conv = /Convective/.test(a.kind);
    if (pt.altFt < a.baseFt - 1000 || pt.altFt > a.topFt + (conv ? 5000 : 1000)) continue;
    if (!inPolygon([pt.lat, pt.lon], a.poly)) continue;
    const s = conv ? Math.min(a.severity, pt.altFt > 25000 ? 2.2 : 3) : a.severity;
    if (areaScore == null || s > areaScore) areaScore = s;
    const band = `${a.baseFt <= 0 ? 'the ground' : fmtFt(a.baseFt)} and ${fmtFt(a.topFt)}`;
    const until = a.to ? ` for about the next ${Math.max(1, Math.round((a.to - now) / 3600000))} h` : '';
    const detail = conv
      ? `The National Weather Service has an active thunderstorm warning here${until}. Storm clouds can reach very high, so airlines route around them.`
      : a.kind === 'G-AIRMET'
        ? `Weather Service forecasters expect moderate turbulence in this area between ${band}${until}. Pilots and airline dispatchers see this before departure and plan for it.`
        : `The National Weather Service has warned of severe turbulence in this area between ${band}${until}. Airlines usually change altitude or route to avoid these areas.`;
    reasons.push({ kind: 'warning', text: conv ? 'Official thunderstorm warning along this part of the route' : a.kind === 'G-AIRMET' ? 'Official turbulence forecast covers this area' : 'Official severe-turbulence warning in effect', detail, s });
  }
  // Pilot reports fade as the flight gets further into the future.
  const ahead = Math.max(0, (pt.eta - now) / 60000);
  let pirepScore = null;
  if (ahead < 240) {
    let wSum = 0, wInt = 0, n = 0, worst = null;
    for (const p of turb.pireps || []) {
      if (p.time == null) continue;
      const ageMin = (now - p.time) / 60000;
      if (ageMin > 180 || ageMin < -10) continue;
      const lo = p.baseFt != null ? p.baseFt : p.altFt, hi = p.topFt != null ? p.topFt : p.altFt;
      const altDiff = pt.altFt < lo ? lo - pt.altFt : pt.altFt > hi ? pt.altFt - hi : 0;
      if (altDiff > 4000) continue;
      const d = distanceNm([pt.lat, pt.lon], [p.lat, p.lon]);
      if (d > 75) continue;
      const w = (1 - d / 75) * Math.exp(-Math.max(0, ageMin + ahead) / 90) * (1 - altDiff / 5000);
      if (w <= 0) continue;
      wSum += w; wInt += w * p.intensity; n++;
      if (!worst || p.intensity > worst.intensity) worst = p;
    }
    if (wSum >= 0.12) {
      pirepScore = Math.max(wInt / wSum, worst.intensity * 0.75);
      const what = worst.intensity >= 1.75 ? 'moderate or worse bumps' : worst.intensity >= 0.75 ? 'light bumps' : 'a smooth ride';
      const ago = Math.max(1, Math.round((now - worst.time) / 60000));
      const lvName = level(worst.intensity).name.toLowerCase();
      const plane = aircraftName(worst.ac);
      const detail = `${n === 1 ? 'One pilot has' : n + ' pilots have'} reported conditions within about 85 miles of this spot in the last 3 hours. The bumpiest: ${lvName} at ${fmtFt(worst.altFt)}, ${ago < 60 ? ago + ' min' : Math.round(ago / 60) + ' h'} ago${plane ? ` (${plane})` : ''}. Reports from planes that just flew through are the best clue to what the air feels like.`;
      reasons.push({ kind: 'pirep', text: `${n === 1 ? 'A pilot' : n + ' pilots'} nearby recently reported ${what}`, detail, s: pirepScore });
    }
  }
  const score = areaScore == null && pirepScore == null ? null : Math.max(areaScore || 0, pirepScore || 0);
  return { score, reasons };
}

// ---------- summary ----------
const dur = (m) => {
  m = Math.round(m);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
};
const roundTo5 = (m) => Math.max(5, Math.round(m / 5) * 5);

function summarize(points, step, profile, opts) {
  const total = profile.durationMin;
  const bumpy = (p) => p.score >= 0.75;
  // Bumpy stretches.
  const segments = [];
  for (const p of points) {
    const last = segments[segments.length - 1];
    if (!bumpy(p)) continue;
    if (last && p.t - last.endT <= step) {
      last.endT = p.t; last.points.push(p);
      if (p.score > last.score) last.score = p.score;
    } else segments.push({ startT: p.t, endT: p.t, score: p.score, points: [p] });
  }
  for (const s of segments) {
    // Each sample stands for the few minutes around it.
    s.startT = Math.max(0, s.startT - step / 2);
    s.endT = Math.min(total, s.endT + step / 2);
    if (s.endT - s.startT < step) { if (s.endT >= total) s.startT = Math.max(0, total - step); else s.endT = Math.min(total, s.startT + step); }
    s.minutes = s.endT - s.startT;
    s.level = level(s.score);
    const r = new Map();
    for (const p of s.points) for (const x of p.reasons) if (x.s >= 0.75 && (!r.has(x.text) || r.get(x.text).s < x.s)) r.set(x.text, x);
    const top = [...r.values()].sort((a, b) => b.s - a.s).slice(0, 2);
    s.reasons = top.map((x) => x.text);
    s.details = top.map((x) => ({ title: x.text, detail: x.detail || '' }));
    const mid = s.points[Math.floor(s.points.length / 2)];
    s.lat = mid.lat; s.lon = mid.lon; s.altFt = mid.altFt;
    s.startUtc = opts.departUtc + s.startT * 60000;
    s.endUtc = opts.departUtc + s.endT * 60000;
    s.phase = mid.phase;
    delete s.points;
  }

  // Phases.
  const phaseDefs = opts.live
    ? [{ key: 'cruise', title: opts.dest ? 'Rest of the flight' : 'Next 2 hours', test: (p) => p.phase !== 'descent' }, ...(opts.dest ? [{ key: 'descent', title: 'Descent & landing', test: (p) => p.phase === 'descent' }] : [])]
    : [
      { key: 'climb', title: 'Takeoff & climb', test: (p) => p.phase === 'climb' },
      { key: 'cruise', title: 'Cruise', test: (p) => p.phase === 'cruise' },
      { key: 'descent', title: 'Descent & landing', test: (p) => p.phase === 'descent' },
    ];
  const phases = phaseDefs.map((d) => {
    const ps = points.filter(d.test);
    if (!ps.length) return null;
    const worst = ps.reduce((a, b) => (b.score > a.score ? b : a));
    const bumpyMin = ps.filter(bumpy).length * step;
    const lv = level(worst.score);
    let text;
    if (lv.key === 'smooth') text = d.key === 'climb' ? 'Smooth climb expected' : d.key === 'descent' ? 'Smooth approach expected' : 'Smooth air expected';
    else text = `${lv.name} for about ${dur(roundTo5(Math.min(bumpyMin, ps.length * step)))}`;
    const why = worst.reasons.filter((r) => r.s >= 0.75).sort((a, b) => b.s - a.s)[0];
    return { key: d.key, title: d.title, level: lv, score: worst.score, text, why: why ? why.text : null, whyDetail: why ? why.detail || null : null, startT: ps[0].t, endT: Math.min(total, ps[ps.length - 1].t + step) };
  }).filter(Boolean);

  // Overall rating 1–5.
  const peak = points.reduce((a, b) => (b.score > a.score ? b : a), points[0]);
  const modMin = points.filter((p) => p.score >= 1.5).length * step;
  const lightMin = points.filter(bumpy).length * step;
  let rating;
  if (peak.score >= 3) rating = 5;
  else if (peak.score >= 2.25 || modMin >= 45) rating = 4;
  else if (peak.score >= 1.5) rating = 3;
  else if (peak.score >= 0.75) rating = 2;
  else rating = 1;
  const labels = { 1: 'Smooth', 2: 'Mostly smooth', 3: 'Some bumps', 4: 'Bumpy', 5: 'Very bumpy' };
  const colors = { 1: '#34c759', 2: '#8fc93a', 3: '#ff9500', 4: '#ff5e1f', 5: '#af52de' };

  // Headline.
  let headline;
  const where = (s) => s.startT <= 3 ? (opts.live ? 'right now' : 'right after takeoff') : s.phase === 'descent' && total - s.startT < 35 ? 'on the way down to land' : `about ${dur(roundTo5(s.startT))} ${opts.live ? 'from now' : 'into the flight'}`;
  if (!segments.length) headline = opts.live ? 'No turbulence expected for the rest of this flight.' : 'No real turbulence expected — it should be a calm flight.';
  else {
    const main = segments.slice().sort((a, b) => b.score - a.score || b.minutes - a.minutes)[0];
    headline = `${main.level.name} ${where(main)}, lasting about ${dur(roundTo5(main.minutes))}.`;
    if (segments.length > 1) headline += ` ${segments.length - 1 === 1 ? 'One other short bumpy patch' : `${segments.length - 1} other bumpy patches`} along the way.`;
  }
  const bumpyShare = total ? Math.round((lightMin / total) * 100) : 0;
  const advice = rating >= 4 ? 'Keep your seatbelt fastened whenever you’re seated, and plan drinks or bathroom trips around the bumpy parts.'
    : rating === 3 ? 'Expect the seatbelt sign to come on for a while. Nothing unusual for flying.'
    : rating === 2 ? 'A few light bumps at most — the kind most people barely notice.'
    : 'Smooth skies along your route.';
  return {
    rating: { score: rating, label: labels[rating], color: colors[rating], headline, advice, bumpyShare },
    phases,
    segments,
  };
}

function confidenceFor(departUtc, now, live) {
  const h = (departUtc - now) / 3600000;
  if (live || h <= 6) return { key: 'high', label: 'High', text: 'Uses live pilot reports and current warnings, plus the latest forecast.' };
  if (h <= 48) return { key: 'good', label: 'Good', text: 'Based on the latest weather forecast. Check again on the day for live pilot reports.' };
  if (h <= 96) return { key: 'fair', label: 'Fair', text: 'Forecasts 2–4 days ahead can shift. Check again closer to departure.' };
  return { key: 'low', label: 'Low', text: 'Forecasts this far out change a lot — treat this as a rough first look.' };
}

// ---------- main entry ----------
// getWeather(points, fromMs, toMs) → array of samplers (see weather.js)
async function forecastTrip({ origin, dest, departUtc, live, path, cruiseFt, turb, getWeather, now = Date.now() }) {
  const profile = buildProfile({ origin, dest, live, path, cruiseFt });
  const { step, points: samples } = samplePoints(profile);
  const arriveUtc = departUtc + profile.durationMin * 60000;
  let samplers = null, weatherError = null;
  try {
    samplers = await getWeather(samples, departUtc, arriveUtc);
  } catch (e) {
    weatherError = e.message;
  }
  // Departure/arrival gusts: the first and last sample points sit on the airports.
  const firstW = samplers && samplers[0] ? samplers[0](departUtc) : null;
  const lastW = samplers && dest ? samplers[samplers.length - 1](arriveUtc) : null;
  const ctx = {
    originElev: origin.elevFt || 0, destElev: dest ? dest.elevFt || 0 : 0,
    originGust: !live && firstW ? firstW.gustKt : null, destGust: lastW ? lastW.gustKt : null,
    originName: origin.code || 'departure', destName: dest ? dest.code || 'arrival' : '',
  };
  const scored = samples.map((p, i) => {
    const eta = departUtc + p.t * 60000;
    const pt = { ...p, eta };
    const w = samplers ? samplers[i](eta) : null;
    const edge = !live && p.t <= 12 ? 'origin' : dest && profile.durationMin - p.t <= 15 ? 'dest' : null;
    const m = modelScore(pt, w, { ...ctx, edge });
    const o = observedScore(pt, turb, now);
    const score = Math.max(m.score || 0, o.score || 0);
    const reasons = [...m.reasons, ...o.reasons].sort((a, b) => b.s - a.s);
    const lv = level(score);
    return { t: p.t, eta, lat: +p.lat.toFixed(3), lon: +p.lon.toFixed(3), altFt: p.altFt, phase: p.phase, score: +score.toFixed(2), color: lv.color, levelName: lv.name, reasons, hasData: m.score != null || o.score != null };
  });
  if (!scored.some((p) => p.hasData)) {
    const err = new Error(weatherError ? `Couldn't get the weather forecast (${weatherError}). Try again in a minute.` : 'No forecast data available for this route.');
    err.status = 502;
    throw err;
  }
  const summary = summarize(scored, step, profile, { departUtc, live: Boolean(live), dest });
  // Detailed line for the map (every 2 min along the exact path), coloured by the nearest forecast point.
  const line = [];
  for (let t = 0; t <= profile.durationMin; t += 2) {
    const p = profile.points[Math.min(t, profile.points.length - 1)];
    let near = scored[0];
    for (const s of scored) if (Math.abs(s.t - t) < Math.abs(near.t - t)) near = s;
    line.push([+p.lat.toFixed(4), +p.lon.toFixed(4), near.color, t]);
  }
  const endP = profile.points[profile.points.length - 1];
  if (line[line.length - 1][3] !== endP.t) line.push([+endP.lat.toFixed(4), +endP.lon.toFixed(4), scored[scored.length - 1].color, endP.t]);
  return {
    departUtc, arriveUtc,
    durationMin: profile.durationMin,
    distanceNm: profile.distanceNm != null ? Math.round(profile.distanceNm) : null,
    distanceMi: profile.distanceNm != null ? Math.round(profile.distanceNm * 1.15078) : null,
    followsFiledRoute: Boolean(profile.followsFiledRoute),
    line,
    cruiseFt: profile.cruiseFt, cruiseText: profile.cruiseFt ? `about ${fmtFt(profile.cruiseFt)}` : null,
    stepMin: step,
    confidence: confidenceFor(departUtc, now, live),
    ...summary,
    points: scored.map(({ reasons, hasData, ...p }) => ({ ...p, why: reasons[0] ? reasons[0].text : null, whyDetail: reasons[0] ? reasons[0].detail || null : null })),
    warnings: weatherError ? ['Weather forecast unavailable — using live reports only.'] : [],
  };
}

module.exports = { forecastTrip, buildProfile, pathWalker, samplePoints, modelScore, observedScore, shearAt, summarize, level, LEVELS };
