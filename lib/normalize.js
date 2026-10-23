// Turns the raw aviationweather.gov feeds into one simple shape the website uses:
//   pireps: [{ lat, lon, altFt, baseFt, topFt, intensity (0–4), label, type, ac, time, raw }]
//   areas:  [{ kind, label, severity (0–4), baseFt, topFt, from, to, poly: [[lat, lon], ...], raw }]
// Intensity scale: 0 smooth · 1 light · 2 moderate · 3 severe · 4 extreme

'use strict';

const WORDS = [
  [/EXTREME|EXTRM|EXTM|EXTR/, 4],
  [/SEV/, 3],
  [/MOD/, 2],
  [/LGT|LIGHT|LT\b/, 1],
  [/SMOOTH|SMTH|NEG|NIL/, 0],
];

// "LGT-MOD" → 1.5, "SMTH-LGT" → 0.5, "MOD" → 2, "" → null
function parseIntensity(s) {
  if (s == null) return null;
  const parts = String(s).toUpperCase().split(/[-/ ]+/).filter(Boolean);
  const vals = [];
  for (const p of parts) {
    for (const [re, v] of WORDS) {
      if (re.test(p)) { vals.push(v); break; }
    }
  }
  if (!vals.length) return null;
  return (Math.min(...vals) + Math.max(...vals)) / 2;
}

function labelFor(v) {
  if (v == null) return 'Unknown';
  if (v < 0.5) return 'Smooth';
  if (v < 1.25) return 'Light';
  if (v < 1.75) return 'Light–moderate';
  if (v < 2.25) return 'Moderate';
  if (v < 2.75) return 'Moderate–severe';
  if (v < 3.5) return 'Severe';
  return 'Extreme';
}

const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

// Turbulence group from a raw PIREP text, e.g. "/TB MOD-SEV 350-390" → { int, base, top }
function parseRawTB(raw) {
  const m = /\/TB\s+([^/]+)/.exec(raw || '');
  if (!m) return null;
  const txt = m[1].trim();
  const int = parseIntensity(txt.split(/\s+(?=\d)/)[0]);
  const alt = /(\d{3})\s*-\s*(\d{3})/.exec(txt);
  return { int, base: alt ? Number(alt[1]) * 100 : null, top: alt ? Number(alt[2]) * 100 : null, text: txt };
}

function normalizePireps(list) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    const lat = num(p.lat), lon = num(p.lon);
    if (lat == null || lon == null) continue;
    const fl = num(p.fltLvl);
    const altFt = fl != null ? fl * 100 : null;
    const layers = [];
    for (const i of [1, 2]) {
      const int = parseIntensity(p['tbInt' + i]);
      if (int == null) continue;
      const b = num(p['tbBas' + i]), t = num(p['tbTop' + i]);
      layers.push({
        int,
        text: [p['tbInt' + i], p['tbType' + i], p['tbFreq' + i]].filter(Boolean).join(' '),
        base: b != null ? b * 100 : altFt,
        top: t != null ? t * 100 : altFt,
      });
    }
    if (!layers.length) {
      const r = parseRawTB(p.rawOb);
      if (r && r.int != null) layers.push({ int: r.int, text: r.text, base: r.base != null ? r.base : altFt, top: r.top != null ? r.top : altFt });
    }
    if (!layers.length) continue; // no turbulence information in this report
    if (altFt == null && layers.every((l) => l.base == null)) continue; // can't place it vertically
    const worst = layers.reduce((a, b) => (b.int > a.int ? b : a));
    const bases = layers.map((l) => l.base).filter((v) => v != null);
    const tops = layers.map((l) => l.top).filter((v) => v != null);
    const obs = num(p.obsTime);
    out.push({
      lat, lon,
      altFt: altFt != null ? altFt : worst.base,
      baseFt: bases.length ? Math.min(...bases) : altFt,
      topFt: tops.length ? Math.max(...tops) : altFt,
      intensity: worst.int,
      label: labelFor(worst.int),
      detail: layers.map((l) => l.text).join(' / '),
      ac: p.acType || '',
      type: p.pirepType || 'PIREP',
      urgent: /UUA/.test(p.pirepType || p.rawOb || ''),
      time: obs ? obs * 1000 : Date.parse(p.receiptTime) || null,
      raw: p.rawOb || '',
    });
  }
  return out;
}

function ringFromCoords(coords) {
  // [{lat, lon}] with numbers or strings → [[lat, lon]]
  return (coords || []).map((c) => [num(c.lat), num(c.lon)]).filter((c) => c[0] != null && c[1] != null);
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}

// G-AIRMET altitudes are in hundreds of feet, or "SFC" / "FZL" (freezing level).
function gairmetAlt(v, fzl) {
  if (v == null || v === '') return null;
  const s = String(v).toUpperCase();
  if (s === 'SFC') return 0;
  if (s === 'FZL') { const f = num(fzl); return f != null ? f * 100 : 8000; }
  const n = num(s);
  return n != null ? n * 100 : null;
}

function normalizeAreas({ airsigmet, isigmet, gairmet }) {
  const areas = [];

  // US SIGMETs (and convective SIGMETs = thunderstorms)
  for (const a of Array.isArray(airsigmet) ? airsigmet : []) {
    const hz = String(a.hazard || '').toUpperCase();
    const isConv = hz === 'CONVECTIVE';
    if (!isConv && hz !== 'TURB') continue;
    const poly = ringFromCoords(a.coords);
    if (poly.length < 3) continue;
    const isSig = /SIGMET/i.test(a.airSigmetType || '');
    areas.push({
      kind: isConv ? 'Convective SIGMET' : isSig ? 'SIGMET' : 'AIRMET',
      label: isConv ? 'Thunderstorms (severe turbulence likely)' : isSig ? 'Severe turbulence' : 'Moderate turbulence',
      severity: isConv ? 3.5 : isSig ? 3 : 2,
      baseFt: num(a.altitudeLow1) != null ? num(a.altitudeLow1) : 0,
      topFt: num(a.altitudeHi1) != null ? num(a.altitudeHi1) : 60000,
      from: toMs(a.validTimeFrom),
      to: toMs(a.validTimeTo),
      poly,
      raw: a.rawAirSigmet || '',
    });
  }

  // International SIGMETs (oceanic and foreign airspace)
  const feats = isigmet && Array.isArray(isigmet.features) ? isigmet.features : [];
  for (const f of feats) {
    const pr = f.properties || {};
    const hz = String(pr.hazard || '').toUpperCase();
    const isConv = hz === 'TS' || hz === 'TSGR' || hz === 'TC' || hz === 'CB';
    if (!isConv && hz !== 'TURB') continue;
    const g = f.geometry || {};
    const rings = g.type === 'Polygon' ? [g.coordinates[0]] : g.type === 'MultiPolygon' ? g.coordinates.map((c) => c[0]) : [];
    for (const r of rings) {
      const poly = (r || []).map((c) => [c[1], c[0]]);
      if (poly.length < 3) continue;
      const sev = String(pr.qualifier || '').toUpperCase().includes('SEV') ? 3 : 2.5;
      areas.push({
        kind: isConv ? 'Convective SIGMET' : 'SIGMET',
        label: isConv ? 'Thunderstorms (severe turbulence likely)' : `${pr.qualifier || ''} turbulence`.trim(),
        severity: isConv ? 3.5 : sev,
        baseFt: num(pr.base) != null ? num(pr.base) : 0,
        topFt: num(pr.top) != null ? num(pr.top) : 60000,
        from: toMs(pr.validTimeFrom),
        to: toMs(pr.validTimeTo),
        poly,
        raw: pr.rawSigmet || '',
        region: pr.firName || '',
      });
    }
  }

  // G-AIRMETs: forecast snapshots of moderate turbulence every 3 hours (US)
  for (const g of Array.isArray(gairmet) ? gairmet : []) {
    const poly = ringFromCoords(g.coords);
    if (poly.length < 3) continue;
    const valid = toMs(g.validTime);
    const hz = String(g.hazard || '').toUpperCase();
    const sev = parseIntensity(g.severity);
    const severity = sev != null ? Math.max(sev, 1.5) : 2;
    areas.push({
      kind: 'G-AIRMET',
      label: `${labelFor(severity)} turbulence forecast${hz.includes('HI') ? ' (high altitude)' : hz.includes('LO') ? ' (low altitude)' : ''}`,
      severity,
      baseFt: gairmetAlt(g.base, g.fzlbase) != null ? gairmetAlt(g.base, g.fzlbase) : 0,
      topFt: gairmetAlt(g.top, g.fzltop) != null ? gairmetAlt(g.top, g.fzltop) : 45000,
      // Each snapshot represents conditions around its valid time (± 90 min).
      from: valid != null ? valid - 90 * 60000 : null,
      to: valid != null ? valid + 90 * 60000 : null,
      forecastHour: num(g.forecastHour),
      poly,
      raw: g.due_to ? `Due to ${g.due_to}` : '',
    });
  }

  return areas;
}

function normalizeTurbulence(raw) {
  return {
    pireps: normalizePireps(raw.pireps),
    areas: normalizeAreas(raw),
  };
}

module.exports = { normalizeTurbulence, normalizePireps, normalizeAreas, parseIntensity, labelFor, parseRawTB };
